"use server"

import { randomUUID } from "node:crypto"
import { and, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm"
import { z } from "zod"
import { withRlsContext } from "@/lib/db/client"
import { books, importPreviews, librarySnapshots } from "@/lib/db/schema"
import { ensureDefaultShelf, lockLibrary } from "@/lib/db/library"
import { getRequiredUserId } from "@/lib/server-user"
import { DomainError, translateDatabaseError } from "@/lib/domain-errors"
import type { ActionResult } from "@/lib/action-result"
import { domainMutation } from "@/lib/server-action"
import { IMPORT_RULES_VERSION, MAX_ACTIVE_PREVIEWS, previewTtlMinutes, type ImportOperationResult } from "@/lib/import-plan"
import { previewAllocator, publishSnapshotRestore, readCollectionSnapshot } from "@/lib/import-publisher"
import {
  buildRestorePlan, decodeSnapshotCursor, encodeSnapshotCursor, foreignSnapshotIds, pageLimit, readSnapshotContent, readSnapshotHeader,
  restoreChanges, SNAPSHOT_LIMITS, snapshotExpired, snapshotUnavailable, type SnapshotPage, type SnapshotSummary,
} from "@/lib/library-snapshots"
import type { LibrarySnapshotReason } from "@/lib/db/schema"
import type { PreparedImport } from "@/app/actions/import-preview"
import { telemetry } from "@/lib/observability/server"
import { observeOperation } from "@/lib/observability/operations"
import { emitSafely } from "@/lib/observability/emitter"

// U-DAT-02 · Historial de versiones anteriores y restauración en dos pasos. La vista previa compara
// la versión con la colección actual (U-DAT-01) y la restauración la publica bajo el bloqueo de
// colección con su revisión, su clave y otra versión anterior del estado que sustituye.

export interface SnapshotRestorePreview extends PreparedImport {
  snapshot: { id: string; reason: LibrarySnapshotReason; createdAt: string; expiresAt: string; books: number; shelves: number }
  /** Títulos acotados de lo que desaparece (añadido después) y de lo que vuelve. */
  changes: { removed: string[]; removedTotal: number; restored: string[]; restoredTotal: number }
}

export interface SnapshotRestoreResult {
  operationId: string
  status: "committed"
  result: ImportOperationResult
  /** true si la respuesta procede de una restauración anterior con la misma clave. */
  replayed: boolean
  /** Versión anterior del estado sustituido por esta restauración. */
  snapshotId: string | null
}

const listSchema = z.object({ cursor: z.string().max(200).nullish(), limit: z.number().int().nullish() }).nullish()
const snapshotSchema = z.object({ snapshotId: z.uuid() })
const restoreSchema = z.object({ previewId: z.uuid(), expectedRevision: z.uuid(), idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) })
const deleteSchema = z.object({ snapshotId: z.uuid(), expectedVersion: z.uuid() })

const summary = (row: typeof librarySnapshots.$inferSelect): SnapshotSummary => ({
  id: row.id, reason: row.reason, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
  books: row.counts.books, shelves: row.counts.shelves, version: row.version,
})

async function listSnapshots(input: unknown): Promise<SnapshotPage> {
  const userId = await getRequiredUserId()
  const parsed = listSchema.safeParse(input)
  if (!parsed.success) throw new DomainError("INVALID_INPUT", "La consulta del historial no es válida.")
  const limit = pageLimit(parsed.data?.limit)
  const cursor = decodeSnapshotCursor(parsed.data?.cursor)
  try {
    return await withRlsContext(userId, async (tx) => {
      const vigente = and(eq(librarySnapshots.userId, userId), eq(librarySnapshots.state, "ready"), gt(librarySnapshots.expiresAt, sql`now()`))
      // La posición se compara con la marca exacta de Postgres (microsegundos), no con la del navegador.
      const after = cursor ? or(lt(librarySnapshots.createdAt, sql`${cursor.createdAt}::timestamptz`), and(eq(librarySnapshots.createdAt, sql`${cursor.createdAt}::timestamptz`), lt(librarySnapshots.id, cursor.id))) : undefined
      const rows = await tx.select({ snapshot: librarySnapshots, position: sql<string>`to_char(${librarySnapshots.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
        .from(librarySnapshots).where(after ? and(vigente, after) : vigente)
        .orderBy(desc(librarySnapshots.createdAt), desc(librarySnapshots.id)).limit(limit + 1)
      // La cuota cuenta todas las versiones guardadas; las vencidas se retiran en la siguiente captura.
      const [{ used }] = await tx.select({ used: sql<number>`count(*)::int` }).from(librarySnapshots)
        .where(and(eq(librarySnapshots.userId, userId), gt(librarySnapshots.expiresAt, sql`now()`)))
      const page = rows.slice(0, limit)
      const last = page.at(-1)
      return {
        items: page.map((row) => summary(row.snapshot)),
        nextCursor: rows.length > limit && last ? encodeSnapshotCursor({ createdAt: last.position, id: last.snapshot.id }) : null,
        quota: { used, limit: SNAPSHOT_LIMITS.maxPerAccount },
        retentionDays: SNAPSHOT_LIMITS.retentionDays,
      }
    })
  } catch (error) { translateDatabaseError(error) }
}

async function previewRestore(input: unknown): Promise<SnapshotRestorePreview> {
  const userId = await getRequiredUserId()
  const parsed = snapshotSchema.safeParse(input)
  if (!parsed.success) throw snapshotUnavailable()
  const { snapshotId } = parsed.data
  const previewId = randomUUID()
  const ttl = previewTtlMinutes(process.env.BIBLIB_IMPORT_PREVIEW_TTL_MINUTES)
  try {
    return await withRlsContext(userId, async (tx) => {
      await ensureDefaultShelf(tx, userId)
      const revision = await lockLibrary(tx)
      const header = await readSnapshotHeader(tx, userId, snapshotId)
      // Ajena, inexistente o incompleta responden igual: no se confirma su existencia.
      if (!header) throw snapshotUnavailable()
      if (header.expired) throw snapshotExpired()
      const content = await readSnapshotContent(tx, userId, header)
      const current = await readCollectionSnapshot(tx, userId)
      const plan = buildRestorePlan({ snapshot: content, current, foreign: await foreignSnapshotIds(tx, header.id), allocateId: previewAllocator(previewId) })
      const titles = plan.books.delete.length || plan.books.insert.length
        ? new Map((await tx.select({ id: books.id, title: books.title }).from(books).where(eq(books.userId, userId))).map((row) => [row.id, row.title]))
        : new Map<string, string>()

      // Mismas reglas de retención que las vistas previas de importación (U-DAT-01).
      await tx.delete(importPreviews).where(and(eq(importPreviews.userId, userId), lt(importPreviews.expiresAt, sql`now() - interval '1 day'`)))
      const surplus = await tx.select({ id: importPreviews.id }).from(importPreviews).where(eq(importPreviews.userId, userId))
        .orderBy(desc(importPreviews.createdAt), desc(importPreviews.id)).offset(MAX_ACTIVE_PREVIEWS - 1)
      if (surplus.length) await tx.delete(importPreviews).where(and(eq(importPreviews.userId, userId), inArray(importPreviews.id, surplus.map((row) => row.id))))

      const [stored] = await tx.insert(importPreviews).values({
        id: previewId, userId, revision, inputDigest: header.digest, mode: "replace", rulesVersion: IMPORT_RULES_VERSION, plan, payload: null, snapshotId: header.id,
        expiresAt: sql`now() + make_interval(mins => ${ttl})`,
      }).returning({ expiresAt: importPreviews.expiresAt })
      return {
        previewId, revision, digest: header.digest, expiresAt: stored.expiresAt.toISOString(), plan,
        snapshot: { id: header.id, reason: header.reason, createdAt: header.createdAt.toISOString(), expiresAt: header.expiresAt.toISOString(), books: header.counts.books, shelves: header.counts.shelves },
        changes: restoreChanges(plan, content, titles),
      }
    })
  } catch (error) { translateDatabaseError(error) }
}

async function restore(input: unknown): Promise<SnapshotRestoreResult> {
  const userId = await getRequiredUserId()
  const parsed = restoreSchema.safeParse(input)
  if (!parsed.success) throw new DomainError("INVALID_INPUT", "La confirmación no es válida. Prepara de nuevo la restauración.")
  try {
    const outcome = await withRlsContext(userId, (tx) => publishSnapshotRestore(tx, { userId, ...parsed.data }))
    return { operationId: outcome.operationId, status: "committed", result: outcome.result, replayed: outcome.replayed, snapshotId: outcome.snapshotId }
  } catch (error) { translateDatabaseError(error) }
}

async function deleteSnapshot(input: unknown): Promise<void> {
  const userId = await getRequiredUserId()
  const parsed = deleteSchema.safeParse(input)
  if (!parsed.success) throw snapshotUnavailable()
  try {
    const rows = await withRlsContext(userId, (tx) => tx.execute<{ status: "deleted" | "not_found" | "conflict" }>(
      sql`select biblib.library_snapshot_delete(${parsed.data.snapshotId}::uuid, ${parsed.data.expectedVersion}::uuid) as status`))
    const status = rows[0]?.status
    if (status === "not_found") throw snapshotUnavailable()
    if (status === "conflict") throw new DomainError("CONFLICT", "Esa versión anterior ha cambiado desde que cargaste el historial. Vuelve a cargarlo antes de eliminarla.")
    if (status !== "deleted") throw new DomainError("PROVIDER_UNAVAILABLE", "No se pudo eliminar la versión anterior. Inténtalo de nuevo.")
  } catch (error) { translateDatabaseError(error) }
}

export async function listLibrarySnapshotsAction(input: { cursor?: string | null; limit?: number } = {}): Promise<ActionResult<SnapshotPage>> {
  return domainMutation(() => listSnapshots(input))
}

export async function previewSnapshotRestoreAction(input: { snapshotId: string }): Promise<ActionResult<SnapshotRestorePreview>> {
  return domainMutation(async () => {
    const started = Date.now()
    try {
      const prepared = await previewRestore(input)
      emitSafely(telemetry, "import.preview", { operation: "snapshot.preview", result: "ok", durationMs: Math.max(0, Date.now() - started) })
      return prepared
    } catch (error) {
      emitSafely(telemetry, "import.preview", { operation: "snapshot.preview", result: "error", errorCode: error instanceof DomainError ? error.code : "UNEXPECTED_ERROR", durationMs: Math.max(0, Date.now() - started) })
      throw error
    }
  })
}

export async function restoreSnapshotAction(input: { previewId: string; expectedRevision: string; idempotencyKey: string }): Promise<ActionResult<SnapshotRestoreResult>> {
  return domainMutation(() => observeOperation("import.commit", "snapshot.restore", () => restore(input), telemetry))
}

export async function deleteLibrarySnapshotAction(input: { snapshotId: string; expectedVersion: string }): Promise<ActionResult<void>> {
  return domainMutation(() => deleteSnapshot(input))
}

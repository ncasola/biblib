"use server"

import { createHash, randomUUID } from "node:crypto"
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm"
import { z } from "zod"
import { withRlsContext } from "@/lib/db/client"
import { importPreviews } from "@/lib/db/schema"
import { ensureDefaultShelf, lockLibrary } from "@/lib/db/library"
import { getRequiredUserId } from "@/lib/server-user"
import { DomainError, translateDatabaseError } from "@/lib/domain-errors"
import type { ActionResult } from "@/lib/action-result"
import { domainMutation } from "@/lib/server-action"
import { DEFAULT_BOOK_COVER } from "@/lib/book-covers"
import { parseLibraryImport } from "@/lib/library-import"
import { createBackupV2, type PortableBackupV2 } from "@/lib/backup-v2"
import {
  buildImportPlan, canonicalJson, IMPORT_RULES_VERSION, MAX_ACTIVE_PREVIEWS, previewTtlMinutes,
  type ImportMode, type ImportOperationResult, type ImportPlan,
} from "@/lib/import-plan"
import { previewAllocator, readCollectionSnapshot } from "@/lib/import-publisher"
import { isTerminal } from "@/lib/jobs/contracts"
import { publicationFailure, publishInline, scheduleDrain, startImportJob } from "@/lib/jobs/server"
import type { LibraryData } from "@/lib/types"
import { telemetry } from "@/lib/observability/server"
import { observeOperation } from "@/lib/observability/operations"
import { emitSafely } from "@/lib/observability/emitter"

// U-DAT-01 · Importación en dos pasos vinculada a la revisión de la colección.
// prepare: valida y guarda entrada + plan privados. No consulta catálogos: las portadas pendientes las
// busca después el trabajo de portadas (U-DAT-03) con el orquestador y el gateway en modo lote, sin
// bloquear la revisión ni la importación (U-BIB-05).
// confirm: publica mediante un trabajo persistente (U-DAT-03); bajo el bloqueo de colección compara
// clave, caducidad, reglas y revisión y nunca fuerza.

export interface PreparedImport {
  previewId: string
  revision: string
  digest: string
  expiresAt: string
  plan: ImportPlan
}

export interface ConfirmedImport {
  /** Operación durable de U-DAT-01; mientras está en cola, el ID del trabajo que la publicará. */
  operationId: string
  status: "queued" | "committed"
  /** Solo cuando la publicación ya está confirmada. */
  result?: ImportOperationResult
  /** Trabajo persistente que publica la importación y continúa con las portadas pendientes. */
  jobId: string
  /** true si la respuesta procede del resultado durable de una confirmación anterior con la misma clave. */
  replayed: boolean
}

const modeSchema = z.enum(["merge", "replace"])
const confirmSchema = z.object({
  previewId: z.uuid(),
  expectedRevision: z.uuid(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
})

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

function parseInput(input: unknown): LibraryData {
  try { return parseLibraryImport(input, telemetry) }
  catch (error) { throw new DomainError("INVALID_INPUT", error instanceof Error ? error.message : "El archivo no es válido.") }
}

async function prepareImport(input: unknown, mode: unknown): Promise<PreparedImport> {
  const userId = await getRequiredUserId()
  const parsedMode = modeSchema.safeParse(mode)
  if (!parsedMode.success) throw new DomainError("INVALID_INPUT", "Selecciona cómo importar la biblioteca.")
  const importMode: ImportMode = parsedMode.data
  const imported = parseInput(input)
  const digest = sha256(canonicalJson(imported))

  const payload: LibraryData = { shelves: imported.shelves, books: imported.books }
  // Al confirmar se vuelve a leer lo guardado y se exige el mismo plan. Se guarda el payload v2 (U-DAT-06): la forma
  // plana no expresa ediciones compartidas, obras, evidencias, identificadores ni ejemplares sin ISBN-13.
  const storedPayload: PortableBackupV2 = createBackupV2(payload)
  const previewId = randomUUID()
  const ttl = previewTtlMinutes(process.env.BIBLIB_IMPORT_PREVIEW_TTL_MINUTES)

  try {
    return await withRlsContext(userId, async (tx) => {
      // La predeterminada se asegura antes de leer la revisión: crearla también rota la revisión.
      await ensureDefaultShelf(tx, userId)
      const revision = await lockLibrary(tx)
      const plan = buildImportPlan({ imported: payload, current: await readCollectionSnapshot(tx, userId), mode: importMode, allocateId: previewAllocator(previewId) })
      // Ninguna portada se busca al preparar: las genéricas quedan pendientes para el trabajo de portadas.
      const covers = new Map(payload.books.map((book) => [book.id, book.cover.large]))
      plan.counts.coversFound = 0
      plan.counts.coversPending = plan.books.insert.filter((entry) => covers.get(entry.sourceId) === DEFAULT_BOOK_COVER).length

      // Las vistas previas caducadas se conservan un día para diagnóstico; cada cuenta guarda un número acotado.
      await tx.delete(importPreviews).where(and(eq(importPreviews.userId, userId), lt(importPreviews.expiresAt, sql`now() - interval '1 day'`)))
      const surplus = await tx.select({ id: importPreviews.id }).from(importPreviews).where(eq(importPreviews.userId, userId))
        .orderBy(desc(importPreviews.createdAt), desc(importPreviews.id)).offset(MAX_ACTIVE_PREVIEWS - 1)
      if (surplus.length) await tx.delete(importPreviews).where(and(eq(importPreviews.userId, userId), inArray(importPreviews.id, surplus.map((row) => row.id))))

      const [stored] = await tx.insert(importPreviews).values({
        id: previewId, userId, revision, inputDigest: digest, mode: importMode, rulesVersion: IMPORT_RULES_VERSION, plan, payload: storedPayload,
        expiresAt: sql`now() + make_interval(mins => ${ttl})`,
      }).returning({ expiresAt: importPreviews.expiresAt })
      return { previewId, revision, digest, expiresAt: stored.expiresAt.toISOString(), plan }
    })
  } catch (error) { translateDatabaseError(error) }
}

/**
 * U-DAT-03: la confirmación se publica a través de un trabajo persistente. La misma clave recupera el
 * mismo trabajo y su resultado durable; el paso de publicación se ejecuta en línea y las portadas
 * pendientes continúan después como otra fase, sin revertir la importación publicada.
 */
async function confirmImport(input: unknown): Promise<ConfirmedImport> {
  const userId = await getRequiredUserId()
  const parsed = confirmSchema.safeParse(input)
  if (!parsed.success) throw new DomainError("INVALID_INPUT", "La confirmación no es válida. Prepara de nuevo la revisión del archivo.")
  const { previewId, expectedRevision, idempotencyKey } = parsed.data
  try {
    const job = await startImportJob(userId, { previewId, expectedRevision, idempotencyKey })
    const view = await publishInline(userId, job.id)
    if (view.published && view.result) {
      if (!isTerminal(view.state)) scheduleDrain(userId, view.id)
      return { operationId: view.result.operationId, status: "committed", result: view.result.result, replayed: !job.created || view.result.replayed, jobId: view.id }
    }
    if (isTerminal(view.state) || view.state === "needs_review") throw publicationFailure(view)
    // Otro trabajador la está publicando o espera un reintento: el resultado se consulta con el trabajo.
    scheduleDrain(userId, view.id)
    return { operationId: view.id, status: "queued", replayed: !job.created, jobId: view.id }
  } catch (error) { translateDatabaseError(error) }
}

export async function prepareImportAction(input: unknown, mode: "merge" | "replace"): Promise<ActionResult<PreparedImport>> {
  return domainMutation(async () => {
    const started = Date.now()
    try {
      const prepared = await prepareImport(input, mode)
      emitSafely(telemetry, "import.preview", { operation: "import.prepare", result: "ok", durationMs: Math.max(0, Date.now() - started) })
      return prepared
    } catch (error) {
      emitSafely(telemetry, "import.preview", { operation: "import.prepare", result: "error", errorCode: error instanceof DomainError ? error.code : "UNEXPECTED_ERROR", durationMs: Math.max(0, Date.now() - started) })
      throw error
    }
  })
}

export async function confirmImportAction(input: { previewId: string; expectedRevision: string; idempotencyKey: string }): Promise<ActionResult<ConfirmedImport>> {
  return domainMutation(async () => {
    try {
      return await observeOperation("import.commit", "import.confirm", () => confirmImport(input), telemetry)
    } catch (error) {
      if (error instanceof DomainError && (error.code === "REVISION_CONFLICT" || error.code === "IDEMPOTENCY_CONFLICT" || error.code === "PREVIEW_EXPIRED")) {
        emitSafely(telemetry, "import.conflict", { operation: "import.confirm", result: "error", errorCode: error.code })
      }
      throw error
    }
  })
}

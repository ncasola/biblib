"use server"

import { z } from "zod"
import { withRlsContext } from "@/lib/db/client"
import { ensureDefaultShelf } from "@/lib/db/library"
import { getRequiredUserId } from "@/lib/server-user"
import { DomainError, translateDatabaseError } from "@/lib/domain-errors"
import type { ActionResult } from "@/lib/action-result"
import { domainMutation } from "@/lib/server-action"
import { previewTtlMinutes, type ImportOperationResult } from "@/lib/import-plan"
import { partIdSchema, RESTORE_LIMITS } from "@/lib/import-manifest"
import {
  beginSession, commitBudget, discardSession, listOpenSessions, prepareSession, publishRestoreSession, putChunk, releaseStaging,
  translateStagingError, validateSession, type ChunkReceipt, type PreparedRestore, type RestoreSessionView, type ValidatedSession,
} from "@/lib/import-staging"
import { telemetry } from "@/lib/observability/server"
import { observeOperation } from "@/lib/observability/operations"
import { emitSafely } from "@/lib/observability/emitter"

// U-DAT-04 · Restauración de todas las partes de un respaldo como una sola operación revisable:
// begin (manifest o partes sueltas) → upload (trozos de hasta 256 KiB con FormData/Blob, nunca
// base64) → validate → prepare (plan frente a la colección actual) → commit (una transacción bajo
// el bloqueo y el CAS de colección). El dueño sale siempre de la sesión; un ID ajeno responde igual
// que uno inexistente.

export interface RestoreCommitResult {
  operationId: string
  status: "committed"
  result: ImportOperationResult
  /** true si la respuesta procede de una publicación anterior con la misma clave. */
  replayed: boolean
  /** Versión anterior del estado sustituido (U-DAT-02). */
  snapshotId: string | null
}

const sha256Text = z.string().regex(/^[0-9a-f]{64}$/)
const sessionSchema = z.object({ sessionId: z.uuid() })
const beginSchema = z.union([
  z.object({ manifest: z.unknown().refine((value) => value !== undefined) }).strict(),
  z.object({ parts: z.array(z.object({ byteLength: z.number().int().min(1), sha256: sha256Text }).strict()).min(1).max(RESTORE_LIMITS.maxParts * 2) }).strict(),
])
const chunkSchema = z.object({
  sessionId: z.uuid(), partId: partIdSchema, ordinal: z.number().int().min(0).max(1_000), total: z.number().int().min(1).max(1_000), sha256: sha256Text,
  chunk: z.custom<Blob>((value) => typeof value === "object" && value !== null && typeof (value as Blob).arrayBuffer === "function" && typeof (value as Blob).size === "number"),
}).strict()
const commitSchema = z.object({ sessionId: z.uuid(), previewId: z.uuid(), expectedRevision: z.uuid(), idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) })

/** Interruptor de servidor: `BIBLIB_RESTORE_SESSIONS_PUBLISH=false` deja validar y revisar, pero no publicar. */
const publishEnabled = () => process.env.BIBLIB_RESTORE_SESSIONS_PUBLISH !== "false"

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError("INVALID_INPUT", message)
  return parsed.data
}

async function owned<T>(work: (userId: string) => Promise<T>): Promise<T> {
  const userId = await getRequiredUserId()
  try { return await work(userId) } catch (error) {
    try { translateStagingError(error) } catch (translated) { translateDatabaseError(translated) }
  }
}

export async function beginRestoreSessionAction(input: { manifest: unknown } | { parts: { byteLength: number; sha256: string }[] }): Promise<ActionResult<RestoreSessionView>> {
  return domainMutation(() => owned(async (userId) => {
    const parsed = parse(beginSchema, input, "Selecciona las partes de la copia o su manifiesto para empezar la restauración.")
    return withRlsContext(userId, async (tx) => {
      await ensureDefaultShelf(tx, userId)
      return beginSession(tx, userId, "manifest" in parsed ? { kind: "manifest", manifest: parsed.manifest } : { kind: "loose", parts: parsed.parts })
    })
  }))
}

/**
 * Recibe un trozo de los bytes originales de una parte. Se mide el tamaño real antes de leerlo y el
 * servidor comprueba posición, total y hash; repetir el mismo trozo no cambia nada.
 */
export async function uploadRestorePartAction(input: { sessionId: string; partId: string; ordinal: number; total: number; sha256: string; chunk: Blob }): Promise<ActionResult<ChunkReceipt>> {
  return domainMutation(() => owned(async (userId) => {
    const parsed = parse(chunkSchema, input, "El trozo de la parte no es válido. Vuelve a seleccionar los archivos.")
    if (parsed.chunk.size < 1 || parsed.chunk.size > RESTORE_LIMITS.chunkBytes) throw new DomainError("LIMIT_EXCEEDED", "Cada trozo de una parte admite hasta 256 KiB.")
    const bytes = new Uint8Array(await parsed.chunk.arrayBuffer())
    if (bytes.byteLength !== parsed.chunk.size) throw new DomainError("INVALID_INPUT", "El trozo llegó incompleto. Vuelve a intentarlo.")
    return withRlsContext(userId, (tx) => putChunk(tx, userId, { sessionId: parsed.sessionId, partId: parsed.partId, ordinal: parsed.ordinal, total: parsed.total, sha256: parsed.sha256, bytes }))
  }))
}

export async function validateRestoreSessionAction(input: { sessionId: string }): Promise<ActionResult<ValidatedSession>> {
  return domainMutation(() => owned(async (userId) => {
    const { sessionId } = parse(sessionSchema, input, "La restauración no es válida.")
    const started = Date.now()
    try {
      const validated = await validateSession((work) => withRlsContext(userId, work), userId, sessionId)
      emitSafely(telemetry, "import.preview", { operation: "restore.validate", result: "ok", durationMs: Math.max(0, Date.now() - started) })
      return validated
    } catch (error) {
      emitSafely(telemetry, "import.preview", { operation: "restore.validate", result: "error", errorCode: error instanceof DomainError ? error.code : "UNEXPECTED_ERROR", durationMs: Math.max(0, Date.now() - started) })
      throw error
    }
  }))
}

export async function prepareRestoreSessionAction(input: { sessionId: string }): Promise<ActionResult<PreparedRestore>> {
  return domainMutation(() => owned(async (userId) => {
    const { sessionId } = parse(sessionSchema, input, "La restauración no es válida.")
    const ttl = previewTtlMinutes(process.env.BIBLIB_IMPORT_PREVIEW_TTL_MINUTES)
    return withRlsContext(userId, async (tx) => {
      // La predeterminada se asegura antes de fijar la revisión: crearla también la rota.
      await ensureDefaultShelf(tx, userId)
      return prepareSession(tx, userId, sessionId, { ttlMinutes: ttl })
    })
  }))
}

export async function commitRestoreSessionAction(input: { sessionId: string; previewId: string; expectedRevision: string; idempotencyKey: string }): Promise<ActionResult<RestoreCommitResult>> {
  return domainMutation(() => observeOperation("import.commit", "restore.commit", () => owned(async (userId) => {
    const request = parse(commitSchema, input, "La confirmación no es válida. Revisa de nuevo la restauración.")
    const outcome = await withRlsContext(userId, (tx) => publishRestoreSession(tx, { userId, ...request }, {
      budget: commitBudget(process.env.BIBLIB_RESTORE_COMMIT_BUDGET_MS), publishEnabled: publishEnabled(),
    }))
    // Fuera de la transacción final: liberar el staging nunca alarga ni pone en riesgo la publicación.
    if (!outcome.replayed) await withRlsContext(userId, (tx) => releaseStaging(tx, userId, request.sessionId)).catch(() => {})
    return { operationId: outcome.operationId, status: "committed" as const, result: outcome.result, replayed: outcome.replayed, snapshotId: outcome.snapshotId }
  }), telemetry))
}

/** Restauraciones a medias del dueño: permiten continuar la subida o descartarlas. */
export async function listRestoreSessionsAction(): Promise<ActionResult<RestoreSessionView[]>> {
  return domainMutation(() => owned((userId) => withRlsContext(userId, (tx) => listOpenSessions(tx, userId))))
}

export async function discardRestoreSessionAction(input: { sessionId: string }): Promise<ActionResult<void>> {
  return domainMutation(() => owned(async (userId) => {
    const { sessionId } = parse(sessionSchema, input, "La restauración no es válida.")
    await withRlsContext(userId, (tx) => discardSession(tx, userId, sessionId))
  }))
}

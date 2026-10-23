"use server"

import { createHash, randomUUID } from "node:crypto"
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm"
import { z } from "zod"
import { withRlsContext, type DatabaseTransaction } from "@/lib/db/client"
import { books, importPreviews, libraryOperations, shelves } from "@/lib/db/schema"
import { ensureDefaultShelf, lockLibrary } from "@/lib/db/library"
import { getRequiredUserId } from "@/lib/server-user"
import { DomainError, idempotencyConflict, previewExpired, revisionConflict, translateDatabaseError } from "@/lib/domain-errors"
import type { ActionResult } from "@/lib/action-result"
import { domainMutation } from "@/lib/server-action"
import { DEFAULT_BOOK_COVER } from "@/lib/book-covers"
import { normalizedBookIdentifier } from "@/lib/isbn"
import { enrichImportedBookCovers, parseLibraryImport } from "@/lib/library-import"
import {
  buildImportPlan, canonicalJson, confirmationInput, decideConfirmation, IMPORT_RULES_VERSION, MAX_ACTIVE_PREVIEWS, operationResult, previewTtlMinutes,
  type CollectionSnapshot, type IdAllocator, type ImportMode, type ImportOperationResult, type ImportPlan,
} from "@/lib/import-plan"
import type { LibraryData } from "@/lib/types"
import { telemetry } from "@/lib/observability/server"
import { observeOperation } from "@/lib/observability/operations"
import { emitSafely } from "@/lib/observability/emitter"

// U-DAT-01 · Importación en dos pasos vinculada a la revisión de la colección.
// prepare: valida, busca portadas fuera de cualquier transacción y guarda entrada + plan privados.
// confirm: bajo el bloqueo de colección compara clave, caducidad, reglas y revisión; nunca fuerza.

export interface PreparedImport {
  previewId: string
  revision: string
  digest: string
  expiresAt: string
  plan: ImportPlan
}

export interface ConfirmedImport {
  operationId: string
  status: "queued" | "committed"
  result: ImportOperationResult
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

/** IDs nuevos derivados de la vista previa: la misma entrada produce el mismo plan al confirmar. */
function allocator(seed: string): IdAllocator {
  return (kind, sourceId) => {
    const hex = sha256(`${seed}\u0000${kind}\u0000${sourceId}`)
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
}

async function readSnapshot(tx: DatabaseTransaction, userId: string): Promise<CollectionSnapshot> {
  const shelfRows = await tx.select({ id: shelves.id, title: shelves.title, isDefault: shelves.isDefault }).from(shelves)
    .where(eq(shelves.userId, userId)).orderBy(asc(shelves.createdAt), asc(shelves.id))
  const bookRows = await tx.select({ id: books.id, isbn: books.isbn }).from(books)
    .where(eq(books.userId, userId)).orderBy(asc(books.id))
  return { shelves: shelfRows, books: bookRows }
}

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

  // Red fuera de cualquier transacción y del bloqueo: solo libros que probablemente se añadirán.
  const existing = importMode === "merge" ? await withRlsContext(userId, async (tx) =>
    new Set((await tx.select({ isbn: books.isbn }).from(books).where(eq(books.userId, userId))).map((book) => normalizedBookIdentifier(book.isbn)))) : new Set<string>()
  const probableNew = imported.books.filter((book) => !existing.has(normalizedBookIdentifier(book.isbn)))
  const enriched = new Map((await enrichImportedBookCovers(probableNew, telemetry)).map((book) => [book.isbn, book]))
  const payload: LibraryData = { shelves: imported.shelves, books: imported.books.map((book) => enriched.get(book.isbn) ?? book) }
  const previewId = randomUUID()
  const ttl = previewTtlMinutes(process.env.BIBLIB_IMPORT_PREVIEW_TTL_MINUTES)

  try {
    return await withRlsContext(userId, async (tx) => {
      // La predeterminada se asegura antes de leer la revisión: crearla también rota la revisión.
      await ensureDefaultShelf(tx, userId)
      const revision = await lockLibrary(tx)
      const plan = buildImportPlan({ imported: payload, current: await readSnapshot(tx, userId), mode: importMode, allocateId: allocator(previewId) })
      const originals = new Map(imported.books.map((book) => [book.id, book.cover.large]))
      const covers = new Map(payload.books.map((book) => [book.id, book.cover.large]))
      plan.counts.coversFound = plan.books.insert.filter((entry) => originals.get(entry.sourceId) === DEFAULT_BOOK_COVER && covers.get(entry.sourceId) !== DEFAULT_BOOK_COVER).length
      plan.counts.coversPending = plan.books.insert.filter((entry) => covers.get(entry.sourceId) === DEFAULT_BOOK_COVER).length

      // Las vistas previas caducadas se conservan un día para diagnóstico; cada cuenta guarda un número acotado.
      await tx.delete(importPreviews).where(and(eq(importPreviews.userId, userId), lt(importPreviews.expiresAt, sql`now() - interval '1 day'`)))
      const surplus = await tx.select({ id: importPreviews.id }).from(importPreviews).where(eq(importPreviews.userId, userId))
        .orderBy(desc(importPreviews.createdAt), desc(importPreviews.id)).offset(MAX_ACTIVE_PREVIEWS - 1)
      if (surplus.length) await tx.delete(importPreviews).where(and(eq(importPreviews.userId, userId), inArray(importPreviews.id, surplus.map((row) => row.id))))

      const [stored] = await tx.insert(importPreviews).values({
        id: previewId, userId, revision, inputDigest: digest, mode: importMode, rulesVersion: IMPORT_RULES_VERSION, plan, payload,
        expiresAt: sql`now() + make_interval(mins => ${ttl})`,
      }).returning({ expiresAt: importPreviews.expiresAt })
      return { previewId, revision, digest, expiresAt: stored.expiresAt.toISOString(), plan }
    })
  } catch (error) { translateDatabaseError(error) }
}

async function applyPlan(tx: DatabaseTransaction, userId: string, payload: LibraryData, plan: ImportPlan): Promise<void> {
  if (plan.mode === "replace") {
    await tx.delete(books).where(eq(books.userId, userId))
    await tx.delete(shelves).where(and(eq(shelves.userId, userId), eq(shelves.isDefault, false)))
  }
  if (plan.shelves.create.length) {
    await tx.insert(shelves).values(plan.shelves.create.map((shelf) => ({ id: shelf.id, userId, title: shelf.title, isDefault: false })))
  }
  const source = new Map(payload.books.map((book) => [book.id, book]))
  const values = plan.books.insert.map((entry) => {
    const book = source.get(entry.sourceId)
    if (!book) throw revisionConflict()
    return { id: entry.id, userId, isbn: normalizedBookIdentifier(book.isbn), title: book.title, subtitle: book.subtitle ?? null,
      authors: book.authors, publishers: book.publishers ?? [], numberOfPages: book.number_of_pages, publishDate: book.publish_date,
      coverSmall: book.cover.small, coverMedium: book.cover.medium, coverLarge: book.cover.large, status: book.status, shelfId: entry.shelfId,
      catalogue: book.catalogue ?? { source: "import" as const, isbnVerified: false } }
  })
  for (let offset = 0; offset < values.length; offset += 100) await tx.insert(books).values(values.slice(offset, offset + 100))
}

async function confirmImport(input: unknown): Promise<ConfirmedImport> {
  const userId = await getRequiredUserId()
  const parsed = confirmSchema.safeParse(input)
  if (!parsed.success) throw new DomainError("INVALID_INPUT", "La confirmación no es válida. Prepara de nuevo la revisión del archivo.")
  const { previewId, expectedRevision, idempotencyKey } = parsed.data
  try {
    return await withRlsContext(userId, async (tx) => {
      const currentRevision = await lockLibrary(tx)
      const [preview] = await tx.select({ preview: importPreviews, expired: sql<boolean>`${importPreviews.expiresAt} <= now()` }).from(importPreviews)
        .where(and(eq(importPreviews.id, previewId), eq(importPreviews.userId, userId))).limit(1)
      const [existing] = await tx.select().from(libraryOperations)
        .where(and(eq(libraryOperations.userId, userId), eq(libraryOperations.operation, "import.confirm"), eq(libraryOperations.idempotencyKey, idempotencyKey))).limit(1)
      const [consumed] = preview ? await tx.select({ id: libraryOperations.id }).from(libraryOperations)
        .where(and(eq(libraryOperations.userId, userId), eq(libraryOperations.previewId, previewId))).limit(1) : []
      const digest = preview ? sha256(canonicalJson(confirmationInput(preview.preview))) : null

      const decision = decideConfirmation({
        existing: existing ? { operationId: existing.id, inputDigest: existing.inputDigest, previewId: existing.previewId } : null,
        preview: preview ? { id: preview.preview.id, revision: preview.preview.revision, expired: preview.expired, rulesVersion: preview.preview.rulesVersion, confirmed: Boolean(consumed) } : null,
        previewId, digest, expectedRevision, currentRevision,
      })
      if (decision.kind === "replay") return { operationId: existing!.id, status: existing!.status, result: existing!.result, replayed: true }
      if (decision.kind === "reject") {
        if (decision.code === "IDEMPOTENCY_CONFLICT") throw idempotencyConflict()
        if (decision.code === "PREVIEW_EXPIRED") throw previewExpired()
        if (decision.code === "REVISION_CONFLICT") throw revisionConflict()
        if (decision.code === "ALREADY_CONFIRMED") throw new DomainError("CONFLICT", "Esta revisión ya se confirmó. Prepara una nueva si quieres volver a importar el archivo.")
        throw new DomainError("NOT_FOUND", "La revisión de la importación no está disponible. Prepárala de nuevo.")
      }

      // Se vuelve a validar la entrada almacenada y a derivar el plan: con la misma revisión debe coincidir.
      const stored = preview!.preview
      let payload: LibraryData
      try { payload = parseLibraryImport(stored.payload) } catch { throw previewExpired() }
      const plan = buildImportPlan({ imported: payload, current: await readSnapshot(tx, userId), mode: stored.mode, allocateId: allocator(stored.id),
        covers: { found: stored.plan.counts.coversFound, pending: stored.plan.counts.coversPending } })
      if (canonicalJson(plan) !== canonicalJson(stored.plan)) throw revisionConflict()
      await applyPlan(tx, userId, payload, plan)
      const result = operationResult(plan)
      const [operation] = await tx.insert(libraryOperations).values({
        userId, operation: "import.confirm", idempotencyKey, inputDigest: digest!, previewId: stored.id, status: "committed", result,
      }).returning({ id: libraryOperations.id })
      return { operationId: operation.id, status: "committed" as const, result, replayed: false }
    })
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

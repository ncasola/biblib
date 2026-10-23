import { createHash } from "node:crypto"
import { and, asc, eq, sql } from "drizzle-orm"
import type { DatabaseTransaction } from "./db/client"
import { books, importPreviews, libraryOperations, shelves } from "./db/schema"
import { DomainError, idempotencyConflict, previewExpired, revisionConflict } from "./domain-errors"
import { normalizedBookIdentifier } from "./isbn"
import { parseLibraryImport } from "./library-import"
import {
  buildImportPlan, canonicalJson, confirmationInput, decideConfirmation, operationResult,
  type CollectionSnapshot, type IdAllocator, type ImportOperationResult, type ImportPlan,
} from "./import-plan"
import type { LibraryData } from "./types"

// Publicador base de importaciones (U-DAT-03), extraído de la confirmación de U-DAT-01. Recibe una
// transacción ya situada en el contexto RLS del dueño y no hace red: bloqueo de colección, CAS de
// revisión, mapeo de IDs, SQL por conjuntos y resultado durable. U-DAT-02 le añadirá el snapshot y
// U-DAT-04 los conjuntos multiparte.

export interface PublishRequest {
  userId: string
  previewId: string
  expectedRevision: string
  idempotencyKey: string
}

export interface PublishOutcome {
  operationId: string
  result: ImportOperationResult
  /** true si se recuperó el resultado durable de una confirmación anterior con la misma clave. */
  replayed: boolean
  /** IDs de los libros insertados por esta publicación (vacío al recuperar un resultado). */
  insertedBookIds: string[]
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

/** IDs nuevos derivados de la vista previa: la misma entrada produce el mismo plan al confirmar. */
export function previewAllocator(seed: string): IdAllocator {
  return (kind, sourceId) => {
    const hex = sha256(`${seed}\u0000${kind}\u0000${sourceId}`)
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
}

/** Hash de la entrada canónica de una confirmación: archivo, modo y reglas de la vista previa. */
export function confirmationDigest(preview: { inputDigest: string; mode: "merge" | "replace"; rulesVersion: number }): string {
  return sha256(canonicalJson(confirmationInput(preview)))
}

/** Bloqueo de colección de U-DAT-01: el dueño sale de `auth.uid()` de la transacción. */
export async function lockCollection(tx: DatabaseTransaction): Promise<string> {
  const rows = await tx.execute<{ revision: string }>(sql`select biblib.lock_library() as revision`)
  const revision = rows[0]?.revision
  if (!revision) throw new Error("No se pudo bloquear la colección.")
  return revision
}

export async function readCollectionSnapshot(tx: DatabaseTransaction, userId: string): Promise<CollectionSnapshot> {
  const shelfRows = await tx.select({ id: shelves.id, title: shelves.title, isDefault: shelves.isDefault }).from(shelves)
    .where(eq(shelves.userId, userId)).orderBy(asc(shelves.createdAt), asc(shelves.id))
  const bookRows = await tx.select({ id: books.id, isbn: books.isbn }).from(books)
    .where(eq(books.userId, userId)).orderBy(asc(books.id))
  return { shelves: shelfRows, books: bookRows }
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

/**
 * Publica una vista previa confirmada. Bajo el bloqueo de colección decide por este orden: clave
 * (una repetición idéntica recupera el resultado durable), caducidad/reglas y revisión. Nunca
 * fuerza: un rechazo lanza `DomainError` sin escribir nada.
 */
export async function publishImport(tx: DatabaseTransaction, request: PublishRequest): Promise<PublishOutcome> {
  const { userId, previewId, expectedRevision, idempotencyKey } = request
  const currentRevision = await lockCollection(tx)
  const [preview] = await tx.select({ preview: importPreviews, expired: sql<boolean>`${importPreviews.expiresAt} <= now()` }).from(importPreviews)
    .where(and(eq(importPreviews.id, previewId), eq(importPreviews.userId, userId))).limit(1)
  const [existing] = await tx.select().from(libraryOperations)
    .where(and(eq(libraryOperations.userId, userId), eq(libraryOperations.operation, "import.confirm"), eq(libraryOperations.idempotencyKey, idempotencyKey))).limit(1)
  const [consumed] = preview ? await tx.select({ id: libraryOperations.id }).from(libraryOperations)
    .where(and(eq(libraryOperations.userId, userId), eq(libraryOperations.previewId, previewId))).limit(1) : []
  const digest = preview ? confirmationDigest(preview.preview) : null

  const decision = decideConfirmation({
    existing: existing ? { operationId: existing.id, inputDigest: existing.inputDigest, previewId: existing.previewId } : null,
    preview: preview ? { id: preview.preview.id, revision: preview.preview.revision, expired: preview.expired, rulesVersion: preview.preview.rulesVersion, confirmed: Boolean(consumed) } : null,
    previewId, digest, expectedRevision, currentRevision,
  })
  if (decision.kind === "replay") return { operationId: existing!.id, result: existing!.result, replayed: true, insertedBookIds: [] }
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
  const plan = buildImportPlan({ imported: payload, current: await readCollectionSnapshot(tx, userId), mode: stored.mode, allocateId: previewAllocator(stored.id),
    covers: { found: stored.plan.counts.coversFound, pending: stored.plan.counts.coversPending } })
  if (canonicalJson(plan) !== canonicalJson(stored.plan)) throw revisionConflict()
  await applyPlan(tx, userId, payload, plan)
  const result = operationResult(plan)
  const [operation] = await tx.insert(libraryOperations).values({
    userId, operation: "import.confirm", idempotencyKey, inputDigest: digest!, previewId: stored.id, status: "committed", result,
  }).returning({ id: libraryOperations.id })
  return { operationId: operation.id, result, replayed: false, insertedBookIds: plan.books.insert.map((entry) => entry.id) }
}

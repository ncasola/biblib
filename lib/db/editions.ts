import "server-only"
import { createHash, randomUUID } from "node:crypto"
import { and, asc, count, eq, inArray, sql } from "drizzle-orm"
import type { DatabaseTransaction } from "./client"
import { bookFields, books, copies, editions, libraryOperations, shelves, type LibraryOperationKind } from "./schema"
import { lockLibrary, mapRowToBook } from "./library"
import { copyVerification, editionValues } from "./model"
import { canonicalJson } from "../import-plan"
import { DomainError, editionShared, idempotencyConflict, revisionConflict } from "../domain-errors"
import type { Book } from "../types"

// Contratos del modelo obra/edición/ejemplar (U-DAT-06). Cada operación se ejecuta en una transacción con el
// contexto RLS del dueño y el bloqueo de colección; las que crean o cambian datos admiten una clave de
// idempotencia por (dueño, operación, clave) con el hash de su entrada canónica: repetir con la misma entrada
// recupera el resultado durable, y con otra entrada es un conflicto.

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

/** Ficha de un ejemplar con el número de ejemplares de su edición (una subconsulta para una sola fila). */
export async function findBook(tx: DatabaseTransaction, userId: string, id: string): Promise<Book | null> {
  const [row] = await tx.select({ book: { ...bookFields, editionCopies: books.editionCopies }, shelfTitle: shelves.title }).from(books)
    .innerJoin(shelves, and(eq(books.shelfId, shelves.id), eq(shelves.userId, userId)))
    .where(and(eq(books.id, id), eq(books.userId, userId))).limit(1)
  return row ? mapRowToBook(row) : null
}

/** Primer ejemplar de la cuenta con ese ISBN-13 (tarea T7): igualdad indexada por (dueño, ISBN-13). */
export async function findBookByIsbn(tx: DatabaseTransaction, userId: string, isbn13: string): Promise<Book | null> {
  const [row] = await tx.select({ book: { ...bookFields, editionCopies: books.editionCopies }, shelfTitle: shelves.title }).from(books)
    .innerJoin(shelves, and(eq(books.shelfId, shelves.id), eq(shelves.userId, userId)))
    .where(and(eq(books.userId, userId), eq(books.isbn13, isbn13))).orderBy(asc(books.createdAt), asc(books.id)).limit(1)
  return row ? mapRowToBook(row) : null
}

/** Ejemplares de una edición propia, como máximo `limit`, en orden de alta. */
export async function editionCopies(tx: DatabaseTransaction, userId: string, editionId: string, limit = 50): Promise<Book[]> {
  const rows = await tx.select({ book: bookFields, shelfTitle: shelves.title }).from(books)
    .innerJoin(shelves, and(eq(books.shelfId, shelves.id), eq(shelves.userId, userId)))
    .where(and(eq(books.userId, userId), eq(books.editionId, editionId))).orderBy(asc(books.createdAt), asc(books.id)).limit(limit)
  return rows.map(mapRowToBook)
}

interface Idempotent { operation: LibraryOperationKind; key?: string; input: unknown }

/** Resultado durable de una operación con la misma clave, o null si es nueva; lanza si la clave se usó con otra entrada. */
async function replayed<T>(tx: DatabaseTransaction, userId: string, request: Idempotent): Promise<{ digest: string; result: T | null }> {
  const digest = sha256(canonicalJson({ operation: request.operation, input: request.input }))
  if (!request.key) return { digest, result: null }
  const [existing] = await tx.select({ inputDigest: libraryOperations.inputDigest, result: libraryOperations.result }).from(libraryOperations)
    .where(and(eq(libraryOperations.userId, userId), eq(libraryOperations.operation, request.operation), eq(libraryOperations.idempotencyKey, request.key))).limit(1)
  if (!existing) return { digest, result: null }
  if (existing.inputDigest !== digest) throw idempotencyConflict()
  return { digest, result: existing.result as T }
}

async function record(tx: DatabaseTransaction, userId: string, request: Idempotent, digest: string, result: Record<string, unknown>): Promise<void> {
  if (!request.key) return
  await tx.insert(libraryOperations).values({ userId, operation: request.operation, idempotencyKey: request.key, inputDigest: digest, status: "committed", result })
}

async function ownShelf(tx: DatabaseTransaction, userId: string, shelfId: string): Promise<string> {
  const [shelf] = await tx.select({ id: shelves.id }).from(shelves).where(and(eq(shelves.id, shelfId), eq(shelves.userId, userId))).limit(1)
  if (!shelf) throw new DomainError("NOT_FOUND", "La estantería ya no está disponible.")
  return shelf.id
}

/** Datos bibliográficos de una edición que se pueden cambiar con `updateEdition`. */
export type EditionPatch = Pick<Book, "isbn" | "title" | "subtitle" | "authors" | "publishers" | "publish_date" | "number_of_pages" | "cover" | "catalogue">

export function editionExists(): DomainError {
  return new DomainError("CONFLICT", "Ya tienes esta edición en tu biblioteca. Puedes abrir su ejemplar o añadir otro ejemplar de la misma edición.")
}

/** Datos de una edición nueva y de su primer ejemplar. */
export type NewEditionInput = EditionPatch & Pick<Book, "status" | "edition" | "verification">

export interface CreateEditionRequest {
  book: NewEditionInput
  shelfId: string
  idempotencyKey?: string
}

/**
 * Crea una edición (con ISBN-13 o sin él) con su primer ejemplar. Si la cuenta ya tiene una edición con ese
 * ISBN no crea otra: «ya existe» ofrece abrir el ejemplar o añadir otro, nunca lo hace por error.
 */
export async function createEdition(tx: DatabaseTransaction, userId: string, request: CreateEditionRequest): Promise<Book> {
  await lockLibrary(tx)
  const { book } = request
  const shelfId = await ownShelf(tx, userId, request.shelfId)
  const idem: Idempotent = { operation: "edition.create", key: request.idempotencyKey, input: { edition: editionValues(book), shelfId, status: book.status, verification: copyVerification(book) } }
  const { digest, result } = await replayed<{ copyId: string }>(tx, userId, idem)
  if (result) {
    const again = await findBook(tx, userId, result.copyId)
    if (!again) throw new DomainError("NOT_FOUND", "El libro que se creó con esta operación ya no está en tu biblioteca.")
    return again
  }
  if (book.isbn) {
    const [existing] = await tx.select({ id: editions.id }).from(editions).where(and(eq(editions.userId, userId), eq(editions.isbn13, book.isbn))).limit(1)
    if (existing) throw editionExists()
  }
  const editionId = randomUUID()
  const copyId = randomUUID()
  await tx.insert(editions).values({ id: editionId, userId, ...editionValues(book) })
  await tx.insert(copies).values({ id: copyId, userId, editionId, status: book.status, shelfId, editionVerification: copyVerification(book) })
  await record(tx, userId, idem, digest, { copyId, editionId })
  const created = await findBook(tx, userId, copyId)
  if (!created) throw new DomainError("NOT_FOUND", "No se pudo recuperar el libro guardado.")
  return created
}

export interface CreateCopyRequest {
  editionId: string
  placement: { shelfId: string }
  status: Book["status"]
  idempotencyKey?: string
}

/** Añade un ejemplar a una edición propia. Explícito: es la respuesta a «ya existe», nunca un efecto lateral. */
export async function createCopy(tx: DatabaseTransaction, userId: string, request: CreateCopyRequest): Promise<Book> {
  await lockLibrary(tx)
  const shelfId = await ownShelf(tx, userId, request.placement.shelfId)
  const idem: Idempotent = { operation: "copy.create", key: request.idempotencyKey, input: { editionId: request.editionId, shelfId, status: request.status } }
  const { digest, result } = await replayed<{ copyId: string }>(tx, userId, idem)
  if (result) {
    const again = await findBook(tx, userId, result.copyId)
    if (!again) throw new DomainError("NOT_FOUND", "El ejemplar que se creó con esta operación ya no está en tu biblioteca.")
    return again
  }
  // RLS: una edición de otra cuenta no existe para esta; el error no confirma nada.
  const [edition] = await tx.select({ id: editions.id }).from(editions).where(and(eq(editions.id, request.editionId), eq(editions.userId, userId))).limit(1)
  if (!edition) throw new DomainError("NOT_FOUND", "La edición ya no está disponible.")
  const copyId = randomUUID()
  // Un ejemplar nuevo nunca hereda la comprobación física de otro: empieza sin verificar.
  await tx.insert(copies).values({ id: copyId, userId, editionId: edition.id, status: request.status, shelfId, editionVerification: { isbnVerified: false } })
  await record(tx, userId, idem, digest, { copyId, editionId: edition.id })
  return (await findBook(tx, userId, copyId))!
}

export interface UpdateEditionRequest {
  editionId: string
  expectedVersion: string
  patch: EditionPatch
  /** Ejemplares que la persona ha confirmado que cambian; obligatorio si la edición tiene más de uno. */
  confirmCopies?: number
  idempotencyKey?: string
}

export interface UpdateEditionResult { editionId: string; version: string; copies: number }

/** Edición propia bloqueada con su versión y su número de ejemplares, o null. */
async function lockedEdition(tx: DatabaseTransaction, userId: string, editionId: string) {
  const [row] = await tx.select().from(editions).where(and(eq(editions.id, editionId), eq(editions.userId, userId))).limit(1).for("update")
  if (!row) return null
  const [{ total }] = await tx.select({ total: count() }).from(copies).where(and(eq(copies.userId, userId), eq(copies.editionId, editionId)))
  return { row, copies: total }
}

/**
 * Cambia los datos bibliográficos de una edición. Si la comparten varios ejemplares exige confirmar cuántos
 * cambian (`EDITION_SHARED` informa del número actual). La versión es la de la edición: un token de ejemplar
 * o de ficha no autoriza por sí solo cambiar una edición compartida.
 */
export async function updateEdition(tx: DatabaseTransaction, userId: string, request: UpdateEditionRequest, provenance: (current: typeof editions.$inferSelect) => Book["catalogue"]): Promise<UpdateEditionResult> {
  await lockLibrary(tx)
  const idem: Idempotent = { operation: "edition.update", key: request.idempotencyKey, input: { editionId: request.editionId, expectedVersion: request.expectedVersion, patch: request.patch, confirmCopies: request.confirmCopies ?? null } }
  const { digest, result } = await replayed<UpdateEditionResult>(tx, userId, idem)
  if (result) return result
  const current = await lockedEdition(tx, userId, request.editionId)
  if (!current) throw new DomainError("NOT_FOUND", "La edición ya no está disponible.")
  if (current.row.version !== request.expectedVersion) throw new DomainError("CONFLICT", "Esta edición ha cambiado desde que la abriste. Conserva tus cambios y carga la versión actual antes de guardar.")
  if (current.copies > 1 && request.confirmCopies !== current.copies) throw editionShared(current.copies)
  if (request.patch.isbn && request.patch.isbn !== current.row.isbn13) {
    const [other] = await tx.select({ id: editions.id }).from(editions).where(and(eq(editions.userId, userId), eq(editions.isbn13, request.patch.isbn))).limit(1)
    if (other) throw new DomainError("CONFLICT", "Ya tienes otra edición con ese ISBN. Si son la misma, fusiónalas en lugar de repetir el ISBN.")
  }
  const values = editionValues({ ...request.patch, catalogue: provenance(current.row) })
  const [updated] = await tx.update(editions).set({ ...values, language: current.row.language, identifiers: current.row.identifiers, updatedAt: new Date() })
    .where(and(eq(editions.id, request.editionId), eq(editions.userId, userId), eq(editions.version, request.expectedVersion))).returning({ version: editions.version })
  if (!updated) throw new DomainError("CONFLICT", "Esta edición ha cambiado desde que la abriste. Conserva tus cambios y carga la versión actual antes de guardar.")
  // Un ISBN distinto ya no es el que se comprobó en cada ejemplar: su verificación vuelve a falso.
  if ((request.patch.isbn ?? null) !== current.row.isbn13) {
    await tx.update(copies).set({ editionVerification: sql`${copies.editionVerification} || '{"isbnVerified": false}'::jsonb`, updatedAt: new Date() })
      .where(and(eq(copies.userId, userId), eq(copies.editionId, request.editionId)))
    if (request.patch.isbn) await tx.update(copies).set({ legacyIdentifier: null }).where(and(eq(copies.userId, userId), eq(copies.editionId, request.editionId), sql`${copies.legacyIdentifier} is not null`))
  }
  const outcome = { editionId: request.editionId, version: updated.version, copies: current.copies }
  await record(tx, userId, idem, digest, { ...outcome })
  return outcome
}

export interface MergeEditionsRequest {
  sourceIds: string[]
  targetId: string
  /** Versión vista de cada edición, incluida la de destino. */
  expectedVersions: Record<string, string>
  expectedRevision: string
  idempotencyKey: string
}

export interface MergeEditionsResult {
  targetId: string
  /** Ejemplares que pasan a la edición de destino. */
  moved: number
  /** Mapeo explícito de cada edición fusionada a la de destino, para el informe y los respaldos. */
  mapping: { sourceId: string; targetId: string }[]
  /** Identificadores legacy retirados al pasar a una edición con ISBN-13 (se conservan aquí). */
  legacyCleared: { copyId: string; legacyIdentifier: string }[]
}

/**
 * Fusiona ediciones propias en una de destino: sus ejemplares pasan a ella con su estado, ubicación y
 * comprobación; las ediciones vacías se retiran. El destino conserva sus datos y, si no tiene ISBN-13, obra o
 * portada privada, adopta la de las fuentes cuando no hay dos distintas. Exige la revisión de colección vista.
 */
export async function mergeEditions(tx: DatabaseTransaction, userId: string, request: MergeEditionsRequest): Promise<MergeEditionsResult> {
  const revision = await lockLibrary(tx)
  const sourceIds = [...new Set(request.sourceIds)]
  if (!sourceIds.length || sourceIds.length > 20 || sourceIds.includes(request.targetId)) throw new DomainError("INVALID_INPUT", "Elige entre 1 y 20 ediciones distintas de la de destino.")
  const idem: Idempotent = { operation: "edition.merge", key: request.idempotencyKey, input: { sourceIds: [...sourceIds].sort(), targetId: request.targetId, expectedVersions: request.expectedVersions, expectedRevision: request.expectedRevision } }
  const { digest, result } = await replayed<MergeEditionsResult>(tx, userId, idem)
  if (result) return result
  if (revision !== request.expectedRevision) throw revisionConflict()
  const ids = [request.targetId, ...sourceIds]
  const rows = await tx.select().from(editions).where(and(eq(editions.userId, userId), inArray(editions.id, ids))).for("update")
  // Una edición ajena o ya fusionada no existe para esta cuenta: error genérico, sin confirmar nada.
  if (rows.length !== ids.length) throw new DomainError("NOT_FOUND", "Alguna edición ya no está disponible. No se ha fusionado nada.")
  if (rows.some((row) => row.version !== request.expectedVersions[row.id])) throw new DomainError("CONFLICT", "Alguna edición ha cambiado desde que la revisaste. No se ha fusionado nada: vuelve a revisarlas.")
  const target = rows.find((row) => row.id === request.targetId)!
  const sources = rows.filter((row) => row.id !== request.targetId)
  const distinct = <T>(values: (T | null)[]) => [...new Set(values.filter((value): value is T => value !== null))]
  const isbns = distinct([target.isbn13, ...sources.map((row) => row.isbn13)])
  if (isbns.length > 1) throw new DomainError("INVALID_INPUT", "Esas ediciones tienen ISBN distintos: no son la misma edición. No se ha fusionado nada.")
  const workIds = distinct([target.workId, ...sources.map((row) => row.workId)])
  if (workIds.length > 1) throw new DomainError("INVALID_INPUT", "Esas ediciones pertenecen a obras distintas. No se ha fusionado nada.")
  const assets = distinct(sources.map((row) => row.coverAssetId))
  const legacy = isbns.length ? await tx.select({ id: copies.id, legacyIdentifier: copies.legacyIdentifier }).from(copies)
    .where(and(eq(copies.userId, userId), inArray(copies.editionId, ids), sql`${copies.legacyIdentifier} is not null`)) : []
  const moved = await tx.update(copies).set({ editionId: target.id, ...(isbns.length ? { legacyIdentifier: null } : {}), updatedAt: new Date() })
    .where(and(eq(copies.userId, userId), inArray(copies.editionId, sourceIds))).returning({ id: copies.id })
  if (isbns.length) await tx.update(copies).set({ legacyIdentifier: null }).where(and(eq(copies.userId, userId), eq(copies.editionId, target.id), sql`${copies.legacyIdentifier} is not null`))
  // La poda ya retiró las ediciones vacías: el destino puede adoptar su ISBN-13, obra o portada.
  const adopt = { ...(!target.isbn13 && isbns.length ? { isbn13: isbns[0] } : {}), ...(!target.workId && workIds.length ? { workId: workIds[0] } : {}),
    ...(!target.coverAssetId && assets.length === 1 ? { coverAssetId: assets[0] } : {}) }
  await tx.update(editions).set({ ...adopt, updatedAt: new Date() }).where(and(eq(editions.id, target.id), eq(editions.userId, userId)))
  const outcome: MergeEditionsResult = {
    targetId: target.id, moved: moved.length, mapping: sources.map((row) => ({ sourceId: row.id, targetId: target.id })),
    legacyCleared: legacy.flatMap((row) => row.legacyIdentifier ? [{ copyId: row.id, legacyIdentifier: row.legacyIdentifier }] : []),
  }
  await record(tx, userId, idem, digest, { ...outcome })
  return outcome
}


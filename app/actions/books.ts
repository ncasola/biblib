"use server"

import { and, eq, ne, inArray } from "drizzle-orm"
import { withRlsContext, type DatabaseTransaction } from "@/lib/db/client"
import { books, shelves } from "@/lib/db/schema"
import { ensureDefaultShelf, lockLibrary, mapRowToBook } from "@/lib/db/library"
import { getRequiredUserId } from "@/lib/server-user"
import { parseBookInput, parseUuid, statusSchema } from "@/lib/book-validation"
import { DomainError, translateDatabaseError } from "@/lib/domain-errors"
import { normalizedBookIdentifier, normalizeIsbn } from "@/lib/isbn"
import { bibliographicCatalog } from "@/lib/bibliographic-catalog/server"
import { classifyCoverLookup } from "@/lib/jobs/contracts"
import type { Book } from "@/lib/types"
import { domainMutation } from "@/lib/server-action"
import { assertBookVersion, bookVersionConflict } from "@/lib/book-version"
import { telemetry } from "@/lib/observability/server"
import { observeOperation } from "@/lib/observability/operations"
import { readCatalogConfig } from "@/lib/bibliographic-catalog/config"
import { catalogueForCreate, catalogueForUpdate, catalogueWithField } from "@/lib/catalogue-provenance"

/** U-BIB-04: los writers de procedencia v2 solo se activan con BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED=true. */
function bibliographyReviewEnabled(): boolean {
  try { return readCatalogConfig().reviewEnabled } catch { return false }
}

async function getShelf(tx: DatabaseTransaction, userId: string, requested: string): Promise<string> {
  if (!requested || requested === "shelf-1") return ensureDefaultShelf(tx, userId)
  const id = parseUuid(requested)
  const [shelf] = await tx.select({ id: shelves.id }).from(shelves)
    .where(and(eq(shelves.id, id), eq(shelves.userId, userId))).limit(1)
  if (!shelf) throw new DomainError("NOT_FOUND", "La estantería ya no está disponible.")
  return shelf.id
}

async function findBook(tx: DatabaseTransaction, userId: string, id: string): Promise<Book | null> {
  const [row] = await tx.select({ book: books, shelfTitle: shelves.title }).from(books)
    .innerJoin(shelves, and(eq(books.shelfId, shelves.id), eq(shelves.userId, userId)))
    .where(and(eq(books.id, id), eq(books.userId, userId))).limit(1)
  return row ? mapRowToBook(row) : null
}

export async function getBookDetailAction(bookId: string): Promise<Book | null> {
  let id: string
  try { id = parseUuid(bookId) } catch { return null }
  const userId = await getRequiredUserId()
  return withRlsContext(userId, (tx) => findBook(tx, userId, id))
}

export async function getBookByIsbnAction(value: string): Promise<Book | null> {
  const userId = await getRequiredUserId()
  if (typeof value !== "string" || value.length > 100) throw new DomainError("INVALID_INPUT", "El ISBN no es válido.")
  const isbn = normalizeIsbn(value)
  if (!isbn) throw new DomainError("INVALID_INPUT", "El ISBN no es válido.")
  return withRlsContext(userId, async (tx) => {
    const candidates = await tx.select({ id: books.id, isbn: books.isbn }).from(books).where(eq(books.userId, userId))
    const match = candidates.find((book) => normalizeIsbn(book.isbn) === isbn)
    return match ? findBook(tx, userId, match.id) : null
  })
}

async function assertUniqueIsbn(tx: DatabaseTransaction, userId: string, isbn: string, exceptId?: string): Promise<void> {
  const candidates = await tx.select({ isbn: books.isbn }).from(books)
    .where(and(eq(books.userId, userId), exceptId ? ne(books.id, exceptId) : undefined))
  if (candidates.some((entry) => normalizedBookIdentifier(entry.isbn) === normalizedBookIdentifier(isbn))) {
    throw new DomainError("CONFLICT", "El libro ya está en la biblioteca.")
  }
}

async function addBook(input: unknown): Promise<Book> {
  const userId = await getRequiredUserId()
  const book = parseBookInput(input)
  const catalogue = catalogueForCreate(book.catalogue, bibliographyReviewEnabled())
  try {
    return await withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      const shelfId = await getShelf(tx, userId, book.shelf_id)
      const id = crypto.randomUUID()
      const isbn = book.isbn || `manual-${id}`
      await assertUniqueIsbn(tx, userId, isbn)
      await tx.insert(books).values({
        id, userId, isbn, title: book.title, subtitle: book.subtitle ?? null,
        authors: book.authors, publishers: book.publishers ?? [], numberOfPages: book.number_of_pages,
        publishDate: book.publish_date, coverSmall: book.cover.small, coverMedium: book.cover.medium,
        coverLarge: book.cover.large, status: book.status, shelfId, catalogue,
      })
      const created = await findBook(tx, userId, id)
      if (!created) throw new DomainError("NOT_FOUND", "No se pudo recuperar el libro guardado.")
      return created
    })
  } catch (error) { translateDatabaseError(error) }
}

async function updateBook(bookId: string, input: unknown): Promise<Book> {
  const userId = await getRequiredUserId()
  const id = parseUuid(bookId)
  const book = parseBookInput(input)
  try {
    return await withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      const current = await findBook(tx, userId, id)
      if (!current) throw new DomainError("NOT_FOUND", "El libro ya no está disponible.")
      assertBookVersion(current, book.version)
      const shelfId = await getShelf(tx, userId, book.shelf_id)
      const isbn = book.isbn || `manual-${id}`
      await assertUniqueIsbn(tx, userId, isbn, id)
      // La procedencia sale de la ficha bloqueada y versionada: los campos cambiados pasan a «manual».
      const catalogue = catalogueForUpdate(current, { ...book, isbn }, bibliographyReviewEnabled())
      const changed = await tx.update(books).set({
        isbn, title: book.title, subtitle: book.subtitle ?? null, authors: book.authors,
        publishers: book.publishers ?? [], numberOfPages: book.number_of_pages,
        publishDate: book.publish_date, coverSmall: book.cover.small, coverMedium: book.cover.medium,
        coverLarge: book.cover.large, status: book.status, shelfId, catalogue, updatedAt: new Date(),
      }).where(and(eq(books.id, id), eq(books.userId, userId), eq(books.version, current.version!))).returning({ id: books.id })
      if (!changed.length) throw bookVersionConflict()
      return (await findBook(tx, userId, id))!
    })
  } catch (error) { translateDatabaseError(error) }
}

async function updateBookStatus(bookId: string, input: Book["status"], version: unknown): Promise<Book> {
  const userId = await getRequiredUserId()
  const id = parseUuid(bookId)
  const status = statusSchema.safeParse(input)
  if (!status.success) throw new DomainError("INVALID_INPUT", "El estado de lectura no es válido.")
  try {
    return await withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      const current = await findBook(tx, userId, id)
      if (!current) throw new DomainError("NOT_FOUND", "El libro ya no está disponible.")
      assertBookVersion(current, version)
      const updated = await tx.update(books).set({ status: status.data, updatedAt: new Date() })
        .where(and(eq(books.id, id), eq(books.userId, userId), eq(books.version, current.version!))).returning({ id: books.id })
      if (!updated.length) throw bookVersionConflict()
      return (await findBook(tx, userId, id))!
    })
  } catch (error) { translateDatabaseError(error) }
}

async function deleteBook(bookId: string, version: unknown): Promise<void> {
  const userId = await getRequiredUserId()
  const id = parseUuid(bookId)
  try {
    await withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      const current = await findBook(tx, userId, id)
      if (!current) throw new DomainError("NOT_FOUND", "El libro ya no está disponible.")
      assertBookVersion(current, version)
      const removed = await tx.delete(books).where(and(eq(books.id, id), eq(books.userId, userId), eq(books.version, current.version!))).returning({ id: books.id })
      if (!removed.length) throw bookVersionConflict()
    })
  } catch (error) { translateDatabaseError(error) }
}

async function refreshBookCover(bookId: string, version: unknown): Promise<Book> {
  const current = await getBookDetailAction(bookId)
  if (!current) throw new DomainError("NOT_FOUND", "El libro ya no está disponible.")
  assertBookVersion(current, version)
  if (!normalizeIsbn(current.isbn)) throw new DomainError("INVALID_INPUT", "Añade un ISBN válido para buscar la portada.")
  const userId = await getRequiredUserId()
  // Misma frontera que el alta y los trabajos: el orquestador. La consulta termina antes de abrir la transacción.
  const outcome = classifyCoverLookup(await bibliographicCatalog.getCover(normalizeIsbn(current.isbn)!, { userId }))
  if (outcome.kind === "retry") throw outcome.code === "RATE_LIMITED"
    ? new DomainError("RATE_LIMITED", "El catálogo ha limitado las consultas. Vuelve a intentarlo más tarde.")
    : new DomainError("PROVIDER_UNAVAILABLE", "No se pudo consultar el catálogo de portadas. Puedes reintentar o indicar su URL manualmente.")
  if (outcome.kind === "failed") throw new DomainError("PROVIDER_UNAVAILABLE", "No hay ninguna fuente de portadas disponible ahora. Puedes indicar su URL manualmente.")
  if (outcome.kind === "notFound") throw new DomainError("NOT_FOUND", "No se ha podido recuperar una portada. Puedes indicar su URL manualmente.")
  return withRlsContext(userId, async (tx) => {
    await lockLibrary(tx)
    const latest = await findBook(tx, userId, current.id)
    if (!latest) throw new DomainError("NOT_FOUND", "El libro ya no está disponible.")
    assertBookVersion(latest, current.version)
    if (normalizedBookIdentifier(latest.isbn) !== normalizedBookIdentifier(current.isbn)) throw new DomainError("CONFLICT", "El ISBN ha cambiado mientras se buscaba la portada. Vuelve a intentarlo.")
    const catalogue = catalogueWithField(latest.catalogue, "cover", { provider: outcome.provider, ...(outcome.sourceUrl ? { sourceUrl: outcome.sourceUrl } : {}), retrievedAt: new Date().toISOString(), selection: "user-selected" }, bibliographyReviewEnabled())
    const changed = await tx.update(books).set({ coverSmall: outcome.cover.small, coverMedium: outcome.cover.medium,
      coverLarge: outcome.cover.large, catalogue, updatedAt: new Date() }).where(and(eq(books.id, current.id), eq(books.userId, userId), eq(books.version, latest.version!))).returning({ id: books.id })
    if (!changed.length) throw bookVersionConflict()
    return (await findBook(tx, userId, current.id))!
  })
}

async function moveBookShelf(bookId: string, shelfId: string, version: unknown): Promise<Book> {
  const userId = await getRequiredUserId()
  const id = parseUuid(bookId)
  return withRlsContext(userId, async (tx) => {
    await lockLibrary(tx)
    const current = await findBook(tx, userId, id)
    if (!current) throw new DomainError("NOT_FOUND", "El libro ya no está disponible.")
    assertBookVersion(current, version)
    const target = await getShelf(tx, userId, shelfId)
    const changed = await tx.update(books).set({ shelfId: target, updatedAt: new Date() })
      .where(and(eq(books.id, id), eq(books.userId, userId), eq(books.version, current.version!))).returning({ id: books.id })
    if (!changed.length) throw bookVersionConflict()
    return (await findBook(tx, userId, id))!
  })
}

async function moveBooksShelf(bookIds: string[], shelfId: string): Promise<void> {
  const userId = await getRequiredUserId()
  if (!Array.isArray(bookIds) || bookIds.length === 0 || bookIds.length > 200) throw new DomainError("INVALID_INPUT", "Selecciona entre 1 y 200 libros.")
  const ids = [...new Set(bookIds.map(parseUuid))]
  await withRlsContext(userId, async (tx) => {
    await lockLibrary(tx)
    const target = await getShelf(tx, userId, shelfId)
    const changed = await tx.update(books).set({ shelfId: target, updatedAt: new Date() })
      .where(and(inArray(books.id, ids), eq(books.userId, userId))).returning({ id: books.id })
    if (changed.length !== ids.length) throw new DomainError("NOT_FOUND", "Algún libro ya no está disponible. No se ha realizado el movimiento.")
  })
}

export async function addBookAction(input: unknown) { return domainMutation(() => addBook(input)) }
export async function updateBookAction(id: string, input: unknown) { return domainMutation(() => updateBook(id, input)) }
export async function updateBookStatusAction(id: string, status: Book["status"], version: unknown) { return domainMutation(() => updateBookStatus(id, status, version)) }
export async function deleteBookAction(id: string, version: unknown) { return domainMutation(() => deleteBook(id, version)) }
export async function refreshBookCoverAction(id: string, version: unknown) {
  return domainMutation(() =>
    observeOperation("cover.recovery", "cover.refresh", () => refreshBookCover(id, version), telemetry))
}
export async function moveBookShelfAction(id: string, shelfId: string, version: unknown) { return domainMutation(() => moveBookShelf(id, shelfId, version)) }
export async function moveBooksShelfAction(ids: string[], shelfId: string) { return domainMutation(() => moveBooksShelf(ids, shelfId)) }

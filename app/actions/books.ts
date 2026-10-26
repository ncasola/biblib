"use server"

import { and, eq, inArray } from "drizzle-orm"
import { withRlsContext, type DatabaseTransaction } from "@/lib/db/client"
import { copies, editions, shelves } from "@/lib/db/schema"
import { ensureDefaultShelf, lockLibrary } from "@/lib/db/library"
import { copyVerification } from "@/lib/db/model"
import { createEdition, findBook, findBookByIsbn, updateEdition } from "@/lib/db/editions"
import { getRequiredUserId } from "@/lib/server-user"
import { parseBookInput, parseUuid, statusSchema } from "@/lib/book-validation"
import { personalDatabaseError } from "@/lib/personal-server"
import { DomainError, translateDatabaseError } from "@/lib/domain-errors"
import { normalizeIsbn } from "@/lib/isbn"
import { bibliographicCatalog } from "@/lib/bibliographic-catalog/server"
import { classifyCoverLookup } from "@/lib/jobs/contracts"
import type { Book } from "@/lib/types"
import { domainMutation } from "@/lib/server-action"
import { assertBookVersion, bookVersionConflict } from "@/lib/book-version"
import { telemetry } from "@/lib/observability/server"
import { observeOperation } from "@/lib/observability/operations"
import { readCatalogConfig } from "@/lib/bibliographic-catalog/config"
import { catalogueForCreate, catalogueForUpdate, catalogueWithField, PROVENANCE_FIELDS, provenanceFieldValue } from "@/lib/catalogue-provenance"
import { editionCatalogue } from "@/lib/db/model"

// Acciones de la ficha plana (U-DAT-06): una ficha es un ejemplar con su edición. Estado, estantería y
// comprobación física cambian el ejemplar con su versión; los datos bibliográficos, la edición (que puede
// compartir con otros ejemplares) con la suya. Los contratos explícitos de ejemplar y edición están en
// app/actions/editions.ts.

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

/** El ejemplar solo exige su propio token (o el token plano de la ficha que se abrió). */
function assertCopyVersion(current: Book, expected: unknown): void {
  if (typeof expected !== "string" || (expected !== current.copyVersion && expected !== current.version)) throw bookVersionConflict()
}

export async function getBookDetailAction(bookId: string): Promise<Book | null> {
  let id: string
  try { id = parseUuid(bookId) } catch { return null }
  const userId = await getRequiredUserId()
  return withRlsContext(userId, (tx) => findBook(tx, userId, id))
}

/** ¿Ya tengo esta edición? Tarea T7: igualdad indexada por (dueño, ISBN-13), sin leer los ISBN de la cuenta. */
export async function getBookByIsbnAction(value: string): Promise<Book | null> {
  const userId = await getRequiredUserId()
  if (typeof value !== "string" || value.length > 100) throw new DomainError("INVALID_INPUT", "El ISBN no es válido.")
  const isbn = normalizeIsbn(value)
  if (!isbn) throw new DomainError("INVALID_INPUT", "El ISBN no es válido.")
  return withRlsContext(userId, (tx) => findBookByIsbn(tx, userId, isbn))
}

/** Alta de una ficha: una edición nueva con su primer ejemplar. Con un ISBN que ya tienes, «ya existe». */
async function addBook(input: unknown): Promise<Book> {
  const userId = await getRequiredUserId()
  const book = parseBookInput(input)
  const catalogue = catalogueForCreate(book.catalogue, bibliographyReviewEnabled())
  try {
    return await withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      const shelfId = await getShelf(tx, userId, book.shelf_id)
      return createEdition(tx, userId, { book: { ...book, catalogue }, shelfId, idempotencyKey: book.idempotencyKey })
    })
  } catch (error) { personalDatabaseError(error) }
}

const bibliographicChanged = (current: Book, next: Pick<Book, "isbn" | "title" | "subtitle" | "authors" | "publishers" | "publish_date" | "number_of_pages" | "cover" | "catalogue">) =>
  (current.isbn ?? null) !== (next.isbn ?? null)
  || PROVENANCE_FIELDS.some((field) => provenanceFieldValue(current, field) !== provenanceFieldValue(next, field))
  || JSON.stringify(current.cover) !== JSON.stringify(next.cover)
  || JSON.stringify(editionCatalogue(current.catalogue)) !== JSON.stringify(editionCatalogue(next.catalogue))

/**
 * Edición desde la ficha plana. El ejemplar (estado, estantería, comprobación) se guarda con su versión; si
 * cambian datos bibliográficos se guarda la edición con la suya y, si la comparten varios ejemplares, solo
 * con la confirmación de cuántos cambian (`EDITION_SHARED` en otro caso).
 */
async function updateBook(bookId: string, input: unknown): Promise<Book> {
  const userId = await getRequiredUserId()
  const id = parseUuid(bookId)
  const book = parseBookInput(input)
  try {
    return await withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      const current = await findBook(tx, userId, id)
      if (!current) throw new DomainError("NOT_FOUND", "El libro ya no está disponible.")
      assertCopyVersion(current, book.copyVersion ?? book.version)
      const shelfId = await getShelf(tx, userId, book.shelf_id)
      // La procedencia sale de la ficha bloqueada y versionada: los campos cambiados pasan a «manual».
      const catalogue = catalogueForUpdate(current, book, bibliographyReviewEnabled())
      const next = { ...book, catalogue }
      const verification = copyVerification({ ...next, verification: current.verification })
      const changed = await tx.update(copies).set({ status: book.status, shelfId, editionVerification: verification, updatedAt: new Date() })
        .where(and(eq(copies.id, id), eq(copies.userId, userId), eq(copies.version, current.copyVersion!))).returning({ id: copies.id })
      if (!changed.length) throw bookVersionConflict()
      if (bibliographicChanged(current, next)) {
        // Sin token de edición, el plano de la ficha que se abrió también la identifica.
        const expectedVersion = book.editionVersion ?? (book.version === current.version ? current.edition!.version! : "")
        await updateEdition(tx, userId, { editionId: current.edition!.id, expectedVersion, patch: next, confirmCopies: book.confirmSharedCopies }, () => catalogue)
        // Un ISBN nuevo reinicia la comprobación de la edición; la de este ejemplar es la que acaba de indicar la persona.
        if ((current.isbn ?? null) !== (book.isbn ?? null)) {
          await tx.update(copies).set({ editionVerification: verification }).where(and(eq(copies.id, id), eq(copies.userId, userId)))
        }
      }
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
      assertCopyVersion(current, version)
      const updated = await tx.update(copies).set({ status: status.data, updatedAt: new Date() })
        .where(and(eq(copies.id, id), eq(copies.userId, userId), eq(copies.version, current.copyVersion!))).returning({ id: copies.id })
      if (!updated.length) throw bookVersionConflict()
      return (await findBook(tx, userId, id))!
    })
  } catch (error) { translateDatabaseError(error) }
}

/** Retira el ejemplar; si era el último de su edición, la edición se retira con él (poda de 0010). */
async function deleteBook(bookId: string, version: unknown): Promise<void> {
  const userId = await getRequiredUserId()
  const id = parseUuid(bookId)
  try {
    await withRlsContext(userId, async (tx) => {
      await lockLibrary(tx)
      const current = await findBook(tx, userId, id)
      if (!current) throw new DomainError("NOT_FOUND", "El libro ya no está disponible.")
      assertCopyVersion(current, version)
      const removed = await tx.delete(copies).where(and(eq(copies.id, id), eq(copies.userId, userId), eq(copies.version, current.copyVersion!))).returning({ id: copies.id })
      if (!removed.length) throw bookVersionConflict()
    })
  } catch (error) { translateDatabaseError(error) }
}

/** La portada es de la edición: recuperarla la cambia para todos sus ejemplares (la ficha muestra cuántos son). */
async function refreshBookCover(bookId: string, version: unknown): Promise<Book> {
  const current = await getBookDetailAction(bookId)
  if (!current) throw new DomainError("NOT_FOUND", "El libro ya no está disponible.")
  assertBookVersion(current, version)
  if (!current.isbn || !normalizeIsbn(current.isbn)) throw new DomainError("INVALID_INPUT", "Añade un ISBN válido para buscar la portada.")
  const userId = await getRequiredUserId()
  // Misma frontera que el alta y los trabajos: el orquestador. La consulta termina antes de abrir la transacción.
  const outcome = classifyCoverLookup(await bibliographicCatalog.getCover(current.isbn, { userId }))
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
    if (latest.isbn !== current.isbn) throw new DomainError("CONFLICT", "El ISBN ha cambiado mientras se buscaba la portada. Vuelve a intentarlo.")
    const catalogue = catalogueWithField(latest.catalogue, "cover", { provider: outcome.provider, ...(outcome.sourceUrl ? { sourceUrl: outcome.sourceUrl } : {}), retrievedAt: new Date().toISOString(), selection: "user-selected" }, bibliographyReviewEnabled())
    const changed = await tx.update(editions).set({ coverSmall: outcome.cover.small, coverMedium: outcome.cover.medium,
      coverLarge: outcome.cover.large, catalogue: editionCatalogue(catalogue), updatedAt: new Date() })
      .where(and(eq(editions.id, latest.edition!.id), eq(editions.userId, userId), eq(editions.version, latest.edition!.version!))).returning({ id: editions.id })
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
    assertCopyVersion(current, version)
    const target = await getShelf(tx, userId, shelfId)
    const changed = await tx.update(copies).set({ shelfId: target, updatedAt: new Date() })
      .where(and(eq(copies.id, id), eq(copies.userId, userId), eq(copies.version, current.copyVersion!))).returning({ id: copies.id })
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
    const changed = await tx.update(copies).set({ shelfId: target, updatedAt: new Date() })
      .where(and(inArray(copies.id, ids), eq(copies.userId, userId))).returning({ id: copies.id })
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

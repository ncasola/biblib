"use server"

import { z } from "zod"
import { withRlsContext } from "@/lib/db/client"
import { lockLibrary } from "@/lib/db/library"
import { createCopy, createEdition, editionCopies, findBook, mergeEditions, updateEdition, type MergeEditionsResult, type UpdateEditionResult } from "@/lib/db/editions"
import { editionCatalogue } from "@/lib/db/model"
import { getRequiredUserId } from "@/lib/server-user"
import { idempotencyKeySchema, parseBookInput, parseUuid, statusSchema, uuidSchema } from "@/lib/book-validation"
import { DomainError, translateDatabaseError } from "@/lib/domain-errors"
import { domainMutation } from "@/lib/server-action"
import { readCatalogConfig } from "@/lib/bibliographic-catalog/config"
import { catalogueForCreate, catalogueForUpdate } from "@/lib/catalogue-provenance"
import type { Book, CatalogueMetadata } from "@/lib/types"

// Contratos del modelo obra/edición/ejemplar (U-DAT-06), todos `ActionResult`:
// - createCopyAction({ editionId, placement, status, idempotencyKey }): un ejemplar más de una edición propia.
// - createEditionAction({ isbn13: null | string, ..., placement, idempotencyKey }): edición nueva con su ejemplar.
// - updateEditionAction({ editionId, expectedVersion, ..., confirmCopies }): informa de cuántos ejemplares cambia.
// - mergeEditionsAction({ sourceIds, targetId, expectedVersions, expectedRevision, idempotencyKey }).
// El dueño sale de la sesión; una edición o estantería de otra cuenta responde «no disponible».

function reviewEnabled(): boolean {
  try { return readCatalogConfig().reviewEnabled } catch { return false }
}

const createCopySchema = z.object({
  editionId: uuidSchema,
  placement: z.object({ shelfId: uuidSchema }).strict(),
  status: statusSchema.default("unread"),
  idempotencyKey: idempotencyKeySchema,
}).strict()

const mergeSchema = z.object({
  sourceIds: z.array(uuidSchema).min(1).max(20),
  targetId: uuidSchema,
  expectedVersions: z.record(uuidSchema, uuidSchema),
  expectedRevision: uuidSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict()

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new DomainError("INVALID_INPUT", message)
  return result.data
}

/** Ejemplares de la edición de un ejemplar propio (para «ya existe» y la ficha), en orden de alta. */
export async function getEditionCopiesAction(copyId: string): Promise<Book[]> {
  let id: string
  try { id = parseUuid(copyId) } catch { return [] }
  const userId = await getRequiredUserId()
  return withRlsContext(userId, async (tx) => {
    const book = await findBook(tx, userId, id)
    return book?.edition ? editionCopies(tx, userId, book.edition.id) : []
  })
}

export async function createCopyAction(input: unknown) {
  return domainMutation(async () => {
    const userId = await getRequiredUserId()
    const request = parse(createCopySchema, input, "Elige la edición, la estantería y el estado del nuevo ejemplar.")
    try { return await withRlsContext(userId, (tx) => createCopy(tx, userId, request)) }
    catch (error) { translateDatabaseError(error) }
  })
}

/** `isbn13` es obligatorio en la entrada (null para un libro sin ISBN): nunca se rellena con un identificador inventado. */
export async function createEditionAction(input: unknown) {
  return domainMutation(async () => {
    const userId = await getRequiredUserId()
    const envelope = parse(z.object({ isbn13: z.string().max(100).nullable(), placement: z.object({ shelfId: uuidSchema }).strict(), idempotencyKey: idempotencyKeySchema }).passthrough(), input,
      "Indica el ISBN-13 (o null), la estantería y la clave de la operación.")
    const book = parseBookInput({ ...(input as Record<string, unknown>), isbn: envelope.isbn13 ?? "", shelf_id: envelope.placement.shelfId, idempotencyKey: envelope.idempotencyKey })
    if (envelope.isbn13 && book.isbn !== envelope.isbn13) throw new DomainError("INVALID_INPUT", "El ISBN-13 debe enviarse en su forma canónica.")
    const catalogue = catalogueForCreate(book.catalogue, reviewEnabled())
    try {
      return await withRlsContext(userId, async (tx) => {
        await lockLibrary(tx)
        return createEdition(tx, userId, { book: { ...book, catalogue }, shelfId: envelope.placement.shelfId, idempotencyKey: envelope.idempotencyKey })
      })
    } catch (error) { translateDatabaseError(error) }
  })
}

export async function updateEditionAction(input: unknown) {
  return domainMutation(async (): Promise<UpdateEditionResult> => {
    const userId = await getRequiredUserId()
    const envelope = parse(z.object({ editionId: uuidSchema, expectedVersion: uuidSchema, confirmCopies: z.number().int().min(2).optional(), idempotencyKey: idempotencyKeySchema.optional() }).passthrough(), input,
      "Indica la edición y la versión que revisaste.")
    const book = parseBookInput({ ...(input as Record<string, unknown>), status: "unread" })
    try {
      return await withRlsContext(userId, (tx) => updateEdition(tx, userId, {
        editionId: envelope.editionId, expectedVersion: envelope.expectedVersion, patch: book, confirmCopies: envelope.confirmCopies, idempotencyKey: envelope.idempotencyKey,
      }, (current) => {
        // La procedencia sale de la edición guardada: los campos cambiados pasan a «manual»; la comprobación física no es suya.
        const stored = { ...current.catalogue, isbnVerified: false } as CatalogueMetadata
        const previous = { isbn: current.isbn13, title: current.title, subtitle: current.subtitle ?? undefined, authors: current.authors, publishers: current.publishers,
          publish_date: current.publishDate, number_of_pages: current.numberOfPages, cover: { small: current.coverSmall, medium: current.coverMedium, large: current.coverLarge }, catalogue: stored }
        return { ...editionCatalogue(catalogueForUpdate(previous, { ...book, catalogue: { ...book.catalogue, isbnVerified: false } }, reviewEnabled())), isbnVerified: false } as CatalogueMetadata
      }))
    } catch (error) { translateDatabaseError(error) }
  })
}

export async function mergeEditionsAction(input: unknown) {
  return domainMutation(async (): Promise<MergeEditionsResult> => {
    const userId = await getRequiredUserId()
    const request = parse(mergeSchema, input, "Indica las ediciones que se fusionan, la de destino, sus versiones y la revisión de tu biblioteca.")
    try { return await withRlsContext(userId, (tx) => mergeEditions(tx, userId, request)) }
    catch (error) { translateDatabaseError(error) }
  })
}

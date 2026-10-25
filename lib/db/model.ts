import { sql } from "drizzle-orm"
import type { DatabaseTransaction } from "./client"
import { copies, editions, works } from "./schema"
import type { ImportPlan } from "../import-plan"
import type { Book, CatalogueMetadata, CopyVerification, EditionCatalogue } from "../types"

// Escrituras del modelo obra/edición/ejemplar (U-DAT-06) a partir del DTO plano. Las usan las acciones,
// el publicador de importaciones y la restauración de versiones anteriores dentro de una transacción ya
// situada en el contexto RLS del dueño y bajo el bloqueo de colección.

/** Procedencia de la edición: la del DTO sin la comprobación física, que es del ejemplar. */
export function editionCatalogue(catalogue: CatalogueMetadata | undefined): EditionCatalogue {
  if (!catalogue) return { source: "import" }
  const sourceUrl = catalogue.sourceUrl ? { sourceUrl: catalogue.sourceUrl } : {}
  if (catalogue.schemaVersion !== 2) return { source: catalogue.source, ...sourceUrl }
  // El checksum se deriva al leer; no se guarda.
  return { schemaVersion: 2, source: catalogue.source, ...sourceUrl, ...(catalogue.fields && Object.keys(catalogue.fields).length ? { fields: catalogue.fields } : {}) }
}

/** Comprobación física de un ejemplar: el indicador del DTO más su fecha y evidencias. */
export function copyVerification(book: Pick<Book, "catalogue" | "verification" | "isbn">): CopyVerification {
  return {
    isbnVerified: Boolean(book.isbn) && (book.catalogue?.isbnVerified ?? false),
    ...(book.verification?.checkedAt ? { checkedAt: book.verification.checkedAt } : {}),
    ...(book.verification?.evidenceRefs?.length ? { evidenceRefs: [...book.verification.evidenceRefs] } : {}),
  }
}

/** Valores de una edición nueva o reescrita con los datos bibliográficos del DTO. */
export function editionValues(book: Pick<Book, "isbn" | "title" | "subtitle" | "authors" | "publishers" | "publish_date" | "number_of_pages" | "cover" | "catalogue" | "edition">) {
  return {
    isbn13: book.isbn ?? null, title: book.title, subtitle: book.subtitle ?? null, authors: book.authors, publishers: book.publishers ?? [],
    publishDate: book.publish_date, numberOfPages: book.number_of_pages, language: book.edition?.language ?? null,
    identifiers: book.edition?.identifiers ?? {}, catalogue: editionCatalogue(book.catalogue),
    coverSmall: book.cover.small, coverMedium: book.cover.medium, coverLarge: book.cover.large,
  }
}

/**
 * Condición «es la edición del ejemplar `copyId` con el token plano `version`»: protege una escritura de la
 * edición desde la ficha plana (portada, recuperación) frente a cambios del ejemplar o de la edición.
 */
export function editionOfCopy(owner: string, copyId: string, version: string) {
  return sql`${editions.userId} = ${owner}::uuid and ${editions.id} = (select b.edition_id from biblib.books as b where b.id = ${copyId}::uuid and b.user_id = ${owner}::uuid and b.version = ${version}::uuid)`
}

const BATCH = 100

/**
 * Crea las obras, ediciones y ejemplares de un plan con los datos de sus filas (`rows` por ID de origen).
 * `extra` añade campos por ejemplar o edición (fecha de alta, portada privada) que solo conocen las
 * restauraciones. El orden respeta las FK con dueño: obras, ediciones y ejemplares.
 */
export async function insertPlannedCopies(tx: DatabaseTransaction, userId: string, plan: Pick<ImportPlan, "books" | "editions" | "works">, rows: ReadonlyMap<string, Book>,
  extra: { createdAt?: (sourceId: string) => Date | undefined; coverAssetId?: (sourceId: string) => string | null } = {}): Promise<void> {
  const row = (sourceId: string) => {
    const book = rows.get(sourceId)
    if (!book) throw new Error("La fila del plan no existe.")
    return book
  }
  const workValues = plan.works.create.map((entry) => ({ id: entry.id, userId, title: row(entry.sourceId).edition?.workTitle ?? row(entry.sourceId).title }))
  for (let offset = 0; offset < workValues.length; offset += BATCH) await tx.insert(works).values(workValues.slice(offset, offset + BATCH))
  const editionRows = plan.editions.create.map((entry) => {
    const created = extra.createdAt?.(entry.sourceId)
    return { id: entry.id, userId, workId: entry.workId, ...editionValues(row(entry.sourceId)), coverAssetId: extra.coverAssetId?.(entry.sourceId) ?? null, ...(created ? { createdAt: created } : {}) }
  })
  for (let offset = 0; offset < editionRows.length; offset += BATCH) await tx.insert(editions).values(editionRows.slice(offset, offset + BATCH))
  const copyRows = plan.books.insert.map((entry) => {
    const book = row(entry.sourceId)
    const created = extra.createdAt?.(entry.sourceId)
    return { id: entry.id, userId, editionId: entry.editionId, status: book.status, shelfId: entry.shelfId, editionVerification: copyVerification(book),
      legacyIdentifier: book.isbn ? null : book.legacyIdentifier ?? null, ...(created ? { createdAt: created } : {}) }
  })
  for (let offset = 0; offset < copyRows.length; offset += BATCH) await tx.insert(copies).values(copyRows.slice(offset, offset + BATCH))
}

/** Retira todos los ejemplares del dueño; la poda de 0010 retira sus ediciones y obras. */
export async function deleteAllCopies(tx: DatabaseTransaction, userId: string): Promise<void> {
  await tx.execute(sql`delete from biblib.copies where user_id = ${userId}::uuid`)
}

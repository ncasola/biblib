import "server-only"
import { and, eq, sql } from "drizzle-orm"
import { shelves, books } from "./schema"
import type { DatabaseTransaction } from "./client"
import type { Book } from "../types"

/**
 * Bloqueo de colección (U-DAT-01): fila del propietario en `biblib.library_state`, tomada con
 * `biblib.lock_library()` antes de escribir. El propietario sale de `auth.uid()` (claims de la
 * sesión en `withRlsContext`), nunca de un argumento. Devuelve la revisión vigente; los triggers de
 * obras, ediciones, ejemplares y estanterías la rotan al confirmar cualquier escritura de la transacción.
 */
export async function lockLibrary(tx: DatabaseTransaction): Promise<string> {
  const rows = await tx.execute<{ revision: string }>(sql`select biblib.lock_library() as revision`)
  const revision = rows[0]?.revision
  if (!revision) throw new Error("No se pudo bloquear la colección.")
  return revision
}

export async function ensureDefaultShelf(tx: DatabaseTransaction, userId: string): Promise<string> {
  const findDefault = () => tx.select({ id: shelves.id }).from(shelves)
    .where(and(eq(shelves.userId, userId), eq(shelves.isDefault, true))).limit(1)
  const existing = await findDefault()
  if (existing[0]) return existing[0].id
  // Crearla es una escritura de colección: primero el bloqueo, para mantener el mismo orden que las mutaciones.
  await lockLibrary(tx)
  const locked = await findDefault()
  if (locked[0]) return locked[0].id
  // También resuelve un nombre legacy ya ocupado por una estantería personalizada.
  for (let suffix = 0; suffix < 20; suffix++) {
    const title = suffix === 0 ? "Predeterminada" : `Predeterminada (${suffix + 1})`
    const created = await tx.insert(shelves).values({ userId, title, isDefault: true })
      .onConflictDoNothing().returning({ id: shelves.id })
    if (created[0]) return created[0].id
    const concurrent = await findDefault()
    if (concurrent[0]) return concurrent[0].id
  }
  throw new Error("No se pudo crear la estantería predeterminada.")
}

export type BookRow = typeof books.$inferSelect

/** Fila de la vista plana `books` (ejemplar + edición, U-DAT-06) en el DTO de la interfaz. */
export function mapRowToBook(row: { book: BookRow; shelfTitle: string }): Book {
  const book = row.book
  const { checkedAt, evidenceRefs } = book.editionVerification
  const evidence = { ...(checkedAt ? { checkedAt } : {}), ...(evidenceRefs?.length ? { evidenceRefs } : {}) }
  return {
    version: book.version, copyVersion: book.copyVersion,
    id: book.id, isbn: book.isbn13,
    ...(book.legacyIdentifier ? { legacyIdentifier: book.legacyIdentifier } : {}),
    title: book.title, subtitle: book.subtitle ?? undefined,
    authors: book.authors, number_of_pages: book.numberOfPages, publish_date: book.publishDate,
    publishers: book.publishers,
    cover: { small: book.coverSmall, medium: book.coverMedium, large: book.coverLarge },
    status: book.status, shelf_id: book.shelfId, shelf_name: row.shelfTitle,
    catalogue: book.catalogue,
    ...(book.coverAssetId ? { coverAssetId: book.coverAssetId } : {}),
    edition: {
      id: book.editionId, version: book.editionVersion, copies: book.editionCopies,
      ...(book.workId ? { workId: book.workId, ...(book.workTitle ? { workTitle: book.workTitle } : {}) } : {}),
      ...(book.language ? { language: book.language } : {}),
      ...(Object.keys(book.identifiers).length ? { identifiers: book.identifiers } : {}),
    },
    ...(Object.keys(evidence).length ? { verification: evidence } : {}),
  }
}

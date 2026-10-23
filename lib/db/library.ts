import "server-only"
import { and, eq, sql } from "drizzle-orm"
import { shelves, books } from "./schema"
import type { DatabaseTransaction } from "./client"
import type { Book } from "../types"

/**
 * Bloqueo de colección (U-DAT-01): fila del propietario en `biblib.library_state`, tomada con
 * `biblib.lock_library()` antes de escribir. El propietario sale de `auth.uid()` (claims de la
 * sesión en `withRlsContext`), nunca de un argumento. Devuelve la revisión vigente; los triggers de
 * `books`/`shelves` la rotan al confirmar cualquier escritura de la transacción.
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

export function mapRowToBook(row: { book: typeof books.$inferSelect; shelfTitle: string }): Book {
  return {
    version: row.book.version,
    id: row.book.id, isbn: row.book.isbn, title: row.book.title, subtitle: row.book.subtitle ?? undefined,
    authors: row.book.authors, number_of_pages: row.book.numberOfPages, publish_date: row.book.publishDate,
    publishers: row.book.publishers,
    cover: { small: row.book.coverSmall, medium: row.book.coverMedium, large: row.book.coverLarge },
    status: row.book.status, shelf_id: row.book.shelfId, shelf_name: row.shelfTitle,
    catalogue: row.book.catalogue,
  }
}

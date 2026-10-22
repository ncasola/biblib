import "server-only"
import { and, eq, sql } from "drizzle-orm"
import { shelves, books } from "./schema"
import type { DatabaseTransaction } from "./client"
import type { Book } from "../types"

/** Serializa escrituras de una colección; el usuario siempre procede de la sesión. */
export async function lockLibrary(tx: DatabaseTransaction, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`)
}

export async function ensureDefaultShelf(tx: DatabaseTransaction, userId: string): Promise<string> {
  const existing = await tx.select({ id: shelves.id }).from(shelves)
    .where(and(eq(shelves.userId, userId), eq(shelves.isDefault, true))).limit(1)
  if (existing[0]) return existing[0].id
  // También resuelve un nombre legacy ya ocupado por una estantería personalizada.
  for (let suffix = 0; suffix < 20; suffix++) {
    const title = suffix === 0 ? "Predeterminada" : `Predeterminada (${suffix + 1})`
    const created = await tx.insert(shelves).values({ userId, title, isDefault: true })
      .onConflictDoNothing().returning({ id: shelves.id })
    if (created[0]) return created[0].id
    const concurrent = await tx.select({ id: shelves.id }).from(shelves)
      .where(and(eq(shelves.userId, userId), eq(shelves.isDefault, true))).limit(1)
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

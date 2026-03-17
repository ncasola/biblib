"use server"

import { and, eq } from "drizzle-orm"
import { withRlsContext } from "@/lib/db/client"
import { books, shelves } from "@/lib/db/schema"
import { createClient } from "@/lib/supabase/server"
import type { Book, LibraryData } from "@/lib/types"

async function getRequiredUserId(): Promise<string> {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error || !user) {
    throw new Error("No autorizado")
  }

  return user.id
}

export async function ensureDefaultShelf(userId: string): Promise<string> {
  return withRlsContext(userId, async (tx) => {
    const existing = await tx
      .select({ id: shelves.id })
      .from(shelves)
      .where(and(eq(shelves.userId, userId), eq(shelves.isDefault, true)))
      .limit(1)

    if (existing.length > 0) {
      return existing[0].id
    }

    const created = await tx
      .insert(shelves)
      .values({
        userId,
        title: "Predeterminada",
        isDefault: true,
      })
      .returning({ id: shelves.id })

    return created[0].id
  })
}

function mapRowToBook(row: {
  book: typeof books.$inferSelect
  shelfTitle: string
}): Book {
  return {
    id: row.book.id,
    isbn: row.book.isbn,
    title: row.book.title,
    subtitle: row.book.subtitle ?? undefined,
    authors: row.book.authors,
    number_of_pages: row.book.numberOfPages,
    publish_date: row.book.publishDate,
    publishers: row.book.publishers,
    cover: {
      small: row.book.coverSmall,
      medium: row.book.coverMedium,
      large: row.book.coverLarge,
    },
    status: row.book.status,
    shelf_id: row.book.shelfId,
    shelf_name: row.shelfTitle,
  }
}

export async function getLibraryDataAction(): Promise<LibraryData> {
  const userId = await getRequiredUserId()
  await ensureDefaultShelf(userId)

  return withRlsContext(userId, async (tx) => {
    const userShelves = await tx
      .select({
        id: shelves.id,
        title: shelves.title,
        isDefault: shelves.isDefault,
      })
      .from(shelves)
      .where(eq(shelves.userId, userId))

    const bookRows = await tx
      .select({
        book: books,
        shelfTitle: shelves.title,
      })
      .from(books)
      .innerJoin(shelves, eq(books.shelfId, shelves.id))
      .where(eq(books.userId, userId))

    return {
      shelves: userShelves.map((shelf) => ({
        id: shelf.id,
        title: shelf.title,
        isDefault: shelf.isDefault,
        book_count: bookRows.filter((row) => row.book.shelfId === shelf.id).length,
      })),
      books: bookRows.map(mapRowToBook),
    }
  })
}

export async function importLibraryDataAction(data: LibraryData): Promise<void> {
  const userId = await getRequiredUserId()

  await withRlsContext(userId, async (tx) => {
    await tx.delete(books).where(eq(books.userId, userId))
    await tx.delete(shelves).where(eq(shelves.userId, userId))
  })

  const defaultShelfId = await ensureDefaultShelf(userId)

  await withRlsContext(userId, async (tx) => {
    const shelfIdMap = new Map<string, string>()
    shelfIdMap.set("shelf-1", defaultShelfId)

    const importedShelves = data.shelves.filter((shelf) => !shelf.isDefault)
    for (const shelf of importedShelves) {
      const created = await tx
        .insert(shelves)
        .values({
          userId,
          title: shelf.title,
          isDefault: false,
        })
        .returning({ id: shelves.id })

      shelfIdMap.set(shelf.id, created[0].id)
    }

    for (const book of data.books) {
      const mappedShelfId = shelfIdMap.get(book.shelf_id) ?? defaultShelfId
      await tx.insert(books).values({
        userId,
        isbn: book.isbn,
        title: book.title,
        subtitle: book.subtitle ?? null,
        authors: book.authors,
        publishers: book.publishers ?? [],
        numberOfPages: book.number_of_pages,
        publishDate: book.publish_date,
        coverSmall: book.cover.small,
        coverMedium: book.cover.medium,
        coverLarge: book.cover.large,
        status: book.status,
        shelfId: mappedShelfId,
      })
    }
  })
}

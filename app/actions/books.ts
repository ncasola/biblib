"use server"

import { and, eq } from "drizzle-orm"
import { withRlsContext } from "@/lib/db/client"
import { books, shelves } from "@/lib/db/schema"
import { createClient } from "@/lib/supabase/server"
import { ensureDefaultShelf } from "@/app/actions/library"
import type { Book } from "@/lib/types"

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

export async function addBookAction(book: Book): Promise<void> {
  const userId = await getRequiredUserId()
  const defaultShelfId = await ensureDefaultShelf(userId)

  await withRlsContext(userId, async (tx) => {
    const existing = await tx
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.userId, userId), eq(books.isbn, book.isbn)))
      .limit(1)

    if (existing.length > 0) {
      throw new Error("El libro ya está en la biblioteca")
    }

    const requestedShelfId = book.shelf_id?.trim() ?? ""
    let shelfId = defaultShelfId

    // Compatibilidad con datos legacy (ej. "shelf-1"): solo consultamos si el ID es UUID válido.
    if (UUID_REGEX.test(requestedShelfId)) {
      const targetShelf = await tx
        .select({ id: shelves.id })
        .from(shelves)
        .where(and(eq(shelves.id, requestedShelfId), eq(shelves.userId, userId)))
        .limit(1)

      shelfId = targetShelf[0]?.id ?? defaultShelfId
    }

    await tx.insert(books).values({
      userId,
      isbn: book.isbn,
      title: book.title,
      subtitle: book.subtitle ?? null,
      authors: book.authors,
      publishers: book.publishers ?? [],
      numberOfPages: book.number_of_pages,
      publishDate: book.publish_date,
      coverSmall: book.cover.small || "/default-book-cover.webp",
      coverMedium: book.cover.medium || "/default-book-cover.webp",
      coverLarge: book.cover.large || "/default-book-cover.webp",
      status: book.status,
      shelfId,
    })
  })
}

export async function updateBookStatusAction(bookId: string, status: Book["status"]): Promise<void> {
  const userId = await getRequiredUserId()
  await withRlsContext(userId, async (tx) => {
    await tx
      .update(books)
      .set({
        status,
        updatedAt: new Date(),
      })
      .where(and(eq(books.id, bookId), eq(books.userId, userId)))
  })
}

export async function deleteBookAction(bookId: string): Promise<void> {
  const userId = await getRequiredUserId()
  await withRlsContext(userId, async (tx) => {
    await tx.delete(books).where(and(eq(books.id, bookId), eq(books.userId, userId)))
  })
}

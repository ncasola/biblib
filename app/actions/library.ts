"use server"

import { and, eq, sql, asc, desc, count } from "drizzle-orm"
import { z } from "zod"
import { withRlsContext } from "@/lib/db/client"
import { books, shelves } from "@/lib/db/schema"
import { ensureDefaultShelf, lockLibrary, mapRowToBook } from "@/lib/db/library"
import { getRequiredUserId } from "@/lib/server-user"
import { DomainError, translateDatabaseError } from "@/lib/domain-errors"
import { normalizedBookIdentifier, normalizeIsbn } from "@/lib/isbn"
import { DEFAULT_BOOK_COVER } from "@/lib/book-covers"
import { enrichImportedBookCovers, parseLibraryImport, type LibraryImportOptions, type LibraryImportResult } from "@/lib/library-import"
import type { LibraryData } from "@/lib/types"
import { mutationResult } from "@/lib/action-result"

export async function getLibraryDataAction(): Promise<LibraryData> {
  const userId = await getRequiredUserId()
  return withRlsContext(userId, async (tx) => {
    await ensureDefaultShelf(tx, userId)
    const userShelves = await tx.select().from(shelves).where(eq(shelves.userId, userId)).orderBy(asc(shelves.createdAt), asc(shelves.id))
    const bookRows = await tx.select({ book: books, shelfTitle: shelves.title }).from(books)
      .innerJoin(shelves, and(eq(books.shelfId, shelves.id), eq(shelves.userId, userId)))
      .where(eq(books.userId, userId)).orderBy(asc(books.title), asc(books.id))
    const counts = new Map<string, number>()
    for (const { book } of bookRows) counts.set(book.shelfId, (counts.get(book.shelfId) ?? 0) + 1)
    return {
      shelves: userShelves.map((shelf) => ({ id: shelf.id, title: shelf.title, isDefault: shelf.isDefault, book_count: counts.get(shelf.id) ?? 0 })),
      books: bookRows.map(mapRowToBook),
    }
  })
}

export async function getLibrarySummaryAction() {
  const userId = await getRequiredUserId()
  return withRlsContext(userId, async (tx) => {
    await ensureDefaultShelf(tx, userId)
    const [totals] = await tx.select({
      totalBooks: count(),
      read: sql<number>`count(*) filter (where ${books.status} = 'read')::int`,
      reading: sql<number>`count(*) filter (where ${books.status} = 'reading')::int`,
      toRead: sql<number>`count(*) filter (where ${books.status} = 'to-read')::int`,
      unread: sql<number>`count(*) filter (where ${books.status} = 'unread')::int`,
    }).from(books).where(eq(books.userId, userId))
    const [shelfTotals] = await tx.select({ totalShelves: count() }).from(shelves).where(eq(shelves.userId, userId))
    const recent = await tx.select({ book: books, shelfTitle: shelves.title }).from(books)
      .innerJoin(shelves, and(eq(books.shelfId, shelves.id), eq(shelves.userId, userId)))
      .where(eq(books.userId, userId)).orderBy(desc(books.createdAt), desc(books.id)).limit(5)
    const reading = await tx.select({ book: books, shelfTitle: shelves.title }).from(books)
      .innerJoin(shelves, and(eq(books.shelfId, shelves.id), eq(shelves.userId, userId)))
      .where(and(eq(books.userId, userId), eq(books.status, "reading"))).orderBy(desc(books.updatedAt), asc(books.id)).limit(5)
    return { ...totals, totalShelves: shelfTotals.totalShelves, recent: recent.map(mapRowToBook), currentlyReading: reading.map(mapRowToBook) }
  })
}

const listSchema = z.object({
  q: z.string().max(500).default(""), status: z.enum(["all", "read", "reading", "unread", "to-read"]).default("all"),
  shelf: z.union([z.literal("all"), z.uuid()]).default("all"),
  sort: z.enum(["title", "-title", "author", "-author", "pages", "-pages", "date", "-date", "status", "-status"]).default("title"),
  page: z.number().int().min(1).max(100_000).default(1), pageSize: z.number().int().min(1).max(100).default(10),
})

export async function listBooksAction(input: unknown = {}) {
  const userId = await getRequiredUserId()
  const parsed = listSchema.safeParse(input)
  if (!parsed.success) throw new DomainError("INVALID_INPUT", "Los filtros de búsqueda no son válidos.")
  const filter = parsed.data
  const searchValue = normalizeIsbn(filter.q) ?? (/^[0-9Xx\s-]+$/.test(filter.q) ? filter.q.replace(/[\s-]/g, "") : filter.q)
  const query = searchValue.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()
  const escaped = `%${query.replace(/[\\%_]/g, "\\$&")}%`
  const conditions = and(eq(books.userId, userId), filter.status !== "all" ? eq(books.status, filter.status) : undefined,
    filter.shelf !== "all" ? eq(books.shelfId, filter.shelf) : undefined,
    query ? sql`translate(lower(${books.title} || ' ' || coalesce(${books.subtitle}, '') || ' ' || ${books.authors}::text || ' ' || ${books.isbn}), 'áéíóúüñ', 'aeiouun') like ${escaped}` : undefined)
  return withRlsContext(userId, async (tx) => {
    const [{ total }] = await tx.select({ total: count() }).from(books).where(conditions)
    const page = Math.min(filter.page, Math.max(1, Math.ceil(total / filter.pageSize)))
    const key = filter.sort.replace(/^-/, "")
    const orderColumn = key === "author" ? sql`${books.authors}->0->>'name'` : key === "pages" ? books.numberOfPages
      : key === "date" ? sql`coalesce(substring(${books.publishDate} from '[0-9]{4}'), '0000')` : key === "status" ? books.status : books.title
    const rows = await tx.select({ book: books, shelfTitle: shelves.title }).from(books)
      .innerJoin(shelves, and(eq(books.shelfId, shelves.id), eq(shelves.userId, userId))).where(conditions)
      .orderBy(filter.sort.startsWith("-") ? desc(orderColumn) : asc(orderColumn), asc(books.id))
      .limit(filter.pageSize).offset((page - 1) * filter.pageSize)
    return { books: rows.map(mapRowToBook), total, page, pageSize: filter.pageSize }
  })
}

async function importLibraryData(input: unknown, options: LibraryImportOptions): Promise<LibraryImportResult> {
  const userId = await getRequiredUserId()
  if (!options || (options.mode !== "merge" && options.mode !== "replace")) throw new DomainError("INVALID_INPUT", "Selecciona cómo importar la biblioteca.")
  let importedData: LibraryData
  try { importedData = parseLibraryImport(input) }
  catch (error) { throw new DomainError("INVALID_INPUT", error instanceof Error ? error.message : "El archivo no es válido.") }
  const existingIdentifiers = options.mode === "merge" ? await withRlsContext(userId, async (tx) =>
    new Set((await tx.select({ isbn: books.isbn }).from(books).where(eq(books.userId, userId))).map((book) => normalizedBookIdentifier(book.isbn)))) : new Set<string>()
  const probableNewBooks = importedData.books.filter((book) => !existingIdentifiers.has(normalizedBookIdentifier(book.isbn)))
  const enriched = new Map((await enrichImportedBookCovers(probableNewBooks)).map((book) => [book.isbn, book]))
  const importedBooks = importedData.books.map((book) => enriched.get(book.isbn) ?? book)
  try {
    return await withRlsContext(userId, async (tx) => {
      await lockLibrary(tx, userId)
      const defaultId = await ensureDefaultShelf(tx, userId)
      const previousShelves = await tx.select().from(shelves).where(eq(shelves.userId, userId))
      const previousBooks = await tx.select({ id: books.id, isbn: books.isbn }).from(books).where(eq(books.userId, userId))
      const previousByIdentifier = new Map(previousBooks.map((book) => [normalizedBookIdentifier(book.isbn), book]))
      const titles = new Map(previousShelves.map((shelf) => [shelf.title.toLocaleLowerCase("es"), shelf.id]))
      const previousShelvesById = new Map(previousShelves.map((shelf) => [shelf.id, shelf]))
      if (options.mode === "replace") {
        await tx.delete(books).where(eq(books.userId, userId))
        await tx.delete(shelves).where(and(eq(shelves.userId, userId), eq(shelves.isDefault, false)))
        titles.clear()
        const defaultShelf = previousShelves.find((shelf) => shelf.id === defaultId)!
        titles.set(defaultShelf.title.toLocaleLowerCase("es"), defaultId)
      }
      const shelfIdMap = new Map<string, string>()
      for (const shelf of importedData.shelves) {
        if (shelf.isDefault) { shelfIdMap.set(shelf.id, defaultId); continue }
        const titleKey = shelf.title.toLocaleLowerCase("es")
        const existingId = titles.get(titleKey)
        if (existingId) { shelfIdMap.set(shelf.id, existingId); continue }
        const previous = previousShelvesById.get(shelf.id)
        const id = options.mode === "replace" && previous && !previous.isDefault ? previous.id : crypto.randomUUID()
        await tx.insert(shelves).values({ id, userId, title: shelf.title, isDefault: false })
        shelfIdMap.set(shelf.id, id)
        titles.set(titleKey, id)
      }
      const candidates = importedBooks.filter((book) => options.mode === "replace" || !previousByIdentifier.has(normalizedBookIdentifier(book.isbn)))
      const values = candidates.map((book) => {
        const previous = previousByIdentifier.get(normalizedBookIdentifier(book.isbn))
        const id = options.mode === "replace" && previous ? previous.id : crypto.randomUUID()
        const shelfId = shelfIdMap.get(book.shelf_id)
        if (!shelfId) throw new DomainError("INVALID_INPUT", "Hay libros con una estantería inexistente.")
        return { id, userId, isbn: normalizedBookIdentifier(book.isbn), title: book.title, subtitle: book.subtitle ?? null,
          authors: book.authors, publishers: book.publishers ?? [], numberOfPages: book.number_of_pages, publishDate: book.publish_date,
          coverSmall: book.cover.small, coverMedium: book.cover.medium, coverLarge: book.cover.large, status: book.status, shelfId,
          catalogue: book.catalogue ?? { source: "import" as const, isbnVerified: false } }
      })
      for (let offset = 0; offset < values.length; offset += 100) await tx.insert(books).values(values.slice(offset, offset + 100))
      const originalByIdentifier = new Map(importedData.books.map((book) => [normalizedBookIdentifier(book.isbn), book]))
      const coversFound = candidates.filter((book) => originalByIdentifier.get(book.isbn)?.cover.large === DEFAULT_BOOK_COVER && book.cover.large !== DEFAULT_BOOK_COVER).length
      return { imported: candidates.length, skipped: importedBooks.length - candidates.length, coversFound,
        coversPending: candidates.filter((book) => book.cover.large === DEFAULT_BOOK_COVER).length, shelves: titles.size }
    })
  } catch (error) { translateDatabaseError(error) }
}

export async function importLibraryDataAction(input: unknown, options: LibraryImportOptions = { mode: "merge" }) {
  return mutationResult(() => importLibraryData(input, options))
}

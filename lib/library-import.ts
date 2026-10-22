import { z } from "zod"
import { DEFAULT_BOOK_COVER, normalizeBookCover } from "./book-covers"
import { normalizeIsbn, normalizedBookIdentifier } from "./isbn"
import { openLibraryHeaders } from "./open-library"
import type { Book, LibraryData } from "./types"

export const MAX_IMPORT_BYTES = 8 * 1024 * 1024
export const MAX_IMPORT_BOOKS = 2_000
export const MAX_IMPORT_SHELVES = 200

export interface LibraryImportOptions {
  mode: "merge" | "replace"
}

export interface LibraryImportResult {
  imported: number
  skipped: number
  coversFound: number
  coversPending: number
  shelves: number
}

export interface LibraryExport extends LibraryData {
  formatVersion: 1
  exportedAt: string
}

const librarySchema = z.object({
  formatVersion: z.literal(1).optional(),
  exportedAt: z.iso.datetime().optional(),
  books: z.array(z.object({
    id: z.string().trim().min(1).max(200),
    isbn: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(500),
    subtitle: z.string().max(1_000).optional(),
    authors: z.array(z.object({ name: z.string().trim().min(1).max(200), url: z.string().max(2_048).optional() })).max(30),
    number_of_pages: z.number().int().min(0).max(100_000),
    publish_date: z.string().max(100),
    publishers: z.array(z.object({ name: z.string().trim().min(1).max(200) })).max(20).optional(),
    cover: z.object({
      small: z.string().max(2_048).optional(),
      medium: z.string().max(2_048).optional(),
      large: z.string().max(2_048).optional(),
    }).nullish(),
    status: z.enum(["read", "reading", "unread", "to-read"]),
    shelf_id: z.string().trim().min(1).max(200),
    shelf_name: z.string().max(200),
    catalogue: z.object({
      source: z.enum(["manual", "open-library", "photo", "import"]),
      isbnVerified: z.boolean().default(false),
      sourceUrl: z.url().max(2_048).refine((value) => new URL(value).protocol === "https:").optional(),
    }).optional(),
  })).max(MAX_IMPORT_BOOKS),
  shelves: z.array(z.object({
    id: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(120),
    book_count: z.number().int().min(0).max(MAX_IMPORT_BOOKS),
    isDefault: z.boolean().optional(),
  })).max(MAX_IMPORT_SHELVES),
})

export function parseLibraryImport(input: unknown): LibraryData {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(input)
  } catch {
    throw new Error("El archivo no tiene un formato de biblioteca válido.")
  }
  if (serialized && new TextEncoder().encode(serialized).byteLength > MAX_IMPORT_BYTES) {
    throw new Error("El archivo supera el límite de 8 MiB.")
  }
  if (input && typeof input === "object" && "formatVersion" in input && input.formatVersion !== 1) {
    throw new Error("Esta versión del formato de biblioteca no es compatible. Solo se admite la versión 1 y el formato antiguo.")
  }
  if (input && typeof input === "object") {
    if ("books" in input && Array.isArray(input.books) && input.books.length > MAX_IMPORT_BOOKS) {
      throw new Error("El archivo supera el límite de 2000 libros por importación.")
    }
    if ("shelves" in input && Array.isArray(input.shelves) && input.shelves.length > MAX_IMPORT_SHELVES) {
      throw new Error("El archivo supera el límite de 200 estanterías por importación.")
    }
  }
  const result = librarySchema.safeParse(input)
  if (!result.success) {
    throw new Error("El archivo no tiene un formato de biblioteca válido. Revisa los datos de libros y estanterías.")
  }

  const data = result.data
  if (data.formatVersion === 1 && !data.exportedAt) {
    throw new Error("El archivo versionado debe incluir una fecha de exportación válida.")
  }
  if (new Set(data.books.map((book) => normalizedBookIdentifier(book.isbn))).size !== data.books.length) {
    throw new Error("El archivo contiene libros con el mismo ISBN o identificador.")
  }
  if (new Set(data.books.map((book) => book.id)).size !== data.books.length) {
    throw new Error("El archivo contiene identificadores internos de libros duplicados.")
  }
  if (
    new Set(data.shelves.map((shelf) => shelf.id)).size !== data.shelves.length ||
    new Set(data.shelves.map((shelf) => shelf.title.toLocaleLowerCase("es"))).size !== data.shelves.length ||
    data.shelves.filter((shelf) => shelf.isDefault).length > 1
  ) {
    throw new Error("El archivo contiene estanterías duplicadas o más de una estantería predeterminada.")
  }

  const shelvesById = new Map(data.shelves.map((shelf) => [shelf.id, shelf]))
  const counts = new Map<string, number>()
  const normalizedBooks = data.books.map((book) => {
    const shelf = shelvesById.get(book.shelf_id)
    if (!shelf) {
      throw new Error(`El libro «${book.title}» hace referencia a una estantería inexistente. Corrige el archivo antes de importarlo.`)
    }
    counts.set(shelf.id, (counts.get(shelf.id) ?? 0) + 1)
    return { ...book, isbn: normalizedBookIdentifier(book.isbn), shelf_name: shelf.title, cover: normalizeBookCover(book.cover), catalogue: {
      source: book.catalogue?.source ?? "import" as const,
      isbnVerified: Boolean(normalizeIsbn(book.isbn)) && (book.catalogue?.isbnVerified ?? false),
      ...(book.catalogue?.sourceUrl ? { sourceUrl: book.catalogue.sourceUrl } : {}),
    } }
  })
  return {
    shelves: data.shelves.map((shelf) => ({ ...shelf, book_count: counts.get(shelf.id) ?? 0 })),
    books: normalizedBooks,
  }
}

export function createLibraryExport(data: LibraryData, exportedAt = new Date()): LibraryExport {
  return { ...data, formatVersion: 1, exportedAt: exportedAt.toISOString() }
}

export function summarizeLibraryImport(imported: LibraryData, current: LibraryData) {
  const existing = new Set(current.books.map((book) => normalizedBookIdentifier(book.isbn)))
  const duplicates = imported.books.filter((book) => existing.has(normalizedBookIdentifier(book.isbn)))
  return {
    books: imported.books.length,
    shelves: imported.shelves.length,
    duplicates,
    newBooks: imported.books.length - duplicates.length,
    missingCovers: imported.books.filter((book) => normalizeBookCover(book.cover).large === DEFAULT_BOOK_COVER).length,
    withoutIsbn: imported.books.filter((book) => !normalizeIsbn(book.isbn)).length,
  }
}

// La API admite varios ISBN en una petición y devuelve las URL de las portadas disponibles.
// https://openlibrary.org/dev/docs/api/books
const BATCH_SIZE = 20
const REQUEST_TIMEOUT_MS = 8_000
const MIN_REQUEST_INTERVAL_MS = 1_000
const TOTAL_LOOKUP_BUDGET_MS = 20_000
const responseCoverSchema = z.object({
  cover: z.object({
    small: z.string().optional(),
    medium: z.string().optional(),
    large: z.string().optional(),
  }).optional(),
})

export async function enrichImportedBookCovers(books: Book[]): Promise<Book[]> {
  const prepared = books.map((book) => ({ ...book, cover: normalizeBookCover(book.cover) }))
  const isbns = [...new Set(prepared
    .filter((book) => book.cover.large === DEFAULT_BOOK_COVER)
    .map((book) => normalizeIsbn(book.isbn))
    .filter((isbn): isbn is string => isbn !== null))]
  const covers = new Map<string, Book["cover"]>()
  let previousRequest = 0
  const deadline = Date.now() + TOTAL_LOOKUP_BUDGET_MS

  for (let offset = 0; offset < isbns.length; offset += BATCH_SIZE) {
    const remaining = MIN_REQUEST_INTERVAL_MS - (Date.now() - previousRequest)
    if (Date.now() + Math.max(remaining, 0) >= deadline) break
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))

    const batch = isbns.slice(offset, offset + BATCH_SIZE)
    const url = new URL("https://openlibrary.org/api/books")
    url.searchParams.set("bibkeys", batch.map((isbn) => `ISBN:${isbn}`).join(","))
    url.searchParams.set("format", "json")
    url.searchParams.set("jscmd", "data")

    try {
      previousRequest = Date.now()
      const response = await fetch(url, { headers: openLibraryHeaders(), signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))) })
      // Ante una caída o límite del servicio, el resto se importa con su portada genérica.
      if (!response.ok) break
      const payload: unknown = await response.json()
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) break

      for (const isbn of batch) {
        const entry = responseCoverSchema.safeParse((payload as Record<string, unknown>)[`ISBN:${isbn}`])
        if (!entry.success) continue
        const cover = normalizeBookCover(entry.data.cover)
        if (cover.large !== DEFAULT_BOOK_COVER) covers.set(isbn, cover)
      }
    } catch {
      break
    }
  }

  return prepared.map((book) => {
    if (book.cover.large !== DEFAULT_BOOK_COVER) return book
    const isbn = normalizeIsbn(book.isbn)
    return { ...book, cover: (isbn && covers.get(isbn)) || book.cover }
  })
}

import { z } from "zod"
import { DEFAULT_BOOK_COVER, normalizeBookCover } from "./book-covers"
import { normalizeIsbn, normalizedBookIdentifier } from "./isbn"
import { libraryRequiresV2, readBackupV2 } from "./backup-v2"
import { catalogueProblem, catalogueSchema, normalizeCatalogue, toCatalogueV1 } from "./catalogue-provenance"
import { emitSafely, noopTelemetry, type TelemetryEmitter } from "./observability/emitter"
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
    // Legacy v1 o `catalogue.schemaVersion: 2`: el lector no recorta procedencia ampliada.
    catalogue: catalogueSchema.optional(),
  })).max(MAX_IMPORT_BOOKS),
  shelves: z.array(z.object({
    id: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(120),
    book_count: z.number().int().min(0).max(MAX_IMPORT_BOOKS),
    isDefault: z.boolean().optional(),
  })).max(MAX_IMPORT_SHELVES),
})

export function parseLibraryImport(input: unknown, telemetry: TelemetryEmitter = noopTelemetry): LibraryData {
  const started = Date.now()
  try {
    const library = validateLibraryImport(input)
    emitSafely(telemetry, "import.preview", { operation: "import.validate", result: "ok", durationMs: Math.max(0, Date.now() - started) })
    return library
  } catch (error) {
    emitSafely(telemetry, "import.preview", { operation: "import.validate", result: "error", errorCode: "INVALID_INPUT", durationMs: Math.max(0, Date.now() - started) })
    throw error
  }
}

function validateLibraryImport(input: unknown): LibraryData {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(input)
  } catch {
    throw new Error("El archivo no tiene un formato de biblioteca válido.")
  }
  if (serialized && new TextEncoder().encode(serialized).byteLength > MAX_IMPORT_BYTES) {
    throw new Error("El archivo supera el límite de 8 MiB.")
  }
  let legacy: unknown = input
  if (input && typeof input === "object" && "formatVersion" in input) {
    if (input.formatVersion === 2) {
      if ("copies" in input && Array.isArray(input.copies) && input.copies.length > MAX_IMPORT_BOOKS) {
        throw new Error("El archivo supera el límite de 2000 libros por importación.")
      }
      // Formato portable v2: se adapta a la forma legacy y pasa por las mismas validaciones.
      legacy = readBackupV2(input)
    } else if (input.formatVersion !== 1) {
      throw new Error("Esta versión del formato de biblioteca no es compatible. Se admiten las versiones 1 y 2 y el formato antiguo.")
    }
  }
  if (legacy && typeof legacy === "object") {
    if ("books" in legacy && Array.isArray(legacy.books) && legacy.books.length > MAX_IMPORT_BOOKS) {
      throw new Error("El archivo supera el límite de 2000 libros por importación.")
    }
    if ("shelves" in legacy && Array.isArray(legacy.shelves) && legacy.shelves.length > MAX_IMPORT_SHELVES) {
      throw new Error("El archivo supera el límite de 200 estanterías por importación.")
    }
  }
  const result = librarySchema.safeParse(legacy)
  if (!result.success) {
    throw new Error(describeCatalogueProblem(legacy) ?? "El archivo no tiene un formato de biblioteca válido. Revisa los datos de libros y estanterías.")
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
    return { ...book, isbn: normalizedBookIdentifier(book.isbn), shelf_name: shelf.title, cover: normalizeBookCover(book.cover),
      catalogue: normalizeCatalogue(book.catalogue ?? { source: "import", isbnVerified: false }, book.isbn) }
  })
  return {
    shelves: data.shelves.map((shelf) => ({ ...shelf, book_count: counts.get(shelf.id) ?? 0 })),
    books: normalizedBooks,
  }
}

/** Explica qué procedencia impide leer el archivo, en lugar de un error genérico o una degradación silenciosa. */
function describeCatalogueProblem(input: unknown): string | null {
  if (!input || typeof input !== "object" || !("books" in input) || !Array.isArray(input.books)) return null
  for (const [index, book] of input.books.entries()) {
    if (!book || typeof book !== "object" || !("catalogue" in book)) continue
    const problem = catalogueProblem(book.catalogue)
    if (problem) return `El libro ${index + 1} no se puede importar sin perder su procedencia. ${problem}`
  }
  return null
}

/** Ficha con procedencia v1; lanza si necesita el formato 2 (BNE o fuentes por campo). */
export function toV1Book(book: Book): Book {
  return book.catalogue ? { ...book, catalogue: toCatalogueV1(book.catalogue) } : book
}

/** Exportación v1: solo sin pérdida. Una procedencia BNE o por campo exige el formato 2. */
export function createLibraryExport(data: LibraryData, exportedAt = new Date()): LibraryExport {
  if (libraryRequiresV2(data)) throw new Error("La biblioteca tiene procedencia que el formato 1 no conserva. Exporta en formato 2.")
  return { ...data, books: data.books.map(toV1Book), formatVersion: 1, exportedAt: exportedAt.toISOString() }
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

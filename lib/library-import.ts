import { z } from "zod"
import { DEFAULT_BOOK_COVER, normalizeBookCover } from "./book-covers"
import { normalizeIsbn, normalizedBookIdentifier } from "./isbn"
import { editionFingerprint, libraryRequiresV2, readBackupV2 } from "./backup-v2"
import { catalogueProblem, catalogueSchema, normalizeCatalogue, toCatalogueV1 } from "./catalogue-provenance"
import { copyIdentity, editionKey } from "./import-plan"
import { emitSafely, noopTelemetry, type TelemetryEmitter } from "./observability/emitter"
import type { Book, LibraryData, Shelf } from "./types"

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

/** Exportación v1: una ficha por ejemplar con `isbn` de texto (ISBN-13 o identificador legacy). */
export interface LibraryExportV1Book extends Omit<Book, "isbn" | "legacyIdentifier" | "edition" | "verification" | "version" | "copyVersion" | "coverAssetId"> {
  isbn: string
}

export interface LibraryExport {
  formatVersion: 1
  exportedAt: string
  books: LibraryExportV1Book[]
  shelves: Shelf[]
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

/**
 * Una fila v1/legacy es un ejemplar con su propia edición (clave = su ID). El texto `isbn` pasa a ISBN-13
 * si es un ISBN válido y, si no (`manual-…` u otro valor), se conserva como identificador legacy: nunca se
 * inventa un ISBN ni se descarta el identificador.
 */
function legacyRow(book: z.output<typeof librarySchema>["books"][number]): Book {
  const isbn = normalizeIsbn(book.isbn)
  const legacy = isbn ? undefined : normalizedBookIdentifier(book.isbn)
  return { ...book, isbn, ...(legacy ? { legacyIdentifier: legacy } : {}), cover: normalizeBookCover(book.cover) }
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
  let rows: Book[]
  let shelves: Shelf[]
  if (input && typeof input === "object" && "formatVersion" in input && input.formatVersion === 2) {
    if ("copies" in input && Array.isArray(input.copies) && input.copies.length > MAX_IMPORT_BOOKS) {
      throw new Error("El archivo supera el límite de 2000 libros por importación.")
    }
    if ("shelves" in input && Array.isArray(input.shelves) && input.shelves.length > MAX_IMPORT_SHELVES) {
      throw new Error("El archivo supera el límite de 200 estanterías por importación.")
    }
    // Formato portable v2: ejemplares con la clave de su edición y obra.
    const parsed = readBackupV2(input)
    rows = parsed.books.map((book) => ({ ...book, cover: normalizeBookCover(book.cover) }))
    shelves = parsed.shelves
  } else {
    if (input && typeof input === "object" && "formatVersion" in input && input.formatVersion !== 1) {
      throw new Error("Esta versión del formato de biblioteca no es compatible. Se admiten las versiones 1 y 2 y el formato antiguo.")
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
      throw new Error(describeCatalogueProblem(input) ?? "El archivo no tiene un formato de biblioteca válido. Revisa los datos de libros y estanterías.")
    }
    if (result.data.formatVersion === 1 && !result.data.exportedAt) {
      throw new Error("El archivo versionado debe incluir una fecha de exportación válida.")
    }
    rows = result.data.books.map(legacyRow)
    shelves = result.data.shelves
  }

  // Varias copias pueden compartir edición (v2); dos ediciones distintas nunca comparten ISBN ni identificador.
  // Una fila v1/legacy es su propia edición: dos filas con el mismo ISBN son un duplicado.
  const identityOwner = new Map<string, string>()
  const fingerprints = new Map<string, string>()
  for (const [index, book] of rows.entries()) {
    const key = editionKey(book)
    const fingerprint = editionFingerprint(book)
    const known = book.edition ? fingerprints.get(key) : undefined
    if (known !== undefined && known !== fingerprint) throw new Error("El archivo contiene copias de una misma edición con datos bibliográficos distintos.")
    fingerprints.set(key, fingerprint)
    const identity = copyIdentity(book)
    if (!identity) continue
    // Un identificador legacy es de un ejemplar; un ISBN-13, de una edición declarada.
    const owner = book.edition ? (book.isbn ? key : book.id) : `fila:${index}`
    if (identityOwner.has(identity) && identityOwner.get(identity) !== owner) throw new Error("El archivo contiene libros con el mismo ISBN o identificador.")
    identityOwner.set(identity, owner)
  }
  if (new Set(rows.map((book) => book.id)).size !== rows.length) {
    throw new Error("El archivo contiene identificadores internos de libros duplicados.")
  }
  if (
    new Set(shelves.map((shelf) => shelf.id)).size !== shelves.length ||
    new Set(shelves.map((shelf) => shelf.title.toLocaleLowerCase("es"))).size !== shelves.length ||
    shelves.filter((shelf) => shelf.isDefault).length > 1
  ) {
    throw new Error("El archivo contiene estanterías duplicadas o más de una estantería predeterminada.")
  }

  const shelvesById = new Map(shelves.map((shelf) => [shelf.id, shelf]))
  const counts = new Map<string, number>()
  const normalizedBooks = rows.map((book) => {
    const shelf = shelvesById.get(book.shelf_id)
    if (!shelf) {
      throw new Error(`El libro «${book.title}» hace referencia a una estantería inexistente. Corrige el archivo antes de importarlo.`)
    }
    counts.set(shelf.id, (counts.get(shelf.id) ?? 0) + 1)
    const catalogue = catalogueSchema.safeParse(book.catalogue ?? { source: "import", isbnVerified: false })
    if (!catalogue.success) throw new Error(`El libro «${book.title}» no se puede importar sin perder su procedencia.`)
    return { ...book, shelf_name: shelf.title, catalogue: normalizeCatalogue(catalogue.data, book.isbn ?? "") }
  })
  return {
    shelves: shelves.map((shelf) => ({ ...shelf, book_count: counts.get(shelf.id) ?? 0 })),
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

/** Ficha v1: procedencia v1 e `isbn` de texto. Lanza si necesita el formato 2. */
export function toV1Book(book: Book): LibraryExportV1Book {
  const identifier = book.isbn ?? book.legacyIdentifier
  if (!identifier) throw new Error("Un libro sin ISBN ni identificador anterior necesita el formato 2.")
  // Los tokens de versión, la edición y la portada privada no forman parte de v1.
  return {
    id: book.id, isbn: identifier, title: book.title, ...(book.subtitle !== undefined ? { subtitle: book.subtitle } : {}),
    authors: book.authors, number_of_pages: book.number_of_pages, publish_date: book.publish_date,
    ...(book.publishers !== undefined ? { publishers: book.publishers } : {}),
    cover: book.cover, status: book.status, shelf_id: book.shelf_id, shelf_name: book.shelf_name,
    ...(book.catalogue ? { catalogue: toCatalogueV1(book.catalogue) } : {}),
  }
}

/**
 * Exportación v1: solo sin pérdida. Procedencia BNE o por campo, varias copias de una edición, obras,
 * evidencias o identificadores de edición y libros sin ISBN ni identificador exigen el formato 2.
 */
export function createLibraryExport(data: LibraryData, exportedAt = new Date()): LibraryExport {
  if (libraryRequiresV2(data)) throw new Error("La biblioteca tiene datos que el formato 1 no conserva (procedencia ampliada, varios ejemplares de una edición, obras o libros sin ISBN). Exporta en formato 2.")
  return { shelves: data.shelves, books: data.books.map(toV1Book), formatVersion: 1, exportedAt: exportedAt.toISOString() }
}

export function summarizeLibraryImport(imported: LibraryData, current: LibraryData) {
  const existing = new Set(current.books.map(copyIdentity).filter((identity): identity is string => Boolean(identity)))
  const duplicates = imported.books.filter((book) => {
    const identity = copyIdentity(book)
    return identity !== null && existing.has(identity)
  })
  return {
    books: imported.books.length,
    shelves: imported.shelves.length,
    duplicates,
    newBooks: imported.books.length - duplicates.length,
    missingCovers: imported.books.filter((book) => normalizeBookCover(book.cover).large === DEFAULT_BOOK_COVER).length,
    withoutIsbn: imported.books.filter((book) => !normalizeIsbn(book.isbn ?? "")).length,
  }
}

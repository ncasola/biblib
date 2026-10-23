import {
  MAX_IMPORT_BOOKS,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_SHELVES,
  parseLibraryImport,
  toV1Book,
  type LibraryExport,
} from "./library-import"
import { bookToEditionAndCopy, createBackupV2, libraryRequiresV2, type PortableBackupV2 } from "./backup-v2"
import type { Book, LibraryData, Shelf } from "./types"

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function shelvesForBooks(shelves: Shelf[], books: Book[]): Shelf[] {
  const counts = new Map<string, number>()
  for (const book of books) counts.set(book.shelf_id, (counts.get(book.shelf_id) ?? 0) + 1)
  return shelves.map((shelf) => ({ ...shelf, book_count: counts.get(shelf.id) ?? 0 }))
}

/** Cómo mide y construye cada formato una parte; los separadores son las comas de cada array. */
interface PartFormat<T> {
  envelopeBytes: number
  /** Arrays donde aparece cada libro (v1: `books`; v2: `editions` y `copies`). */
  arraysPerBook: number
  bookBytes(book: Book): number
  shelfBytes(shelf: Shelf): number
  build(books: Book[], shelves: Shelf[]): T
}

function fragment<T>(data: LibraryData, format: PartFormat<T>): T[] {
  const shelfById = new Map(data.shelves.map((shelf) => [shelf.id, shelf]))
  const chunks: T[] = []
  let currentBooks: Book[] = []
  let currentShelves: Shelf[] = []
  let currentBookBytes = 0
  let currentShelfBytes = 0
  let currentShelfIds = new Set<string>()
  const byteLength = (bookBytes: number, bookCount: number, shelfBytes: number, shelfCount: number) =>
    format.envelopeBytes + bookBytes + format.arraysPerBook * Math.max(0, bookCount - 1) + shelfBytes + Math.max(0, shelfCount - 1)

  const flush = () => {
    if (currentBooks.length === 0 && currentShelves.length === 0) return
    const chunk = format.build(currentBooks, currentShelves)
    parseLibraryImport(chunk)
    chunks.push(chunk)
    currentBooks = []
    currentShelves = []
    currentBookBytes = 0
    currentShelfBytes = 0
    currentShelfIds = new Set<string>()
  }

  for (const book of data.books) {
    const shelf = shelfById.get(book.shelf_id)
    if (!shelf) throw new Error(`El libro «${book.title}» hace referencia a una estantería inexistente.`)

    const bookBytes = format.bookBytes(book)
    const shelfRecordBytes = format.shelfBytes(shelf)
    let accepted = false
    while (!accepted) {
      const hasShelf = currentShelfIds.has(shelf.id)
      const shelfBytes = hasShelf ? 0 : shelfRecordBytes
      const nextBookCount = currentBooks.length + 1
      const nextShelfCount = currentShelves.length + (hasShelf ? 0 : 1)
      if (
        nextBookCount <= MAX_IMPORT_BOOKS &&
        nextShelfCount <= MAX_IMPORT_SHELVES &&
        byteLength(currentBookBytes + bookBytes, nextBookCount, currentShelfBytes + shelfBytes, nextShelfCount) <= MAX_IMPORT_BYTES
      ) {
        currentBooks.push(book)
        currentBookBytes += bookBytes
        if (!hasShelf) {
          currentShelves.push(shelf)
          currentShelfIds.add(shelf.id)
          currentShelfBytes += shelfBytes
        }
        accepted = true
      } else if (currentBooks.length || currentShelves.length) {
        flush()
      } else {
        throw new Error(`El libro «${book.title}» supera por sí solo el límite de tamaño de una importación.`)
      }
    }
  }

  const booksByShelf = new Set(data.books.map((book) => book.shelf_id))
  for (const shelf of data.shelves) {
    const hasBooks = booksByShelf.has(shelf.id)
    if (hasBooks) continue

    let accepted = false
    while (!accepted) {
      const shelfBytes = format.shelfBytes(shelf)
      const nextShelfCount = currentShelves.length + 1
      if (nextShelfCount <= MAX_IMPORT_SHELVES && byteLength(currentBookBytes, currentBooks.length, currentShelfBytes + shelfBytes, nextShelfCount) <= MAX_IMPORT_BYTES) {
        currentShelves.push(shelf)
        currentShelfIds.add(shelf.id)
        currentShelfBytes += shelfBytes
        accepted = true
      } else if (currentBooks.length || currentShelves.length) {
        flush()
      } else {
        throw new Error(`La estantería «${shelf.title}» supera por sí sola el límite de tamaño de una importación.`)
      }
    }
  }

  flush()
  if (chunks.length === 0) chunks.push(format.build([], []))
  return chunks
}

const V1_REQUIRED = "La biblioteca tiene procedencia que el formato 1 no conserva (BNE o fuentes por campo). Exporta en formato 2."

/** Divide una biblioteca en archivos v1 importables sin perder libros ni estanterías. Lanza si v1 perdería procedencia. */
export function fragmentLibraryExport(data: LibraryData, exportedAt = new Date()): LibraryExport[] {
  if (libraryRequiresV2(data)) throw new Error(V1_REQUIRED)
  const timestamp = exportedAt.toISOString()
  return fragment<LibraryExport>(data, {
    envelopeBytes: jsonByteLength({ books: [], shelves: [], formatVersion: 1, exportedAt: timestamp }),
    arraysPerBook: 1,
    bookBytes: (book) => jsonByteLength(toV1Book(book)),
    shelfBytes: (shelf) => jsonByteLength({ ...shelf, book_count: MAX_IMPORT_BOOKS }),
    build: (books, shelves) => ({ books: books.map(toV1Book), shelves: shelvesForBooks(shelves, books), formatVersion: 1, exportedAt: timestamp }),
  })
}

/** Divide una biblioteca en archivos `formatVersion: 2` independientes y válidos por sí solos. */
export function fragmentBackupV2(data: LibraryData, exportedAt = new Date()): PortableBackupV2[] {
  const capabilitiesUpperBound = createBackupV2({ books: data.books, shelves: [] }, exportedAt).requiredCapabilities
  const empty = { ...createBackupV2({ books: [], shelves: [] }, exportedAt), requiredCapabilities: capabilitiesUpperBound }
  return fragment<PortableBackupV2>(data, {
    envelopeBytes: jsonByteLength(empty),
    arraysPerBook: 2,
    bookBytes: (book) => { const { edition, copy } = bookToEditionAndCopy(book); return jsonByteLength(edition) + jsonByteLength(copy) },
    shelfBytes: (shelf) => jsonByteLength({ id: shelf.id, title: shelf.title, isDefault: Boolean(shelf.isDefault) }),
    build: (books, shelves) => createBackupV2({ books, shelves }, exportedAt),
  })
}

export type LibraryBackup =
  | { formatVersion: 1; parts: LibraryExport[] }
  | { formatVersion: 2; parts: PortableBackupV2[]; reason: string }

/**
 * Elige el formato de la copia: v1 solo si no pierde datos (compatibilidad con versiones
 * anteriores de BibLib); si alguna ficha tiene procedencia BNE o por campo, exige v2.
 */
export function exportLibraryBackup(data: LibraryData, exportedAt = new Date()): LibraryBackup {
  if (libraryRequiresV2(data)) return { formatVersion: 2, parts: fragmentBackupV2(data, exportedAt), reason: V1_REQUIRED }
  return { formatVersion: 1, parts: fragmentLibraryExport(data, exportedAt) }
}

/** Recuentos visibles de una parte de cualquier formato. */
export function backupPartCounts(part: LibraryExport | PortableBackupV2): { books: number; shelves: number } {
  return { books: part.formatVersion === 2 ? part.copies.length : part.books.length, shelves: part.shelves.length }
}

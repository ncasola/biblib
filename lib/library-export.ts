import {
  MAX_IMPORT_BOOKS,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_SHELVES,
  parseLibraryImport,
  type LibraryExport,
} from "./library-import"
import type { Book, LibraryData, Shelf } from "./types"

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function exportByteLength(bookBytes: number, bookCount: number, shelfBytes: number, shelfCount: number, timestamp: string): number {
  const envelopeBytes = jsonByteLength({ books: [], shelves: [], formatVersion: 1, exportedAt: timestamp })
  return envelopeBytes + bookBytes + Math.max(0, bookCount - 1) + shelfBytes + Math.max(0, shelfCount - 1)
}

function shelvesForBooks(shelves: Shelf[], books: Book[]): Shelf[] {
  const counts = new Map<string, number>()
  for (const book of books) counts.set(book.shelf_id, (counts.get(book.shelf_id) ?? 0) + 1)
  return shelves.map((shelf) => ({ ...shelf, book_count: counts.get(shelf.id) ?? 0 }))
}

/** Divide una biblioteca en archivos v1 importables sin perder libros ni estanterías. */
export function fragmentLibraryExport(data: LibraryData, exportedAt = new Date()): LibraryExport[] {
  const timestamp = exportedAt.toISOString()
  const shelfById = new Map(data.shelves.map((shelf) => [shelf.id, shelf]))
  const chunks: LibraryExport[] = []
  let currentBooks: Book[] = []
  let currentShelves: Shelf[] = []
  let currentBookBytes = 0
  let currentShelfBytes = 0
  let currentShelfIds = new Set<string>()

  const makeChunk = (books: Book[], shelves: Shelf[]): LibraryExport => ({
    books,
    shelves: shelvesForBooks(shelves, books),
    formatVersion: 1,
    exportedAt: timestamp,
  })

  const flush = () => {
    if (currentBooks.length === 0 && currentShelves.length === 0) return
    const chunk = makeChunk(currentBooks, currentShelves)
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

    const bookBytes = jsonByteLength(book)
    const shelfRecordBytes = jsonByteLength({ ...shelf, book_count: MAX_IMPORT_BOOKS })
    let accepted = false
    while (!accepted) {
      const hasShelf = currentShelfIds.has(shelf.id)
      const shelfBytes = hasShelf ? 0 : shelfRecordBytes
      const nextBookCount = currentBooks.length + 1
      const nextShelfCount = currentShelves.length + (hasShelf ? 0 : 1)
      if (
        nextBookCount <= MAX_IMPORT_BOOKS &&
        nextShelfCount <= MAX_IMPORT_SHELVES &&
        exportByteLength(currentBookBytes + bookBytes, nextBookCount, currentShelfBytes + shelfBytes, nextShelfCount, timestamp) <= MAX_IMPORT_BYTES
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
      const shelfBytes = jsonByteLength(shelf)
      const nextShelfCount = currentShelves.length + 1
      if (nextShelfCount <= MAX_IMPORT_SHELVES && exportByteLength(currentBookBytes, currentBooks.length, currentShelfBytes + shelfBytes, nextShelfCount, timestamp) <= MAX_IMPORT_BYTES) {
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
  if (chunks.length === 0) chunks.push(makeChunk([], []))
  return chunks
}

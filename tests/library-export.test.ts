import assert from "node:assert/strict"
import { test } from "node:test"
import { fragmentLibraryExport } from "../lib/library-export"
import { MAX_IMPORT_BOOKS, MAX_IMPORT_BYTES, MAX_IMPORT_SHELVES, parseLibraryImport } from "../lib/library-import"
import type { Book, LibraryData, Shelf } from "../lib/types"

function makeShelf(index: number): Shelf {
  return { id: `shelf-${index}`, title: `Estantería ${index}`, book_count: 0 }
}

function makeBook(index: number, shelfId: string, coverValue = "https://example.test/cover"): Book {
  return {
    id: `book-${index}`,
    isbn: `custom-${index}`,
    title: `Libro ${index}`,
    authors: [{ name: "Autora de prueba" }],
    number_of_pages: index,
    publish_date: "2020",
    cover: { small: coverValue, medium: coverValue, large: coverValue },
    status: "unread",
    shelf_id: shelfId,
    shelf_name: "Nombre anterior que se normalizará",
  }
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

test("fragmenta por límite de estanterías y preserva IDs, libros y estanterías vacías", () => {
  const shelves = Array.from({ length: MAX_IMPORT_SHELVES + 7 }, (_, index) => makeShelf(index))
  const books = [makeBook(1, shelves[0].id), makeBook(2, shelves[0].id), makeBook(3, shelves[1].id)]
  const data: LibraryData = { shelves, books }
  const exportedAt = new Date("2026-10-22T12:34:56.000Z")

  const chunks = fragmentLibraryExport(data, exportedAt)
  const parsed = chunks.map((chunk) => parseLibraryImport(chunk))
  const exportedBooks = parsed.flatMap((chunk) => chunk.books)
  const exportedShelfIds = new Set(parsed.flatMap((chunk) => chunk.shelves.map((shelf) => shelf.id)))

  assert.ok(chunks.length > 1)
  assert.deepEqual(exportedBooks.map((book) => book.id), books.map((book) => book.id))
  assert.deepEqual([...exportedShelfIds].sort(), shelves.map((shelf) => shelf.id).sort())
  assert.ok(chunks.every((chunk) => chunk.exportedAt === exportedAt.toISOString()))
  assert.ok(chunks.every((chunk) => chunk.books.length <= MAX_IMPORT_BOOKS))
  assert.ok(chunks.every((chunk) => chunk.shelves.length <= MAX_IMPORT_SHELVES))
  assert.ok(chunks.every((chunk) => byteLength(chunk) <= MAX_IMPORT_BYTES))
  assert.equal(parsed.flatMap((chunk) => chunk.shelves).find((shelf) => shelf.id === shelves[5].id)?.book_count, 0)
})

test("fragmenta por bytes y mantiene cada libro exactamente una vez", () => {
  const shelf = makeShelf(0)
  const longCover = "é".repeat(2_048)
  const books = Array.from({ length: 700 }, (_, index) => makeBook(index, shelf.id, longCover))
  const chunks = fragmentLibraryExport({ shelves: [shelf], books }, new Date("2026-10-22T00:00:00.000Z"))

  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((chunk) => byteLength(chunk) <= MAX_IMPORT_BYTES))
  const parsed = chunks.map((chunk) => parseLibraryImport(chunk))
  assert.deepEqual(parsed.flatMap((chunk) => chunk.books.map((book) => book.id)), books.map((book) => book.id))
  assert.ok(parsed.every((chunk) => chunk.shelves.some((item) => item.id === shelf.id)))
})

test("fragmenta exactamente en el máximo de libros y corrige el recuento de la estantería", () => {
  const shelf = makeShelf(0)
  const books = Array.from({ length: MAX_IMPORT_BOOKS + 1 }, (_, index) => makeBook(index, shelf.id))
  const chunks = fragmentLibraryExport({ shelves: [shelf], books }, new Date("2026-10-22T00:00:00.000Z"))

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].books.length, MAX_IMPORT_BOOKS)
  assert.equal(chunks[0].shelves[0].book_count, MAX_IMPORT_BOOKS)
  assert.equal(chunks[1].books.length, 1)
  assert.equal(chunks[1].shelves[0].book_count, 1)
  assert.ok(chunks.every((chunk) => byteLength(chunk) <= MAX_IMPORT_BYTES))
  assert.equal(chunks.flatMap((chunk) => parseLibraryImport(chunk).books).length, books.length)
})

test("exporta una biblioteca vacía en un único archivo v1 importable", () => {
  const [chunk] = fragmentLibraryExport({ shelves: [], books: [] }, new Date("2026-10-22T00:00:00.000Z"))

  assert.equal(chunk.formatVersion, 1)
  assert.equal(chunk.books.length, 0)
  assert.equal(chunk.shelves.length, 0)
  assert.deepEqual(parseLibraryImport(chunk), { books: [], shelves: [] })
})

import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeBookCover } from "../lib/book-covers"
import {
  createLibraryExport, MAX_IMPORT_BOOKS, MAX_IMPORT_BYTES,
  MAX_IMPORT_SHELVES, parseLibraryImport, summarizeLibraryImport,
} from "../lib/library-import"
import type { Book, LibraryData } from "../lib/types"

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: "book-1", isbn: "9788401337208", title: "El nombre del viento",
    authors: [{ name: "Patrick Rothfuss" }], number_of_pages: 0, publish_date: "",
    cover: normalizeBookCover(), status: "unread", shelf_id: "shelf-1", shelf_name: "Predeterminada",
    ...overrides,
  }
}

const cover = {
  small: "https://covers.openlibrary.org/b/id/123-S.jpg",
  medium: "https://covers.openlibrary.org/b/id/123-M.jpg",
  large: "https://covers.openlibrary.org/b/id/123-L.jpg",
}

test("valida el JSON antes de importar y tolera portadas ausentes o parciales", () => {
  const input = { books: [{ ...book(), cover: undefined }], shelves: [{ id: "shelf-1", title: "Predeterminada", book_count: 1, isDefault: true }] }
  assert.deepEqual(parseLibraryImport(input).books[0].cover, normalizeBookCover())
  assert.throws(() => parseLibraryImport({ ...input, books: [{ ...book(), status: "incorrecto" }] }), /formato de biblioteca válido/)
  assert.throws(() => parseLibraryImport({ ...input, books: [{ ...book(), number_of_pages: -1 }] }), /formato de biblioteca válido/)
  assert.throws(() => parseLibraryImport({ ...input, books: [book(), book()] }), /mismo ISBN/)
  assert.throws(() => parseLibraryImport({ ...input, shelves: [...input.shelves, ...input.shelves] }), /estanterías duplicadas/)
  assert.throws(() => parseLibraryImport(null), /formato de biblioteca válido/)
})

function library(books: Book[] = [book()]): LibraryData {
  return { books, shelves: [{ id: "shelf-1", title: "Predeterminada", book_count: books.length, isDefault: true }] }
}

test("exporta versión y fecha y restaura tanto el formato antiguo como el versionado", () => {
  const original = library([book({ subtitle: "Crónica del asesino de reyes", publishers: [{ name: "Plaza & Janés" }], catalogue: { source: "photo", isbnVerified: false, sourceUrl: "https://openlibrary.org/books/OL1M" } })])
  const snapshot = structuredClone(original)
  const exportedAt = new Date("2026-10-22T12:00:00.000Z")
  const exported = createLibraryExport(original, exportedAt)
  assert.equal(exported.formatVersion, 1)
  assert.equal(exported.exportedAt, exportedAt.toISOString())
  assert.deepEqual(parseLibraryImport(JSON.parse(JSON.stringify(exported))), original)
  assert.deepEqual(parseLibraryImport(original), original)
  assert.deepEqual(original, snapshot)
  assert.throws(() => parseLibraryImport({ ...exported, formatVersion: 3 }), /versión.*no es compatible/)
  // No existe un formato 2 con el array `books`: el lector v2 no lo interpreta como v1.
  assert.throws(() => parseLibraryImport({ ...exported, formatVersion: 2 }), /formato 2 contiene secciones.*books/)
  assert.throws(() => parseLibraryImport({ ...exported, exportedAt: undefined }), /fecha de exportación/)
  assert.throws(() => parseLibraryImport({ ...exported, exportedAt: "ayer" }), /formato de biblioteca válido/)
})

test("rechaza referencias rotas y IDs repetidos en lugar de reasignar libros silenciosamente", () => {
  assert.throws(() => parseLibraryImport(library([book({ shelf_id: "inexistente" })])), /estantería inexistente/)
  assert.throws(() => parseLibraryImport(library([book(), book({ isbn: "9788401339639" })])), /identificadores internos.*duplicados/)
  const input = library([book({ shelf_name: "Nombre anticuado" })])
  input.shelves[0].book_count = 99
  const parsed = parseLibraryImport(input)
  assert.equal(parsed.books[0].shelf_name, "Predeterminada")
  assert.equal(parsed.shelves[0].book_count, 1)
  assert.deepEqual(parseLibraryImport({ books: [], shelves: [] }), { books: [], shelves: [] })
})

test("normaliza ISBN equivalentes y detecta duplicados entre ISBN-10 e ISBN-13", () => {
  const first = book({ isbn: "0-8044-2957-x" })
  const second = book({ id: "otro", isbn: "9780804429573" })
  assert.equal(parseLibraryImport(library([first])).books[0].isbn, second.isbn)
  assert.throws(() => parseLibraryImport(library([first, second])), /mismo ISBN/)
  // U-DAT-06: un identificador manual no es un ISBN; se conserva como identificador legacy del ejemplar.
  const manual = parseLibraryImport(library([book({ isbn: " manual-ejemplar-1 " })])).books[0]
  assert.equal(manual.isbn, null)
  assert.equal(manual.legacyIdentifier, "manual-ejemplar-1")
})

test("conserva procedencia y verificación y marca como provisionales los archivos antiguos", () => {
  assert.deepEqual(parseLibraryImport(library()).books[0].catalogue, { source: "import", isbnVerified: false })
  assert.deepEqual(parseLibraryImport(library([book({ catalogue: { source: "manual", isbnVerified: true } })])).books[0].catalogue, { source: "manual", isbnVerified: true })
  assert.equal(parseLibraryImport(library([book({ isbn: "manual-ejemplar", catalogue: { source: "manual", isbnVerified: true } })])).books[0].catalogue?.isbnVerified, false)
  assert.throws(() => parseLibraryImport(library([book({ catalogue: { source: "import", isbnVerified: false, sourceUrl: "javascript:alert(1)" } })])), /formato de biblioteca válido/)
})

test("rechaza archivos, cantidades y campos fuera de los límites antes de importar", () => {
  assert.throws(() => parseLibraryImport({ ...library(), padding: "x".repeat(MAX_IMPORT_BYTES) }), /límite de 8 MiB/)
  const tooManyBooks = Array.from({ length: MAX_IMPORT_BOOKS + 1 }, (_, index) => book({ id: `libro-${index}`, isbn: `manual-${index}` }))
  assert.throws(() => parseLibraryImport(library(tooManyBooks)), /límite de 2000 libros/)
  const tooManyShelves = Array.from({ length: MAX_IMPORT_SHELVES + 1 }, (_, index) => ({ id: `estante-${index}`, title: `Estante ${index}`, book_count: 0 }))
  assert.throws(() => parseLibraryImport({ books: [], shelves: tooManyShelves }), /límite de 200 estanterías/)
  assert.throws(() => parseLibraryImport(library([book({ title: "x".repeat(501) })])), /formato de biblioteca válido/)
  assert.throws(() => parseLibraryImport(library([book({ number_of_pages: 100_001 })])), /formato de biblioteca válido/)
})

test("la revisión calcula duplicados normalizados, portadas y registros sin ISBN sin consultar al proveedor", (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("La revisión no consulta servicios externos") })
  const current = library([book({ isbn: "9780804429573", cover })])
  const imported = library([book({ isbn: "0-8044-2957-x" }), book({ id: "manual", isbn: "manual-provisional", cover })])
  const snapshot = structuredClone(imported)
  const preview = summarizeLibraryImport(imported, current)
  assert.equal(preview.books, 2)
  assert.equal(preview.duplicates.length, 1)
  assert.equal(preview.newBooks, 1)
  assert.equal(preview.missingCovers, 1)
  assert.equal(preview.withoutIsbn, 1)
  assert.deepEqual(imported, snapshot)
  assert.equal(fetch.mock.callCount(), 0)
})

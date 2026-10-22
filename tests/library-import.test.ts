import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_BOOK_COVER, normalizeBookCover } from "../lib/book-covers"
import {
  createLibraryExport, enrichImportedBookCovers, MAX_IMPORT_BOOKS, MAX_IMPORT_BYTES,
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

test("consulta por lotes y conserva todos los datos importados salvo la portada", async (t) => {
  const original = [book({ status: "read", number_of_pages: 872, publish_date: "2009" }), book({ id: "book-2", isbn: "9788401339639" })]
  const snapshot = structuredClone(original)
  const requests: URL[] = []
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    requests.push(input)
    return Response.json({ "ISBN:9788401337208": { cover }, "ISBN:9788401339639": { cover } })
  })
  const result = await enrichImportedBookCovers(original)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].searchParams.get("bibkeys"), "ISBN:9788401337208,ISBN:9788401339639")
  assert.deepEqual(result, original.map((entry) => ({ ...entry, cover })))
  assert.deepEqual(original, snapshot)
})

test("no consulta ISBN manuales, vacíos o con dígito de control incorrecto", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("No debe consultar") })
  const original = ["manual-9788401337208", "", "9788401337201", "abcdefghij", "1234567890"].map((isbn) => book({ isbn }))
  assert.deepEqual(await enrichImportedBookCovers(original), original)
  assert.equal(fetch.mock.callCount(), 0)
})

test("reutiliza las portadas existentes y completa tamaños sin consultar", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("No debe consultar") })
  const existing = "https://mi-biblioteca.example/portada.jpg"
  const [result] = await enrichImportedBookCovers([book({ cover: { small: DEFAULT_BOOK_COVER, medium: existing, large: "" } })])
  assert.deepEqual(result.cover, { small: existing, medium: existing, large: existing })
  assert.equal(fetch.mock.callCount(), 0)
})

test("normaliza ISBN con guiones y un ISBN-10 terminado en x sin modificar el identificador guardado", async (t) => {
  const requests: string[] = []
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    requests.push(input.searchParams.get("bibkeys") ?? "")
    return Response.json({ "ISBN:9788401337208": { cover }, "ISBN:9780804429573": { cover } })
  })
  const originals = [book({ isbn: "978-84-01-33720-8" }), book({ isbn: "0-8044-2957-x" })]
  const result = await enrichImportedBookCovers(originals)
  assert.deepEqual(requests, ["ISBN:9788401337208,ISBN:9780804429573"])
  assert.deepEqual(result.map((entry) => entry.isbn), originals.map((entry) => entry.isbn))
  assert(result.every((entry) => entry.cover.large === cover.large))
})

test("la ausencia de portada, los resultados malformados y los placeholders conservan el fallback", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    "ISBN:9788401337208": { cover: { large: null } },
    "ISBN:9788401339639": { cover: { medium: "/placeholder.svg?height=256" } },
  }))
  const originals = [book(), book({ isbn: "9788401339639" }), book({ isbn: "9788401027055" })]
  assert.deepEqual(await enrichImportedBookCovers(originals), originals)
})

test("una respuesta parcial completa los tamaños que falten", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ "ISBN:9788401337208": { cover: { large: cover.large } } }))
  const [result] = await enrichImportedBookCovers([book()])
  assert.deepEqual(result.cover, { small: cover.large, medium: cover.large, large: cover.large })
})

test("fallos HTTP, timeout, red o JSON no impiden preparar la importación", async (t) => {
  const responses = [
    async () => new Response(null, { status: 429 }),
    async () => new Response(null, { status: 503 }),
    async () => { throw new DOMException("Tiempo agotado", "TimeoutError") },
    async () => { throw new TypeError("Fallo de red") },
    async () => new Response("no es JSON"),
    async () => Response.json(null),
    async () => Response.json([]),
  ]
  for (const response of responses) {
    const mocked = t.mock.method(globalThis, "fetch", response)
    assert.deepEqual(await enrichImportedBookCovers([book()]), [book()])
    mocked.mock.restore()
  }
})

test("divide lotes grandes, omite consultas repetidas y conserva resultados si falla un lote posterior", async (t) => {
  // Veintiún ISBN-13 con dígitos de control válidos.
  const originals = Array.from({ length: 21 }, (_, index) => {
    const base = String(978840133700 + index)
    const sum = [...base].reduce((total, digit, position) => total + Number(digit) * (position % 2 ? 3 : 1), 0)
    return book({ id: `book-${index}`, isbn: `${base}${(10 - sum % 10) % 10}` })
  })
  originals.push(book({ id: "repetido", isbn: originals[0].isbn }))
  const requests: string[][] = []
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    const keys = (input.searchParams.get("bibkeys") ?? "").split(",")
    requests.push(keys)
    return requests.length === 1 ? Response.json(Object.fromEntries(keys.map((key) => [key, { cover }]))) : new Response(null, { status: 503 })
  })
  const result = await enrichImportedBookCovers(originals)
  assert.deepEqual(requests.map((keys) => keys.length), [20, 1])
  assert.equal(result.filter((entry) => entry.cover.large === cover.large).length, 21)
  assert.equal(result[20].cover.large, DEFAULT_BOOK_COVER)
})

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
  assert.throws(() => parseLibraryImport({ ...exported, formatVersion: 2 }), /versión.*no es compatible/)
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
  assert.equal(parseLibraryImport(library([book({ isbn: " manual-ejemplar-1 " })])).books[0].isbn, "manual-ejemplar-1")
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

test("el presupuesto total de portadas termina el enriquecimiento conservando los libros preparados", async (t) => {
  const started = Date.now()
  let calls = 0
  t.mock.method(Date, "now", () => started + calls * 20_001)
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    calls++
    return Response.json({ "ISBN:9788401337208": { cover } })
  })
  const originals = Array.from({ length: 21 }, (_, index) => {
    const base = String(978840133720 + index)
    const sum = [...base].reduce((total, digit, position) => total + Number(digit) * (position % 2 ? 3 : 1), 0)
    return book({ id: `presupuesto-${index}`, isbn: `${base}${(10 - sum % 10) % 10}` })
  })
  const result = await enrichImportedBookCovers(originals)
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(result.length, originals.length)
  assert.equal(result[20].cover.large, DEFAULT_BOOK_COVER)
})

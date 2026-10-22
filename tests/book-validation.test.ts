import assert from "node:assert/strict"
import { test } from "node:test"
import { parseBookInput, parseShelfTitle, parseUuid } from "../lib/book-validation"
import { DomainError } from "../lib/domain-errors"
import { normalizeIsbn, normalizedBookIdentifier } from "../lib/isbn"
import { mutationResult, unwrapAction } from "../lib/action-result"

function input(overrides: Record<string, unknown> = {}) {
  return {
    isbn: "9788401337208", title: "El nombre del viento", authors: [{ name: "Patrick Rothfuss" }],
    number_of_pages: 872, publish_date: "2009", status: "unread", shelf_id: "",
    ...overrides,
  }
}

const invalidInput = (error: unknown) => error instanceof DomainError && error.code === "INVALID_INPUT"

test("valida ISBN-10 con X y convierte ISBN equivalentes a una misma edición", () => {
  assert.equal(normalizeIsbn("0-8044-2957-x"), "9780804429573")
  assert.equal(normalizeIsbn("978-0-8044-2957-3"), "9780804429573")
  assert.equal(normalizedBookIdentifier(" manual-abc "), "manual-abc")
  for (const isbn of ["9788401337201", "0804429570", "abcdefghij", "9788401337208abc", "1234567890", ""]) assert.equal(normalizeIsbn(isbn), null)
  assert.equal(parseBookInput(input({ isbn: "0-8044-2957-x" })).isbn, "9780804429573")
  assert.throws(() => parseBookInput(input({ isbn: "9788401337201" })), invalidInput)
})

test("permite fichas sin ISBN y conserva identificadores manuales compatibles", () => {
  assert.equal(parseBookInput(input({ isbn: "" })).isbn, "")
  assert.equal(parseBookInput(input({ isbn: undefined })).isbn, "")
  const manual = "manual-123e4567-e89b-42d3-a456-426614174000"
  assert.equal(parseBookInput(input({ isbn: manual })).isbn, manual)
  assert.throws(() => parseBookInput(input({ isbn: "manual-no-valido" })), invalidInput)
})

test("recorta títulos y nombres y rechaza texto vacío, cantidades negativas y arrays malformados", () => {
  const parsed = parseBookInput(input({ title: "  Una ficha  ", authors: [{ name: "  Una autora  " }] }))
  assert.equal(parsed.title, "Una ficha")
  assert.deepEqual(parsed.authors, [{ name: "Una autora" }])
  for (const override of [
    { title: "   " }, { title: "x".repeat(501) }, { number_of_pages: -1 }, { number_of_pages: 3.5 },
    { number_of_pages: 100_001 }, { authors: "Una autora" }, { authors: [{ name: " " }] },
    { authors: [null] }, { publishers: [{ name: "" }] }, { status: "inventado" },
  ]) assert.throws(() => parseBookInput(input(override)), invalidInput)
  assert.throws(() => parseBookInput(null), invalidInput)
  assert.throws(() => parseBookInput([]), invalidInput)
})

test("acepta HTTPS y portada por defecto y rechaza esquemas peligrosos o direcciones HTTP", () => {
  const cover = parseBookInput(input({ cover: { large: "https://covers.openlibrary.org/b/id/1-L.jpg" } })).cover
  assert.equal(cover.small, cover.large)
  assert.equal(parseBookInput(input()).cover.large, "/default-book-cover.webp")
  assert.equal(parseBookInput(input({ cover: { large: "/default-book-cover.webp" } })).cover.large, "/default-book-cover.webp")
  for (const url of ["http://example.com/portada.jpg", "javascript:alert(1)", "data:image/png;base64,abc", "//example.com/portada.jpg", "/otra-portada.jpg"]) {
    assert.throws(() => parseBookInput(input({ cover: { large: url } })), invalidInput)
  }
})

test("valida UUID y nombres de estanterías antes de llegar a la base", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000"
  assert.equal(parseUuid(id), id)
  for (const candidate of ["", "book-1", "' OR 1=1", null, 123]) assert.throws(() => parseUuid(candidate), invalidInput)
  assert.equal(parseShelfTitle("  Mi estantería  "), "Mi estantería")
  assert.throws(() => parseShelfTitle(" "), invalidInput)
  assert.throws(() => parseShelfTitle("x".repeat(121)), invalidInput)
})

test("conserva la procedencia de una ficha sin confundir ISBN bibliográfico con edición verificada", () => {
  const catalogue = { source: "photo", isbnVerified: false, sourceUrl: "https://openlibrary.org/books/OL1M" }
  assert.deepEqual(parseBookInput(input({ catalogue })).catalogue, catalogue)
  assert.deepEqual(parseBookInput(input({ catalogue: { source: "manual", isbnVerified: true } })).catalogue, { source: "manual", isbnVerified: true })
  assert.throws(() => parseBookInput(input({ catalogue: { source: "import", isbnVerified: false, sourceUrl: "javascript:alert(1)" } })), invalidInput)
})

test("las mutaciones conservan errores de dominio y ocultan errores técnicos", async (t) => {
  assert.equal(unwrapAction(await mutationResult(async () => 42)), 42)
  const expected = await mutationResult(async () => { throw new DomainError("CONFLICT", "El libro ya está en la biblioteca.") })
  assert.deepEqual(expected, { ok: false, error: { code: "CONFLICT", message: "El libro ya está en la biblioteca." } })
  assert.throws(() => unwrapAction(expected), (error: unknown) => error instanceof DomainError && error.code === "CONFLICT")
  const logs: string[] = []
  t.mock.method(console, "error", (entry: string) => { logs.push(entry) })
  const failure = await mutationResult(async () => { throw new Error("fixture-interna-no-publicar") })
  assert.deepEqual(failure, { ok: false, error: { code: "PROVIDER_UNAVAILABLE", message: "No se pudo guardar el cambio. Inténtalo de nuevo." } })
  assert.equal(logs.length, 1)
  assert.equal(logs[0].includes("fixture-interna"), false)
})

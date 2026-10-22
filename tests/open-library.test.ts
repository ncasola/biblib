import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_BOOK_COVER } from "../lib/book-covers"
import { DomainError } from "../lib/domain-errors"
import { createOpenLibraryClient, openLibraryHeaders } from "../lib/open-library"

function jsonFetch(payload: unknown, requests: Array<{ input: string; init?: RequestInit }> = []): typeof fetch {
  return async (input, init) => {
    requests.push({ input: String(input), init })
    return Response.json(payload)
  }
}

const isbn = "9788401337208"
const providerBook = { title: "El nombre del viento", authors: [{ name: "Patrick Rothfuss" }], number_of_pages: 872, publish_date: "2009" }

test("rechaza un ISBN incorrecto antes de consultar y normaliza ISBN-10 con x minúscula", async () => {
  const requests: Array<{ input: string }> = []
  const client = createOpenLibraryClient({ fetch: jsonFetch({}, requests) })
  for (const value of ["9788401337201", "no es isbn", "9788401337208<script>", ""]) {
    await assert.rejects(client.searchBookByISBN(value), (error: unknown) => error instanceof DomainError && error.code === "INVALID_INPUT")
  }
  assert.equal(requests.length, 0)
  assert.equal(await client.searchBookByISBN("0-8044-2957-x"), null)
  assert.equal(new URL(requests[0].input).searchParams.get("bibkeys"), "ISBN:9780804429573")
})

test("valida la ficha, completa portada parcial y conserva metadatos sin inventar páginas", async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = []
  const client = createOpenLibraryClient({ fetch: jsonFetch({ [`ISBN:${isbn}`]: { ...providerBook, url: "http://openlibrary.org/books/OL1M", subtitle: "Crónica del asesino de reyes", publishers: [{ name: "Plaza & Janés" }], cover: { large: "http://covers.openlibrary.org/b/id/1-L.jpg" } } }, requests), contact: "https://biblioteca.example/contacto" })
  const result = await client.searchBookByISBN("978-84-01-33720-8")
  assert.equal(result?.isbn, isbn)
  assert.equal(result?.title, providerBook.title)
  assert.equal(result?.number_of_pages, 872)
  assert.equal(result?.cover.small, "https://covers.openlibrary.org/b/id/1-L.jpg")
  assert.equal(result?.cover.medium, result?.cover.large)
  assert.deepEqual(result?.catalogue, { source: "open-library", isbnVerified: false, sourceUrl: "https://openlibrary.org/books/OL1M" })
  assert.equal(new Headers(requests[0].init?.headers).get("User-Agent"), "BibLib/1.0 (https://biblioteca.example/contacto)")
  assert.ok(requests[0].init?.signal instanceof AbortSignal)
  const minimal = await createOpenLibraryClient({ fetch: jsonFetch({ [`ISBN:${isbn}`]: { title: "Ficha sin datos adicionales" } }) }).searchBookByISBN(isbn)
  assert.deepEqual(minimal?.authors, [{ name: "Autor desconocido" }])
  assert.equal(minimal?.number_of_pages, 0)
  assert.equal(minimal?.cover.large, DEFAULT_BOOK_COVER)
})

test("solo una respuesta válida sin ficha significa libro no encontrado", async () => {
  assert.equal(await createOpenLibraryClient({ fetch: jsonFetch({}) }).searchBookByISBN(isbn), null)
  for (const payload of [null, [], { error: "Error del proveedor" }, { [`ISBN:${isbn}`]: null }, { [`ISBN:${isbn}`]: {} }, { [`ISBN:${isbn}`]: { title: "Título", number_of_pages: -1 } }]) {
    const client = createOpenLibraryClient({ fetch: jsonFetch(payload) })
    await assert.rejects(client.searchBookByISBN(isbn), (error: unknown) => error instanceof DomainError && error.code === "PROVIDER_UNAVAILABLE")
  }
})

test("distingue la cuota de una caída y no filtra errores de red o de JSON", async () => {
  const rateLimited = createOpenLibraryClient({ fetch: async () => new Response(null, { status: 429 }) })
  await assert.rejects(rateLimited.searchBookByISBN(isbn), (error: unknown) => error instanceof DomainError && error.code === "RATE_LIMITED")
  const providers: Array<typeof fetch> = [
    async () => new Response(null, { status: 503 }),
    async () => { throw new DOMException("Información interna del timeout", "TimeoutError") },
    async () => { throw new TypeError("Información interna de red") },
    async () => new Response("No es JSON"),
  ]
  for (const fetch of providers) {
    await assert.rejects(createOpenLibraryClient({ fetch }).searchBookByISBN(isbn), (error: unknown) => error instanceof DomainError && error.code === "PROVIDER_UNAVAILABLE" && !error.message.includes("Información interna"))
  }
})

test("comparte consultas simultáneas y entrega copias independientes de la ficha pública", async () => {
  let calls = 0
  const client = createOpenLibraryClient({ fetch: async () => { calls++; return Response.json({ [`ISBN:${isbn}`]: providerBook }) } })
  const [first, second] = await Promise.all([client.searchBookByISBN(isbn), client.searchBookByISBN("978-84-01-33720-8")])
  assert.equal(calls, 1)
  assert.ok(first && second)
  first.title = "Mi título modificado"
  first.authors[0].name = "Cambio local"
  assert.equal(second.title, providerBook.title)
  assert.equal((await client.searchBookByISBN(isbn))?.authors[0].name, "Patrick Rothfuss")
  assert.equal(calls, 1)
})

test("caduca la caché positiva y negativa sin almacenar errores del proveedor", async () => {
  let clock = 0
  let calls = 0
  const client = createOpenLibraryClient({ now: () => clock, wait: async (milliseconds) => { clock += milliseconds }, fetch: async () => { calls++; return Response.json(calls < 3 ? {} : { [`ISBN:${isbn}`]: providerBook }) } })
  await client.searchBookByISBN(isbn)
  await client.searchBookByISBN(isbn)
  assert.equal(calls, 1)
  clock += 5 * 60 * 1_000 + 1
  await client.searchBookByISBN(isbn)
  assert.equal(calls, 2)
  clock += 5 * 60 * 1_000 + 1
  await client.searchBookByISBN(isbn)
  clock += 60 * 60 * 1_000 + 1
  await client.searchBookByISBN(isbn)
  assert.equal(calls, 4)

  let failures = 0
  const failing = createOpenLibraryClient({ now: () => clock, wait: async (milliseconds) => { clock += milliseconds }, fetch: async () => { failures++; return new Response(null, { status: 503 }) } })
  await assert.rejects(failing.searchBookByISBN(isbn))
  await assert.rejects(failing.searchBookByISBN(isbn))
  assert.equal(failures, 2)
})

test("separa peticiones al menos un segundo y rechaza ráfagas sin crear una cola ilimitada", async () => {
  const starts: number[] = []
  const waits: number[] = []
  let clock = 0
  const client = createOpenLibraryClient({ now: () => clock, wait: async (milliseconds) => { waits.push(milliseconds); clock += milliseconds }, fetch: async () => { starts.push(clock); return Response.json({}) } })
  await client.searchBookByISBN(isbn)
  await client.searchBookByISBN("9788401339639")
  assert.deepEqual(starts, [0, 1_000])
  assert.deepEqual(waits, [1_000])

  const burst = createOpenLibraryClient({ now: () => 0, wait: async () => {}, fetch: jsonFetch({}) })
  const results = await Promise.allSettled([burst.searchBookByISBN(isbn), burst.searchBookByISBN("9788401339639"), burst.searchBookByISBN("9788401027055")])
  assert.equal(results[0].status, "fulfilled")
  assert.equal(results[1].status, "fulfilled")
  assert.equal(results[2].status, "rejected")
  if (results[2].status === "rejected") assert.equal((results[2].reason as DomainError).code, "RATE_LIMITED")
})

test("la caché está acotada a 500 fichas y no conserva indefinidamente la más antigua", async () => {
  let clock = 0
  let calls = 0
  const client = createOpenLibraryClient({ now: () => clock, fetch: async (input) => {
    calls++
    const key = new URL(String(input)).searchParams.get("bibkeys") ?? ""
    return Response.json({ [key]: providerBook })
  } })
  const identifiers = Array.from({ length: 501 }, (_, index) => {
    const prefix = String(978840133000 + index)
    const checksum = (10 - [...prefix].reduce((sum, digit, position) => sum + Number(digit) * (position % 2 ? 3 : 1), 0) % 10) % 10
    return `${prefix}${checksum}`
  })
  for (const identifier of identifiers) { clock += 1_000; await client.searchBookByISBN(identifier) }
  await client.searchBookByISBN(identifiers.at(-1)!)
  assert.equal(calls, 501)
  clock += 1_000
  await client.searchBookByISBN(identifiers[0])
  assert.equal(calls, 502)
})

test("la identificación usa BibLib y solo incluye el contacto configurado", () => {
  assert.equal(new Headers(openLibraryHeaders("")).get("User-Agent"), "BibLib/1.0")
  assert.equal(new Headers(openLibraryHeaders("contacto\r\nlocal")).get("User-Agent"), "BibLib/1.0 (contacto  local)")
})

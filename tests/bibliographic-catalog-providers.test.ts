import assert from "node:assert/strict"
import { test } from "node:test"
import { createConfiguredCatalog } from "../lib/bibliographic-catalog/registry"
import { readCatalogConfig } from "../lib/bibliographic-catalog/config"
import { candidateToLegacyBook } from "../lib/bibliographic-catalog/normalize"
import { createBibliographicCatalogService } from "../lib/bibliographic-catalog/orchestrator"
import { createOpenLibraryProvider } from "../lib/bibliographic-catalog/providers/open-library"
import { createOpenLibraryClient } from "../lib/open-library"
import { DEFAULT_BOOK_COVER } from "../lib/book-covers"
import { DomainError } from "../lib/domain-errors"
import { catalogResultError } from "../lib/bibliographic-catalog/action-result"
import { FIXTURE_UNAVAILABLE_ISBN } from "../lib/bibliographic-catalog/providers/fixture"

const isbn = "9780804429573"
const live = () => readCatalogConfig({ BIBLIB_TARGET: "test", BIBLIB_CATALOGUE_MODE: "live" })
const providerRecord = { title: "Ficha pública ficticia", authors: [{ name: "Autor ficticio" }], identifiers: { isbn_10: ["0-8044-2957-X"], openlibrary: ["OL1M"] }, url: "https://openlibrary.org/books/OL1M", cover: { large: "https://covers.openlibrary.org/b/id/1-L.jpg" } }

test("modo por defecto local/test fixture; prod/preprod rechazan fixture antes de crear servicio", () => {
  for (const target of ["local", "test"]) assert.equal(readCatalogConfig({ BIBLIB_TARGET: target }).mode, "fixture")
  for (const target of ["prod", "preprod"]) {
    assert.equal(readCatalogConfig({ BIBLIB_TARGET: target }).mode, "live")
    assert.throws(() => createConfiguredCatalog(readCatalogConfig({ BIBLIB_TARGET: target, BIBLIB_CATALOGUE_MODE: "fixture" })), DomainError)
  }
  assert.equal(readCatalogConfig({ NODE_ENV: "production" }).mode, "live")
  assert.throws(() => readCatalogConfig({ BIBLIB_TARGET: "otro" }), DomainError)
  assert.throws(() => readCatalogConfig({ BIBLIB_CATALOGUE_MODE: "otro" }), DomainError)
  assert.throws(() => readCatalogConfig({ BIBLIB_OPEN_LIBRARY_ENABLED: "yes" }), DomainError)
  assert.equal(readCatalogConfig({}).reviewEnabled, false)
})

test("fixture atiende JSON versionados sin tráfico externo aunque las banderas estén activas", async (t) => {
  let requests = 0
  t.mock.method(globalThis, "fetch", async () => { requests++; assert.fail("Fixture no puede llamar a Internet") })
  const config = readCatalogConfig({ BIBLIB_TARGET: "test", BIBLIB_BNE_ENABLED: "true", BIBLIB_GOOGLE_BOOKS_ENABLED: "true" })
  const service = createConfiguredCatalog(config)
  const found = await service.lookupISBN("978-0-0000-0001-9")
  assert.equal(found.status, "found")
  assert.equal(found.candidates[0].title, "La isla de papel")
  assert.equal(found.candidates[0].evidence.isbnExact, true)
  assert.equal((await service.lookupISBN("9780000000026")).candidates[0].title, "El reloj de las mareas")
  assert.equal((await service.getCover("9780000000019")).candidates.length, 0)
  assert.equal((await service.searchTitleAuthor({ title: "isla" })).status, "incomplete")
  assert.equal((await service.resolveEditions({ provider: "open-library", recordKind: "work", recordId: "OL1W" })).status, "incomplete")
  assert.equal(requests, 0)
})

test("fixture: ISBN nuevo encontrado y fallo reservado sin confundirse con notFound", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("Fixture no puede llamar a Internet"))
  const service = createConfiguredCatalog(readCatalogConfig({ BIBLIB_TARGET: "test" }))
  const found = await service.lookupISBN("978-0-00-000003-3")
  assert.equal(found.status, "found")
  assert.equal(found.candidates[0].title, "El faro de las palabras")
  const failing = await service.lookupISBN(FIXTURE_UNAVAILABLE_ISBN)
  assert.equal(failing.status, "incomplete")
  assert.equal(failing.providers[0].status, "unavailable")
  assert.equal(catalogResultError(failing)?.code, "PROVIDER_UNAVAILABLE")
})

test("fixture desconocido es notFound con la configuración predeterminada", async () => {
  const result = await createConfiguredCatalog(readCatalogConfig({ BIBLIB_TARGET: "test" })).lookupISBN(isbn)
  assert.equal(result.status, "notFound")
  assert.equal(result.complete, true)
})

test("desactivar OL evita sus consultas; BNE declara capacidades y Google permanece opcional", async () => {
  let requests = 0
  const config = readCatalogConfig({ BIBLIB_TARGET: "test", BIBLIB_CATALOGUE_MODE: "live", BIBLIB_OPEN_LIBRARY_ENABLED: "false", BIBLIB_BNE_ENABLED: "true", BIBLIB_GOOGLE_BOOKS_ENABLED: "true" })
  const service = createConfiguredCatalog(config, { fetch: async (input) => { requests++; assert.equal(new URL(String(input)).hostname, "catalogo.bne.es"); return new Response(null, { status: 503 }) } })
  const result = await service.lookupISBN(isbn)
  assert.equal(result.status, "incomplete")
  assert.deepEqual(result.providers.map((provider) => provider.status), ["disabled", "unavailable", "misconfigured"])
  assert.equal(service.capabilities().bne.lookupISBN, true)
  assert.equal(service.capabilities().bne.getCover, false)
  assert.equal(service.capabilities()["open-library"].lookupISBN, false)
  assert.equal(requests, 1)
  const keyed = createConfiguredCatalog(readCatalogConfig({ BIBLIB_TARGET: "test", BIBLIB_CATALOGUE_MODE: "live", BIBLIB_OPEN_LIBRARY_ENABLED: "false", BIBLIB_GOOGLE_BOOKS_ENABLED: "true", GOOGLE_BOOKS_API_KEY: "clave-sintetica" }))
  assert.equal((await keyed.lookupISBN(isbn)).providers[2].status, "notAttempted")
  assert.ok(!JSON.stringify(config).includes("clave-sintetica"))
})

test("adaptador OL conserva identificadores originales y valida coincidencia exacta", async () => {
  const requests: string[] = []
  const service = createConfiguredCatalog(live(), { fetch: async (input) => { requests.push(String(input)); return Response.json({ [`ISBN:${isbn}`]: providerRecord }) } })
  const result = await service.lookupISBN("0-8044-2957-X")
  assert.equal(new URL(requests[0]).searchParams.get("bibkeys"), `ISBN:${isbn}`)
  assert.deepEqual(result.candidates[0].isbns, ["0-8044-2957-X"])
  assert.equal(result.candidates[0].recordId, "OL1M")
  const mismatch = createConfiguredCatalog(live(), { fetch: async () => Response.json({ [`ISBN:${isbn}`]: { ...providerRecord, identifiers: { isbn_13: ["9788401337208"] } } }) })
  assert.equal((await mismatch.lookupISBN(isbn)).status, "notFound")
})

test("portada es operación separada con política y URL HTTPS; no inventa imagen", async () => {
  let requests = 0
  const service = createConfiguredCatalog(live(), { fetch: async () => { requests++; return Response.json({ [`ISBN:${isbn}`]: providerRecord }) } })
  const result = await service.getCover(isbn)
  assert.equal(result.status, "found")
  assert.equal(result.candidates[0].imageUrl, providerRecord.cover.large)
  assert.ok(result.candidates[0].rightsPolicyVersion)
  assert.ok(result.candidates[0].attribution)
  const metadata = await service.lookupISBN(isbn)
  const cachedMetadata = await service.lookupISBN(isbn)
  assert.equal(cachedMetadata.candidates[0].retrievedAt, metadata.candidates[0].retrievedAt)
  assert.equal(requests, 1)
  const legacy = candidateToLegacyBook(metadata.candidates[0], isbn, result.candidates[0].imageUrl)
  assert.equal(legacy.catalogue?.isbnVerified, false)
  assert.equal(legacy.cover.large, result.candidates[0].imageUrl)
  assert.equal(candidateToLegacyBook(metadata.candidates[0], isbn).cover.large, DEFAULT_BOOK_COVER)
  for (const cover of [undefined, { large: "http://otra-fuente.test/portada.jpg" }, { large: "https://persona:clave@otra-fuente.test/portada.jpg" }]) {
    const noCover = createConfiguredCatalog(live(), { fetch: async () => Response.json({ [`ISBN:${isbn}`]: { ...providerRecord, cover } }) })
    assert.equal((await noCover.getCover(isbn)).status, "notFound")
  }
})

test("fallos live 429/5xx/cuerpo inválido preservan incomplete y nunca notFound", async () => {
  for (const [response, status] of [[new Response(null, { status: 429 }), "rateLimited"], [new Response(null, { status: 503 }), "unavailable"], [new Response("JSON roto"), "unavailable"]] as const) {
    const result = await createConfiguredCatalog(live(), { fetch: async () => response }).lookupISBN(isbn)
    assert.equal(result.status, "incomplete")
    assert.equal(result.providers[0].status, status)
  }
})

test("cancelación llega al fetch OL y el plazo cancela antes de la siguiente fuente", async () => {
  let signal: AbortSignal | undefined
  const adapter = createOpenLibraryProvider({ fetch: async (_input, init) => {
    signal = init?.signal ?? undefined
    return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }))
  } })
  const service = createBibliographicCatalogService({ providers: [{ id: "open-library", enabled: true, adapter }] })
  const result = await service.lookupISBN(isbn, { timeoutMs: 10 })
  assert.equal(result.status, "incomplete")
  assert.equal(signal?.aborted, true)
})

test("cancelación en la cola del limitador OL impide una petición posterior", async () => {
  let requests = 0
  const client = createOpenLibraryClient({ fetch: async () => { requests++; return Response.json({}) } })
  await client.searchBookByISBN(isbn)
  const controller = new AbortController()
  const queued = client.searchBookByISBN("9788401337208", controller.signal)
  controller.abort()
  await assert.rejects(queued)
  assert.equal(requests, 1)
})

test("getCover tiene su propia cancelación y no transforma timeout en ausencia", async () => {
  let aborted = false
  const adapter = createOpenLibraryProvider({ fetch: async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; reject(init.signal?.reason) }, { once: true })
  }) })
  const service = createBibliographicCatalogService({ providers: [{ id: "open-library", enabled: true, adapter }] })
  const result = await service.getCover(isbn, { timeoutMs: 10 })
  assert.equal(result.status, "incomplete")
  assert.equal(result.complete, false)
  assert.equal(result.deadlineExceeded, true)
  assert.equal(aborted, true)
})

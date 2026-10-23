import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { createTitleAuthorActions, createSearchTokens } from "../lib/title-author-search"
import { createConfiguredCatalog } from "../lib/bibliographic-catalog/registry"
import { createBibliographicCatalogService } from "../lib/bibliographic-catalog/orchestrator"
import { readCatalogConfig } from "../lib/bibliographic-catalog/config"
import { createOpenLibraryProvider } from "../lib/bibliographic-catalog/providers/open-library"
import { createBneSruProvider } from "../lib/bibliographic-catalog/providers/bne-sru"
import { createCatalogGateway, type CatalogueKey, type CoordinationStore } from "../lib/bibliographic-catalog/gateway"
import { privateCacheKey } from "../lib/bibliographic-catalog/cache"
import { DomainError } from "../lib/domain-errors"
import type { BibliographicCandidate, BibliographicCatalogService, CatalogLookupResult, CatalogProvider } from "../lib/bibliographic-catalog/types"
import type { Book } from "../lib/types"
import searchFixture from "./fixtures/bibliography/title-author.json"
import editionFixture from "./fixtures/bibliography/title-author-editions.json"
import failures from "./fixtures/bibliography/title-author-failures.json"
import { createLatestBibliographyRequest, manualTitleAuthorDraft } from "../lib/title-author-search-request"
import { parseBookInput } from "../lib/book-validation"
import { exportLibraryBackup } from "../lib/library-export"
import { parseLibraryImport } from "../lib/library-import"

const ownerA = "11111111-1111-4111-8111-111111111111"
const ownerB = "22222222-2222-4222-8222-222222222222"
const secret = "secreto-sintetico-para-pruebas-titulo-autor"
const candidate = (overrides: Partial<BibliographicCandidate> = {}): BibliographicCandidate => ({ provider: "open-library", level: "work", recordId: "OL100W", title: "Árbol de la memoria", isbns: [], authors: [{ name: "María Núñez" }], publishers: [], retrievedAt: "2026-10-23T00:00:00.000Z", evidence: { isbnExact: false }, ...overrides })
const result = (candidates = [candidate()]): CatalogLookupResult<BibliographicCandidate> => ({ status: "found", candidates, providers: [{ provider: "open-library", status: "found", requestId: "r" }], complete: true, deadlineExceeded: false })
const catalog = (overrides: Partial<BibliographicCatalogService> = {}): BibliographicCatalogService => ({ capabilities: () => ({}), lookupISBN: async () => result(), getCover: async () => ({ ...result([]), candidates: [] }), searchTitleAuthor: async () => result(), resolveEditions: async () => result([candidate({ level: "edition", recordId: "OL200M" })]), ...overrides })
const actions = (service = catalog(), extra: Partial<Parameters<typeof createTitleAuthorActions>[0]> = {}) => createTitleAuthorActions({ catalog: service, authenticate: async () => ownerA, enabled: () => true, secret: () => secret, getTarget: async () => null, ...extra })
const request = { title: "Árbol", author: "María Núñez", page: 1, limit: 10 as const }
const context = () => ({ requestId: "prueba", signal: new AbortController().signal })

test("contrato autenticado: Unicode NFC, campos opcionales, límites y cero llamadas al rechazar", async () => {
  const calls: unknown[] = []
  const api = actions(catalog({ searchTitleAuthor: async (query, options) => { calls.push([query, options]); return result() } }), { maxPage: 2 })
  for (const input of [{ ...request, title: "?!", author: undefined }, { ...request, title: "a".repeat(301) }, { ...request, page: 3 }, { ...request, page: 1.5 }, { ...request, limit: 30 }, { ...request, language: "https://evil.test" }, { ...request, author: "\u0000autor" }, { ...request, user_id: ownerB }]) assert.equal((await api.search(input)).ok, false)
  assert.equal(calls.length, 0)
  const found = await api.search({ title: "A\u0301rbol", page: 2, limit: 20, language: "SPA" })
  assert.equal(found.ok, true)
  assert.deepEqual(calls[0], [{ title: "Árbol", page: 2, limit: 20, language: "spa" }, { userId: ownerA }])
  if (!found.ok) return
  assert.equal(found.value.results[0].level, "work")
  assert.ok(!JSON.stringify(found.value).includes(ownerA))
  assert.ok(!JSON.stringify(found.value).includes("user_id"))
  const unauthenticated = await actions(catalog(), { authenticate: async () => { throw new DomainError("UNAUTHORIZED", "Inicia sesión.") } }).search(request)
  assert.equal(unauthenticated.ok, false)
  if (!unauthenticated.ok) assert.equal(unauthenticated.error.code, "UNAUTHORIZED")
  assert.equal((await actions(catalog(), { enabled: () => false }).search(request)).ok, false)
  assert.equal((await actions(catalog(), { secret: () => undefined }).search(request)).ok, false)
})

test("paginación incluye consulta y tamaño en clave, nunca selecciona el primer candidato", async () => {
  const seen: string[] = []
  const adapter: CatalogProvider = { id: "open-library", capabilities: { lookupISBN: false, searchTitleAuthor: true, resolveEditions: false, getCover: false }, searchTitleAuthor: async (query, ctx) => ({ status: "found", provider: "open-library", requestId: ctx.requestId, value: Array.from({ length: query.limit ?? 10 }, (_, index) => candidate({ recordId: `OL${(query.page ?? 1) * 100 + index}W` })) }) }
  const service = createBibliographicCatalogService({ providers: [{ id: "open-library", enabled: true, adapter }], gateway: { execute: async (input, fetcher) => { seen.push(input.key); return fetcher() }, fetch, bind: () => fetch } })
  const api = actions(service, { maxPage: 2 })
  const first = await api.search(request)
  const second = await api.search({ ...request, page: 2 })
  assert.ok(first.ok && second.ok)
  if (!first.ok || !second.ok) return
  assert.equal(first.value.results.length, 10)
  assert.equal(first.value.nextPage, 2)
  assert.equal(second.value.nextPage, null)
  assert.notEqual(seen[0], seen[1])
  assert.notEqual(first.value.results[0].recordId, second.value.results[0].recordId)
})

test("claves por dueño y consulta: caducidad, manipulación, URL arbitraria y obra parcial", async () => {
  let clock = 0
  const api = actions(catalog(), { now: () => clock })
  const first = await api.search(request)
  const other = await api.search(request)
  assert.ok(first.ok && other.ok)
  if (!first.ok || !other.ok) return
  const workKey = first.value.results[0].candidateKey
  const input = { queryToken: first.value.queryToken, workKey, page: 1 }
  assert.equal((await api.editions(input)).ok, true)
  assert.equal((await api.editions({ ...input, queryToken: other.value.queryToken })).ok, false)
  assert.equal((await api.editions({ ...input, workKey: "https://evil.test/private" })).ok, false)
  assert.equal((await api.prepare({ candidateKey: `${workKey.slice(0, 40)}x${workKey.slice(41)}` })).ok, false)
  const otherUser = actions(catalog(), { authenticate: async () => ownerB, now: () => clock })
  assert.equal((await otherUser.editions(input)).ok, false)
  assert.equal((await otherUser.prepare({ candidateKey: workKey })).ok, false)
  clock = 15 * 60000
  assert.equal((await api.prepare({ candidateKey: workKey })).ok, false)
  const noId = await actions(catalog({ searchTitleAuthor: async () => result([candidate({ recordId: undefined, title: undefined, authors: [] })]) })).search(request)
  assert.ok(noId.ok)
  if (noId.ok) assert.equal((await actions().editions({ queryToken: noId.value.queryToken, workKey: noId.value.results[0].candidateKey, page: 1 })).ok, false)
})

test("homónimos y obra con ISBN no son coincidencia segura; edición parcial mantiene manual compatible", async () => {
  for (const entry of [candidate({ isbns: ["9788401337208"], evidence: { isbnExact: true } }), candidate({ level: "edition", recordId: "OL200M", title: undefined, authors: [], isbns: [] }), candidate({ level: "edition", recordId: "OL201M", isbns: ["9788401337208", "9780804429573"] })]) {
    const api = actions(catalog({ searchTitleAuthor: async () => result([entry]) }))
    const found = await api.search(request)
    assert.ok(found.ok)
    if (!found.ok) continue
    assert.equal(found.value.results[0].evidence.isbnExact, false)
    const prepared = await api.prepare({ candidateKey: found.value.results[0].candidateKey })
    assert.ok(prepared.ok)
    if (!prepared.ok) continue
    assert.equal(prepared.value.isbnVerified, false)
    assert.equal(prepared.value.provisional, true)
    assert.match(prepared.value.isbn, /^manual-[0-9a-f-]{36}$/)
  }
  const api = actions(catalog({ searchTitleAuthor: async () => result([candidate({ level: "edition", isbns: ["9788401337208"] })]) }))
  const found = await api.search(request)
  if (!found.ok) return assert.fail("sin candidato")
  const prepared = await api.prepare({ candidateKey: found.value.results[0].candidateKey })
  assert.ok(prepared.ok)
  if (prepared.ok) { assert.equal(prepared.value.isbn, "9788401337208"); assert.equal(prepared.value.isbnVerified, false) }
})

test("preparar enlace no escribe y exige propietario y versión actual", async () => {
  const version = randomUUID(), id = randomUUID()
  let target: Book | null = { id, version } as Book
  const api = actions(catalog(), { getTarget: async (requested) => { assert.equal(requested, id); return target } })
  const found = await api.search(request)
  if (!found.ok) return assert.fail("sin candidato")
  const candidateKey = found.value.results[0].candidateKey
  assert.equal((await api.prepare({ candidateKey, targetCopyId: id })).ok, false)
  assert.equal((await api.prepare({ candidateKey, targetCopyId: id, expectedVersion: randomUUID() })).ok, false)
  const prepared = await api.prepare({ candidateKey, targetCopyId: id, expectedVersion: version })
  assert.ok(prepared.ok)
  if (prepared.ok) assert.equal(prepared.value.expectedVersion, version)
  target = null
  const missing = await api.prepare({ candidateKey, targetCopyId: id, expectedVersion: version })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.error.code, "NOT_FOUND")
})

test("notFound, 429, timeout, red bloqueada y misconfigured permanecen separados con fixtures", async () => {
  for (const scenario of ["notFound", "rateLimited", "timeout", "blocked", "misconfigured"] as const) {
    let aborted = false
    const provider = createOpenLibraryProvider({ timeoutMs: failures.timeoutMs, fetch: async (_input, init) => {
      init?.signal?.addEventListener("abort", () => { aborted = true })
      if (scenario === "notFound") return Response.json({ docs: [] })
      if (scenario === "rateLimited") return new Response(null, { status: failures.rateLimited.status, headers: { "retry-after": failures.rateLimited.retryAfter } })
      if (scenario === "timeout") return new Promise(() => {})
      throw new Error(failures.blocked)
    } })
    const service = createBibliographicCatalogService({ providers: [{ id: "open-library", enabled: true, configured: scenario !== "misconfigured", adapter: provider }] })
    const response = await actions(service).search(request)
    assert.ok(response.ok)
    if (!response.ok) continue
    assert.equal(response.value.status, ["blocked", "timeout"].includes(scenario) ? "unavailable" : scenario)
    assert.equal(response.value.results.length, 0)
    if (scenario === "timeout") assert.equal(aborted, true)
    if (scenario === "rateLimited") assert.equal(response.value.providers[0].retryAfterSeconds, 12)
  }
})

test("OL pagina título/autor y ediciones parciales; BNE pagina SRU sin URLs del cliente", async () => {
  const urls: URL[] = []
  const provider = createOpenLibraryProvider({ wait: async () => {}, now: () => 1000, fetch: async (input) => { const url = new URL(String(input)); urls.push(url); return Response.json(url.pathname === "/search.json" ? searchFixture : editionFixture) } })
  const found = await provider.searchTitleAuthor!({ ...request, page: 3, limit: 20, language: "spa" }, context())
  assert.equal(found.status, "found")
  if (found.status === "found") assert.equal(found.value[2].title, undefined)
  assert.equal(urls[0].searchParams.get("page"), "3")
  assert.equal(urls[0].searchParams.get("limit"), "20")
  assert.equal(urls[0].searchParams.get("title"), "Árbol")
  assert.equal(urls[0].searchParams.get("q"), "language:spa")
  const editions = await provider.resolveEditions!({ provider: "open-library", recordKind: "work", recordId: "OL100W", page: 2, limit: 20 }, context())
  assert.equal(editions.status, "found")
  assert.equal(urls[1].searchParams.get("offset"), "20")
  const bne = createBneSruProvider({ fetch: async (input) => { const url = new URL(String(input)); assert.equal(url.searchParams.get("startRecord"), "41"); assert.equal(url.searchParams.get("maximumRecords"), "10"); return new Response(readFileSync("tests/fixtures/bibliography/bne/search-retrieve.xml", "utf8")) } })
  assert.equal((await bne.searchTitleAuthor!({ ...request, page: 3, limit: 20 }, context())).status, "found")
  const lastPage = createBneSruProvider({ fetch: async () => new Response('<searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/"><version>1.2</version><numberOfRecords>20</numberOfRecords></searchRetrieveResponse>') })
  assert.equal((await lastPage.searchTitleAuthor!({ ...request, page: 3, limit: 10 }, context())).status, "notFound", "una página pasada del total no es una caída")
})

test("fixture: búsqueda y ediciones cero fetch incluso con Google activo; resultados públicos equivalentes A/B", async (t) => {
  let requests = 0
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("Prohibida la red") })
  const service = createConfiguredCatalog(readCatalogConfig({ BIBLIB_TARGET: "test", BIBLIB_GOOGLE_BOOKS_ENABLED: "true", BIBLIB_BNE_ENABLED: "true" }))
  const a = actions(service), b = actions(service, { authenticate: async () => ownerB })
  const first = await a.search({ title: "Árbol", page: 1, limit: 10 })
  const second = await b.search({ title: "Árbol", page: 1, limit: 10 })
  assert.ok(first.ok && second.ok)
  if (!first.ok || !second.ok) return
  const publicData = (entries: typeof first.value.results) => entries.map((entry) => { const copy: Partial<typeof entry> = { ...entry }; delete copy.candidateKey; return copy })
  assert.deepEqual(publicData(first.value.results), publicData(second.value.results))
  assert.equal(first.value.results.length, 2, "homónimos separados")
  assert.notEqual(first.value.queryToken, second.value.queryToken)
  const loaded = await a.editions({ queryToken: first.value.queryToken, workKey: first.value.results[0].candidateKey, page: 1 })
  assert.ok(loaded.ok)
  if (loaded.ok) assert.equal(loaded.value.results.length, 3)
  assert.equal(requests, 0)
})

test("fallar OL no activa Google; BNE entrega veinte registros mediante dos páginas SRU acotadas", async () => {
  const service = createConfiguredCatalog(readCatalogConfig({ BIBLIB_TARGET: "test", BIBLIB_CATALOGUE_MODE: "live" }), { fetch: async (input) => {
    assert.equal(new URL(String(input)).hostname, "openlibrary.org")
    return new Response(null, { status: 429 })
  } })
  const response = await actions(service).search(request)
  assert.ok(response.ok)
  if (response.ok) assert.equal(response.value.providers.find((entry) => entry.provider === "google-books")?.status, "disabled")
  let clock = 0
  const starts: string[] = []
  const bne = createBneSruProvider({ now: () => clock, wait: async (ms) => { clock += ms }, fetch: async (input) => {
    const url = new URL(String(input)), start = Number(url.searchParams.get("startRecord"))
    starts.push(String(start))
    assert.equal(url.searchParams.get("maximumRecords"), "10")
    const records = Array.from({ length: 10 }, (_, index) => `<record><recordSchema>marcxml</recordSchema><recordPacking>xml</recordPacking><recordData><record xmlns="http://www.loc.gov/MARC21/slim"><controlfield tag="001">synthetic-${start + index}</controlfield></record></recordData><recordPosition>${start + index}</recordPosition></record>`).join("")
    return new Response(`<searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/"><version>1.2</version><numberOfRecords>40</numberOfRecords><records>${records}</records></searchRetrieveResponse>`)
  } })
  const found = await bne.searchTitleAuthor!({ ...request, page: 2, limit: 20 }, context())
  assert.equal(found.status, "found")
  if (found.status === "found") assert.equal(found.value.length, 20)
  assert.deepEqual(starts, ["21", "31"])
})

test("gateway guarda la misma consulta solo en caché privada HMAC por dueño", async () => {
  const privateEntries = new Map<string, { status: "found" | "notFound"; payload: unknown }>()
  const keys: CatalogueKey[] = []
  const store: CoordinationStore = {
    begin: async () => assert.fail("El texto no usa caché pública"), complete: async () => assert.fail("El texto no publica payload común"),
    reserve: async () => ({ state: "reserved", reservationId: randomUUID(), fence: "1", waitMs: 0 }), release: async () => true, invalidate: async () => 0,
    privateGet: async (owner, key) => { keys.push(key); return privateEntries.get(owner + key.key) ?? null },
    privatePut: async (owner, key, outcome) => { privateEntries.set(owner + key.key, { status: outcome.status, payload: outcome.payload }); return true },
  }
  const gateway = createCatalogGateway({ store, privateKeySecret: secret })
  let calls = 0
  const adapter: CatalogProvider = { id: "open-library", capabilities: { lookupISBN: false, searchTitleAuthor: true, resolveEditions: false, getCover: false }, searchTitleAuthor: async (_query, ctx) => { calls++; return { provider: "open-library", requestId: ctx.requestId, status: "found", value: [candidate()] } } }
  const service = createBibliographicCatalogService({ providers: [{ id: "open-library", enabled: true, adapter }], gateway })
  assert.equal((await actions(service).search(request)).ok, true)
  assert.equal((await actions(service).search(request)).ok, true)
  assert.equal(calls, 1)
  assert.equal((await actions(service, { authenticate: async () => ownerB }).search(request)).ok, true)
  assert.equal(calls, 2)
  assert.equal(privateEntries.size, 2)
  assert.ok(keys.every((key) => !key.key.includes("Árbol") && /^[a-f0-9]{64}$/.test(key.key)))
  assert.notEqual(privateCacheKey(secret, ownerA, "Árbol"), privateCacheKey(secret, ownerB, "Árbol"))
})

test("token cifrado no revela dueño, texto o candidatos y está autenticado", () => {
  const tokens = createSearchTokens(secret, ownerA, () => 0)
  const value = { version: 1 as const, kind: "query" as const, queryId: randomUUID(), limit: 10 as const, expires: 1000 }
  const token = tokens.seal(value)
  assert.deepEqual(tokens.open(token, "query"), value)
  assert.throws(() => createSearchTokens(secret, ownerB, () => 0).open(token, "query"))
  assert.ok(!Buffer.from(token, "base64url").toString().includes(ownerA))
})

test("respuesta tardía de búsqueda o ediciones no reemplaza la selección más reciente; cancelar la invalida", async () => {
  const latest = createLatestBibliographyRequest()
  let release!: (value: string) => void
  let selection = ""
  const older = latest.begin()
  const pending = new Promise<string>((resolve) => { release = resolve }).then((value) => { if (!older.signal.aborted) selection = value })
  const newer = latest.begin()
  assert.equal(older.signal.aborted, true)
  if (!newer.signal.aborted) selection = "Edición elegida después"
  release("Obra de una búsqueda anterior")
  await pending
  assert.equal(selection, "Edición elegida después")
  latest.cancel()
  assert.equal(newer.signal.aborted, true)
})

test("entrada manual conserva título y autor con tildes, manual compatible y exportación/importación", () => {
  const draft = manualTitleAuthorDraft("Árbol de la memoria", "María Núñez")
  assert.equal(draft.title, "Árbol de la memoria")
  assert.deepEqual(draft.authors, [{ name: "María Núñez" }])
  assert.match(draft.isbn, /^manual-[0-9a-f-]{36}$/)
  assert.equal(draft.catalogue?.isbnVerified, false)
  const parsed = parseBookInput(draft)
  assert.equal(parsed.isbn, draft.isbn)
  const shelfId = randomUUID()
  const data = { books: [{ ...draft, id: randomUUID(), shelf_id: shelfId, shelf_name: "Predeterminada" }], shelves: [{ id: shelfId, title: "Predeterminada", book_count: 1, isDefault: true }] }
  const backup = exportLibraryBackup(data)
  const restored = parseLibraryImport(backup.parts[0])
  assert.equal(restored.books[0].isbn, draft.isbn)
  assert.equal(restored.books[0].title, draft.title)
  assert.deepEqual(restored.books[0].authors, draft.authors)
})

import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { readCatalogConfig } from "../lib/bibliographic-catalog/config"
import { createConfiguredCatalog } from "../lib/bibliographic-catalog/registry"
import { createGoogleBooksProvider, redactGoogleBooksUrl, type GoogleBooksOptions } from "../lib/bibliographic-catalog/providers/google-books"
import { cachePlan } from "../lib/bibliographic-catalog/cache"
import { createCatalogGateway, type CoordinationStore, type CacheOutcome } from "../lib/bibliographic-catalog/gateway"
import { hasProviderRight, providerRightsPolicy } from "../lib/bibliographic-catalog/rights"
import { providerForUrl, providerQuotaPolicy } from "../lib/bibliographic-catalog/quota"
import { createLogger, type TelemetryRecord } from "../lib/observability/logger"
import type { ProviderContext } from "../lib/bibliographic-catalog/types"

const isbn = "9780804429573"
// Sintética, nunca se carga una credencial real ni se incorpora a fixtures.
const fakeKey = ["google", "only-for-tests", "sentinel-O09"].join("-")
const fixtures = "tests/fixtures/bibliography/google"
const volumes = JSON.parse(readFileSync(`${fixtures}/volumes.json`, "utf8"))
const context = (): ProviderContext => ({ requestId: "00000000-0000-4000-8000-000000000001", signal: new AbortController().signal })
const provider = (options: GoogleBooksOptions = {}) => createGoogleBooksProvider({ enabled: true, apiKey: fakeKey, fetch: async () => Response.json(volumes), ...options })

test("Google: ISBN exacto normalizado, varias ediciones separadas, originales y procedencia sin portada", async () => {
  let count = 0
  const result = await provider({ fetch: async (input, init) => {
    count++
    const url = new URL(String(input))
    assert.equal(url.origin + url.pathname, "https://www.googleapis.com/books/v1/volumes")
    assert.equal(url.searchParams.get("q"), `isbn:${isbn}`)
    assert.equal(url.searchParams.get("key"), fakeKey)
    assert.deepEqual([...url.searchParams.keys()].sort(), ["key", "maxResults", "q"])
    assert.equal(init?.cache, "no-store")
    assert.equal(init?.redirect, "error")
    assert.equal(init?.credentials, "omit")
    return Response.json(volumes)
  } }).lookupISBN!("0-8044-2957-X", context())
  assert.equal(count, 1)
  assert.equal(result.status, "found")
  if (result.status !== "found") return
  assert.deepEqual(result.value.map((item) => item.recordId), ["matching-ten", "matching-thirteen"])
  assert.deepEqual(result.value[0].isbns, ["0-8044-2957-X"])
  assert.equal(result.value[0].title, "Árboles de papel")
  assert.equal(result.value[0].publishDate, "2001-03")
  assert.equal(result.value[0].numberOfPages, 123)
  assert.equal(result.value[0].sourceUrl, "https://books.google.com/books?id=matching-ten")
  assert.ok(result.value.every((item) => item.evidence.isbnExact && !item.coverUrl && item.retrievedAt))
  assert.ok(!JSON.stringify(result).includes(fakeKey))
})

test("Google: ISBN distinto, ausente, inválido o tipo OTHER no certifican coincidencia", async () => {
  for (const industryIdentifiers of [undefined, [], [{ type: "ISBN_13", identifier: "9788401337208" }], [{ type: "OTHER", identifier: isbn }], [{ type: "ISBN_13", identifier: "9780804429574" }]]) {
    const result = await provider({ fetch: async () => Response.json({ totalItems: 1, items: [{ id: "no-match", volumeInfo: { title: "Árboles de papel", industryIdentifiers } }] }) }).lookupISBN!(isbn, context())
    assert.equal(result.status, "notFound")
  }
})

test("Google: ausencia válida, registro incompleto y schema inválido se distinguen", async () => {
  const empty = JSON.parse(readFileSync(`${fixtures}/empty.json`, "utf8"))
  assert.equal((await provider({ fetch: async () => Response.json(empty) }).lookupISBN!(isbn, context())).status, "notFound")
  for (const payload of [{ totalItems: 1 }, { totalItems: -1 }, { items: [] }, { totalItems: 1, items: [{ id: "../../bad", volumeInfo: {} }] }, { totalItems: 1, items: [{ id: "bad", volumeInfo: { pageCount: "many" } }] }]) {
    assert.equal((await provider({ fetch: async () => Response.json(payload) }).lookupISBN!(isbn, context())).status, "unavailable")
  }
  const incomplete = await provider({ fetch: async () => Response.json({ totalItems: 1, items: [{ id: "incomplete", volumeInfo: { industryIdentifiers: [{ type: "ISBN_13", identifier: isbn }] } }] }) }).lookupISBN!(isbn, context())
  assert.equal(incomplete.status, "found")
  if (incomplete.status === "found") { assert.equal(incomplete.value[0].title, undefined); assert.deepEqual(incomplete.value[0].authors, []) }
})

test("Google: búsquedas intitle/inauthor envían solo texto, sin inferir match ni resolver obras", async () => {
  let query = ""
  const adapter = provider({ fetch: async (url) => { query = new URL(String(url)).searchParams.get("q")!; return Response.json(volumes) } })
  const result = await adapter.searchTitleAuthor!({ title: "Árboles de papel", author: "Autora ficticia" }, context())
  assert.equal(query, 'intitle:"Árboles de papel" inauthor:"Autora ficticia"')
  assert.equal(adapter.capabilities.resolveEditions, false)
  assert.equal(result.status, "found")
  if (result.status === "found") assert.ok(result.value.every((item) => !item.evidence.isbnExact && !item.coverUrl))
})

test("Google: getCover solo preview HTTPS exacta y política sin retención, export, rehosting ni backup", async () => {
  const result = await provider().getCover!(isbn, context())
  assert.equal(result.status, "found")
  if (result.status === "found") {
    assert.equal(result.value.length, 1)
    assert.equal(result.value[0].imageUrl, "https://books.google.com/books/content?id=matching-ten&img=1&zoom=1")
    assert.equal(result.value[0].coverKey, "matching-ten")
  }
  const rights = providerRightsPolicy("google-books")
  assert.equal(hasProviderRight(rights, "previewCover"), true)
  for (const right of ["cacheMetadata", "persistMetadata", "exportMetadata", "rehostCover", "backupAsset", "offlineUse"] as const) assert.equal(hasProviderRight(rights, right), false)
  for (const operation of ["lookupISBN", "searchTitleAuthor", "getCover"] as const) assert.equal(cachePlan("google-books", operation), null)
})

test("Google: preview rechaza hosts y credenciales y retira tokens de terceros", async () => {
  for (const image of ["https://evil.test/cover.jpg", "https://books.google.com.evil.test/image", "https://user:pass@books.google.com/image", "javascript:alert(1)"]) {
    const payload = structuredClone(volumes)
    payload.items = [payload.items[1]]
    payload.items[0].volumeInfo.imageLinks.thumbnail = image
    assert.equal((await provider({ fetch: async () => Response.json(payload) }).getCover!(isbn, context())).status, "notFound")
  }
  const payload = structuredClone(volumes)
  payload.items[1].volumeInfo.imageLinks.thumbnail += "&key=untrusted&access_token=untrusted"
  const result = await provider({ fetch: async () => Response.json(payload) }).getCover!(isbn, context())
  if (result.status !== "found") assert.fail("Debe conservar la preview autorizada")
  assert.ok(!JSON.stringify(result).includes("untrusted"))
})

for (const status of [403, 429, 500, 503]) {
  test(`Google: HTTP ${status}, sin cuerpo externo ni reintentos`, async () => {
    let calls = 0
    const result = await provider({ fetch: async () => { calls++; return new Response(`error key=${fakeKey}`, { status, headers: { "Retry-After": "9" } }) } }).lookupISBN!(isbn, context())
    assert.equal(result.status, status === 429 ? "rateLimited" : "unavailable")
    if (result.status === "rateLimited") assert.equal(result.retryAfterSeconds, 9)
    assert.equal(calls, 1)
    assert.ok(!JSON.stringify(result).includes(fakeKey))
  })
}

test("Google: cooldown 429 y límite por instancia comparten todas las operaciones", async () => {
  let calls = 0
  const adapter = provider({ fetch: async () => { calls++; return new Response("", { status: 429, headers: { "Retry-After": "9" } }) } })
  await adapter.lookupISBN!(isbn, context())
  assert.equal((await adapter.searchTitleAuthor!({ title: "Otra consulta" }, context())).status, "rateLimited")
  assert.equal((await adapter.getCover!(isbn, context())).status, "rateLimited")
  assert.equal(calls, 1)
})

test("Google: deadline incluye fetch y cuerpo, cancelación e ISBN inválido sin red", async () => {
  let cancelled = false
  const slow = provider({ timeoutMs: 10, fetch: async (_url, init) => {
    init?.signal?.addEventListener("abort", () => { cancelled = true })
    return new Promise<Response>(() => {})
  } })
  assert.equal((await slow.lookupISBN!(isbn, context())).status, "unavailable")
  assert.equal(cancelled, true)
  const body = provider({ timeoutMs: 10, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true } })) })
  assert.equal((await body.lookupISBN!(isbn, context())).status, "unavailable")
  let calls = 0
  const adapter = provider({ fetch: async () => { calls++; throw new Error("No consultar") } })
  const controller = new AbortController()
  controller.abort()
  assert.equal((await adapter.lookupISBN!(isbn, { ...context(), signal: controller.signal })).status, "unavailable")
  assert.equal((await adapter.lookupISBN!("9780804429574", context())).status, "unavailable")
  assert.equal(calls, 0)
})

test("Google: límite de bytes declarado/real y JSON roto fallan cerrados", async () => {
  for (const response of [() => new Response("{}", { headers: { "content-length": "2000000" } }), () => new Response(" ".repeat(1_048_577)), () => new Response("{invalid")]) {
    assert.equal((await provider({ fetch: async () => response() }).lookupISBN!(isbn, context())).status, "unavailable")
  }
})

test("Google: apagado por defecto, sin clave y fixture nunca llaman fetch", async () => {
  let calls = 0
  const spy: typeof fetch = async () => { calls++; throw new Error("No debe consultar") }
  for (const config of [readCatalogConfig({ BIBLIB_TARGET: "test", BIBLIB_CATALOGUE_MODE: "live", BIBLIB_OPEN_LIBRARY_ENABLED: "false" }), readCatalogConfig({ BIBLIB_TARGET: "test", BIBLIB_CATALOGUE_MODE: "live", BIBLIB_OPEN_LIBRARY_ENABLED: "false", BIBLIB_GOOGLE_BOOKS_ENABLED: "true" })]) {
    const result = await createConfiguredCatalog(config, { fetch: spy }).lookupISBN(isbn)
    assert.equal(result.providers.find((item) => item.provider === "google-books")?.status, config.enabled["google-books"] ? "misconfigured" : "disabled")
    assert.ok(!JSON.stringify(config).includes(fakeKey))
  }
  const fixture = createConfiguredCatalog(readCatalogConfig({ BIBLIB_TARGET: "test", BIBLIB_GOOGLE_BOOKS_ENABLED: "true", BIBLIB_BNE_ENABLED: "true", GOOGLE_BOOKS_API_KEY: fakeKey }), { fetch: spy })
  await fixture.lookupISBN(isbn)
  await fixture.searchTitleAuthor({ title: "Una consulta" })
  await fixture.getCover(isbn)
  for (const options of [{ enabled: false }, { enabled: true, mode: "fixture" as const }, { apiKey: "" }]) {
    const adapter = provider({ ...options, fetch: spy })
    const expected = options.apiKey === "" ? "misconfigured" : "disabled"
    assert.equal((await adapter.lookupISBN!(isbn, context())).status, expected)
    assert.equal((await adapter.searchTitleAuthor!({ author: "Autora" }, context())).status, expected)
    assert.equal((await adapter.getCover!(isbn, context())).status, expected)
  }
  assert.equal(calls, 0)
})

test("Google: error fetch con URL/clave reflejados, logs y resultados no filtran secretos ni consultas", async (t) => {
  const logs: string[] = []
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(JSON.stringify(args)) })
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(JSON.stringify(args)) })
  const records: TelemetryRecord[] = []
  const telemetry = createLogger({ sink: (record) => records.push(record) })
  const descriptor = Object.getOwnPropertyDescriptor(process, "env")!
  t.after(() => Object.defineProperty(process, "env", descriptor))
  process.env = { NODE_ENV: "test", GOOGLE_BOOKS_API_KEY: fakeKey }
  const catalog = createConfiguredCatalog(readCatalogConfig({ BIBLIB_TARGET: "test", BIBLIB_CATALOGUE_MODE: "live", BIBLIB_OPEN_LIBRARY_ENABLED: "false", BIBLIB_GOOGLE_BOOKS_ENABLED: "true", GOOGLE_BOOKS_API_KEY: fakeKey }), {
    telemetry, fetch: async (url) => { throw new Error(`Fallo en ${url}`) },
  })
  const result = await catalog.lookupISBN(isbn)
  assert.equal(result.providers.find((item) => item.provider === "google-books")?.status, "unavailable")
  assert.ok(records.length > 0)
  const serialized = JSON.stringify({ result, records, logs, redacted: redactGoogleBooksUrl() })
  for (const privateValue of [fakeKey, encodeURIComponent(fakeKey), isbn, "?q=", "key="]) assert.ok(!serialized.includes(privateValue), "El diagnóstico debe excluir secretos y consultas")
  for (const reflected of [fakeKey, fakeKey.split("").map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")]) {
    const text = JSON.stringify(volumes).replace("Árboles de papel", reflected)
    assert.equal((await provider({ fetch: async () => new Response(text) }).lookupISBN!(isbn, context())).status, "unavailable")
  }
  for (const name of readdirSync(fixtures)) assert.ok(!readFileSync(`${fixtures}/${name}`, "utf8").includes(fakeKey))
})

test("Google: gateway reserva cuota y nunca guarda payload ni preview", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "env")!
  t.after(() => Object.defineProperty(process, "env", descriptor))
  process.env = { NODE_ENV: "test", GOOGLE_BOOKS_API_KEY: fakeKey }
  const calls = { reserve: 0, begin: 0, privateGet: 0, privatePut: 0, completions: [] as (CacheOutcome | undefined)[] }
  const store: CoordinationStore = {
    async begin(_key, options) { calls.begin++; assert.equal(options.useCache, false); return { state: "leased", fence: "1" } },
    async complete(_key, _fence, outcome) { calls.completions.push(outcome); return "released" },
    async reserve(request) { calls.reserve++; assert.equal(request.provider, "google-books"); assert.equal(request.intervalMs, 2000); return { state: "reserved", reservationId: "00000000-0000-4000-8000-000000000001", fence: "1", waitMs: 0 } },
    async release() { return true }, async invalidate() { return 0 },
    async privateGet() { calls.privateGet++; return null }, async privatePut() { calls.privatePut++; return false },
  }
  const config = readCatalogConfig({ BIBLIB_TARGET: "test", BIBLIB_CATALOGUE_MODE: "live", BIBLIB_OPEN_LIBRARY_ENABLED: "false", BIBLIB_GOOGLE_BOOKS_ENABLED: "true", GOOGLE_BOOKS_API_KEY: fakeKey })
  const gateway = createCatalogGateway({ store, fetch: async () => Response.json(volumes) })
  // Solo gateway: la registry debe utilizar su fetch, no saltárselo por falta de options.fetch.
  const result = await createConfiguredCatalog(config, { gateway }).lookupISBN(isbn)
  assert.equal(result.status, "found")
  assert.equal(calls.reserve, 1)
  assert.deepEqual(calls.completions, [undefined])
  const searched = await createConfiguredCatalog(config, { gateway }).searchTitleAuthor({ title: "Árboles" })
  assert.equal(searched.status, "found")
  assert.equal(calls.privateGet + calls.privatePut, 0)
  const preview = await createConfiguredCatalog(config, { gateway }).getCover(isbn)
  assert.equal(preview.status, "found")
  assert.ok(calls.completions.every((entry) => entry === undefined))
  assert.equal(providerForUrl(new URL("https://www.googleapis.com/books/v1/volumes")), "google-books")
  assert.equal(providerForUrl(new URL("https://evil.test/")), undefined)
  assert.equal(providerQuotaPolicy("google-books")?.ownerCap.interactive, 1)
})

test("Google: diagnóstico operador sin secretos ni red para disabled/misconfigured/ready/fixture", () => {
  for (const [flags, expected] of [
    [{}, "disabled"], [{ BIBLIB_GOOGLE_BOOKS_ENABLED: "true" }, "misconfigured"],
    [{ BIBLIB_GOOGLE_BOOKS_ENABLED: "true", GOOGLE_BOOKS_API_KEY: fakeKey }, "ready"],
    [{ BIBLIB_GOOGLE_BOOKS_ENABLED: "true", BIBLIB_CATALOGUE_MODE: "fixture" }, "fixture"],
  ] as const) {
    const result = spawnSync(process.execPath, ["scripts/catalogue-status.mjs"], { encoding: "utf8", env: { NODE_ENV: "test", BIBLIB_TARGET: "test", BIBLIB_CATALOGUE_MODE: "live", ...flags } })
    assert.equal(result.status, 0)
    assert.equal(JSON.parse(result.stdout).status, expected)
    assert.ok(!(result.stdout + result.stderr).includes(fakeKey))
  }
})

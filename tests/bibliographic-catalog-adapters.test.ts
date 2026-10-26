import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { createOpenLibraryProvider } from "../lib/bibliographic-catalog/providers/open-library"
import { bneTitleAuthorCql, createBneSruProvider } from "../lib/bibliographic-catalog/providers/bne-sru"
import { MAX_BNE_XML_BYTES, parseBneExplain, parseBneSearchRetrieve } from "../lib/bibliographic-catalog/marcxml"
import { createConfiguredCatalog } from "../lib/bibliographic-catalog/registry"
import { readCatalogConfig } from "../lib/bibliographic-catalog/config"
import { providerRightsPolicy, hasProviderRight } from "../lib/bibliographic-catalog/rights"
import type { ProviderContext } from "../lib/bibliographic-catalog/types"
import searchFixture from "./fixtures/bibliography/open-library/search.json"
import editionsFixture from "./fixtures/bibliography/open-library/editions.json"

const fixture = (name: string) => readFileSync(`tests/fixtures/bibliography/bne/${name}.xml`, "utf8")
const actual = fixture("search-retrieve")
const constructed = fixture("constructed")
const isbn = "9788401337208"
const context = (): ProviderContext => ({ requestId: "prueba", signal: new AbortController().signal })
const parseOptions = { retrievedAt: "2026-10-23T00:00:00.000Z" }
const empty = '<searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/"><version>1.2</version><numberOfRecords>0</numberOfRecords></searchRetrieveResponse>'
function clock() { let time = 0; return { now: () => time, wait: async (ms: number) => { time += ms }, advance: (ms: number) => { time += ms } } }

test("OL Search usa campos mínimos, texto con diacríticos y candidatos de obra sin ISBN inferido", async () => {
  const requests: URL[] = []
  const adapter = createOpenLibraryProvider({ fetch: async (input) => { requests.push(new URL(String(input))); return Response.json(searchFixture) } })
  const result = await adapter.searchTitleAuthor!({ title: "La música", author: "Rothfuss" }, context())
  assert.equal(result.status, "found")
  if (result.status !== "found") return
  assert.equal(requests[0].pathname, "/search.json")
  assert.equal(requests[0].searchParams.get("fields"), "key,title,author_name")
  assert.equal(requests[0].searchParams.get("title"), "La música")
  assert.equal(requests[0].searchParams.get("limit"), "10")
  assert.equal(result.value[0].level, "work")
  assert.equal(result.value[0].title, "La música del silencio")
  assert.deepEqual(result.value[0].isbns, [])
  assert.equal(result.value[1].authors.length, 0)
})

test("OL Work Editions JSON conserva varias ediciones ISBN-10/13 e incompletas sin N+1 de autores", async () => {
  const requests: string[] = []
  const adapter = createOpenLibraryProvider({ fetch: async (input) => { requests.push(String(input)); return Response.json(editionsFixture) } })
  const result = await adapter.resolveEditions!({ provider: "open-library", recordKind: "work", recordId: "OL1W" }, context())
  assert.equal(result.status, "found")
  if (result.status !== "found") return
  assert.equal(requests.length, 1)
  assert.equal(requests[0], "https://openlibrary.org/works/OL1W/editions.json?limit=10")
  assert.equal(result.value.length, 3)
  assert.deepEqual(result.value[1].isbns, ["0-8044-2957-X"])
  assert.equal(result.value[2].title, undefined)
  assert.equal(result.value[2].numberOfPages, undefined)
  assert.deepEqual(result.value[0].authors, [])
})

test("OL Edition JSON solo acepta el ID solicitado y mantiene una operación limitada", async () => {
  for (const [key, status] of [["/books/OL1M", "found"], ["/books/OL2M", "unavailable"]] as const) {
    const adapter = createOpenLibraryProvider({ fetch: async (input) => { assert.equal(String(input), "https://openlibrary.org/books/OL1M.json"); return Response.json({ key }) } })
    assert.equal((await adapter.resolveEditions!({ provider: "open-library", recordKind: "edition", recordId: "OL1M" }, context())).status, status)
  }
})

test("OL Search vacío, ediciones vacías, payload inválido y referencias peligrosas", async () => {
  assert.equal((await createOpenLibraryProvider({ fetch: async () => Response.json({ docs: [] }) }).searchTitleAuthor!({ title: "Ausente" }, context())).status, "notFound")
  assert.equal((await createOpenLibraryProvider({ fetch: async () => Response.json({ entries: [] }) }).resolveEditions!({ provider: "open-library", recordKind: "work", recordId: "OL1W" }, context())).status, "notFound")
  assert.equal((await createOpenLibraryProvider({ fetch: async () => Response.json({ docs: [{}] }) }).searchTitleAuthor!({ title: "Incompleto" }, context())).status, "unavailable")
  const adapter = createOpenLibraryProvider({ fetch: async () => { assert.fail("Referencia no permitida") } })
  assert.equal((await adapter.resolveEditions!({ provider: "open-library", recordKind: "work", recordId: "../secreto" }, context())).status, "unavailable")
})

test("OL 429 conserva Retry-After en segundos/fecha y bloquea nuevas operaciones durante el enfriamiento", async () => {
  for (const header of ["120", new Date(120000).toUTCString()]) {
    const timer = clock()
    let calls = 0
    const adapter = createOpenLibraryProvider({ ...timer, fetch: async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": header } }) } })
    const first = await adapter.lookupISBN!(isbn, context())
    assert.equal(first.status, "rateLimited")
    assert.equal(first.retryAfterSeconds, 120)
    assert.equal((await adapter.searchTitleAuthor!({ title: "Otra operación" }, context())).status, "rateLimited")
    assert.equal(calls, 1)
  }
})

test("OL Search y Editions respetan el mismo limitador, caché y fecha original", async () => {
  const timer = clock()
  const starts: number[] = []
  const adapter = createOpenLibraryProvider({ ...timer, fetch: async (input) => { starts.push(timer.now()); return Response.json(String(input).includes("search.json") ? searchFixture : editionsFixture) } })
  const first = await adapter.searchTitleAuthor!({ title: "Música" }, context())
  timer.advance(100)
  const cached = await adapter.searchTitleAuthor!({ title: "Música" }, context())
  await adapter.resolveEditions!({ provider: "open-library", recordKind: "work", recordId: "OL1W" }, context())
  assert.deepEqual(starts, [0, 1000])
  if (first.status === "found" && cached.status === "found") assert.equal(first.value[0].retrievedAt, cached.value[0].retrievedAt)
})

test("OL lookup nunca satisface un ISBN distinto, aunque coincida el título", async () => {
  const adapter = createOpenLibraryProvider({ fetch: async () => Response.json({ [`ISBN:${isbn}`]: { title: "Mismo título", identifiers: { isbn_13: ["9780804429573"] } } }) })
  assert.equal((await adapter.lookupISBN!(isbn, context())).status, "notFound")
})

test("OL timeout propio cancela fetch y cuerpo, y caché positiva no extiende su TTL al leer", async () => {
  for (const body of [false, true]) {
    let signal: AbortSignal | null | undefined
    const adapter = createOpenLibraryProvider({ timeoutMs: 10, fetch: async (_input, init) => { signal = init?.signal; return body ? new Response(new ReadableStream()) : new Promise(() => {}) } })
    assert.equal((await adapter.searchTitleAuthor!({ title: "Consulta" }, context())).status, "unavailable")
    assert.equal(signal?.aborted, true)
  }
  const timer = clock()
  let calls = 0
  const adapter = createOpenLibraryProvider({ ...timer, fetch: async () => { calls++; return Response.json(searchFixture) } })
  await adapter.searchTitleAuthor!({ title: "Música" }, context())
  timer.advance(3599000)
  await adapter.searchTitleAuthor!({ title: "Música" }, context())
  assert.equal(calls, 1)
  timer.advance(1001)
  await adapter.searchTitleAuthor!({ title: "Música" }, context())
  assert.equal(calls, 2)
})

test("BNE Explain real recortado confirma exclusivamente los tres índices usados", () => {
  assert.deepEqual(parseBneExplain(fixture("explain")).indexes.sort(), ["alma.creator", "alma.isbn", "alma.title"])
})

test("MARC real conserva campos atribuibles y excluye ISBN relacionados 776 y traductores/ilustradores", () => {
  const records = parseBneSearchRetrieve(actual, { ...parseOptions, isbn })
  assert.equal(records.length, 2)
  assert.equal(records[0].title, "La música del silencio")
  assert.equal(records[0].language, "spa")
  assert.equal(records[0].numberOfPages, 147)
  assert.deepEqual(records[0].authors, [{ name: "Rothfuss, Patrick", sourceUrl: undefined }])
  assert.equal(records[0].evidence.isbnExact, true)
  assert.equal(records[1].evidence.isbnExact, false)
  assert.equal(records[1].numberOfPages, undefined)
  assert.equal(records[1].publishDate, "2011")
  assert.equal(records[1].publishers[0].name, "Plaza & Janés")
  assert.equal(records[0].sourceUrl?.includes("docid=alma991049552139708606"), true)
  assert.ok(records.every((record) => record.coverUrl === undefined))
})

test("MARC prefijado ordena recordPosition y mapea 264, 008, subtítulo e ISBN-10 sin inventar ausencias", () => {
  const records = parseBneSearchRetrieve(constructed, parseOptions)
  assert.deepEqual(records.map((record) => record.recordId), ["synthetic-1", "synthetic-2"])
  assert.equal(records[0].title, "Música & poesía")
  assert.equal(records[0].subtitle, "una edición española")
  assert.equal(records[0].publishDate, "[2025]")
  assert.equal(records[0].publishers[0].name, "Editorial ficticia")
  assert.equal(records[0].language, "spa")
  assert.equal(records[0].numberOfPages, 234)
  assert.equal(records[0].authors.length, 2)
  assert.equal(records[1].title, undefined)
  assert.equal(records[1].language, undefined)
  assert.equal(records[1].numberOfPages, undefined)
  assert.deepEqual(records[1].isbns, ["0-8044-2957-X"])
  assert.equal(parseBneSearchRetrieve(constructed, { ...parseOptions, isbn: "9780804429573" })[1].evidence.isbnExact, true)
})

test("BNE SRU usa HTTPS fijo, SRU 1.2, máximo acotado y filtra solo 020 exacto", async () => {
  const adapter = createBneSruProvider({ maximumRecords: 20, fetch: async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin + url.pathname, "https://catalogo.bne.es/view/sru/34BNE_INST")
    assert.equal(url.searchParams.get("version"), "1.2")
    assert.equal(url.searchParams.get("query"), `alma.isbn="${isbn}"`)
    assert.equal(url.searchParams.get("maximumRecords"), "10")
    assert.equal(url.searchParams.get("recordSchema"), "marcxml")
    assert.equal(init?.redirect, "error")
    return new Response(actual)
  } })
  const result = await adapter.lookupISBN!(isbn, context())
  assert.equal(result.status, "found")
  if (result.status === "found") assert.equal(result.value.length, 1)
})

test("BNE CQL escapa comillas, barras y comodines sin aceptar índices arbitrarios", async () => {
  const query = { title: 'Música " or alma.isbn="*', author: "García\\López?" }
  const expected = 'alma.title="Música \\" or alma.isbn=\\"\\*" and alma.creator="García\\\\López\\?"'
  assert.equal(bneTitleAuthorCql(query), expected)
  const adapter = createBneSruProvider({ fetch: async (input) => { assert.equal(new URL(String(input)).searchParams.get("query"), expected); return new Response(empty) } })
  assert.equal((await adapter.searchTitleAuthor!(query, context())).status, "notFound")
  assert.throws(() => bneTitleAuthorCql({ title: "\u0000mal" }))
})

test("BNE endpoint configurable solo en test y nunca HTTP, credenciales ni fragmentos", () => {
  for (const endpoint of ["http://catalogo.bne.es/view/sru/34BNE_INST", "https://usuario:clave@catalogo.bne.es/sru", "https://catalogo.bne.es/sru#otro"]) assert.throws(() => createBneSruProvider({ endpoint, target: "test" }))
  assert.throws(() => createBneSruProvider({ endpoint: "https://otro.test/sru", target: "prod" }))
  assert.ok(createBneSruProvider({ endpoint: "https://fixture.test/sru", target: "test" }))
})

test("BNE Explain inyectado no acompaña automáticamente cada búsqueda", async () => {
  let calls = 0
  const adapter = createBneSruProvider({ fetch: async (input) => { calls++; assert.equal(new URL(String(input)).searchParams.get("operation"), "explain"); return new Response(fixture("explain")) } })
  assert.equal((await adapter.explain(context())).indexes.length, 3)
  assert.equal(calls, 1)
})

test("BNE caché conserva recuperación original, copias independientes, TTL y limitador por instancia", async () => {
  const timer = clock()
  let calls = 0
  const starts: number[] = []
  const adapter = createBneSruProvider({ ...timer, fetch: async () => { calls++; starts.push(timer.now()); return new Response(actual) } })
  const first = await adapter.lookupISBN!(isbn, context())
  timer.advance(100)
  const second = await adapter.lookupISBN!(isbn, context())
  if (first.status === "found" && second.status === "found") { first.value[0].title = "Cambio local"; assert.equal(second.value[0].title, "La música del silencio"); assert.equal(first.value[0].retrievedAt, second.value[0].retrievedAt) }
  assert.equal(calls, 1)
  await adapter.searchTitleAuthor!({ title: "Música" }, context())
  assert.deepEqual(starts, [0, 1000])
  timer.advance(3600001)
  await adapter.lookupISBN!(isbn, context())
  assert.equal(calls, 3)
})

test("BNE 429 respeta Retry-After y errores 5xx no se cachean", async () => {
  const timer = clock()
  let calls = 0
  const adapter = createBneSruProvider({ ...timer, fetch: async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": "60" } }) } })
  const first = await adapter.lookupISBN!(isbn, context())
  assert.equal(first.status, "rateLimited")
  assert.equal(first.retryAfterSeconds, 60)
  assert.equal((await adapter.searchTitleAuthor!({ author: "García" }, context())).status, "rateLimited")
  assert.equal(calls, 1)
  let failures = 0
  const failing = createBneSruProvider({ ...clock(), fetch: async () => { failures++; return new Response(null, { status: 503 }) } })
  assert.equal((await failing.lookupISBN!(isbn, context())).status, "unavailable")
  assert.equal((await failing.lookupISBN!(isbn, context())).status, "unavailable")
  assert.equal(failures, 2)
})

test("BNE sin resultado válido es notFound; XML roto o diagnóstico son unavailable", async () => {
  assert.equal((await createBneSruProvider({ fetch: async () => new Response(empty) }).lookupISBN!(isbn, context())).status, "notFound")
  for (const body of ["<roto>", empty.replace("<numberOfRecords>0</numberOfRecords>", ""), empty.replace("</searchRetrieveResponse>", '<diagnostics xmlns="http://www.loc.gov/zing/srw/diagnostic/"><diagnostic/></diagnostics></searchRetrieveResponse>')]) {
    assert.equal((await createBneSruProvider({ fetch: async () => new Response(body) }).lookupISBN!(isbn, context())).status, "unavailable")
  }
})

test("MARC rechaza DTD/XXE, entidades, XML roto, namespaces ajenos, profundidad y tamaño antes de mapear", () => {
  const attacks = [
    '<!DOCTYPE a SYSTEM "https://externo.test/xxe">' + empty,
    '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///secreto">]>' + empty,
    empty.replace("<version>1.2</version>", "<version>&xxe;</version>"),
    empty.replace("<version>1.2</version>", "<version>&#0;</version>"),
    empty.replace("http://www.loc.gov/zing/srw/", "https://namespace-desconocido.test/"),
    empty.replace("<version>", '<version xmlns:x="https://ajeno.test/">'),
    '<s xmlns="http://www.loc.gov/zing/srw/">' + "<a>".repeat(30) + "</a>".repeat(30) + "</s>",
    " ".repeat(MAX_BNE_XML_BYTES + 1) + empty,
    empty.replace("</version>", "</otro>"),
    constructed.replace("<s:recordPosition>2</s:recordPosition>", "<s:recordPosition>1</s:recordPosition>"),
    constructed.replace("<s:numberOfRecords>2", "<s:numberOfRecords>0"),
    constructed.replace('<m:controlfield tag="001">synthetic-2</m:controlfield>', ""),
    empty.replace("<version>1.2</version>", "<?externo href='https://otro.test'?><version>1.2</version>"),
  ]
  for (const attack of attacks) assert.throws(() => parseBneSearchRetrieve(attack, parseOptions))
})

test("BNE limita bytes declarados y en stream, contando UTF-8 y cancelando el cuerpo", async () => {
  for (const headers of [new Headers({ "content-length": "999999" }), new Headers()]) {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("á".repeat(100))); }, cancel() { cancelled = true } })
    const adapter = createBneSruProvider({ maxResponseBytes: 100, fetch: async () => new Response(stream, { headers }) })
    assert.equal((await adapter.lookupISBN!(isbn, context())).status, "unavailable")
    assert.equal(cancelled, true)
  }
  const adapter = createBneSruProvider({ maximumRecords: 1, fetch: async () => new Response(actual) })
  assert.equal((await adapter.lookupISBN!(isbn, context())).status, "unavailable")
})

test("BNE timeout propio alcanza fetch no cooperativo y cuerpo bloqueado", async () => {
  for (const body of [false, true]) {
    let signal: AbortSignal | null | undefined
    const adapter = createBneSruProvider({ timeoutMs: 10, fetch: async (_input, init) => { signal = init?.signal; return body ? new Response(new ReadableStream()) : new Promise(() => {}) } })
    assert.equal((await adapter.lookupISBN!(isbn, context())).status, "unavailable")
    assert.equal(signal?.aborted, true)
  }
})

test("BNE cancelación en la cola impide fetch posterior y caché negativa caduca", async () => {
  let requests = 0
  const adapter = createBneSruProvider({ fetch: async () => { requests++; return new Response(empty) } })
  await adapter.lookupISBN!(isbn, context())
  const controller = new AbortController()
  const queued = adapter.searchTitleAuthor!({ title: "Otra consulta" }, { requestId: "cancelada", signal: controller.signal })
  controller.abort()
  assert.equal((await queued).status, "unavailable")
  assert.equal(requests, 1)
  const timer = clock()
  let calls = 0
  const cached = createBneSruProvider({ ...timer, fetch: async () => { calls++; return new Response(empty) } })
  await cached.lookupISBN!(isbn, context())
  await cached.lookupISBN!(isbn, context())
  assert.equal(calls, 1)
  timer.advance(300001)
  await cached.lookupISBN!(isbn, context())
  assert.equal(calls, 2)
  let mismatches = 0
  const mismatching = createBneSruProvider({ ...timer, fetch: async () => { mismatches++; return new Response(actual.replace('978-84-01-33720-8</subfield>', '9780804429573</subfield>')) } })
  assert.equal((await mismatching.lookupISBN!(isbn, context())).status, "notFound")
  timer.advance(300001)
  await mismatching.lookupISBN!(isbn, context())
  assert.equal(mismatches, 2)
})

test("BNE Retry-After fecha HTTP bloquea consultas y XML con declaración de entidad no sale a red", async () => {
  const timer = clock()
  const limited = createBneSruProvider({ ...timer, fetch: async () => new Response(null, { status: 429, headers: { "retry-after": new Date(90000).toUTCString() } }) })
  const result = await limited.lookupISBN!(isbn, context())
  assert.equal(result.status, "rateLimited")
  assert.equal(result.retryAfterSeconds, 90)
  let calls = 0
  const malicious = createBneSruProvider({ fetch: async () => { calls++; return new Response('<!DOCTYPE a [<!ENTITY xxe SYSTEM "https://externo.test/">]>' + empty) } })
  assert.equal((await malicious.lookupISBN!(isbn, context())).status, "unavailable")
  assert.equal(calls, 1)
})

test("OL found y BNE timeout conservan found con complete false; apagar BNE mantiene OL", async () => {
  for (const enabled of [true, false]) {
    let bneCalls = 0
    const config = readCatalogConfig({ BIBLIB_TARGET: "test", BIBLIB_CATALOGUE_MODE: "live", BIBLIB_BNE_ENABLED: String(enabled) })
    const service = createConfiguredCatalog(config, { fetch: async (input) => {
      if (new URL(String(input)).hostname === "openlibrary.org") return Response.json({ [`ISBN:${isbn}`]: { title: "Ficha OL" } })
      bneCalls++
      return new Promise(() => {})
    } })
    const result = await service.lookupISBN(isbn, { providerTimeoutMs: 20 })
    assert.equal(result.status, "found")
    assert.equal(result.complete, !enabled)
    assert.equal(bneCalls, enabled ? 1 : 0)
    assert.deepEqual(result.providers.slice(0, 2).map((provider) => provider.provider), ["open-library", "bne"])
  }
})

test("derechos BNE permiten solo metadatos CC0 con procedencia y nunca portadas", () => {
  const policy = providerRightsPolicy("bne")
  for (const right of ["cacheMetadata", "persistMetadata", "exportMetadata"] as const) assert.equal(hasProviderRight(policy, right), true)
  for (const right of ["previewCover", "rehostCover", "backupAsset", "offlineUse"] as const) assert.equal(hasProviderRight(policy, right), false)
  assert.match(policy.attribution, /CC0/)
  assert.equal(createBneSruProvider().capabilities.getCover, false)
})

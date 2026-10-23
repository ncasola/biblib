import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { DEFAULT_BOOK_COVER } from "../lib/book-covers"
import { createCatalogGateway, type CatalogGateway } from "../lib/bibliographic-catalog/gateway"
import { readCatalogConfig } from "../lib/bibliographic-catalog/config"
import { createBibliographicCatalogService } from "../lib/bibliographic-catalog/orchestrator"
import { createOpenLibraryProvider } from "../lib/bibliographic-catalog/providers/open-library"
import { createConfiguredCatalog } from "../lib/bibliographic-catalog/registry"
import { providerRightsPolicy } from "../lib/bibliographic-catalog/rights"
import type { BibliographicCandidate, CatalogProvider, CoverCandidate, ProviderId, ProviderRegistration, ProviderResult, ProviderStatus } from "../lib/bibliographic-catalog/types"
import { EMPTY_COUNTS, countsFromItems, decideControl, isTerminal, type JobCounts, type JobControl, type JobItemState, type JobState } from "../lib/jobs/contracts"
import type { DatabaseTransaction } from "../lib/db/client"
import { createLogger, type TelemetryRecord } from "../lib/observability/logger"
import { normalizeIsbn } from "../lib/isbn"
import { runJobStep } from "../lib/jobs/worker"
import type { ClaimedJob, FencedContext, FinishUpdate, ItemUpdate, JobRepository, RecoveredCover } from "../lib/jobs/repository"
import type { Book } from "../lib/types"
import { fakeSleep, memoryStore } from "./support/catalogue-memory-store"

// U-BIB-05 · Los flujos de importación y recuperación sobre el servicio real (orquestador, adaptador
// Open Library y gateway con cuota/caché sobre un store en memoria) y una red simulada. Sin Docker
// ni Internet; la base real y el worker contra Postgres están en tests/integration.

const START = Date.parse("2026-10-23T10:00:00Z")
const OWNER = "00000000-0000-4000-8000-00000000000a"
const SECRET_KEY = "AIzaSy-clave-sintetica-NO-REAL-0123456789"
const SECRET_QUERY = "consulta-privada-sentinela"

/** ISBN-13 válidos y distintos para la simulación. */
function isbns(count: number, prefix = 978840133700): string[] {
  return Array.from({ length: count }, (_, index) => {
    const base = String(prefix + index)
    const sum = [...base].reduce((total, digit, position) => total + Number(digit) * (position % 2 ? 3 : 1), 0)
    return `${base}${(10 - sum % 10) % 10}`
  })
}

type Behaviour = "found" | "empty" | { status: 429; retryAfter: number } | { status: 503 }

interface NetworkEntry { host: string; path: string; isbn?: string; at: number; status: number }

/** Red simulada: registra cada petición, la concurrencia máxima y responde según un guion por ISBN. */
function simulatedNetwork(clock: { now: number }, behave: (isbn: string, attempt: number) => Behaviour = () => "found") {
  const log: NetworkEntry[] = []
  const attempts = new Map<string, number>()
  let inFlight = 0
  let maxInFlight = 0
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await Promise.resolve()
    try {
      const isbn = url.searchParams.get("bibkeys")?.replace("ISBN:", "")
      const attempt = (attempts.get(isbn ?? url.href) ?? 0) + 1
      attempts.set(isbn ?? url.href, attempt)
      const outcome: Behaviour = isbn ? behave(isbn, attempt) : "empty"
      const record = (status: number) => log.push({ host: url.hostname, path: url.pathname, isbn, at: clock.now, status })
      if (typeof outcome === "object" && outcome.status === 429) { record(429); return new Response(null, { status: 429, headers: { "Retry-After": String(outcome.retryAfter) } }) }
      if (typeof outcome === "object") { record(503); return new Response(null, { status: 503 }) }
      record(200)
      if (outcome === "empty" || !isbn) return Response.json({})
      return Response.json({ [`ISBN:${isbn}`]: { title: `Libro ${isbn}`, url: `http://openlibrary.example/books/${isbn}`, cover: { large: `https://covers.invalid/b/id/${isbn.slice(-6)}-L.jpg` }, identifiers: { isbn_13: [isbn] } } })
    } finally { inFlight-- }
  }
  return { fetch: fetchImpl, log, get maxInFlight() { return maxInFlight } }
}

/** Servicio con adaptador OL real y gateway sobre el store; `purpose` lo fija quien llama (lote en los trabajos). */
function liveService(options: { clock: { now: number }; store: ReturnType<typeof memoryStore>["store"]; fetch: typeof fetch; purpose?: "batch" | "interactive"; telemetry?: ReturnType<typeof createLogger>; secret?: string }) {
  const gateway = createCatalogGateway({ store: options.store, fetch: options.fetch, sleep: fakeSleep(options.clock), telemetry: options.telemetry, privateKeySecret: options.secret })
  const bound: CatalogGateway = options.purpose === "batch"
    ? { ...gateway, execute: (request, fetcher, context) => gateway.execute({ ...request, purpose: "batch" }, fetcher, context) } : gateway
  const adapter = createOpenLibraryProvider({ fetch: gateway.fetch, now: () => options.clock.now, wait: fakeSleep(options.clock), telemetry: options.telemetry })
  return createBibliographicCatalogService({ providers: [{ id: "open-library", enabled: true, adapter }], gateway: bound, telemetry: options.telemetry })
}

/** Repositorio en memoria con el contrato del ejecutor: elementos, lease, cuota de pasos y control. */
interface FakeBook { id: string; isbn: string; version: string; cover: Book["cover"]; source?: ProviderId }

function statefulJobs(books: Map<string, FakeBook>, clock: { now: number }) {
  const items = new Map<string, { state: JobItemState; attempts: number; nextAt: number; result: Record<string, unknown> | null; errorCode: string | null }>()
  for (const key of [...books.keys()].sort()) items.set(key, { state: "pending", attempts: 0, nextAt: clock.now, result: null, errorCode: null })
  const job = { state: "queued" as JobState, nextAt: clock.now, cursor: "" as string | null, counts: { ...EMPTY_COUNTS, total: items.size } as JobCounts }
  const steps: { updates: number; at: number }[] = []
  const due = () => [...items].filter(([, item]) => ["pending", "waiting_retry"].includes(item.state) && item.nextAt <= clock.now)
  const claimed = (): ClaimedJob => ({ id: "job", leaseToken: "t", fencing: "1", userId: OWNER, kind: "covers", phase: "covers", previewId: null, expectedRevision: null,
    idempotencyKey: "k".repeat(16), cursor: job.cursor, counts: job.counts, published: false, attempts: 1 })
  const fakeTransaction = { execute: async () => [{ revision: "1" }] } as unknown as DatabaseTransaction
  const applyCovers = async (_tx: DatabaseTransaction, _owner: string, recovered: RecoveredCover[]) => {
    const applied = new Set<string>()
    for (const entry of recovered) {
      const book = books.get(entry.id)
      if (book && book.version === entry.version && book.cover.large === DEFAULT_BOOK_COVER) { book.cover = entry.cover; book.source = entry.provider; applied.add(entry.id) }
    }
    return applied
  }
  const repo = {
    async claim() {
      if (!["queued", "running", "waiting_retry"].includes(job.state) || job.nextAt > clock.now) return null
      job.state = "running"
      return claimed()
    },
    async renew() { return true },
    async fenced<T>(_lease: unknown, work: (context: FencedContext) => Promise<T>) {
      let updated = 0
      const context = {
        owner: OWNER, tx: fakeTransaction,
        asOwner: async <R>(inner: (tx: DatabaseTransaction) => Promise<R>) => inner(fakeTransaction),
        seedCoverItems: async () => 0,
        async updateItems(updates: ItemUpdate[]) {
          updated += updates.length
          for (const update of updates) {
            const item = items.get(update.itemKey)
            if (!item || !["pending", "waiting_retry"].includes(item.state)) continue
            Object.assign(item, { state: update.state, attempts: item.attempts + (update.attempt ? 1 : 0), nextAt: clock.now + update.delayMs, result: update.result ?? null, errorCode: update.errorCode ?? null })
          }
        },
        async recount() {
          const grouped = new Map<JobItemState, number>()
          for (const item of items.values()) grouped.set(item.state, (grouped.get(item.state) ?? 0) + 1)
          return { counts: countsFromItems([...grouped].map(([state, n]) => ({ state, n }))), pendingDue: due().length }
        },
        async finish(update: FinishUpdate) {
          job.state = update.state
          if (update.cursor !== undefined) job.cursor = update.cursor
          if (update.counts) job.counts = update.counts
          const upcoming = [...items.values()].filter((item) => ["pending", "waiting_retry"].includes(item.state)).map((item) => item.nextAt)
          job.nextAt = update.state === "waiting_retry" ? Math.max(clock.now + (update.delayMs ?? 0), Math.min(...upcoming, Infinity)) : clock.now
        },
      } satisfies FencedContext
      const value = await work(context)
      steps.push({ updates: updated, at: clock.now })
      return value
    },
    async dueItems(_job: unknown, limit: number) { return due().slice(0, limit).map(([itemKey, item]) => ({ itemKey, state: item.state, targetVersion: books.get(itemKey)?.version ?? null, attempts: item.attempts })) },
    async coverSnapshots() { return new Map([...books].map(([key, book]) => [key, { id: book.id, isbn: book.isbn, version: book.version, cover: { ...book.cover } }])) },
    async read() { return null },
  } satisfies JobRepository
  return {
    repo, job, items, steps, applyCovers,
    control(action: JobControl) { const decision = decideControl(job.state, action); if (decision.kind === "apply") { job.state = decision.to; job.nextAt = clock.now } return decision.kind },
  }
}

function booksFor(isbnList: string[]): Map<string, FakeBook> {
  return new Map(isbnList.map((isbn, index): [string, FakeBook] => {
    const id = `b${String(index).padStart(3, "0")}`
    return [id, { id, isbn, version: `v${index}`, cover: { small: DEFAULT_BOOK_COVER, medium: DEFAULT_BOOK_COVER, large: DEFAULT_BOOK_COVER } }]
  }))
}

describe("recuperación e importación acotadas y reanudables", () => {
  test("pasos de hasta 20 libros, una sola petición a la vez, 429 detiene el lote y la reanudación no repite lo terminado", async () => {
    const clock = { now: START }
    const list = isbns(45)
    const throttled = list[25]
    const flaky = list[33]
    const network = simulatedNetwork(clock, (isbn, attempt) => {
      if (isbn === throttled && attempt === 1) return { status: 429, retryAfter: 40 }
      if (isbn === flaky && attempt === 1) return { status: 503 }
      return list.indexOf(isbn) % 3 === 2 ? "empty" : "found"
    })
    const { store } = memoryStore(clock)
    const records: TelemetryRecord[] = []
    const telemetry = createLogger({ sink: (record) => records.push(record) })
    const catalog = liveService({ clock, store, fetch: network.fetch, purpose: "batch", telemetry })
    const books = booksFor(list)
    const jobs = statefulJobs(books, clock)
    const deps = { repo: jobs.repo, catalog, telemetry, now: () => clock.now, random: () => 0, applyCovers: jobs.applyCovers }

    const cooldowns: { from: number; until: number }[] = []
    for (let guard = 0; guard < 40 && !isTerminal(jobs.job.state); guard++) {
      const requestsBefore = network.log.length
      const report = await runJobStep(deps)
      if (!report) { clock.now = Math.max(clock.now + 1_000, jobs.job.nextAt); continue }
      for (const entry of network.log.slice(requestsBefore)) if (entry.status === 429) cooldowns.push({ from: entry.at, until: entry.at + 40_000 })
    }

    assert.ok(isTerminal(jobs.job.state), `el trabajo termina (estado ${jobs.job.state})`)
    assert.ok(jobs.steps.length >= 3, "el trabajo se reparte en varios pasos")
    assert.ok(jobs.steps.every((step) => step.updates <= 20), "ningún paso confirma más de 20 elementos")
    assert.equal(network.maxInFlight, 1, "nunca hay dos peticiones a la vez")
    assert.ok(network.log.every((entry) => entry.host === "openlibrary.org"), "solo Open Library, a través del adaptador")
    // Cada ISBN se consulta una vez; solo el 429 y el 503 se repiten, tras su espera.
    const byIsbn = new Map<string, number>()
    for (const entry of network.log) byIsbn.set(entry.isbn ?? "", (byIsbn.get(entry.isbn ?? "") ?? 0) + 1)
    assert.deepEqual([...byIsbn].filter(([, n]) => n > 1).map(([isbn, n]) => [isbn, n]).sort(), [[flaky, 2], [throttled, 2]].sort())
    assert.equal(network.log.length, 47)
    // El Retry-After del 429 se respeta: ninguna petición cae dentro de la espera.
    assert.equal(cooldowns.length, 1)
    assert.ok(network.log.every((entry) => entry.at <= cooldowns[0].from || entry.at >= cooldowns[0].until), "sin peticiones durante el Retry-After")
    // El adaptador y el gateway separan las peticiones al menos un segundo (límite de Open Library).
    assert.ok(network.log.every((entry, index) => index === 0 || entry.at - network.log[index - 1].at >= 1_000 || entry.status === 429 || network.log[index - 1].status === 429))

    const expectedFound = list.filter((_, index) => index % 3 !== 2).length
    const finished = [...jobs.items.values()]
    assert.equal(finished.filter((item) => item.state === "succeeded").length, expectedFound)
    assert.equal(finished.filter((item) => item.state === "not_found").length, list.length - expectedFound)
    assert.ok(finished.filter((item) => item.state === "succeeded").every((item) => (item.result as { provider?: string }).provider === "open-library"), "la fuente de cada portada consta en su elemento")
    assert.equal([...books.values()].filter((book) => book.cover.large !== DEFAULT_BOOK_COVER).length, expectedFound)
    assert.ok([...books.values()].filter((book) => book.cover.large !== DEFAULT_BOOK_COVER).every((book) => book.source === "open-library"))
    // Contadores por proveedor para el operador, sin ISBN ni títulos.
    const sources = records.filter((record) => record.event === "cover.recovery" && record.fields.operation === "cover.source")
    assert.equal(sources.reduce((total, record) => total + Number(record.fields.batch), 0), expectedFound)
    assert.ok(sources.every((record) => record.fields.provider === "open-library" && record.fields.result === "recovered"))
    assert.ok(!JSON.stringify(records).includes(list[0]))
  })

  test("pausar impide nuevas peticiones y reanudar continúa sin repetir los libros ya revisados", async () => {
    const clock = { now: START }
    const list = isbns(6, 978840133800)
    const network = simulatedNetwork(clock)
    const catalog = liveService({ clock, store: memoryStore(clock).store, fetch: network.fetch, purpose: "batch" })
    const jobs = statefulJobs(booksFor(list), clock)
    const deps = { repo: jobs.repo, catalog, now: () => clock.now, random: () => 0, applyCovers: jobs.applyCovers, limits: { maxItemsPerStep: 2 } }

    assert.equal((await runJobStep(deps))?.outcome, "progressed")
    assert.equal(network.log.length, 2, "un paso consulta como mucho los elementos de su tope")
    assert.equal(jobs.control("pause"), "apply")
    assert.equal(jobs.job.state, "paused")
    assert.equal(await runJobStep(deps), null, "en pausa nadie reclama el trabajo")
    assert.equal(network.log.length, 2)
    assert.equal(jobs.control("resume"), "apply")
    for (let guard = 0; guard < 10 && !isTerminal(jobs.job.state); guard++) await runJobStep(deps)
    assert.equal(jobs.job.state, "succeeded")
    assert.deepEqual(network.log.map((entry) => entry.isbn), list, "cada ISBN, una vez y en orden")
    assert.equal(jobs.control("cancel"), "conflict", "un trabajo terminado no se cancela")
  })

  test("un libro cambiado durante la búsqueda conserva su portada y el trabajo sigue sin consultar su ISBN", async () => {
    const clock = { now: START }
    const list = isbns(3, 978840133900)
    const network = simulatedNetwork(clock)
    const books = booksFor(list)
    const jobs = statefulJobs(books, clock)
    // La persona fija una portada propia en el libro 1 antes de que el trabajo lo alcance.
    const manual = "https://mi-biblioteca.example/portada.jpg"
    books.get("b001")!.cover = { small: manual, medium: manual, large: manual }
    const catalog = liveService({ clock, store: memoryStore(clock).store, fetch: network.fetch, purpose: "batch" })
    for (let guard = 0; guard < 5 && !isTerminal(jobs.job.state); guard++) await runJobStep({ repo: jobs.repo, catalog, now: () => clock.now, random: () => 0, applyCovers: jobs.applyCovers })
    assert.equal(books.get("b001")!.cover.large, manual)
    assert.deepEqual(network.log.map((entry) => entry.isbn), [list[0], list[2]])
    assert.equal(jobs.items.get("b001")?.state, "skipped")
  })
})

describe("cola y caché compartidas entre instancias", () => {
  test("dos instancias comparten cuota, deduplican la misma consulta y respetan el tiempo de vida de la caché", async () => {
    const clock = { now: START }
    const shared = memoryStore(clock)
    const network = simulatedNetwork(clock)
    const [first, second] = [liveService({ clock, store: shared.store, fetch: network.fetch }), liveService({ clock, store: shared.store, fetch: network.fetch })]
    const list = isbns(4, 978840134000)

    // La misma consulta lanzada a la vez desde dos instancias sale una sola vez.
    const simultaneous = await Promise.all([first.lookupISBN(list[0], { userId: OWNER }), second.lookupISBN(list[0], { userId: OWNER })])
    assert.ok(simultaneous.every((result) => result.status === "found" && result.complete))
    assert.equal(network.log.filter((entry) => entry.isbn === list[0]).length, 1, "la misma consulta de dos instancias sale una sola vez")
    // Consultas distintas alternando instancias: el intervalo del proveedor es de todo el despliegue.
    for (const [index, isbn] of [list[1], list[2], list[3]].entries()) assert.equal((await (index % 2 ? first : second).lookupISBN(isbn, { userId: OWNER })).status, "found")
    const starts = network.log.map((entry) => entry.at)
    assert.equal(starts.length, 4)
    assert.ok(starts.every((at, index) => index === 0 || at - starts[index - 1] >= 1_000), "las dos instancias comparten el intervalo del proveedor")

    // Acierto de caché: ninguna petición más, aunque la pida otra instancia.
    const hits = network.log.length
    assert.equal((await second.lookupISBN(list[1], { userId: OWNER })).status, "found")
    assert.equal(network.log.length, hits)
    // Expiración: pasada la hora de vida de la ficha se vuelve a consultar.
    clock.now += providerRightsPolicy("open-library").metadataTtlSeconds * 1000 + 1
    assert.equal((await first.lookupISBN(list[1], { userId: OWNER })).status, "found")
    assert.equal(network.log.length, hits + 1)
    // Invalidación: una versión de política distinta no reutiliza lo guardado y se limpia lo anterior.
    assert.ok(shared.calls.invalidate.length >= 1, "al arrancar se retiran las entradas de versiones incompatibles")
  })

  test("la cuota agotada se informa como rateLimited con espera, sin pasar por «no encontrado»", async () => {
    const clock = { now: START }
    const network = simulatedNetwork(clock, () => ({ status: 429, retryAfter: 90 }))
    const catalog = liveService({ clock, store: memoryStore(clock).store, fetch: network.fetch })
    const [isbn] = isbns(1, 978840134100)
    const limited = await catalog.lookupISBN(isbn, { userId: OWNER })
    assert.equal(limited.status, "incomplete")
    assert.equal(limited.providers[0].status, "rateLimited")
    assert.ok((limited.providers[0].retryAfterSeconds ?? 0) >= 90)
    const requests = network.log.length
    const again = await catalog.lookupISBN(isbn, { userId: OWNER })
    assert.equal(again.providers[0].status, "rateLimited")
    assert.equal(network.log.length, requests, "durante el enfriamiento no se vuelve a salir")
    clock.now += 91_000
    assert.equal((await catalog.lookupISBN(isbn, { userId: OWNER })).providers[0].status, "rateLimited", "tras la espera se vuelve a intentar (y el guion devuelve 429 otra vez)")
    assert.equal(network.log.length, requests + 1)
  })
})

describe("Google desactivado y secretos", () => {
  const live = (extra: Record<string, string> = {}) => readCatalogConfig({ BIBLIB_TARGET: "test", BIBLIB_CATALOGUE_MODE: "live", BIBLIB_BNE_ENABLED: "true", GOOGLE_BOOKS_API_KEY: SECRET_KEY, ...extra })

  test("con Google apagado los cuatro flujos terminan con cero salidas a Google, aunque exista una clave", async () => {
    const hosts: string[] = []
    const spy: typeof fetch = async (input) => { hosts.push(new URL(input instanceof Request ? input.url : input).hostname); return Response.json({}) }
    const catalog = createConfiguredCatalog(live(), { fetch: spy })
    const [isbn] = isbns(1, 978840134200)
    const outcomes = await Promise.all([
      catalog.lookupISBN(isbn), catalog.searchTitleAuthor({ title: "Un título" }), catalog.getCover(isbn),
      catalog.resolveEditions({ provider: "open-library", recordKind: "work", recordId: "OL1W" }),
    ])
    for (const result of outcomes) assert.equal(result.providers.find((provider) => provider.provider === "google-books")?.status, "disabled")
    assert.equal(catalog.capabilities()["google-books"].lookupISBN, false)
    assert.ok(hosts.length > 0 && hosts.every((host) => !/google/i.test(host)), `solo catálogos base (${[...new Set(hosts)].join(", ")})`)

    // Recuperación de portadas (trabajo) con el mismo servicio: tampoco sale a Google.
    const clock = { now: START }
    const jobs = statefulJobs(booksFor(isbns(3, 978840134300)), clock)
    await runJobStep({ repo: jobs.repo, catalog, now: () => clock.now, random: () => 0, applyCovers: jobs.applyCovers })
    assert.ok(hosts.every((host) => !/google/i.test(host)))
  })

  test("ni la clave ni la consulta privada aparecen en logs, resultados, errores ni claves de caché", async (t) => {
    // El adaptador lee la clave del runtime del servidor, nunca de un DTO.
    const previousKey = process.env.GOOGLE_BOOKS_API_KEY
    process.env.GOOGLE_BOOKS_API_KEY = SECRET_KEY
    t.after(() => { if (previousKey === undefined) delete process.env.GOOGLE_BOOKS_API_KEY; else process.env.GOOGLE_BOOKS_API_KEY = previousKey })
    const clock = { now: START }
    const shared = memoryStore(clock)
    const requests: string[] = []
    const failing: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input)
      requests.push(url.href)
      // El proveedor refleja la URL (con clave) en el error: nada de eso puede salir de la frontera.
      throw new TypeError(`fallo de red hacia ${url.href}`)
    }
    const records: TelemetryRecord[] = []
    const telemetry = createLogger({ sink: (record) => records.push(record) })
    const gateway = createCatalogGateway({ store: shared.store, fetch: failing, sleep: fakeSleep(clock), telemetry, privateKeySecret: "s".repeat(40) })
    const config = live({ BIBLIB_GOOGLE_BOOKS_ENABLED: "true" })
    const catalog = createConfiguredCatalog(config, { telemetry, fetch: gateway.fetch, gateway })
    const [isbn] = isbns(1, 978840134400)
    const results = [
      await catalog.lookupISBN(isbn, { userId: OWNER }),
      await catalog.searchTitleAuthor({ title: SECRET_QUERY, author: SECRET_QUERY }, { userId: OWNER }),
      await catalog.getCover(isbn, { userId: OWNER }),
    ]
    assert.ok(requests.some((href) => href.includes(SECRET_KEY)), "la clave sí viaja al proveedor que la exige (la prueba es válida)")
    assert.ok(requests.some((href) => href.includes(SECRET_QUERY)), "la consulta viaja al proveedor para poder buscarla")
    const exposed = JSON.stringify({ records, results, privateKeys: [...shared.privateCache.keys()], cacheKeys: [...shared.cache.keys()], calls: shared.calls })
    for (const secret of [SECRET_KEY, SECRET_QUERY, encodeURIComponent(SECRET_QUERY), "AIzaSy"]) assert.ok(!exposed.includes(secret), `no debe filtrarse ${secret.slice(0, 8)}…`)
    assert.ok(results.every((result) => result.status === "incomplete" && result.providers.some((provider) => provider.status === "unavailable")), "una caída de red nunca es «no encontrado»")
  })

  test("las consultas solo llevan el ISBN o el texto buscado: nada del usuario, de su biblioteca ni de una foto", async () => {
    const clock = { now: START }
    const seen: { url: URL; headers: Headers; hasBody: boolean }[] = []
    const spy: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      seen.push({ url, headers: new Headers(init?.headers), hasBody: init?.body !== undefined && init.body !== null })
      return Response.json({})
    }
    const gateway = createCatalogGateway({ store: memoryStore(clock).store, fetch: spy, sleep: fakeSleep(clock) })
    const catalog = createConfiguredCatalog(live(), { fetch: gateway.fetch, gateway })
    const [isbn] = isbns(1, 978840134500)
    await catalog.lookupISBN(isbn, { userId: OWNER })
    await catalog.searchTitleAuthor({ title: "La sombra del viento", author: "Zafón" }, { userId: OWNER })
    assert.ok(seen.length >= 2)
    for (const request of seen) {
      assert.equal(request.hasBody, false, "ninguna consulta envía cuerpo (ni foto ni notas)")
      assert.ok(![...request.headers.keys()].some((name) => /authorization|cookie|x-user|x-account/i.test(name)))
      assert.ok(!request.url.href.includes(OWNER), "el identificador de la cuenta no viaja al proveedor")
    }
  })
})

describe("contrato completo por operación", () => {
  const isbn = isbns(1, 978840134600)[0]
  const candidate = (provider: ProviderId): BibliographicCandidate => ({ provider, level: "edition", isbns: [isbn], authors: [], publishers: [], title: "Ficha", evidence: { isbnExact: false }, retrievedAt: "2026-10-23T10:00:00.000Z" })
  const cover = (provider: ProviderId): CoverCandidate => ({ provider, coverKey: "k", imageUrl: "https://covers.invalid/portada.jpg", rightsPolicyVersion: providerRightsPolicy(provider).version })
  const statuses: ProviderStatus[] = ["found", "notFound", "unavailable", "rateLimited", "disabled", "misconfigured"]

  function adapter(status: ProviderStatus, calls: string[]): CatalogProvider {
    const reply = <T,>(name: string, value: T) => async (_input: unknown, context: { requestId: string }): Promise<ProviderResult<T[]>> => {
      calls.push(name)
      return status === "found" ? { status, provider: "open-library", requestId: context.requestId, value: [value] }
        : { status, provider: "open-library", requestId: context.requestId, ...(status === "rateLimited" ? { retryAfterSeconds: 12 } : {}) }
    }
    return { id: "open-library", capabilities: { lookupISBN: true, searchTitleAuthor: true, resolveEditions: true, getCover: true },
      lookupISBN: reply("lookupISBN", candidate("open-library")), searchTitleAuthor: reply("searchTitleAuthor", candidate("open-library")),
      resolveEditions: reply("resolveEditions", candidate("open-library")), getCover: reply("getCover", cover("open-library")) }
  }

  const operations = [
    ["lookupISBN", (service: ReturnType<typeof createBibliographicCatalogService>) => service.lookupISBN(isbn)],
    ["searchTitleAuthor", (service: ReturnType<typeof createBibliographicCatalogService>) => service.searchTitleAuthor({ title: "Ficha" })],
    ["resolveEditions", (service: ReturnType<typeof createBibliographicCatalogService>) => service.resolveEditions({ provider: "open-library", recordKind: "work", recordId: "OL1W" })],
    ["getCover", (service: ReturnType<typeof createBibliographicCatalogService>) => service.getCover(isbn)],
  ] as const

  for (const [name, call] of operations) {
    test(`${name}: cada estado de adaptador produce su estado agregado y conserva su diagnóstico`, async () => {
      for (const status of statuses) {
        const calls: string[] = []
        const service = createBibliographicCatalogService({ providers: [{ id: "open-library", enabled: true, adapter: adapter(status, calls) }, { id: "bne", enabled: false }, { id: "google-books", enabled: false }] })
        const result = await call(service)
        const outcome = result.providers.find((provider) => provider.provider === "open-library")!
        assert.equal(calls.length, 1, "una consulta, un adaptador")
        const expected = status === "found" ? "found" : status === "notFound" ? "notFound" : "incomplete"
        assert.equal(result.status, expected, `${name} con adaptador ${status}`)
        assert.equal(result.complete, status === "found" || status === "notFound")
        assert.equal(outcome.status, status, `el diagnóstico por fuente conserva ${status}`)
        if (status === "rateLimited") assert.equal(outcome.retryAfterSeconds, 12)
        if (status !== "found") assert.deepEqual(result.candidates, [])
        assert.ok(outcome.requestId.length > 0)
      }
    })
  }

  test("«disabled» y «misconfigured» por política o configuración no invocan al adaptador ni certifican ausencia", async () => {
    for (const [registration, expected] of [[{ enabled: false }, "disabled"], [{ enabled: true, configured: false }, "misconfigured"]] as const) {
      const calls: string[] = []
      const service = createBibliographicCatalogService({ providers: [{ id: "open-library", adapter: adapter("found", calls), ...registration }, { id: "bne", enabled: false }, { id: "google-books", enabled: false }] })
      for (const [, call] of operations) {
        const result = await call(service)
        assert.equal(result.providers[0].status, expected)
        assert.deepEqual([result.status, result.complete], ["incomplete", false])
      }
      assert.deepEqual(calls, [])
    }
  })

  test("una fuente sin ficha y otra caída nunca certifican ausencia; una ficha parcial conserva el fallo", async () => {
    const calls: string[] = []
    const base = adapter("found", calls)
    const failing: CatalogProvider = { ...adapter("unavailable", calls), id: "bne" }
    const empty: CatalogProvider = { ...adapter("notFound", calls), id: "bne" }
    const registrations = (second: CatalogProvider): ProviderRegistration[] => [{ id: "open-library", enabled: true, adapter: base }, { id: "bne", enabled: true, adapter: second }, { id: "google-books", enabled: false }]
    const partial = await createBibliographicCatalogService({ providers: registrations(failing) }).lookupISBN(isbn)
    assert.deepEqual([partial.status, partial.complete], ["found", false])
    assert.deepEqual(partial.providers.map((provider) => provider.status), ["found", "unavailable", "disabled"])
    const noHit = await createBibliographicCatalogService({ providers: [{ id: "open-library", enabled: true, adapter: { ...adapter("notFound", calls) } }, { id: "bne", enabled: true, adapter: failing }, { id: "google-books", enabled: false }] }).lookupISBN(isbn)
    assert.deepEqual([noHit.status, noHit.complete], ["incomplete", false])
    const both = await createBibliographicCatalogService({ providers: [{ id: "open-library", enabled: true, adapter: adapter("notFound", calls) }, { id: "bne", enabled: true, adapter: empty }, { id: "google-books", enabled: false }] }).lookupISBN(isbn)
    assert.deepEqual([both.status, both.complete], ["notFound", true])
  })

  test("un ISBN inválido no produce ninguna llamada a ningún adaptador", async () => {
    const calls: string[] = []
    const service = createBibliographicCatalogService({ providers: [{ id: "open-library", enabled: true, adapter: adapter("found", calls) }] })
    for (const bad of ["9780000000001", "abc", "", "97800000000019"]) {
      assert.equal(normalizeIsbn(bad), null)
      await assert.rejects(service.lookupISBN(bad))
      await assert.rejects(service.getCover(bad))
    }
    assert.deepEqual(calls, [])
  })
})

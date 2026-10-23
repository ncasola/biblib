import assert from "node:assert/strict"
import { test } from "node:test"
import { cachePlan, invalidationVersion, parseCachedPayload, privateCacheKey, type RightsSource } from "../lib/bibliographic-catalog/cache"
import { createCatalogGateway, QuotaDeferredError, type BeginResult, type CacheOutcome, type CatalogueKey, type CoordinationStore, type ReserveRequest, type ReserveResult } from "../lib/bibliographic-catalog/gateway"
import { createBibliographicCatalogService } from "../lib/bibliographic-catalog/orchestrator"
import { createOpenLibraryProvider } from "../lib/bibliographic-catalog/providers/open-library"
import { providerForUrl, providerQuotaPolicy, retryAfterMs } from "../lib/bibliographic-catalog/quota"
import { hasProviderRight, providerRightsPolicy } from "../lib/bibliographic-catalog/rights"
import type { BibliographicCandidate, ProviderResult } from "../lib/bibliographic-catalog/types"

// Pruebas sin Docker: un store en memoria con la misma semántica que las funciones catalogue_*.
// Las carreras reales entre procesos se prueban contra Postgres en tests/integration/catalogue.

const isbn = "9780804429573"
const owner = "00000000-0000-4000-8000-00000000000a"
const record = { title: "Ficha pública ficticia", authors: [{ name: "Autor ficticio" }], identifiers: { isbn_10: ["0-8044-2957-X"], openlibrary: ["OL1M"] }, url: "https://openlibrary.org/books/OL1M" }

function memoryStore(clock: { now: number } = { now: 0 }) {
  const cache = new Map<string, { status: "found" | "notFound"; payload: unknown; fence: string; expiresAt: number }>()
  const inflight = new Map<string, { fence: string; expiresAt: number }>()
  const privateCache = new Map<string, { status: "found" | "notFound"; payload: unknown; expiresAt: number }>()
  const reservations = new Map<string, { owner?: string; purpose: string; fence: string; expiresAt: number; released: boolean; provider: string }>()
  const buckets = new Map<string, { next: number; cooldown: number }>()
  const calls = { begin: 0, complete: [] as (CacheOutcome | undefined)[], reserve: 0, release: [] as (number | undefined)[], invalidate: [] as (string | null)[] }
  let sequence = 0
  const id = (k: CatalogueKey) => JSON.stringify([k.provider, k.policyVersion, k.scope, k.schemaVersion, k.operation, k.key])
  let failing = false
  const guard = () => { if (failing) throw new Error("Postgres no responde") }
  const store: CoordinationStore = {
    async begin(k, options): Promise<BeginResult> {
      guard(); calls.begin++
      if (options.discardFence && cache.get(id(k))?.fence === options.discardFence) cache.delete(id(k))
      const entry = options.useCache ? cache.get(id(k)) : undefined
      if (entry && entry.expiresAt > clock.now) return { state: "hit", status: entry.status, payload: entry.payload, fence: entry.fence }
      const current = inflight.get(id(k))
      if (current && current.expiresAt > clock.now) return { state: "pending" }
      const fence = String(++sequence)
      inflight.set(id(k), { fence, expiresAt: clock.now + options.leaseMs })
      return { state: "leased", fence }
    },
    async complete(k, fence, outcome) {
      guard(); calls.complete.push(outcome)
      const current = inflight.get(id(k))
      if (current?.fence !== fence) return "stale"
      inflight.delete(id(k))
      if (current.expiresAt <= clock.now) return "stale"
      if (!outcome) return "released"
      const previous = cache.get(id(k))
      if (previous && Number(previous.fence) >= Number(fence)) return "stale"
      cache.set(id(k), { status: outcome.status, payload: structuredClone(outcome.payload), fence, expiresAt: clock.now + outcome.ttlMs })
      return "published"
    },
    async reserve(request: ReserveRequest): Promise<ReserveResult> {
      guard(); calls.reserve++
      const bucket = buckets.get(request.provider) ?? { next: clock.now, cooldown: 0 }
      buckets.set(request.provider, bucket)
      if (bucket.cooldown > clock.now) return { state: "cooldown", retryMs: bucket.cooldown - clock.now }
      const active = [...reservations.values()].filter((r) => r.provider === request.provider && r.owner === request.owner && r.purpose === request.purpose && !r.released && r.expiresAt > clock.now).length
      if (active >= request.ownerCap) return { state: "busy", retryMs: request.intervalMs }
      const slot = Math.max(clock.now, bucket.next)
      if (slot > clock.now + request.horizonMs) return { state: "wait", retryMs: slot - clock.now - request.horizonMs }
      bucket.next = slot + request.intervalMs
      const fence = String(++sequence)
      const reservationId = `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`
      reservations.set(reservationId, { owner: request.owner, purpose: request.purpose, fence, expiresAt: slot + request.leaseMs, released: false, provider: request.provider })
      return { state: "reserved", reservationId, fence, waitMs: slot - clock.now }
    },
    async release(reservationId, fence, retryAfter) {
      guard(); calls.release.push(retryAfter)
      const reservation = reservations.get(reservationId)
      if (!reservation || reservation.fence !== fence || reservation.released) return false
      reservation.released = true
      const bucket = buckets.get(reservation.provider)
      if (bucket && retryAfter) { bucket.cooldown = Math.max(bucket.cooldown, clock.now + retryAfter); bucket.next = Math.max(bucket.next, bucket.cooldown) }
      return true
    },
    async privateGet(ownerId, k) {
      guard()
      const entry = privateCache.get(ownerId + id(k))
      return entry && entry.expiresAt > clock.now ? { status: entry.status, payload: entry.payload } : null
    },
    async privatePut(ownerId, k, outcome) {
      guard()
      privateCache.set(ownerId + id(k), { status: outcome.status, payload: outcome.payload, expiresAt: clock.now + outcome.ttlMs })
      return true
    },
    async invalidate(_provider, policyVersion) { guard(); calls.invalidate.push(policyVersion); return 0 },
  }
  return { store, cache, inflight, privateCache, calls, clock, fail: (value: boolean) => { failing = value } }
}

/** Reloj simulado: dormir avanza el tiempo sin esperar de verdad. */
function fakeSleep(clock: { now: number }) {
  return async (milliseconds: number, signal?: AbortSignal) => { signal?.throwIfAborted(); clock.now += Math.max(0, milliseconds) }
}

function olFetch(responses: (() => Response)[], seen: string[] = []) {
  return async (input: Parameters<typeof fetch>[0]) => {
    seen.push(new URL(input instanceof Request ? input.url : input).hostname)
    const next = responses.shift()
    assert.ok(next, "Petición externa no prevista")
    return next()
  }
}

/** Orquestador real con el adaptador OL real; su intervalo y caché locales usan el mismo reloj simulado. */
function service(gateway: ReturnType<typeof createCatalogGateway>, clock?: { now: number }) {
  const time = clock ? { now: () => clock.now, wait: fakeSleep(clock) } : {}
  return createBibliographicCatalogService({ providers: [{ id: "open-library", enabled: true, adapter: createOpenLibraryProvider({ fetch: gateway.fetch, ...time }) }], gateway })
}

const context = (signal = new AbortController().signal) => ({ signal, requestId: "00000000-0000-4000-8000-000000000001" })

test("política: OL cachea ficha 1 h y ausencia 5 min; BNE (CC0) ficha 1 h sin ausencias; portadas y Google sin caché", () => {
  const plan = cachePlan("open-library", "lookupISBN")
  assert.equal(plan?.foundTtlMs, 3_600_000)
  assert.equal(plan?.notFoundTtlMs, 300_000)
  assert.equal(plan?.policyVersion, providerRightsPolicy("open-library").version)
  assert.equal(cachePlan("open-library", "getCover"), null, "coverTtlSeconds = 0: la portada no se guarda")
  // BNE publica metadatos CC0 (U-BIB-02): ficha 1 h con procedencia; las ausencias no se guardan.
  const bne = cachePlan("bne", "lookupISBN")
  assert.equal(bne?.foundTtlMs, 3_600_000)
  assert.equal(bne?.notFoundTtlMs, 0)
  assert.equal(bne?.policyVersion, providerRightsPolicy("bne").version)
  assert.equal(cachePlan("bne", "getCover"), null, "La licencia CC0 de BNE no cubre portadas")
  assert.equal(cachePlan("google-books", "lookupISBN"), null)
  assert.equal(invalidationVersion("google-books"), null)
  const noPersist: RightsSource = { policy: providerRightsPolicy, allows: (policy, capability) => capability !== "persistMetadata" && hasProviderRight(policy, capability) }
  assert.equal(cachePlan("open-library", "lookupISBN", noPersist), null, "Sin persistMetadata no hay caché aunque cacheMetadata esté aprobada")
})

test("cuota: OL, BNE y Google con políticas propias y hosts ajenos bloqueados", () => {
  const ol = providerQuotaPolicy("open-library")
  const bne = providerQuotaPolicy("bne")
  assert.equal(ol?.intervalMs, 1000)
  assert.ok(bne && bne.intervalMs !== ol?.intervalMs)
  assert.equal(providerQuotaPolicy("google-books")?.intervalMs, 2000)
  assert.ok(ol && ol.horizonMs.batch < ol.horizonMs.interactive, "El lote no hace cola por delante de una búsqueda")
  assert.equal(providerForUrl(new URL("https://openlibrary.org/api/books")), "open-library")
  assert.equal(providerForUrl(new URL("https://covers.openlibrary.org/b/id/1-L.jpg")), "open-library")
  assert.equal(providerForUrl(new URL("https://catalogo.bne.es/view/sru")), "bne")
  assert.equal(providerForUrl(new URL("https://www.googleapis.com/books/v1/volumes")), "google-books")
  assert.equal(providerForUrl(new URL("http://openlibrary.org/api/books")), undefined)
  assert.equal(providerForUrl(new URL("https://openlibrary.org.example.com/")), undefined)
  assert.equal(providerForUrl(new URL("https://user:pw@openlibrary.org/")), undefined)
  assert.equal(retryAfterMs("7"), 7000)
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 0), 10_000)
  assert.equal(retryAfterMs(null), 30_000)
  assert.equal(retryAfterMs("999999"), 3_600_000)
  assert.equal(retryAfterMs("0"), 1000)
})

test("dos solicitudes simultáneas de la misma clave comparten una consulta y la caché sirve las siguientes", async () => {
  const memory = memoryStore()
  let requests = 0
  const gateway = createCatalogGateway({ store: memory.store, sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 5)) }, fetch: async () => { requests++; await new Promise((resolve) => setTimeout(resolve, 20)); return Response.json({ [`ISBN:${isbn}`]: record }) } })
  const catalog = service(gateway)
  const [first, second] = await Promise.all([catalog.lookupISBN(isbn, { userId: owner }), catalog.lookupISBN(isbn)])
  assert.equal(requests, 1)
  assert.equal(first.status, "found")
  assert.deepEqual(second.candidates, first.candidates)
  assert.equal((await catalog.lookupISBN(isbn)).status, "found")
  assert.equal(requests, 1, "La tercera consulta sale de la caché compartida")
  const [entry] = [...memory.cache.values()]
  assert.equal(entry.status, "found")
  assert.ok(!JSON.stringify(entry.payload).includes(owner), "La fila compartida no contiene al dueño")
})

test("ausencia confirmada se cachea; caída y límite nunca se guardan como ausencia", async () => {
  const memory = memoryStore()
  const responses = [() => new Response(null, { status: 503 }), () => new Response(null, { status: 503 }), () => Response.json({})]
  const gateway = createCatalogGateway({ store: memory.store, sleep: fakeSleep(memory.clock), fetch: olFetch(responses) })
  const catalog = service(gateway, memory.clock)
  assert.equal((await catalog.lookupISBN(isbn)).status, "incomplete")
  assert.equal(memory.cache.size, 0)
  memory.clock.now += 2000
  assert.equal((await catalog.lookupISBN(isbn)).status, "incomplete")
  memory.clock.now += 2000
  assert.equal((await catalog.lookupISBN(isbn)).status, "notFound")
  assert.equal([...memory.cache.values()][0].status, "notFound")
  assert.equal((await catalog.lookupISBN(isbn)).status, "notFound", "La ausencia se sirve de caché")
  memory.clock.now += 300_001
  responses.push(() => Response.json({ [`ISBN:${isbn}`]: record }))
  assert.equal((await catalog.lookupISBN(isbn)).status, "found", "La ausencia caduca a los 5 min")
})

test("una política que deniega persistencia impide escribir en caché", async () => {
  const memory = memoryStore()
  const denied: RightsSource = { policy: providerRightsPolicy, allows: (policy, capability) => capability !== "cacheMetadata" && hasProviderRight(policy, capability) }
  let requests = 0
  const gateway = createCatalogGateway({ store: memory.store, rights: denied, sleep: fakeSleep(memory.clock) })
  const candidate = { provider: "open-library" as const, level: "edition" as const, isbns: [isbn], authors: [], publishers: [], evidence: { isbnExact: true }, retrievedAt: "2026-10-23T00:00:00.000Z" }
  const fetcher = async (): Promise<ProviderResult<BibliographicCandidate[]>> => { requests++; return { provider: "open-library", requestId: "r", status: "found", value: [candidate] } }
  assert.equal((await gateway.execute({ provider: "open-library", operation: "lookupISBN", key: isbn }, fetcher, context())).status, "found")
  assert.equal((await gateway.execute({ provider: "open-library", operation: "lookupISBN", key: isbn }, fetcher, context())).status, "found")
  assert.equal(requests, 2)
  assert.equal(memory.cache.size, 0)
  assert.ok(memory.calls.complete.every((outcome) => outcome === undefined))
  assert.deepEqual(memory.calls.invalidate, [null], "Política revocada: se retiran todas las entradas del proveedor")
})

test("sin Postgres no hay ráfaga externa: unavailable sin llamar al proveedor", async () => {
  const memory = memoryStore()
  memory.fail(true)
  let requests = 0
  const gateway = createCatalogGateway({ store: memory.store, sleep: fakeSleep(memory.clock), fetch: async () => { requests++; return Response.json({}) } })
  const result = await service(gateway).lookupISBN(isbn)
  assert.equal(result.status, "incomplete")
  assert.equal(result.providers[0].status, "unavailable")
  assert.equal(requests, 0)
  // Tampoco el fetch coordinado sale a la red sin reserva.
  await assert.rejects(gateway.bind({ purpose: "batch" })("https://openlibrary.org/api/books"), /Postgres/)
  assert.equal(requests, 0)
})

test("429 con Retry-After abre cooldown compartido y la espera de cuota es rateLimited, no notFound", async () => {
  const memory = memoryStore()
  const responses = [() => new Response(null, { status: 429, headers: { "Retry-After": "5" } })]
  const gateway = createCatalogGateway({ store: memory.store, sleep: fakeSleep(memory.clock), fetch: olFetch(responses) })
  const catalog = service(gateway, memory.clock)
  const limited = await catalog.lookupISBN(isbn)
  assert.equal(limited.providers[0].status, "rateLimited")
  assert.equal(limited.providers[0].retryAfterSeconds, 5)
  assert.deepEqual(memory.calls.release, [5000])
  // En cooldown no sale ninguna petición: el adaptador ve un fallo y el gateway responde rateLimited.
  const cooling = await catalog.lookupISBN(isbn)
  assert.equal(cooling.status, "incomplete")
  assert.equal(cooling.providers[0].status, "rateLimited")
  // El restante depende de si el limitador local del adaptador consumió reloj simulado: nunca 0 ni más de 5 s.
  const remaining = cooling.providers[0].retryAfterSeconds ?? 0
  assert.ok(remaining > 0 && remaining <= 5, `cooldown restante ${remaining}`)
  assert.equal(memory.cache.size, 0)
  await assert.rejects(gateway.bind({ purpose: "batch" })("https://openlibrary.org/api/books"), (error) => error instanceof QuotaDeferredError && error.retryAfterMs > 0 && error.retryAfterMs <= 5000)
})

test("intervalo global: lote cede ante interactivo y espera fuera de la base", async () => {
  const memory = memoryStore()
  const starts: number[] = []
  const gateway = createCatalogGateway({ store: memory.store, sleep: fakeSleep(memory.clock), fetch: async () => { starts.push(memory.clock.now); return Response.json({}) } })
  const batch = gateway.bind({ owner, purpose: "batch" })
  await batch("https://openlibrary.org/api/books?bibkeys=1")
  await batch("https://openlibrary.org/api/books?bibkeys=2")
  await gateway.bind({ purpose: "interactive" })("https://openlibrary.org/api/books?bibkeys=3")
  assert.deepEqual(starts, [0, 1000, 2000])
  // BNE no consume la reserva de OL.
  await gateway.bind({ purpose: "interactive" })("https://catalogo.bne.es/sru")
  assert.equal(starts.at(-1), 2000)
  // Una búsqueda que tendría que esperar más de lo admisible recibe rateLimited recuperable.
  const busy = memoryStore()
  const gatewayBusy = createCatalogGateway({ store: busy.store, sleep: fakeSleep(busy.clock), fetch: async () => Response.json({}) })
  for (let i = 0; i < 3; i++) await busy.store.reserve({ provider: "open-library", scope: "deployment", purpose: "interactive", owner: `otro-${i}`, intervalMs: 1000, horizonMs: 2500, ownerCap: 2, leaseMs: 10000 })
  await assert.rejects(gatewayBusy.bind({ purpose: "interactive", owner })("https://openlibrary.org/api/books"), QuotaDeferredError)
})

test("Google deshabilitado no recibe peticiones ni crea caché", async () => {
  const memory = memoryStore()
  let requests = 0
  const gateway = createCatalogGateway({ store: memory.store, sleep: fakeSleep(memory.clock), fetch: async () => { requests++; return Response.json({}) } })
  const catalog = createBibliographicCatalogService({ providers: [{ id: "google-books", enabled: false }], gateway })
  const result = await catalog.lookupISBN(isbn)
  assert.equal(result.providers.find((p) => p.provider === "google-books")?.status, "disabled")
  assert.equal(requests, 0)
  assert.equal(memory.calls.begin, 0)
  assert.equal(memory.cache.size, 0)
})

test("caché malformada o de otra versión se descarta y se vuelve a consultar", async () => {
  const memory = memoryStore()
  const policyVersion = providerRightsPolicy("open-library").version
  assert.equal(parseCachedPayload("open-library", "lookupISBN", isbn, policyVersion, [{ provider: "open-library", title: 3 }]), null)
  assert.equal(parseCachedPayload("open-library", "lookupISBN", isbn, policyVersion, { no: "array" }), null)
  assert.equal(parseCachedPayload("bne", "getCover", isbn, policyVersion, [{ provider: "open-library", coverKey: "1", rightsPolicyVersion: policyVersion }]), null)
  const key = JSON.stringify(["open-library", policyVersion, "deployment", 1, "lookupISBN", isbn])
  memory.cache.set(key, { status: "found", payload: [{ provider: "open-library", malformed: true }], fence: "99", expiresAt: Number.MAX_SAFE_INTEGER })
  let requests = 0
  const gateway = createCatalogGateway({ store: memory.store, sleep: fakeSleep(memory.clock), fetch: async () => { requests++; return Response.json({ [`ISBN:${isbn}`]: record }) } })
  const result = await service(gateway).lookupISBN(isbn)
  assert.equal(result.status, "found")
  assert.equal(requests, 1)
  assert.equal((memory.cache.get(key)?.payload as BibliographicCandidate[])[0].title, record.title)
})

test("cancelar mientras otro proceso resuelve la clave no es ausencia ni deja rechazos huérfanos", async () => {
  const memory = memoryStore()
  const policyVersion = providerRightsPolicy("open-library").version
  memory.inflight.set(JSON.stringify(["open-library", policyVersion, "deployment", 1, "lookupISBN", isbn]), { fence: "1", expiresAt: Number.MAX_SAFE_INTEGER })
  const gateway = createCatalogGateway({ store: memory.store, pollMs: 5, fetch: async () => assert.fail("La clave está en vuelo en otro proceso") })
  const result = await service(gateway).lookupISBN(isbn, { providerTimeoutMs: 60 })
  assert.equal(result.status, "incomplete")
  assert.equal(result.providers[0].status, "unavailable")
  assert.equal(result.providers[0].reason, "deadline")
  const controller = new AbortController()
  const pending = gateway.execute<BibliographicCandidate>({ provider: "open-library", operation: "lookupISBN", key: isbn }, async () => assert.fail("No debe consultar"), context(controller.signal))
  controller.abort()
  assert.equal((await pending).status, "unavailable")
})

test("concesión caducada: el trabajador tardío no publica sobre la entrada de otro (fencing)", async () => {
  const memory = memoryStore()
  const policyVersion = providerRightsPolicy("open-library").version
  const key: CatalogueKey = { provider: "open-library", policyVersion, scope: "deployment", schemaVersion: 1, operation: "lookupISBN", key: isbn }
  const late = await memory.store.begin(key, { useCache: true, leaseMs: 100 })
  assert.equal(late.state, "leased")
  memory.clock.now += 200
  const fresh = await memory.store.begin(key, { useCache: true, leaseMs: 100 })
  assert.equal(fresh.state, "leased")
  const outcome: CacheOutcome = { status: "notFound", payload: [], provenance: {}, ttlMs: 1000 }
  assert.equal(await memory.store.complete(key, (late as { fence: string }).fence, outcome), "stale")
  assert.equal(await memory.store.complete(key, (fresh as { fence: string }).fence, outcome), "published")
})

test("búsqueda de texto: caché privada por dueño con HMAC, nunca en la caché compartida", async () => {
  const memory = memoryStore()
  const secret = "s".repeat(32)
  const candidate = { provider: "open-library" as const, level: "work" as const, isbns: [], authors: [{ name: "Autor ficticio" }], publishers: [], evidence: { isbnExact: false }, retrievedAt: "2026-10-23T00:00:00.000Z", title: "Ficha ficticia" }
  let requests = 0
  const rights: RightsSource = { policy: providerRightsPolicy, allows: hasProviderRight }
  const gateway = createCatalogGateway({ store: memory.store, rights, privateKeySecret: secret, sleep: fakeSleep(memory.clock) })
  const fetcher = async (): Promise<ProviderResult<BibliographicCandidate[]>> => { requests++; return { provider: "open-library", requestId: "r", status: "found", value: [candidate] } }
  const query = JSON.stringify(["consulta privada", ""])
  assert.equal((await gateway.execute({ provider: "open-library", operation: "searchTitleAuthor", key: query, owner }, fetcher, context())).status, "found")
  assert.equal((await gateway.execute({ provider: "open-library", operation: "searchTitleAuthor", key: query, owner }, fetcher, context())).status, "found")
  assert.equal(requests, 1)
  assert.equal(memory.cache.size, 0)
  assert.ok(![...memory.privateCache.keys()].some((k) => k.includes("consulta privada")), "La base no guarda el texto consultado")
  // Otro dueño no comparte la entrada privada.
  await gateway.execute({ provider: "open-library", operation: "searchTitleAuthor", key: query, owner: "00000000-0000-4000-8000-00000000000b" }, fetcher, context())
  assert.equal(requests, 2)
  assert.notEqual(privateCacheKey(secret, owner, query), privateCacheKey(secret, "otro", query))
  // Sin secreto o sin dueño no se cachea nada.
  const plain = createCatalogGateway({ store: memoryStore().store })
  await plain.execute({ provider: "open-library", operation: "searchTitleAuthor", key: query, owner }, fetcher, context())
  await plain.execute({ provider: "open-library", operation: "searchTitleAuthor", key: query, owner }, fetcher, context())
  assert.equal(requests, 4)
})

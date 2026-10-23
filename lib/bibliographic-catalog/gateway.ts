import { AsyncLocalStorage } from "node:async_hooks"
import type postgres from "postgres"
import { z } from "zod"
import { emitSafely, noopTelemetry, type TelemetryEmitter } from "../observability/emitter"
import { CATALOGUE_CACHE_SCHEMA_VERSION, cachePlan, invalidationVersion, isPublicCacheKey, parseCachedPayload, privateCacheKey, publishedRights, type CachePlan, type CatalogOperation, type RightsSource } from "./cache"
import { providerForUrl, providerQuotaPolicy, retryAfterMs, type ProviderQuotaPolicy, type QuotaPurpose } from "./quota"
import type { ProviderContext, ProviderId, ProviderResult } from "./types"

/*
 * Gateway de infraestructura del catálogo (U-DAT-05). Coordina entre procesos, mediante Postgres,
 * la caché de metadatos, las consultas en vuelo y la cuota de cada proveedor. No elige fuentes ni
 * fallback (eso es del orquestador U-BIB) y no lo expone ninguna acción de cliente: el dueño llega
 * del contexto servidor y nunca de un DTO.
 */

export interface CatalogueKey {
  provider: ProviderId
  policyVersion: string
  scope: string
  schemaVersion: number
  operation: CatalogOperation
  key: string
}

export type BeginResult =
  | { state: "hit"; status: "found" | "notFound"; payload: unknown; fence: string }
  | { state: "pending" }
  | { state: "leased"; fence: string }

export type ReserveResult =
  | { state: "reserved"; reservationId: string; fence: string; waitMs: number }
  | { state: "cooldown" | "wait" | "busy"; retryMs: number }

export interface ReserveRequest {
  provider: ProviderId
  scope: string
  owner?: string
  purpose: QuotaPurpose
  intervalMs: number
  horizonMs: number
  ownerCap: number
  leaseMs: number
}

export interface CacheOutcome {
  status: "found" | "notFound"
  payload: unknown[]
  provenance: Record<string, string>
  ttlMs: number
}

/** Operaciones atómicas de coordinación. Ninguna espera dentro de la base: devuelven cuánto esperar. */
export interface CoordinationStore {
  begin(key: CatalogueKey, options: { useCache: boolean; leaseMs: number; discardFence?: string }): Promise<BeginResult>
  complete(key: CatalogueKey, fence: string, outcome?: CacheOutcome): Promise<"published" | "released" | "stale">
  reserve(request: ReserveRequest): Promise<ReserveResult>
  release(reservationId: string, fence: string, retryAfterMs?: number): Promise<boolean>
  privateGet(owner: string, key: CatalogueKey): Promise<{ status: "found" | "notFound"; payload: unknown } | null>
  privatePut(owner: string, key: CatalogueKey, outcome: CacheOutcome): Promise<boolean>
  invalidate(provider: ProviderId, policyVersion: string | null, schemaVersion: number): Promise<number>
}

const fence = z.string().regex(/^\d{1,19}$/)
const beginSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("hit"), status: z.enum(["found", "notFound"]), payload: z.unknown(), fence }),
  z.object({ state: z.literal("pending") }),
  z.object({ state: z.literal("leased"), fence }),
])
const reserveSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("reserved"), reservationId: z.uuid(), fence, waitMs: z.number().int().min(0) }),
  z.object({ state: z.enum(["cooldown", "wait", "busy"]), retryMs: z.number().int().min(1) }),
])
const privateSchema = z.object({ status: z.enum(["found", "notFound"]), payload: z.unknown() })

/** Implementación sobre las funciones `biblib.catalogue_*` con la conexión propia del servidor. */
export function createPostgresCoordinationStore(sql: postgres.Sql): CoordinationStore {
  // Objeto tipado como jsonb: un string con ::jsonb se guardaría como escalar JSON, no como array.
  const json = (value: unknown) => sql.json(value as postgres.JSONValue)
  return {
    async begin(k, options) {
      const [row] = await sql`select biblib.catalogue_begin(${k.provider}, ${k.policyVersion}, ${k.scope}, ${k.schemaVersion}::integer, ${k.operation}, ${k.key}, ${options.useCache}, ${options.leaseMs}::integer, ${options.discardFence ?? null}::bigint) as result`
      return beginSchema.parse(row?.result)
    },
    async complete(k, token, outcome) {
      const [row] = await sql`select biblib.catalogue_complete(${k.provider}, ${k.policyVersion}, ${k.scope}, ${k.schemaVersion}::integer, ${k.operation}, ${k.key}, ${token}::bigint,
        ${outcome?.status ?? null}, ${outcome ? json(outcome.payload) : null}, ${outcome ? json(outcome.provenance) : null}, ${outcome ? Math.round(outcome.ttlMs) : null}::integer) as result`
      return z.enum(["published", "released", "stale"]).parse(row?.result)
    },
    async reserve(request) {
      const [row] = await sql`select biblib.catalogue_reserve(${request.provider}, ${request.scope}, ${request.owner ?? null}::uuid, ${request.purpose}, ${request.intervalMs}::integer, ${request.horizonMs}::integer, ${request.ownerCap}::integer, ${request.leaseMs}::integer) as result`
      return reserveSchema.parse(row?.result)
    },
    async release(reservationId, token, retryAfter) {
      const [row] = await sql`select biblib.catalogue_release(${reservationId}::uuid, ${token}::bigint, ${retryAfter === undefined ? null : Math.round(retryAfter)}::integer) as result`
      return row?.result === true
    },
    async privateGet(owner, k) {
      const [row] = await sql`select biblib.catalogue_private_get(${owner}::uuid, ${k.provider}, ${k.policyVersion}, ${k.scope}, ${k.schemaVersion}::integer, ${k.operation}, ${k.key}) as result`
      return row?.result == null ? null : privateSchema.parse(row.result)
    },
    async privatePut(owner, k, outcome) {
      const [row] = await sql`select biblib.catalogue_private_put(${owner}::uuid, ${k.provider}, ${k.policyVersion}, ${k.scope}, ${k.schemaVersion}::integer, ${k.operation}, ${k.key}, ${outcome.status}, ${json(outcome.payload)}, ${Math.round(outcome.ttlMs)}::integer) as result`
      return row?.result === true
    },
    async invalidate(provider, policyVersion, schemaVersion) {
      const [row] = await sql`select biblib.catalogue_invalidate(${provider}, ${policyVersion}, ${schemaVersion}::integer) as result`
      return Number(row?.result ?? 0)
    },
  }
}

/** La cuota pide esperar más de lo admisible: el adaptador lo verá como fallo y el gateway como `rateLimited`. */
export class QuotaDeferredError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("La cuota del proveedor exige esperar.")
    this.name = "QuotaDeferredError"
  }
}

interface CallState {
  owner?: string
  purpose: QuotaPurpose
  signal?: AbortSignal
  deferred?: boolean
  retryAfterMs?: number
}

export interface GatewayRequest {
  provider: ProviderId
  operation: CatalogOperation
  /** Clave canónica (ISBN, referencia) o, en búsquedas de texto, la consulta normalizada (privada). */
  key: string
  /** Dueño procedente de la sesión servidor; nunca de un DTO de cliente. */
  owner?: string
  purpose?: QuotaPurpose
}

export interface CatalogGateway {
  execute<T>(request: GatewayRequest, fetcher: () => Promise<ProviderResult<T[]>>, context: ProviderContext): Promise<ProviderResult<T[]>>
  /** `fetch` coordinado para los adaptadores: solo destinos de proveedores con cuota y siempre con reserva. */
  fetch: typeof fetch
  /** `fetch` coordinado fuera de `execute` (lotes de importación, trabajos), con dueño y propósito explícitos. */
  bind(context: { owner?: string; purpose: QuotaPurpose; signal?: AbortSignal }): typeof fetch
}

export interface CatalogGatewayOptions {
  store: CoordinationStore
  fetch?: typeof fetch
  rights?: RightsSource
  quota?: (provider: ProviderId) => ProviderQuotaPolicy | undefined
  /** Ámbito de credencial: sin identificación acordada, todo el despliegue comparte uno. */
  credentialScope?: string
  /** Secreto servidor del HMAC de consultas de texto; sin él no se cachean. */
  privateKeySecret?: string
  telemetry?: TelemetryEmitter
  leaseMs?: number
  pollMs?: number
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

export const GATEWAY_LEASE_MS = 12_000
const POLL_MS = 150

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return signal?.aborted ? Promise.reject(signal.reason) : Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve() }, milliseconds)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

const seconds = (milliseconds: number | undefined) => milliseconds === undefined ? undefined : Math.max(1, Math.ceil(milliseconds / 1000))

export function createCatalogGateway(options: CatalogGatewayOptions): CatalogGateway {
  const { store } = options
  const baseFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const rights = options.rights ?? publishedRights
  const quota = options.quota ?? providerQuotaPolicy
  const scope = options.credentialScope ?? "deployment"
  const telemetry = options.telemetry ?? noopTelemetry
  const leaseMs = options.leaseMs ?? GATEWAY_LEASE_MS
  const pollMs = options.pollMs ?? POLL_MS
  const sleep = options.sleep ?? abortableSleep
  const calls = new AsyncLocalStorage<CallState>()
  const invalidated = new Map<ProviderId, Promise<void>>()

  /** Retira una vez por proceso las entradas de versiones incompatibles; es limpieza, no condición de uso. */
  function invalidateOnce(provider: ProviderId): Promise<void> {
    let pending = invalidated.get(provider)
    if (!pending) {
      pending = store.invalidate(provider, invalidationVersion(provider, rights), CATALOGUE_CACHE_SCHEMA_VERSION).then(() => undefined, () => { invalidated.delete(provider) })
      invalidated.set(provider, pending)
    }
    return pending
  }

  async function coordinatedFetch(state: CallState, input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input)
    const provider = providerForUrl(url, quota)
    const policy = provider ? quota(provider) : undefined
    // Sin proveedor con cuota aprobada no sale ninguna petición (Google deshabilitado, hosts ajenos).
    if (!provider || !policy) throw new TypeError("Destino de red no autorizado para el catálogo.")
    const signal = init?.signal ?? state.signal
    const purpose = state.purpose
    let waited = 0
    let reservation: Extract<ReserveResult, { state: "reserved" }>
    for (;;) {
      signal?.throwIfAborted()
      // Si Postgres no responde, falla aquí: nunca hay ráfaga externa de reserva.
      const decision = await store.reserve({ provider, scope, owner: state.owner, purpose, intervalMs: policy.intervalMs, horizonMs: policy.horizonMs[purpose], ownerCap: policy.ownerCap[purpose], leaseMs: policy.leaseMs })
      if (decision.state === "reserved") { reservation = decision; break }
      // `wait` indica cuándo entra la plaza en el horizonte; la espera total incluye ese horizonte.
      const total = waited + decision.retryMs + (decision.state === "wait" ? policy.horizonMs[purpose] : 0)
      if (decision.state === "cooldown" || total > policy.maxWaitMs[purpose]) {
        state.deferred = true
        state.retryAfterMs = decision.retryMs
        emitSafely(telemetry, "provider.request", { operation: "catalogue.quota", provider, result: "skipped", errorCode: "rate_limited" })
        throw new QuotaDeferredError(decision.retryMs)
      }
      waited += decision.retryMs
      await sleep(decision.retryMs, signal)
    }
    let cooldown: number | undefined
    try {
      await sleep(reservation.waitMs, signal)
      const response = await baseFetch(input, init)
      if (response.status === 429) {
        cooldown = retryAfterMs(response.headers.get("retry-after"))
        state.retryAfterMs = cooldown
      }
      return response
    } finally {
      await store.release(reservation.reservationId, reservation.fence, cooldown).catch(() => {
        emitSafely(telemetry, "provider.request", { operation: "catalogue.quota", provider, result: "error", errorCode: "network" })
      })
    }
  }

  /** Ejecuta el adaptador con el contexto de cuota y traduce una espera de cuota a `rateLimited`. */
  async function run<T>(state: CallState, fetcher: () => Promise<ProviderResult<T[]>>, base: { provider: ProviderId; requestId: string }): Promise<ProviderResult<T[]>> {
    let result: ProviderResult<T[]>
    try {
      result = await calls.run(state, fetcher)
    } catch (error) {
      if (state.deferred) return { ...base, status: "rateLimited", retryAfterSeconds: seconds(state.retryAfterMs) }
      throw error
    }
    if (result.status === "found" || result.status === "notFound") return result
    // Esperar una reserva no es ausencia ni caída: es una cuota que pide volver más tarde.
    if (state.deferred && result.status === "unavailable") return { provider: result.provider, requestId: result.requestId, status: "rateLimited", retryAfterSeconds: seconds(state.retryAfterMs) }
    if (result.status === "rateLimited" && result.retryAfterSeconds === undefined && state.retryAfterMs !== undefined) return { ...result, retryAfterSeconds: seconds(state.retryAfterMs) }
    return result
  }

  function outcomeFor<T>(plan: CachePlan | null, result: ProviderResult<T[]>): CacheOutcome | undefined {
    if (!plan) return undefined
    // Solo ficha o ausencia confirmadas; una caída, un límite o un error nunca se guardan como ausencia.
    if (result.status === "found" && result.value.length) return { status: "found", payload: result.value, provenance: plan.provenance, ttlMs: plan.foundTtlMs }
    if ((result.status === "found" || result.status === "notFound") && plan.notFoundTtlMs > 0) return { status: "notFound", payload: [], provenance: plan.provenance, ttlMs: plan.notFoundTtlMs }
    return undefined
  }

  function fromCache<T>(base: { provider: ProviderId; requestId: string }, status: "found" | "notFound", value: unknown[]): ProviderResult<T[]> {
    emitSafely(telemetry, "provider.request", { operation: "catalogue.cache", provider: base.provider, requestId: base.requestId, result: "ok" })
    // El payload ya se revalidó con el esquema de la operación que lo produjo.
    return status === "found" && value.length ? { ...base, status: "found", value: value as T[] } : { ...base, status: "notFound" }
  }

  const unavailable = (base: { provider: ProviderId; requestId: string }): { provider: ProviderId; requestId: string; status: "unavailable" } => {
    emitSafely(telemetry, "provider.request", { operation: "catalogue.coordination", provider: base.provider, requestId: base.requestId, result: "unavailable" })
    return { ...base, status: "unavailable" }
  }

  async function executePrivate<T>(request: GatewayRequest, fetcher: () => Promise<ProviderResult<T[]>>, state: CallState, base: { provider: ProviderId; requestId: string }): Promise<ProviderResult<T[]>> {
    const plan = cachePlan(request.provider, request.operation, rights)
    if (!plan || !options.privateKeySecret || !request.owner) return run(state, fetcher, base)
    const key: CatalogueKey = { provider: request.provider, policyVersion: plan.policyVersion, scope, schemaVersion: CATALOGUE_CACHE_SCHEMA_VERSION, operation: request.operation, key: privateCacheKey(options.privateKeySecret, request.owner, request.key) }
    let cached: Awaited<ReturnType<CoordinationStore["privateGet"]>>
    try { cached = await store.privateGet(request.owner, key) } catch { return unavailable(base) }
    const value = cached && parseCachedPayload(request.provider, request.operation, request.key, plan.policyVersion, cached.payload)
    if (cached && value) return fromCache(base, cached.status, value)
    const result = await run(state, fetcher, base)
    const outcome = outcomeFor(plan, result)
    if (outcome) await store.privatePut(request.owner, key, outcome).catch(() => false)
    return result
  }

  async function execute<T>(request: GatewayRequest, fetcher: () => Promise<ProviderResult<T[]>>, context: ProviderContext): Promise<ProviderResult<T[]>> {
    try {
      return await executeCoordinated(request, fetcher, context)
    } catch (error) {
      // Tras cancelar o vencer el plazo, el orquestador ya respondió: no se deja un rechazo huérfano.
      if (context.signal.aborted) return { provider: request.provider, requestId: context.requestId, status: "unavailable" }
      throw error
    }
  }

  async function executeCoordinated<T>(request: GatewayRequest, fetcher: () => Promise<ProviderResult<T[]>>, context: ProviderContext): Promise<ProviderResult<T[]>> {
    const base = { provider: request.provider, requestId: context.requestId }
    const state: CallState = { owner: request.owner, purpose: request.purpose ?? "interactive", signal: context.signal }
    await invalidateOnce(request.provider)
    if (request.operation === "searchTitleAuthor") return executePrivate(request, fetcher, state, base)
    if (!isPublicCacheKey(request.key)) return run(state, fetcher, base)
    const plan = cachePlan(request.provider, request.operation, rights)
    const key: CatalogueKey = { provider: request.provider, policyVersion: plan?.policyVersion ?? rights.policy(request.provider).version, scope, schemaVersion: CATALOGUE_CACHE_SCHEMA_VERSION, operation: request.operation, key: request.key }
    let discardFence: string | undefined
    let discarded = 0
    for (;;) {
      context.signal.throwIfAborted()
      let begun: BeginResult
      // Sin coordinación no hay alternativa directa: se informa `unavailable` sin tocar la red.
      try { begun = await store.begin(key, { useCache: plan !== null && discarded < 2, leaseMs, discardFence }) } catch { return unavailable(base) }
      discardFence = undefined
      if (begun.state === "hit") {
        const value = plan && parseCachedPayload(request.provider, request.operation, request.key, plan.policyVersion, begun.payload)
        if (value) return fromCache(base, begun.status, value)
        emitSafely(telemetry, "provider.request", { operation: "catalogue.cache", provider: request.provider, requestId: context.requestId, result: "error", errorCode: "upstream_error" })
        discardFence = begun.fence
        discarded++
        continue
      }
      // Otro proceso resuelve la misma clave: se espera su publicación en lugar de repetir la consulta.
      if (begun.state === "pending") { await sleep(pollMs, context.signal); continue }
      let result: ProviderResult<T[]>
      try {
        result = await run(state, fetcher, base)
      } catch (error) {
        await store.complete(key, begun.fence).catch(() => "stale")
        throw error
      }
      // Si la concesión caducó o la tomó otro trabajador, la base rechaza la publicación (fencing).
      await store.complete(key, begun.fence, outcomeFor(plan, result)).catch(() => "stale")
      return result
    }
  }

  return {
    execute,
    fetch: (input, init) => coordinatedFetch(calls.getStore() ?? { purpose: "batch" }, input, init),
    bind: (context) => (input, init) => coordinatedFetch({ ...context }, input, init),
  }
}

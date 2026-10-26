import type { BeginResult, CacheOutcome, CatalogueKey, CoordinationStore, ReserveRequest, ReserveResult } from "../../lib/bibliographic-catalog/gateway"

// Store de coordinación en memoria con la misma semántica que las funciones biblib.catalogue_* de 0004
// (caché con fencing, consultas en vuelo, reservas por proveedor y dueño, cooldown y caché privada).
// Lo comparten las pruebas del gateway, los flujos de U-BIB-05 y el benchmark con red simulada.
// Las carreras reales entre procesos se prueban contra Postgres en tests/integration/catalogue.

export function memoryStore(clock: { now: number } = { now: 0 }) {
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
export function fakeSleep(clock: { now: number }) {
  return async (milliseconds: number, signal?: AbortSignal) => { signal?.throwIfAborted(); clock.now += Math.max(0, milliseconds) }
}


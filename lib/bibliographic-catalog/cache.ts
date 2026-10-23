import { createHmac } from "node:crypto"
import { z } from "zod"
import { normalizeCandidate } from "./normalize"
import { hasProviderRight, providerRightsPolicy, type ProviderRightsPolicy, type RightsCapability } from "./rights"
import type { ProviderCapability, ProviderId } from "./types"

/** Versión del payload guardado. Cambiarla deja inservibles (y retira) las entradas anteriores. */
export const CATALOGUE_CACHE_SCHEMA_VERSION = 1
export type CatalogOperation = keyof ProviderCapability

export interface RightsSource {
  policy(provider: ProviderId): ProviderRightsPolicy
  allows(policy: ProviderRightsPolicy, capability: RightsCapability): boolean
}
export const publishedRights: RightsSource = { policy: providerRightsPolicy, allows: hasProviderRight }

/** TTL de ausencia por proveedor; sin entrada, una ausencia no se cachea (requiere TTL autorizado). */
const NOT_FOUND_TTL_SECONDS: Partial<Record<ProviderId, number>> = { "open-library": 300 }

export interface CachePlan {
  policyVersion: string
  foundTtlMs: number
  notFoundTtlMs: number
  provenance: Record<string, string>
}

/**
 * Qué se puede guardar de un proveedor y durante cuánto. Exige `cacheMetadata` y `persistMetadata`
 * aprobadas en la versión publicada; las portadas además `previewCover` y un TTL propio. Cualquier
 * capacidad ausente o denegada devuelve `null`: ni se lee ni se escribe caché.
 */
export function cachePlan(provider: ProviderId, operation: CatalogOperation, rights: RightsSource = publishedRights): CachePlan | null {
  const policy = rights.policy(provider)
  if (!rights.allows(policy, "cacheMetadata") || !rights.allows(policy, "persistMetadata")) return null
  const metadataTtl = Math.max(0, policy.metadataTtlSeconds)
  let foundTtl = metadataTtl
  if (operation === "getCover") {
    if (!rights.allows(policy, "previewCover")) return null
    foundTtl = Math.min(metadataTtl, Math.max(0, policy.coverTtlSeconds))
  }
  if (foundTtl <= 0) return null
  const notFoundTtl = Math.min(foundTtl, NOT_FOUND_TTL_SECONDS[provider] ?? 0)
  return { policyVersion: policy.version, foundTtlMs: foundTtl * 1000, notFoundTtlMs: notFoundTtl * 1000, provenance: { provider, policyVersion: policy.version, attribution: policy.attribution } }
}

/** Versión vigente para invalidar; `null` si la política está revocada y deben retirarse todas. */
export function invalidationVersion(provider: ProviderId, rights: RightsSource = publishedRights): string | null {
  const policy = rights.policy(provider)
  return rights.allows(policy, "cacheMetadata") && rights.allows(policy, "persistMetadata") ? policy.version : null
}

const coverSchema = z.object({
  provider: z.enum(["open-library", "bne", "google-books"]), coverKey: z.string().min(1).max(500),
  sourceUrl: z.string().max(2000).optional(), imageUrl: z.string().max(2000).optional(),
  width: z.number().int().min(1).max(20000).optional(), height: z.number().int().min(1).max(20000).optional(),
  rightsPolicyVersion: z.string().min(1).max(100), attribution: z.string().max(500).optional(),
}).strict()

/**
 * Revalida una entrada leída de la base. Una caché malformada, de otro proveedor o de otra versión
 * de política devuelve `null` y se descarta: nunca llega como ficha ni como ausencia.
 */
export function parseCachedPayload(provider: ProviderId, operation: CatalogOperation, key: string, policyVersion: string, payload: unknown): unknown[] | null {
  if (!Array.isArray(payload) || payload.length > 100) return null
  try {
    if (operation === "getCover") {
      return payload.map((value) => {
        const cover = coverSchema.parse(value)
        if (cover.provider !== provider || cover.rightsPolicyVersion !== policyVersion) throw new Error("Portada ajena")
        return cover
      })
    }
    return payload.map((value) => {
      const candidate = normalizeCandidate(value, operation === "lookupISBN" ? key : undefined)
      if (candidate.provider !== provider || (operation === "lookupISBN" && !candidate.evidence.isbnExact)) throw new Error("Ficha ajena")
      return candidate
    })
  } catch {
    return null
  }
}

/** Clave canónica de las operaciones públicas; las de texto libre nunca usan la caché compartida. */
export function isPublicCacheKey(key: string): boolean {
  return key.length >= 1 && key.length <= 200 && /^[A-Za-z0-9:_-]+$/.test(key)
}

/** Reduce una consulta privada a un HMAC por dueño: la base no guarda el texto consultado. */
export function privateCacheKey(secret: string, owner: string, query: string): string {
  return createHmac("sha256", secret).update(JSON.stringify([CATALOGUE_CACHE_SCHEMA_VERSION, owner, query])).digest("hex")
}

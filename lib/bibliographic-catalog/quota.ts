import type { ProviderId } from "./types"

/** Interactivo: búsqueda o portada con alguien esperando. Lote: importación o trabajo en segundo plano. */
export type QuotaPurpose = "interactive" | "batch"

export interface ProviderQuotaPolicy {
  provider: ProviderId
  /** Separación mínima entre peticiones externas del mismo despliegue y ámbito de credencial. */
  intervalMs: number
  /** Duración de una reserva: pasado este plazo deja de contar para el tope por dueño. */
  leaseMs: number
  /** Cuánto puede quedar por delante una plaza para concederla ya; el lote no hace cola por delante de una búsqueda. */
  horizonMs: Record<QuotaPurpose, number>
  /** Espera total aceptable antes de devolver `rateLimited` con `retryAfterSeconds`. */
  maxWaitMs: Record<QuotaPurpose, number>
  /** Reservas activas simultáneas por dueño y propósito (reparto justo). */
  ownerCap: Record<QuotaPurpose, number>
  /** Dominios atendidos (también sus subdominios). Cualquier otro destino queda bloqueado. */
  hosts: readonly string[]
}

export const QUOTA_DEFAULT_COOLDOWN_MS = 30_000
export const QUOTA_MAX_COOLDOWN_MS = 3_600_000

/**
 * Open Library: 1 petición/s por despliegue mientras no haya identificación acordada
 * (https://openlibrary.org/developers/api). BNE tiene su propia política, provisional y más
 * conservadora hasta que U-BIB la valide; nunca hereda la de OL. Google Books no tiene política
 * aprobada: sin entrada aquí no se reserva ni se envía ninguna petición.
 */
const policies: Partial<Record<ProviderId, ProviderQuotaPolicy>> = {
  "open-library": {
    provider: "open-library", intervalMs: 1_000, leaseMs: 10_000,
    horizonMs: { interactive: 2_500, batch: 250 }, maxWaitMs: { interactive: 2_500, batch: 10_000 },
    ownerCap: { interactive: 2, batch: 1 }, hosts: ["openlibrary.org"],
  },
  bne: {
    provider: "bne", intervalMs: 2_000, leaseMs: 15_000,
    horizonMs: { interactive: 2_500, batch: 250 }, maxWaitMs: { interactive: 2_500, batch: 15_000 },
    ownerCap: { interactive: 2, batch: 1 }, hosts: ["bne.es"],
  },
}

export function providerQuotaPolicy(provider: ProviderId): ProviderQuotaPolicy | undefined {
  const policy = policies[provider]
  return policy ? { ...policy, horizonMs: { ...policy.horizonMs }, maxWaitMs: { ...policy.maxWaitMs }, ownerCap: { ...policy.ownerCap } } : undefined
}

/** Proveedor que atiende una URL HTTPS sin credenciales embebidas; `undefined` si no está autorizada. */
export function providerForUrl(url: URL, lookup: (provider: ProviderId) => ProviderQuotaPolicy | undefined = providerQuotaPolicy): ProviderId | undefined {
  if (url.protocol !== "https:" || url.username || url.password) return undefined
  const host = url.hostname.toLowerCase()
  for (const provider of ["open-library", "bne", "google-books"] as const) {
    const policy = lookup(provider)
    if (policy?.hosts.some((domain) => host === domain || host.endsWith(`.${domain}`))) return provider
  }
  return undefined
}

/** `Retry-After` en segundos o fecha HTTP, acotado a una hora; sin cabecera válida, cooldown conservador. */
export function retryAfterMs(header: string | null | undefined, now = Date.now()): number {
  const value = header?.trim()
  let milliseconds = QUOTA_DEFAULT_COOLDOWN_MS
  if (value && /^\d{1,10}$/.test(value)) milliseconds = Number(value) * 1000
  else if (value) {
    const date = Date.parse(value)
    if (Number.isFinite(date)) milliseconds = date - now
  }
  return Math.min(QUOTA_MAX_COOLDOWN_MS, Math.max(1_000, Math.ceil(milliseconds)))
}

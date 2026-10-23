import { BNE_LEGAL_NOTICE_URL, OPEN_LIBRARY_LICENSING_URL } from "./providers/endpoints"
import type { ProviderId } from "./types"

export type RightsCapability = "cacheMetadata" | "persistMetadata" | "exportMetadata" | "previewCover" | "rehostCover" | "backupAsset" | "offlineUse"
export interface ProviderRightsPolicy extends Record<RightsCapability, boolean> {
  provider: ProviderId
  version: string
  metadataTtlSeconds: number
  coverTtlSeconds: number
  attribution: string
  termsUrl: string
}

const denied = { cacheMetadata: false, persistMetadata: false, exportMetadata: false, previewCover: false, rehostCover: false, backupAsset: false, offlineUse: false }
const policies: Record<ProviderId, ProviderRightsPolicy> = {
  "open-library": {
    ...denied, provider: "open-library", version: "2026-10-23.1",
    cacheMetadata: true, persistMetadata: true, exportMetadata: true, previewCover: true,
    metadataTtlSeconds: 3600, coverTtlSeconds: 0,
    attribution: "Metadatos: Open Library. Las imágenes conservan los derechos de sus titulares.",
    termsUrl: OPEN_LIBRARY_LICENSING_URL,
  },
  bne: {
    ...denied, provider: "bne", version: "2026-10-23.2", metadataTtlSeconds: 3600, coverTtlSeconds: 0,
    cacheMetadata: true, persistMetadata: true, exportMetadata: true,
    attribution: "Metadatos CC0: Biblioteca Nacional de España. Conservar URL del registro y fecha de recuperación.",
    termsUrl: BNE_LEGAL_NOTICE_URL,
  },
  "google-books": { ...denied, provider: "google-books", version: "2026-10-23.3", previewCover: true, metadataTtlSeconds: 0, coverTtlSeconds: 0,
    attribution: "Google Books. Portada solo para previsualización temporal; derechos de sus titulares.", termsUrl: "https://developers.google.com/books/terms" },
}

export function providerRightsPolicy(provider: ProviderId): ProviderRightsPolicy {
  return { ...policies[provider] }
}

/** Toda capacidad ausente o política de versión desconocida queda denegada. */
export function hasProviderRight(policy: Partial<ProviderRightsPolicy> | undefined, capability: RightsCapability): boolean {
  const published = policy?.provider ? policies[policy.provider] : undefined
  if (!published || !policy?.version || policy.version !== published.version) return false
  return published[capability] === true && policy[capability] === true
}

import { hasProviderRight, providerRightsPolicy } from "./rights"
import type { BibliographicCandidate, CoverCandidate, ProviderId } from "./types"

// Retención permanente (U-BIB-05). Decide qué puede quedar guardado en la ficha o en una copia de la
// persona; no regula la caché operativa (eso es `cachePlan`) ni la vista previa temporal. Todo se
// deriva de la política versionada: una capacidad ausente o una política desconocida deniega.

/** Metadatos que la persona puede conservar y exportar con su atribución (OL; BNE como CC0). */
export function canRetainMetadata(provider: ProviderId): boolean {
  const policy = providerRightsPolicy(provider)
  return hasProviderRight(policy, "persistMetadata") && hasProviderRight(policy, "exportMetadata")
}

/**
 * Una portada solo queda en `Book.cover` si su fuente permite previsualizarla y conservar sus datos.
 * Google queda fuera (solo vista previa temporal) y BNE también: su CC0 cubre metadatos, no imágenes.
 */
export function canRetainCover(provider: ProviderId): boolean {
  return hasProviderRight(providerRightsPolicy(provider), "previewCover") && canRetainMetadata(provider)
}

export function retainableCovers(candidates: readonly CoverCandidate[]): CoverCandidate[] {
  return candidates.filter((candidate) => canRetainCover(candidate.provider))
}

export function retainableCandidates(candidates: readonly BibliographicCandidate[]): BibliographicCandidate[] {
  return candidates.filter((candidate) => canRetainMetadata(candidate.provider))
}

/** Fuentes que pueden constar en la procedencia de una ficha guardada (Google nunca). */
export type RetainedProvider = Exclude<ProviderId, "google-books">

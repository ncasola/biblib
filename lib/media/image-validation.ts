import { AssetRejectedError, type AssetRejection } from "../assets/contracts"
import { validateAndNormalizeImage } from "../assets/image-validation"
import { DomainError } from "../domain-errors"
import { MEDIA_LIMITS, type MediaKind } from "../product/contracts"

const mebibytes = (bytes: number) => `${bytes / 1_048_576} MiB`

// Los mensajes de rechazo de portadas citan sus límites («5 MiB», «10 megapíxeles») y la palabra «portada»;
// avatar, ubicación y evidencia tienen los suyos (MEDIA_LIMITS), así que se traducen aquí.
function mediaRejection(kind: MediaKind, reason: AssetRejection): string | null {
  if (reason === "TOO_LARGE") return `La imagen supera el tamaño máximo de ${mebibytes(MEDIA_LIMITS.maxBytes[kind])}.`
  if (reason === "TOO_MANY_PIXELS") return `La imagen supera las dimensiones admitidas (${MEDIA_LIMITS.maxSide[kind]} px por lado).`
  if (reason === "MARKUP") return "El archivo contiene SVG, HTML o XML y no se admite como imagen."
  return null
}

/** Mismos controles de firma, políglotas, animación y decodificación que las portadas. */
export async function normalizeMediaImage(kind: MediaKind, bytes: Uint8Array, declaredType?: string) {
  try {
    return await validateAndNormalizeImage(bytes, { declaredType, limits: {
      maxBytes: MEDIA_LIMITS.maxBytes[kind], maxDimension: MEDIA_LIMITS.maxSide[kind],
      maxPixels: MEDIA_LIMITS.maxSide[kind] ** 2,
      outputMaxWidth: MEDIA_LIMITS.maxSide[kind], outputMaxHeight: MEDIA_LIMITS.maxSide[kind],
    } })
  } catch (error) {
    const message = error instanceof AssetRejectedError ? mediaRejection(kind, error.reason) : null
    if (message) throw new DomainError("ASSET_REJECTED", message)
    throw error
  }
}

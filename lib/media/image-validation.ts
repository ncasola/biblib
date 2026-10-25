import { validateAndNormalizeImage } from "../assets/image-validation"
import { MEDIA_LIMITS, type MediaKind } from "../product/contracts"

/** Mismos controles de firma, políglotas, animación y decodificación que las portadas. */
export function normalizeMediaImage(kind: MediaKind, bytes: Uint8Array, declaredType?: string) {
  return validateAndNormalizeImage(bytes, { declaredType, limits: {
    maxBytes: MEDIA_LIMITS.maxBytes[kind], maxDimension: MEDIA_LIMITS.maxSide[kind],
    maxPixels: MEDIA_LIMITS.maxSide[kind] ** 2,
    outputMaxWidth: MEDIA_LIMITS.maxSide[kind], outputMaxHeight: MEDIA_LIMITS.maxSide[kind],
  } })
}

import { AssetRejectedError, type AssetRejection } from "../assets/contracts"
import { validateAndNormalizeImage, type NormalizedImage } from "../assets/image-validation"
import { DomainError } from "../domain-errors"
import { MEDIA_LIMITS, type MediaKind } from "../product/contracts"

// Normalización de las imágenes privadas de 0014 (avatar, foto de ubicación, foto fuente), sin `server-only` para poder
// probarla sin el stack. Misma validación que las portadas de U-DAT-10 (firma, marcado, políglotas, decodificación real
// con sharp) y reencodificación a WebP sin metadatos: EXIF, GPS, XMP e ICC del original nunca llegan al bucket.

/** Píxeles de entrada admitidos (una foto de móvil de 12 MP cabe) y lado máximo del WebP guardado, dentro del límite de 0014. */
export const MEDIA_INPUT_MAX_PIXELS = 16_000_000
export const MEDIA_OUTPUT_MAX_SIDE: Readonly<Record<MediaKind, number>> = { avatar: 512, location: 2048, evidence: 2048 }

const REJECTIONS: Partial<Record<AssetRejection, string>> = {
  TOO_LARGE: "La imagen supera el tamaño máximo de 5 MiB.",
  MARKUP: "El archivo contiene SVG, HTML o XML y no se admite como imagen.",
  TOO_MANY_PIXELS: "La imagen supera los 16 megapíxeles o las dimensiones admitidas.",
}

/**
 * Valida la firma, el contenido y la decodificación real y devuelve un WebP nuevo, orientado y sin metadatos, con su
 * sha256. Entrada de hasta 5 MiB para todos los tipos; el resultado cumple además el límite del tipo (avatar ≤ 1 MiB y
 * 1024 px). Un rechazo es `ASSET_REJECTED` con su motivo.
 */
export async function normalizeMedia(kind: MediaKind, input: Uint8Array, declaredType?: string): Promise<NormalizedImage> {
  const side = MEDIA_OUTPUT_MAX_SIDE[kind]
  try {
    const image = await validateAndNormalizeImage(input, {
      declaredType,
      limits: { maxBytes: MEDIA_LIMITS.maxBytes.location, maxPixels: MEDIA_INPUT_MAX_PIXELS, outputMaxWidth: side, outputMaxHeight: side },
    })
    if (image.bytes > MEDIA_LIMITS.maxBytes[kind] || image.width > MEDIA_LIMITS.maxSide[kind] || image.height > MEDIA_LIMITS.maxSide[kind]) throw new AssetRejectedError("TOO_LARGE")
    return image
  } catch (error) {
    if (error instanceof AssetRejectedError && REJECTIONS[error.reason]) throw new DomainError("ASSET_REJECTED", REJECTIONS[error.reason]!)
    throw error
  }
}

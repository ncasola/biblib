import { createHash } from "node:crypto"
import sharp from "sharp"
import { ASSET_LIMITS, AssetRejectedError, type AcceptedImageType } from "./contracts"

// Validación y normalización de imágenes (U-DAT-10). Ningún byte llega a sharp sin pasar antes la
// firma: SVG, HTML, XML y cualquier formato que no sea JPEG, PNG o WebP se rechazan sin decodificar.
// Después se decodifica de verdad con límite de píxeles y plazo, y la salida es siempre un WebP nuevo
// sin metadatos (EXIF, XMP, ICC de terceros, comentarios) ni datos añadidos tras la imagen.

export type ImageFormat = "jpeg" | "png" | "webp"

const FORMAT_TYPE: Record<ImageFormat, AcceptedImageType> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }

export interface ValidationLimits {
  maxBytes: number
  maxPixels: number
  maxDimension: number
  decodeTimeoutMs: number
  outputMaxWidth: number
  outputMaxHeight: number
  webpQuality: number
}

export interface NormalizedImage {
  webp: Buffer
  width: number
  height: number
  bytes: number
  sha256: string
  inputFormat: ImageFormat
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])

/** Formato por su firma (magic bytes); el nombre, la extensión o el tipo declarado no cuentan. */
export function sniffImage(bytes: Uint8Array): ImageFormat | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg"
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return "png"
  if (buffer.length >= 12 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") return "webp"
  return null
}

const MARKUP = [/<\s*svg[\s>/]/i, /<\s*\?xml/i, /<\s*!doctype/i, /<\s*html[\s>]/i, /<\s*script[\s>]/i, /<\s*body[\s>]/i, /<\s*iframe[\s>]/i]

/** Marcado (SVG, XML o HTML) en cualquier parte del archivo, también en comentarios o metadatos. */
export function containsMarkup(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1")
  return MARKUP.some((pattern) => pattern.test(text))
}

/**
 * Datos tras el final de la imagen: lo típico de un archivo políglota (una imagen válida seguida de
 * un ZIP, un HTML o un script). JPEG termina en EOI, PNG en IEND y WebP en el tamaño de su RIFF.
 */
export function hasTrailingData(bytes: Uint8Array, format: ImageFormat): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (format === "png") {
    const end = buffer.lastIndexOf(PNG_IEND)
    return end < 0 || end + PNG_IEND.length !== buffer.length
  }
  if (format === "webp") {
    const declared = buffer.readUInt32LE(4) + 8
    return declared !== buffer.length && !(declared + 1 === buffer.length && buffer[buffer.length - 1] === 0)
  }
  let end = buffer.length
  // Algunos equipos rellenan con ceros tras EOI: se admite ese relleno, nada más.
  while (end > 2 && buffer[end - 1] === 0) end--
  return !(buffer[end - 2] === 0xff && buffer[end - 1] === 0xd9)
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AssetRejectedError("DECODE_FAILED")), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function decodeError(error: unknown): AssetRejectedError {
  if (error instanceof AssetRejectedError) return error
  const message = error instanceof Error ? error.message : ""
  return new AssetRejectedError(/pixel limit|exceeds/i.test(message) ? "TOO_MANY_PIXELS" : "DECODE_FAILED")
}

/**
 * Comprueba firma, tipo declarado (si lo hay), marcado, datos añadidos, dimensiones y decodificación
 * real, y devuelve un WebP nuevo con su sha256. Cualquier fallo es `ASSET_REJECTED` con su motivo.
 */
export async function validateAndNormalizeImage(input: Uint8Array, options: { declaredType?: string; limits?: Partial<ValidationLimits> } = {}): Promise<NormalizedImage> {
  const limits: ValidationLimits = { ...ASSET_LIMITS, ...options.limits }
  if (!input.byteLength) throw new AssetRejectedError("EMPTY")
  if (input.byteLength > limits.maxBytes) throw new AssetRejectedError("TOO_LARGE")
  if (containsMarkup(input.subarray(0, 1024))) throw new AssetRejectedError("MARKUP")
  const format = sniffImage(input)
  if (!format) throw new AssetRejectedError("UNSUPPORTED_TYPE")
  if (options.declaredType !== undefined && options.declaredType.split(";")[0].trim().toLowerCase() !== FORMAT_TYPE[format]) throw new AssetRejectedError("MIME_MISMATCH")
  if (containsMarkup(input)) throw new AssetRejectedError("MARKUP")
  if (hasTrailingData(input, format)) throw new AssetRejectedError("POLYGLOT")

  const decoderOptions = { limitInputPixels: limits.maxPixels, failOn: "error" as const, animated: false, sequentialRead: true }
  // Solo la cabecera: dimensiones y páginas antes de decodificar los píxeles.
  const metadata = await withTimeout(sharp(input, decoderOptions).metadata(), limits.decodeTimeoutMs).catch((error: unknown) => { throw decodeError(error) })
  if (metadata.format !== format) throw new AssetRejectedError("UNSUPPORTED_TYPE")
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (!width || !height || width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels) throw new AssetRejectedError("TOO_MANY_PIXELS")
  if ((metadata.pages ?? 1) > 1) throw new AssetRejectedError("ANIMATED")

  const output = await withTimeout(sharp(input, decoderOptions)
    .rotate()
    .resize({ width: limits.outputMaxWidth, height: limits.outputMaxHeight, fit: "inside", withoutEnlargement: true })
    .webp({ quality: limits.webpQuality, effort: 4 })
    .toBuffer({ resolveWithObject: true }), limits.decodeTimeoutMs).catch((error: unknown) => { throw decodeError(error) })
  if (output.info.format !== "webp" || output.data.length > limits.maxBytes) throw new AssetRejectedError("TOO_LARGE")
  return {
    webp: output.data, width: output.info.width, height: output.info.height, bytes: output.data.length,
    sha256: createHash("sha256").update(output.data).digest("hex"), inputFormat: format,
  }
}

/** Imagen ficticia y determinista para el modo `fixture`: cero red, un color por clave. */
export async function fixtureCoverBytes(seed: string): Promise<Buffer> {
  const digest = createHash("sha256").update(seed).digest()
  return sharp({ create: { width: 240, height: 360, channels: 3, background: { r: digest[0], g: digest[1], b: digest[2] } } }).jpeg({ quality: 80 }).toBuffer()
}

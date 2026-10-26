import { hasProviderRight, providerRightsPolicy, type ProviderRightsPolicy } from "../bibliographic-catalog/rights"
import type { ProviderId } from "../bibliographic-catalog/types"
import { DomainError } from "../domain-errors"
import { normalizeIsbn } from "../isbn"

// Contrato de los assets privados (U-DAT-10): bucket, límites, claves de proveedor, derechos y vistas.
// Funciones puras compartidas por las acciones, el ejecutor, la ruta de lectura y las pruebas. Las
// funciones SQL de 0009 aplican las mismas cuotas bajo bloqueo; estas son su referencia probada.

/** Bucket privado de portadas. Lo crea 0009 (`biblib.cover_storage_install`); nunca el seed de fixtures. */
export const COVER_BUCKET = "biblib-covers"

/** Primera configuración medible; un aumento exige pruebas y configuración, nunca una opción del cliente. */
export const ASSET_LIMITS = Object.freeze({
  /** Bytes por descarga o subida, contados en streaming (no se confía en Content-Length). */
  maxBytes: 5 * 1024 * 1024,
  maxPixels: 10_000_000,
  maxDimension: 10_000,
  downloadTimeoutMs: 8_000,
  /** Presupuesto de decodificación y reencodificación medido con sharp (docs/operacion.md). */
  decodeTimeoutMs: 5_000,
  outputMaxWidth: 1_200,
  outputMaxHeight: 1_800,
  webpQuality: 82,
})

/** Cuotas por dueño; las mismas que `biblib.cover_asset_quota`. */
export const ASSET_QUOTAS = Object.freeze({ quarantine: 5, stored: 500, storedBytes: 200 * 1024 * 1024 })

/** Un asset sin fichas ni versiones anteriores que lo citen se conserva este tiempo antes de purgarlo. */
export const PURGE_GRACE_SECONDS = 24 * 60 * 60

/** Versión de la política de una imagen propia: la persona declara que puede conservarla. */
export const UPLOAD_POLICY_VERSION = "upload.v1"

export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const
export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number]

/** Despliegue por etapas: `off` conserva la lectura de assets existentes y detiene subidas y adquisiciones. */
export type CoverAssetsMode = "off" | "uploads" | "full"

export function readCoverAssetsMode(env: Readonly<Record<string, string | undefined>> = process.env): CoverAssetsMode {
  const value = env.BIBLIB_COVER_ASSETS ?? ""
  if (value === "") return "full"
  if (value === "off" || value === "uploads" || value === "full") return value
  throw new DomainError("INVALID_INPUT", "La configuración de portadas privadas no es válida.")
}

/**
 * Clave de portada de un proveedor, validada por el servidor. Nunca es una URL: el host y la ruta
 * salen de la clave (`fetch-policy.ts`), así que el cliente no puede elegir destino.
 */
export interface ProviderCoverKey {
  provider: ProviderId
  kind: "id" | "isbn" | "olid"
  value: string
  /** Forma canónica que se guarda en `cover_assets.source_ref`. */
  ref: string
}

const KEY_PATTERN = /^(open-library|bne|google-books):(id|isbn|olid):([A-Za-z0-9-]{1,40})$/

export function parseProviderCoverKey(input: unknown): ProviderCoverKey | null {
  if (typeof input !== "string" || input.length > 80) return null
  const match = KEY_PATTERN.exec(input)
  if (!match) return null
  const [, provider, kind, raw] = match as unknown as [string, ProviderId, ProviderCoverKey["kind"], string]
  let value = raw
  if (kind === "id" && provider === "open-library" && !/^[1-9]\d{0,11}$/.test(raw)) return null
  if (kind === "olid" && !/^OL[1-9]\d{0,10}M$/.test(raw)) return null
  if (kind === "isbn") {
    const isbn = normalizeIsbn(raw)
    if (!isbn) return null
    value = isbn
  }
  return { provider, kind, value, ref: `${provider}:${kind}:${value}` }
}

/** Clave de una portada de Open Library a partir de su URL pública; cualquier otra URL no tiene clave. */
export function providerCoverKeyFromUrl(url: string | undefined | null, coversHost: string): ProviderCoverKey | null {
  if (!url) return null
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== "https:" || parsed.hostname !== coversHost || parsed.port !== "" || parsed.search || parsed.hash) return null
  const match = /^\/b\/(id|isbn|olid)\/([A-Za-z0-9-]{1,40})-[SML]\.jpg$/.exec(parsed.pathname)
  return match ? parseProviderCoverKey(`open-library:${match[1]}:${match[2]}`) : null
}

export type RightsResolver = (provider: ProviderId) => ProviderRightsPolicy

/**
 * Capacidades vigentes de un proveedor para sus portadas. Copiar exige `rehostCover`; incluirla en un
 * respaldo, además, `backupAsset`. Una política ausente o de versión desconocida lo deniega todo.
 */
export function coverAssetRights(provider: ProviderId, rights?: RightsResolver) {
  const policy = rights ? rights(provider) : providerRightsPolicy(provider)
  // Sin resolutor se exige la política publicada (`hasProviderRight`); las pruebas inyectan la suya.
  const allowed = (capability: "rehostCover" | "backupAsset" | "offlineUse") => rights
    ? policy.provider === provider && Boolean(policy.version) && policy[capability] === true
    : hasProviderRight(policy, capability)
  return { policy, rehost: allowed("rehostCover"), backup: allowed("rehostCover") && allowed("backupAsset"), offline: allowed("rehostCover") && allowed("offlineUse") }
}

/** Una licencia con TTL caduca; `coverTtlSeconds: 0` significa sin caducidad para una copia autorizada. */
export function licenseExpiry(policy: Pick<ProviderRightsPolicy, "coverTtlSeconds">, now: Date): Date | null {
  return policy.coverTtlSeconds > 0 ? new Date(now.getTime() + policy.coverTtlSeconds * 1000) : null
}

/** Ruta del objeto: el dueño, el asset y el intento autorizado. El servidor la deriva; nunca el cliente. */
export function coverStorageKey(owner: string, assetId: string, attempt: string): string {
  if (!UUID.test(owner) || !UUID.test(assetId) || !/^[A-Za-z0-9_-]{1,64}$/.test(attempt)) throw new Error("Clave de objeto no válida.")
  return `${owner}/${assetId}/${attempt}.webp`
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Lectura autenticada desde el propio origen: la CSP no necesita hosts nuevos. */
export function coverAssetUrl(assetId: string): string {
  return `/api/covers/${assetId}`
}

export type AssetRejection =
  | "EMPTY" | "TOO_LARGE" | "UNSUPPORTED_TYPE" | "MIME_MISMATCH" | "MARKUP" | "POLYGLOT" | "TOO_MANY_PIXELS" | "DECODE_FAILED" | "ANIMATED"
  | "HOST_NOT_ALLOWED" | "PORT_NOT_ALLOWED" | "ADDRESS_BLOCKED" | "REDIRECT" | "CONTENT_TYPE" | "RIGHTS_DENIED"

const REJECTION_MESSAGES: Record<AssetRejection, string> = {
  EMPTY: "El archivo está vacío.",
  TOO_LARGE: "La imagen supera el tamaño máximo de 5 MiB.",
  UNSUPPORTED_TYPE: "Solo se admiten imágenes JPEG, PNG o WebP.",
  MIME_MISMATCH: "El tipo declarado del archivo no coincide con su contenido.",
  MARKUP: "El archivo contiene SVG, HTML o XML y no se admite como portada.",
  POLYGLOT: "El archivo contiene datos ajenos a la imagen y no se admite.",
  TOO_MANY_PIXELS: "La imagen supera los 10 megapíxeles o las dimensiones admitidas.",
  DECODE_FAILED: "La imagen está dañada o no se puede leer.",
  ANIMATED: "No se admiten imágenes animadas.",
  HOST_NOT_ALLOWED: "Esa fuente de portadas no está autorizada.",
  PORT_NOT_ALLOWED: "Esa fuente de portadas no está autorizada.",
  ADDRESS_BLOCKED: "Esa fuente de portadas no está autorizada.",
  REDIRECT: "La fuente respondió con una redirección; no se sigue por seguridad.",
  CONTENT_TYPE: "La fuente no devolvió una imagen admitida.",
  RIGHTS_DENIED: "Las condiciones de esta fuente no permiten guardar una copia privada de su portada.",
}

/** Rechazo definitivo de un archivo o un destino. La portada visible no cambia. */
export class AssetRejectedError extends DomainError {
  constructor(readonly reason: AssetRejection) {
    super("ASSET_REJECTED", REJECTION_MESSAGES[reason])
    this.name = "AssetRejectedError"
  }
}

export type CoverAssetState = "quarantine" | "ready" | "restored"

/** Vista del asset para su dueño: sin rutas de Storage, tokens ni URL firmadas. */
export interface CoverAssetView {
  id: string
  state: CoverAssetState
  sourceKind: "provider" | "upload"
  width: number | null
  height: number | null
  bytes: number | null
  attribution: string | null
  createdAt: string
  /** Solo para assets utilizables: la ruta autenticada del propio origen. */
  url: string | null
}

export interface CoverAssetJobView {
  jobId: string
  assetId: string | null
  state: string
  version: string
  /** Código técnico del fallo o del omitido (`RIGHTS_DENIED`, `CHANGED`…); nunca un cuerpo del proveedor. */
  errorCode: string | null
  attached: boolean
  deduplicated: boolean
  nextAttemptAt: string | null
}

/** Capacidades de portada de una ficha para la interfaz, calculadas en el servidor. */
export interface BookCoverAssetState {
  mode: CoverAssetsMode
  current: CoverAssetView | null
  /** Clave validada de la portada actual del proveedor, solo si su política vigente permite copiarla. */
  providerCoverKey: string | null
  canUpload: boolean
  quota: { stored: number; storedBytes: number; limit: number; limitBytes: number }
}

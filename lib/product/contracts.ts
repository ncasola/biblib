// Contratos de datos de producto de O13 (lote D, migración 0014): etiquetas, notas y valoración (U-PRO-01),
// ubicaciones físicas (U-PRO-03), series (U-PRO-05) y assets privados de imagen con el perfil y su avatar
// (U-EXP-06). Solo tipos, límites y funciones puras: los usan el schema, el formato v2 y las unidades, en el
// servidor y en el navegador. Los límites son los mismos que imponen las restricciones y triggers de 0014;
// cambiarlos exige una migración. Documentación: docs/spec-pendientes/contratos-o13.md.

/** Código SQLSTATE de un límite por cuenta o por ejemplar alcanzado (trigger `biblib.enforce_row_limit`). */
export const PRODUCT_LIMIT_SQLSTATE = "BP001"
/** Ciclo en el árbol de ubicaciones (`biblib.guard_location_tree`). */
export const LOCATION_CYCLE_SQLSTATE = "BL001"
/** Árbol de ubicaciones más profundo que `LOCATION_LIMITS.maxDepth`. */
export const LOCATION_DEPTH_SQLSTATE = "BL002"
/** Referencia a un asset privado que no es del dueño, no está listo o es de otro tipo (`biblib.guard_media_reference`). */
export const MEDIA_REFERENCE_SQLSTATE = "BA010"

// ── U-PRO-01 · Etiquetas, notas y valoración (por ejemplar) ─────────────────────────────────────────

export const TAG_LIMITS = Object.freeze({ nameMax: 40, perCopy: 20, perAccount: 1000 })
export const NOTES_MAX = 4000
export const COPY_RATINGS = [1, 2, 3, 4, 5] as const
export type CopyRating = (typeof COPY_RATINGS)[number]

/**
 * Forma comparable de un nombre de etiqueta, idéntica a `biblib.tag_normalize` (0014): espacios colapsados,
 * sin diacríticos salvo la tilde de la ñ, y en minúsculas. «Novela», «novela» y «Nóvela» son la misma etiqueta;
 * «año» y «ano» no. La unicidad por cuenta vive en `tags.normalized_name` (columna generada).
 */
export function normalizeTagName(name: string): string {
  const PROTECTED_N = ""
  return name.trim().replace(/\s+/g, " ").normalize("NFD")
    .replace(/[nN]̃/g, PROTECTED_N)
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replaceAll(PROTECTED_N, "ñ")
    .normalize("NFC")
}

/** Nombre visible válido (como `tags_name_check`): 1–40 caracteres, sin espacios en los extremos ni caracteres de control. */
export function isValidTagName(name: string): boolean {
  const length = [...name].length
  // eslint-disable-next-line no-control-regex
  return length >= 1 && length <= TAG_LIMITS.nameMax && !name.startsWith(" ") && !name.endsWith(" ") && !/[\u0000-\u001f\u007f-\u009f]/.test(name)
}

export interface Tag {
  id: string
  name: string
  normalizedName: string
  version: string
}

/** Datos personales de un ejemplar. Ausente o vacío: sin nota, sin valoración y sin etiquetas. */
export interface CopyPersonal {
  /** Nota privada, 1–4000 caracteres. */
  notes?: string
  /** Valoración entera 1–5; sin valoración, ausente (en la base, `null`). */
  rating?: CopyRating
  /** Etiquetas de la cuenta, hasta 20 por ejemplar. */
  tagIds?: string[]
}

// ── U-PRO-03 · Ubicación física ─────────────────────────────────────────────────────────────────────

/** Tipos de ubicación: habitación, estantería (mueble), armario, caja, balda y otra. */
export const LOCATION_KINDS = ["room", "bookcase", "cabinet", "box", "shelf", "other"] as const
export type LocationKind = (typeof LOCATION_KINDS)[number]

export const LOCATION_KIND_LABELS: Readonly<Record<LocationKind, string>> = {
  room: "Habitación", bookcase: "Estantería", cabinet: "Armario", box: "Caja", shelf: "Balda", other: "Otra",
}

export const LOCATION_LIMITS = Object.freeze({ nameMax: 120, perAccount: 500, maxDepth: 8, shelfLabelMax: 60, positionMax: 100_000 })

/** Nodo del árbol de ubicaciones de la cuenta. La estantería lógica (`shelf_id`) es otra cosa y no cambia. */
export interface PhysicalLocation {
  id: string
  name: string
  kind: LocationKind
  /** Ubicación que la contiene, del mismo dueño; `null` en la raíz. Sin ciclos ni más de 8 niveles. */
  parentId: string | null
  /** Foto general del mueble o de referencia: asset privado propio de tipo `location`. */
  photoAssetId?: string
  version?: string
}

/** Ubicación actual de un ejemplar (una como máximo). La posición es manual: nadie la renumera. */
export interface CopyLocationRef {
  locationId: string
  /** Balda o hueco legible («Balda 3»), 1–60 caracteres. */
  shelfLabel?: string
  /** Posición manual 1–100000. */
  position?: number
}

// ── U-PRO-05 · Series ───────────────────────────────────────────────────────────────────────────────

export const SERIES_LIMITS = Object.freeze({ titleMax: 300, descriptionMax: 2000, perAccount: 1000, volumeLabelMax: 40, orderNoteMax: 200 })

/**
 * Posición exacta en una serie como texto decimal (`NUMERIC` en la base, nunca un flotante): 0 ≤ posición < 1000000
 * con hasta 4 decimales, sin ceros a la izquierda. «1», «1.5» y «2» ordenan exactamente.
 */
export const SERIES_POSITION_PATTERN = /^(0|[1-9]\d{0,5})(\.\d{1,4})?$/

/** Forma canónica de una posición (sin ceros finales en los decimales); `null` si no es válida. */
export function canonicalSeriesPosition(value: string): string | null {
  if (!SERIES_POSITION_PATTERN.test(value)) return null
  const [whole, fraction = ""] = value.split(".")
  const trimmed = fraction.replace(/0+$/, "")
  return trimmed ? `${whole}.${trimmed}` : whole
}

/** Compara dos posiciones exactas; sin posición (orden desconocido) va al final. */
export function compareSeriesPositions(a: string | null | undefined, b: string | null | undefined): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1
  const [aw, af = ""] = a.split(".")
  const [bw, bf = ""] = b.split(".")
  if (aw.length !== bw.length) return aw.length - bw.length
  if (aw !== bw) return aw < bw ? -1 : 1
  const width = Math.max(af.length, bf.length)
  const left = af.padEnd(width, "0"), right = bf.padEnd(width, "0")
  return left === right ? 0 : left < right ? -1 : 1
}

export interface Series {
  id: string
  title: string
  description?: string
  version?: string
}

/** Pertenencia de una edición a una serie (cero o una). No se deduce del ISBN ni del título. */
export interface EditionSeriesRef {
  seriesId: string
  /** Posición exacta (`SERIES_POSITION_PATTERN`); ausente si el orden es desconocido. */
  position?: string
  volumeLabel?: string
  orderNote?: string
}

// ── U-EXP-06 / U-PRO-03 / U-DAT-07 · Assets privados de imagen ─────────────────────────────────────

export const MEDIA_BUCKET = "biblib-media"
/** `avatar` (U-EXP-06), foto de una ubicación (U-PRO-03) o foto fuente de una evidencia (U-DAT-07). */
export const MEDIA_KINDS = ["avatar", "location", "evidence"] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]
export type MediaAssetState = "quarantine" | "ready"

/**
 * Límites de 0014. El servidor reencodifica toda imagen a WebP (sin EXIF ni GPS) antes de subirla: el bucket solo
 * admite `image/webp`. La cuarentena de una subida caduca a los 15 minutos.
 */
export const MEDIA_LIMITS = Object.freeze({
  mime: "image/webp" as const,
  maxBytes: Object.freeze({ avatar: 1_048_576, location: 5_242_880, evidence: 5_242_880 } satisfies Record<MediaKind, number>),
  maxSide: Object.freeze({ avatar: 1024, location: 4096, evidence: 4096 } satisfies Record<MediaKind, number>),
  quarantineMinutes: 15,
  quarantinePerAccount: 5,
  readyPerAccount: 500,
  readyBytesPerAccount: 209_715_200,
})

/** Ruta del objeto en el bucket privado: `{user_id}/{kind}/{asset_id}` (el avatar: `{user_id}/avatar/{asset_id}`). */
export function mediaStorageKey(userId: string, kind: MediaKind, assetId: string): string {
  return `${userId}/${kind}/${assetId}`
}

export interface MediaAsset {
  id: string
  kind: MediaKind
  state: MediaAssetState
  storageKey: string
  sha256: string | null
  bytes: number | null
  width: number | null
  height: number | null
  version: string
}

/**
 * Referencia a un asset privado propio. Al importar o restaurar solo se conserva si ese asset sigue siendo del dueño,
 * está listo, es del tipo esperado y (si viene `sha256`, siempre en v2) tiene los mismos bytes; si no, la entidad se
 * importa sin foto. Los bytes nunca viajan en el JSON.
 */
export interface MediaRef {
  assetId: string
  sha256?: string
}

// ── Entradas de la cuenta en la colección portable (LibraryData, v2 y versiones anteriores) ─────────

/** Etiqueta de la cuenta tal como viaja: la forma normalizada la recalcula Postgres. */
export interface TagEntry {
  id: string
  name: string
  /** Solo en versiones anteriores: fecha de alta que conserva la restauración. */
  createdAt?: string
}

export interface LocationEntry {
  id: string
  name: string
  kind: LocationKind
  parentId: string | null
  photo?: MediaRef
  createdAt?: string
}

export interface SeriesEntry {
  id: string
  title: string
  description?: string
  createdAt?: string
}

/** Respuestas de `biblib.media_asset_begin_upload`, `_register` y `_discard` (0014). */
export type MediaBeginResult =
  | { status: "created"; asset_id: string; storage_key: string }
  | { status: "quota"; quota: "quarantine" | "stored" }
  | { status: "inactive" }
export type MediaRegisterResult =
  | { status: "ready"; asset_id: string }
  | { status: "not_found" | "inactive" | "stale" | "missing_object" | "invalid" }
export type MediaDiscardResult =
  | { status: "discarded"; storage_key: string }
  | { status: "referenced" | "not_found" }

/** Perfil privado (U-EXP-06). La metadata OAuth de Google no cambia: el avatar propio vive aquí. */
export interface Profile {
  /** Asset `avatar` listo del dueño, o `null` (se muestra el de Google o las iniciales). */
  avatarAssetId: string | null
  /** Ruta privada del avatar (`{user_id}/avatar/{asset_id}`), derivada del asset; nunca una URL pública. */
  avatarPath: string | null
  version: string
}

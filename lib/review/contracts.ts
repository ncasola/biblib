import type { MediaRef } from "../product/contracts"

// Contratos de la bandeja de revisión bibliográfica (U-DAT-07) en 0014: evidencias, incidencias y decisiones.
// Solo tipos, límites y valores admitidos; las acciones y la interfaz son de la unidad. La confianza es una etiqueta
// con alcance, nunca un porcentaje, y ninguna evidencia de proveedor ni foto activa por sí sola la comprobación
// física (`isbnVerified` del ejemplar). Documentación: docs/spec-pendientes/contratos-o13.md.

/** Origen de la afirmación: un proveedor bibliográfico, una foto propia, la persona o una importación. */
export const EVIDENCE_SOURCE_KINDS = ["provider", "photo", "manual", "import"] as const
export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number]

/** Confianza con alcance: provisional, coincide con un registro bibliográfico o comprobada frente al ejemplar físico. */
export const CONFIDENCE_LABELS = ["provisional", "bibliographic_match", "physically_checked"] as const
export type ConfidenceLabel = (typeof CONFIDENCE_LABELS)[number]

/** Quién creó la evidencia: el backfill de 0014 (procedencia anterior), la revisión o una importación. */
export const EVIDENCE_ORIGINS = ["backfill", "review", "import"] as const
export type EvidenceOrigin = (typeof EVIDENCE_ORIGINS)[number]

export const EVIDENCE_LIMITS = Object.freeze({ sourceRefMax: 200, sourceUrlMax: 2048, fieldClaimsBytes: 16_384, perSubject: 50 })
/** `source_ref`: clave opaca (registro de proveedor, referencia de foto…), nunca una URL ni una ruta de Storage. */
export const EVIDENCE_SOURCE_REF_PATTERN = /^[A-Za-z0-9:._-]{1,200}$/

/**
 * Evidencia bibliográfica de una edición o de un ejemplar (exactamente uno). `physically_checked` solo existe en un
 * ejemplar. Una foto fuente es una referencia privada a un asset `evidence` del dueño; nunca una ruta pública.
 */
export interface EvidenceEntry {
  id: string
  sourceKind: EvidenceSourceKind
  sourceRef?: string
  /** Solo la URL que ya constaba en la procedencia; nunca se fabrica. */
  sourceUrl?: string
  photo?: MediaRef
  /** Momento en que se observó la fuente (ISO 8601), si se conoce; nunca se inventa. */
  observedAt?: string
  /** Afirmaciones por campo (procedencia por campo de `catalogue.fields`, valores elegidos…), objeto ≤ 16 KiB. */
  fieldClaims: Record<string, unknown>
  confidence: ConfidenceLabel
  origin?: EvidenceOrigin
}

export const REVIEW_REASONS = [
  "provisional", "missing_isbn", "invalid_isbn", "missing_cover", "isbn_conflict", "duplicate_candidate", "photo_doubt", "source_conflict",
] as const
export type ReviewReason = (typeof REVIEW_REASONS)[number]

export const REVIEW_STATES = ["open", "resolved", "ignored"] as const
export type ReviewState = (typeof REVIEW_STATES)[number]

export const REVIEW_DECISION_KINDS = ["accept_fields", "ignore", "confirm_physical", "merge", "reopen"] as const
export type ReviewDecisionKind = (typeof REVIEW_DECISION_KINDS)[number]

export const REVIEW_LIMITS = Object.freeze({ entityRefs: 50, evidenceRefs: 50, selectedFieldsBytes: 16_384, openPerAccount: 5000, batch: 50 })
/** Clave de deduplicación de una incidencia abierta (p. ej. `missing_isbn:<copy_id>`). */
export const REVIEW_DEDUPE_KEY_PATTERN = /^[A-Za-z0-9:._-]{1,200}$/

/** Entidad citada por una incidencia; solo IDs, nunca títulos ni ISBN. */
export interface ReviewEntityRef {
  kind: "copy" | "edition" | "work"
  id: string
}

export interface ReviewIssue {
  id: string
  reason: ReviewReason
  entityRefs: ReviewEntityRef[]
  state: ReviewState
  dedupeKey?: string
  resolvedAt?: string
  version: string
}

/** Decisión humana sobre una incidencia: registro de solo inserción (sin edición ni borrado desde el cliente). */
export interface ReviewDecision {
  id: string
  issueId: string
  kind: ReviewDecisionKind
  /** Campo → valor o fuente elegidos; los demás campos se conservan. */
  selectedFields: Record<string, unknown>
  evidenceRefs: string[]
  actor: "owner"
  decidedAt: string
  /** Operación idempotente (`library_operations`) que aplicó la decisión, si la hubo. */
  operationId?: string
}

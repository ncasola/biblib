import { z } from "zod"
import { candidateBookFields, candidateProvenance } from "./bibliographic-catalog/normalize"
import { canRetainMetadata } from "./bibliographic-catalog/retention"
import type { BibliographicCandidate, ProviderId } from "./bibliographic-catalog/types"
import { DEFAULT_BOOK_COVER } from "./book-covers"
import { uuidSchema, versionTokenSchema } from "./book-validation"
import { PROVENANCE_PROVIDERS, provenanceFieldLabels, provenanceProviderLabel } from "./catalogue-provenance"
import {
  CONFIDENCE_LABELS, EVIDENCE_SOURCE_KINDS, EVIDENCE_SOURCE_REF_PATTERN, REVIEW_LIMITS, REVIEW_REASONS, REVIEW_STATES,
  type ConfidenceLabel, type EvidenceOrigin, type EvidenceSourceKind, type ReviewDecisionKind, type ReviewEntityRef, type ReviewReason, type ReviewState,
} from "./review/contracts"
import type { Author, EditionCatalogue, FieldProvenance, ProvenanceProvider, Publisher } from "./types"

// Bandeja de revisión bibliográfica (U-DAT-07). Funciones puras, sin red ni base de datos, válidas en cliente y servidor:
// qué incidencias se derivan de las evidencias y del modelo, cómo se sincronizan con las guardadas, la comparación campo
// a campo con la fuente de cada afirmación y el plan de cada decisión. El servidor (lib/db/review.ts) carga los hechos,
// llama a estas funciones al preparar un lote y otra vez, bajo el bloqueo de colección, al aplicarlo. Ninguna función
// eleva por sí sola un ejemplar a `physically_checked`: solo `confirm_physical` con confirmación explícita.

// ── Textos visibles ──────────────────────────────────────────────────────────────────────────────────────────────────

export const REVIEW_REASON_LABELS: Record<ReviewReason, string> = {
  provisional: "ISBN provisional",
  missing_isbn: "Sin ISBN",
  invalid_isbn: "ISBN no válido",
  missing_cover: "Sin portada",
  isbn_conflict: "ISBN equivalente a otra edición",
  duplicate_candidate: "Posible duplicado",
  photo_doubt: "Duda de foto",
  source_conflict: "Fuentes contradictorias",
}

export const REVIEW_REASON_HELP: Record<ReviewReason, string> = {
  provisional: "El ISBN no coincide con ninguna ficha bibliográfica ni se ha comprobado en el ejemplar.",
  missing_isbn: "La edición no tiene ISBN. Puede ser correcto (libro antiguo o sin ISBN) o faltar por completar.",
  invalid_isbn: "El identificador guardado parece un ISBN, pero no es válido.",
  missing_cover: "La edición usa la portada genérica.",
  isbn_conflict: "Un identificador antiguo equivale al ISBN de otra edición de tu biblioteca.",
  duplicate_candidate: "Varias ediciones tienen el mismo título y la misma autoría. Solo tú decides si son la misma.",
  photo_doubt: "Una foto del ejemplar aporta datos que nadie ha comprobado todavía.",
  source_conflict: "Al fusionar ediciones quedaron valores distintos entre fuentes; elige cuál conservar.",
}

export const REVIEW_STATE_LABELS: Record<ReviewState, string> = { open: "Abierta", resolved: "Resuelta", ignored: "Ignorada" }

export const EVIDENCE_SOURCE_LABELS: Record<EvidenceSourceKind, string> = {
  provider: "Ficha bibliográfica", photo: "Foto propia", manual: "Entrada manual", import: "Importación",
}

export const CONFIDENCE_TEXT: Record<ConfidenceLabel, string> = {
  provisional: "Provisional",
  bibliographic_match: "Coincide con una ficha bibliográfica",
  physically_checked: "Comprobado en el ejemplar",
}

export const DECISION_LABELS: Record<ReviewDecisionKind, string> = {
  accept_fields: "Aceptar campos", ignore: "Ignorar", confirm_physical: "Confirmar en el ejemplar", merge: "Fusionar ediciones", reopen: "Reabrir",
}

const EVIDENCE_ORIGIN_LABELS: Record<EvidenceOrigin, string> = { backfill: "procedencia anterior", review: "revisión", import: "importación" }
export function evidenceOriginLabel(origin: EvidenceOrigin): string { return EVIDENCE_ORIGIN_LABELS[origin] }

/** Motivos que se derivan del modelo y se sincronizan solos; `source_conflict` lo abre una fusión con discrepancias. */
export const GENERATED_REASONS = ["missing_isbn", "provisional", "missing_cover", "photo_doubt", "duplicate_candidate"] as const satisfies readonly ReviewReason[]
const generated = new Set<ReviewReason>(GENERATED_REASONS)

// ── Hechos que lee el servidor ───────────────────────────────────────────────────────────────────────────────────────

export interface EditionFacts {
  id: string
  version: string
  workId: string | null
  isbn13: string | null
  title: string
  subtitle: string | null
  authors: Author[]
  publishers: Publisher[]
  publishDate: string
  numberOfPages: number
  catalogue: EditionCatalogue
  covers: { small: string; medium: string; large: string }
  coverAssetId: string | null
  /** Ejemplares de la cuenta que comparten la edición. */
  copies: number
}

export interface CopyFacts {
  id: string
  version: string
  editionId: string
  isbnVerified: boolean
}

export interface EvidenceFacts {
  id: string
  editionId: string | null
  copyId: string | null
  sourceKind: EvidenceSourceKind
  sourceRef: string | null
  sourceUrl: string | null
  hasPhoto: boolean
  observedAt: string | null
  fieldClaims: Record<string, unknown>
  confidence: ConfidenceLabel
  origin: EvidenceOrigin
}

export interface DesiredIssue {
  reason: ReviewReason
  dedupeKey: string
  entityRefs: ReviewEntityRef[]
}

// ── Generación de incidencias ────────────────────────────────────────────────────────────────────────────────────────

/** Texto comparable: sin diacríticos, signos ni mayúsculas, con espacios colapsados. */
export function comparableText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLocaleLowerCase("es").replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

const authorKey = (authors: readonly Author[]) => authors.map((author) => comparableText(author.name)).filter(Boolean).sort().join(";")

/** FNV-1a de 32 bits: parte estable y corta de una clave de deduplicación (no es un control de integridad). */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

const BACKED_PROVIDERS = new Set<string>(["open-library", "bne"])

export function hasOwnCover(edition: Pick<EditionFacts, "covers" | "coverAssetId">): boolean {
  if (edition.coverAssetId) return true
  return [edition.covers.small, edition.covers.medium, edition.covers.large].some((url) => Boolean(url) && url !== DEFAULT_BOOK_COVER)
}

/** Límite de ediciones de un grupo de candidatos: el destino y hasta 20 fuentes, como `mergeEditions`. */
const DUPLICATE_GROUP_MAX = 21

/**
 * Incidencias que deberían estar abiertas según el modelo y sus evidencias, ordenadas por clave. Las claves son
 * estables: dependen de IDs, no de textos. Nunca crea evidencias ni toca la comprobación física.
 */
export function deriveReviewIssues(input: { editions: readonly EditionFacts[]; copies: readonly CopyFacts[]; evidence: readonly EvidenceFacts[] }): DesiredIssue[] {
  const copiesByEdition = new Map<string, CopyFacts[]>()
  for (const copy of [...input.copies].sort((left, right) => left.id.localeCompare(right.id))) {
    const list = copiesByEdition.get(copy.editionId) ?? []
    list.push(copy)
    copiesByEdition.set(copy.editionId, list)
  }
  const copyById = new Map(input.copies.map((copy) => [copy.id, copy]))
  const editionById = new Map(input.editions.map((edition) => [edition.id, edition]))
  const matchedEditions = new Set<string>()
  const checkedCopies = new Set(input.copies.filter((copy) => copy.isbnVerified).map((copy) => copy.id))
  for (const entry of input.evidence) {
    if (entry.editionId && entry.confidence === "bibliographic_match") matchedEditions.add(entry.editionId)
    if (entry.copyId && entry.confidence === "physically_checked") checkedCopies.add(entry.copyId)
  }
  const editionChecked = (editionId: string) => (copiesByEdition.get(editionId) ?? []).some((copy) => checkedCopies.has(copy.id))
  const editionRefs = (edition: EditionFacts): ReviewEntityRef[] => [
    { kind: "edition", id: edition.id },
    ...(copiesByEdition.get(edition.id) ?? []).slice(0, REVIEW_LIMITS.entityRefs - 1).map((copy) => ({ kind: "copy" as const, id: copy.id })),
  ]

  const issues: DesiredIssue[] = []
  for (const edition of input.editions) {
    if (!edition.isbn13) issues.push({ reason: "missing_isbn", dedupeKey: `missing_isbn:${edition.id}`, entityRefs: editionRefs(edition) })
    else if (!BACKED_PROVIDERS.has(edition.catalogue.source) && !matchedEditions.has(edition.id) && !editionChecked(edition.id)) {
      issues.push({ reason: "provisional", dedupeKey: `provisional:${edition.id}`, entityRefs: editionRefs(edition) })
    }
    if (!hasOwnCover(edition)) issues.push({ reason: "missing_cover", dedupeKey: `missing_cover:${edition.id}`, entityRefs: editionRefs(edition) })
  }

  for (const entry of input.evidence) {
    if (entry.sourceKind !== "photo" || entry.confidence !== "provisional") continue
    const copy = entry.copyId ? copyById.get(entry.copyId) : undefined
    const editionId = copy?.editionId ?? entry.editionId
    if (!editionId || !editionById.has(editionId)) continue
    // Una comprobación física del ejemplar (o de alguno de la edición) ya resuelve la duda de la foto.
    if (copy ? checkedCopies.has(copy.id) : editionChecked(editionId)) continue
    const refs: ReviewEntityRef[] = copy ? [{ kind: "copy", id: copy.id }, { kind: "edition", id: editionId }] : [{ kind: "edition", id: editionId }]
    issues.push({ reason: "photo_doubt", dedupeKey: `photo_doubt:${entry.id}`, entityRefs: refs })
  }

  issues.push(...duplicateCandidates(input.editions))
  return issues.sort((left, right) => left.dedupeKey.localeCompare(right.dedupeKey))
}

/**
 * Grupos de ediciones con el mismo título y la misma autoría (sin diacríticos ni mayúsculas). Un título igual con otra
 * autoría (homónimos) o la misma autoría con otro título no son candidatos. Dos ISBN distintos o dos obras distintas
 * nunca se proponen como la misma edición: cada edición con ISBN u obra forma su grupo con las que no tienen ninguno.
 */
function duplicateCandidates(editions: readonly EditionFacts[]): DesiredIssue[] {
  const groups = new Map<string, EditionFacts[]>()
  for (const edition of editions) {
    const title = comparableText(edition.title)
    const authors = authorKey(edition.authors)
    if (!title || !authors) continue
    const key = `${title}|${authors}`
    const list = groups.get(key) ?? []
    list.push(edition)
    groups.set(key, list)
  }
  const sets = new Map<string, string[]>()
  const addSet = (members: readonly EditionFacts[]) => {
    if (members.length < 2) return
    const ids = members.map((edition) => edition.id).sort().slice(0, DUPLICATE_GROUP_MAX)
    sets.set(ids.join(","), ids)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const isbns = new Set(group.flatMap((edition) => edition.isbn13 ? [edition.isbn13] : []))
    const works = new Set(group.flatMap((edition) => edition.workId ? [edition.workId] : []))
    if (isbns.size <= 1 && works.size <= 1) { addSet(group); continue }
    const compatible = (members: readonly EditionFacts[]) =>
      new Set(members.flatMap((edition) => edition.isbn13 ? [edition.isbn13] : [])).size <= 1 && new Set(members.flatMap((edition) => edition.workId ? [edition.workId] : [])).size <= 1
    for (const anchor of group.filter((edition) => edition.isbn13 || edition.workId)) {
      let members = [anchor, ...group.filter((edition) => edition.id !== anchor.id && !edition.isbn13 && (!edition.workId || !anchor.workId || edition.workId === anchor.workId))]
      if (!compatible(members)) members = [anchor, ...group.filter((edition) => edition.id !== anchor.id && !edition.isbn13 && !edition.workId)]
      addSet(members)
    }
  }
  return [...sets.values()].map((ids) => ({
    reason: "duplicate_candidate" as const,
    dedupeKey: `duplicate_candidate:${ids[0]}:${ids.length}:${fnv1a(ids.join(","))}`,
    entityRefs: ids.map((id) => ({ kind: "edition" as const, id })),
  }))
}

// ── Sincronización con las incidencias guardadas ─────────────────────────────────────────────────────────────────────

export interface StoredIssueFacts {
  id: string
  reason: ReviewReason
  dedupeKey: string | null
  state: ReviewState
  entityRefs: ReviewEntityRef[]
  resolvedAt: string | null
  /** Resuelta sin decisión humana vigente (sin decisiones o la última es `reopen`): la cerró la sincronización. */
  autoResolved: boolean
}

export interface IssueSyncPlan {
  create: DesiredIssue[]
  /** Incidencias cerradas solas que vuelven a aplicarse: se reabren (misma fila e historial). */
  reopen: string[]
  refresh: { id: string; entityRefs: ReviewEntityRef[] }[]
  /** Abiertas cuyo motivo ya no se da: se resuelven sin decisión y conservan sus evidencias. */
  autoResolve: string[]
  /** Incidencias que no se crean por el límite de abiertas de la cuenta (nunca se recorta en silencio). */
  deferred: number
}

const sameRefs = (left: readonly ReviewEntityRef[], right: readonly ReviewEntityRef[]) =>
  left.length === right.length && left.every((ref, index) => ref.kind === right[index].kind && ref.id === right[index].id)

/**
 * Qué cambia para que haya exactamente una abierta por clave derivada. Una incidencia ignorada o resuelta por una
 * persona no se vuelve a abrir sola: solo con `reopen`. Las abiertas de motivos no derivados no se tocan.
 */
export function planIssueSync(desired: readonly DesiredIssue[], stored: readonly StoredIssueFacts[], openLimit: number = REVIEW_LIMITS.openPerAccount): IssueSyncPlan {
  const byKey = new Map<string, StoredIssueFacts[]>()
  for (const issue of stored) {
    if (!issue.dedupeKey) continue
    const list = byKey.get(issue.dedupeKey) ?? []
    list.push(issue)
    byKey.set(issue.dedupeKey, list)
  }
  const wanted = new Set(desired.map((issue) => issue.dedupeKey))
  const plan: IssueSyncPlan = { create: [], reopen: [], refresh: [], autoResolve: [], deferred: 0 }
  for (const issue of stored) {
    if (issue.state === "open" && issue.dedupeKey && generated.has(issue.reason) && !wanted.has(issue.dedupeKey)) plan.autoResolve.push(issue.id)
  }
  let open = stored.filter((issue) => issue.state === "open").length - plan.autoResolve.length
  const pending: ({ create: DesiredIssue } | { reopen: string })[] = []
  for (const issue of desired) {
    const rows = byKey.get(issue.dedupeKey) ?? []
    const current = rows.find((row) => row.state === "open")
    if (current) {
      if (!sameRefs(current.entityRefs, issue.entityRefs)) plan.refresh.push({ id: current.id, entityRefs: issue.entityRefs })
      continue
    }
    if (rows.length) {
      const latest = [...rows].sort((left, right) => (right.resolvedAt ?? "").localeCompare(left.resolvedAt ?? ""))[0]
      if (latest.state === "resolved" && latest.autoResolved) pending.push({ reopen: latest.id })
      continue
    }
    pending.push({ create: issue })
  }
  for (const entry of pending) {
    if (open >= openLimit) { plan.deferred++; continue }
    open++
    if ("reopen" in entry) plan.reopen.push(entry.reopen)
    else plan.create.push(entry.create)
  }
  return plan
}

// ── Listado: filtros y cursor ────────────────────────────────────────────────────────────────────────────────────────

export const reviewFiltersSchema = z.object({
  reasons: z.array(z.enum(REVIEW_REASONS)).max(REVIEW_REASONS.length).optional(),
  sources: z.array(z.enum(EVIDENCE_SOURCE_KINDS)).max(EVIDENCE_SOURCE_KINDS.length).optional(),
  states: z.array(z.enum(REVIEW_STATES)).min(1).max(REVIEW_STATES.length).optional(),
}).strict()
export type ReviewFilters = z.infer<typeof reviewFiltersSchema>

export const REVIEW_PAGE_DEFAULT = 20
export const REVIEW_PAGE_MAX = 50

export const listReviewIssuesSchema = z.object({
  filters: reviewFiltersSchema.default({}),
  cursor: z.string().max(120).nullable().optional(),
  limit: z.number().int().min(1).max(REVIEW_PAGE_MAX).default(REVIEW_PAGE_DEFAULT),
}).strict()

const CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)~([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** Cursor opaco por (fecha de creación con microsegundos, id), en el mismo orden descendente que el índice. */
export function encodeReviewCursor(position: { createdAt: string; id: string }): string {
  return `${position.createdAt}~${position.id}`
}

export function decodeReviewCursor(cursor: string | null | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null
  const match = CURSOR_PATTERN.exec(cursor)
  return match ? { createdAt: match[1], id: match[2] } : null
}

/** Parámetros de la URL de la bandeja: sobreviven a abrir una ficha y volver. */
export const REVIEW_QUERY = { reasons: "motivo", sources: "fuente", states: "estado", cursor: "desde" } as const

const listParam = <T extends string>(params: URLSearchParams, name: string, allowed: readonly T[]): T[] | undefined => {
  const values = params.getAll(name).flatMap((value) => value.split(",")).filter((value): value is T => (allowed as readonly string[]).includes(value))
  return values.length ? [...new Set(values)] : undefined
}

export function parseReviewQuery(params: URLSearchParams): { filters: ReviewFilters; cursor: string | null } {
  const filters: ReviewFilters = {}
  const reasons = listParam(params, REVIEW_QUERY.reasons, REVIEW_REASONS)
  const sources = listParam(params, REVIEW_QUERY.sources, EVIDENCE_SOURCE_KINDS)
  const states = listParam(params, REVIEW_QUERY.states, REVIEW_STATES)
  if (reasons) filters.reasons = reasons
  if (sources) filters.sources = sources
  if (states) filters.states = states
  const cursor = params.get(REVIEW_QUERY.cursor)
  return { filters, cursor: decodeReviewCursor(cursor) ? cursor : null }
}

export function serializeReviewQuery(filters: ReviewFilters, cursor?: string | null): string {
  const params = new URLSearchParams()
  if (filters.reasons?.length) params.set(REVIEW_QUERY.reasons, filters.reasons.join(","))
  if (filters.sources?.length) params.set(REVIEW_QUERY.sources, filters.sources.join(","))
  if (filters.states?.length) params.set(REVIEW_QUERY.states, filters.states.join(","))
  if (cursor && decodeReviewCursor(cursor)) params.set(REVIEW_QUERY.cursor, cursor)
  const text = params.toString()
  return text ? `?${text}` : ""
}

/** Filtros efectivos: sin estado elegido se muestran las abiertas. */
export function effectiveStates(filters: ReviewFilters): ReviewState[] {
  return filters.states?.length ? filters.states : ["open"]
}

// ── Comparación campo a campo ────────────────────────────────────────────────────────────────────────────────────────

export const ACCEPT_FIELDS = ["title", "subtitle", "authors", "publishers", "publish_date", "number_of_pages"] as const
export type AcceptField = (typeof ACCEPT_FIELDS)[number]
export type FieldValue = string | number | Author[] | Publisher[]
export type FieldValues = Partial<Record<AcceptField, FieldValue>>

export const COMPARE_FIELD_LABELS: Record<AcceptField | "isbn", string> = {
  isbn: "ISBN", title: provenanceFieldLabels.title, subtitle: provenanceFieldLabels.subtitle, authors: provenanceFieldLabels.authors,
  publishers: provenanceFieldLabels.publishers, publish_date: provenanceFieldLabels.publish_date, number_of_pages: provenanceFieldLabels.number_of_pages,
}

export function displayValue(field: AcceptField | "isbn", value: FieldValue | null | undefined): string {
  if (value === undefined || value === null || value === "") return ""
  if (field === "authors" || field === "publishers") return (value as { name: string }[]).map((entry) => entry.name).join("; ")
  if (field === "number_of_pages" && value === 0) return ""
  return String(value)
}

const sameValue = (field: AcceptField | "isbn", left: FieldValue | null | undefined, right: FieldValue | null | undefined) =>
  comparableText(displayValue(field, left)) === comparableText(displayValue(field, right))

/** Valores que una evidencia afirma (`field_claims.values`), validados; lo que no encaja se descarta al leer. */
const claimedValuesSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  subtitle: z.string().trim().min(1).max(500).optional(),
  authors: z.array(z.object({ name: z.string().trim().min(1).max(300) }).strip()).min(1).max(50).optional(),
  publishers: z.array(z.object({ name: z.string().trim().min(1).max(300) }).strip()).min(1).max(50).optional(),
  publish_date: z.string().trim().min(1).max(100).optional(),
  number_of_pages: z.number().int().min(1).max(100_000).optional(),
}).strip()

export function evidenceClaimedValues(fieldClaims: Record<string, unknown>): FieldValues {
  const parsed = claimedValuesSchema.safeParse(fieldClaims.values)
  if (!parsed.success) return {}
  return Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined)) as FieldValues
}

export function editionValues(edition: EditionFacts): FieldValues & { isbn?: string } {
  return {
    ...(edition.isbn13 ? { isbn: edition.isbn13 } : {}),
    title: edition.title,
    ...(edition.subtitle ? { subtitle: edition.subtitle } : {}),
    ...(edition.authors.length ? { authors: edition.authors } : {}),
    ...(edition.publishers.length ? { publishers: edition.publishers } : {}),
    ...(edition.publishDate ? { publish_date: edition.publishDate } : {}),
    ...(edition.numberOfPages ? { number_of_pages: edition.numberOfPages } : {}),
  }
}

export type ColumnKey = string
const COLUMN_KEY_PATTERN = /^(?:(?:edition|evidence):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|provider:(?:open-library|bne|google-books):[A-Za-z0-9._:-]{1,120})$/
export const columnKeySchema = z.string().regex(COLUMN_KEY_PATTERN, "La fuente elegida no es válida.")

export interface ComparisonColumn {
  key: ColumnKey
  kind: "edition" | "evidence" | "provider"
  /** Nombre corto de la columna («Edición 1», «Foto propia», «Open Library»). */
  label: string
  sourceKind: EvidenceSourceKind
  confidence?: ConfidenceLabel
  /** Solo se pueden aceptar valores de fuentes cuya licencia permite conservarlos. */
  selectable: boolean
  notSelectableReason?: string
  editionId?: string
  isbn?: string
  values: FieldValues
  /** Fuente de cada afirmación, en texto visible. */
  fieldSources: Partial<Record<AcceptField, string>>
  sourceUrl?: string
  observedAt?: string
  hasPhoto?: boolean
}

export interface ComparisonRow {
  field: AcceptField | "isbn"
  label: string
  cells: { column: ColumnKey; display: string; source?: string }[]
  /** Hay al menos dos valores presentes y distintos. */
  differs: boolean
}

const SELECTION_TEXT: Record<FieldProvenance["selection"], string> = { "user-selected": "elegido por ti", "manually-verified": "comprobado en tu ejemplar", unverified: "sin revisar" }

function fieldSourceText(catalogue: EditionCatalogue, field: AcceptField): string {
  const fields = "fields" in catalogue ? catalogue.fields : undefined
  const entry = fields?.[field]
  if (entry) return `${provenanceProviderLabel(entry.provider)} · ${SELECTION_TEXT[entry.selection]}`
  return `${provenanceProviderLabel(catalogue.source)} · ficha completa`
}

export function editionColumn(edition: EditionFacts, index: number): ComparisonColumn {
  const values = editionValues(edition)
  const { isbn, ...fields } = values
  return {
    key: `edition:${edition.id}`, kind: "edition", label: `Edición ${index + 1}`, sourceKind: sourceKindOf(edition.catalogue.source),
    selectable: true, editionId: edition.id, ...(isbn ? { isbn } : {}), values: fields,
    fieldSources: Object.fromEntries(ACCEPT_FIELDS.filter((field) => fields[field] !== undefined).map((field) => [field, fieldSourceText(edition.catalogue, field)])),
    ...("sourceUrl" in edition.catalogue && edition.catalogue.sourceUrl ? { sourceUrl: edition.catalogue.sourceUrl } : {}),
  }
}

/** Columna de una evidencia que afirma valores; `null` si solo aporta procedencia. */
export function evidenceColumn(entry: EvidenceFacts): ComparisonColumn | null {
  const values = evidenceClaimedValues(entry.fieldClaims)
  if (!Object.keys(values).length) return null
  const label = entry.sourceKind === "provider" && entry.sourceRef ? providerName(entry.sourceRef.split(":")[0]) : EVIDENCE_SOURCE_LABELS[entry.sourceKind]
  return {
    key: `evidence:${entry.id}`, kind: "evidence", label, sourceKind: entry.sourceKind, confidence: entry.confidence, selectable: true, values,
    fieldSources: Object.fromEntries(Object.keys(values).map((field) => [field, `${label} · ${CONFIDENCE_TEXT[entry.confidence].toLocaleLowerCase("es")}`])),
    ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
    ...(entry.observedAt ? { observedAt: entry.observedAt } : {}),
    ...(entry.hasPhoto ? { hasPhoto: true } : {}),
  }
}

const PROVIDER_NAMES: Record<string, string> = { "open-library": "Open Library", bne: "BNE", "google-books": "Google Books" }
const providerName = (provider: string) => PROVIDER_NAMES[provider] ?? provenanceProviderLabel(provider)

/** Clave de columna de un candidato: proveedor y registro (o posición si el registro no trae ID). */
export function providerColumnKey(candidate: BibliographicCandidate, index: number): ColumnKey {
  const record = (candidate.recordId ?? "").replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 100)
  return `provider:${candidate.provider}:${record || `n${index}`}`
}

/** Un candidato se puede aceptar si su licencia permite conservar y exportar metadatos (Google: solo vista previa). */
export function candidateRetainable(candidate: BibliographicCandidate): boolean {
  return canRetainMetadata(candidate.provider) && candidateProvenance(candidate) !== null
}

export function providerColumn(candidate: BibliographicCandidate, index: number): ComparisonColumn {
  const fields = candidateBookFields(candidate)
  const values = Object.fromEntries(ACCEPT_FIELDS.filter((field) => fields[field] !== undefined).map((field) => [field, fields[field]])) as FieldValues
  const selectable = candidateRetainable(candidate)
  const name = providerName(candidate.provider)
  const isbn = candidate.isbns[0]
  return {
    key: providerColumnKey(candidate, index), kind: "provider", label: name, sourceKind: "provider", confidence: "bibliographic_match", selectable,
    ...(selectable ? {} : { notSelectableReason: `${name} solo permite una vista previa temporal: sus datos no se guardan.` }),
    ...(isbn ? { isbn } : {}), values,
    fieldSources: Object.fromEntries(Object.keys(values).map((field) => [field, `${name} · consultado ahora`])),
    ...(candidate.sourceUrl && /^https?:\/\//.test(candidate.sourceUrl) ? { sourceUrl: candidate.sourceUrl } : {}),
    observedAt: candidate.retrievedAt,
  }
}

/** Filas de la comparación: una por campo, con el valor y la fuente de cada columna. */
export function comparisonRows(columns: readonly ComparisonColumn[]): ComparisonRow[] {
  const fields: (AcceptField | "isbn")[] = ["isbn", ...ACCEPT_FIELDS]
  return fields.flatMap((field) => {
    const cells = columns.map((column) => {
      const value = field === "isbn" ? column.isbn : column.values[field]
      const source = field === "isbn" ? undefined : column.fieldSources[field]
      return { column: column.key, display: displayValue(field, value), ...(source && value !== undefined ? { source } : {}) }
    })
    if (cells.every((cell) => !cell.display)) return []
    const present = cells.filter((cell) => cell.display).map((cell) => comparableText(cell.display))
    return [{ field, label: COMPARE_FIELD_LABELS[field], cells, differs: new Set(present).size > 1 }]
  })
}

// ── Decisiones propuestas y plan ─────────────────────────────────────────────────────────────────────────────────────

const issueBase = { issueId: uuidSchema, expectedVersion: versionTokenSchema }

export const proposedDecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...issueBase, kind: z.literal("accept_fields"), editionId: uuidSchema, editionVersion: versionTokenSchema,
    fields: z.partialRecord(z.enum(ACCEPT_FIELDS), columnKeySchema).refine((fields) => Object.keys(fields).length > 0, "Elige al menos un campo."),
  }).strict(),
  z.object({ ...issueBase, kind: z.literal("ignore") }).strict(),
  z.object({ ...issueBase, kind: z.literal("reopen") }).strict(),
  // La comprobación física exige la confirmación literal de la persona; ninguna selección automática la produce.
  z.object({ ...issueBase, kind: z.literal("confirm_physical"), copyId: uuidSchema, copyVersion: versionTokenSchema, confirmed: z.literal(true) }).strict(),
  z.object({
    ...issueBase, kind: z.literal("merge"), targetEditionId: uuidSchema, sourceEditionIds: z.array(uuidSchema).min(1).max(20),
    expectedVersions: z.record(uuidSchema, versionTokenSchema),
  }).strict(),
])
export type ProposedDecision = z.infer<typeof proposedDecisionSchema>

export const reviewBatchSchema = z.array(proposedDecisionSchema).min(1).max(REVIEW_LIMITS.batch)

export interface IssueFacts {
  id: string
  version: string
  reason: ReviewReason
  state: ReviewState
  dedupeKey: string | null
  entityRefs: ReviewEntityRef[]
}

export interface PlanState {
  issues: ReadonlyMap<string, IssueFacts>
  editions: ReadonlyMap<string, EditionFacts>
  copies: ReadonlyMap<string, CopyFacts>
  evidence: ReadonlyMap<string, EvidenceFacts>
  /** Candidatos de proveedor consultados para el lote, por clave de columna. */
  providers: ReadonlyMap<ColumnKey, BibliographicCandidate>
  /** Claves con una incidencia abierta ahora. */
  openKeys: ReadonlySet<string>
}

export interface NewEvidence {
  subject: { kind: "edition" | "copy"; id: string }
  sourceKind: EvidenceSourceKind
  sourceRef?: string
  sourceUrl?: string
  observedAt?: string
  fieldClaims: Record<string, unknown>
  confidence: ConfidenceLabel
}

export type PlanOperation =
  | { op: "update_edition"; editionId: string; expectedVersion: string; values: FieldValues; catalogue: EditionCatalogue }
  | { op: "insert_evidence"; evidence: NewEvidence }
  | { op: "verify_copy"; copyId: string; expectedVersion: string }
  | { op: "merge_editions"; targetId: string; sourceIds: string[]; expectedVersions: Record<string, string> }
  | { op: "set_issue_state"; issueId: string; expectedVersion: string; state: ReviewState }
  | { op: "open_issue"; reason: ReviewReason; dedupeKey: string; entityRefs: ReviewEntityRef[] }

export type PlanRowStatus = "ready" | "conflict" | "invalid"

export interface PlanRow {
  index: number
  issueId: string
  kind: ReviewDecisionKind
  status: PlanRowStatus
  message?: string
  /** Efectos en texto visible, para la vista previa. */
  effects: string[]
  creates: number
  updates: number
  merges: number
  /** Campos y fuentes elegidos (`review_decisions.selected_fields`) y evidencias citadas. */
  selectedFields: Record<string, unknown>
  evidenceRefs: string[]
  ops: PlanOperation[]
}

const rowOf = (index: number, decision: ProposedDecision): PlanRow => ({
  index, issueId: decision.issueId, kind: decision.kind, status: "ready", effects: [], creates: 0, updates: 0, merges: 0, selectedFields: {}, evidenceRefs: [], ops: [],
})
const reject = (row: PlanRow, status: Exclude<PlanRowStatus, "ready">, message: string): PlanRow => ({ ...row, status, message, effects: [], creates: 0, updates: 0, merges: 0, ops: [] })

function sourceKindOf(source: string): EvidenceSourceKind {
  if (source === "open-library" || source === "bne" || source === "google-books") return "provider"
  if (source === "photo") return "photo"
  if (source === "manual") return "manual"
  return "import"
}

const providerOf = (value: string): ProvenanceProvider => (PROVENANCE_PROVIDERS as readonly string[]).includes(value) ? value as ProvenanceProvider : "import"

/** Procedencia v2 de la edición tras aceptar campos: conserva la fuente primaria y la de los campos no elegidos. */
export function acceptedCatalogue(current: EditionCatalogue, fields: Partial<Record<AcceptField, FieldProvenance>>): EditionCatalogue {
  const previous = "fields" in current && current.fields ? current.fields : {}
  return {
    schemaVersion: 2, source: providerOf(current.source),
    ...("sourceUrl" in current && current.sourceUrl ? { sourceUrl: current.sourceUrl } : {}),
    fields: { ...previous, ...fields },
  }
}

const httpsOnly = (url: string | undefined) => url && /^https:\/\//.test(url) && url.length <= 2048 ? url : undefined

/** `source_ref` de un registro de proveedor: clave opaca saneada, nunca una URL. */
export function providerSourceRef(provider: ProviderId, recordId?: string): string {
  const ref = `${provider}${recordId ? `:${recordId.replace(/[^A-Za-z0-9:._-]/g, "")}` : ""}`.slice(0, 200)
  return EVIDENCE_SOURCE_REF_PATTERN.test(ref) ? ref : provider
}

const editionRefIds = (issue: IssueFacts) => new Set(issue.entityRefs.filter((ref) => ref.kind === "edition").map((ref) => ref.id))
const copyRefIds = (issue: IssueFacts) => new Set(issue.entityRefs.filter((ref) => ref.kind === "copy").map((ref) => ref.id))

function validValue(field: AcceptField, value: FieldValue): boolean {
  if (field === "title") return typeof value === "string" && value.trim().length >= 1 && value.length <= 500
  if (field === "number_of_pages") return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000
  if (field === "authors" || field === "publishers") return Array.isArray(value) && value.length <= 50
  return typeof value === "string" && value.length <= 500
}

/**
 * Plan de una decisión con los hechos actuales. Una versión distinta de la vista es un conflicto (otra persona o
 * pestaña cambió la incidencia o la ficha); una decisión imposible con estos datos es inválida. `touched` recoge lo que
 * cambian las filas anteriores del mismo lote: dos decisiones sobre la misma edición o incidencia no se encadenan.
 */
export function planReviewDecision(state: PlanState, decision: ProposedDecision, index: number, touched: { issues: Set<string>; editions: Set<string>; copies: Set<string> }, now: string): PlanRow {
  const row = rowOf(index, decision)
  const issue = state.issues.get(decision.issueId)
  if (!issue) return reject(row, "conflict", "La incidencia ya no existe.")
  if (touched.issues.has(issue.id)) return reject(row, "invalid", "La incidencia aparece más de una vez en el lote.")
  if (issue.version !== decision.expectedVersion) return reject(row, "conflict", "La incidencia ha cambiado desde que la revisaste.")
  if (decision.kind === "reopen") {
    if (issue.state === "open") return reject(row, "conflict", "La incidencia ya está abierta.")
    if (issue.dedupeKey && state.openKeys.has(issue.dedupeKey)) return reject(row, "conflict", "Ya hay otra incidencia abierta con el mismo motivo para estas fichas.")
    row.ops.push({ op: "set_issue_state", issueId: issue.id, expectedVersion: issue.version, state: "open" })
    row.effects.push("Se reabre la incidencia.")
    row.updates = 1
    touched.issues.add(issue.id)
    return row
  }
  if (issue.state !== "open") return reject(row, "conflict", "La incidencia ya no está abierta.")

  const resolve = (resolution: ReviewState = "resolved") => {
    row.ops.push({ op: "set_issue_state", issueId: issue.id, expectedVersion: issue.version, state: resolution })
    row.effects.push(resolution === "ignored" ? "Se ignora la incidencia; sus evidencias se conservan." : "La incidencia queda resuelta.")
    row.updates++
    touched.issues.add(issue.id)
  }

  switch (decision.kind) {
    case "ignore":
      resolve("ignored")
      return row
    case "confirm_physical": {
      const copy = state.copies.get(decision.copyId)
      const editionIds = editionRefIds(issue)
      if (!copy || (!copyRefIds(issue).has(copy.id) && !editionIds.has(copy.editionId))) return reject(row, "conflict", "El ejemplar ya no está disponible.")
      if (touched.copies.has(copy.id)) return reject(row, "invalid", "El mismo ejemplar se comprueba en otra decisión del lote.")
      if (copy.version !== decision.copyVersion) return reject(row, "conflict", "El ejemplar ha cambiado desde que lo revisaste.")
      const edition = state.editions.get(copy.editionId)
      if (!edition?.isbn13) return reject(row, "invalid", "Este ejemplar no tiene ISBN que comprobar.")
      const photos = [...state.evidence.values()].filter((entry) => entry.sourceKind === "photo" && (entry.copyId === copy.id || entry.editionId === copy.editionId)).map((entry) => entry.id)
      if (!copy.isbnVerified) {
        row.ops.push({ op: "verify_copy", copyId: copy.id, expectedVersion: copy.version })
        row.effects.push(`El ejemplar queda comprobado con el ISBN ${edition.isbn13}.`)
        row.updates++
      }
      row.ops.push({ op: "insert_evidence", evidence: { subject: { kind: "copy", id: copy.id }, sourceKind: "manual", observedAt: now, fieldClaims: { isbnVerified: true, isbn13: edition.isbn13 }, confidence: "physically_checked" } })
      row.effects.push("Se guarda tu comprobación como evidencia del ejemplar.")
      row.creates++
      row.selectedFields = { isbn13: edition.isbn13 }
      row.evidenceRefs = photos.slice(0, REVIEW_LIMITS.evidenceRefs)
      touched.copies.add(copy.id)
      resolve()
      return row
    }
    case "accept_fields": {
      const edition = state.editions.get(decision.editionId)
      if (!edition || !editionRefIds(issue).has(edition.id)) return reject(row, "conflict", "La edición ya no está disponible.")
      if (touched.editions.has(edition.id)) return reject(row, "invalid", "La misma edición cambia en otra decisión del lote.")
      if (edition.version !== decision.editionVersion) return reject(row, "conflict", "La edición ha cambiado desde que la revisaste.")
      const current = editionValues(edition)
      const values: FieldValues = {}
      const provenance: Partial<Record<AcceptField, FieldProvenance>> = {}
      const providerClaims = new Map<ColumnKey, { candidate: BibliographicCandidate; values: FieldValues }>()
      const evidenceRefs = new Set<string>()
      for (const field of ACCEPT_FIELDS) {
        const key = decision.fields[field]
        if (!key) continue
        const [kind, ...rest] = key.split(":")
        let value: FieldValue | undefined
        let origin: FieldProvenance | null = null
        if (kind === "edition") {
          const source = state.editions.get(rest.join(":"))
          if (!source || !editionRefIds(issue).has(source.id)) return reject(row, "conflict", "La edición de la que tomabas el valor ya no está disponible.")
          value = editionValues(source)[field]
          const fields = "fields" in source.catalogue ? source.catalogue.fields : undefined
          origin = fields?.[field] ?? { provider: providerOf(source.catalogue.source), selection: "user-selected" }
        } else if (kind === "evidence") {
          const entry = state.evidence.get(rest.join(":"))
          const subjectOk = entry && (entry.editionId === edition.id || (entry.copyId && state.copies.get(entry.copyId)?.editionId === edition.id))
          if (!entry || !subjectOk) return reject(row, "conflict", "La fuente que elegiste se ha eliminado o ya no pertenece a esta edición.")
          value = evidenceClaimedValues(entry.fieldClaims)[field]
          const provider = entry.sourceKind === "provider" ? providerOf(entry.sourceRef?.split(":")[0] ?? "import") : entry.sourceKind === "photo" ? "photo" : entry.sourceKind
          origin = { provider: providerOf(provider), ...(httpsOnly(entry.sourceUrl ?? undefined) ? { sourceUrl: httpsOnly(entry.sourceUrl ?? undefined) } : {}), selection: "user-selected" }
          evidenceRefs.add(entry.id)
        } else {
          const candidate = state.providers.get(key)
          if (!candidate) return reject(row, "conflict", "La ficha del proveedor ya no está disponible o ha caducado. Vuelve a preparar la revisión.")
          if (!candidateRetainable(candidate)) return reject(row, "invalid", `${providerName(candidate.provider)} solo permite una vista previa: sus datos no se pueden guardar.`)
          const fields = candidateBookFields(candidate)
          value = fields[field] as FieldValue | undefined
          origin = candidateProvenance(candidate)
          const claim = providerClaims.get(key) ?? { candidate, values: {} }
          if (value !== undefined) claim.values[field] = value
          providerClaims.set(key, claim)
        }
        if (value === undefined) return reject(row, "invalid", `La fuente elegida no incluye ${COMPARE_FIELD_LABELS[field].toLocaleLowerCase("es")}.`)
        if (!validValue(field, value)) return reject(row, "invalid", `El valor de ${COMPARE_FIELD_LABELS[field].toLocaleLowerCase("es")} no es válido.`)
        row.selectedFields[field] = { from: key }
        if (sameValue(field, current[field], value)) continue
        values[field] = value
        if (origin) provenance[field] = origin
      }
      const changed = Object.keys(values) as AcceptField[]
      if (changed.length) {
        row.ops.push({ op: "update_edition", editionId: edition.id, expectedVersion: edition.version, values, catalogue: acceptedCatalogue(edition.catalogue, provenance) })
        const copies = edition.copies > 1 ? ` (cambia en sus ${edition.copies} ejemplares)` : ""
        row.effects.push(`Edición «${edition.title}»: ${changed.map((field) => COMPARE_FIELD_LABELS[field].toLocaleLowerCase("es")).join(", ")}${copies}.`)
        row.updates++
      } else row.effects.push("Los valores elegidos ya coinciden con la ficha: no cambia ningún campo.")
      const unchosen = ACCEPT_FIELDS.filter((field) => !decision.fields[field] && current[field] !== undefined)
      if (unchosen.length) row.effects.push(`Se conservan sin cambios: ${unchosen.map((field) => COMPARE_FIELD_LABELS[field].toLocaleLowerCase("es")).join(", ")}.`)
      for (const { candidate, values: claimed } of providerClaims.values()) {
        const origin = candidateProvenance(candidate)
        row.ops.push({ op: "insert_evidence", evidence: {
          subject: { kind: "edition", id: edition.id }, sourceKind: "provider", sourceRef: providerSourceRef(candidate.provider, candidate.recordId),
          ...(candidate.sourceUrl && /^https?:\/\//.test(candidate.sourceUrl) && candidate.sourceUrl.length <= 2048 ? { sourceUrl: candidate.sourceUrl } : {}),
          observedAt: candidate.retrievedAt,
          fieldClaims: { values: claimed, ...(origin ? { fields: Object.fromEntries(Object.keys(claimed).map((field) => [field, origin])) } : {}) },
          // Una ficha pública acredita la coincidencia bibliográfica, nunca la comprobación del ejemplar.
          confidence: "bibliographic_match",
        } })
        row.effects.push(`Se guarda la ficha de ${providerName(candidate.provider)} como evidencia de la edición.`)
        row.creates++
      }
      row.evidenceRefs = [...evidenceRefs].slice(0, REVIEW_LIMITS.evidenceRefs)
      touched.editions.add(edition.id)
      resolve()
      return row
    }
    case "merge": {
      if (issue.reason !== "duplicate_candidate" && issue.reason !== "isbn_conflict") return reject(row, "invalid", "Solo se fusionan ediciones desde un posible duplicado.")
      const allowed = editionRefIds(issue)
      const sourceIds = [...new Set(decision.sourceEditionIds)]
      if (sourceIds.includes(decision.targetEditionId)) return reject(row, "invalid", "La edición de destino no puede ser también una de origen.")
      const ids = [decision.targetEditionId, ...sourceIds]
      if (ids.some((id) => !allowed.has(id))) return reject(row, "invalid", "Solo se fusionan las ediciones de esta incidencia.")
      if (ids.some((id) => touched.editions.has(id))) return reject(row, "invalid", "Alguna de estas ediciones cambia en otra decisión del lote.")
      const editions = ids.map((id) => state.editions.get(id))
      if (editions.some((edition) => !edition)) return reject(row, "conflict", "Alguna edición ya no está disponible.")
      const [target, ...sources] = editions as EditionFacts[]
      if (editions.some((edition) => edition && decision.expectedVersions[edition.id] !== edition.version)) return reject(row, "conflict", "Alguna edición ha cambiado desde que la revisaste.")
      const isbns = new Set(editions.flatMap((edition) => edition?.isbn13 ? [edition.isbn13] : []))
      if (isbns.size > 1) return reject(row, "invalid", "Esas ediciones tienen ISBN distintos: no son la misma edición.")
      const works = new Set(editions.flatMap((edition) => edition?.workId ? [edition.workId] : []))
      if (works.size > 1) return reject(row, "invalid", "Esas ediciones pertenecen a obras distintas.")
      const moved = sources.reduce((total, edition) => total + edition.copies, 0)
      row.ops.push({ op: "merge_editions", targetId: target.id, sourceIds, expectedVersions: Object.fromEntries(editions.map((edition) => [edition!.id, edition!.version])) })
      row.effects.push(`Se fusionan ${sources.length + 1} ediciones en «${target.title}»: ${moved} ejemplar${moved === 1 ? "" : "es"} pasa${moved === 1 ? "" : "n"} a ella y sus evidencias se mueven antes.`)
      row.merges = 1
      row.selectedFields = { targetEditionId: target.id, sourceEditionIds: sourceIds }
      // Discrepancias: el destino conserva sus valores y se abre una resolución con los de cada origen como evidencia.
      const targetValues = editionValues(target)
      const discrepant: AcceptField[] = []
      for (const source of sources) {
        const sourceValues = editionValues(source)
        const differing = ACCEPT_FIELDS.filter((field) => sourceValues[field] !== undefined && !sameValue(field, targetValues[field], sourceValues[field]))
        if (!differing.length) continue
        discrepant.push(...differing)
        row.ops.push({ op: "insert_evidence", evidence: {
          subject: { kind: "edition", id: target.id }, sourceKind: sourceKindOf(source.catalogue.source),
          fieldClaims: { values: Object.fromEntries(differing.map((field) => [field, sourceValues[field]])), mergedFrom: source.id },
          confidence: "provisional",
        } })
        row.creates++
      }
      if (discrepant.length) {
        const fields = [...new Set(discrepant)].map((field) => COMPARE_FIELD_LABELS[field].toLocaleLowerCase("es"))
        const key = `source_conflict:${target.id}`
        if (!state.openKeys.has(key)) {
          row.ops.push({ op: "open_issue", reason: "source_conflict", dedupeKey: key, entityRefs: [{ kind: "edition", id: target.id }] })
          row.creates++
        }
        row.effects.push(`No se sobrescribe nada: se abre una resolución para ${fields.join(", ")}.`)
      }
      for (const id of ids) touched.editions.add(id)
      resolve()
      return row
    }
  }
}

export interface BatchSummary { ready: number; conflicts: number; invalid: number; creates: number; updates: number; merges: number }

export function planReviewBatch(state: PlanState, decisions: readonly ProposedDecision[], now: string): { rows: PlanRow[]; summary: BatchSummary } {
  const touched = { issues: new Set<string>(), editions: new Set<string>(), copies: new Set<string>() }
  const rows = decisions.map((decision, index) => planReviewDecision(state, decision, index, touched, now))
  const ready = rows.filter((row) => row.status === "ready")
  return {
    rows,
    summary: {
      ready: ready.length, conflicts: rows.filter((row) => row.status === "conflict").length, invalid: rows.filter((row) => row.status === "invalid").length,
      creates: ready.reduce((total, row) => total + row.creates, 0), updates: ready.reduce((total, row) => total + row.updates, 0), merges: ready.reduce((total, row) => total + row.merges, 0),
    },
  }
}

const VOLATILE_KEYS = new Set(["observedAt", "retrievedAt", "checkedAt"])

/** Vista de una fila para su huella: sin marcas de tiempo de consulta, que cambian entre preparar y aplicar. */
export function rowDigestView(row: PlanRow, decision: ProposedDecision): unknown {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip)
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !VOLATILE_KEYS.has(key)).map(([key, item]) => [key, strip(item)]))
    return value
  }
  return { decision, status: row.status, ops: strip(row.ops), selectedFields: strip(row.selectedFields), evidenceRefs: row.evidenceRefs }
}

/** Confianza visible con su alcance. */
export function confidenceText(label: ConfidenceLabel): string {
  return CONFIDENCE_TEXT[label]
}

export const CONFIDENCE_ORDER: readonly ConfidenceLabel[] = CONFIDENCE_LABELS

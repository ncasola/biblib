import { DEFAULT_BOOK_COVER, normalizeBookCover } from "../book-covers"
import type { CatalogLookupResult, CoverCandidate } from "../bibliographic-catalog/types"
import type { ImportOperationResult } from "../import-plan"
import type { Book } from "../types"

// Contrato de trabajos persistentes (U-DAT-03). Funciones puras compartidas por el ejecutor, las
// acciones y la interfaz: estados, transiciones, límites, reintentos y clasificación de resultados.
// Las funciones SQL de 0005 aplican las mismas reglas bajo bloqueo; estas son su referencia probada.

export const JOB_CONTRACT_VERSION = 1

export const JOB_KINDS = ["import", "covers"] as const
export type JobKind = (typeof JOB_KINDS)[number]

export const JOB_STATES = ["queued", "running", "waiting_retry", "needs_review", "paused", "succeeded", "partially_succeeded", "failed", "cancelled", "expired"] as const
export type JobState = (typeof JOB_STATES)[number]

export const TERMINAL_JOB_STATES: readonly JobState[] = ["succeeded", "partially_succeeded", "failed", "cancelled", "expired"]
/** Estados en los que el ejecutor puede reclamar el trabajo. */
export const ACTIVE_JOB_STATES: readonly JobState[] = ["queued", "running", "waiting_retry"]

/** La publicación de metadatos y la búsqueda de portadas son fases separadas con resultados distintos. */
export type JobPhase = "publish" | "covers" | "done"

export const ITEM_STATES = ["pending", "waiting_retry", "succeeded", "not_found", "skipped", "failed"] as const
export type JobItemState = (typeof ITEM_STATES)[number]

/** Primera configuración medible; un aumento exige pruebas y configuración, nunca una opción del cliente. */
export const JOB_LIMITS = Object.freeze({
  maxItemsPerStep: 20,
  stepBudgetMs: 20_000,
  fetchTimeoutMs: 8_000,
  leaseMs: 60_000,
  /** Se renueva el lease si quedan menos de estos milisegundos antes de una consulta externa. */
  renewMarginMs: 25_000,
  maxItemAttempts: 5,
  jobTtlDays: 7,
  summaryRetentionDays: 30,
  maxActiveJobs: 5,
})

export const RETRY_POLICY = Object.freeze({ baseMs: 5_000, maxMs: 15 * 60_000, maxRetryAfterMs: 60 * 60_000, jitterMs: 1_000 })

const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ["running", "paused", "cancelled", "expired"],
  // Un lease caducado se puede volver a reclamar: running → running con fencing mayor.
  running: ["running", "queued", "waiting_retry", "needs_review", "paused", "succeeded", "partially_succeeded", "failed", "cancelled", "expired"],
  waiting_retry: ["running", "paused", "cancelled", "expired"],
  // Revisar exige preparar una vista previa nueva; el trabajo antiguo nunca adquiere efecto por reintento.
  needs_review: ["cancelled", "expired"],
  paused: ["queued", "cancelled", "expired"],
  succeeded: [],
  partially_succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
}

export function isTerminal(state: JobState): boolean {
  return TERMINAL_JOB_STATES.includes(state)
}

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * La versión que ve el cliente solo rota con cambios que decide o debe conocer la persona (pausa,
 * cancelación, revisión, final). Alternar queued/running/waiting_retry entre pasos no la cambia, así
 * que pausar o cancelar no choca con el propio avance del trabajo.
 */
export function rotatesVersion(from: JobState, to: JobState): boolean {
  if (from === to) return false
  return !(ACTIVE_JOB_STATES.includes(from) && ACTIVE_JOB_STATES.includes(to))
}

export type JobControl = "pause" | "resume" | "cancel"
export type ControlDecision = { kind: "apply"; to: JobState } | { kind: "noop" } | { kind: "conflict" }

/** Pausar evita reclamar el próximo paso; cancelar es definitivo; reanudar vuelve a la cola. */
export function decideControl(state: JobState, action: JobControl): ControlDecision {
  if (action === "pause") {
    if (ACTIVE_JOB_STATES.includes(state)) return { kind: "apply", to: "paused" }
    return state === "paused" ? { kind: "noop" } : { kind: "conflict" }
  }
  if (action === "resume") {
    if (state === "paused") return { kind: "apply", to: "queued" }
    return ACTIVE_JOB_STATES.includes(state) ? { kind: "noop" } : { kind: "conflict" }
  }
  if (state === "cancelled") return { kind: "noop" }
  return isTerminal(state) ? { kind: "conflict" } : { kind: "apply", to: "cancelled" }
}

/**
 * Espera antes de reintentar un elemento: exponencial con jitter (mitad fija y mitad aleatoria) y
 * límite. Un `Retry-After` del proveedor o de la cuota se respeta siempre como mínimo.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random, retryAfterMs?: number): number {
  const exponential = Math.min(RETRY_POLICY.maxMs, RETRY_POLICY.baseMs * 2 ** Math.max(0, Math.min(attempt, 20) - 1))
  const jitter = Math.min(1, Math.max(0, random()))
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(RETRY_POLICY.maxRetryAfterMs, Math.ceil(retryAfterMs)) + Math.round(jitter * RETRY_POLICY.jitterMs)
  }
  return Math.round(exponential / 2 + (jitter * exponential) / 2)
}

export interface JobCounts {
  total: number
  /** Elementos con resultado definitivo. */
  processed: number
  recovered: number
  notFound: number
  skipped: number
  failed: number
  /** Elementos que esperan un reintento (cuota o proveedor no disponible). */
  retrying: number
}

export const EMPTY_COUNTS: JobCounts = { total: 0, processed: 0, recovered: 0, notFound: 0, skipped: 0, failed: 0, retrying: 0 }

export function countsFromItems(rows: { state: JobItemState; n: number }[]): JobCounts {
  const by = (state: JobItemState) => rows.filter((row) => row.state === state).reduce((total, row) => total + row.n, 0)
  const counts = { total: rows.reduce((total, row) => total + row.n, 0), recovered: by("succeeded"), notFound: by("not_found"), skipped: by("skipped"), failed: by("failed"), retrying: by("waiting_retry") }
  return { ...counts, processed: counts.recovered + counts.notFound + counts.skipped + counts.failed }
}

/** Estado tras un paso de portadas, según lo que queda pendiente y lo confirmado. */
export function stateAfterCovers(input: { pendingDue: number; retrying: number; counts: JobCounts; published: boolean; rateLimited: boolean }): Extract<JobState, "queued" | "waiting_retry" | "succeeded" | "partially_succeeded" | "failed"> {
  if (input.pendingDue > 0) return input.rateLimited ? "waiting_retry" : "queued"
  if (input.retrying > 0) return "waiting_retry"
  if (input.counts.failed === 0) return "succeeded"
  return input.published || input.counts.failed < input.counts.total ? "partially_succeeded" : "failed"
}

export type CoverOutcome =
  | { kind: "found"; cover: Book["cover"] }
  | { kind: "notFound" }
  | { kind: "retry"; code: "RATE_LIMITED" | "PROVIDER_UNAVAILABLE"; retryAfterMs?: number }
  | { kind: "failed"; code: "PROVIDER_DISABLED" }

/** Tamaños de Open Library derivados de la URL grande; otras fuentes usan la misma imagen. */
export function coverFromImage(imageUrl: string): Book["cover"] {
  const match = /^(https:\/\/covers\.openlibrary\.org\/b\/[a-z]+\/[^/?#]+)-L\.jpg$/i.exec(imageUrl)
  const cover = match ? { small: `${match[1]}-S.jpg`, medium: `${match[1]}-M.jpg`, large: imageUrl } : { small: imageUrl, medium: imageUrl, large: imageUrl }
  return normalizeBookCover(cover)
}

/**
 * Traduce el resultado del servicio bibliográfico. Esperar cuota o una caída no equivalen a «no hay
 * portada»: solo una ausencia confirmada por todas las fuentes elegibles es `notFound`.
 */
export function classifyCoverLookup(result: CatalogLookupResult<CoverCandidate>): CoverOutcome {
  const image = result.candidates.find((candidate) => candidate.imageUrl)?.imageUrl
  if (image) {
    const cover = coverFromImage(image)
    if (cover.large !== DEFAULT_BOOK_COVER) return { kind: "found", cover }
  }
  if (result.status === "notFound" || (result.status === "found" && result.complete)) return { kind: "notFound" }
  const limited = result.providers.filter((provider) => provider.status === "rateLimited")
  if (limited.length) {
    const seconds = Math.max(0, ...limited.map((provider) => provider.retryAfterSeconds ?? 0))
    return { kind: "retry", code: "RATE_LIMITED", ...(seconds > 0 ? { retryAfterMs: seconds * 1000 } : {}) }
  }
  if (result.deadlineExceeded || result.providers.some((provider) => provider.status === "unavailable" || provider.reason === "deadline")) {
    return { kind: "retry", code: "PROVIDER_UNAVAILABLE" }
  }
  return { kind: "failed", code: "PROVIDER_DISABLED" }
}

/** Resultado durable de la publicación de una importación. */
export interface ImportJobResult {
  operationId: string
  result: ImportOperationResult
  /** true si la publicación recuperó el resultado de una confirmación anterior con la misma clave. */
  replayed: boolean
}

/** Vista del trabajo para su dueño: IDs técnicos y cantidades confirmadas, sin títulos ni ISBN. */
export interface LibraryJobView {
  id: string
  kind: JobKind
  state: JobState
  phase: JobPhase
  version: string
  counts: JobCounts
  /** La publicación de metadatos ya se confirmó; cancelar después no la revierte. */
  published: boolean
  publishedAt: string | null
  result: ImportJobResult | null
  errorCode: string | null
  nextAttemptAt: string | null
  createdAt: string
  updatedAt: string
  finishedAt: string | null
  expiresAt: string
}

export interface ControlResult {
  job: LibraryJobView
  /** Para cancelar: si la solicitud llegó antes o después de publicar los metadatos. */
  publication: "before" | "after" | "none"
}

/** Clave de idempotencia del cliente: opaca y acotada, igual que la confirmación de U-DAT-01. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

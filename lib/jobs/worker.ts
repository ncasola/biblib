import type { BibliographicCatalogService } from "../bibliographic-catalog/types"
import { isCoverRecoveryCandidate } from "../cover-recovery"
import { DomainError, databaseErrorCode, isRetryable, type DomainErrorCode } from "../domain-errors"
import { lockCollection, publishImport, type PublishOutcome } from "../import-publisher"
import { normalizeIsbn } from "../isbn"
import { emitSafely, noopTelemetry, type TelemetryEmitter } from "../observability/emitter"
import {
  classifyCoverLookup, JOB_LIMITS, retryDelayMs, stateAfterCovers,
  type CoverOutcome, type JobPhase, type JobState,
} from "./contracts"
import { applyRecoveredCovers, LeaseLostError, type ClaimedJob, type ItemUpdate, type JobRepository } from "./repository"

// Ejecutor acotado de trabajos (U-DAT-03). Cada paso reclama un trabajo con lease, hace como mucho
// 20 elementos o 20 s de trabajo, consulta la red fuera de cualquier transacción y confirma en una
// transacción corta y cercada. Un paso que pierde el lease descarta lo que tenga en memoria: otro
// trabajador lo repetirá desde el último estado confirmado.

export type WorkerLimits = { [K in keyof typeof JOB_LIMITS]: number }

/** Puntos de prueba para simular la caída del trabajador; producción no los usa. */
export interface WorkerHooks {
  afterFetch?(job: ClaimedJob): Promise<void> | void
  beforeCommit?(job: ClaimedJob, phase: JobPhase): Promise<void> | void
  afterCommit?(job: ClaimedJob, phase: JobPhase): Promise<void> | void
}

export interface WorkerDeps {
  repo: JobRepository
  /** Servicio bibliográfico U-BIB con el gateway U-DAT-05 en modo lote. */
  catalog: Pick<BibliographicCatalogService, "getCover">
  telemetry?: TelemetryEmitter
  random?: () => number
  now?: () => number
  limits?: Partial<WorkerLimits>
  hooks?: WorkerHooks
}

export interface StepReport {
  jobId: string
  kind: ClaimedJob["kind"]
  phase: JobPhase
  outcome: "progressed" | "lease_lost" | "error"
  state?: JobState
}

const operation = (job: ClaimedJob) => `job.${job.kind}.${job.phase}`

function errorCodeOf(error: unknown): DomainErrorCode {
  if (error instanceof DomainError) return error.code
  const code = databaseErrorCode(error)
  if (code === "23505" || code === "23503") return "CONFLICT"
  return "PROVIDER_UNAVAILABLE"
}

async function publishStep(deps: Required<Pick<WorkerDeps, "repo" | "random">> & WorkerDeps, job: ClaimedJob): Promise<StepReport> {
  const report: StepReport = { jobId: job.id, kind: job.kind, phase: job.phase, outcome: "progressed" }
  let published: { outcome: PublishOutcome; state: JobState } | undefined
  try {
    published = await deps.repo.fenced(job, async (context) => {
      const outcome = await context.asOwner((tx) => publishImport(tx, { userId: context.owner, previewId: job.previewId!, expectedRevision: job.expectedRevision!, idempotencyKey: job.idempotencyKey }))
      // Las portadas pendientes son una fase aparte: no revierten la publicación.
      if (outcome.insertedBookIds.length) await context.seedCoverItems(outcome.insertedBookIds)
      const { counts } = await context.recount()
      const state: JobState = counts.total > 0 ? "queued" : "succeeded"
      await context.finish({ state, phase: counts.total > 0 ? "covers" : "done", counts, published: true, cursor: null,
        result: { operationId: outcome.operationId, result: outcome.result, replayed: outcome.replayed } })
      await deps.hooks?.beforeCommit?.(job, "publish")
      return { outcome, state }
    })
  } catch (error) {
    if (error instanceof LeaseLostError) throw error
    // El rechazo se anota en otra transacción cercada: la publicación no dejó nada escrito.
    const code = errorCodeOf(error)
    const state: JobState = code === "REVISION_CONFLICT" ? "needs_review" : isRetryable(code) ? "waiting_retry" : "failed"
    await deps.repo.fenced(job, (context) => context.finish({ state, errorCode: code, keepAttempts: state === "waiting_retry", delayMs: state === "waiting_retry" ? retryDelayMs(job.attempts, deps.random) : 0 }))
    emitSafely(deps.telemetry ?? noopTelemetry, state === "waiting_retry" ? "job.retried" : "job.failed", { operation: operation(job), result: "error", errorCode: code, attempt: job.attempts })
    return { ...report, state }
  }
  await deps.hooks?.afterCommit?.(job, "publish")
  return { ...report, state: published.state }
}

interface CoverDecision { update: ItemUpdate; recovered?: { id: string; version: string; cover: { small: string; medium: string; large: string } } }

function retryUpdate(itemKey: string, attempts: number, outcome: Extract<CoverOutcome, { kind: "retry" }>, random: () => number, maxAttempts: number): ItemUpdate {
  // Esperar cuota no consume intentos ni es «no encontrado»: solo una caída cuenta para el límite.
  const counts = outcome.code !== "RATE_LIMITED"
  if (counts && attempts + 1 >= maxAttempts) return { itemKey, state: "failed", attempt: true, delayMs: 0, errorCode: outcome.code }
  return { itemKey, state: "waiting_retry", attempt: counts, delayMs: retryDelayMs(attempts + 1, random, outcome.retryAfterMs), errorCode: outcome.code }
}

async function coversStep(deps: Required<Pick<WorkerDeps, "repo" | "random" | "now">> & WorkerDeps, job: ClaimedJob, limits: WorkerLimits): Promise<StepReport> {
  const report: StepReport = { jobId: job.id, kind: job.kind, phase: job.phase, outcome: "progressed" }
  const started = deps.now()
  let leaseDeadline = started + limits.leaseMs
  // Un trabajo de portadas crea sus elementos en su primer paso, con la versión vista de cada libro.
  if (job.kind === "covers" && job.counts.total === 0 && job.cursor === null) {
    await deps.repo.fenced(job, async (context) => {
      await context.seedCoverItems()
      const { counts } = await context.recount()
      await context.finish({ state: counts.total > 0 ? "queued" : "succeeded", phase: counts.total > 0 ? "covers" : "done", counts, cursor: counts.total > 0 ? "" : null })
    })
    const claimed = await deps.repo.claim({ jobId: job.id }, limits.leaseMs)
    if (!claimed) return { ...report, state: "queued" }
    job = claimed
    leaseDeadline = deps.now() + limits.leaseMs
  }

  const items = await deps.repo.dueItems(job, limits.maxItemsPerStep)
  const snapshots = await deps.repo.coverSnapshots(job.userId, items.map((item) => item.itemKey))
  const decisions: CoverDecision[] = []
  let rateLimited = false
  let rateLimitDelayMs = 0
  for (const item of items) {
    const book = snapshots.get(item.itemKey)
    // Libro borrado, modificado a mano o ya con portada: se omite sin consultar la red.
    if (!book || (item.targetVersion && book.version !== item.targetVersion) || !isCoverRecoveryCandidate(book.cover)) {
      decisions.push({ update: { itemKey: item.itemKey, state: "skipped", attempt: false, delayMs: 0, errorCode: book ? "CHANGED" : "MISSING" } })
      continue
    }
    const isbn = normalizeIsbn(book.isbn)
    if (!isbn) {
      decisions.push({ update: { itemKey: item.itemKey, state: "skipped", attempt: false, delayMs: 0, errorCode: "NO_ISBN" } })
      continue
    }
    const elapsed = deps.now() - started
    const budget = limits.stepBudgetMs - elapsed
    if (budget < 1_000) break
    if (leaseDeadline - deps.now() < limits.renewMarginMs) {
      if (!(await deps.repo.renew(job, limits.leaseMs))) throw new LeaseLostError("lease")
      leaseDeadline = deps.now() + limits.leaseMs
    }
    let outcome: CoverOutcome
    try {
      outcome = classifyCoverLookup(await deps.catalog.getCover(isbn, { userId: job.userId, timeoutMs: Math.min(limits.fetchTimeoutMs, budget) }))
    } catch {
      outcome = { kind: "retry", code: "PROVIDER_UNAVAILABLE" }
    }
    if (outcome.kind === "found") {
      decisions.push({ update: { itemKey: item.itemKey, state: "succeeded", attempt: true, delayMs: 0, result: { cover: outcome.cover } }, recovered: { id: book.id, version: book.version, cover: outcome.cover } })
    } else if (outcome.kind === "notFound") {
      decisions.push({ update: { itemKey: item.itemKey, state: "not_found", attempt: true, delayMs: 0 } })
    } else if (outcome.kind === "failed") {
      decisions.push({ update: { itemKey: item.itemKey, state: "failed", attempt: true, delayMs: 0, errorCode: outcome.code } })
    } else {
      const update = retryUpdate(item.itemKey, item.attempts, outcome, deps.random, limits.maxItemAttempts)
      decisions.push({ update })
      // Tras un límite del proveedor no se siguen enviando peticiones: todo el trabajo espera su Retry-After.
      if (outcome.code === "RATE_LIMITED") { rateLimited = true; rateLimitDelayMs = update.delayMs; break }
    }
  }
  await deps.hooks?.afterFetch?.(job)

  let state: JobState = "queued"
  await deps.repo.fenced(job, async (context) => {
    const recovered = decisions.flatMap((decision) => decision.recovered ? [decision.recovered] : [])
    // Solo escribe si el libro conserva versión y preimagen; si no, el elemento queda omitido.
    const applied = recovered.length ? await context.asOwner(async (tx) => {
      await lockCollection(tx)
      return applyRecoveredCovers(tx, context.owner, recovered)
    }) : new Set<string>()
    await context.updateItems(decisions.map(({ update, recovered: entry }) => entry && !applied.has(entry.id)
      ? { ...update, state: "skipped" as const, result: null, errorCode: "CHANGED" } : update))
    const { counts, pendingDue } = await context.recount()
    state = stateAfterCovers({ pendingDue, retrying: counts.retrying, counts, published: job.published, rateLimited })
    const last = decisions.at(-1)?.update.itemKey
    await context.finish({ state, counts, phase: ["queued", "waiting_retry"].includes(state) ? "covers" : "done", cursor: last ?? job.cursor,
      errorCode: rateLimited ? "RATE_LIMITED" : null, delayMs: rateLimited ? rateLimitDelayMs : 0 })
    await deps.hooks?.beforeCommit?.(job, "covers")
  })
  await deps.hooks?.afterCommit?.(job, "covers")
  const retried = decisions.filter((decision) => decision.update.state === "waiting_retry").length
  if (retried) emitSafely(deps.telemetry ?? noopTelemetry, "job.retried", { operation: operation(job), result: "error", batch: retried, errorCode: rateLimited ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE" })
  return { ...report, state }
}

/**
 * Reclama y ejecuta un paso. Devuelve null si no hay trabajo vencido. Un fallo inesperado deja el
 * trabajo en `waiting_retry` con backoff; si ni eso es posible, el lease caduca y otro lo reclamará.
 */
export async function runJobStep(input: WorkerDeps, filter: { jobId?: string; owner?: string } = {}): Promise<StepReport | null> {
  const limits: WorkerLimits = { ...JOB_LIMITS, ...input.limits }
  const deps = { ...input, random: input.random ?? Math.random, now: input.now ?? Date.now }
  const telemetry = input.telemetry ?? noopTelemetry
  const job = await deps.repo.claim(filter, limits.leaseMs)
  if (!job) return null
  const started = deps.now()
  emitSafely(telemetry, "job.started", { operation: operation(job), result: "ok", attempt: job.attempts })
  try {
    const report = job.kind === "import" && job.phase === "publish" ? await publishStep(deps, job) : await coversStep(deps, job, limits)
    emitSafely(telemetry, "db.operation", { operation: operation(job), result: "ok", durationMs: Math.max(0, deps.now() - started) })
    return report
  } catch (error) {
    if (error instanceof LeaseLostError) {
      emitSafely(telemetry, "job.failed", { operation: operation(job), result: "skipped", errorCode: error.reason === "account" ? "ACCOUNT_INACTIVE" : "LEASE_LOST" })
      return { jobId: job.id, kind: job.kind, phase: job.phase, outcome: "lease_lost" }
    }
    const code = errorCodeOf(error)
    try {
      await deps.repo.fenced(job, (context) => context.finish({ state: "waiting_retry", errorCode: "STEP_FAILED", keepAttempts: true, delayMs: retryDelayMs(job.attempts, deps.random) }))
    } catch { /* Sin conexión: el lease caduca y el trabajo vuelve a reclamarse. */ }
    emitSafely(telemetry, "job.failed", { operation: operation(job), result: "error", errorCode: code, attempt: job.attempts })
    return { jobId: job.id, kind: job.kind, phase: job.phase, outcome: "error", state: "waiting_retry" }
  }
}

/** Ejecuta pasos mientras quede trabajo vencido y presupuesto. Devuelve los pasos ejecutados. */
export async function drainJobs(input: WorkerDeps, filter: { jobId?: string; owner?: string } = {}, budgetMs = 25_000): Promise<StepReport[]> {
  const now = input.now ?? Date.now
  const deadline = now() + budgetMs
  const reports: StepReport[] = []
  while (now() < deadline) {
    const report = await runJobStep(input, filter)
    if (!report) break
    reports.push(report)
    if (report.outcome !== "progressed") break
  }
  return reports
}

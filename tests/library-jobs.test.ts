import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { CatalogLookupResult, CoverCandidate, ProviderOutcome } from "../lib/bibliographic-catalog/types"
import { DEFAULT_BOOK_COVER } from "../lib/book-covers"
import { DomainError, httpStatusForDomainError, isRetryable, jobConflict, jobExpired } from "../lib/domain-errors"
import {
  ACTIVE_JOB_STATES, canTransition, classifyCoverLookup, countsFromItems, coverFromImage, decideControl, EMPTY_COUNTS, isTerminal,
  JOB_LIMITS, JOB_STATES, RETRY_POLICY, retryDelayMs, rotatesVersion, stateAfterCovers, TERMINAL_JOB_STATES, type JobState,
} from "../lib/jobs/contracts"
import { jobView, LeaseLostError, type ClaimedJob, type FencedContext, type FinishUpdate, type ItemUpdate, type JobRepository } from "../lib/jobs/repository"
import { isRunnerAuthorized, runnerToken } from "../lib/jobs/runner-auth"
import { runJobStep } from "../lib/jobs/worker"

const providers = (...outcomes: Partial<ProviderOutcome>[]): ProviderOutcome[] => outcomes.map((outcome, index) => ({ provider: `p${index}`, status: "notFound", requestId: `r${index}`, ...outcome }))
const lookup = (overrides: Partial<CatalogLookupResult<CoverCandidate>>): CatalogLookupResult<CoverCandidate> => ({ status: "notFound", candidates: [], providers: providers({ status: "notFound" }), complete: true, deadlineExceeded: false, ...overrides })
const cover = (imageUrl?: string): CoverCandidate => ({ provider: "open-library", coverKey: "k", imageUrl, rightsPolicyVersion: "v1" })

describe("estados de un trabajo", () => {
  test("los estados finales no admiten transiciones y los activos sí", () => {
    for (const state of TERMINAL_JOB_STATES) for (const to of JOB_STATES) assert.equal(canTransition(state, to), false, `${state} → ${to}`)
    assert.ok(canTransition("queued", "running"))
    assert.ok(canTransition("running", "running"), "un lease caducado se vuelve a reclamar")
    assert.ok(canTransition("running", "needs_review"))
    assert.ok(canTransition("waiting_retry", "running"))
    assert.ok(canTransition("paused", "queued"))
    assert.equal(canTransition("paused", "running"), false, "una pausa no se reclama sin reanudar")
    assert.deepEqual(JOB_STATES.filter((to) => canTransition("needs_review", to)), ["cancelled", "expired"], "revisar exige una vista previa nueva")
    assert.deepEqual(JOB_STATES.filter(isTerminal), ["succeeded", "partially_succeeded", "failed", "cancelled", "expired"])
  })

  test("pausar, reanudar y cancelar según el estado", () => {
    const table: Record<JobState, [string, string, string]> = {
      queued: ["paused", "noop", "cancelled"], running: ["paused", "noop", "cancelled"], waiting_retry: ["paused", "noop", "cancelled"],
      paused: ["noop", "queued", "cancelled"], needs_review: ["conflict", "conflict", "cancelled"],
      succeeded: ["conflict", "conflict", "conflict"], partially_succeeded: ["conflict", "conflict", "conflict"], failed: ["conflict", "conflict", "conflict"],
      cancelled: ["conflict", "conflict", "noop"], expired: ["conflict", "conflict", "conflict"],
    }
    for (const state of JOB_STATES) {
      const got = (["pause", "resume", "cancel"] as const).map((action) => { const decision = decideControl(state, action); return decision.kind === "apply" ? decision.to : decision.kind })
      assert.deepEqual(got, table[state], state)
      for (const decision of got) if (JOB_STATES.includes(decision as JobState)) assert.ok(canTransition(state, decision as JobState), `${state} → ${decision} debe ser una transición válida`)
    }
  })

  test("la versión del cliente no rota al alternar cola y ejecución", () => {
    for (const from of ACTIVE_JOB_STATES) for (const to of ACTIVE_JOB_STATES) assert.equal(rotatesVersion(from, to), false)
    assert.ok(rotatesVersion("running", "paused"))
    assert.ok(rotatesVersion("paused", "queued"))
    assert.ok(rotatesVersion("running", "succeeded"))
    assert.ok(rotatesVersion("running", "needs_review"))
  })

  test("estado tras un paso de portadas", () => {
    const counts = (patch: Partial<typeof EMPTY_COUNTS>) => ({ ...EMPTY_COUNTS, total: 4, ...patch })
    assert.equal(stateAfterCovers({ pendingDue: 2, retrying: 0, counts: counts({}), published: false, rateLimited: false }), "queued")
    assert.equal(stateAfterCovers({ pendingDue: 2, retrying: 1, counts: counts({}), published: false, rateLimited: true }), "waiting_retry", "tras un 429 todo espera")
    assert.equal(stateAfterCovers({ pendingDue: 0, retrying: 1, counts: counts({}), published: false, rateLimited: false }), "waiting_retry")
    assert.equal(stateAfterCovers({ pendingDue: 0, retrying: 0, counts: counts({ processed: 4, notFound: 4 }), published: false, rateLimited: false }), "succeeded", "sin portada no es un fallo")
    assert.equal(stateAfterCovers({ pendingDue: 0, retrying: 0, counts: counts({ processed: 4, failed: 1, recovered: 3 }), published: false, rateLimited: false }), "partially_succeeded")
    assert.equal(stateAfterCovers({ pendingDue: 0, retrying: 0, counts: counts({ processed: 4, failed: 4 }), published: true, rateLimited: false }), "partially_succeeded", "una portada pendiente no revierte la importación publicada")
    assert.equal(stateAfterCovers({ pendingDue: 0, retrying: 0, counts: counts({ processed: 4, failed: 4 }), published: false, rateLimited: false }), "failed")
  })

  test("cantidades confirmadas a partir de los elementos", () => {
    assert.deepEqual(countsFromItems([{ state: "succeeded", n: 2 }, { state: "not_found", n: 1 }, { state: "skipped", n: 3 }, { state: "failed", n: 1 }, { state: "waiting_retry", n: 2 }, { state: "pending", n: 4 }]),
      { total: 13, processed: 7, recovered: 2, notFound: 1, skipped: 3, failed: 1, retrying: 2 })
  })

  test("códigos JOB_CONFLICT (409) y JOB_EXPIRED (410), en español y sin reintento automático", () => {
    for (const [error, status] of [[jobConflict(), 409], [jobExpired(), 410]] as const) {
      assert.ok(error instanceof DomainError)
      assert.equal(isRetryable(error.code), false)
      assert.equal(httpStatusForDomainError(error.code), status)
      assert.match(error.message, /trabajo/)
    }
  })
})

describe("reintentos", () => {
  test("backoff exponencial con jitter y límite", () => {
    assert.equal(retryDelayMs(1, () => 0), RETRY_POLICY.baseMs / 2)
    assert.equal(retryDelayMs(1, () => 1), RETRY_POLICY.baseMs)
    assert.equal(retryDelayMs(3, () => 1), RETRY_POLICY.baseMs * 4)
    for (const attempt of [1, 2, 5, 12, 40]) {
      for (const random of [0, 0.37, 1]) {
        const delay = retryDelayMs(attempt, () => random)
        const ceiling = Math.min(RETRY_POLICY.maxMs, RETRY_POLICY.baseMs * 2 ** (Math.min(attempt, 20) - 1))
        assert.ok(delay >= ceiling / 2 && delay <= ceiling, `intento ${attempt}: ${delay}`)
      }
    }
    assert.ok(retryDelayMs(2, () => 0.9) > retryDelayMs(2, () => 0.1), "el jitter separa a los trabajadores")
  })

  test("Retry-After se respeta como mínimo y se acota a 1 h", () => {
    assert.ok(retryDelayMs(1, () => 0, 30_000) >= 30_000)
    assert.ok(retryDelayMs(1, () => 1, 30_000) <= 30_000 + RETRY_POLICY.jitterMs)
    assert.ok(retryDelayMs(1, () => 0, 10 * 60 * 60_000) <= RETRY_POLICY.maxRetryAfterMs + RETRY_POLICY.jitterMs)
    assert.equal(retryDelayMs(1, () => 0, Number.NaN), RETRY_POLICY.baseMs / 2, "un Retry-After ilegible no anula el backoff")
  })

  test("límites de la primera configuración", () => {
    assert.deepEqual({ items: JOB_LIMITS.maxItemsPerStep, step: JOB_LIMITS.stepBudgetMs, fetch: JOB_LIMITS.fetchTimeoutMs, lease: JOB_LIMITS.leaseMs }, { items: 20, step: 20_000, fetch: 8_000, lease: 60_000 })
    assert.ok(JOB_LIMITS.renewMarginMs < JOB_LIMITS.leaseMs - JOB_LIMITS.fetchTimeoutMs, "se renueva con margen antes de una consulta")
  })
})

describe("clasificación de portadas", () => {
  test("imagen encontrada en Open Library con sus tamaños", () => {
    const outcome = classifyCoverLookup(lookup({ status: "found", candidates: [cover("https://covers.openlibrary.org/b/id/123-L.jpg")] }))
    assert.deepEqual(outcome, { kind: "found", cover: { small: "https://covers.openlibrary.org/b/id/123-S.jpg", medium: "https://covers.openlibrary.org/b/id/123-M.jpg", large: "https://covers.openlibrary.org/b/id/123-L.jpg" }, provider: "open-library" })
    assert.deepEqual(coverFromImage("https://books.example/portada.jpg"), { small: "https://books.example/portada.jpg", medium: "https://books.example/portada.jpg", large: "https://books.example/portada.jpg" })
    assert.equal(coverFromImage(DEFAULT_BOOK_COVER).large, DEFAULT_BOOK_COVER)
  })

  test("solo una ausencia confirmada es «sin portada»", () => {
    assert.deepEqual(classifyCoverLookup(lookup({})), { kind: "notFound" })
    assert.deepEqual(classifyCoverLookup(lookup({ status: "found", candidates: [cover()], complete: true })), { kind: "notFound" })
  })

  test("cuota, caída, plazo y JSON roto se reintentan; nunca son ausencia", () => {
    assert.deepEqual(classifyCoverLookup(lookup({ status: "incomplete", complete: false, providers: providers({ status: "rateLimited", retryAfterSeconds: 7 }) })), { kind: "retry", code: "RATE_LIMITED", retryAfterMs: 7000 })
    assert.deepEqual(classifyCoverLookup(lookup({ status: "incomplete", complete: false, providers: providers({ status: "rateLimited" }) })), { kind: "retry", code: "RATE_LIMITED" })
    assert.deepEqual(classifyCoverLookup(lookup({ status: "incomplete", complete: false, providers: providers({ status: "unavailable" }) })), { kind: "retry", code: "PROVIDER_UNAVAILABLE" })
    assert.deepEqual(classifyCoverLookup(lookup({ status: "incomplete", complete: false, deadlineExceeded: true, providers: providers({ status: "notAttempted", reason: "deadline" }) })), { kind: "retry", code: "PROVIDER_UNAVAILABLE" })
    assert.deepEqual(classifyCoverLookup(lookup({ status: "incomplete", complete: false, providers: providers({ status: "disabled", reason: "policy" }) })), { kind: "failed", code: "PROVIDER_DISABLED" })
  })
})

describe("entrada interna del ejecutor", () => {
  const env = { SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55342/postgres" }
  test("token derivado de la conexión o secreto explícito, comparación exacta", () => {
    const token = runnerToken(env)!
    assert.equal(token, "rq32VLQEo4VVLW__cEk63UWpMO21z9JeXSdFJZxaZWc", "mismo vector que scripts/jobs/run-local.mjs")
    assert.ok(isRunnerAuthorized(`Bearer ${token}`, env))
    assert.equal(isRunnerAuthorized(`Bearer ${token}x`, env), false)
    assert.equal(isRunnerAuthorized(null, env), false)
    assert.equal(isRunnerAuthorized(`Bearer ${token}`, {}), false, "sin configuración la entrada queda cerrada")
    assert.equal(runnerToken({ BIBLIB_JOBS_RUNNER_SECRET: "corto" }), null, "un secreto débil no habilita la entrada")
    const secret = "s".repeat(40)
    assert.ok(isRunnerAuthorized(`Bearer ${secret}`, { ...env, BIBLIB_JOBS_RUNNER_SECRET: secret }))
    assert.equal(isRunnerAuthorized(`Bearer ${token}`, { ...env, BIBLIB_JOBS_RUNNER_SECRET: secret }), false)
  })
})

describe("vista del trabajo", () => {
  const row = {
    id: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-0000000000aa", kind: "covers" as const, contractVersion: 1,
    idempotencyKey: "clave-1234567890ab", inputDigest: "a".repeat(64), previewId: null, expectedRevision: null, state: "queued", phase: "covers",
    cursor: null, counts: { total: 3, processed: 1 }, result: null, errorCode: null, attempts: 0, nextAttemptAt: new Date("2026-10-23T10:00:00Z"),
    leaseUntil: null, leaseToken: null, fencingNumber: BigInt(0), publishedAt: null, version: "00000000-0000-4000-8000-0000000000bb",
    expiresAt: new Date("2026-10-30T10:00:00Z"), createdAt: new Date("2026-10-23T09:00:00Z"), updatedAt: new Date("2026-10-23T09:30:00Z"), finishedAt: null,
  }
  test("solo IDs técnicos y cantidades; caducado al vencer aunque no se haya persistido", () => {
    const view = jobView(row, new Date("2026-10-23T12:00:00Z"))
    assert.equal(view.state, "queued")
    assert.deepEqual(view.counts, { ...EMPTY_COUNTS, total: 3, processed: 1 })
    assert.equal(view.nextAttemptAt, null)
    assert.ok(!("userId" in view) && !("leaseToken" in view), "la vista no expone dueño ni lease")
    const expired = jobView(row, new Date("2026-11-01T00:00:00Z"))
    assert.equal(expired.state, "expired")
    assert.equal(expired.errorCode, "JOB_EXPIRED")
    assert.equal(jobView({ ...row, state: "waiting_retry" }).nextAttemptAt, "2026-10-23T10:00:00.000Z")
  })
})

/** Repositorio en memoria para el paso de portadas; la base real se prueba en tests/integration/jobs. */
function fakeRepository(input: { items: { key: string; isbn: string; version?: string; cover?: string }[]; renew?: boolean }) {
  const updates: ItemUpdate[] = []
  const finishes: FinishUpdate[] = []
  let claimed = false
  const job: ClaimedJob = { id: "job", leaseToken: "t", fencing: "1", userId: "owner", kind: "covers", phase: "covers", previewId: null, expectedRevision: null,
    idempotencyKey: "k".repeat(16), cursor: "", counts: { ...EMPTY_COUNTS, total: input.items.length }, published: false, attempts: 1 }
  const repo = {
    async claim() { if (claimed) return null; claimed = true; return job },
    async renew() { return input.renew ?? true },
    async fenced<T>(_lease: unknown, work: (context: FencedContext) => Promise<T>) {
      const context = {
        owner: "owner", tx: undefined as never,
        asOwner: async () => { throw new Error("no debe escribir dominio en esta prueba") },
        seedCoverItems: async () => 0,
        updateItems: async (list: ItemUpdate[]) => { updates.push(...list) },
        recount: async () => ({ counts: { ...EMPTY_COUNTS, total: input.items.length, processed: updates.filter((u) => !["pending", "waiting_retry"].includes(u.state)).length, retrying: updates.filter((u) => u.state === "waiting_retry").length }, pendingDue: input.items.length - updates.length }),
        finish: async (update: FinishUpdate) => { finishes.push(update) },
      } satisfies FencedContext
      return work(context)
    },
    async dueItems() { return input.items.map((item) => ({ itemKey: item.key, state: "pending" as const, targetVersion: item.version ?? "v", attempts: 0 })) },
    async coverSnapshots() { return new Map(input.items.map((item) => [item.key, { id: item.key, isbn: item.isbn, version: "v", cover: { small: item.cover ?? DEFAULT_BOOK_COVER, medium: item.cover ?? DEFAULT_BOOK_COVER, large: item.cover ?? DEFAULT_BOOK_COVER } }])) },
    async read() { return null },
  } satisfies JobRepository
  return { repo, updates, finishes }
}

describe("paso de portadas", () => {
  test("omite sin red los libros sin ISBN, cambiados o con portada; «sin portada» es definitivo", async () => {
    const calls: string[] = []
    const { repo, updates, finishes } = fakeRepository({ items: [
      { key: "a", isbn: "manual-1" }, { key: "b", isbn: "9780000000019", version: "otra" }, { key: "c", isbn: "9780000000026", cover: "https://x/portada.jpg" }, { key: "d", isbn: "9780000000033" },
    ] })
    const report = await runJobStep({ repo, catalog: { getCover: async (isbn) => { calls.push(isbn); return lookup({}) } } })
    assert.equal(report?.outcome, "progressed")
    assert.deepEqual(calls, ["9780000000033"], "solo se consulta el libro candidato")
    assert.deepEqual(updates.map((u) => [u.itemKey, u.state, u.errorCode ?? null]), [["a", "skipped", "NO_ISBN"], ["b", "skipped", "CHANGED"], ["c", "skipped", "CHANGED"], ["d", "not_found", null]])
    assert.equal(finishes.at(-1)?.state, "succeeded")
  })

  test("tras un 429 no se envían más peticiones y la cuota no consume intentos", async () => {
    const calls: string[] = []
    const { repo, updates, finishes } = fakeRepository({ items: [{ key: "a", isbn: "9780000000019" }, { key: "b", isbn: "9780000000026" }] })
    await runJobStep({ repo, random: () => 0, catalog: { getCover: async (isbn) => { calls.push(isbn); return lookup({ status: "incomplete", complete: false, providers: providers({ status: "rateLimited", retryAfterSeconds: 30 }) }) } } })
    assert.equal(calls.length, 1)
    assert.deepEqual(updates.map((u) => [u.itemKey, u.state, u.attempt, u.errorCode]), [["a", "waiting_retry", false, "RATE_LIMITED"]])
    assert.ok(updates[0].delayMs >= 30_000)
    assert.equal(finishes.at(-1)?.state, "waiting_retry")
    assert.ok((finishes.at(-1)?.delayMs ?? 0) >= 30_000, "todo el trabajo espera el Retry-After")
  })

  test("una caída o una excepción del proveedor se reintentan con backoff y cuentan como intento", async () => {
    const { repo, updates } = fakeRepository({ items: [{ key: "a", isbn: "9780000000019" }, { key: "b", isbn: "9780000000026" }] })
    let first = true
    await runJobStep({ repo, random: () => 0, catalog: { getCover: async () => { if (first) { first = false; throw new SyntaxError("JSON roto") } return lookup({ status: "incomplete", complete: false, providers: providers({ status: "unavailable" }) }) } } })
    assert.deepEqual(updates.map((u) => [u.state, u.attempt, u.errorCode]), [["waiting_retry", true, "PROVIDER_UNAVAILABLE"], ["waiting_retry", true, "PROVIDER_UNAVAILABLE"]])
  })

  test("si no puede renovar el lease antes de consultar, descarta el paso", async () => {
    const { repo, updates } = fakeRepository({ items: [{ key: "a", isbn: "9780000000019" }], renew: false })
    let now = 0
    const report = await runJobStep({ repo, now: () => (now += 1_000), limits: { renewMarginMs: 59_000 }, catalog: { getCover: async () => lookup({}) } })
    assert.equal(report?.outcome, "lease_lost")
    assert.equal(updates.length, 0, "nada en memoria se confirma tras perder el lease")
    assert.ok(new LeaseLostError("account").message.includes("cuenta"))
  })
})

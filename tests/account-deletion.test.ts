import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, test } from "node:test"
import { deletionPhase, DELETION_CONFIRMATION, isRecentSignIn, lastSignInAt, OPERATION_KEY_PATTERN, RECENT_SIGN_IN_MS, toDeletionView } from "../lib/account-deletion/contracts"
import {
  ACCOUNT_DATA_INVENTORY, DELETION_STEPS, drainDeletions, LeaseLostError, MARK_RETENTION_DAYS, processDeletion,
  type ClaimedDeletion, type DatabaseStep, type DeletionDatabase, type DeletionDeps, type DeletionErrorCode, type DeletionStep, type StorageObjectRef,
} from "../lib/account-deletion/worker"
import { accountInactive, httpStatusForDomainError, isRetryable, translateDatabaseError } from "../lib/domain-errors"
import { mutationResult } from "../lib/action-result"

const OWNER = "ad000000-0000-4000-8000-0000000000e1"

/** Base simulada con el contrato de 0013: pasos en orden, lotes que se vacían y fallos registrados. */
function fakeDeletion({ step = "sessions" as DeletionStep, rows = 3, objects = [{ bucket: "biblib-covers", name: `${OWNER}/a/1.webp` }] as StorageObjectRef[], attempts = 1 } = {}) {
  const log: string[] = []
  const remaining = new Map<string, number>()
  const store = { objects: [...objects], current: step, failed: null as null | { code: DeletionErrorCode; retryMs: number }, completed: false, claimed: false }
  const claimed: ClaimedDeletion = { userId: OWNER, step, token: "t1", fence: 1, attempts }
  const db: DeletionDatabase = {
    async claim() { if (store.claimed || store.completed) return null; store.claimed = true; return claimed },
    async renew() { return true },
    async purge(_owner, _token, purgeStep) {
      assert.equal(purgeStep, store.current, "solo purga el paso en curso")
      const left = remaining.get(purgeStep) ?? rows
      const removed = Math.min(left, 2)
      remaining.set(purgeStep, left - removed)
      log.push(`purge:${purgeStep}:${removed}`)
      return removed
    },
    async objects(_owner, limit) { return store.objects.slice(0, limit) },
    async advance(_owner, _token, advanced) {
      assert.equal(advanced, store.current)
      log.push(`advance:${advanced}`)
      store.current = DELETION_STEPS[DELETION_STEPS.indexOf(advanced) + 1]
      return store.current
    },
    async fail(_owner, _token, code, retryMs) { store.failed = { code, retryMs }; log.push(`fail:${code}`); return "waiting_retry" },
    async complete(_owner, _token, markDays) { assert.equal(markDays, MARK_RETENTION_DAYS); store.completed = true; log.push("complete") },
  }
  const deps: DeletionDeps = {
    db,
    storage: { async remove(bucket, names) { log.push(`remove:${bucket}:${names.length}`); store.objects = store.objects.filter((object) => !names.includes(object.name)) } },
    auth: { async revokeSessions() { log.push("revoke") }, async deleteIdentity() { log.push("identity") } },
  }
  return { deps, db, log, store, claimed }
}

describe("contratos de la eliminación de cuenta", () => {
  test("la fase visible no expone el estado interno ni el código técnico", () => {
    assert.equal(deletionPhase("pending", "sessions"), "requested")
    assert.equal(deletionPhase("pending", "storage"), "in_progress")
    assert.equal(deletionPhase("running"), "in_progress")
    assert.equal(deletionPhase("waiting_retry"), "retrying")
    assert.equal(deletionPhase("failed"), "needs_attention")
    assert.equal(deletionPhase("completed"), "completed")
    assert.equal(deletionPhase("none"), "none")
    const view = toDeletionView({ state: "waiting_retry", step: "storage", requestedAt: "2026-10-25T08:00:00Z", errorCode: "STORAGE_UNAVAILABLE", counts: { copies: 3 }, created: true })
    assert.deepEqual(view, { phase: "retrying", requestedAt: "2026-10-25T08:00:00.000Z" })
    assert.deepEqual(toDeletionView({ state: "none" }), { phase: "none", requestedAt: null })
    assert.deepEqual(toDeletionView(null), { phase: "none", requestedAt: null })
  })

  test("confirmación escrita, clave de operación e inicio de sesión reciente", () => {
    assert.equal(DELETION_CONFIRMATION, "ELIMINAR MI CUENTA")
    assert.ok(OPERATION_KEY_PATTERN.test(crypto.randomUUID()))
    assert.ok(!OPERATION_KEY_PATTERN.test("corta") && !OPERATION_KEY_PATTERN.test("x".repeat(129)) && !OPERATION_KEY_PATTERN.test(`${"a".repeat(20)} ;`))
    const now = Date.UTC(2026, 9, 25, 8, 0, 0)
    const at = (msAgo: number) => [{ method: "oauth", timestamp: Math.floor((now - msAgo) / 1000) }]
    assert.equal(lastSignInAt([{ method: "password", timestamp: 100 }, { method: "otp", timestamp: 200 }]), 200_000)
    assert.ok(isRecentSignIn(at(60_000), now))
    assert.ok(!isRecentSignIn(at(RECENT_SIGN_IN_MS + 1000), now), "más de 15 minutos exige volver a entrar")
    assert.ok(!isRecentSignIn(at(-10 * 60_000), now), "un instante futuro no cuenta")
    assert.ok(!isRecentSignIn(undefined, now) && !isRecentSignIn(["oauth"], now) && !isRecentSignIn([{ method: "oauth" }], now), "sin marca de tiempo no hay sesión reciente")
  })

  test("BD001 es ACCOUNT_INACTIVE (403, sin reintento) desde cualquier vía de escritura", async () => {
    assert.equal(httpStatusForDomainError("ACCOUNT_INACTIVE"), 403)
    assert.equal(isRetryable("ACCOUNT_INACTIVE"), false)
    assert.equal(httpStatusForDomainError("REAUTH_REQUIRED"), 401)
    assert.throws(() => translateDatabaseError(Object.assign(new Error("x"), { code: "BD001" })), (error: unknown) => error instanceof Error && "code" in error && error.code === "ACCOUNT_INACTIVE")
    const untranslated = await mutationResult(async () => { throw Object.assign(new Error("rls"), { code: "BD001" }) })
    assert.deepEqual(untranslated, { ok: false, error: { code: "ACCOUNT_INACTIVE", message: accountInactive().message, retryable: false } })
  })
})

describe("worker de eliminación", () => {
  test("recorre los pasos en orden: sesiones, Storage, filas por lotes, identidad y verificación", async () => {
    const { deps, log, store } = fakeDeletion()
    const report = await processDeletion(deps, (await deps.db.claim(null, 1000))!)
    assert.equal(report.outcome, "completed")
    assert.equal(report.step, "done")
    assert.ok(store.completed)
    assert.deepEqual(log.slice(0, 4), ["revoke", "advance:sessions", `remove:biblib-covers:1`, "advance:storage"])
    assert.ok(log.indexOf("identity") > log.indexOf("advance:state"), "la identidad se borra al final")
    assert.equal(log.at(-1), "complete")
    for (const step of ["covers", "copies", "shelves", "state"] as DatabaseStep[]) assert.ok(log.includes(`purge:${step}:2`) && log.includes(`purge:${step}:0`), `${step} se vacía por lotes`)
    assert.equal(report.counts.copies, 3)
    assert.equal(report.counts.objects, 1)
  })

  test("Storage caído: el error queda registrado y no se borra la identidad ni se da por terminada", async () => {
    const { deps, log, store, claimed } = fakeDeletion({ attempts: 3 })
    deps.storage.remove = async () => { throw new Error("503") }
    const report = await processDeletion(deps, claimed)
    assert.deepEqual({ outcome: report.outcome, step: report.step, errorCode: report.errorCode }, { outcome: "waiting_retry", step: "storage", errorCode: "STORAGE_UNAVAILABLE" })
    assert.equal(store.failed?.retryMs, 120_000, "espera creciente con los intentos")
    assert.ok(!log.includes("identity") && !store.completed && !log.some((entry) => entry.startsWith("purge:")))
  })

  test("Storage que acepta la petición pero conserva los objetos: pendiente, no terminado", async () => {
    const { deps, store, claimed } = fakeDeletion()
    deps.storage.remove = async () => {}
    const report = await processDeletion(deps, claimed)
    assert.equal(report.errorCode, "STORAGE_PENDING")
    assert.equal(store.objects.length, 1)
    assert.ok(!store.completed)
  })

  test("un worker interrumpido continúa desde su paso sin repetir los anteriores", async () => {
    const { deps, log, claimed } = fakeDeletion({ step: "copies" })
    const report = await processDeletion(deps, claimed)
    assert.equal(report.outcome, "completed")
    assert.ok(!log.includes("revoke") && !log.some((entry) => entry.startsWith("remove:") || entry.startsWith("purge:covers")))
    assert.equal(log[0], "purge:copies:2")
  })

  test("lease perdido: se detiene sin registrar fallo ni seguir borrando", async () => {
    const { deps, log, store, claimed } = fakeDeletion({ step: "views" })
    deps.db.purge = async () => { throw new LeaseLostError() }
    const report = await processDeletion(deps, claimed)
    assert.equal(report.outcome, "lease_lost")
    assert.equal(store.failed, null)
    assert.ok(!log.includes("identity"))
  })

  test("un fallo de GoTrue al borrar la identidad deja la eliminación pendiente en el paso auth", async () => {
    const { deps, claimed } = fakeDeletion({ step: "auth" })
    deps.auth.deleteIdentity = async () => { throw new Error("gotrue") }
    const report = await processDeletion(deps, claimed)
    assert.deepEqual({ step: report.step, errorCode: report.errorCode }, { step: "auth", errorCode: "AUTH_UNAVAILABLE" })
  })

  test("drain procesa hasta que no quedan solicitudes vencidas", async () => {
    const { deps } = fakeDeletion()
    const reports = await drainDeletions(deps, { budgetMs: 10_000 })
    assert.deepEqual(reports.map((report) => report.outcome), ["completed"])
    assert.deepEqual(await drainDeletions(deps, { budgetMs: 10_000 }), [])
  })
})

describe("inventario de limpieza", () => {
  // La definición vigente de account_deletion_step_tables es la de 0015 (lectura y préstamos al principio de product).
  const migration = readFileSync("drizzle/0015_reading_and_loans.sql", "utf8")
  const stepTables = migration.slice(migration.indexOf('FUNCTION "biblib"."account_deletion_step_tables"'), migration.indexOf("ELSE NULL", migration.indexOf('FUNCTION "biblib"."account_deletion_step_tables"')))
  const sqlSteps = Object.fromEntries([...stepTables.matchAll(/WHEN '(\w+)' THEN ARRAY\[([^\]]*)\]/g)].map(([, step, list]) => [step, [...list.matchAll(/'(\w+)'/g)].map((match) => match[1])]))

  test("cada tabla del inventario tiene el mismo paso que la función vigente (0015), en el mismo orden", () => {
    const tables = ACCOUNT_DATA_INVENTORY.filter((entry) => entry.kind === "table" && entry.name !== "account_lifecycle")
    const fromInventory: Record<string, string[]> = {}
    for (const entry of tables) (fromInventory[entry.step] ??= []).push(entry.name)
    assert.deepEqual(fromInventory, sqlSteps)
    for (const step of Object.keys(sqlSteps)) assert.ok((DELETION_STEPS as readonly string[]).includes(step), step)
  })

  test("docs/retencion.md documenta cada tabla, objeto y sistema del inventario", () => {
    const doc = readFileSync("docs/retencion.md", "utf8")
    for (const entry of ACCOUNT_DATA_INVENTORY) assert.ok(doc.includes(`\`${entry.name}\``), `${entry.name} falta en docs/retencion.md`)
    assert.ok(doc.includes("account_deletions") && doc.includes(`${MARK_RETENTION_DAYS} días`))
  })
})

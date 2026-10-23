import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"
import { sanitize } from "../lib/process.mjs"
import { compareLedger, inspectJournal, LEDGER, loadJournal, MIGRATIONS_DIR } from "./journal-guard.mjs"
import { inspectObjects, verifyManifest } from "./objects-manifest.mjs"
import { assertPlanMatchesTarget, createPlan, gitCommit, readPlan, validatePlan } from "./plan.mjs"
import { assertSupportedTarget, closeConnection, connect, connectionError, drizzleVersion, inspectDatabase, readLedger, resolveLocal } from "./target.mjs"

// Clave del bloqueo consultivo común a todos los runners de esquema de BibLib
// (migrate local, bootstrap y, en U-INF-06/07, reset y promoción).
export const MIGRATION_LOCK_KEY = "7316290410462004"
export const LOCK_WAIT_MS = 30000
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }

export const EXPLICIT_COMMANDS = [
  "pnpm db:status:local [--profile scratch] [--json]",
  "pnpm db:plan:local --out <plan.json> [--profile scratch]",
  "pnpm db:migrate:local --plan <plan.json> --expect-project <id> --expect-plan <sha256>",
]

/** `pnpm db:migrate` ya no elige destino por archivos heredados: no aplica nada y sale con 2. */
export function legacyDispatcher() {
  return {
    code: EXIT.INVALID_ARGS,
    message: [
      "db:migrate ya no aplica migraciones ni lee .env/.env.local: elige un comando explícito.",
      ...EXPLICIT_COMMANDS.map((c) => `  ${c}`),
      "Preprod/prod (db:plan:<target>, db:migrate:<target>) llegan con U-INF-07.",
    ].join("\n"),
  }
}

export async function acquireMigrationLock(sql, { waitMs = LOCK_WAIT_MS, pollMs = 250, signal } = {}) {
  const deadline = Date.now() + waitMs
  let waited = false
  for (;;) {
    const [{ locked }] = await sql`select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}::bigint) as locked`
    if (locked) return { waited }
    if (signal?.aborted) fail(EXIT.INTERRUPTED, "bloqueo", "Interrupción solicitada mientras se esperaba el bloqueo.")
    if (Date.now() >= deadline) fail(EXIT.LOCK_BUSY, "bloqueo", `Otro runner de esquema mantiene el bloqueo de migraciones tras ${Math.round(waitMs / 1000)} s; reintenta cuando termine. No se ha aplicado nada.`)
    waited = true
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

export async function releaseMigrationLock(sql) {
  try { await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)` } catch { /* Cerrar la conexión también libera el bloqueo de sesión. */ }
}

function lockWait() {
  const value = Number(process.env.BIBLIB_MIGRATE_LOCK_WAIT_MS ?? LOCK_WAIT_MS)
  return Number.isFinite(value) && value >= 0 && value <= 600000 ? value : LOCK_WAIT_MS
}

function failedChange(error, journal, pending) {
  const query = error?.query
  if (typeof query !== "string") return null
  return journal.entries.find((e) => pending.includes(e.tag) && e.statements.includes(query))?.tag ?? null
}

/**
 * Aplica con el migrador de Drizzle bajo bloqueo consultivo y verifica el resultado.
 * `migrationsDir` solo cambia en pruebas de stack (por ejemplo, una migración que falla).
 */
export async function applyPlan(sql, { plan, journal, migrationsDir = MIGRATIONS_DIR, waitMs = lockWait(), signal }) {
  const report = { previousHead: plan.appliedHead, attempted: plan.pending, failedChange: null, result: "pending", head: plan.appliedHead }
  const lock = await acquireMigrationLock(sql, { waitMs, signal })
  report.waitedForLock = lock.waited
  try {
    const before = await inspectDatabase(sql, journal)
    assertPlanMatchesTarget(plan, before)
    if (!plan.pending.length) return { ...report, result: "sin cambios: el destino ya estaba al día", checks: before.manifest }
    try {
      await drizzleMigrate(drizzle(sql), { migrationsFolder: migrationsDir, migrationsSchema: LEDGER.schema, migrationsTable: LEDGER.table })
    } catch (error) {
      const after = await readLedger(sql).catch(() => null)
      const unchanged = after && after.rows.length === before.ledger.rows.length
      const cause = error?.cause ?? error
      const sqlstate = typeof cause?.code === "string" && /^[0-9A-Z]{5}$/.test(cause.code) ? cause.code : null
      const failure = { ...report, failedChange: failedChange(error, journal, plan.pending), sqlstate, result: unchanged ? "revertido: el ledger no avanzó" : "estado incierto: revisa el ledger" }
      throw Object.assign(new BiblibError(EXIT.MIGRATION_FAILED, "migración", `La migración ${failure.failedChange ?? "pendiente"} falló${sqlstate ? ` (SQLSTATE ${sqlstate})` : ""}; ${failure.result}. Head anterior: ${plan.appliedHead?.tag ?? "ninguno"}.`), { report: failure })
    }
    const ledger = await readLedger(sql)
    const comparison = compareLedger(journal.entries, ledger.rows)
    const applied = comparison.migrations.filter((m) => m.status === "applied").map((m) => m.tag)
    const checks = verifyManifest(await inspectObjects(sql), applied)
    const done = { ...report, head: comparison.appliedHead, checks }
    if (comparison.problems.length || comparison.pending.length || comparison.appliedHead?.tag !== plan.expectedHead.tag || checks.some((c) => c.status === "fail")) {
      throw Object.assign(new BiblibError(EXIT.VERIFICATION_FAILED, "verificación", "Las migraciones se aplicaron, pero el ledger o el manifest de objetos no coinciden con lo esperado; no reapliques: diagnostica con db:status:local."), { report: { ...done, result: "aplicado con verificación fallida" } })
    }
    return { ...done, result: `aplicado: ${plan.pending.join(" → ")}` }
  } finally { await releaseMigrationLock(sql) }
}

export function parseArgs(argv) {
  const [command, target, ...args] = argv
  if (command === "legacy") return { command }
  if (!["status", "apply"].includes(command)) fail(EXIT.INVALID_ARGS, "argumentos", "Uso: migrate.mjs status|apply local [...].")
  assertSupportedTarget(target)
  const options = { command, target, json: false }
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (seen.has(flag)) fail(EXIT.INVALID_ARGS, "argumentos", `Argumento repetido: ${flag}.`)
    seen.add(flag)
    const value = args[i + 1]
    if (flag === "--json") options.json = true
    else if (flag === "--profile" && ["main", "test", "scratch"].includes(value)) { options.profile = value; i++ }
    else if (command === "apply" && ["--plan", "--expect-project", "--expect-plan"].includes(flag) && value && !value.startsWith("--")) { options[flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value; i++ }
    else fail(EXIT.INVALID_ARGS, "argumentos", command === "apply" ? "Uso: db:migrate:local --plan <ruta> --expect-project <id> --expect-plan <sha256> [--json]. No se admiten URLs ni flags reenviados." : "Uso: db:status:local [--profile main|test|scratch] [--json].")
  }
  if (command === "apply" && (!options.plan || !options.expectProject || !options.expectPlan)) fail(EXIT.INVALID_ARGS, "argumentos", "db:migrate:local exige --plan, --expect-project y --expect-plan.")
  return options
}

/** Introspección de solo lectura del ledger y del manifest (transacción read only). */
export async function status({ profile = "main", root = REPO_ROOT, migrationsDir = MIGRATIONS_DIR } = {}) {
  const journal = inspectJournal(migrationsDir)
  const resolved = await resolveLocal(profile, { root })
  const sql = connect(resolved, { applicationName: "biblib-status" })
  try {
    const inspection = journal.problems.length ? null : await sql.begin("read only", (tx) => inspectDatabase(tx, journal))
    const code = journal.problems.length ? EXIT.HISTORY_DIVERGED : inspection.code
    return {
      code,
      result: {
        schemaVersion: 1, target: resolved.target.redacted(), state: inspection?.state ?? "journal-invalid",
        appliedHead: inspection?.appliedHead ?? null, expectedHead: journal.entries.at(-1)?.tag ?? null,
        migrations: inspection?.migrations ?? [], pending: inspection?.pending ?? [],
        checks: [...journal.problems, ...(inspection ? [...inspection.checks, ...inspection.prerequisites, ...inspection.manifest] : [])].map(({ id, status, message }) => ({ id, status, message })),
      },
    }
  } catch (error) { throw connectionError(error) } finally { await closeConnection(sql) }
}

/** Revalida el plan contra checkout y destino, y aplica. Devuelve `{ code, result }`. */
export async function migrateWithPlan({ plan: planFile, expectProject, expectPlan, profile, root = REPO_ROOT, migrationsDir = MIGRATIONS_DIR, signal }) {
  const { file, plan } = readPlan(planFile, root)
  if (profile && plan?.target?.profile !== profile) fail(EXIT.IDENTITY_MISMATCH, "identidad", "--profile no coincide con el perfil del plan.")
  if (typeof plan?.target?.profile !== "string") fail(EXIT.PLAN_REJECTED, "plan", "El plan no indica un perfil válido.")
  const journal = loadJournal(migrationsDir)
  const resolved = await resolveLocal(plan.target.profile, { root })
  validatePlan(plan, { expectProject, expectPlan, current: { target: resolved.target.target, project: resolved.project, profile: resolved.profile, fingerprint: resolved.fingerprint, commit: gitCommit(root), drizzle: drizzleVersion(root), journal } })
  const sql = connect(resolved, { applicationName: "biblib-migrate" })
  const abort = () => { sql.end({ timeout: 0 }).catch(() => {}) }
  signal?.addEventListener("abort", abort, { once: true })
  const receipt = (report) => {
    const content = { schemaVersion: 1, kind: "migrate-receipt", planHash: plan.planHash, target: resolved.target.redacted(), finishedAt: new Date().toISOString(), ...report }
    writeFileSync(file.replace(/\.json$/, ".receipt.json"), `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 })
    return content
  }
  try {
    const report = await applyPlan(sql, { plan, journal, migrationsDir, signal })
    return { code: EXIT.OK, result: receipt({ code: EXIT.OK, ...report }) }
  } catch (error) {
    if (signal?.aborted) fail(EXIT.INTERRUPTED, "migración", "Interrupción solicitada: la transacción se revierte al cerrar la conexión; comprueba el estado con db:status:local.")
    if (error instanceof BiblibError) {
      if (error.report) error.report = receipt({ code: error.code, ...error.report, message: error.message })
      throw error
    }
    throw connectionError(error, "migración")
  } finally {
    signal?.removeEventListener("abort", abort)
    await closeConnection(sql)
  }
}

/** Head aplicado para `db:local:status` (solo lectura; null si no hay ledger). */
export async function readAppliedHead(stackContext) {
  const journal = loadJournal()
  const resolved = await resolveLocal(stackContext.profile.name, { root: stackContext.root, stack: stackContext })
  const sql = connect(resolved, { applicationName: "biblib-status" })
  try {
    const ledger = await sql.begin("read only", (tx) => readLedger(tx))
    if (!ledger.rows.length) return null
    const comparison = compareLedger(journal.entries, ledger.rows)
    return { tag: comparison.appliedHead?.tag ?? null, applied: comparison.migrations.filter((m) => m.status === "applied").length, expected: journal.entries.length, state: comparison.problems.length ? "diverged" : comparison.pending.length ? "pending" : "up-to-date" }
  } finally { await closeConnection(sql) }
}

/** Fase migrate del bootstrap: plan + migrate locales con el mismo contrato que los comandos. */
export async function runLocalMigration(stackContext, { runId = randomUUID(), signal } = {}) {
  const profile = stackContext.profile.name
  const out = `bootstrap-${profile}-${runId}.json`
  const planned = await createPlan({ profile, out, root: stackContext.root })
  if (planned.code !== EXIT.OK) fail(planned.code, "migrate", planned.result.checks?.find((c) => c.status === "fail")?.message ?? "El plan de migración no permite continuar.")
  const applied = await migrateWithPlan({ plan: out, expectProject: planned.plan.target.project, expectPlan: planned.plan.planHash, root: stackContext.root, signal })
  const total = planned.plan.migrations.length
  const tag = applied.result.head?.tag ?? null
  // Misma forma que readAppliedHead para que status y bootstrap publiquen un head comparable.
  const head = tag ? { tag, applied: planned.plan.migrations.findIndex((m) => m.tag === tag) + 1, expected: total, state: "up-to-date" } : null
  return { head, result: applied.result.result, plan: planned.result.file }
}

function print(json, command, code, result) {
  if (json) { console.log(JSON.stringify({ code, ...result })); return }
  if (command === "status") {
    console.log(`Estado de migraciones · ${result.target.project} · ${result.state}`)
    console.log(`Head aplicado: ${result.appliedHead?.tag ?? "ninguno"} · esperado: ${result.expectedHead} · pendientes: ${result.pending.join(", ") || "ninguna"}`)
    for (const check of result.checks.filter((c) => c.status !== "ok")) console.log(`[${check.status}] ${check.id}: ${check.message}`)
    console.log(`${result.checks.filter((c) => c.status === "ok").length} comprobaciones correctas.`)
  } else {
    console.log(`Migración · ${result.target.project} · ${result.result}`)
    console.log(`Head anterior: ${result.previousHead?.tag ?? "ninguno"} · head actual: ${result.head?.tag ?? "ninguno"}`)
    for (const check of (result.checks ?? []).filter((c) => c.status !== "ok")) console.log(`[${check.status}] ${check.id}: ${check.message}`)
  }
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json")
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.on("SIGINT", abort)
  try {
    const options = parseArgs(argv)
    if (options.command === "legacy") {
      const { code, message } = legacyDispatcher()
      console.error(message)
      return code
    }
    const { code, result } = options.command === "status" ? await status(options) : await migrateWithPlan({ ...options, signal: controller.signal })
    print(json, options.command, code, result)
    return code
  } catch (error) {
    const code = controller.signal.aborted ? EXIT.INTERRUPTED : error instanceof BiblibError ? error.code : EXIT.SERVICE_UNAVAILABLE
    const report = error?.report ? { previousHead: error.report.previousHead?.tag ?? null, failedChange: error.report.failedChange, result: error.report.result, head: error.report.head?.tag ?? null } : undefined
    const result = { schemaVersion: 1, code, phase: error instanceof BiblibError ? error.phase : "migración", correlation: randomUUID(), message: error instanceof BiblibError ? sanitize(error.message) : "No se pudo completar la operación de migración.", ...(report ? { report } : {}) }
    if (json) console.log(JSON.stringify(result))
    else {
      console.error(`Error [${result.phase}] (${code}): ${result.message}`)
      if (report) console.error(`Head anterior: ${report.previousHead ?? "ninguno"} · cambio fallido: ${report.failedChange ?? "n/d"} · resultado: ${report.result}`)
    }
    return code
  } finally { process.removeListener("SIGINT", abort) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

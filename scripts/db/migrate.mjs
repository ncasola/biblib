import { randomBytes, randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { localPath } from "../lib/local-path.mjs"
import { objectFacts } from "../lib/backup-db.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"
import { sanitize } from "../lib/process.mjs"
import { compareLedger, inspectJournal, LEDGER, loadJournal, MIGRATIONS_DIR } from "./journal-guard.mjs"
import { inspectObjects, verifyManifest } from "./objects-manifest.mjs"
import { assertPlanMatchesTarget, createPlan, gitCommit, readPlan, validatePlan } from "./plan.mjs"
import { assertSupportedTarget, closeConnection, connect, connectionError, drizzleVersion, inspectDatabase, readLedger, resolveLocal } from "./target.mjs"
import { assertReceiptMatchesDatabase, connectRemote, dataPreflight, describeRemote, isRemoteTarget, platformFingerprint, probeRemote, remoteConnectionError, validateBackupReceipt } from "./remote-preflight.mjs"
import { analyzeAdoption, applyAdoption } from "./adopt.mjs"

// Clave del bloqueo consultivo común a todos los runners de esquema de BibLib
// (migrate local, bootstrap y, en U-INF-06/07, reset y promoción).
export const MIGRATION_LOCK_KEY = "7316290410462004"
export const LOCK_WAIT_MS = 30000
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }

export const EXPLICIT_COMMANDS = [
  "pnpm db:status:local [--profile scratch] [--json]",
  "pnpm db:plan:local --out <plan.json> [--profile scratch]",
  "pnpm db:migrate:local --plan <plan.json> --expect-project <id> --expect-plan <sha256>",
  "pnpm db:status:<preprod|prod> --expect-project <ref> [--json]",
  "pnpm db:plan:<preprod|prod> --out <plan.json> --expect-project <ref>",
  "pnpm db:migrate:<preprod|prod> --plan <plan.json> --expect-project <ref> --expect-plan <sha256> --backup-receipt <recibo.json>",
  "pnpm db:adopt:<preprod|prod> --plan <plan.json> --expect-project <ref> --expect-plan <sha256> --backup-receipt <recibo.json>",
]

/** `pnpm db:migrate` ya no elige destino por archivos heredados: no aplica nada y sale con 2. */
export function legacyDispatcher() {
  return {
    code: EXIT.INVALID_ARGS,
    message: [
      "db:migrate ya no aplica migraciones ni lee .env/.env.local: elige un comando explícito.",
      ...EXPLICIT_COMMANDS.map((c) => `  ${c}`),
      "Preprod/prod exigen variables inyectadas por CI o el gestor de credenciales y TLS verify-full; ver docs/promocion.md.",
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
export async function applyPlan(sql, { plan, journal, migrationsDir = MIGRATIONS_DIR, waitMs = lockWait(), signal, beforeApply }) {
  const report = { previousHead: plan.appliedHead, attempted: plan.pending, failedChange: null, result: "pending", head: plan.appliedHead }
  const lock = await acquireMigrationLock(sql, { waitMs, signal })
  report.waitedForLock = lock.waited
  try {
    const before = await inspectDatabase(sql, journal)
    assertPlanMatchesTarget(plan, before)
    if (!plan.pending.length) return { ...report, result: "sin cambios: el destino ya estaba al día", checks: before.manifest }
    // Comprobaciones de promoción (recibo frente al destino, huella de plataforma), ya bajo bloqueo.
    await beforeApply?.(sql, before)
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

const camel = (flag) => flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())

/** `status|apply|adopt <target> ...`. El sufijo del comando fija el destino; nunca una URL ni un flag reenviado. */
export function parseArgs(argv) {
  const [command, target, ...args] = argv
  if (command === "legacy") return { command }
  if (!["status", "apply", "adopt"].includes(command)) fail(EXIT.INVALID_ARGS, "argumentos", "Uso: migrate.mjs status|apply local|preprod|prod [...].")
  if (args.includes("--force") || target === "--force") fail(EXIT.INVALID_ARGS, "argumentos", command === "adopt" ? "db:adopt no acepta --force: la adopción solo procede con equivalencia demostrada por metadatos." : "No existe --force: las guardas de identidad, plan y respaldo no se pueden omitir.")
  assertSupportedTarget(target)
  const remote = isRemoteTarget(target)
  if (command === "adopt" && !remote) fail(EXIT.INVALID_ARGS, "objetivo", "db:adopt solo existe para preprod/prod; un stack local se reconstruye con db:reset:local.")
  const name = command === "apply" ? "migrate" : command
  const usage = command === "status"
    ? remote ? `Uso: db:status:${target} --expect-project <ref> [--json].` : "Uso: db:status:local [--profile main|test|scratch] [--json]."
    : `Uso: db:${name}:${target} --plan <ruta> --expect-project <id> --expect-plan <sha256>${remote ? " --backup-receipt <recibo.json>" : ""} [--json]. No se admiten URLs ni flags reenviados.`
  const allowed = command === "status" ? (remote ? ["--expect-project"] : []) : ["--plan", "--expect-project", "--expect-plan", ...(remote ? ["--backup-receipt"] : [])]
  const options = { command, target, json: false }
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (seen.has(flag)) fail(EXIT.INVALID_ARGS, "argumentos", `Argumento repetido: ${flag}.`)
    seen.add(flag)
    const value = args[i + 1]
    if (flag === "--json") options.json = true
    else if (!remote && flag === "--profile" && ["main", "test", "scratch"].includes(value)) { options.profile = value; i++ }
    else if (allowed.includes(flag) && value && !value.startsWith("--")) { options[camel(flag)] = value; i++ }
    else fail(EXIT.INVALID_ARGS, "argumentos", usage)
  }
  if (command !== "status" && (!options.plan || !options.expectProject || !options.expectPlan)) fail(EXIT.INVALID_ARGS, "argumentos", `db:${name}:${target} exige --plan, --expect-project y --expect-plan${remote ? " (y --backup-receipt)" : ""}.`)
  if (command === "status" && remote && !options.expectProject) fail(EXIT.INVALID_ARGS, "argumentos", `db:status:${target} exige --expect-project <ref>.`)
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

/**
 * Introspección remota de solo lectura: identidad y TLS antes de conectar; rol, permisos,
 * versión, ledger, manifest, adopción derivada y revisión de datos en una transacción read only.
 */
export async function statusRemote({ target, expectProject, root = REPO_ROOT, migrationsDir = MIGRATIONS_DIR, env = process.env }, deps = {}) {
  const journal = inspectJournal(migrationsDir)
  const remote = describeRemote(target, { env, expectProject, cwd: root })
  const sql = connectRemote(remote, { applicationName: "biblib-status", resolveHost: deps.resolveHost })
  try {
    const observed = journal.problems.length ? null : await sql.begin("read only", async (tx) => {
      const probe = await probeRemote(tx)
      const inspection = await inspectDatabase(tx, journal)
      const adoption = inspection.state === "adoption-required" ? analyzeAdoption(inspection.facts, journal, { migrationsDir }) : null
      return { probe, inspection, adoption, data: await dataPreflight(tx, adoption?.proven ? adoption.pendingAfter : inspection.pending) }
    })
    const inspection = observed?.inspection
    const code = journal.problems.length ? EXIT.HISTORY_DIVERGED : observed.probe.code || inspection.code || observed.data.code
    return {
      code,
      result: {
        schemaVersion: 1, target: remote.redacted(), state: inspection?.state ?? "journal-invalid",
        appliedHead: inspection?.appliedHead ?? null, expectedHead: journal.entries.at(-1)?.tag ?? null,
        migrations: inspection?.migrations ?? [], pending: inspection?.pending ?? [],
        adoption: observed?.adoption ? (observed.adoption.proven ? { proven: true, head: observed.adoption.head.tag, pendingAfter: observed.adoption.pendingAfter } : { proven: false, reconciliation: observed.adoption.reconciliation }) : null,
        remote: observed?.probe.facts ?? null, dataPreflight: observed ? { required: observed.data.required, checks: observed.data.checks } : null,
        checks: [...journal.problems, ...(observed ? [...observed.probe.checks, ...inspection.checks, ...inspection.prerequisites, ...inspection.manifest] : [])].map(({ id, status, message }) => ({ id, status, message })),
      },
    }
  } catch (error) { throw remoteConnectionError(error, "status") } finally { await closeConnection(sql) }
}

export const PROMOTIONS_DIR = [".biblib", "promotions"]

/** Registro de promoción: objetivo, commit, plan, heads, respaldo y resultado; sin URLs, tokens ni datos. */
export function writePromotionRecord(root, record) {
  const stamp = record.finishedAt.replace(/[-:]/g, "").replace(/\.\d{3}/, "")
  const file = localPath(root, path.join(root, ...PROMOTIONS_DIR, `${stamp}-${record.target.target}-${record.planHash.slice(0, 12)}-${randomBytes(3).toString("hex")}.json`))
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  return path.relative(root, file).split(path.sep).join("/")
}

const LOST_WRITES = "Las escrituras en el destino posteriores a backup.createdAt no están en el respaldo: si hubiera que restaurar, se pierden o se recuperan por otra vía antes de abrir tráfico. Mantén la aplicación sin escrituras desde el respaldo hasta verificar la promoción."

/**
 * Promoción a preprod/prod (`kind` migrate o adopt-ledger). Antes de cualquier DDL: plan del tipo
 * correcto, identidad y TLS, commit/journal, recibo de respaldo del mismo destino y head con
 * ensayo superado, rol y permisos; ya bajo el bloqueo común, el ledger y los objetos deben ser los
 * del plan y los del respaldo. Al terminar verifica el manifest y la plataforma y deja un registro.
 */
export async function runPromotion(options, { kind = "migrate", apply = applyPlan } = {}, deps = {}) {
  const { plan: planFile, expectProject, expectPlan, backupReceipt, target, root = REPO_ROOT, migrationsDir = MIGRATIONS_DIR, env = process.env, signal } = options
  const startedAt = new Date()
  const { file, plan } = readPlan(planFile, root)
  if (plan?.target?.target !== target) fail(EXIT.IDENTITY_MISMATCH, "identidad", "El plan es para otro objetivo; el sufijo del comando fija el destino.")
  const journal = loadJournal(migrationsDir)
  const remote = describeRemote(target, { env, expectProject, cwd: root })
  validatePlan(plan, { expectProject, expectPlan, kind, current: { target, project: remote.project, profile: null, fingerprint: remote.fingerprint, commit: gitCommit(root), drizzle: drizzleVersion(root), journal } })
  const backup = validateBackupReceipt(backupReceipt, { root, target, project: remote.project, fingerprint: remote.fingerprint, appliedHead: plan.appliedHead, now: deps.now?.() })
  const record = {
    schemaVersion: 1, kind: "biblib-promotion-record", operation: kind, recordId: randomUUID(),
    target: remote.redacted(), commit: plan.commit.sha, planHash: plan.planHash, plan: path.relative(root, file).split(path.sep).join("/"),
    headBefore: plan.appliedHead?.tag ?? null, headAfter: null, attempted: kind === "adopt-ledger" ? plan.adoption.rows.map((r) => r.tag) : plan.pending,
    backup: { backupId: backup.backupId, receiptHash: backup.receiptHash, createdAt: backup.createdAt, rehearsal: backup.rehearsal },
    lostWrites: { since: backup.createdAt, note: LOST_WRITES }, platform: null, result: "pendiente", code: null, startedAt: startedAt.toISOString(),
  }
  const finish = (code, result, extra = {}) => {
    Object.assign(record, { code, result, finishedAt: new Date().toISOString(), ...extra })
    record.file = writePromotionRecord(root, { ...record })
    return record
  }
  const sql = connectRemote(remote, { applicationName: `biblib-${kind}`, resolveHost: deps.resolveHost })
  const abort = () => { sql.end({ timeout: 0 }).catch(() => {}) }
  signal?.addEventListener("abort", abort, { once: true })
  let platformBefore = null
  try {
    const probe = await sql.begin("read only", (tx) => probeRemote(tx))
    const failed = probe.checks.find((c) => c.status === "fail")
    if (failed) fail(failed.code, "preflight", failed.message)
    const beforeApply = async (locked, before) => {
      assertReceiptMatchesDatabase(backup, { ledgerRows: before.ledger.rows, objectsHash: (await objectFacts(locked)).hash })
      platformBefore = await platformFingerprint(locked)
    }
    const report = await apply(sql, { plan, journal, migrationsDir, signal, beforeApply })
    const platformAfter = platformBefore ? await platformFingerprint(sql) : null
    const platform = platformBefore ? { before: platformBefore, after: platformAfter, unchanged: platformBefore === platformAfter } : null
    const failing = (report.checks ?? []).filter((c) => c.status === "fail")
    if (platform && !platform.unchanged) {
      const done = finish(EXIT.VERIFICATION_FAILED, "aplicado con verificación fallida: cambió el esquema de plataforma auth/storage", { headAfter: report.head?.tag ?? null, platform })
      throw Object.assign(new BiblibError(EXIT.VERIFICATION_FAILED, "verificación", "La promoción alteró objetos de auth/storage; no reapliques y revisa el registro."), { record: done.file })
    }
    const done = finish(EXIT.OK, report.result, { headAfter: report.head?.tag ?? null, platform, checks: { ok: (report.checks ?? []).length - failing.length, fail: failing.length }, pendingAfter: report.pendingAfter ?? [] })
    return { code: EXIT.OK, result: { schemaVersion: 1, code: EXIT.OK, kind, target: remote.redacted(), planHash: plan.planHash, previousHead: report.previousHead, head: report.head, result: report.result, checks: report.checks ?? [], pendingAfter: report.pendingAfter ?? [], backupId: backup.backupId, record: done.file } }
  } catch (error) {
    const interrupted = signal?.aborted
    const failure = interrupted ? new BiblibError(EXIT.INTERRUPTED, kind, "Interrupción solicitada: la transacción se revierte al cerrar la conexión; comprueba el estado con db:status.") : error instanceof BiblibError ? error : remoteConnectionError(error, kind)
    if (!failure.record) {
      const done = finish(failure.code, failure.report?.result ?? `rechazado antes de aplicar: ${failure.phase}`, { headAfter: failure.report?.head?.tag ?? record.headBefore, phase: failure.phase })
      failure.record = done.file
    }
    throw failure
  } finally {
    signal?.removeEventListener("abort", abort)
    await closeConnection(sql)
  }
}

export function printPromotion(json, command, code, result) {
  if (json) { console.log(JSON.stringify({ code, ...result })); return }
  console.log(`${command === "adopt" ? "Adopción del ledger" : "Promoción"} · ${result.target.target} (${result.target.project}) · ${result.result}`)
  console.log(`Head anterior: ${result.previousHead?.tag ?? "ninguno"} · head actual: ${result.head?.tag ?? "ninguno"}${result.pendingAfter?.length ? ` · pendientes: ${result.pendingAfter.join(", ")}` : ""}`)
  for (const check of result.checks.filter((c) => c.status !== "ok")) console.log(`[${check.status}] ${check.id}: ${check.message}`)
  console.log(`Respaldo ${result.backupId} · registro ${result.record}`)
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

function printRemoteStatus(json, code, result) {
  if (json) { console.log(JSON.stringify({ code, ...result })); return }
  console.log(`Estado de migraciones · ${result.target.target} (${result.target.project}) · ${result.state}`)
  console.log(`Head aplicado: ${result.appliedHead?.tag ?? "ninguno"} · esperado: ${result.expectedHead} · pendientes: ${result.pending.join(", ") || "ninguna"}`)
  if (result.adoption) console.log(result.adoption.proven ? `Adopción del ledger demostrable hasta ${result.adoption.head}; después quedarían: ${result.adoption.pendingAfter.join(", ") || "ninguna"}.` : "Adopción NO demostrable: ver conciliación con db:plan.")
  for (const check of result.checks.filter((c) => c.status !== "ok")) console.log(`[${check.status}] ${check.id}: ${check.message}`)
  for (const check of result.dataPreflight?.checks?.filter((c) => c.status !== "ok") ?? []) console.log(`[${check.status}] ${check.id}: ${check.message}`)
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
    if (isRemoteTarget(options.target)) {
      if (options.command === "status") { const { code, result } = await statusRemote(options); printRemoteStatus(json, code, result); return code }
      const { code, result } = await runPromotion({ ...options, signal: controller.signal }, options.command === "adopt" ? { kind: "adopt-ledger", apply: applyAdoption } : { kind: "migrate" })
      printPromotion(json, options.command, code, result)
      return code
    }
    const { code, result } = options.command === "status" ? await status(options) : await migrateWithPlan({ ...options, signal: controller.signal })
    print(json, options.command, code, result)
    return code
  } catch (error) {
    const code = controller.signal.aborted ? EXIT.INTERRUPTED : error instanceof BiblibError ? error.code : EXIT.SERVICE_UNAVAILABLE
    const report = error?.report ? { previousHead: error.report.previousHead?.tag ?? null, failedChange: error.report.failedChange, result: error.report.result, head: error.report.head?.tag ?? null } : undefined
    const result = { schemaVersion: 1, code, phase: error instanceof BiblibError ? error.phase : "migración", correlation: randomUUID(), message: error instanceof BiblibError ? sanitize(error.message) : "No se pudo completar la operación de migración.", ...(report ? { report } : {}), ...(error?.record ? { record: error.record } : {}) }
    if (json) console.log(JSON.stringify(result))
    else {
      console.error(`Error [${result.phase}] (${code}): ${result.message}`)
      if (report) console.error(`Head anterior: ${report.previousHead ?? "ninguno"} · cambio fallido: ${report.failedChange ?? "n/d"} · resultado: ${report.result}`)
    }
    return code
  } finally { process.removeListener("SIGINT", abort) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

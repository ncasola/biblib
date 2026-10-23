import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"
import { sanitize } from "../lib/process.mjs"
import { inspectJournal, LEDGER, MIGRATIONS_DIR, sha256, summarizeDdl } from "./journal-guard.mjs"
import { expectedObjects } from "./objects-manifest.mjs"
import { assertSupportedTarget, closeConnection, connect, connectionError, drizzleVersion, inspectDatabase, resolveLocal } from "./target.mjs"
import { connectRemote, dataPreflight, describeRemote, isRemoteTarget, probeRemote, remoteConnectionError } from "./remote-preflight.mjs"
import { analyzeAdoption } from "./adopt.mjs"

export const PLAN_SCHEMA_VERSION = 1
export const PLAN_TTL_MS = 30 * 60 * 1000
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }

/** JSON canónico (claves ordenadas) para que el hash no dependa del orden de serialización. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`
  return JSON.stringify(value)
}

export function computePlanHash(plan) {
  const body = { ...plan }
  delete body.planHash
  return sha256(canonical(body))
}

export function plansDir(root = REPO_ROOT) {
  return path.join(root, ".biblib", "plans")
}

/** Los planes viven fuera de Git, dentro de `.biblib/plans/` de este checkout. */
export function resolvePlanPath(file, root = REPO_ROOT) {
  if (typeof file !== "string" || !file.trim()) fail(EXIT.INVALID_ARGS, "argumentos", "Indica la ruta del plan.")
  const resolved = path.resolve(root, path.isAbsolute(file) || /[\\/]/.test(file) ? file : path.join(".biblib", "plans", file))
  const dir = plansDir(root)
  if (path.dirname(resolved) !== dir || !resolved.endsWith(".json")) fail(EXIT.INVALID_ARGS, "argumentos", "El plan debe ser un .json dentro de .biblib/plans/ (ignorado por Git).")
  for (const candidate of [path.join(root, ".biblib"), dir, resolved]) {
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) fail(EXIT.IDENTITY_MISMATCH, "argumentos", "La ruta del plan no puede atravesar enlaces.")
  }
  return resolved
}

export function gitCommit(root = REPO_ROOT) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000 })
  if (head.error || head.status !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) fail(EXIT.MISSING_REQUIREMENT, "commit", "No se pudo leer el commit del checkout con git.")
  const dirty = spawnSync("git", ["status", "--porcelain", "--", "drizzle", ".gitattributes"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000 })
  return { sha: head.stdout.trim(), drizzleClean: dirty.status === 0 && dirty.stdout.trim() === "" }
}

/** Construye el documento de plan (puro): no consulta ni modifica la base. */
export function buildPlan({ resolved, journal, inspection, commit, drizzle, now = new Date(), kind = "migrate", extra = {}, extraRisks = [], extraPrerequisites = [] }) {
  const pendingEntries = journal.entries.filter((e) => inspection.pending.includes(e.tag))
  const ddlSummary = pendingEntries.map(summarizeDdl)
  const last = journal.entries.at(-1)
  const risks = [
    ...(pendingEntries.length ? ["Todas las migraciones pendientes se aplican en una única transacción: un error revierte el conjunto sin avanzar el ledger."] : []),
    ...new Set(ddlSummary.flatMap((d) => d.risks.map((r) => `${d.tag}: ${r}`))),
    ...(commit.drizzleClean ? [] : ["drizzle/ o .gitattributes tienen cambios sin commitear: revisa los SQL antes de aplicar."]),
    ...extraRisks,
  ]
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    kind,
    target: { target: resolved.target.target, profile: resolved.profile, project: resolved.project },
    fingerprint: resolved.fingerprint,
    commit,
    drizzle: { version: drizzle, journalHash: journal.journalHash, migrationsSchema: LEDGER.schema, migrationsTable: LEDGER.table },
    state: inspection.state,
    appliedHead: inspection.appliedHead,
    expectedHead: { tag: last.tag, when: last.when, hash: last.hash },
    migrations: inspection.migrations,
    pending: inspection.pending,
    ddlSummary,
    expectedObjects: expectedObjects(),
    risks,
    prerequisites: [
      ...inspection.prerequisites.map(({ id, status, message }) => ({ id, status, message })),
      { id: "lock", status: "ok", message: "El runner adquiere el bloqueo consultivo común antes de releer el ledger." },
      ...extraPrerequisites,
    ],
    ...extra,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
  }
  return { ...plan, planHash: computePlanHash(plan) }
}

/**
 * Revalida un plan antes de aplicar. `current` refleja el checkout y el destino actuales.
 * Identidad incorrecta → 3; plan caducado, de otro tipo, hash o bytes distintos → 6.
 */
export function validatePlan(plan, { expectProject, expectPlan, current, now = new Date(), kind = "migrate" }) {
  const reject = (message) => fail(EXIT.PLAN_REJECTED, "plan", message)
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) reject("El plan no es un documento JSON válido.")
  if (!/^[0-9a-f]{64}$/.test(expectPlan ?? "")) fail(EXIT.INVALID_ARGS, "argumentos", "--expect-plan debe ser el sha256 (64 hex) impreso por db:plan.")
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION || plan.kind !== kind) reject(`El plan no es de tipo ${kind} con la versión de esquema admitida; genera otro con db:plan (migrate y adopt-ledger no son intercambiables).`)
  if (computePlanHash(plan) !== plan.planHash) reject("El contenido del plan no coincide con su planHash: el archivo se modificó tras generarlo.")
  if (plan.planHash !== expectPlan) reject("El plan no coincide con --expect-plan; revisa y usa el hash del plan aprobado.")
  const expires = Date.parse(plan.expiresAt)
  if (!Number.isFinite(expires) || expires <= now.getTime()) reject("El plan ha caducado (30 minutos); genera y revisa uno nuevo, sin omitir la revisión.")
  if (plan.target?.target !== current.target) fail(EXIT.IDENTITY_MISMATCH, "identidad", "El plan es para otro objetivo; el sufijo del comando fija el destino.")
  if (plan.target?.project !== expectProject) fail(EXIT.IDENTITY_MISMATCH, "identidad", "--expect-project no coincide con el proyecto del plan.")
  if (plan.target.project !== current.project || plan.target.profile !== current.profile || plan.fingerprint !== current.fingerprint) fail(EXIT.IDENTITY_MISMATCH, "identidad", "El destino actual no es el del plan (proyecto, perfil o huella distintos).")
  if (plan.commit?.sha !== current.commit.sha) reject("El commit del checkout cambió desde el plan; genera uno nuevo.")
  if (plan.drizzle?.version !== current.drizzle || plan.drizzle?.journalHash !== current.journal.journalHash) reject("La versión de Drizzle o el journal cambiaron desde el plan.")
  const tags = current.journal.entries.map((e) => `${e.tag}:${e.when}:${e.hash}`)
  if (canonical(plan.migrations.map((m) => `${m.tag}:${m.when}:${m.hash}`)) !== canonical(tags)) reject("Los bytes, tags o timestamps de las migraciones cambiaron desde el plan.")
  return plan
}

/** Comprueba que el destino (releído bajo bloqueo) sigue en el estado que se planificó. */
export function assertPlanMatchesTarget(plan, inspection) {
  if (inspection.code !== EXIT.OK) fail(inspection.code, "historial", inspection.checks.find((c) => c.status === "fail")?.message ?? inspection.prerequisites.find((c) => c.status === "fail")?.message ?? "El destino no permite aplicar.")
  if (canonical(plan.appliedHead) !== canonical(inspection.appliedHead) || canonical(plan.pending) !== canonical(inspection.pending)) {
    fail(EXIT.PLAN_REJECTED, "plan", "El head aplicado o los pendientes cambiaron desde el plan (¿otro runner?); no se aplica nada. Genera un plan nuevo.")
  }
}

export function writePlan(plan, file, root = REPO_ROOT) {
  const target = resolvePlanPath(file, root)
  mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, target)
  return target
}

export function readPlan(file, root = REPO_ROOT) {
  const target = resolvePlanPath(file, root)
  if (!existsSync(target)) fail(EXIT.PLAN_REJECTED, "plan", "No existe el plan indicado; genera uno con db:plan.")
  try { return { file: target, plan: JSON.parse(readFileSync(target, "utf8")) } } catch { fail(EXIT.PLAN_REJECTED, "plan", "El plan no es JSON válido.") }
}

export function parsePlanArgs(argv) {
  const [target, ...args] = argv
  assertSupportedTarget(target)
  const remote = isRemoteTarget(target)
  const options = { target, profile: remote ? null : "main", json: false }
  const usage = remote ? `Uso: db:plan:${target} --out <archivo.json> --expect-project <ref> [--json]. No se admiten URLs, --profile ni flags reenviados.` : "Uso: db:plan:local --out <archivo.json> [--profile main|test|scratch] [--json]."
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (seen.has(flag)) fail(EXIT.INVALID_ARGS, "argumentos", `Argumento repetido: ${flag}.`)
    seen.add(flag)
    if (flag === "--json") options.json = true
    else if (!remote && flag === "--profile" && ["main", "test", "scratch"].includes(args[i + 1])) options.profile = args[++i]
    else if (flag === "--out" && args[i + 1] && !args[i + 1].startsWith("--")) options.out = args[++i]
    else if (remote && flag === "--expect-project" && args[i + 1] && !args[i + 1].startsWith("--")) options.expectProject = args[++i]
    else fail(EXIT.INVALID_ARGS, "argumentos", usage)
  }
  if (!options.out) fail(EXIT.INVALID_ARGS, "argumentos", "--out <ruta> es obligatorio (dentro de .biblib/plans/).")
  if (remote && !options.expectProject) fail(EXIT.INVALID_ARGS, "argumentos", `--expect-project <ref> es obligatorio en db:plan:${target}.`)
  return options
}

/** Genera un plan de solo lectura. Devuelve `{ code, result, file? }`. */
export async function createPlan({ profile, out, root = REPO_ROOT, migrationsDir = MIGRATIONS_DIR, now }) {
  const outFile = resolvePlanPath(out, root)
  const journal = inspectJournal(migrationsDir)
  if (journal.problems.length) return { code: EXIT.HISTORY_DIVERGED, result: { state: "journal-invalid", checks: journal.problems.map(({ id, status, message }) => ({ id, status, message })) } }
  const resolved = await resolveLocal(profile, { root })
  const commit = gitCommit(root)
  const sql = connect(resolved, { applicationName: "biblib-plan" })
  let inspection
  try { inspection = await sql.begin("read only", (tx) => inspectDatabase(tx, journal)) } catch (error) { throw connectionError(error) } finally { await closeConnection(sql) }
  const base = { target: resolved.target.redacted(), state: inspection.state, appliedHead: inspection.appliedHead, pending: inspection.pending, checks: [...inspection.checks, ...inspection.prerequisites, ...inspection.manifest.filter((c) => c.status !== "ok")].map(({ id, status, message }) => ({ id, status, message })) }
  if (inspection.code !== EXIT.OK) return { code: inspection.code, result: base }
  const plan = buildPlan({ resolved, journal, inspection, commit, drizzle: drizzleVersion(root), now })
  const file = writePlan(plan, outFile, root)
  return { code: EXIT.OK, file, plan, result: { ...base, file: path.relative(root, file), planHash: plan.planHash, expiresAt: plan.expiresAt, project: resolved.project } }
}

const ADOPTION_RISKS = [
  "Adopción excepcional: solo crea el ledger drizzle.__drizzle_migrations si falta y escribe sus filas; no ejecuta DDL de negocio ya presente.",
  "Tras adoptar, el head cambia: genera un plan migrate nuevo y un respaldo de ese head antes de aplicar los pendientes.",
]

function remoteResolved(remote) {
  return { target: { target: remote.target }, profile: null, project: remote.project, fingerprint: remote.fingerprint }
}

/**
 * Plan de solo lectura para preprod/prod: identidad y TLS antes de conectar; rol, permisos,
 * versión, ledger, manifest, adopción y revisión de datos dentro de una transacción read only.
 * No crea ledger ni objetos. `deps.resolveHost` solo existe para ensayos con un destino simulado.
 */
export async function createRemotePlan({ target, out, expectProject, root = REPO_ROOT, migrationsDir = MIGRATIONS_DIR, now, env = process.env }, deps = {}) {
  const outFile = resolvePlanPath(out, root)
  const journal = inspectJournal(migrationsDir)
  if (journal.problems.length) return { code: EXIT.HISTORY_DIVERGED, result: { state: "journal-invalid", checks: journal.problems.map(({ id, status, message }) => ({ id, status, message })) } }
  const remote = describeRemote(target, { env, expectProject, cwd: root })
  const commit = gitCommit(root)
  const sql = connectRemote(remote, { applicationName: "biblib-plan", resolveHost: deps.resolveHost })
  let observed
  try {
    observed = await sql.begin("read only", async (tx) => {
      const probe = await probeRemote(tx)
      const inspection = await inspectDatabase(tx, journal)
      const adoption = inspection.state === "adoption-required" ? analyzeAdoption(inspection.facts, journal, { migrationsDir }) : null
      const data = await dataPreflight(tx, adoption?.proven ? adoption.pendingAfter : inspection.pending)
      return { probe, inspection, adoption, data }
    })
  } catch (error) { throw remoteConnectionError(error, "plan") } finally { await closeConnection(sql) }
  const { probe, inspection, adoption, data } = observed
  const base = {
    target: remote.redacted(), project: remote.project, state: inspection.state, appliedHead: inspection.appliedHead, pending: inspection.pending,
    checks: [...probe.checks, ...inspection.checks, ...inspection.prerequisites, ...inspection.manifest.filter((c) => c.status !== "ok")].map(({ id, status, message }) => ({ id, status, message })),
    dataPreflight: { required: data.required, checks: data.checks },
  }
  if (probe.code !== EXIT.OK) return { code: probe.code, result: base }
  if (adoption && !adoption.proven) return { code: EXIT.HISTORY_DIVERGED, result: { ...base, adoption: { proven: false }, reconciliation: adoption.reconciliation } }
  if (!adoption && inspection.code !== EXIT.OK) return { code: inspection.code, result: base }
  if (inspection.prerequisites.some((p) => p.status === "fail")) return { code: EXIT.SERVICE_UNAVAILABLE, result: base }
  if (data.code !== EXIT.OK && !adoption) {
    const corrections = writePlan({ schemaVersion: 1, kind: "data-corrections", target: remote.redacted(), pending: inspection.pending, checks: data.checks, items: data.items, truncatedAt: data.truncatedAt, createdAt: (now ?? new Date()).toISOString() }, outFile.replace(/\.json$/, ".corrections.json"), root)
    return { code: data.code, result: { ...base, dataPreflight: data, corrections: path.relative(root, corrections) } }
  }
  const remoteFacts = { descriptor: remote.descriptor, remote: probe.facts, dataPreflight: { required: data.required, checks: data.checks.map(({ id, status, count }) => ({ id, status, count })) } }
  const receiptPrerequisite = { id: "backup-receipt", status: "pending", message: "Requiere --backup-receipt de un respaldo de este destino y head con ensayo de restauración superado (U-OPS-02)." }
  const probeChecks = probe.checks.map(({ id, status, message }) => ({ id, status, message }))
  const plan = adoption
    ? buildPlan({ resolved: remoteResolved(remote), journal, inspection: { ...inspection, pending: [] }, commit, drizzle: drizzleVersion(root), now, kind: "adopt-ledger",
      extraRisks: [...ADOPTION_RISKS, ...(data.code !== EXIT.OK ? ["La revisión de datos encontró filas que 0001/0002 rechazarían: corrígelas antes del plan migrate posterior a la adopción."] : [])],
      extraPrerequisites: [...probeChecks, receiptPrerequisite],
      extra: { ...remoteFacts, adoption: { head: adoption.head, rows: adoption.rows, factsHash: adoption.factsHash, evidenceHash: adoption.evidenceHash, evidence: adoption.evidence, checks: adoption.checks, pendingAfter: adoption.pendingAfter } } })
    : buildPlan({ resolved: remoteResolved(remote), journal, inspection, commit, drizzle: drizzleVersion(root), now, extraPrerequisites: [...probeChecks, receiptPrerequisite], extra: remoteFacts })
  const file = writePlan(plan, outFile, root)
  return { code: EXIT.OK, file, plan, result: { ...base, kind: plan.kind, file: path.relative(root, file), planHash: plan.planHash, expiresAt: plan.expiresAt, ...(adoption ? { adoption: { proven: true, head: adoption.head.tag, rows: adoption.rows.length, pendingAfter: adoption.pendingAfter } } : {}) } }
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json")
  try {
    const options = parsePlanArgs(argv)
    const { code, result } = isRemoteTarget(options.target) ? await createRemotePlan(options) : await createPlan(options)
    if (json) console.log(JSON.stringify({ schemaVersion: 1, code, ...result }))
    else {
      console.log(`Plan de migración · ${result.target?.project ?? options.profile} · estado ${result.state}`)
      if (result.appliedHead !== undefined) console.log(`Head aplicado: ${result.appliedHead?.tag ?? "ninguno"} · pendientes: ${result.pending?.join(", ") || "ninguna"}`)
      for (const check of result.checks ?? []) console.log(`[${check.status}] ${check.id}: ${check.message}`)
      for (const line of result.reconciliation?.proposal ?? []) console.log(`  ${line}`)
      for (const item of result.reconciliation?.differences ?? []) console.log(`  - ${item.id}: ${item.message}`)
      for (const item of result.dataPreflight?.checks?.filter((c) => c.status !== "ok") ?? []) console.log(`  [${item.status}] ${item.id}: ${item.message} ${item.correction ?? ""}`)
      if (result.corrections) console.log(`Listado restringido de correcciones propuestas: ${result.corrections}`)
      if (code === EXIT.OK) {
        console.log(`Plan ${result.kind ?? "migrate"} guardado en ${result.file} (caduca ${result.expiresAt}).`)
        if (!isRemoteTarget(options.target)) console.log(`Para aplicarlo: pnpm db:migrate:local --plan ${result.file} --expect-project ${result.project} --expect-plan ${result.planHash}`)
        else console.log(`Tras revisarlo, respaldar y ensayar la restauración: pnpm db:${result.kind === "adopt-ledger" ? "adopt" : "migrate"}:${options.target} --plan ${result.file} --expect-project ${result.project} --expect-plan ${result.planHash} --backup-receipt <recibo.json>`)
      }
    }
    return code
  } catch (error) {
    const code = error instanceof BiblibError ? error.code : EXIT.SERVICE_UNAVAILABLE
    const result = { schemaVersion: 1, code, phase: error instanceof BiblibError ? error.phase : "plan", correlation: randomUUID(), message: error instanceof BiblibError ? sanitize(error.message) : "No se pudo generar el plan." }
    if (json) console.log(JSON.stringify(result))
    else console.error(`Error [${result.phase}] (${code}): ${result.message}`)
    return code
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

import { readFileSync } from "node:fs"
import path from "node:path"
import postgres from "postgres"
import { assertOwnership, inventory, selectResources } from "../lib/docker.mjs"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { execute } from "../lib/process.mjs"
import { getProfile, REPO_ROOT, rootFingerprint } from "../lib/profiles.mjs"
import { readState } from "../lib/state.mjs"
import { childEnv, loadTarget } from "./environment.mjs"
import { compareLedger, LEDGER } from "./journal-guard.mjs"
import { checkPrerequisites, inspectObjects, verifyManifest } from "./objects-manifest.mjs"

// Helpers compartidos por status/plan/migrate (U-INF-04). Local prueba la propiedad del stack;
// preprod/prod (U-INF-07) usan el descriptor remoto de remote-preflight.mjs.
export const SUPPORTED_TARGETS = Object.freeze(["local", "preprod", "prod"])

export function assertSupportedTarget(target) {
  if (!SUPPORTED_TARGETS.includes(target)) throw new BiblibError(EXIT.INVALID_ARGS, "objetivo", "Indica el objetivo con el sufijo del comando: local, preprod o prod (test lo prepara su harness).")
}

export function drizzleVersion(root = REPO_ROOT) {
  return JSON.parse(readFileSync(path.join(root, "node_modules", "drizzle-orm", "package.json"), "utf8")).version
}

// Contexto mínimo compatible con los helpers de lifecycle. No se importa local-stack.mjs:
// este módulo se carga desde su status/bootstrap y un ciclo bloquearía su await de nivel superior.
function stackContext(profile, root, fingerprint) {
  const env = childEnv({ env: () => ({ BIBLIB_TARGET: "local", BIBLIB_PROFILE: profile, BIBLIB_CATALOGUE_MODE: "fixture" }) })
  return { root, profile: getProfile(profile, { root }), identity: rootFingerprint({ root }), fingerprint, run: execute, processOptions: { cwd: root, env } }
}

/**
 * Prueba la propiedad del stack local antes de conectar: endpoints exactos del perfil
 * (`loadTarget`), registro de recursos de este checkout con la misma huella y contenedor
 * Postgres registrado y en marcha.
 */
export async function resolveLocal(profile, { root = REPO_ROOT, stack: provided } = {}) {
  const target = loadTarget("local", { profile, cwd: root })
  const stack = provided ?? stackContext(profile, path.resolve(root), target.fingerprint)
  if (stack.fingerprint !== target.fingerprint) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "identidad", "La huella del objetivo no coincide con la del stack registrado.")
  const state = readState(stack)
  if (!state) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "identidad", `El perfil ${profile} no tiene registro de recursos de este checkout; arráncalo con pnpm db:local:up --profile ${profile}.`)
  let resources
  try { resources = selectResources(stack, await inventory(stack), state) } catch (error) {
    if (error instanceof BiblibError && error.code === EXIT.IDENTITY_MISMATCH) throw error
    throw new BiblibError(EXIT.SERVICE_UNAVAILABLE, "identidad", "Docker no respondió al comprobar la propiedad del stack local.")
  }
  assertOwnership(stack, resources, state)
  const db = resources.containers.find((c) => c.name === `supabase_db_${stack.profile.projectId}`)
  if (!db || db.status !== "running") throw new BiblibError(EXIT.SERVICE_UNAVAILABLE, "identidad", `Postgres del perfil ${profile} no está en marcha; usa pnpm db:local:up --profile ${profile}.`)
  return { stack, target, profile, project: stack.profile.projectId, fingerprint: target.fingerprint }
}

/** Conexión administrativa dedicada: una sola conexión, timeouts y avisos silenciados. */
export function connect(resolved, { applicationName = "biblib-runner" } = {}) {
  const url = resolved.target.env().SUPABASE_DB_URL
  return postgres(url, {
    max: 1, prepare: false, ssl: false, connect_timeout: 10, idle_timeout: 0, max_lifetime: null, onnotice: () => {},
    connection: { application_name: applicationName, statement_timeout: 120000, lock_timeout: 15000, idle_in_transaction_session_timeout: 120000 },
  })
}

export async function closeConnection(sql) {
  try { await sql?.end({ timeout: 5 }) } catch { /* El cierre es best-effort tras liberar el bloqueo. */ }
}

export function connectionError(error, phase = "conexión") {
  if (error instanceof BiblibError) return error
  return new BiblibError(EXIT.SERVICE_UNAVAILABLE, phase, `No se pudo consultar Postgres del stack local${error?.code ? ` (${String(error.code).replace(/[^A-Z0-9_]/gi, "")})` : ""}.`)
}

export async function readLedger(sql) {
  const [meta] = await sql`select
      exists(select 1 from pg_namespace where nspname = 'biblib') as biblib,
      to_regclass(${`${LEDGER.schema}.${LEDGER.table}`}) is not null as ledger,
      to_regclass('supabase_migrations.schema_migrations') is not null as supabase_ledger`
  const rows = meta.ledger ? await sql`select id, hash, created_at from ${sql(LEDGER.schema)}.${sql(LEDGER.table)} order by id` : []
  return { biblib: meta.biblib, ledger: meta.ledger, supabaseLedger: meta.supabase_ledger, rows: rows.map((r) => ({ id: r.id, hash: r.hash, created_at: Number(r.created_at) })) }
}

/**
 * Clasifica el destino sin modificarlo: empty, pending, up-to-date, adoption-required,
 * diverged, reconciliation-required o drift. `code` es el exit code que corresponde.
 */
export function classify(journal, ledger, facts) {
  const checks = []
  const prerequisites = facts ? checkPrerequisites(facts) : []
  if (ledger.supabaseLedger) checks.push({ id: "ledger.supabase", status: "warn", message: "Existe supabase_migrations.schema_migrations: BibLib no registra negocio ahí; revísalo, el runner no lo usa." })
  const all = journal.entries.map((e) => ({ tag: e.tag, when: e.when, hash: e.hash, status: "pending" }))
  if (!ledger.rows.length) {
    if (ledger.biblib) {
      checks.push({ id: "ledger.adoption", status: "fail", code: EXIT.HISTORY_DIVERGED, message: "Esquema de negocio biblib presente sin historial Drizzle: adopción de historial necesaria (U-INF-07). No se trata como base vacía ni se aplica DDL encima." })
      return { state: "adoption-required", code: EXIT.HISTORY_DIVERGED, appliedHead: null, migrations: all.map((m) => ({ ...m, status: "unknown" })), pending: [], checks, prerequisites, manifest: [] }
    }
    const failedPrerequisite = prerequisites.find((p) => p.status === "fail")
    return { state: "empty", code: failedPrerequisite ? EXIT.SERVICE_UNAVAILABLE : EXIT.OK, appliedHead: null, migrations: all, pending: all.map((m) => m.tag), checks, prerequisites, manifest: [] }
  }
  const comparison = compareLedger(journal.entries, ledger.rows)
  if (comparison.problems.length || !ledger.biblib) {
    const legacy = comparison.problems.some((p) => p.id === "ledger.legacy-crlf")
    if (!ledger.biblib) checks.push({ id: "ledger.schema", status: "fail", code: EXIT.HISTORY_DIVERGED, message: "El ledger registra migraciones pero falta el esquema biblib: historial y esquema no coinciden." })
    return { state: legacy ? "reconciliation-required" : "diverged", code: EXIT.HISTORY_DIVERGED, appliedHead: comparison.appliedHead, migrations: comparison.migrations, pending: [], checks: [...checks, ...comparison.problems], prerequisites, manifest: [] }
  }
  const applied = comparison.migrations.filter((m) => m.status === "applied").map((m) => m.tag)
  const manifest = facts ? verifyManifest(facts, applied) : []
  const drift = manifest.filter((c) => c.status === "fail")
  if (drift.length) {
    checks.push({ id: "manifest.drift", status: "fail", code: EXIT.HISTORY_DIVERGED, message: `Drift en ${drift.length} objeto(s) deliberado(s); no se corrige reaplicando migraciones antiguas: requiere corrección hacia delante revisada.` })
    return { state: "drift", code: EXIT.HISTORY_DIVERGED, appliedHead: comparison.appliedHead, migrations: comparison.migrations, pending: [], checks, prerequisites, manifest }
  }
  return { state: comparison.pending.length ? "pending" : "up-to-date", code: EXIT.OK, appliedHead: comparison.appliedHead, migrations: comparison.migrations, pending: comparison.pending, checks, prerequisites, manifest }
}

export async function inspectDatabase(sql, journal) {
  const ledger = await readLedger(sql)
  const facts = await inspectObjects(sql)
  return { ledger, facts, ...classify(journal, ledger, facts) }
}

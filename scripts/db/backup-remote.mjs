import { spawnSync } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import postgres from "postgres"
import { COVERS_BUCKET, MEDIA_BUCKET, objectFacts } from "../lib/backup-db.mjs"
import { resolveBackupsRoot } from "../lib/backup-files.mjs"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { sanitize } from "../lib/process.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"
import { LEDGER, loadJournal, MIGRATIONS_DIR } from "./journal-guard.mjs"
import { gitCommit } from "./plan.mjs"
import { withRemoteEnvFile } from "./remote-env.mjs"
import { connectRemote, describeRemote, isRemoteTarget, ledgerHash, probeRemote, RECEIPT_COVERAGE, RECEIPT_KIND, receiptHash, remoteConnectionError } from "./remote-preflight.mjs"
import { closeConnection, inspectDatabase } from "./target.mjs"

// Respaldo administrativo de preprod/prod (U-OPS-02 remoto) con el recibo que exige la promoción.
// El proyecto Supabase es compartido (D01): solo se respalda lo de BibLib. Dominio y ledger con pg_dump
// en el snapshot exportado de la misma transacción que mide ledger y objetos; de Auth, solo las cuentas
// con datos en BibLib y sin secretos; Storage de BibLib solo si está vacío (los bytes exigen service_role).
// Después se restaura en un Postgres desechable del mismo major y se verifica antes de sellar el recibo.

export const LABEL = "biblib.unit=backup-remoto"
const AUTH_SECRET_COLUMNS = Object.freeze(["encrypted_password", "confirmation_token", "recovery_token", "email_change_token_new", "email_change_token_current", "phone_change_token", "reauthentication_token"])
const BACKUP_STATES = new Set(["adoption-required", "pending", "up-to-date"])
const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }
const relative = (root, file) => path.relative(root, file).split(path.sep).join("/")

export function parseBackupRemoteArgs(argv) {
  const [target, ...args] = argv
  if (!isRemoteTarget(target)) fail(EXIT.INVALID_ARGS, "argumentos", "Uso: db:backup:<preprod|prod> --expect-project <ref> [--json].")
  const options = { target, json: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") options.json = true
    else if (args[i] === "--expect-project" && args[i + 1] && !args[i + 1].startsWith("--") && !options.expectProject) options.expectProject = args[++i]
    else fail(EXIT.INVALID_ARGS, "argumentos", `Uso: db:backup:${target} --expect-project <ref> [--json]. No se admiten URLs ni otros flags.`)
  }
  if (!options.expectProject) fail(EXIT.INVALID_ARGS, "argumentos", `db:backup:${target} exige --expect-project <ref>.`)
  return options
}

/** Cuentas con datos en BibLib: unión de `user_id` de todas sus tablas. */
async function biblibOwners(tx) {
  const tables = await tx`select c.table_name as table from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'biblib' and c.column_name = 'user_id' and t.table_type = 'BASE TABLE' order by 1`
  const ids = new Set()
  for (const { table } of tables) for (const row of await tx`select distinct user_id::text as id from ${tx("biblib")}.${tx(table)} where user_id is not null`) ids.add(row.id)
  return [...ids].sort()
}

async function tableCounts(tx) {
  const counts = {}
  for (const { table } of await tx`select tablename as table from pg_tables where schemaname = 'biblib' order by 1`) {
    counts[`biblib.${table}`] = Number((await tx`select count(*)::bigint as n from ${tx("biblib")}.${tx(table)}`)[0].n)
  }
  return counts
}

async function authRows(tx, ids) {
  if (!ids.length) return { users: [], identities: [] }
  const users = await tx`select to_jsonb(u) - ${AUTH_SECRET_COLUMNS}::text[] as row from auth.users u where u.id = any(${ids}::uuid[]) order by u.id`
  const identities = (await tx`select to_regclass('auth.identities') is not null as present`)[0].present
    ? await tx`select to_jsonb(i) as row from auth.identities i where i.user_id = any(${ids}::uuid[]) order by i.user_id, i.provider`
    : []
  return { users: users.map((r) => r.row), identities: identities.map((r) => r.row) }
}

async function storageObjects(tx) {
  if (!(await tx`select to_regclass('storage.objects') is not null as present`)[0].present) return []
  return tx`select bucket_id as bucket, count(*)::integer as objects from storage.objects where bucket_id in (${COVERS_BUCKET}, ${MEDIA_BUCKET}) or bucket_id like 'biblib%' group by bucket_id order by bucket_id`
}

function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, windowsHide: true, ...options })
}

/**
 * pg_dump en un contenedor `postgres:<major>-alpine` contra el destino, con TLS verify-full, la
 * credencial por entorno (nunca en argv) y el snapshot exportado por la transacción del respaldo.
 */
export function dumpDomain(remote, { snapshot, schemas, image }) {
  const url = new URL(remote.ctx.env().SUPABASE_DB_URL)
  const env = {
    ...process.env, PGHOST: remote.descriptor.host, PGPORT: String(remote.descriptor.port), PGDATABASE: remote.descriptor.database,
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: "verify-full",
    PGSSLROOTCERT: remote.rootCert ? "/run/biblib/ca.crt" : "/etc/ssl/certs/ca-certificates.crt",
  }
  const args = ["run", "--rm", "--label", LABEL, ...["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSSLMODE", "PGSSLROOTCERT"].flatMap((name) => ["--env", name]),
    ...(remote.rootCert ? ["--mount", `type=bind,source=${remote.rootCert},target=/run/biblib/ca.crt,readonly`] : []),
    image, "pg_dump", "--format", "plain", "--quote-all-identifiers", "--snapshot", snapshot, ...schemas.flatMap((schema) => ["--schema", schema])]
  const result = docker(args, { env })
  if (result.status !== 0 || !result.stdout) fail(EXIT.SERVICE_UNAVAILABLE, "volcado", `pg_dump no pudo volcar ${schemas.join("/")} del destino: ${sanitize(result.stderr || result.error?.message || "sin salida").trim().split(/\r?\n/).slice(-2).join(" ")}`)
  return result.stdout
}

// Roles a los que el volcado concede o asigna algo: la copia desechable los crea sin login.
export function referencedRoles(dump) {
  const roles = new Set()
  for (const match of dump.matchAll(/\b(?:OWNER TO|TO|FROM)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?(?=\s*(?:[;,]|USING\b|WITH\b))/g)) roles.add(match[1])
  for (const match of dump.matchAll(/\bTO\s+((?:"?[A-Za-z_][A-Za-z0-9_]*"?\s*,\s*)+"?[A-Za-z_][A-Za-z0-9_]*"?)\s*;/g)) for (const role of match[1].split(",")) roles.add(role.trim().replace(/"/g, ""))
  roles.delete("PUBLIC")
  roles.delete("public")
  return [...roles].sort()
}

/** Restaura en un Postgres desechable del mismo major y comprueba ledger, manifest, objetos y filas. */
export async function rehearseRestore({ root, dir, backupId, image, dump, ownerIds, expected, journal }) {
  const password = randomUUID()
  const started = docker(["run", "--rm", "--detach", "--label", LABEL, "--publish", "127.0.0.1::5432", "--env", `POSTGRES_PASSWORD=${password}`, image])
  const id = started.stdout?.trim()
  if (started.status !== 0 || !/^[a-f0-9]{64}$/.test(id ?? "")) fail(EXIT.SERVICE_UNAVAILABLE, "ensayo", "No se pudo arrancar el Postgres desechable del ensayo de restauración.")
  const psql = (sqlText) => {
    const result = docker(["exec", "-i", id, "psql", "--no-psqlrc", "--quiet", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], { input: sqlText })
    if (result.status !== 0) fail(EXIT.VERIFICATION_FAILED, "ensayo", `La restauración en la copia desechable falló: ${sanitize(result.stderr).trim().split(/\r?\n/).slice(-2).join(" ")}`)
  }
  try {
    let ready = false
    for (let attempt = 0; attempt < 240 && !ready; attempt++) {
      ready = docker(["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres"]).status === 0
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!ready) fail(EXIT.SERVICE_UNAVAILABLE, "ensayo", "El Postgres desechable no respondió.")
    // Sustituto mínimo de Auth y Storage (el mismo de test:db) y los roles que cite el volcado.
    psql(readFileSync(path.join(REPO_ROOT, "tests/db/bootstrap.sql"), "utf8"))
    const roles = referencedRoles(dump)
    if (roles.length) psql(roles.map((role) => `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE "${role}" NOLOGIN; END IF; END $$;`).join("\n"))
    if (ownerIds.length) psql(`insert into auth.users (id) values ${ownerIds.map((u) => `('${u}')`).join(", ")};`)
    psql(dump)
    psql("DO $$ BEGIN IF to_regprocedure('biblib.cover_storage_install()') IS NOT NULL THEN PERFORM biblib.cover_storage_install(); END IF; IF to_regprocedure('biblib.media_storage_install()') IS NOT NULL THEN PERFORM biblib.media_storage_install(); END IF; END $$;")
    const port = Number(/:(\d+)\s*$/m.exec(docker(["port", id, "5432/tcp"]).stdout ?? "")?.[1])
    const sql = postgres({ host: "127.0.0.1", port, database: "postgres", username: "postgres", password, ssl: false, max: 1, onnotice: () => {} })
    let restored
    try {
      restored = await sql.begin("read only", async (tx) => ({ inspection: await inspectDatabase(tx, journal, { legacy: "adopt" }), objects: await objectFacts(tx), counts: await tableCounts(tx) }))
    } finally { await sql.end({ timeout: 5 }) }
    const checks = [
      { id: "ledger", status: ledgerHash(restored.inspection.ledger.rows) === expected.ledgerHash ? "ok" : "fail" },
      { id: "manifest", status: restored.inspection.state === expected.state ? "ok" : "fail", state: restored.inspection.state, expected: expected.state },
      { id: "objects.facts", status: restored.objects.hash === expected.objectsHash ? "ok" : "fail" },
      { id: "rows", status: JSON.stringify(restored.counts) === JSON.stringify(expected.counts) ? "ok" : "fail", tables: Object.keys(expected.counts).length },
    ]
    const report = { schemaVersion: 1, kind: "biblib-restore-report", reportId: randomUUID(), backupId, passed: checks.every((c) => c.status === "ok"), checks, target: { target: "copia-aislada", image }, finishedAt: new Date().toISOString() }
    const file = path.join(dir, "rehearsal.json")
    const body = `${JSON.stringify(report, null, 2)}\n`
    writeFileSync(file, body, { mode: 0o600 })
    return { report, restoreVerification: { passed: report.passed, reportId: report.reportId, report: relative(root, file), reportSha256: sha256(body), at: report.finishedAt, target: report.target } }
  } finally { docker(["rm", "--force", "--volumes", id]) }
}

export async function backupRemote({ target, expectProject, root = REPO_ROOT, env = process.env, now = new Date() }, deps = {}) {
  const remote = describeRemote(target, { env, expectProject, cwd: root })
  const journal = loadJournal(MIGRATIONS_DIR)
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
  const backupId = `${stamp}-${target}-${randomBytes(3).toString("hex")}`
  const dir = path.join(resolveBackupsRoot(root), backupId)
  const sql = connectRemote(remote, { applicationName: "biblib-backup", resolveHost: deps.resolveHost })
  let source
  try {
    const probe = await sql.begin("read only", (tx) => probeRemote(tx, remote.descriptor))
    const failed = probe.checks.find((c) => c.status === "fail")
    if (failed) fail(failed.code, "preflight", failed.message)
    const image = `postgres:${probe.facts.major}-alpine`
    source = await sql.begin("isolation level repeatable read read only", async (tx) => {
      const inspection = await inspectDatabase(tx, journal, { legacy: "adopt" })
      if (!BACKUP_STATES.has(inspection.state)) fail(inspection.state === "empty" ? EXIT.PLAN_REJECTED : EXIT.HISTORY_DIVERGED, "ledger", `El destino está en estado ${inspection.state}: no hay un esquema de BibLib coherente que respaldar. Consulta db:status:${target}.`)
      const storage = await storageObjects(tx)
      const stored = storage.reduce((n, b) => n + b.objects, 0)
      if (stored) fail(EXIT.MISSING_REQUIREMENT, "storage", `Hay ${stored} objeto(s) en Storage de BibLib (${storage.map((b) => b.bucket).join(", ")}): sus bytes exigen la clave service_role y este respaldo no los cubre todavía.`)
      const ownerIds = await biblibOwners(tx)
      const auth = await authRows(tx, ownerIds)
      const [{ snapshot }] = await tx`select pg_export_snapshot() as snapshot`
      const schemas = ["biblib", ...((await tx`select to_regnamespace(${LEDGER.schema}) is not null as present`)[0].present ? [LEDGER.schema] : [])]
      // El snapshot vive mientras esta transacción siga abierta: pg_dump ve exactamente lo medido aquí.
      const dump = await (deps.dumpDomain ?? dumpDomain)(remote, { snapshot, schemas, image })
      return { inspection, objects: await objectFacts(tx), counts: await tableCounts(tx), ownerIds, auth, storage, schemas, dump, image, version: probe.facts.version }
    })
  } catch (error) {
    throw error instanceof BiblibError ? error : remoteConnectionError(error, "respaldo")
  } finally { await closeConnection(sql) }

  mkdirSync(path.join(dir, "db"), { recursive: true, mode: 0o700 })
  const files = []
  const add = (role, name, content) => {
    const file = path.join(dir, ...name.split("/"))
    writeFileSync(file, content, { flag: "wx", mode: 0o600 })
    files.push({ path: relative(root, file), role, bytes: Buffer.byteLength(content), sha256: sha256(Buffer.from(content)) })
  }
  add("domain-dump", "db/biblib.sql", source.dump)
  add("auth-data", "db/auth.json", `${JSON.stringify({ users: source.auth.users, identities: source.auth.identities }, null, 2)}\n`)
  const ledgerRowsHash = ledgerHash(source.inspection.ledger.rows)
  const rehearsal = await (deps.rehearseRestore ?? rehearseRestore)({
    root, dir, backupId, image: deps.restoreImage ?? source.image, dump: source.dump, ownerIds: source.ownerIds, journal,
    expected: { ledgerHash: ledgerRowsHash, objectsHash: source.objects.hash, state: source.inspection.state, counts: source.counts },
  })
  const receipt = {
    schemaVersion: 1, kind: RECEIPT_KIND, backupId, createdAt: now.toISOString(), completedAt: new Date().toISOString(),
    target: { target, profile: null, project: remote.project }, fingerprint: remote.fingerprint, commit: (deps.gitCommit ?? gitCommit)(root).sha,
    source: { postgres: source.version, image: source.image, connection: remote.descriptor.connection, schemas: source.schemas },
    migrations: { head: source.inspection.appliedHead?.tag ?? null, state: source.inspection.state, applied: source.inspection.migrations.filter((m) => m.status === "applied").map((m) => m.tag), ledgerHash: ledgerRowsHash },
    scope: ["schema", "data", "history", "domain", "ledger", "auth", "storage"],
    counts: { tables: source.counts, authUsers: source.auth.users.length, authIdentities: source.auth.identities.length, storageObjects: 0 },
    strategy: {
      auth: `Proyecto compartido: solo las ${source.auth.users.length} cuenta(s) con datos en BibLib (auth.users e identities), sin contraseñas ni tokens. Sesiones y refresh tokens fuera. Nunca se restauran sobre el Auth compartido sin revisar las demás apps.`,
      storage: "Buckets de BibLib vacíos en el momento del respaldo (comprobado); si tuvieran objetos, el respaldo se detiene porque los bytes exigen service_role.",
      configuration: "Configuración de Auth/OAuth/SMTP/JWT, claves y variables del alojamiento fuera del respaldo; se reconfiguran desde el gestor de credenciales.",
    },
    objects: { hash: source.objects.hash, coverage: [...RECEIPT_COVERAGE] },
    files, restoreVerification: rehearsal.restoreVerification,
  }
  receipt.receiptHash = receiptHash(receipt)
  const receiptFile = path.join(dir, "receipt.json")
  writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  if (!rehearsal.report.passed) fail(EXIT.VERIFICATION_FAILED, "ensayo", `El ensayo de restauración no superó: ${rehearsal.report.checks.filter((c) => c.status !== "ok").map((c) => c.id).join(", ")}. El recibo ${relative(root, receiptFile)} no sirve para promover.`)
  return { code: EXIT.OK, result: { schemaVersion: 1, backupId, receipt: relative(root, receiptFile), project: remote.project, head: receipt.migrations.head, state: receipt.migrations.state, counts: receipt.counts, rehearsal: rehearsal.report.checks.map(({ id, status }) => ({ id, status })) } }
}

export async function main(argv = process.argv.slice(2)) {
  let json = argv.includes("--json")
  try {
    const options = parseBackupRemoteArgs(argv)
    json = options.json
    const { code, result } = await backupRemote({ ...options, env: withRemoteEnvFile(options.target) })
    if (json) console.log(JSON.stringify({ code, ...result }))
    else {
      console.log(`Respaldo ${result.backupId} · ${options.target} (${result.project}) · estado ${result.state} · head ${result.head ?? "sin ledger propio"}`)
      console.log(`Tablas: ${Object.keys(result.counts.tables).length} · cuentas Auth de BibLib: ${result.counts.authUsers} · Storage: ${result.counts.storageObjects}`)
      console.log(`Ensayo de restauración: ${result.rehearsal.map((c) => `${c.id} ${c.status}`).join(", ")}`)
      console.log(`Recibo: ${result.receipt} (válido 24 h; repítelo si el destino cambia)`)
      const plan = result.state === "adoption-required" ? "adopt" : "migrate"
      console.log(`Siguiente: pnpm db:plan:${options.target} --out ${options.target}.json --expect-project ${result.project} y, tras revisarlo, pnpm db:${plan}:${options.target} --plan .biblib/plans/${options.target}.json --expect-project ${result.project} --expect-plan <sha256> --backup-receipt ${result.receipt}`)
    }
    return code
  } catch (error) {
    const code = error instanceof BiblibError ? error.code : EXIT.SERVICE_UNAVAILABLE
    const result = { schemaVersion: 1, code, phase: error instanceof BiblibError ? error.phase : "respaldo", message: error instanceof BiblibError ? sanitize(error.message) : "No se pudo completar el respaldo remoto." }
    if (json) console.log(JSON.stringify(result))
    else console.error(`Error [${result.phase}] (${code}): ${result.message}`)
    return code
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

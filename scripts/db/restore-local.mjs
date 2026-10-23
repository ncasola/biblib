import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, lstatSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { checkBackupFiles, compareMigrations, readBackupFile, readKeyFile, readManifest, resolveBackupDir } from "../lib/backup-files.mjs"
import { rotateRestoredTokens } from "../lib/backup-db.mjs"
import { streamCommand } from "../lib/backup-process.mjs"
import { inventory } from "../lib/docker.mjs"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { sanitize } from "../lib/process.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"
import { acquireLock, readState, writeState } from "../lib/state.mjs"
import { registeredDatabase } from "./backup-local.mjs"
import { readFixtureStore, writeFixtureStore } from "./fixture-store.mjs"
import { loadJournal } from "./journal-guard.mjs"
import { acquireMigrationLock, releaseMigrationLock } from "./migrate.mjs"
import { assertResetIdentity } from "./reset-local.mjs"
import { ASSET, BUCKET, loadCensus, resolveSeedTarget } from "./seed-local.mjs"
import { closeConnection, connect, connectionError } from "./target.mjs"

const fail = (code, message, phase = "restore") => { throw new BiblibError(code, phase, message) }
const PHASES = ["preflight", "clear", "auth", "domain", "storage", "rotate", "fixtures"]
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

export function parseRestoreArgs(argv) {
  const parsed = { json: false }
  const values = { "--backup": "backup", "--profile": "profile", "--expect-project": "expectProject", "--key-file": "keyFile" }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (seen.has(flag)) fail(EXIT.INVALID_ARGS, "Argumento repetido.", "argumentos")
    seen.add(flag)
    if (flag === "--json") parsed.json = true
    else if (values[flag] && argv[i + 1] && !argv[i + 1].startsWith("--")) parsed[values[flag]] = argv[++i]
    else fail(EXIT.INVALID_ARGS, "Restore no admite URLs, --linked, --db-url ni flags reenviados.", "argumentos")
  }
  if (!parsed.backup || !parsed.expectProject || !["main", "test", "scratch"].includes(parsed.profile)) fail(EXIT.INVALID_ARGS, "Uso: db:restore:local --backup <carpeta> --profile main|test|scratch --expect-project <id> [--key-file <ruta>] [--json].", "argumentos")
  return parsed
}

/**
 * Lee y autentica el respaldo antes de mirar el destino: un archivo ausente, alterado o una
 * clave que falta detienen el ensayo sin modificar nada.
 */
export function loadBackup(root, options) {
  const dir = resolveBackupDir(root, options.backup)
  const manifest = readManifest(dir)
  const discrepancies = checkBackupFiles(dir, manifest)
  if (discrepancies.length) fail(EXIT.VERIFICATION_FAILED, `Respaldo incompleto o alterado (${discrepancies.length} discrepancia(s), p. ej. ${discrepancies[0].message}); no se ha modificado el destino.`, "integridad")
  let key = null
  if (manifest.encryption) {
    if (!options.keyFile) fail(EXIT.PLAN_REJECTED, "El respaldo está cifrado y falta la clave de recuperación (--key-file); no se ha modificado el destino.", "clave")
    key = readKeyFile(root, options.keyFile, { backupsRoot: path.dirname(dir), backupDir: dir })
    if (key.fingerprint !== manifest.encryption.keyFingerprint) fail(EXIT.PLAN_REJECTED, "La clave indicada no corresponde a este respaldo.", "clave")
  } else if (options.keyFile) fail(EXIT.INVALID_ARGS, "El respaldo no está cifrado; no indiques --key-file.", "clave")
  const file = (role) => manifest.files.find((f) => f.role === role) ?? fail(EXIT.VERIFICATION_FAILED, `Falta ${role} en el inventario.`, "integridad")
  const domain = readBackupFile(dir, file("domain-dump"), key?.key)
  const auth = readBackupFile(dir, file("auth-data"), key?.key)
  const objects = manifest.storage.objects.map((object) => ({ ...object, bytes: readBackupFile(dir, manifest.files.find((f) => f.path === object.file), key?.key) }))
  return { dir, manifest, domain, auth, objects }
}

// Tablas derivadas o regenerables que el reset+seed puebla por sí solo (library_state lo crea el
// trigger de 0003 para cada propietario) o que no guardan datos del usuario: revisión de colección
// (la restauración la rota), previews (se invalidan) y caché/cuotas del catálogo (vaciables). El
// restore las sustituye al recrear el esquema. library_operations sí cuenta: registra importaciones
// confirmadas, es decir, actividad real.
export const DERIVED_TABLES = Object.freeze(["library_state", "import_previews", "catalogue_cache", "catalogue_inflight", "catalogue_quota_buckets", "catalogue_quota_reservations", "catalogue_private_cache"])

// Versiones anteriores (U-DAT-02, 0006): son datos de la cuenta, no derivados. Se restauran tal cual
// con el volcado de dominio (también su `version`, que solo autoriza borrar esa versión, y su
// caducidad, que sigue corriendo), por eso un destino con versiones no está vacío. Sus vistas previas
// de restauración caen con las demás en la rotación. Tras restaurar se comprueba su integridad.
export const SNAPSHOT_TABLES = Object.freeze(["library_snapshots", "library_snapshot_chunks"])

// U-EXP-02: preferencias de usuario restaurables con su versión; nunca son caché regenerable.
// El volcado incluye nombres, filtros, fechas y tokens. Un destino con vistas no está vacío.
export const SAVED_VIEW_TABLES = Object.freeze(["saved_book_views"])

/**
 * Integridad de las versiones restauradas a partir de hechos agregados (sin IDs ni contenido): un
 * trozo o hash final que no cuadra es un respaldo dañado; una versión vencida o sin completar se
 * informa para revisión, porque ninguna de las dos se lista ni se restaura.
 */
export function classifySnapshots(rows) {
  const damaged = rows.filter((row) => row.state === "ready" && (!row.chunksOk || !row.digestOk || row.chunks === 0))
  if (damaged.length) fail(EXIT.VERIFICATION_FAILED, `${damaged.length} versión(es) anterior(es) restauradas no superan su hash: el respaldo está dañado o alterado.`, "rotate")
  const review = []
  const capturing = rows.filter((row) => row.state !== "ready").length
  const expired = rows.filter((row) => row.state === "ready" && row.expired).length
  if (capturing) review.push({ table: "biblib.library_snapshots", message: `${capturing} versión(es) sin completar: no se listan ni se restauran; elimínalas tras revisar su origen.` })
  if (expired) review.push({ table: "biblib.library_snapshots", message: `${expired} versión(es) vencidas: se retirarán en la siguiente captura o con library_snapshot_purge_expired.` })
  return { restored: rows.length - capturing, chunks: rows.reduce((total, row) => total + row.chunks, 0), expired, capturing, review }
}

/** Lee los hechos de integridad de las versiones restauradas dentro de la transacción del llamador. */
export async function verifyRestoredSnapshots(tx) {
  const [present] = await tx`select to_regclass('biblib.library_snapshots') is not null as found`
  if (!present.found) return { restored: 0, chunks: 0, expired: 0, capturing: 0, review: [] }
  const rows = await tx`select s.state, s.expires_at <= now() as expired, count(c.seq)::integer as chunks,
      coalesce(bool_and(c.digest = encode(sha256(convert_to(c.payload::text, 'UTF8')), 'hex')), true) as chunks_ok,
      coalesce(s.digest = encode(sha256(convert_to(concat_ws('|', 'biblib.snapshot.v1', (s.counts->>'books')::integer, (s.counts->>'shelves')::integer,
        coalesce(string_agg(c.digest, '' order by c.seq), '')), 'UTF8')), 'hex'), false) as digest_ok
    from biblib.library_snapshots as s left join biblib.library_snapshot_chunks as c on c.snapshot_id = s.id
    group by s.id`
  return classifySnapshots(rows.map((row) => ({ state: row.state, expired: row.expired, chunks: row.chunks, chunksOk: row.chunks_ok, digestOk: row.digest_ok })))
}

/**
 * Destino vacío o recién reseteado: solo puede contener las cuentas, bibliotecas y el objeto
 * del censo de fixtures que vuelve a crear `db:reset:local`, más filas de tablas derivadas.
 * Cualquier otro dato aborta.
 */
export function classifyDestination({ users, books, shelves, otherRows, buckets, objects }, census) {
  const emails = new Set(census.accounts.map((a) => a.email))
  const fixtureUsers = new Set(users.filter((u) => u.census === census.censusId && emails.has(u.email)).map((u) => u.id))
  const foreign = []
  if (users.some((u) => !fixtureUsers.has(u.id))) foreign.push("cuentas fuera del censo de fixtures")
  if (books.some((b) => b.census !== census.censusId || !b.fixture || !fixtureUsers.has(b.user_id))) foreign.push("libros que no son fixtures")
  if (shelves.some((s) => !fixtureUsers.has(s.user_id))) foreign.push("estanterías de otras cuentas")
  if (otherRows.some((r) => r.rows > 0 && !DERIVED_TABLES.includes(r.table))) foreign.push("filas en otras tablas de biblib")
  if (buckets.some((b) => b.id !== BUCKET) || objects.some((o) => o.bucket !== BUCKET || o.name !== ASSET)) foreign.push("objetos Storage fuera del fixture")
  return { fresh: foreign.length === 0, foreign, fixtureUsers: [...fixtureUsers] }
}

async function readDestination(tx) {
  const users = await tx`select id::text as id, email, raw_user_meta_data->>'biblib_fixture' as census from auth.users`
  const [schema] = await tx`select to_regclass('biblib.books') is not null as books, to_regclass('biblib.shelves') is not null as shelves`
  const books = schema.books ? await tx`select user_id::text as user_id, catalogue->>'censusId' as census, catalogue ? 'fixtureKey' as fixture from biblib.books` : []
  const shelves = schema.shelves ? await tx`select user_id::text as user_id from biblib.shelves` : []
  const otherRows = []
  for (const t of await tx`select tablename as table from pg_tables where schemaname = 'biblib' and tablename not in ('books', 'shelves')`) {
    const [row] = await tx`select count(*)::integer as rows from ${tx("biblib")}.${tx(t.table)}`
    otherRows.push({ table: t.table, rows: row.rows })
  }
  const buckets = await tx`select id from storage.buckets`
  const objects = await tx`select bucket_id as bucket, name from storage.objects`
  return { users, books, shelves, otherRows, buckets: [...buckets], objects: [...objects] }
}

const PSQL = ["psql", "-X", "--host", "127.0.0.1", "--username", "postgres", "--dbname", "postgres", "--no-password", "-v", "ON_ERROR_STOP=1", "--single-transaction", "--quiet", "-f", "-"]

async function applySql(stack, db, input, phase, signal) {
  // El volcado viaja por stdin del contenedor registrado; ni datos ni credenciales en argv.
  const result = await streamCommand("docker", ["exec", "-i", db.id, ...PSQL], { ...stack.processOptions, input, signal, phase, maxBytes: 16 * 1024 * 1024 })
  if (result.code !== 0) fail(EXIT.SERVICE_UNAVAILABLE, `psql no pudo aplicar la fase ${phase} en una transacción; se revirtió esa fase.`, phase)
}

async function restoreStorage(admin, manifest, objects, destination) {
  const wanted = new Set(objects.map((o) => `${o.bucket}\u0000${o.name}`))
  for (const bucket of manifest.storage.buckets) {
    const options = { public: bucket.public, allowedMimeTypes: bucket.allowedMimeTypes ?? undefined, fileSizeLimit: bucket.fileSizeLimit ?? undefined }
    const exists = destination.buckets.some((b) => b.id === bucket.id)
    const { error } = exists ? await admin.storage.updateBucket(bucket.id, options) : await admin.storage.createBucket(bucket.id, options)
    if (error) fail(EXIT.SERVICE_UNAVAILABLE, "Storage no aceptó la configuración de un bucket del respaldo.", "storage")
  }
  for (const object of objects) {
    const { error } = await admin.storage.from(object.bucket).upload(object.name, object.bytes, { contentType: object.contentType, upsert: true })
    if (error) fail(EXIT.SERVICE_UNAVAILABLE, "Storage no aceptó un objeto del respaldo.", "storage")
  }
  // El destino recién reseteado solo puede tener el objeto fixture: lo que no esté en el respaldo se retira.
  const extra = destination.objects.filter((o) => !wanted.has(`${o.bucket}\u0000${o.name}`))
  for (const bucket of new Set(extra.map((o) => o.bucket))) {
    const { error } = await admin.storage.from(bucket).remove(extra.filter((o) => o.bucket === bucket).map((o) => o.name))
    if (error) fail(EXIT.SERVICE_UNAVAILABLE, "Storage no retiró un objeto fixture ajeno al respaldo.", "storage")
  }
  for (const bucket of destination.buckets.filter((b) => !manifest.storage.buckets.some((m) => m.id === b.id))) {
    const { error } = await admin.storage.deleteBucket(bucket.id)
    if (error) fail(EXIT.SERVICE_UNAVAILABLE, "Storage no retiró un bucket fixture ajeno al respaldo.", "storage")
  }
  return { buckets: manifest.storage.buckets.length, objects: objects.length, removed: extra.length }
}

/**
 * Las contraseñas de las cuentas fixture no viajan en el respaldo. Tras restaurar Auth se
 * reasignan las del registro privado del destino (o nuevas aleatorias) mediante la API admin
 * de GoTrue: es una rotación de credenciales locales, limitada a las cuentas del censo.
 */
async function rebindFixtures(admin, sql, resolved, census, backupId) {
  const store = readFixtureStore(resolved, census) ?? { schemaVersion: 1, censusVersion: census.censusVersion, censusId: census.censusId, fingerprint: resolved.fingerprint, accounts: {}, phase: "restaurado" }
  store.serviceRoleKey = resolved.target.env().SUPABASE_SERVICE_ROLE_KEY
  store.restoredFrom = backupId
  const bound = []
  for (const account of census.accounts) {
    const [user] = await sql`select id::text as id from auth.users where email = ${account.email} and raw_user_meta_data->>'biblib_fixture' = ${census.censusId}`
    if (!user) { delete store.accounts[account.key]; continue }
    const saved = store.accounts[account.key] ??= { email: account.email, password: randomBytes(36).toString("base64url") }
    writeFixtureStore(resolved, store)
    const { error } = await admin.auth.admin.updateUserById(user.id, { password: saved.password })
    if (error) fail(EXIT.SERVICE_UNAVAILABLE, "GoTrue no aceptó la reasignación de credenciales de un fixture restaurado.", "fixtures")
    saved.id = user.id
    writeFixtureStore(resolved, store)
    bound.push(account.key)
  }
  return { accounts: bound }
}

function assertWorktreeProfile(root, profile) {
  const git = path.join(root, ".git")
  if (existsSync(git) && !lstatSync(git).isDirectory() && profile !== "scratch") fail(EXIT.IDENTITY_MISMATCH, "Desde un worktree solo se restaura sobre scratch.", "identidad")
}

export async function runRestore(options, deps = {}) {
  const root = deps.root ?? REPO_ROOT
  const startedAt = new Date()
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") fail(EXIT.IDENTITY_MISMATCH, "Restore solo admite BIBLIB_TARGET=local o ausente; el procedimiento remoto está pendiente de U-INF-07.", "objetivo")
  assertWorktreeProfile(root, options.profile)
  const backup = loadBackup(root, options)
  const { manifest } = backup
  const journal = loadJournal(path.join(root, "drizzle"))
  const migrations = compareMigrations(manifest.migrations.applied, journal.entries)
  if (!migrations.ok) fail(EXIT.HISTORY_DIVERGED, `El historial del respaldo no es un prefijo del journal de este checkout: ${migrations.problems[0]}`, "ledger")
  const census = loadCensus(root)
  const resolved = await (deps.resolveTarget ?? resolveSeedTarget)(options.profile, { root })
  if (options.expectProject !== resolved.project) fail(EXIT.IDENTITY_MISMATCH, "--expect-project no coincide con el proyecto del perfil destino; no se ha modificado nada.", "identidad")
  const { stack } = resolved
  const state = readState(stack)
  const all = await (deps.inventory ?? inventory)(stack)
  assertResetIdentity(stack, state, all, resolved.target)
  const db = registeredDatabase(stack, state, all)
  const release = acquireLock(stack)
  const runId = randomUUID()
  let sql, locked = false, receipt
  const save = (phase, status, extra = {}) => {
    receipt.phase = phase
    receipt.phases[phase] = { ...receipt.phases[phase], status, ...extra, at: new Date().toISOString() }
    writeState(stack, receipt, "-restore")
  }
  try {
    sql = connect(resolved, { applicationName: "biblib-restore" })
    await acquireMigrationLock(sql, { signal: options.signal })
    locked = true
    const destination = await sql.begin("read only", readDestination)
    const fresh = classifyDestination(destination, census)
    if (!fresh.fresh) fail(EXIT.PLAN_REJECTED, `El destino no está vacío ni recién reseteado (${fresh.foreign.join(", ")}); reconstrúyelo con db:reset:local antes de restaurar.`, "destino")
    receipt = { runId, backupId: manifest.backupId, backupContentHash: manifest.contentHash, source: manifest.source, status: "running", startedAt: startedAt.toISOString(), phases: Object.fromEntries(PHASES.map((p) => [p, { status: "pending" }])) }
    save("preflight", "passed", { destinationUsers: destination.users.length, pendingAfterRestore: migrations.pending })
    const values = resolved.target.env()
    const admin = (deps.createClient ?? createClient)(values.SUPABASE_URL, values.SUPABASE_SERVICE_ROLE_KEY, clientOptions)

    save("clear", "running")
    await sql.begin(async (tx) => { await tx`drop schema if exists biblib cascade`; await tx`drop schema if exists drizzle cascade` })
    for (const user of destination.users) {
      const { error } = await admin.auth.admin.deleteUser(user.id)
      if (error) fail(EXIT.SERVICE_UNAVAILABLE, "GoTrue no eliminó una cuenta fixture del destino.", "clear")
    }
    save("clear", "passed", { removedUsers: destination.users.length })

    save("auth", "running")
    await (deps.applySql ?? applySql)(stack, db, backup.auth, "auth", options.signal)
    save("auth", "passed")
    save("domain", "running")
    await (deps.applySql ?? applySql)(stack, db, backup.domain, "domain", options.signal)
    save("domain", "passed")

    save("storage", "running")
    save("storage", "passed", await restoreStorage(admin, manifest, backup.objects, destination))

    save("rotate", "running")
    const rotation = await sql.begin(async (tx) => {
      const rotated = await rotateRestoredTokens(tx)
      const snapshots = await verifyRestoredSnapshots(tx)
      return { ...rotated, snapshots, review: [...rotated.review, ...snapshots.review] }
    })
    if (rotation.staleWriteRejected === false) fail(EXIT.VERIFICATION_FAILED, "Una escritura condicional con una versión del respaldo siguió aplicando tras la rotación.", "rotate")
    save("rotate", "passed", rotation)

    save("fixtures", "running")
    save("fixtures", "passed", await rebindFixtures(admin, sql, resolved, census, manifest.backupId))
    receipt.status = "passed"
    receipt.finishedAt = new Date().toISOString()
    receipt.durationMs = Date.parse(receipt.finishedAt) - startedAt.getTime()
    writeState(stack, receipt, "-restore")
    return { schemaVersion: 1, code: EXIT.OK, runId, backupId: manifest.backupId, profile: options.profile, project: resolved.project, head: manifest.migrations.head, pendingAfterRestore: migrations.pending, rotation, durationMs: receipt.durationMs,
      next: `pnpm db:restore:verify --backup ${options.backup} --profile ${options.profile}` }
  } catch (error) {
    if (receipt) { receipt.status = options.signal?.aborted ? "interrupted" : "failed"; save(receipt.phase, receipt.status) }
    if (options.signal?.aborted) fail(EXIT.INTERRUPTED, "Restore interrumpido; el destino queda incompleto: reconstrúyelo con db:reset:local y repite.")
    if (receipt && error instanceof BiblibError) throw new BiblibError(error.code, error.phase, `${error.message} El destino queda incompleto: reconstrúyelo con db:reset:local y repite el restore; nunca limpies el origen.`)
    throw error instanceof BiblibError ? error : connectionError(error, "restore")
  } finally {
    if (locked) await releaseMigrationLock(sql)
    await closeConnection(sql)
    release()
  }
}

export async function main(argv = process.argv.slice(2)) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.on("SIGINT", abort)
  const json = argv.includes("--json")
  try {
    const options = parseRestoreArgs(argv)
    const result = await runRestore({ ...options, signal: controller.signal })
    if (json) console.log(JSON.stringify(result))
    else {
      console.log(`Restore ${result.backupId} → ${result.profile} (${result.project}) completado en ${Math.round(result.durationMs / 1000)} s; tokens rotados: ${result.rotation.rotated.map((r) => `${r.token} (${r.rows})`).join(", ") || "ninguno"}.`)
      if (result.pendingAfterRestore.length) console.log(`Migraciones pendientes tras restaurar: ${result.pendingAfterRestore.join(", ")} (usa db:plan:local y db:migrate:local).`)
      console.log(`Siguiente paso: ${result.next}`)
    }
    return EXIT.OK
  } catch (error) {
    const code = controller.signal.aborted ? EXIT.INTERRUPTED : error instanceof BiblibError ? error.code : EXIT.SERVICE_UNAVAILABLE
    const result = { code, phase: error instanceof BiblibError ? error.phase : "restore", message: error instanceof BiblibError ? sanitize(error.message) : "No se pudo completar el restore local." }
    if (json) console.log(JSON.stringify(result))
    else console.error(`Error [${result.phase}] (${code}): ${result.message}`)
    return code
  } finally { process.removeListener("SIGINT", abort) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

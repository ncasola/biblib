import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { authExclusions, BACKUP_KIND, backupFilePath, checkBackupFiles, encrypt, ENCRYPTION, MANIFEST_FILE, newBackupId, objectFile, readKeyFile, readManifest, resolveBackupDir, resolveBackupsRoot, sealManifest, sha256 } from "../lib/backup-files.mjs"
import { bookSample, classifyCoverAssets, contentDigests, COVERS_BUCKET, coverAssetInventory, excludedCoverKeys, fixtureAccounts, objectFacts, scopeTables, stateMark, storageInventory, tokenHashes, verifyCoverObjects } from "../lib/backup-db.mjs"
import { streamCommand } from "../lib/backup-process.mjs"
import { inventory } from "../lib/docker.mjs"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { localPath, removeLocalPath } from "../lib/local-path.mjs"
import { sanitize, supabaseCommand } from "../lib/process.mjs"
import { profileWorkdir, REPO_ROOT } from "../lib/profiles.mjs"
import { acquireLock, readState } from "../lib/state.mjs"
import { compareLedger, loadJournal } from "./journal-guard.mjs"
import { acquireMigrationLock, releaseMigrationLock } from "./migrate.mjs"
import { canonical, gitCommit } from "./plan.mjs"
import { assertResetIdentity, discardedState, mailpitInventory } from "./reset-local.mjs"
import { RECEIPT_COVERAGE, RECEIPT_KIND, receiptHash } from "./remote-preflight.mjs"
import { loadCensus, resolveSeedTarget } from "./seed-local.mjs"
import { closeConnection, connect, connectionError, drizzleVersion, inspectDatabase } from "./target.mjs"

export const PROD_PENDING = "db:backup:prod está pendiente de U-INF-07 y de un destino autorizado; no se ha conectado con ninguna base remota."
export const RECEIPT_FILE = "receipt.json"
const fail = (code, message, phase = "respaldo") => { throw new BiblibError(code, phase, message) }

export function parseBackupArgs(argv) {
  const [target, ...rest] = argv
  if (target === "prod" || target === "preprod") fail(EXIT.INVALID_ARGS, PROD_PENDING, "objetivo")
  if (target !== "local") fail(EXIT.INVALID_ARGS, "Usa db:backup:local; el objetivo se fija con el nombre del comando.", "objetivo")
  const parsed = { profile: process.env.BIBLIB_PROFILE || "main", json: false }
  const values = { "--profile": "profile", "--out": "out", "--encrypt-key-file": "keyFile", "--receipt-of": "receiptOf" }
  const seen = new Set()
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (seen.has(flag)) fail(EXIT.INVALID_ARGS, "Argumento repetido.", "argumentos")
    seen.add(flag)
    if (flag === "--json") parsed.json = true
    else if (values[flag] && rest[i + 1] && !rest[i + 1].startsWith("--")) parsed[values[flag]] = rest[++i]
    else fail(EXIT.INVALID_ARGS, "Uso: db:backup:local [--profile main|test|scratch] [--out <carpeta fuera de Git>] [--encrypt-key-file <ruta>] [--json], o db:backup:local --receipt-of <carpeta del respaldo> [--json]. No se admiten URLs ni flags reenviados.", "argumentos")
  }
  if (parsed.receiptOf && (parsed.out || parsed.keyFile || seen.has("--profile"))) fail(EXIT.INVALID_ARGS, "--receipt-of solo reemite el recibo de un respaldo existente; no admite --profile, --out ni --encrypt-key-file.", "argumentos")
  if (!["main", "test", "scratch"].includes(parsed.profile)) fail(EXIT.INVALID_ARGS, "Perfil local desconocido; usa main, test o scratch.", "argumentos")
  return parsed
}

/** Contenedor Postgres registrado del perfil: `docker exec` solo por su ID acreditado. */
export function registeredDatabase(stack, state, all) {
  const db = all.containers.find((c) => c.name === `supabase_db_${stack.profile.projectId}` && state.resources.containers.some((r) => r.id === c.id))
  if (!db || db.status !== "running") fail(EXIT.SERVICE_UNAVAILABLE, "Postgres del perfil no está en marcha con su ID registrado.", "identidad")
  return db
}

// Conexión por loopback dentro del contenedor (trust local de la imagen): sin contraseña en argv ni entorno.
const PG_ARGS = ["--host", "127.0.0.1", "--username", "postgres", "--dbname", "postgres", "--no-password"]

async function dumpDomain(stack, db, snapshot, signal) {
  const result = await streamCommand("docker", ["exec", db.id, "pg_dump", ...PG_ARGS, "--schema", "biblib", "--schema", "drizzle", "--format", "plain", "--quote-all-identifiers", "--snapshot", snapshot], { ...stack.processOptions, signal, phase: "volcado" })
  if (result.code !== 0 || !result.stdout.length) fail(EXIT.SERVICE_UNAVAILABLE, "pg_dump no pudo volcar biblib/drizzle del contenedor registrado.", "volcado")
  return result.stdout
}

/**
 * Procedimiento soportado por el CLI fijado: datos de Auth sin recrear sus tablas de plataforma.
 * Sin `--network-id`: el pg_dump transitorio del CLI usa la red del host para alcanzar el puerto
 * publicado del perfil y no se conecta a la red propia (que el reset exige sin ajenos).
 */
async function dumpAuth(stack, excluded, signal) {
  const bin = supabaseCommand(stack.root)
  const args = [...bin.prefix, "db", "dump", "--local", "--data-only", "--schema", "auth", ...excluded.flatMap((t) => ["-x", t]), "--workdir", profileWorkdir(stack.profile.name, { root: stack.root })]
  const result = await streamCommand(bin.command, args, { ...stack.processOptions, signal, phase: "auth" })
  if (result.code !== 0 || !/INSERT INTO "auth"\."users"/.test(result.stdout.toString("utf8"))) fail(EXIT.SERVICE_UNAVAILABLE, "supabase db dump no devolvió los datos de Auth del perfil.", "auth")
  return result.stdout
}

async function pgDumpVersion(stack, db) {
  const result = await streamCommand("docker", ["exec", db.id, "pg_dump", "--version"], { ...stack.processOptions, timeoutMs: 20000, phase: "volcado" })
  return /\d+\.\d+/.exec(result.stdout.toString("utf8"))?.[0] ?? "desconocida"
}

async function downloadObjects(resolved, objects) {
  const values = resolved.target.env()
  if (!values.SUPABASE_SERVICE_ROLE_KEY) fail(EXIT.SERVICE_UNAVAILABLE, "Falta la credencial administrativa local del perfil; no se imprime ni se guarda.", "storage")
  const admin = createClient(values.SUPABASE_URL, values.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  const result = []
  for (const object of objects) {
    const { data, error } = await admin.storage.from(object.bucket).download(object.name)
    if (error || !data) fail(EXIT.SERVICE_UNAVAILABLE, "Storage no devolvió un objeto del inventario; el respaldo no se guarda incompleto.", "storage")
    const bytes = Buffer.from(await data.arrayBuffer())
    if (object.size !== null && bytes.length !== object.size) fail(EXIT.LOCK_BUSY, "Un objeto Storage cambió de tamaño durante la copia; repite el respaldo sin escrituras.", "storage")
    result.push({ ...object, bytes })
  }
  return result
}

/**
 * Copia RAW de cada mensaje de Mailpit (no marca leídos). El inventario debe ser el mismo que
 * entró en la huella del estado; si cambió durante el respaldo no se guarda nada.
 */
export async function downloadMail(ctx, expectedHash) {
  const mailbox = await mailpitInventory(ctx)
  if (sha256(canonical(mailbox)) !== expectedHash) fail(EXIT.LOCK_BUSY, "Mailpit cambió durante el respaldo; detén los envíos y repítelo.", "mailpit")
  const messages = []
  for (const [id] of mailbox.hashes) {
    const response = await ctx.fetch(`http://127.0.0.1:${ctx.profile.ports.mailpit}/api/v1/message/${encodeURIComponent(id)}/raw`, { signal: AbortSignal.any([AbortSignal.timeout(5000), ...(ctx.signal ? [ctx.signal] : [])]), redirect: "error" })
    if (!response.ok) fail(EXIT.SERVICE_UNAVAILABLE, "Mailpit no devolvió un mensaje del inventario; el respaldo no se guarda incompleto.", "mailpit")
    messages.push({ id, raw: Buffer.from(await response.arrayBuffer()) })
  }
  const after = await mailpitInventory(ctx)
  if (sha256(canonical(after)) !== expectedHash) fail(EXIT.LOCK_BUSY, "Mailpit cambió durante el respaldo; detén los envíos y repítelo.", "mailpit")
  return messages
}

const COVERAGE_FACTS = { rls: "tables", policies: "policies", grants: "grants", constraints: "constraints", indexes: "indexes", functions: "functions", triggers: "triggers" }

/**
 * Recibo `--backup-receipt` (U-INF-07) derivado del manifiesto sellado: destino y huella, head y
 * ledger, alcance (también Mailpit), estrategia de Auth/Storage/configuración, cobertura de
 * objetos, inventario con rutas relativas a la raíz, `discardedStateHash` del reset y ensayo de
 * restauración. Lo aceptan `db:reset:local` y la promoción; se reemite tras cada ensayo.
 */
export function buildBackupReceipt(root, dir, manifest) {
  const rehearsal = manifest.restoreVerification
  let restoreVerification = null
  if (rehearsal) {
    const report = backupFilePath(dir, rehearsal.report)
    if (!existsSync(report) || lstatSync(report).isSymbolicLink() || sha256(readFileSync(report)) !== rehearsal.reportSha256) fail(EXIT.VERIFICATION_FAILED, "El informe del ensayo de restauración falta o no coincide con su sha256.", "recibo")
    restoreVerification = { passed: rehearsal.passed === true, reportId: rehearsal.reportId, report: displayPath(root, report), reportSha256: rehearsal.reportSha256, target: rehearsal.target, recoveryMs: rehearsal.recoveryMs, at: rehearsal.at }
  }
  const scope = manifest.scope.list
  const receipt = {
    schemaVersion: 1, kind: RECEIPT_KIND, backupId: manifest.backupId, createdAt: manifest.createdAt, completedAt: manifest.completedAt,
    target: { target: manifest.source.target, profile: manifest.source.profile, project: manifest.source.project }, fingerprint: manifest.source.fingerprint,
    commit: manifest.commit?.sha ?? null,
    migrations: { head: manifest.migrations.head, applied: manifest.migrations.applied.map((m) => m.tag), ledgerHash: manifest.migrations.ledgerHash, journalHash: manifest.migrations.journalHash },
    scope: [...new Set([...scope, ...(scope.includes("data") ? ["domain"] : []), ...(scope.includes("history") ? ["ledger"] : [])])],
    strategy: {
      auth: `${manifest.scope.auth.method}: identidades; sesiones, tokens y flujos excluidos.`,
      storage: `${manifest.scope.storage.method}: bytes con sha256 e inventario de buckets.`,
      configuration: "Configuración de Auth/OAuth/SMTP/JWT y claves fuera del respaldo: se reconfigura desde el gestor de secretos del destino.",
      ...(manifest.scope.mailpit ? { mailpit: `${manifest.scope.mailpit.method}; no se reinyecta al restaurar.` } : {}),
    },
    objects: { hash: manifest.objects.hash, coverage: Object.entries(COVERAGE_FACTS).filter(([, key]) => Array.isArray(manifest.objects.facts?.[key])).map(([name]) => name) },
    files: manifest.files.map((f) => ({ path: displayPath(root, backupFilePath(dir, f.path)), role: f.role, bytes: f.bytes, sha256: f.sha256 })),
    manifest: { path: displayPath(root, path.join(dir, MANIFEST_FILE)), contentHash: manifest.contentHash },
    discardedStateHash: manifest.discardedStateHash ?? null,
    restoreVerification,
  }
  if (RECEIPT_COVERAGE.some((c) => !receipt.objects.coverage.includes(c))) fail(EXIT.VERIFICATION_FAILED, "El manifiesto no contiene todos los hechos de objetos que exige el recibo.", "recibo")
  return { ...receipt, receiptHash: receiptHash(receipt) }
}

/** (Re)emite `receipt.json` junto al manifiesto tras validar su sello y todos sus archivos. */
export function writeBackupReceipt(root, dir) {
  const manifest = readManifest(dir)
  const broken = checkBackupFiles(dir, manifest)
  if (broken.length) fail(EXIT.VERIFICATION_FAILED, `El respaldo está incompleto o alterado (${broken.map((d) => d.id).join(", ")}); no se emite recibo.`, "recibo")
  const receipt = buildBackupReceipt(root, dir, manifest)
  const file = path.join(dir, RECEIPT_FILE)
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  return { file: displayPath(root, file), receipt }
}

export function exclusionsFor(excludedAuth) {
  return [
    ...excludedAuth.map((table) => ({ item: table, reason: "Sesiones, tokens, flujos, auditoría o configuración de Auth: se invalidan o se gestionan fuera del respaldo." })),
    { item: "auth.schema_migrations, storage.migrations", reason: "Historial de la plataforma: lo crea la versión de Supabase del destino." },
    { item: "configuración de Auth, OAuth, SMTP, JWT y claves", reason: "Configuración externa y secretos; nunca forman parte del respaldo ni del repositorio." },
    { item: "Mailpit (reinyección)", reason: "Los mensajes se copian para consulta y para acreditar el estado que descarta un reset; db:restore:local no los reinyecta: es correo efímero de desarrollo." },
    { item: ".biblib/fixtures", reason: "Registro privado con contraseñas de fixtures y clave local; restore reasigna credenciales en el destino." },
    { item: "otros esquemas de plataforma (storage interno, realtime, vault, extensiones)", reason: "Los recrea la plataforma del destino." },
  ]
}

export async function runBackup({ profile, out, keyFile, root = REPO_ROOT, signal, now = () => new Date() }, deps = {}) {
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") fail(EXIT.IDENTITY_MISMATCH, "El respaldo local exige BIBLIB_TARGET=local o ausente.", "objetivo")
  const census = loadCensus(root)
  const backupsRoot = resolveBackupsRoot(root, out)
  const key = readKeyFile(root, keyFile, { backupsRoot })
  const resolved = await (deps.resolveTarget ?? resolveSeedTarget)(profile, { root })
  const { stack } = resolved
  const state = readState(stack)
  const all = await (deps.inventory ?? inventory)(stack)
  assertResetIdentity(stack, state, all, resolved.target)
  const db = registeredDatabase(stack, state, all)
  const started = now()
  const backupId = newBackupId(profile, started)
  const dir = path.join(backupsRoot, backupId)
  const release = acquireLock(stack)
  let sql, locked = false, created = false
  try {
    sql = connect(resolved, { applicationName: "biblib-backup" })
    await acquireMigrationLock(sql, { signal })
    locked = true
    const journal = loadJournal(path.join(root, "drizzle"))
    // Dominio y ledger salen del mismo snapshot que los hechos del manifiesto.
    const snapshot = await sql.begin("isolation level repeatable read read only", async (tx) => {
      const inspection = await inspectDatabase(tx, journal)
      if (inspection.code !== EXIT.OK) fail(inspection.code, "Historial u objetos divergentes; consulta db:status:local antes de respaldar.", "ledger")
      if (!inspection.ledger.rows.length) fail(EXIT.PLAN_REJECTED, "El perfil no tiene esquema migrado; no hay respaldo administrativo que hacer.", "ledger")
      const scope = await scopeTables(tx)
      const mark = await stateMark(tx, scope.tables)
      const [{ id }] = await tx`select pg_export_snapshot() as id`
      const domain = await (deps.dumpDomain ?? dumpDomain)(stack, db, id, signal)
      // Misma huella que el plan de db:reset:local: así su --backup-receipt acredita este estado.
      const discarded = await (deps.discardedState ?? discardedState)({ ...stack, fetch: deps.fetch ?? globalThis.fetch, signal }, resolved.target, { sql: tx })
      return { inspection, scope, mark, domain, discarded, digests: await contentDigests(tx, scope.tables), objects: await objectFacts(tx), tokens: await tokenHashes(tx), sample: await bookSample(tx), accounts: await fixtureAccounts(tx, census), storage: await storageInventory(tx), assets: classifyCoverAssets(await coverAssetInventory(tx)) }
    })
    const excludedAuth = authExclusions(snapshot.scope.authTables)
    const auth = await (deps.dumpAuth ?? dumpAuth)(stack, excludedAuth, signal)
    // U-DAT-10: las portadas de proveedores sin backupAsset no se copian (Google nunca).
    const excludedCovers = excludedCoverKeys(snapshot.assets)
    const objects = await (deps.downloadObjects ?? downloadObjects)(resolved, snapshot.storage.objects.filter((object) => !(object.bucket === COVERS_BUCKET && excludedCovers.has(object.name))))
    const mail = await (deps.downloadMail ?? downloadMail)({ ...stack, fetch: deps.fetch ?? globalThis.fetch, signal }, snapshot.discarded.mailpitHash)
    const after = await sql.begin("isolation level repeatable read read only", (tx) => stateMark(tx, snapshot.scope.tables))
    if (after !== snapshot.mark) fail(EXIT.LOCK_BUSY, "Hubo escrituras durante el respaldo (marca de estado distinta antes y después); detén la aplicación y repítelo. No se ha guardado nada.", "consistencia")

    mkdirSync(backupsRoot, { recursive: true })
    mkdirSync(dir)
    created = true
    mkdirSync(path.join(dir, "db"))
    if (objects.length) mkdirSync(path.join(dir, "storage"))
    if (mail.length) mkdirSync(path.join(dir, "mailpit"))
    const files = []
    const add = (role, relative, plain) => {
      const data = key ? encrypt(key.key, plain) : plain
      const file = key ? `${relative}.enc` : relative
      writeFileSync(path.join(dir, ...file.split("/")), data, { flag: "wx", mode: 0o600 })
      files.push({ path: file, role, bytes: data.length, sha256: sha256(data), plainSha256: sha256(plain), encrypted: Boolean(key) })
    }
    add("domain-dump", "db/biblib-drizzle.sql", snapshot.domain)
    add("auth-data", "db/auth-data.sql", auth)
    const storageObjects = objects.map(({ bytes, ...object }) => {
      const file = objectFile(object.bucket, object.name)
      add("storage-object", file, bytes)
      return { ...object, size: bytes.length, sha256: sha256(bytes), file: files.at(-1).path }
    })
    const coverProblems = verifyCoverObjects(snapshot.assets, storageObjects)
    if (coverProblems.length) fail(EXIT.VERIFICATION_FAILED, `Las portadas privadas no coinciden con su registro (${coverProblems.length}: ${coverProblems[0]}); el respaldo no se guarda.`, "storage")
    for (const message of mail) add("mailpit-message", `mailpit/${sha256(message.id).slice(0, 40)}.eml`, message.raw)
    const { inspection } = snapshot
    const applied = compareLedger(journal.entries, inspection.ledger.rows).migrations.filter((m) => m.status === "applied").map((m) => ({ tag: m.tag, hash: m.hash, created_at: m.when }))
    const completed = now()
    const manifest = sealManifest({
      schemaVersion: 1, kind: BACKUP_KIND, backupId, createdAt: started.toISOString(), completedAt: completed.toISOString(), durationMs: completed - started,
      source: { target: "local", profile, project: resolved.project, fingerprint: resolved.fingerprint, rootHash: stack.identity.hash, postgres: { host: "127.0.0.1", port: stack.profile.ports.db, database: "postgres" } },
      commit: (deps.gitCommit ?? gitCommit)(root),
      tools: { supabaseCli: JSON.parse(readFileSync(path.join(root, "node_modules/supabase/package.json"), "utf8")).version, pgDump: await (deps.pgDumpVersion ?? pgDumpVersion)(stack, db), drizzleOrm: drizzleVersion(root) },
      migrations: { head: inspection.appliedHead?.tag ?? null, state: inspection.state, applied, journalHash: sha256(canonical(journal.entries.map(({ tag, when, hash }) => ({ tag, when, hash })))), ledgerHash: sha256(canonical(inspection.ledger.rows)) },
      scope: {
        list: ["schema", "data", "history", "auth", "storage", "mailpit"],
        schema: ["biblib", "drizzle"], data: ["biblib", "drizzle"], history: "drizzle.__drizzle_migrations",
        auth: { method: "supabase db dump --local --data-only --schema auth", tables: snapshot.scope.tables.filter((t) => t.schema === "auth").map((t) => `auth.${t.table}`) },
        storage: { method: "API Storage del perfil (clave local service_role, solo en memoria)", buckets: snapshot.storage.buckets.length, objects: storageObjects.length },
        mailpit: { method: "API de Mailpit del perfil (mensajes RAW, sin marcarlos como leídos)", messages: mail.length, restored: false },
      },
      discardedStateHash: snapshot.discarded.hash,
      exclusions: [...exclusionsFor(excludedAuth), ...(snapshot.assets ? [{ item: `${COVERS_BUCKET}: copias de proveedores sin backupAsset`, reason: `Su política de derechos no permite respaldarlas (Google nunca); al restaurar, la ficha vuelve a su URL original. Excluidas: ${snapshot.assets.excluded.length}.` }] : [])],
      consistency: { method: "pg_dump con snapshot exportado para dominio/ledger; marca de estado igual antes y después de Auth y Storage", mark: snapshot.mark },
      counts: Object.fromEntries(snapshot.digests.map((d) => [`${d.schema}.${d.table}`, d.count])),
      digests: snapshot.digests, objects: snapshot.objects, tokens: snapshot.tokens, sample: snapshot.sample, fixtureAccounts: snapshot.accounts,
      storage: { buckets: snapshot.storage.buckets, objects: storageObjects },
      // Manifiesto de portadas privadas (desde 0009): asset, clave, sha256 y tamaño, separado de los bytes.
      ...(snapshot.assets ? { assets: snapshot.assets } : {}),
      files,
      encryption: key ? { algorithm: ENCRYPTION.algorithm, keyFingerprint: key.fingerprint, key: "externa: no se guarda con el respaldo" } : null,
      restoreVerification: null,
    })
    writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    const receipt = writeBackupReceipt(root, dir)
    return { schemaVersion: 1, code: EXIT.OK, backupId, dir: displayPath(root, dir), receipt: receipt.file, discardedStateHash: manifest.discardedStateHash, profile, project: resolved.project, head: manifest.migrations.head, counts: manifest.counts, storageObjects: storageObjects.length, files: files.length, encrypted: Boolean(key), durationMs: manifest.durationMs, contentHash: manifest.contentHash }
  } catch (error) {
    if (created) discardPartial(root, dir)
    if (signal?.aborted) fail(EXIT.INTERRUPTED, "Respaldo interrumpido; no se ha guardado nada.")
    throw error instanceof BiblibError ? error : connectionError(error, "respaldo")
  } finally {
    if (locked) await releaseMigrationLock(sql)
    await closeConnection(sql)
    release()
  }
}

export function displayPath(root, file) {
  const relative = path.relative(root, file)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : file
}

/** Solo elimina la carpeta que este mismo intento creó. */
function discardPartial(root, dir) {
  try { localPath(root, dir); removeLocalPath(root, dir) } catch { rmSync(dir, { recursive: true, force: true }) }
}

export async function main(argv = process.argv.slice(2)) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.on("SIGINT", abort)
  const json = argv.includes("--json")
  try {
    const options = parseBackupArgs(argv)
    if (options.receiptOf) {
      const { file, receipt } = writeBackupReceipt(REPO_ROOT, resolveBackupDir(REPO_ROOT, options.receiptOf))
      const summary = { schemaVersion: 1, code: EXIT.OK, backupId: receipt.backupId, receipt: file, receiptHash: receipt.receiptHash, restoreVerification: receipt.restoreVerification?.passed ?? false }
      if (json) console.log(JSON.stringify(summary))
      else console.log(`Recibo ${file} · respaldo ${receipt.backupId} · ensayo de restauración ${summary.restoreVerification ? "superado" : "pendiente"}`)
      return EXIT.OK
    }
    const result = await runBackup({ ...options, signal: controller.signal })
    if (json) console.log(JSON.stringify(result))
    else console.log(`Respaldo ${result.backupId} · ${result.profile} (${result.project}) · head ${result.head} · ${result.files} archivos${result.encrypted ? " cifrados" : ""} · ${result.dir} · recibo ${result.receipt} (ensayo pendiente: tras db:restore:verify, reemítelo con --receipt-of)`)
    return EXIT.OK
  } catch (error) {
    const code = controller.signal.aborted ? EXIT.INTERRUPTED : error instanceof BiblibError ? error.code : EXIT.SERVICE_UNAVAILABLE
    const result = { code, phase: error instanceof BiblibError ? error.phase : "respaldo", message: error instanceof BiblibError ? sanitize(error.message) : "No se pudo completar el respaldo local." }
    if (json) console.log(JSON.stringify(result))
    else console.error(`Error [${result.phase}] (${code}): ${result.message}`)
    return code
  } finally { process.removeListener("SIGINT", abort) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

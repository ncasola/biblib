import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { signInFixture } from "../../tests/integration/support/session.mjs"
import { checkBackupFiles, MANIFEST_FILE, readManifest, resolveBackupDir, sha256 } from "../lib/backup-files.mjs"
import { bookSample, CONTENT_SCHEMAS, contentDigests, objectFacts, tokenHashes } from "../lib/backup-db.mjs"
import { inventory } from "../lib/docker.mjs"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { sanitize } from "../lib/process.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"
import { readState } from "../lib/state.mjs"
import { displayPath } from "./backup-local.mjs"
import { loadJournal } from "./journal-guard.mjs"
import { canonical } from "./plan.mjs"
import { assertResetIdentity } from "./reset-local.mjs"
import { loadCensus, resolveSeedTarget } from "./seed-local.mjs"
import { closeConnection, connect, connectionError, inspectDatabase } from "./target.mjs"

const fail = (code, message, phase = "verify") => { throw new BiblibError(code, phase, message) }
const ROLLBACK = Symbol("rollback")

export function parseVerifyArgs(argv) {
  const parsed = { json: false }
  const values = { "--backup": "backup", "--profile": "profile" }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (seen.has(flag)) fail(EXIT.INVALID_ARGS, "Argumento repetido.", "argumentos")
    seen.add(flag)
    if (flag === "--json") parsed.json = true
    else if (values[flag] && argv[i + 1] && !argv[i + 1].startsWith("--")) parsed[values[flag]] = argv[++i]
    else fail(EXIT.INVALID_ARGS, "Uso: db:restore:verify --backup <carpeta> --profile main|test|scratch [--json].", "argumentos")
  }
  if (!parsed.backup || !["main", "test", "scratch"].includes(parsed.profile)) fail(EXIT.INVALID_ARGS, "Uso: db:restore:verify --backup <carpeta> --profile main|test|scratch [--json].", "argumentos")
  return parsed
}

/** Compara el estado restaurado con el recibo. Pura: cada diferencia es una discrepancia. */
export function compareRestored(manifest, current) {
  const checks = []
  const check = (id, ok, message, failure) => checks.push({ id, status: ok ? "ok" : "fail", message: ok ? message : failure })

  const applied = current.ledger.map((r) => ({ hash: r.hash, created_at: r.created_at }))
  check("ledger.history", canonical(applied) === canonical(manifest.migrations.applied.map(({ hash, created_at }) => ({ hash, created_at }))), `Ledger con ${applied.length} migración(es) idénticas al respaldo (head ${manifest.migrations.head}).`, "El ledger restaurado no coincide con el historial del respaldo.")
  check("manifest.objects", current.inspection.code === EXIT.OK && current.inspection.manifest.length > 0 && current.inspection.manifest.every((c) => c.status === "ok"), `Manifest U-INF-04: ${current.inspection.manifest.length} comprobaciones de RLS, políticas, grants, FK, índices, columnas, función y trigger conformes.`, `Manifest de objetos con drift o incompleto (${current.inspection.manifest.filter((c) => c.status !== "ok").map((c) => c.id).join(", ") || current.inspection.state}).`)
  const facts = Object.keys(manifest.objects.facts).filter((k) => canonical(manifest.objects.facts[k]) !== canonical(current.objects.facts[k]))
  check("objects.facts", current.objects.hash === manifest.objects.hash, "Hechos de catálogo (tablas, RLS, políticas, grants, constraints, índices, columnas, función, trigger) idénticos al origen.", `Hechos de catálogo distintos del origen en: ${facts.join(", ")}.`)

  for (const expected of manifest.digests) {
    const id = `${expected.schema}.${expected.table}`
    const found = current.digests.find((d) => d.schema === expected.schema && d.table === expected.table)
    const content = CONTENT_SCHEMAS.includes(expected.schema)
    const ok = found && found.count === expected.count && found.keys === expected.keys && (!content || found.content === expected.content)
    check(`table.${id}`, ok, `${id}: ${expected.count} fila(s)${content ? ", claves y contenido" : " y claves"} iguales al recibo.`, found ? `${id}: ${found.count}/${expected.count} filas o claves/contenido distintos.` : `${id}: falta la tabla.`)
  }

  for (const [token, hashes] of Object.entries(manifest.tokens)) {
    const restored = current.tokens[token] ?? []
    const reused = restored.filter((h) => hashes.includes(h)).length
    check(`tokens.${token}`, restored.length === hashes.length && reused === 0, `${token}: ${restored.length} token(s) rotados; ninguno coincide con el respaldo.`, `${token}: ${reused} token(s) del respaldo siguen vigentes o la cantidad difiere.`)
  }

  const missing = manifest.sample.filter((s) => !current.sample.some((c) => c.id === s.id && c.digest === s.digest))
  check("sample.books", missing.length === 0, `Muestra de ${manifest.sample.length} ficha(s) idéntica salvo el token rotado.`, `${missing.length} ficha(s) de la muestra faltan o difieren.`)
  return checks
}

async function asUser(sql, userId, body) {
  let result
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`
      await tx.unsafe("set local role authenticated")
      result = await body(tx)
      throw ROLLBACK
    })
  } catch (error) { if (error !== ROLLBACK) throw error }
  return result
}

/** Sesiones GoTrue reales de A/B y RLS con sus claims: cada cuenta solo ve y modifica lo suyo. */
async function verifyAccounts(sql, manifest, census, profile, root) {
  const checks = []
  const ids = Object.fromEntries(Object.entries(manifest.fixtureAccounts).map(([k, v]) => [k, v.id]))
  for (const account of census.accounts) {
    const expected = manifest.fixtureAccounts[account.key]
    if (!expected) continue
    const other = ids[account.key === "a" ? "b" : "a"]
    let fixture
    try {
      fixture = await signInFixture(account.key, { profile, root })
      const user = await fixture.client.auth.getUser()
      const id = user.data.user?.id
      const seen = await asUser(sql, id, async (tx) => ({
        books: await tx`select user_id::text as user_id from biblib.books`,
        shelves: await tx`select user_id::text as user_id from biblib.shelves`,
        foreignUpdate: other ? (await tx`update biblib.books set title = title where user_id = ${other}`).count : 0,
      }))
      const ok = !user.error && id === expected.id && seen.books.length === expected.books && seen.shelves.length === expected.shelves && seen.books.every((b) => b.user_id === id) && seen.shelves.every((s) => s.user_id === id) && seen.foreignUpdate === 0
      checks.push({ id: `access.${account.key}`, status: ok ? "ok" : "fail", message: ok ? `Cuenta ${account.key.toUpperCase()}: sesión GoTrue real con el ID restaurado; ve ${expected.books} libro(s) y ${expected.shelves} estantería(s) propias y 0 ajenas; actualizar las ajenas afecta 0 filas.` : `Cuenta ${account.key.toUpperCase()}: identidad, visibilidad o aislamiento distintos del respaldo.` })
    } catch (error) {
      checks.push({ id: `access.${account.key}`, status: "fail", message: `Cuenta ${account.key.toUpperCase()}: no se pudo abrir una sesión GoTrue real (${error instanceof BiblibError ? error.message : "error de sesión"}).` })
    } finally { await fixture?.client.auth.signOut({ scope: "local" }).catch(() => {}) }
  }
  if (!checks.length) checks.push({ id: "access.fixtures", status: "fail", message: "El respaldo no contiene cuentas A/B del censo: no se puede acreditar el acceso." })
  return checks
}

async function verifyStorage(resolved, manifest) {
  const values = resolved.target.env()
  const admin = createClient(values.SUPABASE_URL, values.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  const checks = []
  for (const bucket of manifest.storage.buckets) {
    const { data, error } = await admin.storage.getBucket(bucket.id)
    const ok = !error && data && data.public === bucket.public && canonical(data.allowed_mime_types ?? null) === canonical(bucket.allowedMimeTypes)
    checks.push({ id: `storage.bucket.${bucket.id}`, status: ok ? "ok" : "fail", message: ok ? `Bucket ${bucket.id} ${bucket.public ? "público" : "privado"} con su configuración.` : `Bucket ${bucket.id} ausente o con otra visibilidad/configuración.` })
  }
  let present = 0
  for (const object of manifest.storage.objects) {
    const { data, error } = await admin.storage.from(object.bucket).download(object.name)
    const hash = !error && data ? sha256(Buffer.from(await data.arrayBuffer())) : null
    if (hash === object.sha256) present++
    else checks.push({ id: "storage.object", status: "fail", message: hash ? `Objeto ${object.bucket}/${object.file} con sha256 distinto.` : `Falta el objeto ${object.bucket}/${object.file} en el destino.` })
  }
  checks.push({ id: "storage.objects", status: present === manifest.storage.objects.length ? "ok" : "fail", message: `${present}/${manifest.storage.objects.length} objeto(s) presentes con su sha256.` })
  return checks
}

export async function runVerify(options, deps = {}) {
  const root = deps.root ?? REPO_ROOT
  const started = new Date()
  const dir = resolveBackupDir(root, options.backup)
  const manifest = readManifest(dir)
  const checks = checkBackupFiles(dir, manifest).map((d) => ({ id: d.id, status: "fail", message: d.message }))
  if (!checks.length) checks.push({ id: "backup.files", status: "ok", message: `${manifest.files.length} archivo(s) del respaldo presentes con su sha256.` })
  const census = loadCensus(root)
  const resolved = await (deps.resolveTarget ?? resolveSeedTarget)(options.profile, { root })
  const { stack } = resolved
  assertResetIdentity(stack, readState(stack), await (deps.inventory ?? inventory)(stack), resolved.target)
  const restore = readState(stack, "-restore")
  checks.push({ id: "restore.receipt", status: restore?.backupId === manifest.backupId && restore.status === "passed" ? "ok" : "fail", message: restore?.backupId === manifest.backupId && restore.status === "passed" ? `Restore ${restore.runId} de este respaldo completado (${restore.phases.rotate.rotated?.length ?? 0} token(s) rotados, escritura antigua rechazada: ${restore.phases.rotate.staleWriteRejected !== false ? "sí" : "no"}).` : "No hay un restore completado de este respaldo en el perfil." })
  const sql = connect(resolved, { applicationName: "biblib-restore-verify" })
  try {
    const journal = loadJournal(path.join(root, "drizzle"))
    const current = await sql.begin("isolation level repeatable read read only", async (tx) => {
      const inspection = await inspectDatabase(tx, journal)
      const tables = manifest.digests.map(({ schema, table }) => ({ schema, table }))
      const present = await tx`select schemaname as schema, tablename as table from pg_tables where schemaname in ('biblib', 'drizzle', 'auth', 'storage')`
      return {
        inspection, ledger: inspection.ledger.rows,
        objects: await objectFacts(tx),
        digests: await contentDigests(tx, tables.filter((t) => present.some((p) => p.schema === t.schema && p.table === t.table))),
        tokens: await tokenHashes(tx), sample: await bookSample(tx, Math.max(manifest.sample.length, 5)),
      }
    })
    checks.push(...compareRestored(manifest, current))
    checks.push(...await verifyAccounts(sql, manifest, census, options.profile, root))
    checks.push(...await verifyStorage(resolved, manifest))
  } catch (error) {
    throw error instanceof BiblibError ? error : connectionError(error, "verify")
  } finally { await closeConnection(sql) }

  const finished = new Date()
  const discrepancies = checks.filter((c) => c.status !== "ok")
  const restoreStart = restore?.backupId === manifest.backupId ? Date.parse(restore.startedAt) : null
  const report = {
    schemaVersion: 1, kind: "biblib-restore-report", reportId: randomUUID(), backupId: manifest.backupId, backupContentHash: manifest.contentHash,
    target: { target: "local", profile: options.profile, project: resolved.project, fingerprint: resolved.fingerprint },
    restoreRunId: restore?.runId ?? null, passed: discrepancies.length === 0,
    durations: { restoreMs: restore?.durationMs ?? null, verifyMs: finished - started, recoveryMs: restoreStart ? finished.getTime() - restoreStart : null },
    lostWindow: { backupCreatedAt: manifest.createdAt, note: "Las escrituras posteriores a esta fecha en el origen no están en el respaldo y deben recuperarse o darse por perdidas antes de abrir tráfico." },
    pendingMigrations: pendingAfter(manifest, root),
    checks, discrepancies, startedAt: started.toISOString(), finishedAt: finished.toISOString(),
  }
  const reports = path.join(dir, "rehearsals")
  mkdirSync(reports, { recursive: true })
  const file = path.join(reports, `${finished.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}-${options.profile}.json`)
  const body = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(file, body, { flag: "wx", mode: 0o600 })
  writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify(recordRehearsal(manifest, report, path.relative(dir, file).split(path.sep).join("/"), sha256(body)), null, 2)}\n`, { mode: 0o600 })
  return { code: report.passed ? EXIT.OK : EXIT.VERIFICATION_FAILED, report, file: displayPath(root, file) }
}

/**
 * Referencia del ensayo en el recibo, sin alterar su huella de contenido. `restoreVerification`
 * conserva el último ensayo superado; un fallo del propio respaldo (archivo ausente o alterado)
 * lo invalida. Un fallo solo del destino queda en `lastRehearsal` sin desacreditar la copia.
 */
export function recordRehearsal(manifest, report, reportPath, reportSha256) {
  const reference = { passed: report.passed, reportId: report.reportId, report: reportPath, reportSha256, target: report.target, recoveryMs: report.durations.recoveryMs, at: report.finishedAt }
  const backupBroken = report.discrepancies.some((d) => d.id.startsWith("backup."))
  return { ...manifest, lastRehearsal: reference, restoreVerification: report.passed || backupBroken || !manifest.restoreVerification?.passed ? reference : manifest.restoreVerification }
}

function pendingAfter(manifest, root) {
  return loadJournal(path.join(root, "drizzle")).entries.slice(manifest.migrations.applied.length).map((e) => e.tag)
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json")
  try {
    const options = parseVerifyArgs(argv)
    const { code, report, file } = await runVerify(options)
    if (json) console.log(JSON.stringify({ code, file, ...report }))
    else {
      for (const check of report.checks) console.log(`[${check.status}] ${check.id}: ${check.message}`)
      console.log(`${report.passed ? "Ensayo de recuperación superado" : `Ensayo de recuperación FALLIDO (${report.discrepancies.length} discrepancia(s))`} · recuperación ${report.durations.recoveryMs === null ? "sin restore registrado" : `${Math.round(report.durations.recoveryMs / 1000)} s`} · informe ${file}`)
    }
    return code
  } catch (error) {
    const code = error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
    const result = { code, phase: error instanceof BiblibError ? error.phase : "verify", message: error instanceof BiblibError ? sanitize(error.message) : "No se pudo completar la verificación del restore." }
    if (json) console.log(JSON.stringify(result))
    else console.error(`Error [${result.phase}] (${code}): ${result.message}`)
    return code
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

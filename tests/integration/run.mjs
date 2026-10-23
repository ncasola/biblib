import { execFileSync, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { createConnection } from "node:net"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { BiblibError, EXIT } from "../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../scripts/lib/profiles.mjs"
import { acquireLock } from "../../scripts/lib/state.mjs"
import { loadJournal } from "../../scripts/db/journal-guard.mjs"
import { inspectDatabase } from "../../scripts/db/target.mjs"
import { adminClient, closeConnection, database, integrationContext, PROFILE } from "./lib/context.mjs"
import { cleanupManifest, isEmpty, manifestFile, readManifest, startManifest, writeManifest } from "./lib/run-manifest.mjs"

// pnpm test:integration:local — U-QA-01. Ejecuta tests/integration/{auth,rls,storage,import,catalogue} contra el
// stack Supabase real del perfil test y la app compilada para ese perfil (127.0.0.1:3148).

const SUITES = ["rls", "storage", "import", "auth", "catalogue"]
const LOG_DIR = path.join(REPO_ROOT, ".biblib", "integration")
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }

export function parseArgs(argv) {
  const parsed = { profile: PROFILE, reuseBuild: false }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (seen.has(flag)) fail(EXIT.INVALID_ARGS, "argumentos", "Argumento repetido.")
    seen.add(flag)
    if (flag === "--profile" && argv[i + 1] === PROFILE) i++
    else if (flag === "--reuse-build") parsed.reuseBuild = true
    else fail(EXIT.INVALID_ARGS, "argumentos", "Uso: test:integration:local [--profile test] [--reuse-build]. Solo se admite el perfil test.")
  }
  return parsed
}

/** Lotes de archivos de prueba; la caída simulada de servicios va sola y al final. */
export function suiteBatches(root = REPO_ROOT) {
  const files = SUITES.flatMap((suite) => {
    const dir = path.join(root, "tests", "integration", suite)
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => path.join("tests", "integration", suite, f)) : []
  })
  return [files.filter((f) => !f.includes("caida")), files.filter((f) => f.includes("caida"))].filter((batch) => batch.length)
}

/** Enmascara JWT, valores de cookie SSR y secretos conocidos antes de escribir en consola. */
export function redactor(secrets = []) {
  const known = secrets.filter((s) => typeof s === "string" && s.length >= 8)
  return (text) => {
    let out = text
    for (const secret of known) out = out.split(secret).join("[oculto]")
    return out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt oculto]")
      .replace(/base64-[A-Za-z0-9_-]{16,}/g, "[cookie oculta]")
      .replace(/(refresh_token|access_token|password)("?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1$2[oculto]")
  }
}

function pipeRedacted(stream, target, redact) {
  let pending = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk) => {
    pending += chunk
    const lines = pending.split("\n")
    pending = lines.pop()
    for (const line of lines) target.write(`${redact(line)}\n`)
  })
  stream.on("end", () => { if (pending) target.write(redact(pending)) })
}

function run(command, args, { env, logFile, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    const log = logFile ? createWriteStream(logFile) : null
    for (const stream of [child.stdout, child.stderr]) {
      if (log) stream.pipe(log, { end: false })
      if (onOutput) onOutput(stream)
    }
    child.once("error", () => reject(new BiblibError(EXIT.MISSING_REQUIREMENT, "proceso", `No se pudo ejecutar ${path.basename(command)}.`)))
    child.once("close", (code) => { log?.end(); resolve(code ?? EXIT.INTERRUPTED) })
  })
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    socket.setTimeout(1000)
    socket.once("connect", () => { socket.destroy(); resolve(true) })
    socket.once("timeout", () => { socket.destroy(); resolve(false) })
    socket.once("error", () => resolve(false))
  })
}

/** Termina solo el árbol del proceso que arrancó este runner. */
function stopTree(child) {
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    else process.kill(-child.pid, "SIGTERM")
  } catch { /* Ya había terminado. */ }
}

async function startApp(ctx, env) {
  if (await portInUse(Number(new URL(ctx.appUrl).port))) fail(EXIT.SERVICE_UNAVAILABLE, "app", `El puerto de la app del perfil test (${ctx.appUrl}) está ocupado; no se termina al ocupante. Libéralo y repite.`)
  const child = spawn(process.execPath, ["scripts/next-target.mjs", "start", "local", "--profile", PROFILE], {
    cwd: REPO_ROOT, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  })
  const log = createWriteStream(path.join(LOG_DIR, "app.log"))
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(child.exitCode === EXIT.IDENTITY_MISMATCH ? EXIT.IDENTITY_MISMATCH : EXIT.SERVICE_UNAVAILABLE, "app", "La app no arrancó con el build del perfil test; revisa .biblib/integration/app.log.")
    try {
      const response = await fetch(`${ctx.appUrl}/login`, { redirect: "manual", signal: AbortSignal.timeout(2000) })
      if (response.status === 200) return child
    } catch { /* Todavía arrancando. */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  stopTree(child)
  fail(EXIT.SERVICE_UNAVAILABLE, "app", "La app del perfil test no respondió en 60 s.")
}

async function listUsers(admin) {
  const users = []
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) fail(EXIT.SERVICE_UNAVAILABLE, "usuarios", "GoTrue no permitió listar las cuentas locales.")
    users.push(...data.users.map((u) => ({ id: u.id, email: u.email })))
    if (data.users.length < 1000) break
  }
  return users.sort((x, y) => x.id.localeCompare(y.id))
}

/** Limpia lo registrado; si algo queda, el manifiesto conserva solo lo pendiente y se sale con 10. */
async function cleanRun(file, sql, admin) {
  const manifest = readManifest(file)
  const pending = await cleanupManifest({ sql, admin, manifest })
  if (isEmpty({ created: pending })) { rmSync(file, { force: true }); return }
  writeManifest(file, { ...manifest, created: pending })
  fail(EXIT.SEED_FAILED, "limpieza", `No se pudieron limpiar ${Object.values(pending).flat().length} recurso(s) del run ${manifest.runId}; se conservan en ${path.relative(REPO_ROOT, file)} (sin sesiones).`)
}

function childEnvironment(runId) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|DATABASE_URL$|PG|POSTGRES_|BIBLIB_)/i.test(key)))
  return { ...base, BIBLIB_TARGET: "local", BIBLIB_PROFILE: PROFILE, BIBLIB_INTEGRATION_RUN_ID: runId, NODE_ENV: "test" }
}

export async function runIntegration(argv = process.argv.slice(2), out = process.stdout) {
  const options = parseArgs(argv)
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") fail(EXIT.IDENTITY_MISMATCH, "objetivo", "La integración local solo admite BIBLIB_TARGET=local (perfil test).")
  const runId = randomBytes(6).toString("hex")
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
  const ctx = await integrationContext()
  const release = acquireLock(ctx.resolved.stack)
  const sql = database(ctx, "biblib-integration-runner")
  const admin = adminClient(ctx)
  const redact = redactor([ctx.env.SUPABASE_SERVICE_ROLE_KEY, ctx.env.SUPABASE_ANON_KEY, ctx.store.accounts.a.password, ctx.store.accounts.b.password, ctx.store.serviceRoleKey])
  const file = manifestFile(PROFILE, ctx.root)
  let app, interrupted = false
  const onInterrupt = () => { interrupted = true; stopTree(app) }
  process.once("SIGINT", onInterrupt)
  const shortFingerprint = ctx.resolved.fingerprint.slice(0, 12)
  try {
    out.write(`Integración Supabase real · perfil ${PROFILE} · ${ctx.projectId} · huella ${shortFingerprint} · run ${runId}\n`)
    const inspection = await sql.begin("read only", (tx) => inspectDatabase(tx, loadJournal()))
    if (inspection.code !== EXIT.OK) fail(inspection.code, "ledger", "Historial u objetos divergentes en el perfil test; consulta pnpm db:status:local --profile test.")
    if (inspection.state !== "up-to-date") fail(EXIT.PLAN_REJECTED, "ledger", "Hay migraciones pendientes en el perfil test: ejecuta db:plan:local y db:migrate:local con --profile test.")

    const previous = readManifest(file)
    if (previous) {
      await cleanRun(file, sql, admin)
      if (!isEmpty(previous)) out.write(`Restos registrados del run anterior ${previous.runId} limpiados.\n`)
    }
    const usersBefore = await listUsers(admin)

    const env = childEnvironment(runId)
    if (!options.reuseBuild) {
      out.write("Compilando la app para el perfil test…\n")
      const code = await run(process.execPath, ["scripts/next-target.mjs", "build", "local", "--profile", PROFILE], { env, logFile: path.join(LOG_DIR, "build.log") })
      if (code !== 0) fail(code === EXIT.IDENTITY_MISMATCH ? code : EXIT.VERIFICATION_FAILED, "build", "Falló el build del perfil test; revisa .biblib/integration/build.log.")
    }
    const bundle = await run(process.execPath, ["scripts/check-client-bundle.mjs", "--dist-dir", ".next-local"], { env })
    if (bundle !== 0) fail(EXIT.VERIFICATION_FAILED, "bundle", "El bundle de cliente contiene material privado o no existe; no se ejecuta la suite.")
    out.write("Bundle de cliente sin credenciales administrativas ni URLs privadas.\n")

    app = await startApp(ctx, env)
    startManifest(file, { runId, fingerprint: ctx.resolved.fingerprint })
    const counts = { pass: 0, fail: 0 }
    let testCode = 0
    // node --test ordena los archivos: cada lote se lanza aparte para que la caída vaya al final.
    for (const files of suiteBatches()) {
      if (interrupted) break
      const code = await run(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", ...files], {
        env,
        onOutput: (stream) => {
          pipeRedacted(stream, out, (line) => {
            const count = /^ℹ (pass|fail) (\d+)/.exec(line)
            if (count) counts[count[1]] += Number(count[2])
            return redact(line)
          })
        },
      })
      testCode ||= code
    }
    if (interrupted) fail(EXIT.INTERRUPTED, "pruebas", "Suite interrumpida; el manifiesto de restos se conserva para el siguiente intento.")

    const usersAfter = await listUsers(admin)
    const sameUsers = JSON.stringify(usersBefore) === JSON.stringify(usersAfter)
    const fixtureOnly = usersAfter.every((u) => u.email?.endsWith("@biblib.test"))

    await cleanRun(file, sql, admin)

    if (!sameUsers || !fixtureOnly) fail(EXIT.VERIFICATION_FAILED, "usuarios", "La suite cambió las cuentas de Auth o existen cuentas fuera de @biblib.test.")
    out.write(`Cuentas de Auth sin cambios (${usersAfter.length}, todas @biblib.test). Limpieza del run completa.\n`)
    if (testCode !== 0 || counts.fail > 0) fail(EXIT.VERIFICATION_FAILED, "pruebas", `Fallaron ${counts.fail || "algunos"} escenario(s); revisa los nombres marcados arriba.`)
    out.write(`Resultado: ${counts.pass} escenarios superados, 0 fallidos.\n`)
    return EXIT.OK
  } finally {
    process.removeListener("SIGINT", onInterrupt)
    stopTree(app)
    await closeConnection(sql)
    release()
  }
}

export async function main(argv = process.argv.slice(2)) {
  try { return await runIntegration(argv) } catch (error) {
    const code = error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
    const phase = error instanceof BiblibError ? error.phase : "suite"
    console.error(`Error [${phase}] (${code}): ${error instanceof BiblibError ? error.message : "Fallo inesperado de la suite de integración."}`)
    return code
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

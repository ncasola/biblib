import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createWriteStream, mkdirSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { BiblibError, EXIT } from "../../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../../scripts/lib/profiles.mjs"
import { acquireLock } from "../../../scripts/lib/state.mjs"
import { loadJournal } from "../../../scripts/db/journal-guard.mjs"
import { loadCensus, resolveSeedTarget } from "../../../scripts/db/seed-local.mjs"
import { readFixtureStore } from "../../../scripts/db/fixture-store.mjs"
import { closeConnection, connect, inspectDatabase } from "../../../scripts/db/target.mjs"
import { createClient } from "@supabase/supabase-js"
import { listUsers, pipeRedacted, portInUse, redactor, run, stopTree } from "../lib/process.mjs"
import { PROFILES } from "./lib/context.mjs"

// pnpm test:integration:account [--profile scratch|test] [--reuse-build] — U-OPS-03. Ejecuta el grupo
// tests/integration/account (eliminación de cuenta y retención) contra Postgres, GoTrue, Storage y la app compilada del
// perfil, con cuentas desechables y el worker administrativo real. Al terminar, las cuentas de Auth son las mismas que
// al empezar. En el perfil test también corre en pnpm test:integration:local.

const LOG_DIR = path.join(REPO_ROOT, ".biblib", "integration")
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }

export function parseArgs(argv) {
  const parsed = { profile: "test", reuseBuild: false }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (seen.has(flag)) fail(EXIT.INVALID_ARGS, "argumentos", "Argumento repetido.")
    seen.add(flag)
    if (flag === "--profile" && PROFILES.includes(argv[i + 1])) parsed.profile = argv[++i]
    else if (flag === "--reuse-build") parsed.reuseBuild = true
    else fail(EXIT.INVALID_ARGS, "argumentos", "Uso: test:integration:account [--profile scratch|test] [--reuse-build].")
  }
  return parsed
}

function childEnvironment(profile, runId) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|DATABASE_URL$|PG|POSTGRES_|BIBLIB_)/i.test(key)))
  return { ...base, BIBLIB_TARGET: "local", BIBLIB_PROFILE: profile, BIBLIB_ACCOUNT_RUN_ID: runId, NODE_ENV: "test" }
}

/** Arranca la app compilada del perfil; si su puerto está ocupado, sale con 8 sin tocar al ocupante. */
async function startApp(resolved, profile, env, logFile) {
  const { host, port } = resolved.stack.profile.app
  if (await portInUse(port)) fail(EXIT.SERVICE_UNAVAILABLE, "app", `El puerto de la app (${host}:${port}) está ocupado; no se termina al ocupante.`)
  const child = spawn(process.execPath, ["scripts/next-target.mjs", "start", "local", "--profile", profile], {
    cwd: REPO_ROOT, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  })
  const log = createWriteStream(logFile)
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(EXIT.SERVICE_UNAVAILABLE, "app", "La app no arrancó; revisa .biblib/integration/account-app.log.")
    try { if ((await fetch(`http://${host}:${port}/login`, { redirect: "manual", signal: AbortSignal.timeout(2000) })).status === 200) return child } catch { /* Arrancando. */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  stopTree(child)
  fail(EXIT.SERVICE_UNAVAILABLE, "app", "La app no respondió en 60 s.")
}

export async function main(argv = process.argv.slice(2), out = process.stdout) {
  let app, release, sql
  try {
    const { profile, reuseBuild } = parseArgs(argv)
    if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") fail(EXIT.IDENTITY_MISMATCH, "objetivo", "El grupo account solo admite BIBLIB_TARGET=local.")
    const runId = randomBytes(6).toString("hex")
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
    const resolved = await resolveSeedTarget(profile)
    release = acquireLock(resolved.stack)
    sql = connect(resolved, { applicationName: "biblib-account-runner" })
    const inspection = await sql.begin("read only", (tx) => inspectDatabase(tx, loadJournal()))
    if (inspection.code !== EXIT.OK) fail(inspection.code, "ledger", `Historial u objetos divergentes; consulta pnpm db:status:local --profile ${profile}.`)
    if (inspection.state !== "up-to-date") fail(EXIT.PLAN_REJECTED, "ledger", `Hay migraciones pendientes: ejecuta db:plan:local y db:migrate:local con --profile ${profile}.`)
    const store = readFixtureStore(resolved, loadCensus())
    if (!store?.accounts?.a?.id || !store?.accounts?.b?.id || store.phase !== "completado") fail(EXIT.SEED_FAILED, "fixtures", `Faltan fixtures A/B completos; ejecuta pnpm db:seed:local --profile ${profile}.`)
    await closeConnection(sql); sql = undefined
    out.write(`Grupo account · perfil ${profile} · ${resolved.stack.profile.projectId} · run ${runId}\n`)

    const env = childEnvironment(profile, runId)
    if (!reuseBuild) {
      out.write(`Compilando la app para el perfil ${profile}…\n`)
      const code = await run(process.execPath, ["scripts/next-target.mjs", "build", "local", "--profile", profile], { env, logFile: path.join(LOG_DIR, "account-build.log") })
      if (code !== 0) fail(code === EXIT.IDENTITY_MISMATCH ? code : EXIT.VERIFICATION_FAILED, "build", "Falló el build; revisa .biblib/integration/account-build.log.")
    }
    if (await run(process.execPath, ["scripts/check-client-bundle.mjs", "--dist-dir", ".next-local"], { env }) !== 0) fail(EXIT.VERIFICATION_FAILED, "bundle", "El bundle de cliente contiene material privado o no existe.")
    app = await startApp(resolved, profile, env, path.join(LOG_DIR, "account-app.log"))
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const files = readdirSync(dir).filter((file) => file.endsWith(".test.mjs")).sort().map((file) => path.join("tests", "integration", "account", file))
    const redact = redactor([resolved.target.env().SUPABASE_SERVICE_ROLE_KEY, resolved.target.env().SUPABASE_ANON_KEY, store.accounts.a.password, store.accounts.b.password])
    const values = resolved.target.env()
    const admin = createClient(values.SUPABASE_URL, values.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    const usersBefore = await listUsers(admin)
    const code = await run(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", ...files], { env, onOutput: (stream) => pipeRedacted(stream, out, redact) })
    // Las cuentas desechables del grupo se crean y se eliminan dentro del run: Auth queda como estaba.
    if (JSON.stringify(await listUsers(admin)) !== JSON.stringify(usersBefore)) fail(EXIT.VERIFICATION_FAILED, "usuarios", "El grupo account dejó cuentas de Auth distintas de las del inicio; revisa la limpieza de las cuentas ops03-….")
    return code === 0 ? EXIT.OK : EXIT.VERIFICATION_FAILED
  } catch (error) {
    console.error(`Error [${error instanceof BiblibError ? error.phase : "suite"}]: ${error instanceof BiblibError ? error.message : "Fallo inesperado del grupo account."}`)
    return error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
  } finally {
    stopTree(app)
    if (sql) await closeConnection(sql)
    release?.()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { BiblibError, EXIT } from "../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../scripts/lib/profiles.mjs"
import { acquireLock } from "../../scripts/lib/state.mjs"
import { loadJournal } from "../../scripts/db/journal-guard.mjs"
import { inspectDatabase } from "../../scripts/db/target.mjs"
import { adminClient, closeConnection, database, integrationContext, PROFILE } from "../integration/lib/context.mjs"
import { listUsers, pipeRedacted, redactor, run, startApp, stopTree } from "../integration/lib/process.mjs"
import { cleanupE2E, e2eManifestFile, readE2EManifest, startE2EManifest } from "./lib/e2e-manifest.mjs"
import { checkUntargetedBuild } from "./lib/untargeted-bundle.mjs"

// pnpm test:e2e:local — U-QA-02. Recorridos de navegador (Playwright) contra el stack real del perfil
// test y la app compilada para ese perfil (127.0.0.1:3148) con catálogo `fixture`. Acredita el perfil
// igual que tests/integration/run.mjs, bloquea la red externa del servidor y para solo lo que arranca.

export const BROWSERS = ["chromium", "firefox", "webkit"]
export const E2E_DIR = path.join(REPO_ROOT, ".biblib", "e2e")
const PLAYWRIGHT_CLI = path.join(REPO_ROOT, "node_modules", "@playwright", "test", "cli.js")
const GUARD = path.join(REPO_ROOT, "tests", "e2e", "lib", "server-network-guard.mjs")
const USAGE = "Uso: test:e2e:local [--profile test] [--project chromium|firefox|webkit]… [--reuse-build] [--grep <texto>] [--no-deps] [--ui] · --check-untargeted-build · test:e2e:external"
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }

export function parseArgs(argv) {
  const parsed = { profile: PROFILE, projects: [], reuseBuild: false, ui: false, external: false, checkUntargeted: false, grep: undefined, noDeps: false }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag !== "--project" && seen.has(flag)) fail(EXIT.INVALID_ARGS, "argumentos", "Argumento repetido.")
    seen.add(flag)
    if (flag === "--profile" && argv[i + 1] === PROFILE) i++
    else if (flag === "--project" && BROWSERS.includes(argv[i + 1]) && !parsed.projects.includes(argv[i + 1])) parsed.projects.push(argv[++i])
    else if (flag === "--reuse-build") parsed.reuseBuild = true
    else if (flag === "--ui") parsed.ui = true
    else if (flag === "--external") parsed.external = true
    else if (flag === "--check-untargeted-build") parsed.checkUntargeted = true
    else if (flag === "--no-deps") parsed.noDeps = true
    else if (flag === "--grep" && argv[i + 1] && !argv[i + 1].startsWith("--")) parsed.grep = argv[++i]
    else fail(EXIT.INVALID_ARGS, "argumentos", USAGE)
  }
  const local = parsed.projects.length || parsed.reuseBuild || parsed.ui || parsed.noDeps || parsed.grep !== undefined
  if (parsed.external && (local || parsed.checkUntargeted)) fail(EXIT.INVALID_ARGS, "argumentos", "test:e2e:external no admite opciones del stack local.")
  if (parsed.checkUntargeted && local) fail(EXIT.INVALID_ARGS, "argumentos", "--check-untargeted-build es una comprobación aparte: no se combina con los recorridos.")
  if (!parsed.projects.length) parsed.projects.push("chromium")
  return parsed
}

/** Argumentos de Playwright: el proyecto de cada navegador arrastra su sesión y sus recorridos por dependencias. */
export function playwrightArgs(options) {
  const args = [PLAYWRIGHT_CLI, "test", "--config", options.config ?? "playwright.config.ts"]
  if (options.external) return [...args, "--project", "external"]
  for (const project of options.projects) args.push("--project", project)
  if (options.grep) args.push("--grep", options.grep)
  // Solo para depurar un proyecto suelto (p. ej. el cierre): no es una ejecución de aceptación.
  if (options.noDeps) args.push("--no-deps")
  if (options.ui) args.push("--ui")
  return args
}

/** Entorno de los procesos hijos: sin herencia de Supabase/Postgres/BIBLIB salvo lo que fija el runner. */
export function childEnvironment(extra) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|DATABASE_URL$|PG|POSTGRES_|BIBLIB_|NODE_OPTIONS$)/i.test(key)))
  return { ...base, BIBLIB_TARGET: "local", BIBLIB_PROFILE: PROFILE, NODE_ENV: "test", ...extra }
}

/** Lo anotado por el guard del servidor: si vigiló algún proceso y qué hosts externos bloqueó (sin la URL completa). */
export function readOutbound(file) {
  const entries = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []
  return { guarded: entries.some((entry) => entry.guard === "activo"), hosts: entries.filter((entry) => typeof entry.host === "string").map((entry) => entry.host) }
}

/**
 * Resumen del informe JSON de Playwright: superados, fallos conocidos (`test.fail`), pendientes (fixme),
 * inesperados y cualquier repetición. Con `retries: 0` no debe haber repeticiones; si las hubiera, cuentan.
 */
export function summarizeReport(report) {
  const tests = []
  const walk = (suite) => {
    for (const child of suite.suites ?? []) walk(child)
    for (const spec of suite.specs ?? []) {
      for (const entry of spec.tests ?? []) tests.push({ title: spec.title, project: entry.projectName, expectedStatus: entry.expectedStatus, status: entry.status, runs: entry.results?.length ?? 0 })
    }
  }
  for (const suite of report.suites ?? []) walk(suite)
  const label = (t) => `[${t.project}] ${t.title}`
  return {
    passed: tests.filter((t) => t.status === "expected" && t.expectedStatus === "passed").length,
    known: tests.filter((t) => t.status === "expected" && t.expectedStatus === "failed").map(label),
    pending: tests.filter((t) => t.status === "skipped").length,
    unexpected: tests.filter((t) => t.status === "unexpected").map(label),
    repeated: tests.filter((t) => t.status === "flaky" || t.runs > 1).map(label),
  }
}

async function runExternal(options, out) {
  out.write("E2E externo (opt-in) · Open Library live · no se ejecuta en CI\n")
  const code = await run(process.execPath, playwrightArgs(options), {
    env: { ...childEnvironment({ BIBLIB_E2E_EXTERNAL: "1" }) },
    onOutput: (stream) => pipeRedacted(stream, out, (line) => line),
  })
  if (code !== 0) fail(EXIT.VERIFICATION_FAILED, "externo", "La comprobación externa falló; revisa el escenario marcado arriba (sin red, Open Library caído o cambio de contrato).")
  return EXIT.OK
}

export async function runE2E(argv = process.argv.slice(2), out = process.stdout, config) {
  const options = parseArgs(argv)
  options.config = config
  if (options.external) return runExternal(options, out)
  if (options.checkUntargeted) {
    // Comprobación de U-LOC-01: sin stack ni sesiones; solo compila y revisa el bundle.
    mkdirSync(E2E_DIR, { recursive: true, mode: 0o700 })
    out.write("Compilando un build sin objetivo en una carpeta temporal (sin archivos .env)…\n")
    const result = await checkUntargetedBuild({ logFile: path.join(E2E_DIR, "build-sin-objetivo.log") })
    out.write(`Build sin objetivo: ${result.files} archivos estáticos revisados, sin formulario de acceso local ni material privado.\n`)
    return EXIT.OK
  }
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") fail(EXIT.IDENTITY_MISMATCH, "objetivo", "El E2E local solo admite BIBLIB_TARGET=local (perfil test).")
  const runId = randomBytes(6).toString("hex")
  mkdirSync(E2E_DIR, { recursive: true, mode: 0o700 })
  const ctx = await integrationContext()
  const release = acquireLock(ctx.resolved.stack)
  const sql = database(ctx, "biblib-e2e-runner")
  const admin = adminClient(ctx)
  const redact = redactor([ctx.env.SUPABASE_SERVICE_ROLE_KEY, ctx.env.SUPABASE_ANON_KEY, ctx.store.accounts.a.password, ctx.store.accounts.b.password, ctx.store.serviceRoleKey])
  const manifest = e2eManifestFile(ctx.root)
  const outbound = path.join(E2E_DIR, "outbound.jsonl")
  const stateDir = path.join(E2E_DIR, "state")
  let app, interrupted = false
  const onInterrupt = () => { interrupted = true; stopTree(app) }
  process.once("SIGINT", onInterrupt)
  try {
    out.write(`E2E · perfil ${PROFILE} · ${ctx.projectId} · huella ${ctx.resolved.fingerprint.slice(0, 12)} · run ${runId} · ${options.projects.join(", ")}\n`)
    const inspection = await sql.begin("read only", (tx) => inspectDatabase(tx, loadJournal()))
    if (inspection.code !== EXIT.OK) fail(inspection.code, "ledger", "Historial u objetos divergentes en el perfil test; consulta pnpm db:status:local --profile test.")
    if (inspection.state !== "up-to-date") fail(EXIT.PLAN_REJECTED, "ledger", "Hay migraciones pendientes en el perfil test: ejecuta db:plan:local y db:migrate:local con --profile test.")

    if (readE2EManifest(manifest)) {
      await cleanupE2E({ sql, users: ctx.users, file: manifest })
      out.write("Restos registrados del E2E anterior limpiados.\n")
    }
    const usersBefore = await listUsers(admin)

    const env = childEnvironment({ BIBLIB_ISBN_CAMERA: "1" })
    if (!options.reuseBuild) {
      out.write("Compilando la app para el perfil test…\n")
      const code = await run(process.execPath, ["scripts/next-target.mjs", "build", "local", "--profile", PROFILE], { env, logFile: path.join(E2E_DIR, "build.log") })
      if (code !== 0) fail(code === EXIT.IDENTITY_MISMATCH ? code : EXIT.VERIFICATION_FAILED, "build", "Falló el build del perfil test; revisa .biblib/e2e/build.log.")
    }
    const bundle = await run(process.execPath, ["scripts/check-client-bundle.mjs", "--dist-dir", ".next-local"], { env })
    if (bundle !== 0) fail(EXIT.VERIFICATION_FAILED, "bundle", "El bundle de cliente contiene material privado o no existe; no se ejecutan los recorridos.")
    out.write("Bundle de cliente sin credenciales administrativas ni URLs privadas.\n")

    rmSync(outbound, { force: true })
    writeFileSync(outbound, "", { mode: 0o600 })
    // El guard se carga en el proceso de la app: cualquier fetch del servidor fuera de loopback se bloquea y se anota.
    app = await startApp(ctx, { ...env, NODE_OPTIONS: `--import=${pathToFileURL(GUARD).href}`, E2E_OUTBOUND_LOG: outbound }, { logFile: path.join(E2E_DIR, "app.log"), logHint: ".biblib/e2e/app.log" })
    await startE2EManifest(manifest, { runId, sql })

    rmSync(stateDir, { recursive: true, force: true })
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const results = path.join(E2E_DIR, "resultados.json")
    rmSync(results, { force: true })
    const code = await run(process.execPath, playwrightArgs(options), {
      env: { ...env, BIBLIB_E2E_RUN_ID: runId, BIBLIB_E2E_BASE_URL: ctx.appUrl, BIBLIB_E2E_DIR: E2E_DIR },
      onOutput: (stream) => pipeRedacted(stream, out, redact),
    })
    if (interrupted) fail(EXIT.INTERRUPTED, "pruebas", "E2E interrumpido; el manifiesto de restos se conserva para el siguiente intento.")

    const { guarded, hosts } = readOutbound(outbound)
    const usersAfter = await listUsers(admin)
    await cleanupE2E({ sql, users: ctx.users, file: manifest })

    if (!guarded) fail(EXIT.VERIFICATION_FAILED, "red", "El guard de red no se cargó en el proceso de la app; no se puede acreditar la ausencia de tráfico externo.")
    if (hosts.length) fail(EXIT.VERIFICATION_FAILED, "red", `El servidor intentó salir a ${new Set(hosts).size} host(s) externo(s) en modo fixture: ${[...new Set(hosts)].join(", ")}.`)
    out.write("Servidor sin salidas de red externas durante el run.\n")
    if (JSON.stringify(usersBefore) !== JSON.stringify(usersAfter) || !usersAfter.every((u) => u.email?.endsWith("@biblib.test"))) fail(EXIT.VERIFICATION_FAILED, "usuarios", "El E2E cambió las cuentas de Auth o existen cuentas fuera de @biblib.test.")
    out.write(`Cuentas de Auth sin cambios (${usersAfter.length}, todas @biblib.test). Datos del run limpiados y biblioteca de A restaurada si hizo falta.\n`)
    if (options.ui) return code === 0 ? EXIT.OK : EXIT.VERIFICATION_FAILED
    if (!existsSync(results)) fail(EXIT.VERIFICATION_FAILED, "pruebas", "Playwright no generó .biblib/e2e/resultados.json; no se puede acreditar el resultado.")
    const summary = summarizeReport(JSON.parse(readFileSync(results, "utf8")))
    for (const title of summary.known) out.write(`Fallo conocido (test.fail, documentado): ${title}\n`)
    for (const title of summary.repeated) out.write(`Repetición registrada: ${title}\n`)
    if (code !== 0 || summary.unexpected.length || summary.repeated.length) fail(EXIT.VERIFICATION_FAILED, "pruebas", `Recorridos fallidos o repetidos (${summary.unexpected.length} fallidos, ${summary.repeated.length} con repetición); revisa los nombres marcados arriba y .biblib/e2e/report.`)
    out.write(`Resultado: ${summary.passed} recorridos superados, ${summary.known.length} fallo(s) conocido(s), ${summary.pending} pendientes (fixme), 0 fallidos, 0 repeticiones.\n`)
    return EXIT.OK
  } finally {
    process.removeListener("SIGINT", onInterrupt)
    stopTree(app)
    rmSync(stateDir, { recursive: true, force: true })
    await closeConnection(sql)
    release()
  }
}

export async function main(argv = process.argv.slice(2), config) {
  try { return await runE2E(argv, process.stdout, config) } catch (error) {
    const code = error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
    const phase = error instanceof BiblibError ? error.phase : "e2e"
    console.error(`Error [${phase}] (${code}): ${error instanceof BiblibError ? error.message : "Fallo inesperado del runner E2E."}`)
    return code
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

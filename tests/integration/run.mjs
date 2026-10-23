import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { BiblibError, EXIT } from "../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../scripts/lib/profiles.mjs"
import { acquireLock } from "../../scripts/lib/state.mjs"
import { loadJournal } from "../../scripts/db/journal-guard.mjs"
import { inspectDatabase } from "../../scripts/db/target.mjs"
import { adminClient, closeConnection, database, integrationContext, PROFILE } from "./lib/context.mjs"
import { cleanupManifest, isEmpty, manifestFile, readManifest, startManifest, writeManifest } from "./lib/run-manifest.mjs"
import { listUsers, pipeRedacted, redactor, run, startApp, stopTree } from "./lib/process.mjs"

export { redactor }

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

    app = await startApp(ctx, env, { logFile: path.join(LOG_DIR, "app.log"), logHint: ".biblib/integration/app.log" })
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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { pathToFileURL } from "node:url"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"
import { acquireLock } from "../lib/state.mjs"
import { loadCensus, resolveSeedTarget, seedAccounts } from "../db/seed-local.mjs"
import { closeConnection, database, integrationContext, PROFILE } from "../../tests/integration/lib/context.mjs"
import { run as runProcess, startApp, stopTree } from "../../tests/integration/lib/process.mjs"
import { ensureCompiled } from "../../tests/integration/catalogue/lib/context.mjs"
import { SCALES } from "./lib/dataset.mjs"
import { removeScaleAccount, runScaleSeed } from "./scale-seed.mjs"
import { collectManifest } from "./lib/manifest.mjs"
import { openSessions } from "./lib/sessions.mjs"
import { createApp, invoke, runCold, runPass } from "./lib/load.mjs"
import { actionScenarios, loadExportModule, previewScenarios, scaleFacts } from "./lib/scenarios.mjs"
import { mainQueries } from "./lib/queries.mjs"
import { explainAll } from "./lib/explain.mjs"
import { CANDIDATES, measureCandidate, measureWriteCost } from "./lib/indexes.mjs"
import { isolationUnderLoad } from "./lib/isolation.mjs"
import { runQuotaScenario } from "./lib/quota.mjs"
import { browserVersion, runWebVitals } from "./lib/webvitals.mjs"
import { summarize } from "./lib/stats.mjs"
import { writeTables } from "./lib/report.mjs"

// pnpm perf:local — U-QA-03. Medición de rendimiento y capacidad contra el stack real del perfil `test` y la
// app compilada para ese perfil (127.0.0.1:3148), con catálogo en fixture y sin llamadas externas.
// Cuenta de escala `escala@biblib.test` (100, 1000 y 10000 ejemplares sintéticos), sesiones reales de GoTrue.

const LOG_DIR = path.join(REPO_ROOT, ".biblib", "performance")
const GUARD = path.join(REPO_ROOT, "tests", "e2e", "lib", "server-network-guard.mjs")
const STEPS = ["actions", "explain", "indexes", "isolation", "web", "quota", "auth"]
const CONCURRENCY = [1, 5, 10]
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }
const today = () => new Date().toISOString().slice(0, 10)

export function parseArgs(argv) {
  const parsed = { scales: [], reuseBuild: false, skip: new Set(), out: null, webRuns: null, cleanup: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === "--scale" && SCALES.map(String).includes(argv[i + 1])) parsed.scales.push(Number(argv[++i]))
    else if (flag === "--skip" && STEPS.includes(argv[i + 1])) parsed.skip.add(argv[++i])
    else if (flag === "--reuse-build") parsed.reuseBuild = true
    else if (flag === "--cleanup") parsed.cleanup = true
    else if (flag === "--web-runs" && /^[1-5]$/.test(argv[i + 1] ?? "")) parsed.webRuns = Number(argv[++i])
    else if (flag === "--out" && argv[i + 1]) parsed.out = argv[++i]
    else if (flag === "--profile" && argv[i + 1] === PROFILE) i++
    else fail(EXIT.INVALID_ARGS, "argumentos", `Uso: perf:local [--scale 100|1000|10000]... [--skip ${STEPS.join("|")}]... [--reuse-build] [--web-runs 1-5] [--out <carpeta>] [--cleanup]. Solo el perfil test.`)
  }
  if (!parsed.scales.length) parsed.scales = [...SCALES]
  parsed.scales.sort((a, b) => a - b)
  return parsed
}

function childEnvironment() {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|DATABASE_URL$|PG|POSTGRES_|BIBLIB_|E2E_)/i.test(key)))
  return { ...base, BIBLIB_TARGET: "local", BIBLIB_PROFILE: PROFILE, NODE_ENV: "production" }
}

const writeJson = (dir, name, value) => writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`)

/** Sondeo de GoTrue (GET /auth/v1/user) desde el cliente: ida y vuelta a través de Kong, la misma llamada que hace getUser(). */
async function authRoundTrip(ctx, sessions, { iterations = 60 }) {
  const result = {}
  for (const concurrency of CONCURRENCY) {
    const times = []
    await Promise.all(sessions.escala.slice(0, concurrency).map(async (session) => {
      for (let i = 0; i < iterations; i++) {
        const started = performance.now()
        const response = await fetch(`${ctx.env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ctx.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${session.accessToken}` } })
        await response.arrayBuffer()
        if (response.status === 200) times.push(performance.now() - started)
      }
    }))
    result[concurrency] = summarize(times, 1)
  }
  return result
}

async function connectionSnapshot(sql) {
  const rows = await sql.unsafe("/* perf */ select coalesce(nullif(application_name, ''), '(sin nombre)') as app, usename, state, count(*)::int as n from pg_stat_activity where datname is not null group by 1, 2, 3 order by 4 desc")
  const [{ setting }] = await sql.unsafe("/* perf */ select setting from pg_settings where name = 'max_connections'")
  return { maxConnections: Number(setting), total: rows.reduce((sum, row) => sum + row.n, 0), porAplicacion: rows.map((row) => ({ aplicacion: row.app, rol: row.usename, estado: row.state, conexiones: row.n })) }
}

export async function runPerformance(argv = process.argv.slice(2), out = process.stdout) {
  const options = parseArgs(argv)
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") fail(EXIT.IDENTITY_MISMATCH, "objetivo", "La medición solo admite BIBLIB_TARGET=local (perfil test).")
  const outDir = path.resolve(REPO_ROOT, options.out ?? path.join("docs", "validacion", "rendimiento", today()))
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(outDir, { recursive: true })
  const ctx = await integrationContext()
  const release = acquireLock(ctx.resolved.stack)
  const sql = database(ctx, "biblib-perf")
  const poolSql = database(ctx, "biblib-perf-sampler")
  const containerName = `supabase_auth_${ctx.projectId}`
  const deps = { resolveSeedTarget, seedAccounts, loadCensus }
  let app, sessions, interrupted = false
  const onInterrupt = () => { interrupted = true; stopTree(app) }
  process.once("SIGINT", onInterrupt)
  const log = (text) => out.write(`${text}\n`)
  try {
    log(`Rendimiento · perfil ${PROFILE} · ${ctx.projectId} · huella ${ctx.resolved.fingerprint.slice(0, 12)} · tamaños ${options.scales.join(", ")}`)
    const env = childEnvironment()
    if (!options.reuseBuild) {
      log("Compilando la app para el perfil test…")
      const code = await runProcess(process.execPath, ["scripts/next-target.mjs", "build", "local", "--profile", PROFILE], { env, logFile: path.join(LOG_DIR, "build.log") })
      if (code !== 0) fail(code === EXIT.IDENTITY_MISMATCH ? code : EXIT.VERIFICATION_FAILED, "build", "Falló el build del perfil test; revisa .biblib/performance/build.log.")
    }
    ensureCompiled()
    const manifest = await collectManifest({ sql, projectId: ctx.projectId, browserVersion: options.skip.has("web") ? null : await browserVersion() })
    manifest.perfilDeMedicion = { app: "next start (build de producción, Turbopack) en 127.0.0.1:3148", catalogo: "BIBLIB_CATALOGUE_MODE=fixture (sin red)", pool: "postgres.js max 1 por proceso (lib/db/client.ts)", sesiones: "GoTrue real, signInWithPassword; 10 sesiones de escala + A + B reutilizadas" }
    writeJson(outDir, "manifiesto.json", manifest)

    const all = { manifiesto: manifest.generadoEn, tamanos: {} }
    for (const scale of options.scales) {
      if (interrupted) break
      log(`\n== ${scale} ejemplares ==`)
      const seeded = await runScaleSeed({ profile: PROFILE, scale, lockHeld: true }, deps)
      log(`Dataset ${seeded.datasetId} (${seeded.datasetHash.slice(0, 12)}): ${seeded.books} libros, ${seeded.shelves} estanterías.`)
      const outbound = path.join(LOG_DIR, "outbound.jsonl")
      rmSync(outbound, { force: true })
      writeFileSync(outbound, "", { mode: 0o600 })
      app = await startApp(ctx, { ...env, NODE_OPTIONS: `--import=${pathToFileURL(GUARD).href}`, E2E_OUTBOUND_LOG: outbound }, { logFile: path.join(LOG_DIR, "app.log"), logHint: ".biblib/performance/app.log" })
      try {
        if (!sessions) { log("Abriendo sesiones reales (10 de escala, A y B)…"); sessions = await openSessions(ctx, { escala: 10, ab: true }) }
        const facts = await scaleFacts(sql, sessions.scaleUserId)
        const appHandle = createApp({ url: ctx.appUrl, root: ctx.root })
        const result = { escala: scale, dataset: { id: seeded.datasetId, hash: seeded.datasetHash, libros: seeded.books, estanterias: seeded.shelves, porEstado: seeded.byStatus, estanteriaMayor: seeded.largestShelf, isbnManuales: seeded.manualIsbn } }

        if (!options.skip.has("actions")) {
          const scenarios = actionScenarios(facts)
          log("Frío (primera llamada de cada acción tras arrancar la app)…")
          result.frio = await runCold({ app: appHandle, session: sessions.escala[0], scenarios, sql, containerName })
          // Preparación de los previews: datos reales de la acción de exportación y particionado de la copia.
          const data = await invoke(appHandle, sessions.escala[1], "getLibraryDataAction", [])
          if (!data.ok) fail(EXIT.VERIFICATION_FAILED, "preparación", "No se pudo leer la colección para preparar los previews.")
          const exporter = loadExportModule()
          const splitTimes = []
          let backup
          for (let i = 0; i < 5; i++) { const t = performance.now(); backup = exporter.exportLibraryBackup(data.value); splitTimes.push(performance.now() - t) }
          result.exportacion = {
            formato: backup.formatVersion, partes: backup.parts.length, fichasPorParte: backup.parts.map((p) => (p.books ?? p.copies ?? []).length),
            bytesPorParte: backup.parts.map((p) => Buffer.byteLength(JSON.stringify(p))), lecturaCompletaBytes: data.bytes, particionadoNodeMs: summarize(splitTimes, 1),
          }
          if (backup.formatVersion !== 1 || !backup.parts[0].books) fail(EXIT.VERIFICATION_FAILED, "preparación", "La copia no es del formato 1: el escenario de preview no aplica a este dataset.")
          const all13 = [...scenarios, ...previewScenarios(backup.parts)]
          result.acciones = []
          for (const scenario of all13) {
            for (const concurrency of CONCURRENCY) {
              if (interrupted) break
              const pass = await runPass({ app: appHandle, sessions: sessions.escala, scenario, concurrency, iterations: scenario.iterations[concurrency], sql, poolSql, containerName, attributeSql: concurrency === 1 })
              pass.pantalla = scenario.pantalla
              result.acciones.push(pass)
              log(`  ${scenario.name.padEnd(32)} c=${String(concurrency).padEnd(2)} p50 ${String(pass.accionMs.p50).padStart(7)} ms · p95 ${String(pass.accionMs.p95).padStart(7)} ms${pass.sqlMs ? ` · SQL p95 ${pass.sqlMs.p95} ms` : ""} · errores ${pass.errores}`)
              await sql`delete from biblib.import_previews where user_id = ${sessions.scaleUserId}`
            }
          }
          result.conexiones = await connectionSnapshot(sql)
        }

        if (!options.skip.has("explain") || !options.skip.has("indexes")) {
          const [{ id: bookId }] = await sql`select id from biblib.books where user_id = ${sessions.scaleUserId} order by id limit 1`
          const queries = mainQueries({ userId: sessions.scaleUserId, shelfId: facts.bigShelf, bookId, scale })
          if (!options.skip.has("explain")) {
            const plans = await explainAll(sql, sessions.scaleUserId, queries)
            result.consultas = plans.map((plan) => Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "texto")))
            writeFileSync(path.join(outDir, `explain-${scale}.txt`), `EXPLAIN (ANALYZE, BUFFERS) de las consultas principales · ${scale} ejemplares · PostgreSQL ${manifest.postgres.version}\nRol authenticated con RLS real; cuenta sintética de escala; UUID sustituidos.\n\n${plans.map((p) => `-- ${p.id} · ${p.accion} · ${p.pantalla}${p.limite ? "" : " · SIN LIMIT en la aplicación"}\n${p.texto}\n`).join("\n")}`)
            log(`EXPLAIN de ${plans.length} consultas guardado.`)
          }
          if (!options.skip.has("indexes")) {
            result.indices = []
            result.escrituraSinIndiceMs = await measureWriteCost(sql, sessions.scaleUserId)
            for (const candidate of CANDIDATES) {
              const measured = await measureCandidate(sql, sessions.scaleUserId, candidate, queries)
              if (measured.aplicable) measured.escrituraConIndiceMs = await measureWriteCost(sql, sessions.scaleUserId, candidate.ddl)
              result.indices.push(measured)
            }
            log(`Índices candidatos medidos (transacción revertida): ${result.indices.filter((i) => i.aplicable).length}/${CANDIDATES.length} aplicables.`)
          }
        }

        if (!options.skip.has("isolation")) {
          result.aislamiento = await isolationUnderLoad({ app: appHandle, sessions, sql, ctx, facts, durationMs: scale === 10000 ? 12_000 : 6_000 })
          log(`Aislamiento bajo carga: ${result.aislamiento.comprobaciones} comprobaciones, ${result.aislamiento.violaciones} violaciones.`)
        }

        if (!options.skip.has("web")) {
          result.web = {}
          const runs = options.webRuns ?? (scale === 10000 ? 3 : 2)
          const profiles = scale === 10000 ? ["escritorio", "movil"] : ["escritorio"]
          for (const profileKey of profiles) {
            log(`Web vitals · ${profileKey} · ${runs} contexto(s) por pantalla…`)
            result.web[profileKey] = await runWebVitals({ appUrl: ctx.appUrl, cookies: sessions.escala[9].cookies, facts, profileKey: profileKey, runs: profileKey === "movil" ? Math.min(runs, 2) : runs })
            await sql.unsafe("/* perf */ select 1")
          }
        }

        // Ninguna salida de red del servidor ni del navegador en modo fixture.
        const outboundLog = readFileSync(outbound, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
        const hosts = outboundLog.filter((entry) => entry.host).map((entry) => entry.host)
        result.redExterna = { guardCargado: outboundLog.some((entry) => entry.guard === "activo"), hostsBloqueadosDelServidor: [...new Set(hosts)], hostsAbortadosDelNavegador: Object.values(result.web ?? {}).flatMap((w) => w.peticionesExternasAbortadas) }
        all.tamanos[scale] = result
        writeJson(outDir, `resultados-${scale}.json`, result)
        if (!result.redExterna.guardCargado || hosts.length || result.redExterna.hostsAbortadosDelNavegador.length) fail(EXIT.VERIFICATION_FAILED, "red", "Se detectó (o no se pudo descartar) tráfico externo durante la medición.")
      } finally { stopTree(app); app = null }
    }

    if (!interrupted && sessions) {
      if (!options.skip.has("auth")) { all.authIdaYVuelta = await authRoundTrip(ctx, sessions, {}); writeJson(outDir, "auth.json", all.authIdaYVuelta); log("Auth (ida y vuelta GET /auth/v1/user) medido.") }
      if (!options.skip.has("quota")) { all.cuota = await runQuotaScenario({ sql, dbUrl: ctx.env.SUPABASE_DB_URL, users: ctx.users }); writeJson(outDir, "cuota.json", all.cuota); log(`Cuota con dos procesos: separación mínima ${all.cuota.distintos.separacionMinimaMs} ms, cumple=${all.cuota.distintos.cumpleIntervalo}.`) }
    }
    writeTables(outDir, { manifest, all })
    if (options.cleanup) { await removeScaleAccount({ profile: PROFILE, lockHeld: true }, deps); log("Cuenta de escala eliminada.") }
    return interrupted ? EXIT.INTERRUPTED : EXIT.OK
  } finally {
    process.removeListener("SIGINT", onInterrupt)
    stopTree(app)
    await sessions?.close()
    await closeConnection(poolSql)
    await closeConnection(sql)
    release()
  }
}

export async function runCleanup() {
  const result = await removeScaleAccount({ profile: PROFILE }, { resolveSeedTarget, seedAccounts, loadCensus })
  console.log(result.removed ? "Cuenta de escala y su biblioteca eliminadas." : `Nada que eliminar: ${result.reason}.`)
  return EXIT.OK
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const [command, ...rest] = argv[0] && !argv[0].startsWith("--") ? argv : ["run", ...argv]
    if (command === "cleanup") return await runCleanup()
    if (command === "run") return await runPerformance(rest)
    fail(EXIT.INVALID_ARGS, "argumentos", "Uso: perf-local [run|cleanup] …")
  } catch (error) {
    const code = error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
    console.error(`Error [${error instanceof BiblibError ? error.phase : "rendimiento"}] (${code}): ${error instanceof BiblibError ? error.message : "Fallo inesperado de la medición."}`)
    return code
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

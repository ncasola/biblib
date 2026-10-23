import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { pathToFileURL } from "node:url"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"
import { acquireLock } from "../lib/state.mjs"
import { loadCensus, resolveSeedTarget, seedAccounts } from "../db/seed-local.mjs"
import { readFixtureStore } from "../db/fixture-store.mjs"
import { closeConnection } from "../db/target.mjs"
import { run as runProcess, stopTree } from "../../tests/integration/lib/process.mjs"
import { ensureCompiled } from "../../tests/integration/catalogue/lib/context.mjs"
import { datasetHash, DATASET_ID, SCALES, scaleDataset, summarize as summarizeDataset } from "./lib/dataset.mjs"
import { removeScaleAccount, runScaleSeed, scaleCensus, scaleResolved } from "./scale-seed.mjs"
import { database, PERF_PROFILES, perfContext, startPerfApp } from "./lib/context.mjs"
import { collectManifest } from "./lib/manifest.mjs"
import { openSessions } from "./lib/sessions.mjs"
import { createApp, invoke, runCold, runPass } from "./lib/load.mjs"
import { ACTION_SCENARIO_NAMES, actionScenarios, loadExportModule, PREVIEW_SCENARIO_NAMES, previewScenarios, scaleFacts } from "./lib/scenarios.mjs"
import { mainQueries } from "./lib/queries.mjs"
import { explainAll } from "./lib/explain.mjs"
import { CANDIDATES, measureCandidate, measureWriteCost } from "./lib/indexes.mjs"
import { isolationUnderLoad } from "./lib/isolation.mjs"
import { runQuotaScenario } from "./lib/quota.mjs"
import { browserVersion, runWebVitals } from "./lib/webvitals.mjs"
import { summarize } from "./lib/stats.mjs"
import { writeTables } from "./lib/report.mjs"
import { contractResults } from "./lib/contract.mjs"

// pnpm perf:local — U-QA-03. Medición de rendimiento y capacidad contra el stack real del perfil (ya arrancado y
// sembrado: no lo arranca ni lo para) y la app compilada para ese perfil, con catálogo en fixture y sin llamadas
// externas. Cuenta de escala `escala@biblib.test` (100, 1000 y 10000 ejemplares sintéticos), sesiones reales de GoTrue.
//
// Contrato: perf:local [--profile test|scratch] [--scale 100|1000|10000] [--scenarios <lista>] [--out <dir>] [--json]
// Salidas: 0 mide (aunque haya presupuestos incumplidos: van como «over-budget»), 2 argumentos, 3 perfil ajeno, 8 stack no disponible.

const LOG_DIR = path.join(REPO_ROOT, ".biblib", "performance")
const GUARD = path.join(REPO_ROOT, "tests", "e2e", "lib", "server-network-guard.mjs")
const STEPS = ["explain", "indexes", "isolation", "web", "quota", "auth"]
const CONCURRENCY = [1, 5, 10]
const ALL_NAMES = [...ACTION_SCENARIO_NAMES, ...PREVIEW_SCENARIO_NAMES, ...STEPS]
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }
const today = () => new Date().toISOString().slice(0, 10)

export function parseArgs(argv) {
  const parsed = { profile: "test", scales: [], reuseBuild: false, skip: new Set(), only: null, out: null, webRuns: null, cleanup: false, json: false }
  const usage = () => fail(EXIT.INVALID_ARGS, "argumentos", `Uso: perf:local [--profile test|scratch] [--scale 100|1000|10000] [--scenarios <lista separada por comas>] [--out <carpeta>] [--json] [--skip actions|${STEPS.join("|")}] [--reuse-build] [--web-runs 1-5] [--cleanup]. Escenarios: ${ALL_NAMES.join(", ")}.`)
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === "--profile" && PERF_PROFILES.includes(value)) { parsed.profile = value; i++ }
    else if (flag === "--scale" && SCALES.map(String).includes(value)) { const scale = Number(value); if (!parsed.scales.includes(scale)) parsed.scales.push(scale); i++ }
    else if (flag === "--scenarios" && value && /^[a-z0-9,-]+$/.test(value)) {
      const names = value.split(",").filter(Boolean)
      if (!names.length || names.some((name) => !ALL_NAMES.includes(name))) usage()
      parsed.only = new Set(names)
      i++
    }
    else if (flag === "--skip" && [...STEPS, "actions"].includes(value)) { parsed.skip.add(value); i++ }
    else if (flag === "--out" && value && !value.startsWith("--")) { parsed.out = value; i++ }
    else if (flag === "--web-runs" && /^[1-5]$/.test(value ?? "")) { parsed.webRuns = Number(value); i++ }
    else if (flag === "--reuse-build") parsed.reuseBuild = true
    else if (flag === "--cleanup") parsed.cleanup = true
    else if (flag === "--json") parsed.json = true
    else usage()
  }
  if (!parsed.scales.length) parsed.scales = [1000]
  parsed.scales.sort((a, b) => a - b)
  return parsed
}

function childEnvironment(profile) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|DATABASE_URL$|PG|POSTGRES_|BIBLIB_|E2E_)/i.test(key)))
  return { ...base, BIBLIB_TARGET: "local", BIBLIB_PROFILE: profile, NODE_ENV: "production" }
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

/** ¿Ya contiene la cuenta de escala exactamente este dataset? Entonces no se vuelve a sembrar. */
async function seededDataset(ctx, sql, scale) {
  const store = readFixtureStore(scaleResolved(ctx.resolved), scaleCensus(ctx.census))
  const id = store?.accounts?.escala?.id
  if (!id) return null
  const [row] = await sql`select count(*)::int as n, count(*) filter (where catalogue->>'datasetId' = ${DATASET_ID})::int as own from biblib.books where user_id = ${id}`
  if (row.n !== scale || row.own !== scale) return null
  const dataset = scaleDataset(scale)
  return { datasetId: DATASET_ID, datasetHash: datasetHash(dataset), ...summarizeDataset(dataset) }
}

export async function runPerformance(argv = process.argv.slice(2), out = process.stdout) {
  const options = parseArgs(argv)
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") fail(EXIT.IDENTITY_MISMATCH, "objetivo", "La medición solo admite BIBLIB_TARGET=local.")
  const wants = (step) => options.only ? options.only.has(step) : !options.skip.has(step)
  const actionNames = options.only ? [...ACTION_SCENARIO_NAMES, ...PREVIEW_SCENARIO_NAMES].filter((name) => options.only.has(name)) : null
  const actionsOn = options.only ? actionNames.length > 0 : !options.skip.has("actions")
  const log = (text) => (options.json ? process.stderr : out).write(`${text}\n`)
  const outDir = path.resolve(REPO_ROOT, options.out ?? path.join("docs", "validacion", "rendimiento", today()))
  const profile = options.profile
  const ctx = await perfContext(profile)
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(outDir, { recursive: true })
  const release = acquireLock(ctx.resolved.stack)
  const sql = database(ctx, "biblib-perf")
  const poolSql = database(ctx, "biblib-perf-sampler")
  const containerName = `supabase_auth_${ctx.projectId}`
  const deps = { resolveSeedTarget, seedAccounts, loadCensus }
  let app, sessions, interrupted = false
  const onInterrupt = () => { interrupted = true; stopTree(app) }
  process.once("SIGINT", onInterrupt)
  const contract = []
  try {
    log(`Rendimiento · perfil ${profile} · ${ctx.projectId} · huella ${ctx.resolved.fingerprint.slice(0, 12)} · tamaños ${options.scales.join(", ")}`)
    const env = childEnvironment(profile)
    if (!options.reuseBuild) {
      log(`Compilando la app para el perfil ${profile}…`)
      const code = await runProcess(process.execPath, ["scripts/next-target.mjs", "build", "local", "--profile", profile], { env, logFile: path.join(LOG_DIR, "build.log") })
      if (code !== 0) fail(code === EXIT.IDENTITY_MISMATCH ? code : EXIT.VERIFICATION_FAILED, "build", "Falló el build de este perfil; revisa .biblib/performance/build.log.")
    }
    ensureCompiled()
    const manifest = await collectManifest({ sql, projectId: ctx.projectId, browserVersion: wants("web") ? await browserVersion() : null })
    manifest.perfilDeMedicion = { perfil: profile, app: `next start (build de producción, Turbopack) en ${ctx.appUrl.replace("http://", "")}`, catalogo: "BIBLIB_CATALOGUE_MODE=fixture (sin red)", pool: "postgres.js max 1 por proceso (lib/db/client.ts)", sesiones: "GoTrue real, signInWithPassword; 10 sesiones de escala + A + B reutilizadas" }
    writeJson(outDir, "manifiesto.json", manifest)

    const all = { manifiesto: manifest.generadoEn, tamanos: {} }
    for (const scale of options.scales) {
      if (interrupted) break
      log(`\n== ${scale} ejemplares ==`)
      const seeded = (await seededDataset(ctx, sql, scale)) ?? await runScaleSeed({ profile, scale, lockHeld: true }, deps)
      log(`Dataset ${seeded.datasetId} (${seeded.datasetHash.slice(0, 12)}): ${seeded.books} libros, ${seeded.shelves} estanterías.`)
      const outbound = path.join(LOG_DIR, "outbound.jsonl")
      rmSync(outbound, { force: true })
      writeFileSync(outbound, "", { mode: 0o600 })
      app = await startPerfApp(ctx, { ...env, NODE_OPTIONS: `--import=${pathToFileURL(GUARD).href}`, E2E_OUTBOUND_LOG: outbound }, { logFile: path.join(LOG_DIR, "app.log") })
      try {
        if (!sessions) {
          log("Abriendo sesiones reales (10 de escala, A y B)…")
          sessions = await openSessions(ctx, { escala: 10, ab: true })
          // El token de acceso dura 1 h: el sondeo de Auth va con las sesiones recién abiertas.
          if (wants("auth")) { all.authIdaYVuelta = await authRoundTrip(ctx, sessions, {}); writeJson(outDir, "auth.json", all.authIdaYVuelta); log("Auth (ida y vuelta GET /auth/v1/user) medido.") }
        }
        const facts = await scaleFacts(sql, sessions.scaleUserId)
        const appHandle = createApp({ url: ctx.appUrl, root: ctx.root })
        const result = { escala: scale, dataset: { id: seeded.datasetId, hash: seeded.datasetHash, libros: seeded.books, estanterias: seeded.shelves, porEstado: seeded.byStatus, estanteriaMayor: seeded.largestShelf, isbnManuales: seeded.manualIsbn } }

        if (actionsOn) {
          const selected = (name) => !actionNames || actionNames.includes(name)
          const base = actionScenarios(facts).filter((scenario) => selected(scenario.name))
          log("Frío (primera llamada de cada acción tras arrancar la app)…")
          result.frio = await runCold({ app: appHandle, session: sessions.escala[0], scenarios: base, sql, containerName })
          let previews = []
          if (!actionNames || PREVIEW_SCENARIO_NAMES.some(selected) || selected("exportacion-lectura-completa")) {
            // Preparación de los previews: datos reales de la acción de exportación y particionado de la copia.
            const data = await invoke(appHandle, sessions.escala[1], "getLibraryDataAction", [])
            if (!data.ok) fail(EXIT.VERIFICATION_FAILED, "preparación", `No se pudo leer la colección para preparar los previews (HTTP ${data.status}, lanzó: ${data.thrown}).`)
            const exporter = loadExportModule()
            const splitTimes = []
            let backup
            for (let i = 0; i < 5; i++) { const t = performance.now(); backup = exporter.exportLibraryBackup(data.value); splitTimes.push(performance.now() - t) }
            result.exportacion = {
              formato: backup.formatVersion, partes: backup.parts.length, fichasPorParte: backup.parts.map((p) => (p.books ?? p.copies ?? []).length),
              bytesPorParte: backup.parts.map((p) => Buffer.byteLength(JSON.stringify(p))), lecturaCompletaBytes: data.bytes, particionadoNodeMs: summarize(splitTimes, 1),
            }
            if (backup.formatVersion !== 1 || !backup.parts[0].books) fail(EXIT.VERIFICATION_FAILED, "preparación", "La copia no es del formato 1: el escenario de preview no aplica a este dataset.")
            previews = previewScenarios(backup.parts).filter((scenario) => selected(scenario.name))
          }
          result.acciones = []
          for (const scenario of [...base, ...previews]) {
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

        if (wants("explain") || wants("indexes")) {
          const [{ id: bookId }] = await sql`select id from biblib.books where user_id = ${sessions.scaleUserId} order by id limit 1`
          const queries = mainQueries({ userId: sessions.scaleUserId, shelfId: facts.bigShelf, bookId, scale })
          if (wants("explain")) {
            const plans = await explainAll(sql, sessions.scaleUserId, queries)
            result.consultas = plans.map((plan) => Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "texto")))
            writeFileSync(path.join(outDir, `explain-${scale}.txt`), `EXPLAIN (ANALYZE, BUFFERS) de las consultas principales · ${scale} ejemplares · PostgreSQL ${manifest.postgres.version}\nRol authenticated con RLS real; cuenta sintética de escala; UUID sustituidos.\n\n${plans.map((p) => `-- ${p.id} · ${p.accion} · ${p.pantalla}${p.limite ? "" : " · SIN LIMIT en la aplicación"}\n${p.texto}\n`).join("\n")}`)
            log(`EXPLAIN de ${plans.length} consultas guardado.`)
          }
          if (wants("indexes")) {
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

        if (wants("isolation")) {
          result.aislamiento = await isolationUnderLoad({ app: appHandle, sessions, sql, ctx, facts, durationMs: scale === 10000 ? 12_000 : 6_000 })
          log(`Aislamiento bajo carga: ${result.aislamiento.comprobaciones} comprobaciones, ${result.aislamiento.violaciones} violaciones.`)
        }

        if (wants("web")) {
          result.web = {}
          const runs = options.webRuns ?? (scale === 10000 ? 3 : 2)
          for (const profileKey of scale === 10000 ? ["escritorio", "movil"] : ["escritorio"]) {
            log(`Web vitals · ${profileKey} · ${runs} contexto(s) por pantalla…`)
            result.web[profileKey] = await runWebVitals({ appUrl: ctx.appUrl, cookies: sessions.escala[9].cookies, facts, profileKey, runs: profileKey === "movil" ? Math.min(runs, 2) : runs })
          }
        }

        // Ninguna salida de red del servidor ni del navegador en modo fixture.
        const outboundLog = readFileSync(outbound, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
        const hosts = outboundLog.filter((entry) => entry.host).map((entry) => entry.host)
        result.redExterna = { guardCargado: outboundLog.some((entry) => entry.guard === "activo"), hostsBloqueadosDelServidor: [...new Set(hosts)], hostsAbortadosDelNavegador: Object.values(result.web ?? {}).flatMap((w) => w.peticionesExternasAbortadas) }
        all.tamanos[scale] = result
        writeJson(outDir, `resultados-${scale}.json`, result)
        contract.push({ scale, results: contractResults(result) })
        if (!result.redExterna.guardCargado || hosts.length || result.redExterna.hostsAbortadosDelNavegador.length) fail(EXIT.VERIFICATION_FAILED, "red", "Se detectó (o no se pudo descartar) tráfico externo durante la medición.")
      } finally { stopTree(app); app = null }
    }

    if (!interrupted && sessions && wants("quota")) { all.cuota = await runQuotaScenario({ sql, dbUrl: ctx.env.SUPABASE_DB_URL, users: ctx.users }); writeJson(outDir, "cuota.json", all.cuota); log(`Cuota con dos procesos: plazas separadas ${all.cuota.distintos.separacionPlazasMinimaMs} ms como mínimo, cumple=${all.cuota.distintos.cumpleIntervalo}.`) }
    // Tamaños medidos en ejecuciones anteriores de esta misma carpeta: las tablas los incluyen.
    for (const size of SCALES) {
      if (all.tamanos[size]) continue
      try { all.tamanos[size] = JSON.parse(readFileSync(path.join(outDir, `resultados-${size}.json`), "utf8")) } catch { /* no medido todavía */ }
    }
    for (const [key, file] of [["authIdaYVuelta", "auth.json"], ["cuota", "cuota.json"]]) {
      if (all[key]) continue
      try { all[key] = JSON.parse(readFileSync(path.join(outDir, file), "utf8")) } catch { /* no medido todavía */ }
    }
    writeTables(outDir, { manifest, all })
    if (options.cleanup) { await removeScaleAccount({ profile, lockHeld: true }, deps); log("Cuenta de escala eliminada.") }
    const document = contract.length === 1 ? { schemaVersion: 1, profile, scale: contract[0].scale, results: contract[0].results } : { schemaVersion: 1, profile, scales: contract }
    writeJson(outDir, "contrato.json", document)
    if (options.json) out.write(`${JSON.stringify(document)}\n`)
    else log(`Resultados en ${path.relative(REPO_ROOT, outDir) || "."}: ${contract.reduce((n, c) => n + c.results.filter((r) => r.status === "over-budget").length, 0)} medida(s) fuera de presupuesto.`)
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

export async function runCleanup(profile = "test") {
  const result = await removeScaleAccount({ profile }, { resolveSeedTarget, seedAccounts, loadCensus })
  console.log(result.removed ? "Cuenta de escala y su biblioteca eliminadas." : `Nada que eliminar: ${result.reason}.`)
  return EXIT.OK
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const [command, ...rest] = argv[0] === "cleanup" || argv[0] === "run" ? argv : ["run", ...argv]
    if (command === "cleanup") {
      if (rest.length && !(rest.length === 2 && rest[0] === "--profile" && PERF_PROFILES.includes(rest[1]))) fail(EXIT.INVALID_ARGS, "argumentos", "Uso: perf:local:cleanup [--profile test|scratch].")
      return await runCleanup(rest[1] ?? "test")
    }
    return await runPerformance(rest)
  } catch (error) {
    const code = error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
    console.error(`Error [${error instanceof BiblibError ? error.phase : "rendimiento"}] (${code}): ${error instanceof BiblibError ? error.message : "Fallo inesperado de la medición."}`)
    return code
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { pathToFileURL } from "node:url"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"
import { acquireLock } from "../lib/state.mjs"
import { loadCensus, resolveSeedTarget, seedAccounts } from "../db/seed-local.mjs"
import { closeConnection } from "../db/target.mjs"
import { run as runProcess, stopTree } from "../../tests/integration/lib/process.mjs"
import { SCALES } from "./lib/dataset.mjs"
import { runScaleSeed } from "./scale-seed.mjs"
import { database, PERF_PROFILES, perfContext, startPerfApp } from "./lib/context.mjs"
import { openSessions } from "./lib/sessions.mjs"
import { createApp, runPass } from "./lib/load.mjs"
import { ACTION_SCENARIO_NAMES, actionScenarios, scaleFacts } from "./lib/scenarios.mjs"
import { summarize } from "./lib/stats.mjs"
import { applyVariant, VARIANT_NAMES, VARIANTS } from "./lib/t4-variants.mjs"
import { authRoundTrip, childEnvironment, GUARD, LOG_DIR, seededDataset } from "./run.mjs"

// pnpm perf:t4 — U-FIX-02. Experimento controlado de la tarea T4 de U-QA-03: ¿por qué inicio, búsqueda y
// listado de 100 filas superan 1 s con 5–10 sesiones? Mide los mismos escenarios con 1, 5 y 10 sesiones en
// varias builds que difieren en UNA sola cosa (lib/t4-variants.mjs): pool 1/2/4, con y sin la 2.ª llamada
// a GoTrue y menos idas y vueltas. Añade dos sondas que no dependen de la app: GET /auth/v1/user directo a
// Kong/GoTrue y GET /login (página pública, sin Auth ni Postgres) para la cola propia de Next.
//
// Contrato: perf:t4 [--profile test|scratch] [--scale 100|1000|10000] [--variants <lista>] [--scenarios <lista>]
//                   [--concurrency 1,5,10] [--out <dir>] [--label <nombre>]
// Mismo stack, cuentas y límites que perf:local (sesiones abiertas una vez para todas las variantes).
// Salidas: 0 mide, 2 argumentos, 3 perfil ajeno, 8 stack/puerto, 11 build fallido, tráfico externo o árbol sin restaurar.

const DEFAULT_SCENARIOS = ["dashboard", "listado-100-filas", "busqueda-local-texto"]
const ITERATIONS = { 1: 60, 5: 20, 10: 15 }
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }
const today = () => new Date().toISOString().slice(0, 10)

export function parseT4Args(argv) {
  const parsed = { profile: "test", scale: 10000, variants: [...VARIANT_NAMES], scenarios: [...DEFAULT_SCENARIOS], concurrency: [1, 5, 10], out: null, label: "experimento-t4" }
  const usage = () => fail(EXIT.INVALID_ARGS, "argumentos", `Uso: perf:t4 [--profile test|scratch] [--scale ${SCALES.join("|")}] [--variants ${VARIANT_NAMES.join(",")}] [--scenarios <lista>] [--concurrency 1,5,10] [--out <carpeta>] [--label <nombre>].`)
  const list = (value, allowed) => {
    const names = (value ?? "").split(",").filter(Boolean)
    if (!names.length || names.some((name) => !allowed.includes(name))) usage()
    return [...new Set(names)]
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === "--profile" && PERF_PROFILES.includes(value)) parsed.profile = value
    else if (flag === "--scale" && SCALES.map(String).includes(value)) parsed.scale = Number(value)
    else if (flag === "--variants") parsed.variants = list(value, VARIANT_NAMES)
    else if (flag === "--scenarios") parsed.scenarios = list(value, ACTION_SCENARIO_NAMES)
    else if (flag === "--concurrency") parsed.concurrency = list(value, ["1", "5", "10"]).map(Number).sort((a, b) => a - b)
    else if (flag === "--out" && value && !value.startsWith("--")) parsed.out = value
    else if (flag === "--label" && /^[a-z0-9-]{1,40}$/.test(value ?? "")) parsed.label = value
    else usage()
    i++
  }
  return parsed
}

/** GET /login sin cookies: página pública que no llama a GoTrue ni a Postgres. Mide la cola de Next. */
async function publicPageProbe(appUrl, levels) {
  const out = {}
  for (const concurrency of levels) {
    const times = []
    for (let i = 0; i < 3; i++) await (await fetch(`${appUrl}/login`)).arrayBuffer()
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (let i = 0; i < ITERATIONS[concurrency]; i++) {
        const started = performance.now()
        const response = await fetch(`${appUrl}/login`, { redirect: "manual" })
        await response.arrayBuffer()
        if (response.status === 200) times.push(performance.now() - started)
      }
    }))
    out[concurrency] = summarize(times)
  }
  return out
}

function treeIsClean(files) {
  if (!files.length) return true
  try { execFileSync("git", ["diff", "--quiet", "--", ...files], { cwd: REPO_ROOT, windowsHide: true }); return true } catch { return false }
}

const row = (cells) => `| ${cells.join(" | ")} |`
const pair = (s) => (s?.n ? `${s.p50} / ${s.p95}` : "—")

export function t4Table(result) {
  const lines = [row(["Variante", "Escenario", "Sesiones", "Acción p50 / p95 (ms)", "GoTrue servidor p50 / p95", "Llamadas Auth por acción", "SQL p50 / p95 (1 sesión)", "Pool máx.", "Peticiones/s", "Errores"]), row(Array(10).fill("---"))]
  for (const variant of result.variantes) {
    for (const pass of variant.acciones) {
      lines.push(row([variant.nombre, pass.escenario, String(pass.concurrencia), pair(pass.accionMs), pair(pass.authServidorMs), String(pass.llamadasAuthPorPeticion), pass.sqlMs ? pair(pass.sqlMs) : "—", String(pass.pool?.maxTotal ?? "—"), String(pass.peticionesPorSegundo), String(pass.errores)]))
    }
  }
  const probes = [row(["Variante", "Sonda", ...result.concurrencia.map((c) => `${c} en paralelo p50 / p95 (ms)`)]), row(Array(2 + result.concurrencia.length).fill("---"))]
  for (const variant of result.variantes) probes.push(row([variant.nombre, "GET /login (Next sin Auth ni DB)", ...result.concurrencia.map((c) => pair(variant.paginaPublica[c]))]))
  for (const [label, data] of [["inicio", result.authInicio], ["final", result.authFinal]]) {
    if (data) probes.push(row(["—", `GET /auth/v1/user directo a Kong (${label})`, ...result.concurrencia.map((c) => pair(data[c]))]))
  }
  return `${lines.join("\n")}\n\n${probes.join("\n")}\n`
}

export async function runT4(argv = process.argv.slice(2), out = process.stdout) {
  const options = parseT4Args(argv)
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") fail(EXIT.IDENTITY_MISMATCH, "objetivo", "El experimento solo admite BIBLIB_TARGET=local.")
  const log = (text) => out.write(`${text}\n`)
  const outDir = path.resolve(REPO_ROOT, options.out ?? path.join("docs", "validacion", "rendimiento", `${today()}-fix-02`))
  const ctx = await perfContext(options.profile)
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(outDir, { recursive: true })
  const release = acquireLock(ctx.resolved.stack)
  const sql = database(ctx, "biblib-perf")
  const poolSql = database(ctx, "biblib-perf-sampler")
  const containerName = `supabase_auth_${ctx.projectId}`
  let app, sessions, restore = null, interrupted = false
  const onInterrupt = () => { interrupted = true; restore?.(); stopTree(app) }
  process.once("SIGINT", onInterrupt)
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true }).trim()
  const result = { generadoEn: new Date().toISOString(), commit: head, perfil: options.profile, escala: options.scale, concurrencia: options.concurrency, iteraciones: ITERATIONS, escenarios: options.scenarios, variantes: [] }
  const file = path.join(outDir, `${options.label}.json`)
  const save = () => { writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`); writeFileSync(path.join(outDir, `${options.label}.md`), t4Table(result)) }
  try {
    log(`Experimento T4 · perfil ${options.profile} · ${options.scale} ejemplares · commit ${head} · variantes ${options.variants.join(", ")}`)
    const seeded = (await seededDataset(ctx, sql, options.scale)) ?? await runScaleSeed({ profile: options.profile, scale: options.scale, lockHeld: true }, { resolveSeedTarget, seedAccounts, loadCensus })
    result.dataset = { id: seeded.datasetId, hash: seeded.datasetHash, libros: seeded.books, estanterias: seeded.shelves }
    const env = childEnvironment(options.profile)
    for (const name of options.variants) {
      if (interrupted) break
      const variant = VARIANTS[name]
      log(`\n== ${name}: ${variant.factor} ==`)
      const touched = Object.keys(variant.files)
      restore = applyVariant(REPO_ROOT, name)
      let code
      try {
        code = await runProcess(process.execPath, ["scripts/next-target.mjs", "build", "local", "--profile", options.profile], { env, logFile: path.join(LOG_DIR, `t4-build-${name}.log`) })
      } finally { restore(); restore = null }
      if (!treeIsClean(touched)) fail(EXIT.VERIFICATION_FAILED, "variante", `No se restauraron los archivos de ${name}: revisa git diff antes de seguir.`)
      if (code !== 0) fail(EXIT.VERIFICATION_FAILED, "build", `Falló el build de ${name}; revisa .biblib/performance/t4-build-${name}.log.`)
      const outbound = path.join(LOG_DIR, "outbound.jsonl")
      rmSync(outbound, { force: true })
      writeFileSync(outbound, "", { mode: 0o600 })
      app = await startPerfApp(ctx, { ...env, NODE_OPTIONS: `--import=${pathToFileURL(GUARD).href}`, E2E_OUTBOUND_LOG: outbound }, { logFile: path.join(LOG_DIR, `t4-app-${name}.log`) })
      try {
        if (!sessions) {
          log("Abriendo 10 sesiones reales de la cuenta de escala (una vez para todas las variantes)…")
          sessions = await openSessions(ctx, { escala: 10, ab: false })
          result.authInicio = await authRoundTrip(ctx, sessions, { iterations: 30, levels: options.concurrency })
        }
        const facts = await scaleFacts(sql, sessions.scaleUserId)
        const appHandle = createApp({ url: ctx.appUrl, root: ctx.root })
        const entry = { nombre: name, factor: variant.factor, diagnostica: Boolean(variant.diagnostica), acciones: [] }
        entry.paginaPublica = await publicPageProbe(ctx.appUrl, options.concurrency)
        for (const scenario of actionScenarios(facts).filter((s) => options.scenarios.includes(s.name))) {
          for (const concurrency of options.concurrency) {
            if (interrupted) break
            const pass = await runPass({ app: appHandle, sessions: sessions.escala, scenario, concurrency, iterations: ITERATIONS[concurrency], sql, poolSql, containerName, attributeSql: concurrency === 1 })
            delete pass.sentencias
            entry.acciones.push(pass)
            log(`  ${scenario.name.padEnd(24)} c=${String(concurrency).padEnd(2)} p50 ${String(pass.accionMs.p50).padStart(7)} · p95 ${String(pass.accionMs.p95).padStart(7)} ms · Auth/acción ${pass.llamadasAuthPorPeticion} · pool ${pass.pool.maxTotal} · errores ${pass.errores}`)
          }
        }
        const hosts = readFileSync(outbound, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((e) => e.host)
        if (hosts.length) fail(EXIT.VERIFICATION_FAILED, "red", "Se detectó tráfico externo durante el experimento.")
        result.variantes.push(entry)
        save()
      } finally { stopTree(app); app = null }
    }
    if (sessions && !interrupted) result.authFinal = await authRoundTrip(ctx, sessions, { iterations: 30, levels: options.concurrency })
    save()
    log(`\nResultados en ${path.relative(REPO_ROOT, file)}.`)
    return interrupted ? EXIT.INTERRUPTED : EXIT.OK
  } finally {
    process.removeListener("SIGINT", onInterrupt)
    restore?.()
    stopTree(app)
    await sessions?.close()
    await closeConnection(poolSql)
    await closeConnection(sql)
    release()
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    return await runT4(argv)
  } catch (error) {
    const code = error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
    console.error(`Error [${error instanceof BiblibError ? error.phase : "experimento"}] (${code}): ${error instanceof BiblibError ? error.message : `Fallo inesperado del experimento: ${error instanceof Error ? error.message : "desconocido"}.`}`)
    return code
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

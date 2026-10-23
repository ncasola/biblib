import { performance } from "node:perf_hooks"
import { BiblibError, EXIT } from "../../lib/exit-codes.mjs"
import { decodeActionResponse, loadActions } from "../../../tests/integration/lib/app.mjs"
import { applySetCookies, cookieHeader } from "./sessions.mjs"
import { summarize } from "./stats.mjs"
import { authUserDurations, resetStatements, startPoolSampler, statementBreakdown, statementTotals, summarizeAuth } from "./probes.mjs"

// Carga de Server Actions reales de la app arrancada (HTTP, cabecera Next-Action, cookies SSR de sesiones
// de GoTrue), igual que el navegador. Sin rutas ni bypass añadidos al producto.

export function createApp({ url, root }) {
  return { url, actions: loadActions(root) }
}

/** Una invocación: `ms` va desde el envío hasta el último byte del cuerpo; la decodificación RSC queda fuera. */
export async function invoke(app, session, name, args) {
  const action = app.actions.get(name)
  if (!action) throw new BiblibError(EXIT.VERIFICATION_FAILED, "app", `La acción ${name} no está en el build.`)
  const started = performance.now()
  const response = await fetch(`${app.url}${action.route}`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(120_000),
    headers: { "Next-Action": action.id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Origin: app.url, Cookie: cookieHeader(session.cookies) },
    body: JSON.stringify(args),
  })
  const body = Buffer.from(await response.arrayBuffer())
  const ms = performance.now() - started
  applySetCookies(session, response.headers.getSetCookie())
  const ok = response.status === 200 && (response.headers.get("content-type") ?? "").startsWith("text/x-component")
  const decoded = ok ? decodeActionResponse(body) : { value: undefined, thrown: false }
  return { ms, status: response.status, bytes: body.length, value: decoded.value, thrown: decoded.thrown, ok: ok && !decoded.thrown }
}

/** Filas devueltas por la acción (libros de una página, estanterías, libros del export…). */
function rowsOf(value) {
  if (!value || typeof value !== "object") return null
  if (Array.isArray(value)) return value.length
  if (Array.isArray(value.books)) return value.books.length
  if (value.ok === true && value.value && typeof value.value === "object") return rowsOf(value.value)
  if (Array.isArray(value.recent)) return value.recent.length + (value.currentlyReading?.length ?? 0)
  return null
}

/**
 * Una pasada de carga: `concurrency` sesiones, cada una lanza `warmup + iterations` llamadas seguidas.
 * Con `attributeSql` (solo concurrencia 1) mide además, por llamada, el tiempo de ejecución SQL real
 * (diferencia de pg_stat_statements antes/después) —el resto de la medición no se ve afectada porque
 * la lectura ocurre fuera de la ventana de la petición.
 */
export async function runPass({ app, sessions, scenario, concurrency, iterations, warmup = 3, sql, containerName, attributeSql = false, poolSql }) {
  const active = sessions.slice(0, concurrency)
  if (active.length < concurrency) throw new BiblibError(EXIT.INVALID_ARGS, "carga", `Hacen falta ${concurrency} sesiones y solo hay ${active.length}.`)
  // La preparación (p. ej. elegir ID de libro) no cuenta ni se mide.
  const argsFor = (index) => scenario.args(index)
  for (let i = 0; i < warmup; i++) await invoke(app, active[0], scenario.action, argsFor(i))

  await resetStatements(sql)
  const sinceAuth = new Date(Date.now() - 500)
  const stopPool = startPoolSampler(poolSql ?? sql)
  const latencies = [], sqlMs = [], bytes = [], rows = [], failures = []
  const wallStart = performance.now()
  await Promise.all(active.map(async (session, s) => {
    for (let i = 0; i < iterations; i++) {
      const before = attributeSql ? await statementTotals(sql) : null
      const result = await invoke(app, session, scenario.action, argsFor(s * iterations + i))
      const after = attributeSql ? await statementTotals(sql) : null
      if (!result.ok) { failures.push({ status: result.status, thrown: result.thrown }); continue }
      latencies.push(result.ms)
      bytes.push(result.bytes)
      const count = rowsOf(result.value)
      if (count !== null) rows.push(count)
      if (before && after) sqlMs.push(after.ms - before.ms)
    }
  }))
  const wallMs = performance.now() - wallStart
  const pool = await stopPool()
  const untilAuth = new Date(Date.now() + 500)
  const authMs = await authUserDurations(containerName, sinceAuth, untilAuth)
  const breakdown = await statementBreakdown(sql)
  return {
    escenario: scenario.name, accion: scenario.action, concurrencia: concurrency, iteraciones: iterations,
    accionMs: summarize(latencies), sqlMs: attributeSql ? summarize(sqlMs, 2) : null,
    authServidorMs: summarizeAuth(authMs), llamadasAuthPorPeticion: Math.round((authMs.length / Math.max(1, latencies.length + failures.length)) * 100) / 100,
    filas: summarize(rows, 0), bytes: summarize(bytes, 0), errores: failures.length, peticionesPorSegundo: Math.round((latencies.length / (wallMs / 1000)) * 10) / 10,
    pool, sentencias: breakdown,
  }
}

/** Primera llamada de cada acción tras arrancar la app (proceso y conexión nuevos): el «frío» de la aplicación. */
export async function runCold({ app, session, scenarios, sql, containerName }) {
  const out = []
  for (const scenario of scenarios) {
    await resetStatements(sql)
    const since = new Date(Date.now() - 500)
    const result = await invoke(app, session, scenario.action, scenario.args(0))
    const authMs = await authUserDurations(containerName, since, new Date(Date.now() + 500))
    const totals = await statementTotals(sql)
    out.push({ escenario: scenario.name, accion: scenario.action, accionMs: Math.round(result.ms * 10) / 10, sqlMs: Math.round(totals.ms * 100) / 100, authServidorMs: authMs.map((v) => Math.round(v * 100) / 100), ok: result.ok, bytes: result.bytes })
  }
  return out
}

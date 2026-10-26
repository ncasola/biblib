import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { summarize } from "./stats.mjs"

const run = promisify(execFile)
const TAG = "/* perf */"

// Sondas de servidor para U-QA-03. Todas son de solo lectura sobre el stack propio del perfil `test`:
//  - pg_stat_statements: tiempo y filas reales de las sentencias que emite la aplicación;
//  - pg_stat_activity: conexiones del pool de la aplicación (cliente postgres.js);
//  - registro de GoTrue: duración real de cada GET /user (lo que hace `getUser()` en el proxy y en la acción).

/** Sentencias de la aplicación (rol postgres y authenticated tras `set local role`), ni de la sonda ni de pg_stat_statements. */
const APP_STATEMENTS = `userid in (select oid from pg_roles where rolname in ('postgres', 'authenticated')) and dbid = (select oid from pg_database where datname = current_database())
  and query not like '/* perf */%' and query not ilike '%pg_stat_statements%' and query not ilike '%pg_stat_activity%'`

export async function resetStatements(sql) {
  await sql.unsafe(`${TAG} select pg_stat_statements_reset()`)
}

/** Totales acumulados (ms de ejecución, sentencias y filas) de las sentencias de la aplicación. */
export async function statementTotals(sql) {
  const [row] = await sql.unsafe(`${TAG} select coalesce(sum(total_exec_time), 0)::float8 as ms, coalesce(sum(calls), 0)::int as calls, coalesce(sum(rows), 0)::int as rows from pg_stat_statements where ${APP_STATEMENTS}`)
  return row
}

/** Detalle por sentencia normalizada (sin parámetros): llamadas, media, máximo, filas por llamada y si lleva LIMIT. */
export async function statementBreakdown(sql) {
  const rows = await sql.unsafe(`${TAG} select query, calls::int, rows::float8, mean_exec_time::float8 as mean_ms, max_exec_time::float8 as max_ms, stddev_exec_time::float8 as stddev_ms,
      shared_blks_hit::float8 as hit, shared_blks_read::float8 as read
    from pg_stat_statements where ${APP_STATEMENTS} and calls > 0 order by total_exec_time desc limit 40`)
  return rows.map((row) => ({
    query: row.query.replace(/\s+/g, " ").trim(), calls: row.calls, rowsPerCall: row.calls ? Math.round((row.rows / row.calls) * 10) / 10 : 0,
    meanMs: Math.round(row.mean_ms * 1000) / 1000, maxMs: Math.round(row.max_ms * 1000) / 1000, stddevMs: Math.round(row.stddev_ms * 1000) / 1000,
    bufferHitRatio: row.hit + row.read ? Math.round((row.hit / (row.hit + row.read)) * 1000) / 1000 : null,
    hasLimit: /\blimit\b/i.test(row.query),
    selectsRows: /^\s*select\b/i.test(row.query) && !/^\s*select\s+(set_config|biblib\.lock_library)/i.test(row.query),
  }))
}

/**
 * Conexiones del pool de la aplicación (`application_name = 'postgres.js'`, el valor por defecto del
 * cliente de BibLib), muestreadas cada `intervalMs`. Devuelve el máximo simultáneo y el reparto por estado.
 */
export function startPoolSampler(sql, { intervalMs = 100 } = {}) {
  const byState = {}
  let samples = 0, maxTotal = 0, maxActive = 0, running = true, error = null
  const loop = (async () => {
    while (running) {
      try {
        const rows = await sql.unsafe(`${TAG} select state, count(*)::int as n from pg_stat_activity where application_name = 'postgres.js' and datname = current_database() group by state`)
        const total = rows.reduce((sum, row) => sum + row.n, 0)
        samples++
        maxTotal = Math.max(maxTotal, total)
        maxActive = Math.max(maxActive, rows.filter((row) => row.state !== "idle").reduce((sum, row) => sum + row.n, 0))
        for (const row of rows) byState[row.state ?? "sin estado"] = (byState[row.state ?? "sin estado"] ?? 0) + row.n
      } catch (e) { error = e instanceof Error ? e.message : "error" }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  })()
  return async () => { running = false; await loop; return { samples, maxTotal, maxActive, byState, error } }
}

/** Duraciones (ms) de `GET /user` en el registro de GoTrue del perfil, entre dos instantes. */
export async function authUserDurations(containerName, since, until) {
  const args = ["logs", "--since", since.toISOString(), "--until", until.toISOString(), containerName]
  let output = ""
  try {
    const { stdout, stderr } = await run("docker", args, { windowsHide: true, timeout: 60_000, maxBuffer: 256 * 1024 * 1024 })
    output = `${stdout}\n${stderr}`
  } catch (error) { output = `${error.stdout ?? ""}\n${error.stderr ?? ""}` }
  const durations = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes('"request completed"') || !line.includes('"path":"/user"')) continue
    try {
      const entry = JSON.parse(line)
      if (entry.path === "/user" && entry.method === "GET" && Number.isFinite(entry.duration)) durations.push(entry.duration / 1e6)
    } catch { /* línea de otro formato */ }
  }
  return durations
}

export const summarizeAuth = (durations) => summarize(durations, 2)

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { REPO_ROOT } from "../../lib/profiles.mjs"
import { fakeIsbn } from "./quota-isbn.mjs"
import { summarize } from "./stats.mjs"

// Cuota distribuida con DOS procesos independientes (U-QA-03), catálogo en fixture: cada proceso ejecuta el
// orquestador + gateway compilados contra el Postgres del perfil `test` con un proveedor simulado.
// Mide: separación real entre peticiones al proveedor, latencia por consulta, aciertos de caché y que
// el proceso no retiene una conexión de base de datos mientras espera su plaza de cuota.

const WORKER = fileURLToPath(new URL("./quota-worker.mjs", import.meta.url))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const count = (lookups) => lookups.reduce((acc, l) => ({ ...acc, [l.status]: (acc[l.status] ?? 0) + 1 }), {})

function runWorker(dbUrl, task) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify(task)], { cwd: REPO_ROOT, env: { ...process.env, BIBLIB_PERF_DB_URL: dbUrl }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let out = "", err = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { err += chunk })
    const timer = setTimeout(() => child.kill(), 120_000)
    child.once("error", reject)
    child.once("close", (code) => {
      clearTimeout(timer)
      try { resolve({ code, ...JSON.parse(out.trim().split("\n").at(-1)) }) } catch { reject(new Error(`El proceso de cuota no devolvió JSON (código ${code}): ${err.slice(0, 200)}`)) }
    })
  })
}

/** Muestrea las conexiones de los procesos de prueba: inactivas en transacción, activas y totales, y la transacción más larga. */
function startWorkerSampler(sql, applicationName) {
  let running = true, samples = 0, maxTotal = 0, maxActive = 0, maxIdleInTransaction = 0, maxXactMs = 0
  const loop = (async () => {
    while (running) {
      try {
        const rows = await sql.unsafe(`/* perf */ select state, count(*)::int as n, coalesce(max(extract(epoch from clock_timestamp() - xact_start) * 1000), 0)::float8 as xact_ms from pg_stat_activity where application_name = '${applicationName}' group by state`)
        samples++
        maxTotal = Math.max(maxTotal, rows.reduce((sum, row) => sum + row.n, 0))
        maxActive = Math.max(maxActive, rows.filter((row) => row.state === "active").reduce((sum, row) => sum + row.n, 0))
        maxIdleInTransaction = Math.max(maxIdleInTransaction, rows.filter((row) => row.state?.startsWith("idle in transaction")).reduce((sum, row) => sum + row.n, 0))
        maxXactMs = Math.max(maxXactMs, ...rows.map((row) => row.xact_ms))
      } catch { /* una muestra perdida no invalida la medición */ }
      await sleep(25)
    }
  })()
  return async () => { running = false; await loop; return { muestras: samples, conexionesMaximas: maxTotal, activasMaximas: maxActive, enTransaccionInactivaMaximas: maxIdleInTransaction, transaccionMasLargaMs: Math.round(maxXactMs) } }
}

export async function runQuotaScenario({ sql, dbUrl, users, perProcess = 6 }) {
  const scope = `perf-${randomBytes(6).toString("hex")}`
  const applicationName = `biblib-perf-${scope.slice(5)}`
  const cleanup = async () => {
    await sql`delete from biblib.catalogue_cache where credential_scope = ${scope}`
    await sql`delete from biblib.catalogue_inflight where credential_scope = ${scope}`
    await sql`delete from biblib.catalogue_private_cache where credential_scope = ${scope}`
    await sql`delete from biblib.catalogue_quota_reservations where credential_scope = ${scope}`
    await sql`delete from biblib.catalogue_quota_buckets where credential_scope = ${scope}`
  }
  try {
    // 1) Dos procesos piden ISBN distintos a la vez: la cuota global de Open Library es 1 petición/s.
    const own = (offset) => Array.from({ length: perProcess }, (_, i) => fakeIsbn(offset + i))
    const stop = startWorkerSampler(sql, applicationName)
    const startAt = Date.now() + 2000
    const [one, two] = await Promise.all([
      runWorker(dbUrl, { scope, owner: users.a, isbns: own(1), startAt, applicationName }),
      runWorker(dbUrl, { scope, owner: users.b, isbns: own(101), startAt, applicationName }),
    ])
    const conexiones = await stop()
    // Autoridad de la cuota: la separación entre las plazas que reservó la base (reloj de Postgres), no la hora a la que despierta cada proceso.
    const slotGaps = (await sql`select (extract(epoch from slot_at - lag(slot_at) over (order by slot_at)) * 1000)::float8 as gap from biblib.catalogue_quota_reservations where credential_scope = ${scope} and provider = 'open-library' order by slot_at`).map((r) => r.gap).filter((gap) => gap !== null)
    const times = [...one.calls, ...two.calls].map((call) => call.at).sort((x, y) => x - y)
    const gaps = times.slice(1).map((time, i) => time - times[i])
    const distintos = {
      procesos: 2, consultasPorProceso: perProcess, peticionesAlProveedor: times.length, intervaloOLms: 1000,
      separacionPlazasMinimaMs: slotGaps.length ? Math.round(Math.min(...slotGaps)) : null, plazasReservadas: slotGaps.length + 1,
      separacionMinimaMs: gaps.length ? Math.min(...gaps) : null, separacionMediaMs: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
      // La garantía es la separación de las plazas reservadas por la base; la hora real de cada petición añade jitter de planificación del proceso.
      cumpleIntervalo: slotGaps.length > 0 && slotGaps.every((gap) => gap >= 1000),
      jitterObservadoMs: gaps.length ? Math.max(0, 1000 - Math.min(...gaps)) : null,
      duracionTotalMs: times.length ? times.at(-1) - times[0] : null,
      latenciaConsultaMs: summarize([...one.lookups, ...two.lookups].map((l) => l.ms), 0),
      estados: count([...one.lookups, ...two.lookups]), conexiones,
    }
    // 2) Los mismos ISBN otra vez, desde el otro proceso: caché compartida, sin peticiones al proveedor.
    const again = await runWorker(dbUrl, { scope, owner: users.b, isbns: own(1), applicationName })
    const aciertosDeCache = { consultas: again.lookups.length, peticionesAlProveedor: again.calls.length, latenciaMs: summarize(again.lookups.map((l) => l.ms), 1), estados: count(again.lookups) }
    // 3) El mismo ISBN nuevo pedido a la vez por los dos procesos: una única consulta en vuelo.
    const shared = [fakeIsbn(500)]
    const startAt2 = Date.now() + 1500
    const [x, y] = await Promise.all([
      runWorker(dbUrl, { scope, owner: users.a, isbns: shared, startAt: startAt2, providerLatencyMs: 400, applicationName }),
      runWorker(dbUrl, { scope, owner: users.b, isbns: shared, startAt: startAt2, providerLatencyMs: 400, applicationName }),
    ])
    const consultaEnVueloCompartida = { procesos: 2, peticionesAlProveedor: x.calls.length + y.calls.length, estados: [...x.lookups, ...y.lookups].map((l) => l.status) }
    return { distintos, aciertosDeCache, consultaEnVueloCompartida }
  } finally { await cleanup() }
}

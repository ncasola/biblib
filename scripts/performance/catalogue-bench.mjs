// Benchmark del catálogo con red simulada (U-BIB-05). Mide el comportamiento de BibLib frente a 1, 10 y 100
// consultas concurrentes: latencia p50/p95, deduplicación, cola, plazos y tamaño de caché. NO mide el
// rendimiento de Open Library, BNE ni de Internet: la red es un simulador local con latencias inventadas
// y el tiempo es virtual (x10) para no esperar los intervalos reales del proveedor.
//
//   pnpm perf:catalogue [--build] [--out ruta.json] [--check]
//
// Usa el código compilado de pruebas (.next/tests, lo genera `pnpm test` o `--build`): el orquestador, el
// adaptador de Open Library y el gateway reales sobre un store de coordinación en memoria. Sin Docker, sin
// claves y sin red. Con --check devuelve 1 si se viola un invariante (peticiones al proveedor por encima de
// su límite, duplicados que salen dos veces, plazos superados o fallos contados como «no encontrado»).
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const compiled = (file) => path.join(repo, ".next", "tests", file)
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }

if (args.some((arg) => arg.startsWith("--") && !["--build", "--check", "--out"].includes(arg)) || (flag("--out") && !option("--out"))) {
  console.error("Uso: node scripts/performance/catalogue-bench.mjs [--build] [--out ruta.json] [--check]")
  process.exit(2)
}
if (flag("--build") || !existsSync(compiled("lib/bibliographic-catalog/orchestrator.js")) || !existsSync(compiled("tests/support/catalogue-memory-store.js"))) {
  console.log("Compilando las pruebas (tsc -p tsconfig.tests.json)…")
  const build = spawnSync(process.execPath, [path.join(repo, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.tests.json"], { cwd: repo, stdio: "inherit" })
  if (build.status !== 0) { console.error("No se pudo compilar el código de pruebas."); process.exit(1) }
}

const require = createRequire(import.meta.url)
const { createBibliographicCatalogService } = require(compiled("lib/bibliographic-catalog/orchestrator.js"))
const { createOpenLibraryProvider } = require(compiled("lib/bibliographic-catalog/providers/open-library.js"))
const { OPEN_LIBRARY_HOST } = require(compiled("lib/bibliographic-catalog/providers/endpoints.js"))
const { createCatalogGateway } = require(compiled("lib/bibliographic-catalog/gateway.js"))
const { memoryStore } = require(compiled("tests/support/catalogue-memory-store.js"))

/** Tiempo virtual: cada milisegundo real equivale a SCALE virtuales. Todos los plazos se escalan igual. */
const SCALE = 10
const ORIGIN = Date.parse("2026-10-23T10:00:00Z")
const CATALOG_DEADLINE_MS = 8_000
const PROVIDER_DEADLINE_MS = 3_500
const OPEN_LIBRARY_INTERVAL_MS = 1_000
const BASE_LATENCY_MS = 180
const LEVELS = [1, 10, 100]

function createClock() {
  const started = performance.now()
  return { get now() { return ORIGIN + (performance.now() - started) * SCALE } }
}

const sleep = (virtualMs, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return }
  const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve() }, Math.max(0, virtualMs) / SCALE)
  signal?.addEventListener("abort", onAbort, { once: true })
})

/** Generador pseudoaleatorio determinista (mulberry32): mismas latencias y fallos en cada ejecución. */
function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function isbn13(index) {
  const base = String(978840140000 + index)
  const sum = [...base].reduce((total, digit, position) => total + Number(digit) * (position % 2 ? 3 : 1), 0)
  return `${base}${(10 - sum % 10) % 10}`
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))])
}

/** Servidor simulado de Open Library: latencia determinista, cuelgues y 429 inyectados. */
function simulatedProvider(clock, rng, faults) {
  const log = []
  let inFlight = 0
  let maxInFlight = 0
  const fetchImpl = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname !== OPEN_LIBRARY_HOST) throw new TypeError("Destino fuera del simulador")
    const isbn = url.searchParams.get("bibkeys")?.replace("ISBN:", "")
    const at = clock.now
    const roll = rng()
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      if (roll < faults.hang) {
        log.push({ isbn, at, outcome: "hang" })
        await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true }))
      }
      await sleep(BASE_LATENCY_MS * (0.5 + rng()), init?.signal)
      if (roll < faults.hang + faults.limited) {
        log.push({ isbn, at, outcome: "429" })
        return new Response(null, { status: 429, headers: { "Retry-After": "3" } })
      }
      log.push({ isbn, at, outcome: "ok" })
      return Response.json({ [`ISBN:${isbn}`]: { title: `Libro simulado ${isbn}`, authors: [{ name: "Autora ficticia" }], cover: { large: `https://covers.invalid/${isbn}-L.jpg` }, identifiers: { isbn_13: [isbn] } } })
    } finally { inFlight-- }
  }
  return { fetch: fetchImpl, log, get maxInFlight() { return maxInFlight } }
}

/** Una instancia del servicio con su gateway sobre un store en memoria; el reloj es el virtual. */
function createService(clock, network) {
  const shared = memoryStore(clock)
  // Cola: reservas concedidas y todavía sin liberar (esperando su plaza o con la petición en vuelo).
  const queue = { current: 0, max: 0 }
  // Deduplicación: claves que esperaron la consulta en vuelo de otra solicitud y aciertos de caché compartida.
  const dedupe = { waitedKeys: new Set(), cacheHits: 0 }
  const store = {
    ...shared.store,
    async begin(key, options) {
      const decision = await shared.store.begin(key, options)
      if (decision.state === "pending") dedupe.waitedKeys.add(key.key)
      if (decision.state === "hit") dedupe.cacheHits++
      return decision
    },
    async reserve(request) {
      const decision = await shared.store.reserve(request)
      if (decision.state === "reserved") { queue.current++; queue.max = Math.max(queue.max, queue.current) }
      return decision
    },
    async release(...release) {
      const done = await shared.store.release(...release)
      if (done) queue.current--
      return done
    },
  }
  const gateway = createCatalogGateway({ store, fetch: network.fetch, sleep, pollMs: 150 })
  const adapter = createOpenLibraryProvider({ fetch: gateway.fetch, now: () => clock.now, wait: (ms) => sleep(ms), timeoutMs: CATALOG_DEADLINE_MS / SCALE })
  return { service: createBibliographicCatalogService({ providers: [{ id: "open-library", enabled: true, adapter }], gateway }), shared, queue, dedupe }
}

/** Máximo de peticiones iniciadas en cualquier ventana de un segundo virtual. */
function maxRate(entries) {
  const starts = entries.map((entry) => entry.at).sort((a, b) => a - b)
  let best = 0
  for (let i = 0; i < starts.length; i++) {
    let j = i
    while (j < starts.length && starts[j] - starts[i] < 1_000) j++
    best = Math.max(best, j - i)
  }
  return best
}

/** Calienta el JIT y los módulos para que la primera consulta medida no incluya el arranque del proceso. */
async function warmUp() {
  const clock = createClock()
  const network = simulatedProvider(clock, random(1), { hang: 0, limited: 0 })
  const { service } = createService(clock, network)
  for (let index = 0; index < 4; index++) await service.lookupISBN(isbn13(900 + index), { userId: "00000000-0000-4000-8000-000000000001" })
}

async function runLevel(level, phase, setup, queries) {
  const { clock, network, service } = setup
  const upstreamBefore = network.log.length
  // ISBN que el proveedor ya devolvió antes de esta fase: no deberían volver a salir mientras la caché los guarde.
  const resolved = new Set(network.log.filter((entry) => entry.outcome === "ok").map((entry) => entry.isbn))
  // Cada consulta es de una cuenta distinta: la cuota por cuenta no oculta el reparto del límite del proveedor.
  const results = await Promise.all(queries.map(async (isbn, index) => {
    const started = clock.now
    const result = await service.lookupISBN(isbn, { userId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, timeoutMs: CATALOG_DEADLINE_MS / SCALE, providerTimeoutMs: PROVIDER_DEADLINE_MS / SCALE })
    return { latency: clock.now - started, result }
  }))
  const upstream = network.log.slice(upstreamBefore)
  const latencies = results.map((entry) => entry.latency).sort((a, b) => a - b)
  const count = (predicate) => results.filter(({ result }) => predicate(result)).length
  const perIsbn = new Map()
  for (const entry of upstream) perIsbn.set(entry.isbn, (perIsbn.get(entry.isbn) ?? 0) + 1)
  return {
    consultasConcurrentes: level, fase: phase, consultasDistintas: new Set(queries).size,
    p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95), maxMs: Math.round(latencies.at(-1)),
    encontradas: count((result) => result.status === "found"), ausencias: count((result) => result.status === "notFound"),
    incompletas: count((result) => result.status === "incomplete"),
    limitadas: count((result) => result.providers.some((provider) => provider.status === "rateLimited")),
    plazosAgotados: count((result) => result.deadlineExceeded || result.providers.some((provider) => provider.reason === "deadline")),
    peticionesAlProveedor: upstream.length,
    repeticionesDeLoYaResuelto: upstream.filter((entry) => resolved.has(entry.isbn)).length,
    // Consultas atendidas sin salir al proveedor: duplicados concurrentes y aciertos de caché.
    consultasSinSalida: queries.length - upstream.length,
    duplicadosQueSalieronDosVeces: [...perIsbn.values()].filter((n) => n > 1).length,
    peticionesPorSegundoVirtualMax: maxRate(upstream),
    clavesDeduplicadas: setup.dedupe.waitedKeys.size, aciertosDeCache: setup.dedupe.cacheHits,
    colaMaxima: setup.queue.max, concurrenciaMaximaAlProveedor: network.maxInFlight,
    entradasDeCache: setup.shared.cache.size,
    bytesDeCache: [...setup.shared.cache.values()].reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.payload)), 0),
  }
}

await warmUp()
const rows = []
for (const level of LEVELS) {
  // Fría y caliente: la mitad de las consultas repite ISBN para medir la deduplicación de consultas simultáneas.
  const unique = Math.max(1, Math.ceil(level / 2))
  const queries = Array.from({ length: level }, (_, index) => isbn13(level * 1000 + (index % unique)))
  const clock = createClock()
  const network = simulatedProvider(clock, random(level), { hang: 0, limited: 0 })
  const setup = { clock, network, ...createService(clock, network) }
  rows.push(await runLevel(level, "fría", setup, queries))
  rows.push(await runLevel(level, "caliente", setup, queries))
  // Con fallos: el 15 % de las peticiones al proveedor no responde y otro 10 % devuelve 429.
  const faultyClock = createClock()
  const faultyNetwork = simulatedProvider(faultyClock, random(level + 7), { hang: 0.15, limited: 0.1 })
  const faulty = { clock: faultyClock, network: faultyNetwork, ...createService(faultyClock, faultyNetwork) }
  rows.push(await runLevel(level, "con fallos", faulty, Array.from({ length: level }, (_, index) => isbn13(level * 2000 + index))))
  // Sin respuesta: el proveedor no contesta nunca; el plazo de la fuente corta cada consulta y el resultado es «incompleto».
  const silentClock = createClock()
  const silentNetwork = simulatedProvider(silentClock, random(level + 13), { hang: 1, limited: 0 })
  const silent = { clock: silentClock, network: silentNetwork, ...createService(silentClock, silentNetwork) }
  rows.push(await runLevel(level, "sin respuesta", silent, Array.from({ length: level }, (_, index) => isbn13(level * 3000 + index))))
}

const columns = ["consultasConcurrentes", "fase", "p50Ms", "p95Ms", "peticionesAlProveedor", "consultasSinSalida", "clavesDeduplicadas", "aciertosDeCache", "limitadas", "plazosAgotados", "colaMaxima", "entradasDeCache", "bytesDeCache"]
console.log(`Benchmark del catálogo con red SIMULADA (tiempo virtual x${SCALE}; latencias en ms virtuales). No mide rendimiento externo.`)
console.table(rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))))

const FAULT_PHASES = ["con fallos", "sin respuesta"]
const violations = []
for (const row of rows) {
  const where = `${row.consultasConcurrentes} consultas · ${row.fase}`
  if (row.peticionesPorSegundoVirtualMax > 2) violations.push(`${where}: ${row.peticionesPorSegundoVirtualMax} peticiones en un segundo virtual (el proveedor admite 1 por segundo)`)
  if (!FAULT_PHASES.includes(row.fase) && row.duplicadosQueSalieronDosVeces > 0) violations.push(`${where}: consultas duplicadas que salieron dos veces`)
  if (row.concurrenciaMaximaAlProveedor > 2) violations.push(`${where}: ${row.concurrenciaMaximaAlProveedor} peticiones simultáneas al proveedor`)
  if (row.fase === "sin respuesta" && row.plazosAgotados === 0) violations.push(`${where}: el plazo de la fuente no cortó ninguna consulta`)
  if (row.maxMs > CATALOG_DEADLINE_MS * 1.5) violations.push(`${where}: una consulta tardó ${row.maxMs} ms, por encima del plazo común de ${CATALOG_DEADLINE_MS} ms`)
  if (FAULT_PHASES.includes(row.fase) && row.ausencias > 0) violations.push(`${where}: un fallo del proveedor se contó como «no encontrado»`)
  if (row.repeticionesDeLoYaResuelto > 0) violations.push(`${where}: ${row.repeticionesDeLoYaResuelto} petición(es) por ISBN ya resueltos y en caché`)
}
const report = { simulated: true, scale: SCALE, deadlines: { commonMs: CATALOG_DEADLINE_MS, providerMs: PROVIDER_DEADLINE_MS }, openLibraryIntervalMs: OPEN_LIBRARY_INTERVAL_MS, rows, violations }
const target = option("--out")
if (target) {
  mkdirSync(path.dirname(path.resolve(target)), { recursive: true })
  writeFileSync(path.resolve(target), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Informe JSON: ${path.resolve(target)}`)
}
if (violations.length) {
  for (const violation of violations) console.error(`Invariante violado · ${violation}`)
  if (flag("--check")) process.exitCode = 1
} else {
  console.log("Invariantes: sin peticiones por encima del límite del proveedor, sin duplicados repetidos ni plazos superados.")
}

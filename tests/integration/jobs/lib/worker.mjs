import { writeSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import postgres from "postgres"
import { REPO_ROOT } from "../../../../scripts/lib/profiles.mjs"

// Proceso trabajador independiente del grupo jobs (U-DAT-03): ejecuta el worker compilado contra el
// Postgres local con el servicio bibliográfico U-BIB y el gateway U-DAT-05 en modo lote. El fetch es
// simulado: registra la clave ficticia pedida y responde según la tarea, nunca sale a Internet.
// Los puntos `kill` terminan el proceso de golpe (137) para simular una caída.

const require = createRequire(import.meta.url)
const build = path.join(REPO_ROOT, ".next", "tests", "lib")
const { createJobDatabase, createJobRepository } = require(path.join(build, "jobs", "repository.js"))
const { runJobStep, drainJobs } = require(path.join(build, "jobs", "worker.js"))
const { createCatalogGateway, createPostgresCoordinationStore } = require(path.join(build, "bibliographic-catalog", "gateway.js"))
const { createBibliographicCatalogService } = require(path.join(build, "bibliographic-catalog", "orchestrator.js"))
const { createOpenLibraryProvider } = require(path.join(build, "bibliographic-catalog", "providers", "open-library.js"))

const task = JSON.parse(process.argv[2])
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)))
const sql = postgres(process.env.BIBLIB_JOBS_TEST_DB_URL, { max: 3, prepare: false, ssl: false, connect_timeout: 5, idle_timeout: 5, onnotice: () => {}, connection: { application_name: "biblib-jobs-worker", statement_timeout: 30_000 } })
const calls = []
const events = []

function record(isbn, coverId) {
  return { title: "Ficha ficticia", authors: [{ name: "Autoría ficticia" }], identifiers: { isbn_13: [isbn] }, url: `https://openlibrary.org/books/OL${isbn.slice(-6)}M`,
    ...(coverId ? { cover: { small: `https://covers.openlibrary.org/b/id/${coverId}-S.jpg`, medium: `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`, large: `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` } } : {}) }
}

async function mockFetch(input) {
  const url = new URL(input instanceof Request ? input.url : input)
  const key = url.searchParams.get("bibkeys") ?? url.pathname
  const isbn = key.replace(/^ISBN:/, "")
  calls.push({ at: Date.now(), isbn })
  // Solo los ISBN sintéticos del run (979-0-0003…) tienen ficha; los de los fixtures A/B nunca reciben
  // portada, así que una prueba no modifica los libros del seed.
  const synthetic = isbn.startsWith("97900003")
  await sleep(synthetic ? task.delayMs ?? 0 : 0)
  const reply = task.replies?.[isbn] ?? (synthetic ? task.reply ?? "found" : "missing")
  if (reply === "429") return new Response(null, { status: 429, headers: { "Retry-After": String(task.retryAfter ?? 3) } })
  if (reply === "503") return new Response(null, { status: 503 })
  if (reply === "broken") return new Response("{\"ISBN:roto", { status: 200, headers: { "Content-Type": "application/json" } })
  if (reply === "missing") return Response.json({})
  return Response.json({ [key]: record(isbn, Number(isbn.slice(-5))) })
}

const gateway = createCatalogGateway({ store: createPostgresCoordinationStore(sql), fetch: mockFetch, credentialScope: task.scope, leaseMs: 4000, pollMs: 50 })
const batch = { ...gateway, execute: (request, fetcher, context) => gateway.execute({ ...request, purpose: "batch" }, fetcher, context) }
const catalog = createBibliographicCatalogService({ providers: [{ id: "open-library", enabled: true, adapter: createOpenLibraryProvider({ fetch: gateway.fetch }) }], gateway: batch })

function print(extra = {}) {
  writeSync(1, `${JSON.stringify({ calls, events, ...extra })}\n`)
}

/** Acción en un punto del paso: morir (caída real del proceso) o esperar (para cancelar o bloquear en medio). */
function hook(point) {
  const action = task.at?.[point]
  if (!action) return undefined
  return async (job) => {
    events.push({ point, at: Date.now(), fencing: job.fencing })
    if (action === "kill") { print({ killed: point }); process.exit(137) }
    if (typeof action === "number") await sleep(action)
  }
}

async function main() {
  if (task.startAt) await sleep(task.startAt - Date.now())
  const deps = {
    repo: createJobRepository(createJobDatabase(sql)), catalog, random: () => 0,
    limits: task.limits ?? {},
    hooks: { afterFetch: hook("afterFetch"), beforeCommit: hook("beforeCommit"), afterCommit: hook("afterCommit") },
  }
  const filter = { ...(task.jobId ? { jobId: task.jobId } : {}), ...(task.owner ? { owner: task.owner } : {}) }
  const reports = task.drain ? await drainJobs(deps, filter, task.budgetMs ?? 30_000) : [await runJobStep(deps, filter)].filter(Boolean)
  print({ reports })
}

try { await main() } finally { await sql.end({ timeout: 2 }).catch(() => {}) }

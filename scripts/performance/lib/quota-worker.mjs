import { writeSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import postgres from "postgres"
import { REPO_ROOT } from "../../lib/profiles.mjs"

// Proceso de aplicación simulado para la medición de cuota distribuida (U-QA-03): ejecuta el orquestador y
// el gateway compilados —el mismo código que `lib/bibliographic-catalog/server.ts`— con su propia conexión
// de coordinación (max 2, plazos cortos) y un `fetch` de proveedor simulado. Nunca sale a Internet: el
// `fetch` solo registra la hora y la clave ficticia. Responde con una línea JSON.

const require = createRequire(import.meta.url)
const build = path.join(REPO_ROOT, ".next", "tests", "lib", "bibliographic-catalog")
const { createCatalogGateway, createPostgresCoordinationStore } = require(path.join(build, "gateway.js"))
const { createBibliographicCatalogService } = require(path.join(build, "orchestrator.js"))
const { createOpenLibraryProvider } = require(path.join(build, "providers", "open-library.js"))

const task = JSON.parse(process.argv[2])
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)))
const sql = postgres(process.env.BIBLIB_PERF_DB_URL, { max: 2, prepare: false, ssl: false, connect_timeout: 5, idle_timeout: 20, onnotice: () => {}, connection: { application_name: task.applicationName, statement_timeout: 3000, lock_timeout: 2000 } })
const calls = []

async function mockFetch(input) {
  const url = new URL(input instanceof Request ? input.url : input)
  const key = url.searchParams.get("bibkeys") ?? url.pathname
  calls.push({ at: Date.now(), host: url.hostname })
  await sleep(task.providerLatencyMs ?? 5)
  const isbn = key.replace(/^ISBN:/, "")
  return Response.json({ [key]: { title: "Ficha ficticia de escala", authors: [{ name: "Autor ficticio" }], identifiers: { isbn_13: [isbn] }, url: `https://openlibrary.org/books/OL${isbn.slice(-6)}M` } })
}

const gateway = createCatalogGateway({ store: createPostgresCoordinationStore(sql), fetch: mockFetch, credentialScope: task.scope, leaseMs: 12_000, pollMs: 50 })
const catalog = createBibliographicCatalogService({ providers: [{ id: "open-library", enabled: true, adapter: createOpenLibraryProvider({ fetch: gateway.fetch }) }], gateway })

try {
  if (task.startAt) await sleep(task.startAt - Date.now())
  const lookups = []
  for (const isbn of task.isbns) {
    const started = performance.now()
    const result = await catalog.lookupISBN(isbn, { userId: task.owner })
    lookups.push({ ms: performance.now() - started, status: result.status, provider: result.providers[0]?.status ?? null })
  }
  writeSync(1, `${JSON.stringify({ calls, lookups })}\n`)
} finally { await sql.end({ timeout: 2 }).catch(() => {}) }

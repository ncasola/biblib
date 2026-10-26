import { writeSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import postgres from "postgres"
import { REPO_ROOT } from "../../../../scripts/lib/profiles.mjs"

// Proceso independiente del grupo catalogue: ejecuta el gateway compilado contra Postgres local con
// un fetch simulado. Nunca sale a Internet: el fetch registra la hora y la clave ficticia pedida.

const require = createRequire(import.meta.url)
const build = path.join(REPO_ROOT, ".next", "tests", "lib", "bibliographic-catalog")
const { createCatalogGateway, createPostgresCoordinationStore, QuotaDeferredError } = require(path.join(build, "gateway.js"))
const { createBibliographicCatalogService } = require(path.join(build, "orchestrator.js"))
const { createOpenLibraryProvider } = require(path.join(build, "providers", "open-library.js"))
const { hasProviderRight, providerRightsPolicy } = require(path.join(build, "rights.js"))

const task = JSON.parse(process.argv[2])
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)))
const sql = postgres(process.env.BIBLIB_CATALOGUE_TEST_DB_URL, { max: 2, prepare: false, ssl: false, connect_timeout: 3, idle_timeout: 5, onnotice: () => {}, connection: { application_name: "biblib-catalogue-worker", statement_timeout: 5000 } })
const store = createPostgresCoordinationStore(sql)
const calls = []

function record(isbn) {
  return { title: task.title ?? "Ficha ficticia compartida", authors: [{ name: "Autor ficticio" }], identifiers: { isbn_13: [isbn] }, url: `https://openlibrary.org/books/OL${isbn.slice(-6)}M` }
}

async function mockFetch(input) {
  const url = new URL(input instanceof Request ? input.url : input)
  const key = url.searchParams.get("bibkeys") ?? url.pathname
  calls.push({ at: Date.now(), host: url.hostname, key })
  await sleep(task.delayMs ?? 0)
  if (task.reply === "429") return new Response(null, { status: 429, headers: { "Retry-After": String(task.retryAfter ?? 2) } })
  if (task.reply === "503") return new Response(null, { status: 503 })
  if (url.hostname.endsWith("bne.es")) return new Response("<sru/>", { status: 200 })
  const isbn = key.replace(/^ISBN:/, "")
  return Response.json(task.reply === "missing" ? {} : { [key]: record(isbn) })
}

const rights = task.denyCache ? { policy: providerRightsPolicy, allows: (policy, capability) => capability !== "cacheMetadata" && hasProviderRight(policy, capability) } : undefined
const gateway = createCatalogGateway({ store, fetch: mockFetch, credentialScope: task.scope, leaseMs: task.leaseMs ?? 4000, pollMs: 50, rights, privateKeySecret: task.secret })
const catalog = createBibliographicCatalogService({ providers: [{ id: "open-library", enabled: true, adapter: createOpenLibraryProvider({ fetch: gateway.fetch }) }], gateway })
const summary = (result) => ({ status: result.status, providers: result.providers.map(({ provider, status, reason, retryAfterSeconds }) => ({ provider, status, reason, retryAfterSeconds })), candidates: result.candidates })

async function main() {
  if (task.startAt) await sleep(task.startAt - Date.now())
  const results = []
  if (task.mode === "lookup") for (const isbn of task.isbns) results.push(summary(await catalog.lookupISBN(isbn, { userId: task.owner })))
  else if (task.mode === "cover") for (const isbn of task.isbns) results.push(summary(await catalog.getCover(isbn, { userId: task.owner })))
  else if (task.mode === "batch") {
    // Lote de importación: fuera del orquestador, con dueño y propósito explícitos.
    const batchFetch = gateway.bind({ owner: task.owner, purpose: "batch" })
    for (const isbn of task.isbns) {
      try { results.push({ status: (await batchFetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`)).status }) } catch (error) { results.push({ deferred: error instanceof QuotaDeferredError, retryAfterMs: error.retryAfterMs }) }
    }
  } else if (task.mode === "fetch") {
    results.push(...await Promise.all(task.urls.map(async (url) => {
      try { return { status: (await gateway.bind({ owner: task.owner, purpose: "interactive" })(url)).status } } catch (error) { return { deferred: error instanceof QuotaDeferredError } }
    })))
  } else if (task.mode === "text") {
    // Búsqueda de texto con un adaptador ficticio: la consulta solo viaja como HMAC a la caché privada.
    const candidate = { provider: "open-library", level: "work", isbns: [], authors: [{ name: "Autor ficticio" }], publishers: [], evidence: { isbnExact: false }, retrievedAt: "2026-10-23T00:00:00.000Z", title: "Obra ficticia" }
    const fetcher = async () => { calls.push({ at: Date.now(), host: "texto", key: "consulta" }); return { provider: "open-library", requestId: "r", status: "found", value: [candidate] } }
    for (let i = 0; i < 2; i++) results.push((await gateway.execute({ provider: "open-library", operation: "searchTitleAuthor", key: task.query, owner: task.owner }, fetcher, { signal: new AbortController().signal, requestId: "00000000-0000-4000-8000-000000000001" })).status)
  } else if (task.mode === "die") {
    // Reserva concesión y cuota y muere sin completar ni liberar (proceso terminado de golpe).
    const key = { provider: "open-library", policyVersion: providerRightsPolicy("open-library").version, scope: task.scope, schemaVersion: 1, operation: "lookupISBN", key: task.isbns[0] }
    const lease = await store.begin(key, { useCache: true, leaseMs: task.leaseMs ?? 1500 })
    const quota = await store.reserve({ provider: "open-library", scope: task.scope, owner: task.owner, purpose: "interactive", intervalMs: 1000, horizonMs: 2500, ownerCap: 2, leaseMs: 10000 })
    writeSync(1, `${JSON.stringify({ calls, results: [{ lease: lease.state, quota: quota.state, reservationId: quota.reservationId }] })}\n`)
    process.exit(137)
  }
  writeSync(1, `${JSON.stringify({ calls, results })}\n`)
}

try { await main() } finally { await sql.end({ timeout: 2 }).catch(() => {}) }

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { test } from "node:test"
import { runInNewContext } from "node:vm"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { normalizeBookCover } from "../lib/book-covers"
import { readCatalogConfig } from "../lib/bibliographic-catalog/config"
import { createConfiguredCatalog } from "../lib/bibliographic-catalog/registry"
import type { BibliographicCatalogService, CoverCandidate } from "../lib/bibliographic-catalog/types"
import type { Book } from "../lib/types"

// Como las pruebas de componentes existentes: ejecuta el módulo real, sustituyendo solo sus
// fronteras de Next/Auth/DB. Los lectores, el enriquecimiento y el catálogo fixture son reales.
function loadSource<T>(file: string, dependencies: Record<string, unknown>): T {
  const compiledRequire = createRequire(path.resolve(".next/tests", file.replace(/\.tsx?$/, ".js")))
  const code = transpileModule(readFileSync(file, "utf8"), { compilerOptions: {
    module: ModuleKind.CommonJS, target: ScriptTarget.ES2022,
  } }).outputText
  const exports = {}
  runInNewContext(code, { exports, require: (id: string) => {
    if (id in dependencies) return dependencies[id]
    if (id === "server-only") return {}
    return compiledRequire(id.startsWith("@/") ? path.resolve(".next/tests", id.slice(2)) : id)
  } })
  return exports as T
}

const book: Book = {
  id: "11111111-1111-4111-8111-111111111111", version: "22222222-2222-4222-8222-222222222222",
  isbn: "9780000000019", title: "Libro ficticio", authors: [], number_of_pages: 0,
  publish_date: "", status: "unread", shelf_id: "shelf-1", shelf_name: "Predeterminada", cover: normalizeBookCover(),
}

test("fixture: recuperación y búsqueda legacy terminan sin ninguna llamada fetch", async (t) => {
  const previous = { ...process.env }
  t.after(() => { process.env = previous })
  process.env.BIBLIB_TARGET = "test"
  process.env.BIBLIB_CATALOGUE_MODE = "fixture"
  process.env.BIBLIB_GOOGLE_BOOKS_ENABLED = "false"
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Salida de red prohibida en fixture") })
  const original = structuredClone(book)

  const catalog = createConfiguredCatalog(readCatalogConfig())
  const client = loadSource<{ searchBookByISBN: (isbn: string) => Promise<Book | null> }>("lib/api-client.ts", {
    "./bibliographic-catalog/server": { bibliographicCatalog: catalog },
    "./observability/server": { withActionCorrelation: (operation: () => unknown) => operation() },
  })
  assert.equal((await client.searchBookByISBN(book.isbn!))?.title, "La isla de papel")
  assert.equal(await client.searchBookByISBN("9780000000057"), null)
  assert.equal(await client.searchBookByISBN("isbn-inválido"), null)
  await assert.rejects(client.searchBookByISBN("9780000000040"), { code: "PROVIDER_UNAVAILABLE" })

  // Desde U-DAT-03 la recuperación de portadas es un trabajo persistente: la acción solo lo encola y el
  // worker consulta portadas con un catálogo configurado igual que este (fixture en local/test).
  const started: unknown[] = []
  const recovery = loadSource<{ recoverMissingCoversAction: (input: { idempotencyKey: string }) => Promise<unknown> }>("app/actions/cover-recovery.ts", {
    "@/app/actions/library-jobs": { startCoverJobAction: async (input: unknown) => { started.push(input); return { ok: true } } },
  })
  await recovery.recoverMissingCoversAction({ idempotencyKey: "clave-fixture" })
  // El objeto llega desde otro contexto de vm: se compara su contenido, no el prototipo.
  assert.equal(JSON.stringify(started), JSON.stringify([{ scope: "missing", idempotencyKey: "clave-fixture" }]))
  const cover = await catalog.getCover(book.isbn!)
  assert.notEqual(cover.status, undefined)
  assert.deepEqual(book, original)
  assert.equal(fetch.mock.callCount(), 0)
})

test("búsqueda HTTP: descarta portadas Google y conserva una portada persistible posterior", async () => {
  const catalog = createConfiguredCatalog(readCatalogConfig({ BIBLIB_TARGET: "test" }))
  const found = (await catalog.lookupISBN(book.isbn!)).candidates[0]
  const google: CoverCandidate = { provider: "google-books", imageUrl: "https://books.google.com/preview.jpg", coverKey: "google", rightsPolicyVersion: "preview-only" }
  const openLibrary: CoverCandidate = { provider: "open-library", imageUrl: "https://covers.openlibrary.org/b/id/1-L.jpg", coverKey: "ol", rightsPolicyVersion: "test" }
  let covers = [google]
  const service: BibliographicCatalogService = { ...catalog,
    lookupISBN: async () => ({ status: "found", complete: true, deadlineExceeded: false, providers: [], candidates: [{ ...found, coverUrl: openLibrary.imageUrl }] }),
    getCover: async () => ({ status: "found", complete: true, deadlineExceeded: false, providers: [], candidates: covers }),
  }
  const route = loadSource<{ GET: (request: unknown) => Promise<Response> }>("app/api/books/search/route.ts", {
    "@/lib/bibliographic-catalog/server": { bibliographicCatalog: service },
    "@/lib/server-user": { getRequiredUserId: async () => "cuenta-fixture" },
    "@/lib/observability/server": { withRequestCorrelation: (_request: unknown, operation: () => unknown) => operation() },
  })
  const request = { nextUrl: new URL(`http://localhost/api/books/search?isbn=${book.isbn}`) }
  const response = await route.GET(request)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("Cache-Control"), "private, no-store")
  assert.deepEqual((await response.json() as Book).cover, normalizeBookCover())
  covers = [google, openLibrary]
  assert.deepEqual((await (await route.GET(request)).json() as Book).cover, normalizeBookCover({ large: openLibrary.imageUrl }))
})

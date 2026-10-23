import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { cachePlan } from "../lib/bibliographic-catalog/cache"
import { candidateProvenance, coverProvenance } from "../lib/bibliographic-catalog/normalize"
import { readCatalogConfig } from "../lib/bibliographic-catalog/config"
import { createConfiguredCatalog } from "../lib/bibliographic-catalog/registry"
import { canRetainCover, canRetainMetadata, retainableCandidates, retainableCovers } from "../lib/bibliographic-catalog/retention"
import { hasProviderRight, providerRightsPolicy, type RightsCapability } from "../lib/bibliographic-catalog/rights"
import type { BibliographicCandidate, CatalogLookupResult, CoverCandidate, ProviderId } from "../lib/bibliographic-catalog/types"
import { DEFAULT_BOOK_COVER } from "../lib/book-covers"
import { classifyCoverLookup } from "../lib/jobs/contracts"
import { createLibraryExport, parseLibraryImport } from "../lib/library-import"
import { exportLibraryBackup } from "../lib/library-export"
import type { Book, CatalogueMetadata, LibraryData } from "../lib/types"

// U-BIB-05 · Retención permanente, exportación y caché. Lo que se guarda en la biblioteca de la persona
// es una decisión distinta de la caché operativa: depende de la política versionada de cada fuente.

const providers: ProviderId[] = ["open-library", "bne", "google-books"]
const result = (candidates: CoverCandidate[], overrides: Partial<CatalogLookupResult<CoverCandidate>> = {}): CatalogLookupResult<CoverCandidate> =>
  ({ status: candidates.length ? "found" : "notFound", candidates, providers: [], complete: true, deadlineExceeded: false, ...overrides })
const cover = (provider: ProviderId, imageUrl = `https://imagenes.invalid/${provider}-L.jpg`): CoverCandidate =>
  ({ provider, coverKey: `${provider}-1`, sourceUrl: `https://fuente.invalid/${provider}`, imageUrl, rightsPolicyVersion: providerRightsPolicy(provider).version })

test("solo Open Library puede dejar fichas y portadas en la biblioteca; BNE solo metadatos y Google nada", () => {
  assert.deepEqual(providers.map((provider) => [provider, canRetainMetadata(provider), canRetainCover(provider)]), [
    ["open-library", true, true],
    ["bne", true, false],
    ["google-books", false, false],
  ])
  // BNE CC0 cubre el catálogo, no las imágenes: la política lo dice con todas las capacidades de imagen denegadas.
  const bne = providerRightsPolicy("bne")
  for (const capability of ["previewCover", "rehostCover", "backupAsset", "offlineUse"] as RightsCapability[]) assert.equal(hasProviderRight(bne, capability), false, capability)
  // Google: ni metadatos ni imágenes persistentes; solo vista previa temporal.
  const google = providerRightsPolicy("google-books")
  for (const capability of ["cacheMetadata", "persistMetadata", "exportMetadata", "rehostCover", "backupAsset", "offlineUse"] as RightsCapability[]) assert.equal(hasProviderRight(google, capability), false, capability)
  assert.equal(hasProviderRight(google, "previewCover"), true)
})

test("una política desconocida o alterada deniega la retención", () => {
  const forged = { ...providerRightsPolicy("google-books"), persistMetadata: true, exportMetadata: true, rehostCover: true }
  assert.equal(hasProviderRight(forged, "persistMetadata"), false, "la versión publicada manda sobre una copia con permisos añadidos")
  assert.equal(hasProviderRight({ ...providerRightsPolicy("open-library"), version: "futura" }, "persistMetadata"), false)
  assert.equal(hasProviderRight(undefined, "exportMetadata"), false)
})

test("las portadas y fichas no retenibles se descartan antes de guardarlas", () => {
  assert.deepEqual(retainableCovers([cover("google-books"), cover("bne"), cover("open-library")]).map((entry) => entry.provider), ["open-library"])
  const candidate = (provider: ProviderId): BibliographicCandidate => ({ provider, level: "edition", isbns: [], authors: [], publishers: [], evidence: { isbnExact: true }, retrievedAt: "2026-10-23T10:00:00.000Z" })
  assert.deepEqual(retainableCandidates([candidate("google-books"), candidate("bne"), candidate("open-library")]).map((entry) => entry.provider), ["bne", "open-library"])
  assert.equal(candidateProvenance(candidate("google-books")), null)
  assert.equal(coverProvenance(cover("google-books")), null)
  assert.equal(coverProvenance(cover("bne"))?.provider, "bne", "la procedencia de la fuente existe; la política de portada decide si se guarda")
})

test("el trabajo de portadas nunca guarda una imagen de Google ni de BNE, aunque sea la única o la primera", () => {
  const preview = result([cover("google-books"), cover("bne")])
  assert.deepEqual(classifyCoverLookup(preview), { kind: "notFound" }, "sin imagen retenible y fuentes sanas es «sin portada», no una portada ajena")
  const first = classifyCoverLookup(result([cover("google-books"), cover("open-library", "https://covers.invalid/b/id/9-L.jpg")]))
  assert.equal(first.kind, "found")
  if (first.kind === "found") {
    assert.equal(first.provider, "open-library")
    assert.equal(first.cover.large, "https://covers.invalid/b/id/9-L.jpg")
    assert.notEqual(first.cover.large, DEFAULT_BOOK_COVER)
  }
  // Una fuente retenible incompleta y otra no retenible no se convierten en ausencia.
  const incomplete = classifyCoverLookup(result([cover("google-books")], { status: "found", complete: false, deadlineExceeded: true }))
  assert.equal(incomplete.kind, "retry")
})

test("la caché operativa de Google y de las imágenes de BNE nunca se escribe", () => {
  for (const operation of ["lookupISBN", "searchTitleAuthor", "resolveEditions", "getCover"] as const) assert.equal(cachePlan("google-books", operation), null, `Google ${operation}`)
  assert.equal(cachePlan("bne", "getCover"), null)
  assert.ok(cachePlan("bne", "lookupISBN"), "los metadatos CC0 de BNE sí se cachean con procedencia")
  const live = createConfiguredCatalog(readCatalogConfig({ BIBLIB_TARGET: "test", BIBLIB_CATALOGUE_MODE: "live", BIBLIB_BNE_ENABLED: "true" }), { fetch: async () => { throw new Error("sin red") } })
  assert.equal(live.capabilities().bne.getCover, false, "BNE no ofrece portadas")
})

const olProvenance: CatalogueMetadata = { source: "open-library", isbnVerified: true, sourceUrl: "https://openlibrary.org/books/OL1M" }
const bneProvenance: CatalogueMetadata = {
  schemaVersion: 2, source: "bne", isbnVerified: false, sourceUrl: "https://catalogo.bne.es/discovery/fulldisplay?docid=alma1",
  fields: {
    title: { provider: "bne", recordId: "alma1", sourceUrl: "https://catalogo.bne.es/discovery/fulldisplay?docid=alma1", retrievedAt: "2026-10-23T09:00:00.000Z", selection: "user-selected" },
    cover: { provider: "open-library", sourceUrl: "https://openlibrary.org/books/OL1M", retrievedAt: "2026-10-23T09:05:00.000Z", selection: "unverified" },
  },
}

function book(overrides: Partial<Book>): Book {
  return { id: "11111111-1111-4111-8111-111111111111", isbn: "9788401337208", title: "El nombre del viento", authors: [{ name: "Patrick Rothfuss" }], number_of_pages: 872, publish_date: "2009",
    cover: { small: "https://covers.invalid/1-S.jpg", medium: "https://covers.invalid/1-M.jpg", large: "https://covers.invalid/1-L.jpg" }, status: "read", shelf_id: "estanteria", shelf_name: "Predeterminada", ...overrides }
}
const library = (...books: Book[]): LibraryData => ({ books, shelves: [{ id: "estanteria", title: "Predeterminada", book_count: books.length, isDefault: true }] })

test("la exportación conserva la atribución de las fuentes autorizadas y se lee de vuelta sin pérdida", () => {
  const original = library(
    book({ catalogue: olProvenance }),
    book({ id: "22222222-2222-4222-8222-222222222222", isbn: "9788401339639", title: "Otro libro", catalogue: bneProvenance }),
  )
  // El formato 1 no conserva la procedencia de BNE ni por campo: se rechaza en lugar de degradarla.
  assert.throws(() => createLibraryExport(original), /formato 2/)
  const exported = exportLibraryBackup(original)
  assert.equal(exported.formatVersion, 2)
  const restored = parseLibraryImport(exported.parts[0])
  assert.deepEqual(restored.books.map((entry) => entry.catalogue), [olProvenance, bneProvenance])
  // Solo OL: el formato 1 antiguo también conserva fuente, URL del registro y verificación del ISBN.
  const legacy = createLibraryExport(library(book({ catalogue: olProvenance })))
  assert.deepEqual(parseLibraryImport(JSON.parse(JSON.stringify(legacy))).books[0].catalogue, olProvenance)
})

test("Google no puede constar como fuente retenida: ni en la ficha ni en la portada de un archivo importado", () => {
  const source = (catalogue: unknown) => ({ ...library(), books: [{ ...book({}), catalogue }] })
  assert.throws(() => parseLibraryImport(source({ source: "google-books", isbnVerified: false })), /Google Books|procedencia|formato/)
  assert.throws(() => parseLibraryImport(source({ schemaVersion: 2, source: "manual", isbnVerified: false, fields: { cover: { provider: "google-books", selection: "user-selected" } } })), /Google Books|procedencia|formato/)
})

test("la exportación solo contiene la biblioteca: sin caché sin seleccionar, candidatos ni diagnósticos de proveedores", () => {
  const exported = JSON.stringify(exportLibraryBackup(library(book({ catalogue: bneProvenance }))))
  for (const forbidden of ["candidates", "providers", "requestId", "cache", "payload", "rightsPolicyVersion", "retryAfter"]) assert.ok(!exported.includes(`"${forbidden}"`), forbidden)
  // El camino de lectura de la copia no importa el catálogo ni toca las tablas de coordinación.
  for (const file of ["lib/library-export.ts", "lib/backup-v2.ts", "lib/library-import.ts", "lib/catalogue-provenance.ts", "app/actions/library.ts", "lib/db/library.ts"]) {
    const source = readFileSync(file, "utf8")
    assert.ok(!/bibliographic-catalog\/(?:gateway|cache|server|orchestrator)|catalogue_cache|catalogueCache|catalogue_private/.test(source), `${file} no debe leer la caché del catálogo`)
  }
})

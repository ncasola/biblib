import assert from "node:assert/strict"
import { test } from "node:test"
import { assertBookVersion } from "../lib/book-version"
import { parseBookInput } from "../lib/book-validation"
import {
  catalogueForCreate, catalogueForUpdate, catalogueRequiresV2, catalogueWithField, provenanceProviderLabel, readCatalogueView,
} from "../lib/catalogue-provenance"
import { DomainError } from "../lib/domain-errors"
import { decideConfirmation, IMPORT_RULES_VERSION } from "../lib/import-plan"
import type { Book, CatalogueMetadata } from "../lib/types"

const VERSION_A = "11111111-1111-4111-8111-111111111111"
const VERSION_B = "22222222-2222-4222-8222-222222222222"

function stored(overrides: Partial<Book> = {}): Book {
  return {
    id: "33333333-3333-4333-8333-333333333333", version: VERSION_A, isbn: "9788401337208", title: "El nombre del viento",
    authors: [{ name: "Patrick Rothfuss" }], publishers: [], number_of_pages: 872, publish_date: "2009",
    cover: { small: "https://covers.openlibrary.org/b/id/1-S.jpg", medium: "https://covers.openlibrary.org/b/id/1-M.jpg", large: "https://covers.openlibrary.org/b/id/1-L.jpg" },
    status: "unread", shelf_id: "", shelf_name: "Predeterminada",
    catalogue: { source: "open-library", isbnVerified: false, sourceUrl: "https://openlibrary.org/books/OL1M" },
    ...overrides,
  }
}

const bneProvenance: CatalogueMetadata = {
  schemaVersion: 2, source: "bne", isbnVerified: false, sourceUrl: "https://catalogo.bne.es/permalink/1",
  fields: {
    title: { provider: "bne", recordId: "1", retrievedAt: "2026-10-23T09:00:00.000Z", selection: "user-selected" },
    publish_date: { provider: "manual", selection: "manually-verified" },
    cover: { provider: "open-library", selection: "user-selected" },
  },
}

const invalidInput = (error: unknown) => error instanceof DomainError && error.code === "INVALID_INPUT"

test("con la revisión apagada el alta escribe v1 como hoy y rechaza v2 sin recortarla", () => {
  const v1 = parseBookInput({ ...stored(), catalogue: { source: "open-library", isbnVerified: true } }).catalogue
  assert.deepEqual(catalogueForCreate(v1, false), { source: "open-library", isbnVerified: true })
  assert.throws(() => catalogueForCreate(bneProvenance, false), invalidInput)
  assert.deepEqual(catalogueForCreate(bneProvenance, true), bneProvenance)
})

test("parseBookInput conserva schemaVersion y fields y explica fuentes no admitidas", () => {
  assert.deepEqual(parseBookInput({ ...stored(), catalogue: bneProvenance }).catalogue, bneProvenance)
  assert.throws(() => parseBookInput({ ...stored(), catalogue: { source: "google-books", isbnVerified: false } }), (error: unknown) => invalidInput(error) && /Google Books/.test((error as Error).message))
  assert.throws(() => parseBookInput({ ...stored(), catalogue: { schemaVersion: 3, source: "manual", isbnVerified: false } }), /versión de procedencia/)
  // Un ISBN manual nunca queda verificado, aunque el cliente lo envíe.
  assert.equal(parseBookInput({ ...stored(), isbn: "", catalogue: { ...bneProvenance, isbnVerified: true } }).catalogue.isbnVerified, false)
})

test("la edición deriva la procedencia de la ficha guardada: cambios a «manual», el resto se conserva", () => {
  const current = stored({ catalogue: bneProvenance })
  const next = { ...current, title: "Título corregido", catalogue: { source: "manual" as const, isbnVerified: true } }
  const result = catalogueForUpdate(current, next, false)
  assert.equal(result.schemaVersion, 2, "una ficha v2 sigue siendo v2 aunque la revisión se apague")
  assert.equal(result.source, "bne", "el cliente no puede cambiar la fuente primaria")
  assert.equal(result.isbnVerified, true, "la confirmación humana sí viene del formulario")
  assert.deepEqual(result.schemaVersion === 2 && result.fields?.title, { provider: "manual", selection: "user-selected" })
  assert.deepEqual(result.schemaVersion === 2 && result.fields?.publish_date, { provider: "manual", selection: "manually-verified" })
  assert.deepEqual(result.schemaVersion === 2 && result.fields?.cover, { provider: "open-library", selection: "user-selected" })
})

test("una ficha v1 sigue en v1 con la revisión apagada y solo pasa a v2 si hay algo que registrar", () => {
  const current = stored()
  const unchanged = catalogueForUpdate(current, { ...current, catalogue: { source: "manual", isbnVerified: false } }, true)
  assert.deepEqual(unchanged, current.catalogue)
  const changed = { ...current, number_of_pages: 900, catalogue: { source: "photo" as const, isbnVerified: false } }
  assert.deepEqual(catalogueForUpdate(current, changed, false), current.catalogue)
  assert.deepEqual(catalogueForUpdate(current, changed, true), {
    schemaVersion: 2, source: "open-library", isbnVerified: false, sourceUrl: "https://openlibrary.org/books/OL1M",
    fields: { number_of_pages: { provider: "manual", selection: "user-selected" } },
  })
  // Sin catálogo legacy no se inventa una fuente «manual»: queda «import» y sin verificar.
  assert.deepEqual(catalogueForUpdate(stored({ catalogue: undefined }), { ...current, catalogue: { source: "manual", isbnVerified: false } }, false), { source: "import", isbnVerified: false })
})

test("edición concurrente: una versión antigua no escribe y la nueva parte de la procedencia vigente", () => {
  const opened = stored({ catalogue: bneProvenance })
  // A guarda primero: el trigger renueva la versión y la procedencia del título pasa a manual.
  const afterA = { ...opened, version: VERSION_B, title: "Título de A", catalogue: catalogueForUpdate(opened, { ...opened, title: "Título de A", catalogue: { source: "manual", isbnVerified: false } }, true) }
  // B envió la versión que abrió: el CAS de Book.version la rechaza antes de calcular procedencia.
  assert.throws(() => assertBookVersion(afterA, VERSION_A), (error: unknown) => error instanceof DomainError && error.code === "CONFLICT")
  assertBookVersion(afterA, VERSION_B)
  const afterB = catalogueForUpdate(afterA, { ...afterA, subtitle: "Subtítulo de B", catalogue: { source: "manual", isbnVerified: false } }, true)
  assert.deepEqual(afterB.schemaVersion === 2 && Object.keys(afterB.fields ?? {}).sort(), ["cover", "publish_date", "subtitle", "title"])
  // Un cambio solo de procedencia también rota la revisión de colección: una vista previa anterior caduca.
  assert.deepEqual(decideConfirmation({
    existing: null, preview: { id: "p", revision: VERSION_A, expired: false, rulesVersion: IMPORT_RULES_VERSION, confirmed: false },
    previewId: "p", digest: "d", expectedRevision: VERSION_A, currentRevision: VERSION_B,
  }), { kind: "reject", code: "REVISION_CONFLICT" })
})

test("la portada recuperada actualiza su procedencia sin activar v2 con la revisión apagada", () => {
  const provenance = { provider: "open-library" as const, selection: "user-selected" as const }
  assert.deepEqual(catalogueWithField(stored().catalogue, "cover", provenance, false), stored().catalogue)
  const updated = catalogueWithField(bneProvenance, "cover", { ...provenance, retrievedAt: "2026-10-23T10:00:00.000Z" }, false)
  assert.equal(updated.schemaVersion === 2 && updated.fields?.cover?.retrievedAt, "2026-10-23T10:00:00.000Z")
  assert.equal(updated.schemaVersion === 2 && updated.fields?.title?.provider, "bne")
})

test("el lector de presentación deriva el checksum y no confunde fuentes", () => {
  const view = readCatalogueView(bneProvenance, "9788401337208")
  assert.equal(view.schemaVersion, 2)
  assert.equal(view.isbnChecksumValid, true)
  assert.equal(view.isbnVerified, false)
  assert.equal(view.fields.title?.provider, "bne")
  assert.equal(provenanceProviderLabel("bne"), "Biblioteca Nacional de España (BNE)")
  assert.equal(readCatalogueView({ source: "photo", isbnVerified: true }, "9780000000000").isbnVerified, false)
  assert.equal(catalogueRequiresV2(bneProvenance), true)
  assert.equal(catalogueRequiresV2({ schemaVersion: 2, source: "manual", isbnVerified: false }), false)
})

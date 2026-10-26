import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { BACKUP_V2_SUPPORTED_CAPABILITIES, createBackupV2, readBackupV2, type PortableBackupV2 } from "../lib/backup-v2"
import { readCatalogueView } from "../lib/catalogue-provenance"
import { buildImportPlan, canonicalJson, type IdAllocator } from "../lib/import-plan"
import { exportLibraryBackup, fragmentBackupV2, fragmentLibraryExport } from "../lib/library-export"
import { createLibraryExport, MAX_IMPORT_BOOKS, parseLibraryImport } from "../lib/library-import"
import type { Book, LibraryData } from "../lib/types"

const synthetic = (): unknown => JSON.parse(readFileSync("tests/fixtures/import/sintetico-111.json", "utf8"))
const exportedAt = new Date("2026-10-23T10:00:00.000Z")
const SHELF = "00000000-0000-4000-8001-000000000001"

function library(books: Book[]): LibraryData {
  return { books, shelves: [{ id: SHELF, title: "Balda", book_count: books.length, isDefault: true }] }
}

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: "00000000-0000-4000-8002-000000000001", isbn: "9788401337208", title: "El nombre del viento",
    authors: [{ name: "Patrick Rothfuss" }], number_of_pages: 872, publish_date: "2009",
    cover: { small: "/default-book-cover.webp", medium: "/default-book-cover.webp", large: "/default-book-cover.webp" },
    status: "unread", shelf_id: SHELF, shelf_name: "Balda", catalogue: { source: "manual", isbnVerified: false },
    ...overrides,
  }
}

const bneBook = () => book({ catalogue: {
  schemaVersion: 2, source: "bne", isbnVerified: true, sourceUrl: "https://catalogo.bne.es/permalink/34BNE_INST/1",
  fields: {
    title: { provider: "bne", recordId: "a1", sourceUrl: "https://catalogo.bne.es/permalink/34BNE_INST/1", retrievedAt: "2026-10-23T09:00:00.000Z", selection: "user-selected" },
    cover: { provider: "open-library", sourceUrl: "https://openlibrary.org/books/OL1M", selection: "user-selected" },
    publish_date: { provider: "manual", selection: "manually-verified" },
  },
} })

const v2 = (data: LibraryData) => JSON.parse(JSON.stringify(createBackupV2(data, exportedAt))) as PortableBackupV2

test("el payload v2 canónico deriva edición y copia de book.id con works vacío", () => {
  const manual = book({ id: "00000000-0000-4000-8002-000000000002", isbn: "manual-00000000-0000-4000-8002-000000000002", catalogue: { source: "manual", isbnVerified: true } })
  const backup = createBackupV2(library([bneBook(), manual]), exportedAt)
  assert.equal(backup.formatVersion, 2)
  assert.deepEqual(backup.works, [])
  assert.deepEqual(backup.requiredCapabilities, ["catalogue.provenance-v2"])
  const [edition, manualEdition] = backup.editions
  const [copy, manualCopy] = backup.copies
  assert.equal(edition.id, copy.id)
  assert.equal(copy.edition_id, edition.id)
  assert.equal(edition.id, "00000000-0000-4000-8002-000000000001")
  assert.equal(edition.work_id, null)
  assert.equal(edition.isbn13, "9788401337208")
  // La verificación física vive en la copia; las fuentes por campo, en la edición.
  assert.deepEqual(copy.edition_verification, { isbnVerified: true })
  assert.equal("isbnVerified" in (edition.catalogue ?? {}), false)
  assert.equal(edition.catalogue?.schemaVersion, 2)
  assert.equal(Object.keys(edition.catalogue && "fields" in edition.catalogue ? edition.catalogue.fields ?? {} : {}).length, 3)
  // Un identificador manual no es un ISBN: va a legacy_identifier y nunca se marca verificado.
  assert.equal(manualEdition.isbn13, null)
  assert.equal(manualCopy.legacy_identifier, "manual-00000000-0000-4000-8002-000000000002")
  assert.equal(manualCopy.edition_verification.isbnVerified, false)
  assert.equal("version" in edition || "version" in copy, false)
})

test("ida y vuelta v1→v2→v1 sin pérdida con el fixture sintético de 111 fichas", () => {
  const legacy = parseLibraryImport(synthetic())
  assert.equal(legacy.books.length, 111)
  const fromV2 = parseLibraryImport(v2(legacy))
  assert.deepEqual(fromV2, legacy)
  assert.equal(new Set(v2(legacy).copies.map((copy) => copy.id)).size, 111)
  const v1Again = JSON.parse(JSON.stringify(createLibraryExport(fromV2, exportedAt)))
  assert.deepEqual(parseLibraryImport(v1Again), legacy)
  assert.equal(exportLibraryBackup(legacy, exportedAt).formatVersion, 1)
})

test("ida y vuelta v2→v2 conserva procedencia por campo y verificación humana", () => {
  const data = library([bneBook(), book({ id: "00000000-0000-4000-8002-000000000003", isbn: "9780804429573", subtitle: "", publishers: [] })])
  const first = v2(data)
  const parsed = parseLibraryImport(first)
  assert.deepEqual(v2(parsed), first)
  assert.equal(parsed.books[0].catalogue?.schemaVersion, 2)
  assert.equal(parsed.books[0].catalogue?.isbnVerified, true)
  assert.deepEqual(parsed.books[0].catalogue?.schemaVersion === 2 && parsed.books[0].catalogue.fields?.publish_date, { provider: "manual", selection: "manually-verified" })
})

test("v1 solo se ofrece sin pérdida: BNE o fuentes por campo exigen v2", () => {
  const data = library([bneBook()])
  assert.throws(() => createLibraryExport(data, exportedAt), /formato 1 no conserva/)
  assert.throws(() => fragmentLibraryExport(data, exportedAt), /formato 1 no conserva/)
  const backup = exportLibraryBackup(data, exportedAt)
  assert.equal(backup.formatVersion, 2)
  assert.match(backup.formatVersion === 2 ? backup.reason : "", /formato 2/)
  // Una v2 sin campos ni BNE se escribe como v1 sin pérdida.
  const plain = library([book({ catalogue: { schemaVersion: 2, source: "open-library", isbnVerified: false } })])
  const exported = createLibraryExport(plain, exportedAt)
  assert.deepEqual(exported.books[0].catalogue, { source: "open-library", isbnVerified: false })
})

test("los exports antiguos v1 y legacy {books, shelves} siguen importando igual", () => {
  const legacyFile = synthetic() as { books: Record<string, unknown>[]; shelves: unknown[] }
  const parsed = parseLibraryImport(legacyFile)
  const withoutCatalogue = legacyFile.books.findIndex((entry) => !("catalogue" in entry))
  // La ausencia de valor legacy deja isbnVerified en false y la fuente en «import», nunca «manual».
  assert.deepEqual(parsed.books[withoutCatalogue].catalogue, { source: "import", isbnVerified: false })
  const v1 = { ...legacyFile, formatVersion: 1, exportedAt: exportedAt.toISOString() }
  assert.deepEqual(parseLibraryImport(v1), parsed)
})

test("el lector v2 declara sus capacidades y rechaza con explicación lo no representable", () => {
  const base = v2(library([book()]))
  // U-DAT-06 activa la capacidad completa del formato 2.
  // O13 (0014) añade notas/etiquetas, ubicaciones, series y evidencias como secciones opcionales declaradas; O14 (0015), lectura y préstamos.
  assert.deepEqual([...BACKUP_V2_SUPPORTED_CAPABILITIES], ["catalogue.provenance-v2", "works.entities", "copies.multiple-per-edition", "copies.verification-evidence", "editions.identifiers",
    "copies.personal", "copies.locations", "editions.series", "bibliographic.evidence", "copies.reading", "copies.loans"])
  const shared = { id: "00000000-0000-4000-8003-000000000009" }
  const twoCopies = v2(library([book({ edition: shared }), book({ id: "00000000-0000-4000-8002-000000000009", edition: shared })]))
  const cases: [unknown, RegExp][] = [
    // Varias copias sin declarar la capacidad que usan.
    [{ ...twoCopies, requiredCapabilities: [] }, /varias copias de una misma edición sin declarar/],
    [{ ...base, works: [{ id: "w1", title: "Obra" }] }, /obras sin ninguna edición/],
    [{ ...base, requiredCapabilities: ["loans.v1"] }, /capacidad «loans\.v1».*no conoce/],
    [{ ...base, loans: [] }, /secciones.*loans/],
    [{ ...base, editions: [{ ...base.editions[0], identifiers: { oclc: ["1"] } }] }, /identificadores externos o idioma de la edición sin declarar/],
    [{ ...base, editions: [{ ...base.editions[0], identifiers: { oclc: "1" } }] }, /edición 1 no tiene un formato válido/],
    [{ ...base, copies: [{ ...base.copies[0], edition_verification: { isbnVerified: true, checkedAt: "2026-10-01T10:00:00Z" } }] }, /evidencias de la comprobación física sin declarar/],
    [{ ...base, copies: [{ ...base.copies[0], edition_verification: { isbnVerified: true, foto: "x" } }] }, /copia 1.*foto/],
    [{ ...base, editions: [...base.editions, { ...base.editions[0], id: "sin-copia", isbn13: null }] }, /ediciones sin ningún ejemplar/],
    [{ ...base, editions: [{ ...base.editions[0], work_id: "w1" }], requiredCapabilities: ["works.entities"] }, /obra inexistente/],
    [{ ...base, copies: [{ ...base.copies[0], legacy_identifier: "manual-1" }] }, /ISBN y un identificador legacy a la vez/],
    [{ ...base, editions: [{ ...base.editions[0], isbn13: null }], copies: [{ ...base.copies[0], edition_verification: { isbnVerified: true } }] }, /comprobada sin ISBN/],
    [{ ...base, formatVersion: 3 }, /versión.*no es compatible/],
    [{ formatVersion: 2, exportedAt: exportedAt.toISOString(), books: [], shelves: [] }, /secciones.*books/],
  ]
  for (const [input, expected] of cases) assert.throws(() => parseLibraryImport(input), expected)
  assert.throws(() => readBackupV2({ ...base, editions: [{ ...base.editions[0], catalogue: { schemaVersion: 2, source: "manual", fields: { title: { provider: "manual", selection: "user-selected" } } } }] }), /sin declarar la capacidad/)
  // Dos ediciones distintas con el mismo ISBN no son representables: se rechaza, no se fusiona.
  const twoEditions = v2(library([book(), book({ id: "00000000-0000-4000-8002-000000000009", title: "Otra edición" })]))
  assert.throws(() => parseLibraryImport(twoEditions), /mismo ISBN/)
})

test("U-DAT-06: varias copias de una edición, obra, evidencias e identificadores hacen ida y vuelta v2 sin pérdida", () => {
  const edition = { id: "00000000-0000-4000-8003-000000000001", workId: "00000000-0000-4000-8004-000000000001", workTitle: "Crónica del asesino de reyes", language: "es", identifiers: { openLibrary: ["OL1M"] } }
  const a = book({ edition, catalogue: { source: "manual", isbnVerified: true }, verification: { checkedAt: "2026-10-20T10:00:00.000Z", evidenceRefs: ["foto:lomo-1"] }, status: "read" })
  const b = book({ id: "00000000-0000-4000-8002-000000000002", edition, catalogue: { source: "manual", isbnVerified: false }, status: "to-read" })
  const noIsbn = book({ id: "00000000-0000-4000-8002-000000000003", isbn: null, title: "Sin ISBN", catalogue: { source: "manual", isbnVerified: false } })
  const data = library([a, b, noIsbn])
  const backup = v2(data)
  assert.deepEqual(backup.requiredCapabilities, ["works.entities", "copies.multiple-per-edition", "copies.verification-evidence", "editions.identifiers"])
  assert.equal(backup.works.length, 1)
  assert.equal(backup.editions.length, 2, "una edición compartida y otra sin ISBN")
  assert.equal(backup.copies.length, 3)
  assert.deepEqual(backup.copies.map((copy) => copy.edition_verification.isbnVerified), [true, false, false], "la comprobación es de cada copia")
  const withoutIsbn = backup.editions.find((entry) => entry.title === "Sin ISBN")!
  assert.equal(withoutIsbn.isbn13, null)
  assert.equal(backup.copies.find((copy) => copy.edition_id === withoutIsbn.id)!.legacy_identifier, null, "sin ISBN no se inventa un identificador")
  const parsed = parseLibraryImport(backup)
  assert.equal(parsed.books.length, 3)
  assert.deepEqual(parsed.books.map((entry) => [entry.status, entry.catalogue?.isbnVerified]), [["read", true], ["to-read", false], ["unread", false]])
  assert.equal(parsed.books[2].isbn, null)
  assert.deepEqual(parsed.books[0].verification, { checkedAt: "2026-10-20T10:00:00.000Z", evidenceRefs: ["foto:lomo-1"] })
  assert.deepEqual(v2(parsed), backup, "la ida y vuelta conserva todas las entidades")
  // v1 no puede representarlo: se exige v2 en lugar de omitir copias o inventar ISBN.
  assert.throws(() => createLibraryExport(data, exportedAt), /formato 1 no conserva/)
  assert.equal(exportLibraryBackup(data, exportedAt).formatVersion, 2)
  assert.throws(() => createLibraryExport(library([noIsbn]), exportedAt), /formato 1 no conserva/)
  // El plan agrupa las dos copias en una edición y crea su obra.
  const allocate: IdAllocator = (kind, sourceId) => `${kind}-${sourceId}`
  const plan = buildImportPlan({ imported: parsed, current: { shelves: [{ id: "default", title: "Predeterminada", isDefault: true }], books: [] }, mode: "merge", allocateId: allocate })
  assert.equal(plan.editions.create.length, 2)
  assert.equal(plan.works.create.length, 1)
  assert.equal(new Set(plan.books.insert.slice(0, 2).map((entry) => entry.editionId)).size, 1, "dos copias, una edición")
  assert.equal(plan.editions.create.find((entry) => entry.key === edition.id)?.workId, `work-${edition.workId}`)
})

test("el enum de fuente no clasifica Google ni desconocidos como manual por defecto", () => {
  const google = { books: [{ ...book(), catalogue: { source: "google-books", isbnVerified: false } }], shelves: library([]).shelves }
  assert.throws(() => parseLibraryImport(google), /Google Books todavía no es una fuente admitida/)
  const field = { books: [{ ...book(), catalogue: { schemaVersion: 2, source: "manual", isbnVerified: false, fields: { title: { provider: "google-books", selection: "user-selected" } } } }], shelves: library([]).shelves }
  assert.throws(() => parseLibraryImport(field), /Google Books/)
  const unknown = { books: [{ ...book(), catalogue: { source: "catalogo-x", isbnVerified: false } }], shelves: library([]).shelves }
  assert.throws(() => parseLibraryImport(unknown), /«catalogo-x» no es reconocida.*No se convierte en «manual»/)
  const fieldsWithoutVersion = { books: [{ ...book(), catalogue: { source: "manual", isbnVerified: false, fields: {} } }], shelves: library([]).shelves }
  assert.throws(() => parseLibraryImport(fieldsWithoutVersion), /schemaVersion: 2/)
  const view = readCatalogueView({ source: "google-books", isbnVerified: true }, "9788401337208")
  assert.equal(view.sourceKnown, false)
  assert.match(view.sourceLabel, /Fuente no reconocida/)
})

test("proveedor o checksum nunca marcan isbnVerified y su ausencia legacy da false", () => {
  const view = readCatalogueView({ source: "open-library" }, "9788401337208")
  assert.equal(view.isbnChecksumValid, true)
  assert.equal(view.isbnVerified, false)
  assert.equal(readCatalogueView(undefined, "manual-x").isbnChecksumValid, false)
  // isbnChecksumValid importado se ignora y se vuelve a derivar; no se persiste.
  const parsed = parseLibraryImport({ books: [{ ...book(), isbn: "manual-1", catalogue: { schemaVersion: 2, source: "bne", isbnVerified: true, isbnChecksumValid: true } }], shelves: library([]).shelves })
  assert.deepEqual(parsed.books[0].catalogue, { schemaVersion: 2, source: "bne", isbnVerified: false })
  const backup = v2(library([book({ catalogue: { source: "open-library", isbnVerified: false } })]))
  assert.equal(backup.copies[0].edition_verification.isbnVerified, false)
})

test("las partes v2 respetan límites, son importables por separado y alimentan el plan de U-DAT-01", () => {
  const books = Array.from({ length: MAX_IMPORT_BOOKS + 5 }, (_, index) => book({
    id: `00000000-0000-4000-8002-${String(index + 1).padStart(12, "0")}`, isbn: `manual-${index}`, catalogue: bneBook().catalogue,
  }))
  const data = library(books)
  const parts = fragmentBackupV2(data, exportedAt)
  assert.equal(parts.length, 2)
  const parsed = parts.map((part) => parseLibraryImport(JSON.parse(JSON.stringify(part))))
  assert.equal(parsed.reduce((total, part) => total + part.books.length, 0), books.length)
  assert.ok(parts.every((part) => part.formatVersion === 2 && part.works.length === 0))

  const legacy = parseLibraryImport(synthetic())
  const allocate: IdAllocator = (kind, sourceId) => `${kind}-${sourceId}`
  const current = { shelves: [{ id: "default", title: "Predeterminada", isDefault: true }], books: [] }
  const fromV1 = buildImportPlan({ imported: legacy, current, mode: "replace", allocateId: allocate })
  const fromV2 = buildImportPlan({ imported: parseLibraryImport(v2(legacy)), current, mode: "replace", allocateId: allocate })
  assert.equal(canonicalJson(fromV2), canonicalJson(fromV1))
})

test("la vista previa guarda el payload v2 y al confirmar se vuelve a leer igual: legacy, identificadores no ISBN y v2 (U-DAT-06)", () => {
  const cover = { small: "/default-book-cover.webp", medium: "/default-book-cover.webp", large: "/default-book-cover.webp" }
  const legacyIds = { shelves: [{ id: "estante-x", title: "Importación", book_count: 2 }], books: [0, 1].map((index) => ({
    id: `libro-x-${index}`, isbn: `manual-dat03-x-${index}`, title: `Libro ${index}`, authors: [], number_of_pages: 10, publish_date: "", cover, status: "unread", shelf_id: "estante-x", shelf_name: "Importación",
  })) }
  for (const input of [synthetic(), legacyIds]) {
    const imported = parseLibraryImport(input)
    const reread = parseLibraryImport(JSON.parse(JSON.stringify(createBackupV2(imported))))
    assert.equal(canonicalJson(reread), canonicalJson(imported))
  }
  // La forma plana de antes no se podía volver a leer con un ejemplar sin ISBN-13.
  const flat = parseLibraryImport(legacyIds)
  assert.throws(() => parseLibraryImport(JSON.parse(JSON.stringify({ shelves: flat.shelves, books: flat.books }))))
})

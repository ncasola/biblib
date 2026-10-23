import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"
import {
  buildImportPlan, canonicalJson, confirmationInput, decideConfirmation, DEFAULT_PREVIEW_TTL_MINUTES, IMPORT_RULES_VERSION, operationResult,
  previewTtlMinutes, type CollectionSnapshot, type ConfirmState, type IdAllocator,
} from "../lib/import-plan"
import { parseLibraryImport } from "../lib/library-import"
import type { LibraryData } from "../lib/types"

// Fixture sintético: 102 ISBN de prueba válidos y 9 identificadores manuales, sin datos personales.
const synthetic = (): unknown => JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/import/sintetico-111.json"), "utf8"))

const allocator = (seed: string): IdAllocator => (kind, sourceId) => {
  const hex = createHash("sha256").update(`${seed}:${kind}:${sourceId}`).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const DEFAULT = "10000000-0000-4000-8000-000000000001"
const CUSTOM = "10000000-0000-4000-8000-000000000002"
const current = (books: CollectionSnapshot["books"] = []): CollectionSnapshot => ({
  shelves: [{ id: DEFAULT, title: "Predeterminada", isDefault: true }, { id: CUSTOM, title: "Narrativa", isDefault: false }],
  books,
})

const cover = { small: "/default-book-cover.webp", medium: "/default-book-cover.webp", large: "/default-book-cover.webp" }
const file: LibraryData = {
  shelves: [{ id: "s-def", title: "Predeterminada", book_count: 1, isDefault: true }, { id: "s-nar", title: "narrativa", book_count: 1 }, { id: "s-new", title: "Ensayo", book_count: 1 }],
  books: [
    { id: "b1", isbn: "9780000000019", title: "Uno", authors: [], number_of_pages: 0, publish_date: "", cover, status: "unread", shelf_id: "s-def", shelf_name: "Predeterminada" },
    { id: "b2", isbn: "9780000000026", title: "Dos", authors: [], number_of_pages: 0, publish_date: "", cover, status: "read", shelf_id: "s-nar", shelf_name: "narrativa" },
    { id: "b3", isbn: "manual-b3", title: "Tres", authors: [], number_of_pages: 0, publish_date: "", cover, status: "to-read", shelf_id: "s-new", shelf_name: "Ensayo" },
  ],
}

describe("plan de importación", () => {
  test("fusionar: altas, conservados, omitidos y reasignaciones sin eliminar nada", () => {
    const plan = buildImportPlan({ imported: file, current: current([{ id: "30000000-0000-4000-8000-000000000001", isbn: "978-0-00-000001-9" }]), mode: "merge", allocateId: allocator("p1") })
    assert.equal(plan.rulesVersion, IMPORT_RULES_VERSION)
    assert.deepEqual(plan.books.skip, [{ sourceId: "b1", existingId: "30000000-0000-4000-8000-000000000001" }], "El ISBN con guiones es el mismo identificador.")
    assert.deepEqual(plan.books.insert.map((entry) => entry.sourceId), ["b2", "b3"])
    assert.equal(plan.books.insert[0].shelfId, CUSTOM, "Las estanterías se unen por nombre sin distinguir mayúsculas.")
    assert.deepEqual(plan.books.delete, [])
    assert.deepEqual(plan.shelves.delete, [])
    assert.equal(plan.shelves.create.length, 1)
    assert.equal(plan.counts.added, 2)
    assert.equal(plan.counts.kept, 1)
    assert.equal(plan.counts.skipped, 1)
    assert.equal(plan.counts.deleted, 0)
    assert.equal(plan.counts.reassigned, 3, "Dos libros y una estantería reciben IDs nuevos e informados.")
    assert.equal(plan.counts.booksAfter, 3)
    assert.equal(plan.counts.shelvesAfter, 3)
  })

  test("reemplazar: elimina lo ausente, conserva IDs propios por identificador y protege la predeterminada", () => {
    const own = { id: "30000000-0000-4000-8000-000000000002", isbn: "9780000000026" }
    const gone = { id: "30000000-0000-4000-8000-000000000003", isbn: "manual-antiguo" }
    const reusedShelf: LibraryData = { ...file, shelves: file.shelves.map((shelf) => shelf.id === "s-new" ? { ...shelf, id: CUSTOM, title: "Ensayo" } : shelf.id === "s-nar" ? { ...shelf, title: "Poesía" } : shelf), books: file.books.map((book) => book.shelf_id === "s-new" ? { ...book, shelf_id: CUSTOM } : book) }
    const plan = buildImportPlan({ imported: reusedShelf, current: current([own, gone]), mode: "replace", allocateId: allocator("p2") })
    assert.deepEqual(plan.books.delete, [gone.id])
    assert.equal(plan.books.insert.find((entry) => entry.sourceId === "b2")?.id, own.id, "Un ISBN propio conserva su ID al reemplazar.")
    assert.equal(plan.counts.overwritten, 1)
    assert.equal(plan.counts.kept, 1)
    assert.equal(plan.counts.added, 2)
    assert.equal(plan.counts.deleted, 1)
    assert.ok(plan.shelves.create.some((shelf) => shelf.id === CUSTOM), "Un ID de estantería propio reconocido se conserva.")
    assert.deepEqual(plan.shelves.delete, [], "La estantería reutilizada no cuenta como eliminada.")
    assert.ok(!plan.shelves.create.some((shelf) => shelf.id === DEFAULT), "La predeterminada nunca se recrea ni se borra.")
    assert.equal(plan.books.insert.find((entry) => entry.sourceId === "b1")?.shelfId, DEFAULT)
    assert.equal(plan.counts.shelvesAfter, 3)
    assert.equal(plan.counts.booksAfter, 3)
  })

  test("reemplazar con un archivo vacío vacía la colección salvo la predeterminada", () => {
    const plan = buildImportPlan({ imported: { books: [], shelves: [] }, current: current([{ id: "30000000-0000-4000-8000-000000000004", isbn: "9780000000019" }]), mode: "replace", allocateId: allocator("p3") })
    assert.deepEqual(plan.books.delete, ["30000000-0000-4000-8000-000000000004"])
    assert.deepEqual(plan.shelves.delete, [CUSTOM])
    assert.equal(plan.counts.shelvesAfter, 1)
  })

  test("el plan es determinista para la misma vista previa y cambia con la semilla", () => {
    const input = { imported: file, current: current(), mode: "merge" as const }
    const first = buildImportPlan({ ...input, allocateId: allocator("misma") })
    assert.equal(canonicalJson(first), canonicalJson(buildImportPlan({ ...input, allocateId: allocator("misma") })))
    assert.notEqual(canonicalJson(first), canonicalJson(buildImportPlan({ ...input, allocateId: allocator("otra") })))
  })

  test("los 111 registros sintéticos legacy siguen siendo válidos y producen un plan completo", () => {
    const imported = parseLibraryImport(synthetic())
    assert.equal(imported.books.length, 111)
    assert.equal(imported.books.filter((book) => book.isbn.startsWith("manual-")).length, 9)
    const merge = buildImportPlan({ imported, current: current(), mode: "merge", allocateId: allocator("s") })
    assert.equal(merge.counts.added, 111)
    assert.equal(new Set(merge.books.insert.map((entry) => entry.id)).size, 111)
    assert.equal(merge.counts.shelvesCreated, 4, "La predeterminada del archivo se asigna a la de la cuenta.")
    const again = buildImportPlan({ imported, current: current(merge.books.insert.map((entry) => ({ id: entry.id, isbn: imported.books.find((book) => book.id === entry.sourceId)!.isbn }))), mode: "merge", allocateId: allocator("s2") })
    assert.equal(again.counts.added, 0)
    assert.equal(again.counts.skipped, 111, "Reimportar el mismo archivo no duplica: todo queda omitido.")
    const replace = buildImportPlan({ imported, current: current([{ id: "30000000-0000-4000-8000-000000000009", isbn: "9780000000019" }]), mode: "replace", allocateId: allocator("s") })
    assert.equal(replace.counts.deleted, 1)
    assert.equal(replace.counts.booksAfter, 111)
    assert.deepEqual(operationResult(replace), { imported: 111, skipped: 0, deleted: 1, reassigned: replace.counts.reassigned, shelves: 5, coversFound: 0, coversPending: 0 })
  })

  test("el hash de entrada es estable frente al orden de claves y distingue archivos", () => {
    assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }] }), "{\"a\":[{\"d\":2}],\"b\":1}")
    const imported = parseLibraryImport(synthetic())
    const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])) : value
    assert.equal(canonicalJson(reverseKeys(imported)), canonicalJson(imported))
    assert.notEqual(JSON.stringify(reverseKeys(imported)), JSON.stringify(imported))
    const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex")
    assert.notEqual(digest(confirmationInput({ inputDigest: digest(imported), mode: "merge", rulesVersion: 1 })), digest(confirmationInput({ inputDigest: digest(imported), mode: "replace", rulesVersion: 1 })))
  })

  test("caducidad configurable acotada a 1–1440 minutos, 30 por defecto", () => {
    assert.equal(previewTtlMinutes(undefined), DEFAULT_PREVIEW_TTL_MINUTES)
    assert.equal(DEFAULT_PREVIEW_TTL_MINUTES, 30)
    assert.equal(previewTtlMinutes("5"), 5)
    for (const value of ["0", "-1", "1441", "abc", "2.5", ""]) assert.equal(previewTtlMinutes(value), 30)
  })
})

describe("decisión de confirmación", () => {
  const R1 = "40000000-0000-4000-8000-000000000001", R2 = "40000000-0000-4000-8000-000000000002"
  const base = (change: Partial<ConfirmState> = {}): ConfirmState => ({
    existing: null,
    preview: { id: "p", revision: R1, expired: false, rulesVersion: IMPORT_RULES_VERSION, confirmed: false },
    previewId: "p", digest: "d1", expectedRevision: R1, currentRevision: R1, ...change,
  })

  test("misma revisión, vigente y sin clave previa: se ejecuta", () => {
    assert.deepEqual(decideConfirmation(base()), { kind: "execute" })
  })

  test("una escritura posterior a la vista previa produce REVISION_CONFLICT, sin forzar", () => {
    assert.deepEqual(decideConfirmation(base({ currentRevision: R2 })), { kind: "reject", code: "REVISION_CONFLICT" })
    assert.deepEqual(decideConfirmation(base({ expectedRevision: R2, currentRevision: R2 })), { kind: "reject", code: "REVISION_CONFLICT" }, "El cliente no puede declarar otra revisión esperada.")
  })

  test("caducada o con reglas antiguas: PREVIEW_EXPIRED", () => {
    assert.deepEqual(decideConfirmation(base({ preview: { ...base().preview!, expired: true } })), { kind: "reject", code: "PREVIEW_EXPIRED" })
    assert.deepEqual(decideConfirmation(base({ preview: { ...base().preview!, rulesVersion: IMPORT_RULES_VERSION - 1 } })), { kind: "reject", code: "PREVIEW_EXPIRED" })
  })

  test("la misma clave recupera el resultado durable aunque la revisión ya haya cambiado", () => {
    const existing = { operationId: "op", inputDigest: "d1", previewId: "p" }
    assert.deepEqual(decideConfirmation(base({ existing, currentRevision: R2, preview: { ...base().preview!, confirmed: true } })), { kind: "replay", operationId: "op" })
    assert.deepEqual(decideConfirmation(base({ existing, preview: null })), { kind: "replay", operationId: "op" }, "Si la vista previa se purgó, basta con que la clave apunte a ella.")
  })

  test("la misma clave con otro archivo o modo: IDEMPOTENCY_CONFLICT sin ejecutar", () => {
    const existing = { operationId: "op", inputDigest: "d1", previewId: "p" }
    assert.deepEqual(decideConfirmation(base({ existing, digest: "d2", previewId: "q" })), { kind: "reject", code: "IDEMPOTENCY_CONFLICT" })
    assert.deepEqual(decideConfirmation(base({ existing, preview: null, previewId: "q" })), { kind: "reject", code: "IDEMPOTENCY_CONFLICT" })
  })

  test("vista previa ajena o inexistente: NOT_FOUND genérico; ya confirmada con otra clave: rechazo", () => {
    assert.deepEqual(decideConfirmation(base({ preview: null })), { kind: "reject", code: "NOT_FOUND" })
    assert.deepEqual(decideConfirmation(base({ preview: { ...base().preview!, confirmed: true } })), { kind: "reject", code: "ALREADY_CONFIRMED" })
  })
})

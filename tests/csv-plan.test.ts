import assert from "node:assert/strict"
import { test } from "node:test"
import { buildImportPlan, type CollectionSnapshot } from "../lib/import-plan"
import { csvSourceRowKey, type CsvMapping as StoredMapping } from "../lib/csv-import/contracts"
import { resolveStoredMapping, storedCsvMappingSchema } from "../lib/csv-import/mapping"
import { normalizeCsv } from "../lib/csv-import/normalization"
import { parseCsv } from "../lib/csv-import/parser"

const sessionId = "11111111-1111-4111-8111-111111111111"
const stored: StoredMapping = {
  delimiter: ";", header: true, columns: [{ sourceColumn: "Título", target: "title" }, { sourceColumn: "#2", target: "authors", separator: "|" }, { sourceColumn: "ISBN", target: "isbn" }, { sourceColumn: "Estado", target: "status" }],
  statusMap: { Leído: "read", Pendiente: "to-read" },
}
const current: CollectionSnapshot = { shelves: [{ id: "s-default", title: "Principal", isDefault: true }], books: [{ id: "copy-existing", isbn: "9780306406157", editionId: "edition-existing" }] }

test("CSV O13: contrato persistente resuelve cabeceras y posiciones con reglas explícitas", () => {
  const result = resolveStoredMapping(["Título", "Autor", "ISBN", "Estado"], stored)
  assert.deepEqual(result.issues, [])
  assert.equal(result.mapping?.columns[1].sourceColumn, 1)
  assert.equal(result.mapping?.authorsSeparator, "|")
  assert.equal(result.mapping?.defaultStatus, "unread")
  assert.equal(csvSourceRowKey(2), "csv:2")
  assert.throws(() => csvSourceRowKey(0))
  assert.equal(resolveStoredMapping(["Título"], stored).mapping, null)
  assert.equal(storedCsvMappingSchema.safeParse({ ...stored, header: false }).success, false)
})

test("CSV O13: otra copia conserva edición, añade dos ejemplares y no cambia la política JSON", async () => {
  const rules = resolveStoredMapping(["Título", "Autor", "ISBN", "Estado"], stored).mapping!
  const normalized = await normalizeCsv({ sessionId, delimiter: ";", mapping: rules, source: "Título;Autor;ISBN;Estado\nLibro;Apellido, Nombre|Otra;9780306406157;Leído\nLibro;Apellido, Nombre|Otra;0-306-40615-2;Pendiente" })
  assert.ok(normalized.library)
  const input = { imported: normalized.library, current, mode: "merge" as const, allocateId: (kind: string, source: string) => `${kind}:${source}` }
  const skip = buildImportPlan(input)
  assert.equal(skip.books.skip.length, 2)
  assert.equal(skip.books.insert.length, 0)
  assert.equal(skip.duplicatePolicy, undefined)
  const copies = buildImportPlan({ ...input, duplicatePolicy: "another-copy" })
  assert.equal(copies.books.insert.length, 2)
  assert.equal(copies.books.skip.length, 0)
  assert.equal(copies.counts.added, 2)
  assert.equal(copies.counts.booksAfter, 3)
  assert.equal(copies.counts.editionsCreated, 0)
  assert.equal(copies.editions.create.length, 0)
  assert.equal(copies.works.create.length, 0)
  assert.ok(copies.books.insert.every((row) => row.editionId === "edition-existing" && row.id !== "copy-existing"))
  assert.notEqual(copies.books.insert[0].id, copies.books.insert[1].id)
  assert.deepEqual(normalized.rows.map((row) => row.sourceRowKey), ["csv:1", "csv:2"])
  assert.equal(normalized.library.books[0].catalogue?.isbnVerified, false)
})

test("CSV O13: mapeos desconocidos, destinos repetidos y reglas de estado ambiguas se rechazan", () => {
  for (const mapping of [
    { ...stored, columns: [{ sourceColumn: "Ausente", target: "title" }] },
    { ...stored, columns: [{ sourceColumn: "#1", target: "title" }, { sourceColumn: "#2", target: "title" }] },
    { ...stored, statusMap: { Leído: "read", " LEÍDO ": "unread" } },
  ]) assert.equal(resolveStoredMapping(["Título", "Autor", "ISBN", "Estado"], mapping as StoredMapping).mapping, null)
})

test("CSV O13: cabeceras excesivas y U+0000 son incidencias explícitas, sin alterar la entrada", () => {
  const parsed = parseCsv("Título\nValor\0privado", ",")
  assert.equal(parsed.records[0].cells[0], "Valor\0privado")
  assert.equal(parsed.issues[0].code, "INVALID_CHARACTER")
  assert.equal(parseCsv("X".repeat(501) + "\nLibro", ",").issues[0].code, "FIELD_LIMIT")
  assert.equal(storedCsvMappingSchema.safeParse({ ...stored, defaultShelf: "Nombre\0inválido" }).success, false)
})

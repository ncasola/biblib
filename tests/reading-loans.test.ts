import assert from "node:assert/strict"
import { test } from "node:test"
import { createBackupV2, libraryRequiresV2, readBackupV2, type PortableBackupV2 } from "../lib/backup-v2"
import { buildImportPlan, type IdAllocator } from "../lib/import-plan"
import { fragmentBackupV2 } from "../lib/library-export"
import { createLibraryExport, parseLibraryImport } from "../lib/library-import"
import { snapshotRows, type SnapshotBookEntry } from "../lib/library-snapshots"
import { planProductRows, type ProductTargets } from "../lib/product/portable"
import {
  civilDateInZone, isCivilDate, isLoanOverdue, isValidBorrowerLabel, LOAN_NO_DUE_DATE_TEXT, LOAN_REMINDERS_SENT, readingProgress,
} from "../lib/product/reading-loans"
import type { Book, LibraryData } from "../lib/types"

// O14 · 0015. Contratos puros de lectura y préstamos: progreso sin porcentaje falso, fechas civiles sin huso, alias sin
// datos de contacto, formato v2 con las secciones `copies.reading` y `copies.loans` (ida y vuelta, archivos anteriores sin
// datos inventados, rechazos con explicación), versiones anteriores (esquema 4) y el planificador de la publicación.

const exportedAt = new Date("2026-10-26T10:00:00.000Z")
const SHELF = "00000000-0000-4000-8001-000000000001"
const CYCLE_1 = "00000000-0000-4000-800a-000000000001"
const CYCLE_2 = "00000000-0000-4000-800a-000000000002"
const ENTRY = "00000000-0000-4000-800b-000000000001"
const LOAN_1 = "00000000-0000-4000-800c-000000000001"
const LOAN_2 = "00000000-0000-4000-800c-000000000002"

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: "00000000-0000-4000-8002-000000000001", isbn: "9788401337208", title: "El nombre del viento",
    authors: [{ name: "Patrick Rothfuss" }], number_of_pages: 300, publish_date: "2009",
    cover: { small: "/default-book-cover.webp", medium: "/default-book-cover.webp", large: "/default-book-cover.webp" },
    status: "read", shelf_id: SHELF, shelf_name: "Balda", catalogue: { source: "manual", isbnVerified: false },
    ...overrides,
  }
}

function readingLibrary(): LibraryData {
  return {
    shelves: [{ id: SHELF, title: "Balda", book_count: 2, isDefault: true }],
    books: [
      book({
        reading: [
          { id: CYCLE_1, cycleNumber: 1, status: "finished", startedAt: "2026-01-10T10:00:00.000Z", finishedAt: "2026-02-01T20:00:00.000Z" },
          { id: CYCLE_2, cycleNumber: 2, status: "reading", entries: [
            { id: ENTRY, occurredAt: "2026-04-02T19:30:00.000Z", pageFrom: 0, pageTo: 120, note: "Relectura 📚" },
            { id: "00000000-0000-4000-800b-000000000002", occurredAt: "2026-04-03T07:00:00.000Z", note: "Sin página" },
          ] },
        ],
        loans: [
          { id: LOAN_1, borrowerLabel: "Tía Ana", loanedOn: "2026-03-29", returnedOn: "2026-04-05", note: "Semana Santa" },
          { id: LOAN_2, borrowerLabel: "Luis", loanedOn: "2026-04-06", dueOn: "2026-05-06" },
        ],
      }),
      book({ id: "00000000-0000-4000-8002-000000000002", isbn: "9788401337215", title: "El temor de un hombre sabio", number_of_pages: 0,
        reading: [{ id: "00000000-0000-4000-800a-000000000003", cycleNumber: 1, status: "paused", entries: [{ id: "00000000-0000-4000-800b-000000000003", occurredAt: "2026-04-02T10:00:00.000Z", pageTo: 5000 }] }] }),
    ],
  }
}

const v2 = (data: LibraryData) => JSON.parse(JSON.stringify(createBackupV2(data, exportedAt))) as PortableBackupV2

test("progreso honesto: sin total conocido o por encima del total, no hay porcentaje", () => {
  assert.deepEqual(readingProgress(150, 300), { page: 150, total: 300, percent: 50 })
  assert.deepEqual(readingProgress(299, 300), { page: 299, total: 300, percent: 99 }, "nunca redondea hacia arriba hasta terminar")
  assert.deepEqual(readingProgress(120, 0), { page: 120, total: null, percent: null }, "0 páginas es desconocido")
  assert.deepEqual(readingProgress(120, null), { page: 120, total: null, percent: null })
  assert.deepEqual(readingProgress(320, 300), { page: 320, total: 300, percent: null }, "por encima del total no inventa un 106 %")
})

test("fechas civiles sin desplazamiento por huso y préstamos sin recordatorios", () => {
  const instant = new Date("2026-03-28T23:30:00.000Z")
  assert.equal(civilDateInZone(instant, "Europe/Madrid"), "2026-03-29", "en Madrid ya es domingo")
  assert.equal(civilDateInZone(instant, "America/Los_Angeles"), "2026-03-28")
  assert.equal(civilDateInZone(new Date("2026-03-29T10:00:00.000Z"), "Pacific/Kiritimati"), "2026-03-30")
  for (const valid of ["2026-03-29", "2024-02-29", "1900-01-01", "2999-12-31"]) assert.ok(isCivilDate(valid), valid)
  for (const invalid of ["2026-02-29", "2026-13-01", "1899-12-31", "3000-01-01", "2026-3-29", "2026-03-29T00:00:00Z", ""]) assert.ok(!isCivilDate(invalid), invalid)
  assert.ok(isLoanOverdue({ dueOn: "2026-05-06" }, "2026-05-07"))
  assert.ok(!isLoanOverdue({ dueOn: "2026-05-06" }, "2026-05-06"), "el día del vencimiento aún no ha vencido")
  assert.ok(!isLoanOverdue({}, "2999-12-31"), "sin vencimiento nunca vence")
  assert.ok(!isLoanOverdue({ dueOn: "2026-05-06", returnedOn: "2026-06-01" }, "2026-07-01"), "devuelto, no vencido")
  assert.equal(LOAN_NO_DUE_DATE_TEXT, "Sin fecha acordada")
  assert.equal(LOAN_REMINDERS_SENT, false)
})

test("alias de préstamo como loans_borrower_label_check: corto, sin correo ni teléfono", () => {
  for (const valid of ["Tía Ana", "Vecina 3.º B", "Luis", "ñ".repeat(40), "Grupo 123456"]) assert.ok(isValidBorrowerLabel(valid), valid)
  for (const invalid of ["ana@example.com", "+34 600 123 456", "6001234567", " Ana", "Ana ", "x".repeat(41), "", "Ana\tB"]) assert.ok(!isValidBorrowerLabel(invalid), invalid)
})

test("v2: la lectura y los préstamos se declaran y vuelven exactos; sin ellos no se exige v2", () => {
  const data = readingLibrary()
  const payload = v2(data)
  assert.deepEqual(payload.requiredCapabilities, ["copies.reading", "copies.loans"])
  assert.deepEqual(payload.copies[0].reading, data.books[0].reading)
  assert.deepEqual(payload.copies[0].loans, data.books[0].loans)
  const parsed = parseLibraryImport(payload)
  assert.deepEqual(parsed.books.map((entry) => [entry.reading, entry.loans]), data.books.map((entry) => [entry.reading, entry.loans]))
  assert.ok(libraryRequiresV2(data))
  assert.equal(parsed.books[0].status, "read", "el estado actual sigue siendo independiente de la lectura")
})

test("un archivo anterior (v1 o v2 sin las secciones) se importa sin lectura ni préstamos, aunque haya libros leídos", () => {
  const plain: LibraryData = { shelves: [{ id: SHELF, title: "Balda", book_count: 1, isDefault: true }], books: [book()] }
  for (const input of [createLibraryExport(plain, exportedAt), v2(plain)]) {
    const parsed = parseLibraryImport(JSON.parse(JSON.stringify(input)))
    assert.ok(parsed.books.every((entry) => entry.status === "read" && entry.reading === undefined && entry.loans === undefined), "ningún ciclo deducido del estado read")
  }
  assert.ok(!libraryRequiresV2(plain))
})

test("el lector v2 rechaza con explicación lo que 0015 no admitiría", () => {
  const base = v2(readingLibrary())
  const copy = base.copies[0]
  const [first, second] = copy.reading!
  const withCopy = (changes: Record<string, unknown>) => ({ ...base, copies: [{ ...copy, ...changes }, base.copies[1]] })
  const cases: [unknown, RegExp][] = [
    [{ ...base, requiredCapabilities: ["copies.loans"] }, /ciclos y sesiones de lectura sin declarar/],
    [{ ...base, requiredCapabilities: ["copies.reading"] }, /préstamos sin declarar/],
    [withCopy({ reading: [first, { ...second, cycleNumber: 1 }] }), /repite la lectura número 1/],
    [withCopy({ reading: [{ ...first, status: "paused", finishedAt: undefined }, second] }), /más de una lectura en curso/],
    [withCopy({ reading: [{ ...first, finishedAt: "2026-01-01T00:00:00.000Z" }, second] }), /termina antes de empezar/],
    [withCopy({ reading: [first, { ...second, finishedAt: "2026-05-01T00:00:00.000Z" }] }), /lectura en curso .* tiene fecha de fin/],
    [withCopy({ reading: [first, { ...second, entries: [{ id: ENTRY, occurredAt: "2026-04-02T19:30:00.000Z", pageTo: 301 }] }] }), /página 301, por encima de las 300/],
    [withCopy({ reading: [first, { ...second, entries: [{ id: ENTRY, occurredAt: "2026-04-02T19:30:00.000Z", pageFrom: 50, pageTo: 40 }] }] }), /página posterior a la final/],
    [withCopy({ reading: [first, { ...second, entries: [{ id: ENTRY, occurredAt: "2026-04-02T19:30:00.000Z" }] }] }), /no tiene página ni nota/],
    [withCopy({ reading: [first, { ...second, entries: [{ id: ENTRY, occurredAt: "2026-04-02 19:30", note: "x" }] }] }), /copia 1 no tiene un formato válido/],
    [withCopy({ reading: [first, { ...second, entries: [{ id: ENTRY, occurredAt: "2026-04-02T19:30:00.000Z", pageTo: -1 }] }] }), /copia 1 no tiene un formato válido/],
    [withCopy({ reading: [{ ...first, status: "leído" }, second] }), /copia 1 no tiene un formato válido/],
    [withCopy({ reading: [{ ...first, sessions: 3 }, second] }), /campos que esta versión no puede conservar/],
    [withCopy({ loans: [{ ...copy.loans![0], returnedOn: undefined }, copy.loans![1]] }), /más de un préstamo activo/],
    [withCopy({ loans: [{ ...copy.loans![0], returnedOn: "2026-03-01" }, copy.loans![1]] }), /se devuelve antes de prestarse/],
    [withCopy({ loans: [{ ...copy.loans![0], borrowerLabel: "ana@example.com" }] }), /copia 1 no tiene un formato válido/],
    [withCopy({ loans: [{ ...copy.loans![0], loanedOn: "2026-02-30" }] }), /copia 1 no tiene un formato válido/],
    [withCopy({ loans: [{ ...copy.loans![0], reminderSentAt: "2026-04-01" }] }), /campos que esta versión no puede conservar/],
    [{ ...base, copies: [copy, { ...base.copies[1], loans: [copy.loans![1]] }] }, /préstamos con el mismo identificador/],
  ]
  for (const [input, expected] of cases) assert.throws(() => readBackupV2(input), expected, String(expected))
  assert.doesNotThrow(() => readBackupV2(withCopy({ loans: [{ ...copy.loans![0], note: "✨".repeat(500) }] })), "500 caracteres con emojis")
})

test("las partes v2 conservan la lectura y los préstamos de cada copia y se validan solas", () => {
  const data = readingLibrary()
  const many = { ...data, books: Array.from({ length: 2100 }, (_, index) => book({
    id: `00000000-0000-4000-8002-${String(index + 10).padStart(12, "0")}`, isbn: null, legacyIdentifier: `manual-${index}`, title: `Libro ${index}`,
    reading: [{ id: `00000000-0000-4000-800a-${String(index + 10).padStart(12, "0")}`, cycleNumber: 1, status: "finished" }],
    loans: [{ id: `00000000-0000-4000-800c-${String(index + 10).padStart(12, "0")}`, borrowerLabel: "Ana", loanedOn: "2026-01-01" }] })) }
  const parts = fragmentBackupV2(many, exportedAt)
  assert.ok(parts.length >= 2)
  let cycles = 0
  for (const part of parts) {
    assert.ok(part.requiredCapabilities.includes("copies.reading") && part.requiredCapabilities.includes("copies.loans"))
    cycles += parseLibraryImport(JSON.parse(JSON.stringify(part))).books.filter((entry) => entry.reading?.length).length
  }
  assert.equal(cycles, 2100)
})

test("versión anterior (esquema 4): lectura y préstamos vuelven con instantes en UTC y fechas civiles tal cual", () => {
  const entry: SnapshotBookEntry = {
    id: "00000000-0000-4000-8002-000000000001", isbn: null, title: "Ensayo", subtitle: null, authors: [], publishers: [], catalogue: { source: "manual", isbnVerified: false },
    number_of_pages: 300, publish_date: "", cover_small: "", cover_medium: "", cover_large: "", status: "read", shelf_id: SHELF, created_at: "2026-01-01T00:00:00+00:00",
    edition_id: "00000000-0000-4000-8003-000000000001",
    reading: [
      { id: CYCLE_1, cycle_number: 1, status: "finished", started_at: "2026-01-10T11:00:00+01:00", finished_at: "2026-02-01T20:00:00+00:00" },
      { id: CYCLE_2, cycle_number: 2, status: "reading", entries: [{ id: ENTRY, occurred_at: "2026-04-02T21:30:00+02:00", page_from: 0, page_to: 120 }] },
    ],
    loans: [{ id: LOAN_1, borrower_label: "Tía Ana", loaned_on: "2026-03-29", returned_on: "2026-04-05" }],
  }
  const row = snapshotRows({ shelves: [{ id: SHELF, title: "Balda", is_default: true, created_at: "2026-01-01T00:00:00+00:00" }], books: [entry] }).get(entry.id)!
  assert.deepEqual(row.reading, [
    { id: CYCLE_1, cycleNumber: 1, status: "finished", startedAt: "2026-01-10T10:00:00.000Z", finishedAt: "2026-02-01T20:00:00.000Z" },
    { id: CYCLE_2, cycleNumber: 2, status: "reading", entries: [{ id: ENTRY, occurredAt: "2026-04-02T19:30:00.000Z", pageFrom: 0, pageTo: 120 }] },
  ])
  assert.deepEqual(row.loans, [{ id: LOAN_1, borrowerLabel: "Tía Ana", loanedOn: "2026-03-29", returnedOn: "2026-04-05" }])
})

const allocator: IdAllocator = (kind, sourceId) => `nuevo-${kind}-${sourceId}`

function targets(overrides: Partial<ProductTargets> = {}): ProductTargets {
  return { tagsByName: new Map(), ownLocations: new Set(), ownSeries: new Set(), keep: () => false, media: new Map(), ...overrides }
}

test("planificador: solo los ejemplares nuevos reciben lectura y préstamos; IDs propios al reemplazar, nuevos al fusionar", () => {
  const data = readingLibrary()
  const merge = buildImportPlan({ imported: data, current: { shelves: [{ id: SHELF, title: "Balda", isDefault: true }], books: [{ id: "otro", isbn: "9788401337215" }] }, mode: "merge", allocateId: allocator })
  assert.equal(merge.books.insert.length, 1, "la segunda copia ya existe y conserva lo suyo")
  const merged = planProductRows(data, merge, "merge", targets({ keep: () => true }), allocator)
  assert.deepEqual(merged.readingCycles.map((row) => [row.id, row.copyId, row.cycleNumber, row.status, row.startedAt]), [
    [`nuevo-reading_cycle-${CYCLE_1}`, merge.books.insert[0].id, 1, "finished", "2026-01-10T10:00:00.000Z"],
    [`nuevo-reading_cycle-${CYCLE_2}`, merge.books.insert[0].id, 2, "reading", null],
  ])
  assert.ok(merged.readingEntries.every((row) => row.cycleId === `nuevo-reading_cycle-${CYCLE_2}` && row.id.startsWith("nuevo-reading_entry-")))
  assert.deepEqual(merged.loans.map((row) => [row.id, row.loanedOn, row.dueOn, row.returnedOn]), [
    [`nuevo-loan-${LOAN_1}`, "2026-03-29", null, "2026-04-05"], [`nuevo-loan-${LOAN_2}`, "2026-04-06", "2026-05-06", null],
  ])
  const replace = buildImportPlan({ imported: data, current: { shelves: [{ id: SHELF, title: "Balda", isDefault: true }], books: [] }, mode: "replace", allocateId: allocator })
  const own = new Set([CYCLE_1, ENTRY, LOAN_2])
  const replaced = planProductRows(data, replace, "replace", targets({ keep: (id) => own.has(id) }), allocator)
  assert.deepEqual(replaced.readingCycles.map((row) => row.id), [CYCLE_1, `nuevo-reading_cycle-${CYCLE_2}`, "nuevo-reading_cycle-00000000-0000-4000-800a-000000000003"])
  assert.equal(replaced.readingEntries[0].id, ENTRY)
  assert.equal(replaced.readingEntries[0].cycleId, `nuevo-reading_cycle-${CYCLE_2}`, "la entrada sigue a su ciclo")
  assert.deepEqual(replaced.loans.map((row) => row.id), [`nuevo-loan-${LOAN_1}`, LOAN_2])
  const bare = data.books.map((entry) => { const copy = { ...entry }; delete copy.reading; delete copy.loans; return copy })
  const empty = planProductRows({ ...data, books: bare }, replace, "replace", targets(), allocator)
  assert.deepEqual([empty.readingCycles, empty.readingEntries, empty.loans], [[], [], []])
})

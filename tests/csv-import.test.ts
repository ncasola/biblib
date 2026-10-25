import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { createLibraryExport, parseLibraryImport } from "../lib/library-import"
import { createBackupV2 } from "../lib/backup-v2"
import { CSV_LIMITS, csvIssue, csvIssueReport, escapeCsvReportCell, parseCsv } from "../lib/csv-import/parser"
import { csvMappingHash, csvSha256, DEFAULT_CSV_STATUS_EQUIVALENCES, validateCsvMapping, type CsvMapping, type CsvTarget } from "../lib/csv-import/mapping"
import { csvSourceRowKey, normalizeCsv } from "../lib/csv-import/normalization"

const sessionId = "11111111-1111-4111-8111-111111111111"
const fixture = (name: string) => readFileSync(`tests/fixtures/csv-import/${name}`)
const mapping = (targets: CsvTarget[]): CsvMapping => ({
  columns: targets.map((target, sourceColumn) => ({ sourceColumn, target })),
  authorsSeparator: null, publishersSeparator: null,
  statusEquivalences: DEFAULT_CSV_STATUS_EQUIVALENCES.map((entry) => ({ ...entry })),
  defaultStatus: "unread", defaultShelf: "Predeterminada",
})
const convert = (source: string | Uint8Array, rules: CsvMapping) => normalizeCsv({ source, mapping: rules, delimiter: ",", sessionId })

test("CSV: BOM, Unicode, comillas escapadas, separador y saltos dentro de comillas", () => {
  const parsed = parseCsv(fixture("comillas-unicode.csv"), ",")
  assert.deepEqual(parsed.issues, [])
  assert.equal(parsed.headers[0], "Título")
  assert.equal(parsed.records.length, 3)
  assert.deepEqual(parsed.records.map((row) => row.ordinal), [1, 2, 3])
  assert.equal(parsed.records[0].cells[0], 'El libro, con "comillas"')
  assert.equal(parsed.records[0].cells[1], "Apellido, Nombre")
  assert.match(parsed.records[1].cells[0], /^Título con\r?\nsalto de línea$/)
  assert.equal(parsed.records[2].cells[0], "📚 Café y poesía")
})

test("CSV: coma, punto y coma, tabulador y CRLF/CR, seleccionados explícitamente", () => {
  for (const delimiter of [",", ";", "\t"] as const) {
    for (const newline of ["\r\n", "\r", "\n"]) {
      const parsed = parseCsv(`Título${delimiter}Autor${newline}"A${delimiter}B"${delimiter}"C${newline}D"${newline}`, delimiter)
      assert.deepEqual(parsed.issues, [])
      assert.deepEqual(parsed.records[0].cells, [`A${delimiter}B`, `C${newline}D`])
      assert.equal(parsed.records.length, 1)
    }
  }
})

test("CSV: conserva vacíos, campos finales y registros vacíos sin perderlos", () => {
  const parsed = parseCsv("A,B\nuno,\n\n,dos", ",")
  assert.deepEqual(parsed.records.map((row) => row.cells), [["uno", ""], [""], ["", "dos"]])
  assert.equal(parsed.issues[0].code, "COLUMN_COUNT")
  assert.equal(parsed.issues[0].record, 2)
})

test("CSV: cabeceras duplicadas, vacías y equivalentes en Unicode se notifican", () => {
  const parsed = parseCsv("Título, TÍTULO ,Cafe\u0301,Café,\nx,y,z,w,v", ",")
  assert.equal(parsed.issues.filter((issue) => issue.code === "DUPLICATE_HEADER").length, 2)
  assert.equal(parsed.issues.filter((issue) => issue.code === "EMPTY_HEADER").length, 1)
  assert.equal(parsed.records.length, 1)
})

test("CSV: conserva e identifica el registro truncado, sin numerar líneas físicas", () => {
  const parsed = parseCsv(fixture("truncado.csv"), ",")
  assert.equal(parsed.records.length, 2)
  assert.equal(parsed.issues.find((issue) => issue.code === "TRUNCATED_RECORD")?.record, 2)
  for (const source of ['A\ntexto"raro', 'A\n"cerrado"resto']) {
    assert.ok(parseCsv(source, ",").issues.some((issue) => issue.code === "UNEXPECTED_QUOTE"))
  }
})

test("CSV: rechaza UTF-8 inválido y admite un archivo vacío solo como incidencia", () => {
  assert.equal(parseCsv(new Uint8Array([0xc3, 0x28]), ",").issues[0].code, "INVALID_UTF8")
  assert.equal(parseCsv("\uFEFF", ",").issues[0].code, "EMPTY_FILE")
})

test("CSV: límites de 8 MiB medidos en bytes y 2000 registros sin truncamiento silencioso", () => {
  assert.equal(parseCsv(new Uint8Array(CSV_LIMITS.bytes + 1), ",").issues[0].code, "FILE_TOO_LARGE")
  assert.equal(parseCsv("é".repeat(CSV_LIMITS.bytes / 2 + 1), ",").issues[0].code, "FILE_TOO_LARGE")
  assert.equal(parseCsv("Título\n" + "A\n".repeat(2_000), ",").records.length, 2_000)
  const excessive = parseCsv("Título\n" + "A\n".repeat(2_001), ",")
  assert.equal(excessive.complete, false)
  assert.ok(excessive.issues.some((issue) => issue.code === "TOO_MANY_RECORDS"))
  const wide = parseCsv(Array.from({ length: 257 }, (_, index) => `Columna ${index}`).join(","), ",")
  assert.equal(wide.complete, false)
  assert.ok(wide.issues.some((issue) => issue.code === "TOO_MANY_COLUMNS"))
})

test("CSV: todo destino es explícito, título obligatorio y columnas/destinos únicos", () => {
  for (const rules of [mapping(["authors"]), mapping(["title", "title"]), { ...mapping(["title", "ignore"]), columns: [{ sourceColumn: 0, target: "title" }, { sourceColumn: 0, target: "ignore" }] }, mapping(["title"])]) {
    assert.equal(validateCsvMapping(["A", "B"], rules).mapping, null)
  }
  assert.deepEqual(validateCsvMapping(["A", "B"], mapping(["title", "ignore"])).issues, [])
  const duplicate = mapping(["title"])
  duplicate.statusEquivalences.push({ source: " LEÍDO ", status: "unread" })
  assert.equal(validateCsvMapping(["A"], duplicate).mapping, null)
})

test("CSV: salida canónica v2, ISBN opcional, fechas originales y verificación siempre falsa", async () => {
  const rules = mapping(["title", "authors", "isbn", "pages", "status", "shelf", "publishDate", "publishers"])
  const result = await convert(fixture("comillas-unicode.csv"), rules)
  assert.deepEqual(result.issues, [])
  assert.ok(result.payload)
  assert.ok(result.library)
  assert.equal(result.library.books.length, 3)
  assert.deepEqual(result.library.books[0].authors, [{ name: "Apellido, Nombre" }])
  assert.equal(result.library.books[1].isbn, null)
  assert.equal(result.library.books[1].legacyIdentifier, undefined)
  assert.equal(result.library.books[1].publish_date, "春 2026")
  assert.equal(result.library.books[0].publish_date, "1997")
  assert.equal(result.library.books[0].cover.large, "/default-book-cover.webp")
  assert.ok(result.library.books.every((book) => book.catalogue?.isbnVerified === false))
  assert.deepEqual(parseLibraryImport(result.payload), result.library)
  assert.deepEqual(parseLibraryImport(createBackupV2(result.library)), result.library)
})

test("CSV: compatible con lector JSON v1 si es representable sin pérdida", async () => {
  const result = await convert("Título,ISBN\nLibro,0-306-40615-2", mapping(["title", "isbn"]))
  assert.deepEqual(result.issues, [])
  assert.ok(result.library)
  const v1 = createLibraryExport(result.library)
  assert.equal(parseLibraryImport(v1).books[0].isbn, "9780306406157")
  const noIsbn = await convert("Título\nLibro sin ISBN", mapping(["title"]))
  assert.ok(noIsbn.library)
  assert.throws(() => createLibraryExport(noIsbn.library!), /formato 1 no conserva/)
})

test("CSV: divide autores/editoriales solo con los separadores elegidos", async () => {
  const source = 'Título,Autores,Editoriales\nLibro,"Apellido, Nombre|Otra autora","Uno;Dos"'
  const rules = mapping(["title", "authors", "publishers"])
  const untouched = await convert(source, rules)
  assert.deepEqual(untouched.library?.books[0].authors, [{ name: "Apellido, Nombre|Otra autora" }])
  const result = await convert(source, { ...rules, authorsSeparator: "|", publishersSeparator: ";" })
  assert.deepEqual(result.library?.books[0].authors, [{ name: "Apellido, Nombre" }, { name: "Otra autora" }])
  assert.deepEqual(result.library?.books[0].publishers, [{ name: "Uno" }, { name: "Dos" }])
})

test("CSV: páginas negativas, estado desconocido y checksum inválido bloquean con código/campo/muestra", async () => {
  const result = await convert(fixture("errores.csv"), mapping(["title", "pages", "status", "isbn"]))
  assert.equal(result.library, null)
  assert.equal(result.payload, null)
  assert.equal(result.rows.length, 3)
  assert.deepEqual(result.issues.map((issue) => [issue.record, issue.code, issue.field]), [[1, "INVALID_PAGES", "pages"], [2, "UNKNOWN_STATUS", "status"], [3, "INVALID_ISBN", "isbn"]])
  assert.equal(result.rows[1].book, null)
  assert.equal(result.issues[1].privateSample, "terminado quizá")
  assert.ok(result.issues.every((issue) => issue.privateSample.length <= 120))
})

test("CSV: corrige estados con tabla visible, nunca por fallback a leído", async () => {
  const rules = mapping(["title", "status"])
  const unknown = await convert("Título,Estado\nA,desconocido", rules)
  assert.equal(unknown.library, null)
  const fixed = await convert("Título,Estado\nA,desconocido", { ...rules, statusEquivalences: [...rules.statusEquivalences, { source: "desconocido", status: "to-read" }] })
  assert.equal(fixed.library?.books[0].status, "to-read")
  assert.equal((await convert("Título\nA", mapping(["title"]))).library?.books[0].status, "unread")
})

test("CSV: límites de campo iguales al JSON sin recortar valores", async () => {
  const cases: [CsvTarget, string, Partial<CsvMapping>][] = [
    ["title", "x".repeat(501), {}], ["authors", "x".repeat(201), {}], ["publishers", "x".repeat(201), {}],
    ["publishDate", "x".repeat(101), {}], ["shelf", "x".repeat(121), {}],
    ["authors", Array(31).fill("A").join("|"), { authorsSeparator: "|" }],
    ["publishers", Array(21).fill("A").join("|"), { publishersSeparator: "|" }],
  ]
  for (const [target, value, extra] of cases) {
    const rules = { ...mapping(target === "title" ? ["title"] : ["title", target]), ...extra }
    const result = await convert(target === "title" ? `Título\n${value}` : `Título,Extra\nLibro,${value}`, rules)
    assert.equal(result.library, null, target)
    assert.ok(result.issues.some((issue) => issue.code === "FIELD_LIMIT" && issue.field === target), target)
  }
  for (const pages of ["-1", "1.5", "1e2", "100001", "Infinity", "=1+1"]) {
    assert.ok((await convert(`Título,Páginas\nA,${pages}`, mapping(["title", "pages"]))).issues.some((issue) => issue.code === "INVALID_PAGES"))
  }
})

test("CSV: cabecera duplicada, truncado, fila corta y título vacío bloquean sin ocultar filas", async () => {
  for (const source of ["Título,Título\nA,B", 'Título,Autor\nA,B\n"C', "Título,Autor\nA,B\nC", "Título,Autor\n,B"]) {
    const result = await convert(source, mapping(["title", "authors"]))
    assert.equal(result.library, null)
    assert.equal(result.rows.length, parseCsv(source, ",").records.length)
    assert.ok(result.issues.length)
  }
})

test("CSV: fórmulas y SQL son texto literal y el informe escapa sin mutar el dominio", async () => {
  const source = fixture("formulas.csv")
  const parsed = parseCsv(source, ",")
  const result = await convert(source, mapping(["title", "authors"]))
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.library?.books.map((book) => book.title), parsed.records.map((row) => row.cells[0]))
  for (const value of ["=1+1", "@SUM(A1)", "+1+1", "-1+1", " \t=1", "\ttexto"]) {
    assert.ok(escapeCsvReportCell(value).startsWith('"\''))
  }
  const issue = csvIssue("UNKNOWN_STATUS", 1, "status", "=1+1", "Revisar")
  assert.ok(csvIssueReport([issue]).includes('"\'=1+1"'))
  assert.equal(issue.privateSample, "=1+1")
  assert.equal(escapeCsvReportCell('A,"B"'), '"A,""B"""')
})

test("CSV: muestras privadas Unicode acotadas incluso en errores enormes", () => {
  const issue = csvIssue("FIELD_LIMIT", 1, "title", "📚".repeat(100_000), "Revisar")
  assert.equal([...issue.privateSample].length, 120)
  const parsed = parseCsv('Título\n' + 'a"'.repeat(100_000), ",")
  assert.equal(parsed.issues.filter((entry) => entry.code === "UNEXPECTED_QUOTE").length, 1)
})

test("CSV: reintentos conservan claves y hashes; un mapeo corregido cambia hash y digest", async () => {
  const source = "Título,Autor\nUno,Ana\nDos,Luis"
  const rules = mapping(["title", "authors"])
  const first = await convert(source, rules)
  const replay = await convert(source, structuredClone(rules))
  assert.deepEqual(first, replay)
  assert.equal(first.inputHash, await csvSha256(new TextEncoder().encode(source)))
  const corrected = await convert(source, mapping(["title", "ignore"]))
  assert.equal(first.inputHash, corrected.inputHash)
  assert.notEqual(first.mappingHash, corrected.mappingHash)
  assert.notEqual(first.digest, corrected.digest)
  assert.deepEqual(first.rows.map((row) => row.sourceRowKey), corrected.rows.map((row) => row.sourceRowKey))
  assert.equal(first.rows[1].sourceRowKey, csvSourceRowKey(sessionId, 2))
  assert.notEqual(await csvMappingHash(rules, ","), await csvMappingHash(rules, ";"))
})

test("CSV: mismo ISBN compatible conserva dos copias; bibliografía discrepante exige revisión", async () => {
  const rules = mapping(["title", "isbn", "status"])
  const result = await convert("Título,ISBN,Estado\nLibro,9780306406157,Leído\nLibro,0-306-40615-2,Leyendo", rules)
  assert.deepEqual(result.issues, [])
  assert.equal(result.payload?.copies.length, 2)
  assert.equal(result.payload?.editions.length, 1)
  assert.notEqual(result.payload?.copies[0].id, result.payload?.copies[1].id)
  const conflict = await convert("Título,ISBN,Estado\nLibro,9780306406157,Leído\nDistinto,9780306406157,Leyendo", rules)
  assert.equal(conflict.library, null)
  assert.ok(conflict.issues.some((issue) => issue.code === "EDITION_CONFLICT" && issue.record === 2))
})

test("CSV: ida/vuelta de registros generados con comillas y Unicode en los tres separadores", () => {
  const pieces = ["a", "é", "📚", '"', ",", ";", "\t", "\n", "\r\n", " "]
  let seed = 13
  const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed }
  const records = Array.from({ length: 200 }, () => Array.from({ length: 4 }, () => Array.from({ length: next() % 12 }, () => pieces[next() % pieces.length]).join("")))
  for (const delimiter of [",", ";", "\t"] as const) {
    const quoted = (cell: string) => `"${cell.replace(/"/g, '""')}"`
    const source = ["Uno", "Dos", "Tres", "Cuatro"].join(delimiter) + "\r\n" + records.map((row) => row.map(quoted).join(delimiter)).join("\r\n")
    const parsed = parseCsv(source, delimiter)
    assert.deepEqual(parsed.issues, [])
    assert.deepEqual(parsed.records.map((row) => row.cells), records)
  }
})

test("CSV: listas hostiles y más de 200 estanterías producen incidencia", async () => {
  const hostile = await convert("Título,Autor\nLibro," + "a|".repeat(100_000), { ...mapping(["title", "authors"]), authorsSeparator: "|" })
  assert.equal(hostile.library, null)
  assert.ok(hostile.issues.some((issue) => issue.field === "authors" && issue.code === "FIELD_LIMIT"))
  const shelves = "Título,Estantería\n" + Array.from({ length: 200 }, (_, index) => `Libro ${index},Estantería ${index}`).join("\n")
  const result = await convert(shelves, mapping(["title", "shelf"]))
  assert.equal(result.library, null)
  assert.ok(result.issues.some((issue) => issue.field === "shelf" && issue.code === "FIELD_LIMIT"))
})

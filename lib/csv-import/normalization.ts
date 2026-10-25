import { z } from "zod"
import { createBackupV2, editionFingerprint, type PortableBackupV2 } from "../backup-v2"
import { normalizeBookCover } from "../book-covers"
import { canonicalJson } from "../import-plan"
import { normalizeIsbn } from "../isbn"
import { parseLibraryImport } from "../library-import"
import type { Book, LibraryData, Shelf } from "../types"
import { csvMappingHash, csvSha256, csvValueKey, validateCsvMapping, type CsvMapping, type CsvTarget } from "./mapping"
import { csvIssue, parseCsv, type CsvDelimiter, type CsvIssue, type CsvIssueCode } from "./parser"
import { csvSourceRowKey as persistentRowKey } from "./contracts"

export interface NormalizedCsvRow {
  ordinal: number
  sourceRowKey: string
  book: Book | null
  issues: CsvIssue[]
}
export interface NormalizedCsv {
  inputHash: string
  mappingHash: string | null
  /** Vincula bytes exactos, separador y todas las reglas del mapeo; cambia al corregirlo. */
  digest: string | null
  rows: NormalizedCsvRow[]
  issues: CsvIssue[]
  /** Cualquier incidencia bloquea el conjunto. No hay publicación parcial implícita. */
  library: LibraryData | null
  payload: PortableBackupV2 | null
  shelves: Shelf[]
}

/** Clave de origen, no ISBN ni ID de edición. El ordinal es el registro de datos desde 1. */
export function csvSourceRowKey(sessionId: string, ordinal: number): string {
  if (!z.uuid().safeParse(sessionId).success || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > 2_000) {
    throw new Error("La sesión o el número de registro CSV no es válido.")
  }
  return persistentRowKey(ordinal)
}

function names(value: string, separator: string | null, max: number): { name: string }[] {
  if (separator === null) return value.trim() ? [{ name: value.trim() }] : []
  const result: { name: string }[] = []
  let start = 0
  while (start <= value.length) {
    const end = value.indexOf(separator, start)
    const name = value.slice(start, end < 0 ? undefined : end).trim()
    if (name) result.push({ name })
    // max + 1 prueba el exceso sin reservar millones de objetos para entradas hostiles.
    if (result.length > max || end < 0) break
    start = end + separator.length
  }
  return result
}

/** Conversión pura: no elige políticas de duplicados contra la colección ni hace enriquecimiento. */
export async function normalizeCsv(input: {
  source: string | Uint8Array
  delimiter: CsvDelimiter
  mapping: unknown
  sessionId: string
}): Promise<NormalizedCsv> {
  // Validar incluso sin registros evita producir claves parciales con una sesión inválida.
  csvSourceRowKey(input.sessionId, 1)
  const parsed = parseCsv(input.source, input.delimiter)
  const checked = validateCsvMapping(parsed.headers, input.mapping)
  const inputHash = await csvSha256(input.source)
  const mapping = checked.mapping
  const mappingHash = mapping ? await csvMappingHash(mapping, input.delimiter) : null
  const digest = mappingHash ? await csvSha256(canonicalJson({ inputHash, mappingHash })) : null
  const issues = [...parsed.issues, ...checked.issues]
  const result: NormalizedCsv = { inputHash, mappingHash, digest, rows: [], issues, library: null, payload: null, shelves: [] }
  if (!mapping || !parsed.complete) return result
  const columns = new Map(mapping.columns.map((column) => [column.target, column.sourceColumn]))
  const statusTable = new Map(mapping.statusEquivalences.map((state) => [csvValueKey(state.source), state.status]))
  const shelves = new Map<string, Shelf>()
  const defaultKey = csvValueKey(mapping.defaultShelf)
  const shelfFor = (title: string): Shelf => {
    const key = csvValueKey(title)
    const existing = shelves.get(key)
    if (existing) return existing
    const shelf: Shelf = { id: `csv:${input.sessionId}:shelf:${shelves.size}`, title, book_count: 0, isDefault: key === defaultKey }
    shelves.set(key, shelf)
    return shelf
  }
  shelfFor(mapping.defaultShelf)
  const editions = new Map<string, { id: string; fingerprint: string }>()
  const issuesByRecord = new Map<number, CsvIssue[]>()
  for (const issue of parsed.issues) {
    const group = issuesByRecord.get(issue.record) ?? []
    group.push(issue); issuesByRecord.set(issue.record, group)
  }
  for (const record of parsed.records) {
    const rowIssues = [...(issuesByRecord.get(record.ordinal) ?? [])]
    const parserIssueCount = rowIssues.length
    const value = (field: CsvTarget) => { const column = columns.get(field); return column === undefined ? "" : (record.cells[column] ?? "").trim() }
    const add = (code: CsvIssueCode, field: CsvTarget, message: string) => rowIssues.push(csvIssue(code, record.ordinal, field, value(field), message))
    const limit = (field: CsvTarget, text: string, max: number) => { if (text.length > max) add("FIELD_LIMIT", field, `El campo supera el límite de ${max} caracteres.`) }
    const sourceRowKey = csvSourceRowKey(input.sessionId, record.ordinal)
    const title = value("title")
    if (!title) add("REQUIRED_TITLE", "title", "El título es obligatorio.")
    limit("title", title, 500)
    const rawIsbn = value("isbn")
    limit("isbn", rawIsbn, 100)
    const isbn = rawIsbn ? normalizeIsbn(rawIsbn) : null
    if (rawIsbn && !isbn) add("INVALID_ISBN", "isbn", "El ISBN no tiene un formato o checksum válido; corrígelo o deja el campo vacío.")
    const pages = value("pages")
    const numberOfPages = pages ? Number(pages) : 0
    if ((pages && !/^\d+$/.test(pages)) || !Number.isSafeInteger(numberOfPages) || numberOfPages < 0 || numberOfPages > 100_000) add("INVALID_PAGES", "pages", "Las páginas deben ser un entero entre 0 y 100000.")
    const rawStatus = value("status")
    const status = rawStatus ? statusTable.get(csvValueKey(rawStatus)) : mapping.defaultStatus
    limit("status", rawStatus, 200)
    if (!status) add("UNKNOWN_STATUS", "status", "El estado no figura en la tabla de equivalencias; añade una regla o corrige el valor.")
    const authors = names(value("authors"), mapping.authorsSeparator, 30)
    const publishers = names(value("publishers"), mapping.publishersSeparator, 20)
    for (const [field, list, max] of [["authors", authors, 30], ["publishers", publishers, 20]] as const) {
      if (list.length > max) add("FIELD_LIMIT", field, `El campo admite hasta ${max} nombres.`)
      for (const item of list) limit(field, item.name, 200)
    }
    const publishDate = value("publishDate")
    limit("publishDate", publishDate, 100) // Texto editorial original: no inventa día/mes.
    const shelfTitle = value("shelf") || mapping.defaultShelf
    limit("shelf", shelfTitle, 120)
    let book: Book | null = null
    if (!rowIssues.length && status) {
      const shelf = shelfFor(shelfTitle)
      book = {
        id: `${input.sessionId}:${sourceRowKey}`, isbn, title, authors, publishers, number_of_pages: numberOfPages, publish_date: publishDate,
        status, shelf_id: shelf.id, shelf_name: shelf.title, cover: normalizeBookCover(),
        catalogue: { source: "import", isbnVerified: false }, edition: { id: `${input.sessionId}:${sourceRowKey}` },
      }
      // Solo agrupa ISBN idénticos con bibliografía idéntica; conserva una copia por registro.
      if (isbn) {
        const fingerprint = editionFingerprint(book)
        const existing = editions.get(isbn)
        if (existing && existing.fingerprint !== fingerprint) {
          add("EDITION_CONFLICT", "isbn", "El mismo ISBN tiene datos bibliográficos distintos en otro registro; revisa ambas filas.")
          book = null
        } else if (existing) book.edition = { id: existing.id }
        else editions.set(isbn, { id: book.id, fingerprint })
      }
      if (book) shelf.book_count++
    }
    result.rows.push({ ordinal: record.ordinal, sourceRowKey, book, issues: rowIssues })
    // Las incidencias del parser ya están incluidas en el conjunto.
    issues.push(...rowIssues.slice(parserIssueCount))
  }
  result.shelves = [...shelves.values()]
  if (shelves.size > 200) issues.push(csvIssue("FIELD_LIMIT", 0, "shelf", "", "La importación admite hasta 200 estanterías."))
  if (issues.length) return result
  const library: LibraryData = { books: result.rows.flatMap((row) => row.book ? [row.book] : []), shelves: [...shelves.values()] }
  // Fecha fija del adaptador, sin reloj implícito. El export final pone su propia fecha.
  const payload = createBackupV2(library, new Date("1970-01-01T00:00:00.000Z"))
  try {
    result.library = parseLibraryImport(payload)
    result.payload = payload
  } catch {
    issues.push(csvIssue("CANONICAL_LIMIT", 0, "file", "", "La salida supera los límites del formato JSON de biblioteca; divide el archivo y revisa sus campos."))
  }
  return result
}

export type { CsvMapping }

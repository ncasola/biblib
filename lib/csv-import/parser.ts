/** CSV UTF-8 acotado. No interpreta celdas ni realiza escrituras o peticiones. */
export const CSV_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, records: 2_000, columns: 256, sample: 120 })
export type CsvDelimiter = "," | ";" | "\t"
export type CsvIssueCode =
  | "FILE_TOO_LARGE" | "INVALID_UTF8" | "INVALID_DELIMITER" | "EMPTY_FILE" | "EMPTY_HEADER"
  | "DUPLICATE_HEADER" | "TOO_MANY_COLUMNS" | "TOO_MANY_RECORDS" | "UNEXPECTED_QUOTE"
  | "TRUNCATED_RECORD" | "COLUMN_COUNT" | "INVALID_MAPPING" | "REQUIRED_TITLE"
  | "FIELD_LIMIT" | "INVALID_PAGES" | "UNKNOWN_STATUS" | "INVALID_ISBN" | "EDITION_CONFLICT"
  | "CANONICAL_LIMIT" | "EXISTING_COPY" | "INVALID_CHARACTER"

export interface CsvIssue {
  code: CsvIssueCode
  /** Cabecera = 0; datos desde 1. Un registro puede ocupar varias líneas físicas. */
  record: number
  field: string
  message: string
  /** Solo para la revisión privada del dueño; nunca enviar a logs o telemetría. */
  privateSample: string
}
export interface CsvRecord { ordinal: number; cells: string[] }
export interface ParsedCsv {
  delimiter: CsvDelimiter
  headers: string[]
  records: CsvRecord[]
  issues: CsvIssue[]
  /** false significa rechazo de límites/codificación; no se conoce el resto de registros. */
  complete: boolean
}

export function csvIssue(code: CsvIssueCode, record: number, field: string, value: string, message: string): CsvIssue {
  return { code, record, field, message, privateSample: [...value.slice(0, CSV_LIMITS.sample * 2)].slice(0, CSV_LIMITS.sample).join("") }
}

export function parseCsv(input: string | Uint8Array, delimiter: CsvDelimiter): ParsedCsv {
  const result: ParsedCsv = { delimiter, headers: [], records: [], issues: [], complete: true }
  const fail = (code: CsvIssueCode, message: string) => {
    result.issues.push(csvIssue(code, 0, "file", "", message))
    result.complete = false
    return result
  }
  if (![",", ";", "\t"].includes(delimiter)) return fail("INVALID_DELIMITER", "Selecciona coma, punto y coma o tabulador.")
  // Rechaza antes de decodificar/asignar copias de archivos grandes.
  if (input.length > CSV_LIMITS.bytes) return fail("FILE_TOO_LARGE", "El archivo supera el límite de 8 MiB.")
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input
  if (bytes.byteLength > CSV_LIMITS.bytes) return fail("FILE_TOO_LARGE", "El archivo supera el límite de 8 MiB.")
  let source: string
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
  catch { return fail("INVALID_UTF8", "El archivo debe estar codificado en UTF-8.") }
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1)
  if (!source.length) return fail("EMPTY_FILE", "El archivo no contiene cabecera.")

  let state: "start" | "plain" | "quoted" | "closed" = "start"
  let cells: string[] = []
  let cell = ""
  let ordinal = 0
  let touched = false
  const reported = new Set<string>()
  const problem = (code: CsvIssueCode, message: string) => {
    const key = `${ordinal}:${cells.length}:${code}`
    if (!reported.has(key)) result.issues.push(csvIssue(code, ordinal, String(cells.length), cell, message))
    reported.add(key)
  }
  const pushCell = () => { cells.push(cell); cell = ""; state = "start" }
  const pushRecord = () => {
    pushCell()
    if (ordinal === 0) result.headers = cells.map((header) => header.trim())
    else {
      result.records.push({ ordinal, cells })
      if (cells.length !== result.headers.length) result.issues.push(csvIssue("COLUMN_COUNT", ordinal, "record", cells.join(delimiter), "El registro no tiene el mismo número de columnas que la cabecera."))
    }
    ordinal++
    cells = []
    touched = false
  }
  for (let offset = 0; offset < source.length; offset++) {
    const char = source[offset]
    if (ordinal > CSV_LIMITS.records) {
      result.issues.push(csvIssue("TOO_MANY_RECORDS", ordinal, "record", "", "El archivo supera el límite de 2000 registros; no se ha importado ninguna fila."))
      result.complete = false
      break
    }
    touched = true
    if (char === "\0") problem("INVALID_CHARACTER", "La celda contiene un carácter nulo que no se puede guardar. Corrígelo antes de importar.")
    if (state === "quoted") {
      if (char === '"') {
        if (source[offset + 1] === '"') { cell += '"'; offset++ }
        else state = "closed"
      } else cell += char
      continue
    }
    if (char === delimiter) {
      pushCell()
      if (cells.length >= CSV_LIMITS.columns) {
        problem("TOO_MANY_COLUMNS", "El archivo supera el límite de 256 columnas.")
        result.complete = false
        break
      }
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && source[offset + 1] === "\n") offset++
      pushRecord()
    } else if (char === '"') {
      if (state === "start") state = "quoted"
      else { problem("UNEXPECTED_QUOTE", "Hay una comilla fuera de un campo entrecomillado."); cell += char; state = "plain" }
    } else {
      if (state === "closed") problem("UNEXPECTED_QUOTE", "Hay texto después del cierre de un campo entrecomillado.")
      cell += char
      state = "plain"
    }
  }
  if (result.complete && touched) {
    if (state === "quoted") problem("TRUNCATED_RECORD", "El archivo termina dentro de un campo entrecomillado.")
    pushRecord() // Conserva incluso el registro truncado para su revisión.
  }
  const seen = new Set<string>()
  for (const [column, header] of result.headers.entries()) {
    if (header.length > 500) result.issues.push(csvIssue("FIELD_LIMIT", 0, String(column), header, "La cabecera admite hasta 500 caracteres."))
    if (!header) result.issues.push(csvIssue("EMPTY_HEADER", 0, String(column), header, "La columna necesita una cabecera."))
    const key = header.normalize("NFC").toLocaleLowerCase("es")
    if (seen.has(key)) result.issues.push(csvIssue("DUPLICATE_HEADER", 0, String(column), header, "Hay una cabecera duplicada; corrígela antes de importar."))
    seen.add(key)
  }
  return result
}

/** CSV descargable: escapa fórmulas solo en la representación, conservando el valor de dominio. */
export function escapeCsvReportCell(value: string): string {
  const safe = /^[\s\u0000-\u001f]*[=+@-]/u.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/g, '""')}"`
}

export function csvIssueReport(issues: readonly CsvIssue[], delimiter: CsvDelimiter = ","): string {
  const rows = [["Registro", "Código", "Campo", "Muestra privada", "Mensaje"], ...issues.map((issue) => [String(issue.record), issue.code, issue.field, issue.privateSample, issue.message])]
  return "\uFEFF" + rows.map((row) => row.map(escapeCsvReportCell).join(delimiter)).join("\r\n")
}

import { z } from "zod"
import { canonicalJson } from "../import-plan"
import { csvIssue, type CsvDelimiter, type CsvIssue } from "./parser"
import type { Book } from "../types"

export const CSV_MAPPING_VERSION = 1
export const CSV_TARGETS = ["title", "authors", "isbn", "publishers", "pages", "publishDate", "status", "shelf", "ignore"] as const
export type CsvTarget = typeof CSV_TARGETS[number]
export interface CsvColumnMapping { sourceColumn: number; target: CsvTarget }
export interface CsvMapping {
  columns: CsvColumnMapping[]
  /** null conserva el texto completo: «Apellido, Nombre» es un solo autor. */
  authorsSeparator: string | null
  publishersSeparator: string | null
  /** Tabla visible y explícita; las claves se comparan tras trim + NFC + minúsculas. */
  statusEquivalences: { source: string; status: Book["status"] }[]
  defaultStatus: Book["status"]
  defaultShelf: string
}
export const DEFAULT_CSV_STATUS_EQUIVALENCES: CsvMapping["statusEquivalences"] = [
  { source: "read", status: "read" }, { source: "leído", status: "read" },
  { source: "reading", status: "reading" }, { source: "leyendo", status: "reading" },
  { source: "unread", status: "unread" }, { source: "sin leer", status: "unread" },
  { source: "to-read", status: "to-read" }, { source: "por leer", status: "to-read" },
]
export const csvValueKey = (value: string) => value.trim().normalize("NFC").toLocaleLowerCase("es")
const statusSchema = z.enum(["read", "reading", "unread", "to-read"])
const separatorSchema = z.string().min(1).max(10).nullable()
export const csvMappingSchema = z.object({
  columns: z.array(z.object({ sourceColumn: z.number().int().min(0).max(255), target: z.enum(CSV_TARGETS) }).strict()).min(1).max(256),
  authorsSeparator: separatorSchema,
  publishersSeparator: separatorSchema,
  statusEquivalences: z.array(z.object({ source: z.string().trim().min(1).max(200), status: statusSchema }).strict()).max(100),
  defaultStatus: statusSchema,
  defaultShelf: z.string().trim().min(1).max(120),
}).strict()

export function validateCsvMapping(headers: readonly string[], input: unknown): { mapping: CsvMapping | null; issues: CsvIssue[] } {
  const parsed = csvMappingSchema.safeParse(input)
  const issues: CsvIssue[] = []
  const issue = (field: string, sample: string, message: string) => issues.push(csvIssue("INVALID_MAPPING", 0, field, sample, message))
  if (!parsed.success) {
    for (const error of parsed.error.issues) issue(error.path.join("."), "", "El mapeo contiene una regla no válida.")
    return { mapping: null, issues }
  }
  const mapping = parsed.data
  const sources = new Set<number>()
  const targets = new Set<CsvTarget>()
  for (const column of mapping.columns) {
    if (column.sourceColumn >= headers.length || sources.has(column.sourceColumn)) issue(String(column.sourceColumn), "", "Cada columna debe aparecer una sola vez en el mapeo.")
    if (column.target !== "ignore" && targets.has(column.target)) issue(column.target, "", "Un campo de destino solo puede recibir una columna.")
    sources.add(column.sourceColumn)
    targets.add(column.target)
  }
  if (sources.size !== headers.length) issue("columns", "", "Elige un destino o «Ignorar» para cada columna.")
  if (!targets.has("title")) issue("title", "", "Selecciona la columna del título.")
  const states = new Set<string>()
  for (const state of mapping.statusEquivalences) {
    const key = csvValueKey(state.source)
    if (states.has(key)) issue("status", state.source, "La tabla de estados contiene equivalencias duplicadas.")
    states.add(key)
  }
  return { mapping: issues.length ? null : mapping, issues }
}

/** SHA-256 disponible en navegador y Node; sin reloj, aleatoriedad ni efectos externos. */
export async function csvSha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function csvMappingHash(mapping: CsvMapping, delimiter: CsvDelimiter): Promise<string> {
  return csvSha256(canonicalJson({ mappingVersion: CSV_MAPPING_VERSION, delimiter, mapping: { ...mapping, columns: [...mapping.columns].sort((a, b) => a.sourceColumn - b.sourceColumn) } }))
}

import type { ActionResult } from "../action-result"
import type { ImportMode, ImportPlan } from "../import-plan"
import type { CsvMapping } from "./mapping"
import type { CsvDelimiter, CsvIssue, CsvRecord } from "./parser"

/** Contratos de fase 1: no exportan acciones ejecutables ni simulan persistencia. */
export interface InspectCsvInput {
  sessionId: string
  delimiter: CsvDelimiter
  /** Trozos originales de hasta 256 KiB; se decodifican juntos, nunca UTF-8 por trozo. */
  chunk: { ordinal: number; total: number; sha256: string; bytes: Blob }
}
export interface InspectedCsv {
  sessionId: string
  version: string
  complete: boolean
  headers: string[]
  /** Como máximo 10 registros privados; no forman parte de un perfil de mapeo. */
  sampleRows: CsvRecord[]
  recordCount: number | null
  inputHash: string | null
  issues: CsvIssue[]
}
export interface SetCsvMappingInput { sessionId: string; expectedVersion: string; mapping: CsvMapping; mappingVersion: number }
export interface CsvMappingReceipt { sessionId: string; version: string; mappingHash: string; mappingVersion: number }
export type CsvDuplicatePolicy = "skip-existing" | "another-copy"
export interface PrepareCsvImportInput {
  sessionId: string
  mode: ImportMode
  duplicatePolicy: CsvDuplicatePolicy
  /** Por defecto bloquea; omitir exige elección explícita y lista durable de filas. */
  invalidRows?: "block" | "skip-invalid"
}
export interface CsvImportPreview {
  sessionId: string
  previewId: string
  revision: string
  digest: string
  expiresAt: string
  inputHash: string
  mappingHash: string
  plan: ImportPlan
  issues: CsvIssue[]
  omittedRows: { sourceRowKey: string; ordinal: number; codes: CsvIssue["code"][] }[]
}
export interface CsvImportActions {
  inspectCsvAction(input: InspectCsvInput): Promise<ActionResult<InspectedCsv>>
  setCsvMappingAction(input: SetCsvMappingInput): Promise<ActionResult<CsvMappingReceipt>>
  prepareCsvImportAction(input: PrepareCsvImportInput): Promise<ActionResult<CsvImportPreview>>
}

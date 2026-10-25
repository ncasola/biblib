// Contratos persistentes de la importación CSV (U-DAT-09) en 0014: el mapeo versionado de una sesión sobre el
// staging de 0008, la clave durable de cada registro y los perfiles de mapeo guardados (privados, versionados y
// sin muestras). El parser, la normalización y las acciones son de la unidad. Documentación:
// docs/spec-pendientes/contratos-o13.md.

export const CSV_LIMITS = Object.freeze({ maxBytes: 8 * 1024 * 1024, maxRecords: 2000, mappingBytes: 16_384, profilesPerAccount: 20, profileNameMax: 80, issuesPerRow: 50 })

export const CSV_DELIMITERS = [",", ";", "\t"] as const
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number]

export const CSV_TARGET_FIELDS = ["title", "authors", "isbn", "publishers", "pages", "publishDate", "status", "shelf", "ignore"] as const
export type CsvTargetField = (typeof CSV_TARGET_FIELDS)[number]

export interface CsvColumnMapping {
  /** Cabecera de la columna (o su posición, `#3`, si el archivo no tiene cabecera). */
  sourceColumn: string
  target: CsvTargetField
  /** Separador explícito para dividir autores o editoriales; sin él, la celda es un solo valor. */
  separator?: string
}

/**
 * Mapeo explícito de una sesión o de un perfil guardado. `statusMap` es la tabla visible de equivalencias: un valor
 * que no aparece en ella es una incidencia, nunca «Leído». Se guarda como JSON (≤ 16 KiB) junto con su versión.
 */
export interface CsvMapping {
  delimiter: CsvDelimiter
  header: boolean
  columns: CsvColumnMapping[]
  statusMap?: Record<string, "read" | "reading" | "unread" | "to-read">
}

/** Incidencia de un registro CSV: código y campo, sin el contenido de la celda. */
export interface CsvRowIssue {
  code: string
  field?: CsvTargetField | "record"
}

/**
 * Clave durable de un registro: estable para la misma sesión y ordinal (número de registro CSV, no de línea física),
 * de modo que un reintento con el mismo archivo y mapeo no duplica filas ni regenera identificadores manuales.
 */
export function csvSourceRowKey(ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 1_000_000) throw new RangeError("Ordinal de registro CSV fuera de rango.")
  return `csv:${ordinal}`
}

/** Perfil de mapeo guardado a petición de la persona: nombre, mapeo y su versión. Nunca filas ni muestras. */
export interface CsvMappingProfile {
  id: string
  name: string
  mapping: CsvMapping
  mappingVersion: number
  version: string
}

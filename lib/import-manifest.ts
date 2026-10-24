import { z } from "zod"
import { canonicalJson } from "./import-plan"
import { MAX_IMPORT_BOOKS, MAX_IMPORT_BYTES, MAX_IMPORT_SHELVES } from "./library-import"

// Manifest de un conjunto de partes (U-DAT-04, `bundleVersion: 1`). Funciones puras, válidas en el
// navegador y en el servidor. El hash de cada parte se calcula fuera (Web Crypto o node:crypto) sobre
// los bytes UTF-8 exactos del archivo descargado, nunca sobre JSON reserializado. El manifest acredita
// integridad, orden y cantidades; no firma la autoría ni lleva `user_id`. `bundleVersion` es
// independiente del payload de cada parte (`formatVersion` 1 o 2).

export const BACKUP_SET_KIND = "biblib.backup-set" as const
export const BUNDLE_VERSION = 1 as const

/** Límites iniciales del conjunto; cualquier aumento exige medición (docs/operacion.md). */
export const RESTORE_LIMITS = Object.freeze({
  maxBooks: 10_000,
  maxShelves: 1_000,
  maxBytes: 80 * 1024 * 1024,
  maxParts: 50,
  maxPartBytes: MAX_IMPORT_BYTES,
  chunkBytes: 256 * 1024,
  sessionTtlDays: 7,
  /** Sesiones sin publicar ni caducar por cuenta. */
  maxOpenSessions: 3,
})

export type PartCountsV1 = { books: number; shelves: number }
export type PartCountsV2 = { works: number; editions: number; copies: number; shelves: number }
export type PartCounts = PartCountsV1 | PartCountsV2

export interface BackupSetPart {
  /** Clave estable de la parte dentro del conjunto. */
  partId: string
  index: number
  byteLength: number
  sha256: string
  counts: PartCounts
}

export interface BackupSetManifest {
  kind: typeof BACKUP_SET_KIND
  bundleVersion: typeof BUNDLE_VERSION
  exportSetId: string
  exportedAt: string
  payloadFormatVersion: 1 | 2
  parts: BackupSetPart[]
  /** Cantidades globales únicas: una estantería que aparece en varias partes cuenta una vez. */
  totals: PartCounts
}

export type ManifestErrorCode = "MANIFEST_MISMATCH" | "LIMIT_EXCEEDED" | "INVALID_INPUT"

export class ManifestError extends Error {
  constructor(readonly code: ManifestErrorCode, message: string) {
    super(message)
    this.name = "ManifestError"
  }
}

const count = z.number().int().min(0).max(1_000_000)
const countsV1Schema = z.object({ books: count, shelves: count }).strict()
const countsV2Schema = z.object({ works: count, editions: count, copies: count, shelves: count }).strict()
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
export const partIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

const manifestSchema = z.object({
  kind: z.literal(BACKUP_SET_KIND),
  bundleVersion: z.literal(BUNDLE_VERSION),
  exportSetId: z.uuid(),
  exportedAt: z.iso.datetime(),
  payloadFormatVersion: z.union([z.literal(1), z.literal(2)]),
  parts: z.array(z.object({
    partId: partIdSchema,
    index: z.number().int().min(0),
    byteLength: z.number().int().min(1),
    sha256: sha256Schema,
    counts: z.union([countsV1Schema, countsV2Schema]),
  }).strict()).min(1).max(1_000),
  totals: z.union([countsV1Schema, countsV2Schema]),
}).strict()

/** Número de trozos de 256 KiB de una parte. */
export function chunkCount(byteLength: number): number {
  return Math.ceil(byteLength / RESTORE_LIMITS.chunkBytes)
}

/** Clave estable de la parte `index` (base 0) de un conjunto. */
export function partIdFor(index: number): string {
  return `parte-${String(index + 1).padStart(2, "0")}`
}

/** Libros (copias en v2) y estanterías de unas cantidades de cualquier formato. */
export function bookAndShelfCounts(counts: PartCounts): PartCountsV1 {
  return "copies" in counts ? { books: counts.copies, shelves: counts.shelves } : { books: counts.books, shelves: counts.shelves }
}

export function sameCounts(a: PartCounts, b: PartCounts): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

/**
 * Cantidades declaradas por el contenido de una parte ya decodificada, sin validarla todavía:
 * v1 y legacy por libros/estanterías; v2 por obras/ediciones/copias/estanterías.
 */
export function payloadCounts(raw: unknown): { formatVersion: 1 | 2; counts: PartCounts } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ManifestError("INVALID_INPUT", "La parte no tiene un formato de biblioteca válido.")
  const length = (key: string) => {
    const value = (raw as Record<string, unknown>)[key]
    return Array.isArray(value) ? value.length : 0
  }
  const version = (raw as Record<string, unknown>).formatVersion
  if (version === 2) return { formatVersion: 2, counts: { works: length("works"), editions: length("editions"), copies: length("copies"), shelves: length("shelves") } }
  // El formato antiguo sin versión se trata como v1: los lectores comparten la misma forma.
  if (version === 1 || version === undefined) return { formatVersion: 1, counts: { books: length("books"), shelves: length("shelves") } }
  throw new ManifestError("INVALID_INPUT", "Una parte usa una versión del formato de biblioteca que no es compatible.")
}

function mismatch(message: string): never { throw new ManifestError("MANIFEST_MISMATCH", message) }
function limit(message: string): never { throw new ManifestError("LIMIT_EXCEEDED", message) }

/** Comprueba los límites del conjunto antes de aceptar ningún byte: partes, tamaño y cantidades. */
export function assertSetLimits(parts: readonly { byteLength: number }[], totals?: PartCounts): void {
  if (parts.length > RESTORE_LIMITS.maxParts) limit(`El conjunto tiene ${parts.length} partes; se admiten hasta ${RESTORE_LIMITS.maxParts}. No se ha modificado nada.`)
  if (parts.some((part) => part.byteLength > RESTORE_LIMITS.maxPartBytes)) limit("Alguna parte supera el límite de 8 MiB por archivo. No se ha modificado nada.")
  const bytes = parts.reduce((total, part) => total + part.byteLength, 0)
  if (bytes > RESTORE_LIMITS.maxBytes) limit("El conjunto supera el límite de 80 MiB. No se ha modificado nada.")
  if (totals) {
    const { books, shelves } = bookAndShelfCounts(totals)
    if (books > RESTORE_LIMITS.maxBooks) limit(`El conjunto tiene ${books.toLocaleString("es")} libros; se admiten hasta ${RESTORE_LIMITS.maxBooks.toLocaleString("es")}. No se ha modificado nada.`)
    if (shelves > RESTORE_LIMITS.maxShelves) limit(`El conjunto tiene ${shelves.toLocaleString("es")} estanterías; se admiten hasta ${RESTORE_LIMITS.maxShelves.toLocaleString("es")}. No se ha modificado nada.`)
  }
}

/** Duplicados de partes: el mismo archivo dos veces se reconoce por su hash. */
export function assertDistinctParts(parts: readonly { sha256: string }[]): void {
  if (new Set(parts.map((part) => part.sha256)).size !== parts.length) mismatch("La misma parte aparece dos veces en el conjunto. Revisa los archivos seleccionados.")
}

/**
 * Lee y comprueba un manifest: forma estricta, orden contiguo, partes distintas, cantidades por
 * formato coherentes con los totales y límites. Lanza `ManifestError` sin modificar nada.
 */
export function parseBackupSetManifest(input: unknown): BackupSetManifest {
  const parsed = manifestSchema.safeParse(input)
  if (!parsed.success) {
    if (input && typeof input === "object" && "kind" in input && input.kind === BACKUP_SET_KIND && "bundleVersion" in input && input.bundleVersion !== BUNDLE_VERSION) {
      throw new ManifestError("INVALID_INPUT", "Este manifiesto usa una versión de conjunto que esta versión de BibLib no conoce. No se ha modificado nada.")
    }
    throw new ManifestError("INVALID_INPUT", "El manifiesto del conjunto no es válido: debe incluir el identificador, la fecha, el formato y la lista ordenada de partes con su tamaño, hash y cantidades.")
  }
  const manifest = parsed.data as BackupSetManifest
  const v2 = manifest.payloadFormatVersion === 2
  const shapeOk = (counts: PartCounts) => ("copies" in counts) === v2
  if (!shapeOk(manifest.totals) || manifest.parts.some((part) => !shapeOk(part.counts))) mismatch("Las cantidades del manifiesto no corresponden al formato de sus partes.")
  manifest.parts.forEach((part, index) => { if (part.index !== index) mismatch("El manifiesto no tiene las partes en orden o le falta alguna posición.") })
  if (new Set(manifest.parts.map((part) => part.partId)).size !== manifest.parts.length) mismatch("El manifiesto repite el identificador de una parte.")
  assertDistinctParts(manifest.parts)
  assertSetLimits(manifest.parts, manifest.totals)
  for (const part of manifest.parts) {
    const { books, shelves } = bookAndShelfCounts(part.counts)
    if (books > MAX_IMPORT_BOOKS || shelves > MAX_IMPORT_SHELVES) mismatch("Una parte declara más libros o estanterías de los que admite un archivo.")
    if ("copies" in part.counts && part.counts.editions !== part.counts.copies) mismatch("Una parte declara un número de ediciones distinto del de copias.")
  }
  const sum = manifest.parts.reduce((total, part) => total + bookAndShelfCounts(part.counts).books, 0)
  const totals = bookAndShelfCounts(manifest.totals)
  const shelfSum = manifest.parts.reduce((total, part) => total + bookAndShelfCounts(part.counts).shelves, 0)
  const shelfMax = Math.max(...manifest.parts.map((part) => bookAndShelfCounts(part.counts).shelves))
  if (totals.books !== sum) mismatch("El total de libros del manifiesto no coincide con la suma de sus partes.")
  if (totals.shelves > shelfSum || totals.shelves < shelfMax) mismatch("El total de estanterías del manifiesto no es coherente con sus partes.")
  if ("copies" in manifest.totals && manifest.totals.editions !== manifest.totals.copies) mismatch("El total de ediciones del manifiesto no coincide con el de copias.")
  return manifest
}

export interface ManifestPartInput { byteLength: number; sha256: string; counts: PartCounts }

/** Construye un manifest con partes en el orden dado (exportación o asistente de partes sueltas). */
export function createBackupSetManifest(input: { exportSetId: string; exportedAt: string; payloadFormatVersion: 1 | 2; parts: ManifestPartInput[]; totals: PartCounts }): BackupSetManifest {
  return {
    kind: BACKUP_SET_KIND,
    bundleVersion: BUNDLE_VERSION,
    exportSetId: input.exportSetId,
    exportedAt: input.exportedAt,
    payloadFormatVersion: input.payloadFormatVersion,
    parts: input.parts.map((part, index) => ({ partId: partIdFor(index), index, byteLength: part.byteLength, sha256: part.sha256, counts: part.counts })),
    totals: input.totals,
  }
}

/** Texto exacto del manifest descargable: el orden de claves empieza por `kind` para reconocerlo leyendo poco. */
export function serializeBackupSetManifest(manifest: BackupSetManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** Entrada canónica del hash global de una sesión. */
export function manifestCanonical(manifest: BackupSetManifest): string {
  return canonicalJson(manifest)
}

/** Reconoce un manifest por el principio del archivo, sin leer ni decodificar partes grandes. */
export function looksLikeManifest(head: string): boolean {
  return /^\s*\{\s*"kind"\s*:\s*"biblib\.backup-set"/.test(head)
}

const stamp = (exportedAt: string) => exportedAt.replace(/[:.]/g, "-")

/** Nombres de los archivos de un conjunto: partes numeradas y manifiesto. */
export function backupFileNames(exportedAt: string, formatVersion: 1 | 2, total: number): { part: (index: number) => string; manifest: string } {
  const base = `biblib-backup-${formatVersion === 2 ? "v2-" : ""}${stamp(exportedAt)}`
  return {
    part: (index) => `${base}${total > 1 ? `-parte-${String(index + 1).padStart(String(total).length, "0")}-de-${total}` : ""}.json`,
    manifest: `${base}-conjunto.json`,
  }
}

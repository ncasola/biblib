import { createHash } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import type { DatabaseTransaction } from "./db/client"
import { coverAssets, librarySnapshots, shelves, type LibrarySnapshotReason } from "./db/schema"
import { deleteAllCopies, insertPlannedCopies } from "./db/model"
import { applyProductData, deleteAccountProduct, readProductTargets } from "./db/product"
import { DomainError, databaseErrorCode } from "./domain-errors"
import { editionFingerprint } from "./backup-v2"
import { canonicalJson, IMPORT_RULES_VERSION, planEditions, type CollectionSnapshot, type IdAllocator, type ImportMode, type ImportPlan } from "./import-plan"
import { normalizeIsbn } from "./isbn"
import type { CopyRating, LocationKind } from "./product/contracts"
import { READING_CYCLE_STATUSES, type Loan, type ReadingCycle, type ReadingCycleStatus } from "./product/reading-loans"
import type { ConfidenceLabel, EvidenceEntry, EvidenceOrigin, EvidenceSourceKind } from "./review/contracts"
import type { Author, Book, CatalogueMetadata, CopyVerification, EditionIdentifiers, LibraryData, Publisher } from "./types"

// Versiones anteriores de la colección (U-DAT-02). Funciones puras (plan de restauración, cursor,
// límites) y el acceso a Postgres que usan el publicador y las acciones dentro de una transacción
// del dueño. Capturar y borrar pasan por las funciones `biblib.library_snapshot_*` de 0006.

/** Límites iniciales propuestos; F4 fija la capacidad definitiva. Los aplica también la migración 0006. */
export const SNAPSHOT_LIMITS = Object.freeze({
  /** Versiones vigentes por cuenta. Con la cuota agotada se bloquea la operación destructiva. */
  maxPerAccount: 10,
  retentionDays: 30,
  maxBooks: 10_000,
  maxShelves: 1_000,
  chunkSize: 200,
  pageSize: 10,
  maxPageSize: 20,
})
/**
 * 1: ficha legacy (0006–0010). 2: ejemplar con su edición, obra y comprobación (0011, U-DAT-06). 3 (0014, O13): además
 * nota, valoración y etiquetas, ubicación, serie de la edición y evidencias, con las etiquetas, ubicaciones y series de la
 * cuenta en trozos propios tras los libros. 4 (0015, O14): además los ciclos de lectura con sus entradas y los préstamos de
 * cada ejemplar.
 */
export const SNAPSHOT_SCHEMA_VERSION = 4

/** Tablas privadas que la limpieza de cuenta (U-OPS-03) debe incluir; todas cuelgan de `auth.users`. */
export const SNAPSHOT_INVENTORY = Object.freeze(["biblib.library_snapshots", "biblib.library_snapshot_chunks", "biblib.import_previews (snapshot_id)"])

export interface SnapshotShelfEntry { id: string; title: string; is_default: boolean; created_at: string }

/** Evidencia tal como la guarda una versión anterior (`biblib.evidence_snapshot_item`, 0014). */
export interface SnapshotEvidenceEntry {
  id: string
  source_kind: EvidenceSourceKind
  source_ref?: string
  source_url?: string
  photo_asset_id?: string
  observed_at?: string
  field_claims: Record<string, unknown>
  confidence: ConfidenceLabel
  origin: EvidenceOrigin
}
/** Ciclo de lectura tal como lo guarda una versión anterior (0015): instantes como texto ISO, sin claves nulas. */
export interface SnapshotReadingCycleEntry {
  id: string
  cycle_number: number
  status: ReadingCycleStatus
  started_at?: string
  finished_at?: string
  entries?: { id: string; occurred_at: string; page_from?: number; page_to?: number; note?: string }[]
}
/** Préstamo tal como lo guarda una versión anterior (0015): fechas civiles `AAAA-MM-DD`. */
export interface SnapshotLoanEntry { id: string; borrower_label: string; loaned_on: string; due_on?: string; returned_on?: string; note?: string }
export interface SnapshotTagEntry { id: string; name: string; created_at: string }
export interface SnapshotLocationEntry { id: string; parent_id: string | null; name: string; kind: LocationKind; photo_asset_id: string | null; created_at: string }
export interface SnapshotSeriesEntry { id: string; title: string; description: string | null; created_at: string }
/**
 * Ejemplar de una versión anterior. En schema_version 2, `isbn` es el ISBN-13 de su edición (o null) y
 * `edition_id` agrupa los ejemplares de una edición; en 1, `isbn` es el texto legacy de la ficha.
 */
export interface SnapshotBookEntry {
  id: string
  isbn: string | null
  title: string
  subtitle: string | null
  authors: Author[]
  publishers: Publisher[]
  catalogue: CatalogueMetadata
  number_of_pages: number
  publish_date: string
  cover_small: string
  cover_medium: string
  cover_large: string
  status: Book["status"]
  shelf_id: string
  created_at: string
  /** Portada privada de la ficha (U-DAT-10, desde 0009); ausente en las fichas sin asset y en versiones anteriores. */
  cover_asset_id?: string
  edition_id?: string
  verification?: CopyVerification
  legacy_identifier?: string
  work_id?: string
  work_title?: string | null
  language?: string
  identifiers?: EditionIdentifiers
  /** schema_version 3 (0014): datos de producto del ejemplar y de su edición. */
  personal?: { notes?: string; rating?: CopyRating; tag_ids?: string[] }
  location?: { location_id: string; shelf_label?: string; position?: number }
  series?: { series_id: string; position?: string; volume_label?: string; order_note?: string }
  evidence?: SnapshotEvidenceEntry[]
  edition_evidence?: SnapshotEvidenceEntry[]
  /** schema_version 4 (0015): lectura y préstamos del ejemplar. */
  reading?: SnapshotReadingCycleEntry[]
  loans?: SnapshotLoanEntry[]
}
export interface SnapshotContent {
  shelves: SnapshotShelfEntry[]
  books: SnapshotBookEntry[]
  /** schema_version 3 (0014); ausentes o vacíos en versiones anteriores. */
  tags?: SnapshotTagEntry[]
  locations?: SnapshotLocationEntry[]
  series?: SnapshotSeriesEntry[]
}

export interface SnapshotSummary {
  id: string
  reason: LibrarySnapshotReason
  createdAt: string
  expiresAt: string
  books: number
  shelves: number
  /** Autoriza solo el borrado de esta versión. */
  version: string
}

export interface SnapshotPage {
  items: SnapshotSummary[]
  nextCursor: string | null
  quota: { used: number; limit: number }
  retentionDays: number
}

export function snapshotQuotaExceeded(): DomainError {
  return new DomainError("LIMIT_EXCEEDED", `Has alcanzado el máximo de ${SNAPSHOT_LIMITS.maxPerAccount} versiones anteriores guardadas. No se ha aplicado nada: elimina alguna versión en Ajustes › Versiones anteriores y vuelve a intentarlo.`)
}

export function snapshotTooLarge(): DomainError {
  return new DomainError("LIMIT_EXCEEDED", `Tu biblioteca supera el tamaño que se puede guardar como versión anterior (${SNAPSHOT_LIMITS.maxBooks.toLocaleString("es")} libros). No se ha aplicado nada; descarga una copia y usa la fusión en su lugar.`)
}

/** Un trabajo solo conserva el código: el mensaje cubre la cuota y el tamaño máximo. */
export function snapshotCaptureBlocked(): DomainError {
  return new DomainError("LIMIT_EXCEEDED", `No se ha reemplazado nada: antes hay que guardar la colección actual como versión anterior y no hay espacio (máximo ${SNAPSHOT_LIMITS.maxPerAccount} versiones y ${SNAPSHOT_LIMITS.maxBooks.toLocaleString("es")} libros por versión). Elimina alguna versión en Ajustes › Versiones anteriores o usa la fusión.`)
}

export function snapshotUnavailable(): DomainError {
  return new DomainError("NOT_FOUND", "Esa versión anterior ya no está disponible. Puede que se haya eliminado o caducado; revisa el historial.")
}

export function snapshotExpired(): DomainError {
  return new DomainError("PREVIEW_EXPIRED", "Esa versión anterior ha caducado y ya no se puede restaurar.")
}

export function snapshotDamaged(): DomainError {
  return new DomainError("CONFLICT", "Esa versión anterior no supera la comprobación de integridad y no se puede restaurar. No se ha aplicado nada.")
}

export function accountInactive(): DomainError {
  return new DomainError("UNAUTHORIZED", "Tu cuenta no admite operaciones nuevas en este momento.")
}

/** Traduce los códigos propios de 0006 (BS001–BS003) a errores de dominio; el resto se relanza. */
export function translateSnapshotError(error: unknown): never {
  const code = databaseErrorCode(error)
  if (code === "BS001") throw snapshotQuotaExceeded()
  if (code === "BS002") throw accountInactive()
  if (code === "BS003") throw snapshotTooLarge()
  throw error
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

/** Hash de la entrada canónica de una restauración: versión, modo y reglas (como `confirmationDigest`). */
export function restoreDigest(preview: { inputDigest: string; mode: ImportMode; rulesVersion: number }): string {
  return sha256(canonicalJson({ operation: "snapshot.restore", inputDigest: preview.inputDigest, mode: preview.mode, rulesVersion: preview.rulesVersion }))
}

/** Mismo cálculo que `library_snapshot_capture`: cantidades y hashes de los trozos en orden. */
export function snapshotDigest(counts: { books: number; shelves: number }, chunkDigests: string[]): string {
  return sha256(["biblib.snapshot.v1", counts.books, counts.shelves, chunkDigests.join("")].join("|"))
}

// Cursor opaco del historial: fecha de creación (con microsegundos, como la guarda Postgres) e ID.
const cursorSchema = z.tuple([z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/).max(40), z.uuid()])

export function encodeSnapshotCursor(position: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify([position.createdAt, position.id]), "utf8").toString("base64url")
}

export function decodeSnapshotCursor(cursor: string | null | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null
  if (cursor.length > 200) throw new DomainError("INVALID_INPUT", "La posición del historial no es válida. Vuelve a cargarlo.")
  try {
    const [createdAt, id] = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")))
    return { createdAt, id }
  } catch {
    throw new DomainError("INVALID_INPUT", "La posición del historial no es válida. Vuelve a cargarlo.")
  }
}

export function pageLimit(limit: unknown): number {
  const value = typeof limit === "number" && Number.isInteger(limit) ? limit : SNAPSHOT_LIMITS.pageSize
  return Math.min(Math.max(value, 1), SNAPSHOT_LIMITS.maxPageSize)
}

export interface BuildRestorePlanInput {
  snapshot: SnapshotContent
  current: CollectionSnapshot
  /** IDs de la versión que hoy usa otra cuenta: se reasignan e informan. */
  foreign: ReadonlySet<string>
  allocateId: IdAllocator
}

/**
 * Plan de una restauración completa como reemplazo: conserva los IDs propios de la versión (también
 * los de libros borrados después) salvo los ocupados por otra cuenta, mantiene la predeterminada
 * actual y elimina lo añadido después de la captura. Las versiones de las fichas se regeneran al
 * insertar; nunca se reutiliza un token anterior.
 */
export function buildRestorePlan({ snapshot, current, foreign, allocateId }: BuildRestorePlanInput): ImportPlan {
  const defaultShelf = current.shelves.find((shelf) => shelf.isDefault)
  if (!defaultShelf) throw new Error("La colección actual no tiene estantería predeterminada.")
  const currentCustom = new Set(current.shelves.filter((shelf) => !shelf.isDefault).map((shelf) => shelf.id))
  const currentBooks = new Set(current.books.map((book) => book.id))
  const idFor = (kind: "book" | "shelf", id: string) => foreign.has(id) ? allocateId(kind, id) : id

  const create: ImportPlan["shelves"]["create"] = []
  const map: ImportPlan["shelves"]["map"] = []
  const reassigned: ImportPlan["reassigned"] = []
  // Títulos exactos, como la unicidad de la base: dos estanterías que solo difieren en mayúsculas siguen separadas.
  const titles = new Map<string, string>([[defaultShelf.title, defaultShelf.id]])
  for (const shelf of snapshot.shelves) {
    const target = shelf.is_default ? defaultShelf.id : titles.get(shelf.title)
    if (target) {
      map.push({ sourceId: shelf.id, id: target })
      if (target !== shelf.id) reassigned.push({ kind: "shelf", sourceId: shelf.id, id: target })
      continue
    }
    const id = idFor("shelf", shelf.id)
    if (id !== shelf.id) reassigned.push({ kind: "shelf", sourceId: shelf.id, id })
    create.push({ sourceId: shelf.id, id, title: shelf.title })
    map.push({ sourceId: shelf.id, id })
    titles.set(shelf.title, id)
  }
  const shelfFor = new Map(map.map((entry) => [entry.sourceId, entry.id]))

  const insert: { sourceId: string; id: string; shelfId: string }[] = []
  let matched = 0
  for (const book of snapshot.books) {
    const shelfId = shelfFor.get(book.shelf_id)
    if (!shelfId) throw new Error("La versión anterior tiene libros con una estantería inexistente.")
    const id = idFor("book", book.id)
    if (id !== book.id) reassigned.push({ kind: "book", sourceId: book.id, id })
    if (currentBooks.has(id)) matched++
    insert.push({ sourceId: book.id, id, shelfId })
  }
  // Ediciones y obras con sus IDs de la versión salvo los que hoy usa otra cuenta (internos, no se informan).
  const editions = planEditions(snapshotRows(snapshot), insert, allocateId, {
    keepEdition: (key) => foreign.has(key) ? null : key,
    keepWork: (key) => foreign.has(key) ? null : key,
  })
  const restored = new Set(insert.map((entry) => entry.id))
  const created = new Set(create.map((entry) => entry.id))
  const deletedBooks = current.books.filter((book) => !restored.has(book.id)).map((book) => book.id)
  const deletedShelves = [...currentCustom].filter((id) => !created.has(id))
  return {
    rulesVersion: IMPORT_RULES_VERSION,
    mode: "replace",
    counts: {
      added: insert.length - matched,
      kept: matched,
      overwritten: matched,
      skipped: 0,
      reassigned: reassigned.length,
      deleted: deletedBooks.length,
      shelvesCreated: create.filter((entry) => !currentCustom.has(entry.id)).length,
      shelvesDeleted: deletedShelves.length,
      shelvesAfter: 1 + create.length,
      booksAfter: insert.length,
      editionsCreated: editions.editions.length,
      worksCreated: editions.works.length,
      coversFound: 0,
      coversPending: 0,
    },
    shelves: { create, map, delete: deletedShelves },
    books: { insert: insert.map((entry) => ({ ...entry, editionId: editions.editionOf(entry.sourceId) })), skip: [], delete: deletedBooks },
    editions: { create: editions.editions },
    works: { create: editions.works },
    reassigned,
  }
}

const uuidText = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const jsonArray = <T>() => z.custom<T[]>((value) => Array.isArray(value))
const jsonObject = <T>() => z.custom<T>((value) => typeof value === "object" && value !== null && !Array.isArray(value))
const shelfEntrySchema = z.object({ id: uuidText, title: z.string(), is_default: z.boolean(), created_at: z.string() })
const bookEntrySchema = z.object({
  id: uuidText, isbn: z.string().nullable(), title: z.string(), subtitle: z.string().nullable(), authors: jsonArray<Author>(), publishers: jsonArray<Publisher>(),
  catalogue: jsonObject<CatalogueMetadata>(), number_of_pages: z.number().int(), publish_date: z.string(),
  cover_small: z.string(), cover_medium: z.string(), cover_large: z.string(), status: z.enum(["read", "reading", "unread", "to-read"]),
  shelf_id: uuidText, created_at: z.string(), cover_asset_id: uuidText.optional(),
  // schema_version 2 (U-DAT-06): edición, comprobación, identificador legacy, obra, idioma e identificadores.
  edition_id: uuidText.optional(), verification: jsonObject<CopyVerification>().optional(), legacy_identifier: z.string().optional(),
  work_id: uuidText.optional(), work_title: z.string().nullable().optional(), language: z.string().optional(), identifiers: jsonObject<EditionIdentifiers>().optional(),
  // schema_version 3 (0014): datos de producto; los valida la base al volver a escribirlos.
  personal: z.object({ notes: z.string().optional(), rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(), tag_ids: z.array(uuidText).optional() }).optional(),
  location: z.object({ location_id: uuidText, shelf_label: z.string().optional(), position: z.number().int().optional() }).optional(),
  series: z.object({ series_id: uuidText, position: z.string().optional(), volume_label: z.string().optional(), order_note: z.string().optional() }).optional(),
  evidence: jsonArray<SnapshotEvidenceEntry>().optional(),
  edition_evidence: jsonArray<SnapshotEvidenceEntry>().optional(),
  // schema_version 4 (0015): lectura y préstamos; los valida la base al volver a escribirlos.
  reading: z.array(z.object({
    id: uuidText, cycle_number: z.number().int(), status: z.enum(READING_CYCLE_STATUSES), started_at: z.string().optional(), finished_at: z.string().optional(),
    entries: z.array(z.object({ id: uuidText, occurred_at: z.string(), page_from: z.number().int().optional(), page_to: z.number().int().optional(), note: z.string().optional() })).optional(),
  })).optional(),
  loans: z.array(z.object({ id: uuidText, borrower_label: z.string(), loaned_on: z.string(), due_on: z.string().optional(), returned_on: z.string().optional(), note: z.string().optional() })).optional(),
})
const tagEntrySchema = z.object({ id: uuidText, name: z.string(), created_at: z.string() })
const locationEntrySchema = z.object({ id: uuidText, parent_id: uuidText.nullable(), name: z.string(), kind: z.enum(["room", "bookcase", "cabinet", "box", "shelf", "other"]),
  photo_asset_id: uuidText.nullable(), created_at: z.string() })
const seriesEntrySchema = z.object({ id: uuidText, title: z.string(), description: z.string().nullable(), created_at: z.string() })

export interface SnapshotChunkRow { seq: number; kind: string; itemCount: number; digest: string; valid: boolean; payload: unknown }

/**
 * Reconstruye el contenido de una versión y comprueba su integridad: cada trozo conserva su hash,
 * la secuencia es completa, las cantidades cuadran y el hash final coincide con la cabecera.
 */
export function assembleSnapshot(header: { digest: string; counts: { books: number; shelves: number } }, chunks: SnapshotChunkRow[]): SnapshotContent {
  const content: Required<SnapshotContent> = { shelves: [], books: [], tags: [], locations: [], series: [] }
  // Orden de los trozos: estanterías, libros y (schema_version 3) etiquetas, ubicaciones y series.
  const stages = ["shelves", "books", "tags", "locations", "series"]
  let expectedSeq = 0
  let stage = 0
  const take = <T>(schema: z.ZodType<T>, payload: unknown, into: T[]) => {
    const parsed = z.array(schema).safeParse(payload)
    if (!parsed.success) throw snapshotDamaged()
    into.push(...parsed.data)
  }
  for (const chunk of chunks) {
    if (!chunk.valid || chunk.seq !== expectedSeq++ || !Array.isArray(chunk.payload) || chunk.payload.length !== chunk.itemCount) throw snapshotDamaged()
    const position = stages.indexOf(chunk.kind)
    if (position < stage) throw snapshotDamaged()
    stage = position
    if (chunk.kind === "shelves") take(shelfEntrySchema, chunk.payload, content.shelves)
    else if (chunk.kind === "books") take(bookEntrySchema, chunk.payload, content.books)
    else if (chunk.kind === "tags") take(tagEntrySchema, chunk.payload, content.tags)
    else if (chunk.kind === "locations") take(locationEntrySchema, chunk.payload, content.locations)
    else take(seriesEntrySchema, chunk.payload, content.series)
  }
  if (content.books.length !== header.counts.books || content.shelves.length !== header.counts.shelves) throw snapshotDamaged()
  if (snapshotDigest(header.counts, chunks.map((chunk) => chunk.digest)) !== header.digest) throw snapshotDamaged()
  if (content.shelves.filter((shelf) => shelf.is_default).length !== 1) throw snapshotDamaged()
  const { tags, locations, series, ...base } = content
  return { ...base, ...(tags.length ? { tags } : {}), ...(locations.length ? { locations } : {}), ...(series.length ? { series } : {}) }
}

/** Captura el estado vigente para la operación de esta transacción. Un fallo aborta la operación. */
export async function captureSnapshot(tx: DatabaseTransaction, input: { operationId: string; reason: LibrarySnapshotReason }): Promise<{ id: string; digest: string }> {
  try {
    const rows = await tx.execute<{ snapshot: { id: string; digest: string } }>(sql`select biblib.library_snapshot_capture(${input.operationId}::uuid, ${input.reason}) as snapshot`)
    const snapshot = rows[0]?.snapshot
    if (!snapshot?.id) throw new Error("La captura no devolvió la versión.")
    return { id: snapshot.id, digest: snapshot.digest }
  } catch (error) { translateSnapshotError(error) }
}

export interface SnapshotHeader {
  id: string
  reason: LibrarySnapshotReason
  digest: string
  counts: { books: number; shelves: number }
  createdAt: Date
  expiresAt: Date
  /** Calculado por Postgres: el reloj de la base decide la caducidad. */
  expired: boolean
}

/** Cabecera de una versión completa del dueño, o null si no existe, es ajena o no está completa. */
export async function readSnapshotHeader(tx: DatabaseTransaction, userId: string, snapshotId: string): Promise<SnapshotHeader | null> {
  const [row] = await tx.select({ snapshot: librarySnapshots, expired: sql<boolean>`${librarySnapshots.expiresAt} <= now()` }).from(librarySnapshots)
    .where(and(eq(librarySnapshots.id, snapshotId), eq(librarySnapshots.userId, userId), eq(librarySnapshots.state, "ready"))).limit(1)
  const snapshot = row?.snapshot
  if (!snapshot?.digest) return null
  return { id: snapshot.id, reason: snapshot.reason, digest: snapshot.digest, counts: { books: snapshot.counts.books, shelves: snapshot.counts.shelves },
    createdAt: snapshot.createdAt, expiresAt: snapshot.expiresAt, expired: row.expired }
}

/** Contenido verificado de una versión: el hash de cada trozo se recalcula en Postgres sobre el JSON guardado. */
export async function readSnapshotContent(tx: DatabaseTransaction, userId: string, header: SnapshotHeader): Promise<SnapshotContent> {
  const rows = await tx.execute<{ seq: number; kind: string; item_count: number; digest: string; valid: boolean; payload: unknown }>(sql`
    select c.seq, c.kind, c.item_count, c.digest, c.payload, c.digest = encode(sha256(convert_to(c.payload::text, 'UTF8')), 'hex') as valid
    from biblib.library_snapshot_chunks as c where c.snapshot_id = ${header.id}::uuid and c.user_id = ${userId}::uuid order by c.seq`)
  return assembleSnapshot(header, [...rows].map((row) => ({ seq: row.seq, kind: row.kind, itemCount: row.item_count, digest: row.digest, valid: row.valid, payload: row.payload })))
}

export async function foreignSnapshotIds(tx: DatabaseTransaction, snapshotId: string): Promise<Set<string>> {
  const rows = await tx.execute<{ ids: string[] | null }>(sql`select biblib.library_snapshot_foreign_ids(${snapshotId}::uuid) as ids`)
  return new Set(rows[0]?.ids ?? [])
}

/**
 * Filas planas (DTO) de los ejemplares de una versión, con la clave de su edición. Una versión 1 (antes de
 * 0011) es una ficha por edición: su texto `isbn` pasa a ISBN-13 o identificador legacy como en el backfill, y
 * dos fichas equivalentes con los mismos datos comparten edición; si difieren, la segunda queda sin ISBN-13
 * con su texto original, sin descartar ninguna.
 */
export function snapshotRows(content: SnapshotContent): Map<string, Book> {
  const rows = new Map<string, Book>()
  const isbnOwner = new Map<string, { key: string; fingerprint: string }>()
  for (const entry of content.books) {
    const v2 = entry.edition_id !== undefined
    let isbn = v2 ? entry.isbn : entry.isbn ? normalizeIsbn(entry.isbn) : null
    let legacy = v2 ? entry.legacy_identifier : isbn ? undefined : entry.isbn?.trim() || undefined
    let key = entry.edition_id ?? entry.id
    const verified = entry.verification?.isbnVerified ?? entry.catalogue.isbnVerified ?? false
    const evidence = { ...(entry.verification?.checkedAt ? { checkedAt: entry.verification.checkedAt } : {}), ...(entry.verification?.evidenceRefs?.length ? { evidenceRefs: entry.verification.evidenceRefs } : {}) }
    const book: Book = {
      id: entry.id, isbn, title: entry.title, ...(entry.subtitle !== null ? { subtitle: entry.subtitle } : {}), authors: entry.authors, publishers: entry.publishers,
      number_of_pages: entry.number_of_pages, publish_date: entry.publish_date, cover: { small: entry.cover_small, medium: entry.cover_medium, large: entry.cover_large },
      status: entry.status, shelf_id: entry.shelf_id, shelf_name: "", catalogue: { ...entry.catalogue, isbnVerified: verified } as CatalogueMetadata,
      ...(Object.keys(evidence).length ? { verification: evidence } : {}),
    }
    if (isbn && !v2) {
      const owner = isbnOwner.get(isbn)
      const fingerprint = editionFingerprint(book)
      if (owner && owner.fingerprint === fingerprint) key = owner.key
      else if (owner) { legacy = entry.isbn ?? undefined; isbn = null }
      else isbnOwner.set(isbn, { key, fingerprint })
    }
    const personal = entry.personal ? {
      ...(entry.personal.notes !== undefined ? { notes: entry.personal.notes } : {}),
      ...(entry.personal.rating !== undefined ? { rating: entry.personal.rating } : {}),
      ...(entry.personal.tag_ids?.length ? { tagIds: entry.personal.tag_ids } : {}),
    } : undefined
    const series = entry.series ? { seriesId: entry.series.series_id, ...(entry.series.position !== undefined ? { position: entry.series.position } : {}),
      ...(entry.series.volume_label !== undefined ? { volumeLabel: entry.series.volume_label } : {}), ...(entry.series.order_note !== undefined ? { orderNote: entry.series.order_note } : {}) } : undefined
    rows.set(entry.id, {
      ...book, isbn, ...(legacy ? { legacyIdentifier: legacy } : {}),
      edition: { id: key, ...(entry.work_id ? { workId: entry.work_id, ...(entry.work_title ? { workTitle: entry.work_title } : {}) } : {}),
        ...(entry.language ? { language: entry.language } : {}), ...(entry.identifiers && Object.keys(entry.identifiers).length ? { identifiers: entry.identifiers } : {}),
        ...(series ? { series } : {}), ...(entry.edition_evidence?.length ? { evidence: entry.edition_evidence.map(snapshotEvidence) } : {}) },
      ...(personal && Object.keys(personal).length ? { personal } : {}),
      ...(entry.location ? { location: { locationId: entry.location.location_id, ...(entry.location.shelf_label !== undefined ? { shelfLabel: entry.location.shelf_label } : {}),
        ...(entry.location.position !== undefined ? { position: entry.location.position } : {}) } } : {}),
      ...(entry.evidence?.length ? { evidence: entry.evidence.map(snapshotEvidence) } : {}),
      ...(entry.reading?.length ? { reading: entry.reading.map(snapshotCycle) } : {}),
      ...(entry.loans?.length ? { loans: entry.loans.map(snapshotLoan) } : {}),
    })
  }
  return rows
}

/** Instante de una versión (texto de `timestamptz` en jsonb, con su desplazamiento) en ISO UTC, como la exportación. */
const isoInstant = (value: string) => new Date(value).toISOString()

function snapshotCycle(entry: SnapshotReadingCycleEntry): ReadingCycle {
  return {
    id: entry.id, cycleNumber: entry.cycle_number, status: entry.status,
    ...(entry.started_at !== undefined ? { startedAt: isoInstant(entry.started_at) } : {}), ...(entry.finished_at !== undefined ? { finishedAt: isoInstant(entry.finished_at) } : {}),
    ...(entry.entries?.length ? { entries: entry.entries.map((item) => ({
      id: item.id, occurredAt: isoInstant(item.occurred_at), ...(item.page_from !== undefined ? { pageFrom: item.page_from } : {}),
      ...(item.page_to !== undefined ? { pageTo: item.page_to } : {}), ...(item.note !== undefined ? { note: item.note } : {}),
    })) } : {}),
  }
}

function snapshotLoan(entry: SnapshotLoanEntry): Loan {
  return {
    id: entry.id, borrowerLabel: entry.borrower_label, loanedOn: entry.loaned_on, ...(entry.due_on !== undefined ? { dueOn: entry.due_on } : {}),
    ...(entry.returned_on !== undefined ? { returnedOn: entry.returned_on } : {}), ...(entry.note !== undefined ? { note: entry.note } : {}),
  }
}

function snapshotEvidence(entry: SnapshotEvidenceEntry): EvidenceEntry {
  return {
    id: entry.id, sourceKind: entry.source_kind, ...(entry.source_ref !== undefined ? { sourceRef: entry.source_ref } : {}),
    ...(entry.source_url !== undefined ? { sourceUrl: entry.source_url } : {}), ...(entry.photo_asset_id !== undefined ? { photo: { assetId: entry.photo_asset_id } } : {}),
    ...(entry.observed_at !== undefined ? { observedAt: entry.observed_at } : {}), fieldClaims: entry.field_claims, confidence: entry.confidence, origin: entry.origin,
  }
}

/** La colección de una versión anterior como origen de la publicación: filas planas y datos de la cuenta (0014). */
export function snapshotLibrary(content: SnapshotContent): LibraryData {
  return {
    books: [...snapshotRows(content).values()], shelves: [],
    tags: (content.tags ?? []).map((tag) => ({ id: tag.id, name: tag.name, createdAt: tag.created_at })),
    locations: (content.locations ?? []).map((location) => ({ id: location.id, name: location.name, kind: location.kind, parentId: location.parent_id,
      ...(location.photo_asset_id ? { photo: { assetId: location.photo_asset_id } } : {}), createdAt: location.created_at })),
    series: (content.series ?? []).map((entry) => ({ id: entry.id, title: entry.title, ...(entry.description !== null ? { description: entry.description } : {}), createdAt: entry.created_at })),
  }
}

/**
 * Sustituye la colección por la versión según el plan ya comprobado. Los ejemplares y ediciones reciben versiones nuevas.
 * Desde schema_version 3 también vuelven sus etiquetas, notas, ubicaciones, series y evidencias, y desde la 4 su lectura y
 * sus préstamos, con sus IDs salvo los que hoy usa otra cuenta (`foreign`); una foto citada solo vuelve si su asset sigue
 * siendo del dueño.
 */
export async function applyRestorePlan(tx: DatabaseTransaction, userId: string, content: SnapshotContent, plan: ImportPlan,
  options: { foreign: ReadonlySet<string>; allocateId: IdAllocator }): Promise<void> {
  const library = snapshotLibrary(content)
  const targets = await readProductTargets(tx, userId, library, "snapshot", options.foreign)
  await deleteAllCopies(tx, userId)
  await tx.delete(shelves).where(and(eq(shelves.userId, userId), eq(shelves.isDefault, false)))
  await deleteAccountProduct(tx, userId)
  const shelfSource = new Map(content.shelves.map((shelf) => [shelf.id, shelf]))
  if (plan.shelves.create.length) {
    await tx.insert(shelves).values(plan.shelves.create.map((entry) => ({ id: entry.id, userId, title: entry.title, isDefault: false, createdAt: new Date(shelfSource.get(entry.sourceId)?.created_at ?? Date.now()) })))
  }
  const bookSource = new Map(content.books.map((book) => [book.id, book]))
  if (plan.books.insert.some((entry) => !bookSource.has(entry.sourceId))) throw snapshotDamaged()
  // La versión retiene la referencia a la portada privada; solo se recupera si el asset propio sigue
  // utilizable (la purga no retira lo que una versión cita, pero una licencia vencida sí).
  const referenced = [...new Set(content.books.flatMap((book) => book.cover_asset_id ? [book.cover_asset_id] : []))]
  const usable = new Set(referenced.length ? (await tx.select({ id: coverAssets.id }).from(coverAssets)
    .where(and(eq(coverAssets.userId, userId), eq(coverAssets.state, "ready"), sql`${coverAssets.id} = any(${`{${referenced.join(",")}}`}::uuid[])`, sql`(${coverAssets.expiresAt} is null or ${coverAssets.expiresAt} > now())`))).map((row) => row.id) : [])
  await insertPlannedCopies(tx, userId, plan, snapshotRows(content), {
    createdAt: (sourceId) => new Date(bookSource.get(sourceId)!.created_at),
    coverAssetId: (sourceId) => {
      const asset = bookSource.get(sourceId)?.cover_asset_id
      return asset && usable.has(asset) ? asset : null
    },
  })
  await applyProductData(tx, userId, library, plan, "snapshot", targets, options.allocateId)
}

/** Títulos afectados por una restauración, acotados para la comparación de la vista previa. */
export function restoreChanges(plan: ImportPlan, content: SnapshotContent, currentTitles: ReadonlyMap<string, string>, limit = 20) {
  const restoredIds = new Set(plan.books.insert.filter((entry) => !currentTitles.has(entry.id)).map((entry) => entry.sourceId))
  const back = content.books.filter((book) => restoredIds.has(book.id)).map((book) => book.title)
  const removed = plan.books.delete.map((id) => currentTitles.get(id) ?? "Libro sin título disponible")
  return { removed: removed.slice(0, limit), removedTotal: removed.length, restored: back.slice(0, limit), restoredTotal: back.length }
}

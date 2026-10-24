import { createHash } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import type { DatabaseTransaction } from "./db/client"
import { books, coverAssets, librarySnapshots, shelves, type LibrarySnapshotReason } from "./db/schema"
import { DomainError, databaseErrorCode } from "./domain-errors"
import { canonicalJson, IMPORT_RULES_VERSION, type CollectionSnapshot, type IdAllocator, type ImportMode, type ImportPlan } from "./import-plan"
import type { Author, Book, CatalogueMetadata, Publisher } from "./types"

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
export const SNAPSHOT_SCHEMA_VERSION = 1

/** Tablas privadas que la limpieza de cuenta (U-OPS-03) debe incluir; todas cuelgan de `auth.users`. */
export const SNAPSHOT_INVENTORY = Object.freeze(["biblib.library_snapshots", "biblib.library_snapshot_chunks", "biblib.import_previews (snapshot_id)"])

export interface SnapshotShelfEntry { id: string; title: string; is_default: boolean; created_at: string }
export interface SnapshotBookEntry {
  id: string
  isbn: string
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
}
export interface SnapshotContent { shelves: SnapshotShelfEntry[]; books: SnapshotBookEntry[] }

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

  const insert: ImportPlan["books"]["insert"] = []
  let matched = 0
  for (const book of snapshot.books) {
    const shelfId = shelfFor.get(book.shelf_id)
    if (!shelfId) throw new Error("La versión anterior tiene libros con una estantería inexistente.")
    const id = idFor("book", book.id)
    if (id !== book.id) reassigned.push({ kind: "book", sourceId: book.id, id })
    if (currentBooks.has(id)) matched++
    insert.push({ sourceId: book.id, id, shelfId })
  }
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
      coversFound: 0,
      coversPending: 0,
    },
    shelves: { create, map, delete: deletedShelves },
    books: { insert, skip: [], delete: deletedBooks },
    reassigned,
  }
}

const uuidText = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const jsonArray = <T>() => z.custom<T[]>((value) => Array.isArray(value))
const jsonObject = <T>() => z.custom<T>((value) => typeof value === "object" && value !== null && !Array.isArray(value))
const shelfEntrySchema = z.object({ id: uuidText, title: z.string(), is_default: z.boolean(), created_at: z.string() })
const bookEntrySchema = z.object({
  id: uuidText, isbn: z.string(), title: z.string(), subtitle: z.string().nullable(), authors: jsonArray<Author>(), publishers: jsonArray<Publisher>(),
  catalogue: jsonObject<CatalogueMetadata>(), number_of_pages: z.number().int(), publish_date: z.string(),
  cover_small: z.string(), cover_medium: z.string(), cover_large: z.string(), status: z.enum(["read", "reading", "unread", "to-read"]),
  shelf_id: uuidText, created_at: z.string(), cover_asset_id: uuidText.optional(),
})

export interface SnapshotChunkRow { seq: number; kind: string; itemCount: number; digest: string; valid: boolean; payload: unknown }

/**
 * Reconstruye el contenido de una versión y comprueba su integridad: cada trozo conserva su hash,
 * la secuencia es completa, las cantidades cuadran y el hash final coincide con la cabecera.
 */
export function assembleSnapshot(header: { digest: string; counts: { books: number; shelves: number } }, chunks: SnapshotChunkRow[]): SnapshotContent {
  const content: SnapshotContent = { shelves: [], books: [] }
  let expectedSeq = 0
  for (const chunk of chunks) {
    if (!chunk.valid || chunk.seq !== expectedSeq++ || !Array.isArray(chunk.payload) || chunk.payload.length !== chunk.itemCount) throw snapshotDamaged()
    if (chunk.kind === "shelves" && content.books.length === 0) {
      const parsed = z.array(shelfEntrySchema).safeParse(chunk.payload)
      if (!parsed.success) throw snapshotDamaged()
      content.shelves.push(...parsed.data)
    } else if (chunk.kind === "books") {
      const parsed = z.array(bookEntrySchema).safeParse(chunk.payload)
      if (!parsed.success) throw snapshotDamaged()
      content.books.push(...parsed.data)
    } else {
      throw snapshotDamaged()
    }
  }
  if (content.books.length !== header.counts.books || content.shelves.length !== header.counts.shelves) throw snapshotDamaged()
  if (snapshotDigest(header.counts, chunks.map((chunk) => chunk.digest)) !== header.digest) throw snapshotDamaged()
  if (content.shelves.filter((shelf) => shelf.is_default).length !== 1) throw snapshotDamaged()
  return content
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

/** Sustituye la colección por la versión según el plan ya comprobado. Las fichas reciben versiones nuevas. */
export async function applyRestorePlan(tx: DatabaseTransaction, userId: string, content: SnapshotContent, plan: ImportPlan): Promise<void> {
  await tx.delete(books).where(eq(books.userId, userId))
  await tx.delete(shelves).where(and(eq(shelves.userId, userId), eq(shelves.isDefault, false)))
  const shelfSource = new Map(content.shelves.map((shelf) => [shelf.id, shelf]))
  if (plan.shelves.create.length) {
    await tx.insert(shelves).values(plan.shelves.create.map((entry) => ({ id: entry.id, userId, title: entry.title, isDefault: false, createdAt: new Date(shelfSource.get(entry.sourceId)?.created_at ?? Date.now()) })))
  }
  const bookSource = new Map(content.books.map((book) => [book.id, book]))
  // La versión retiene la referencia a la portada privada; solo se recupera si el asset propio sigue
  // utilizable (la purga no retira lo que una versión cita, pero una licencia vencida sí).
  const referenced = [...new Set(content.books.flatMap((book) => book.cover_asset_id ? [book.cover_asset_id] : []))]
  const usable = new Set(referenced.length ? (await tx.select({ id: coverAssets.id }).from(coverAssets)
    .where(and(eq(coverAssets.userId, userId), eq(coverAssets.state, "ready"), sql`${coverAssets.id} = any(${`{${referenced.join(",")}}`}::uuid[])`, sql`(${coverAssets.expiresAt} is null or ${coverAssets.expiresAt} > now())`))).map((row) => row.id) : [])
  const values = plan.books.insert.map((entry) => {
    const book = bookSource.get(entry.sourceId)
    if (!book) throw snapshotDamaged()
    return { id: entry.id, userId, isbn: book.isbn, title: book.title, subtitle: book.subtitle, authors: book.authors, publishers: book.publishers,
      catalogue: book.catalogue, numberOfPages: book.number_of_pages, publishDate: book.publish_date,
      coverSmall: book.cover_small, coverMedium: book.cover_medium, coverLarge: book.cover_large, status: book.status, shelfId: entry.shelfId,
      coverAssetId: book.cover_asset_id && usable.has(book.cover_asset_id) ? book.cover_asset_id : null,
      createdAt: new Date(book.created_at) }
  })
  for (let offset = 0; offset < values.length; offset += 100) await tx.insert(books).values(values.slice(offset, offset + 100))
}

/** Títulos afectados por una restauración, acotados para la comparación de la vista previa. */
export function restoreChanges(plan: ImportPlan, content: SnapshotContent, currentTitles: ReadonlyMap<string, string>, limit = 20) {
  const restoredIds = new Set(plan.books.insert.filter((entry) => !currentTitles.has(entry.id)).map((entry) => entry.sourceId))
  const back = content.books.filter((book) => restoredIds.has(book.id)).map((book) => book.title)
  const removed = plan.books.delete.map((id) => currentTitles.get(id) ?? "Libro sin título disponible")
  return { removed: removed.slice(0, limit), removedTotal: removed.length, restored: back.slice(0, limit), restoredTotal: back.length }
}

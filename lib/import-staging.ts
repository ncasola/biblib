import { createHash, randomUUID } from "node:crypto"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import type { DatabaseTransaction } from "./db/client"
import { books, importSessionParts, importSessions, libraryOperations, librarySnapshots, shelves, type RestoreSessionTotals } from "./db/schema"
import { DEFAULT_BOOK_COVER } from "./book-covers"
import { DomainError, databaseErrorCode, idempotencyConflict, revisionConflict } from "./domain-errors"
import {
  buildImportPlan, canonicalJson, decideConfirmation, IMPORT_RULES_VERSION, operationResult,
  type ImportOperationResult, type ImportPlan,
} from "./import-plan"
import { lockCollection, previewAllocator, readCollectionSnapshot } from "./import-publisher"
import {
  assertDistinctParts, assertSetLimits, bookAndShelfCounts, chunkCount, createBackupSetManifest, manifestCanonical, ManifestError,
  parseBackupSetManifest, partIdFor, payloadCounts, RESTORE_LIMITS, sameCounts, type BackupSetManifest, type PartCounts,
} from "./import-manifest"
import { parseLibraryImport } from "./library-import"
import { captureSnapshot } from "./library-snapshots"
import type { Book, LibraryData, Shelf } from "./types"

// Restauración de conjuntos de partes (U-DAT-04) sobre Postgres. Cada función recibe una transacción
// ya situada en el contexto RLS del dueño y no hace red. Las partes llegan en trozos de 256 KiB, se
// reconstruyen y comprueban por hash, se validan una a una y quedan como filas en staging. La
// publicación es una única transacción bajo el bloqueo y el CAS de colección (U-DAT-01), con la
// versión anterior de U-DAT-02 y SQL por conjuntos; un fallo o un timeout la revierte entera y el
// staging se conserva para revisar y reintentar. Nunca hay commits parciales.

export const RESTORE_OPERATION = "restore.commit"

/** Tablas privadas que la limpieza de cuenta (U-OPS-03) y la retención (F4) deben incluir. */
export const RESTORE_SESSION_INVENTORY = Object.freeze([
  "biblib.import_sessions", "biblib.import_session_parts", "biblib.import_session_chunks", "biblib.import_session_rows",
])

/** Presupuesto de la transacción final: `lock_timeout`, `statement_timeout` por sentencia y total. */
export interface CommitBudget { lockTimeoutMs: number; statementTimeoutMs: number; totalMs: number }
export const DEFAULT_COMMIT_BUDGET: Readonly<CommitBudget> = Object.freeze({ lockTimeoutMs: 1_000, statementTimeoutMs: 5_000, totalMs: 15_000 })

/** Presupuesto total configurable por servidor (F4), acotado para que un valor erróneo no deje bloqueos largos. */
export function commitBudget(totalMs: string | undefined): CommitBudget {
  const parsed = Number(totalMs)
  const total = Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 60_000 ? parsed : DEFAULT_COMMIT_BUDGET.totalMs
  return { ...DEFAULT_COMMIT_BUDGET, totalMs: total }
}

const sha256 = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex")

export function sessionUnavailable(): DomainError {
  return new DomainError("NOT_FOUND", "Esa restauración ya no está disponible. Puede que haya caducado o se haya descartado; empieza de nuevo seleccionando las partes.")
}

export function sessionExpired(): DomainError {
  return new DomainError("PREVIEW_EXPIRED", "La restauración ha caducado. Las partes subidas se han descartado; vuelve a seleccionarlas para empezar de nuevo.")
}

export function commitTimedOut(): DomainError {
  return new DomainError("PROVIDER_UNAVAILABLE", "La restauración no ha cabido en el tiempo previsto. No se ha aplicado nada y las partes se conservan: puedes volver a confirmarla.")
}

function commitBusy(): DomainError {
  return new DomainError("PROVIDER_UNAVAILABLE", "Otra operación estaba modificando tu biblioteca. No se ha aplicado nada y las partes se conservan: vuelve a confirmar en un momento.")
}

/** Traduce los fallos de Postgres de una sesión: guarda de staging, timeouts y bloqueo ocupado. */
export function translateStagingError(error: unknown): never {
  if (error instanceof DomainError) throw error
  if (error instanceof ManifestError) throw new DomainError(error.code, error.message)
  const code = databaseErrorCode(error)
  if (code === "BR001") throw new DomainError("CONFLICT", "Esta restauración ya no admite más datos: está validada, publicada o ha caducado.")
  if (code === "57014") throw commitTimedOut()
  if (code === "55P03") throw commitBusy()
  throw error
}

// ── Vista de una sesión ──────────────────────────────────────────────────────────────────────

export interface RestorePartView {
  partId: string
  index: number
  byteLength: number
  sha256: string
  totalChunks: number
  receivedChunks: number
  state: "pending" | "received" | "validated"
  counts: Record<string, number> | null
  exportedAt: string | null
}

export interface RestoreSessionView {
  sessionId: string
  state: "receiving" | "validated" | "prepared" | "committed" | "rejected"
  source: "manifest" | "loose"
  exportSetId: string
  payloadFormatVersion: 1 | 2 | null
  manifestDigest: string
  partCount: number
  validatedParts: number
  receivedBytes: number
  totalBytes: number
  totals: RestoreSessionTotals | null
  errorCode: string | null
  operationId: string | null
  expiresAt: string
  parts: RestorePartView[]
}

type SessionRow = typeof importSessions.$inferSelect

async function readParts(tx: DatabaseTransaction, userId: string, sessionId: string): Promise<RestorePartView[]> {
  const rows = await tx.execute<{ part_id: string; part_index: number; byte_length: number; sha256: string; total_chunks: number; state: RestorePartView["state"]; counts: Record<string, number> | null; exported_at: string | null; received: number }>(sql`
    select p.part_id, p.part_index, p.byte_length, p.sha256, p.total_chunks, p.state, p.counts, p.exported_at,
      (select count(*)::int from biblib.import_session_chunks c where c.session_id = p.session_id and c.part_id = p.part_id and c.user_id = p.user_id) as received
    from biblib.import_session_parts p where p.session_id = ${sessionId}::uuid and p.user_id = ${userId}::uuid order by p.part_index`)
  return [...rows].map((row) => ({ partId: row.part_id, index: row.part_index, byteLength: row.byte_length, sha256: row.sha256, totalChunks: row.total_chunks,
    receivedChunks: row.received, state: row.state, counts: row.counts, exportedAt: row.exported_at }))
}

function view(session: SessionRow, parts: RestorePartView[]): RestoreSessionView {
  return {
    sessionId: session.id, state: session.state, source: session.source, exportSetId: session.exportSetId,
    payloadFormatVersion: session.payloadFormatVersion === 1 || session.payloadFormatVersion === 2 ? session.payloadFormatVersion : null,
    manifestDigest: session.manifestDigest, partCount: session.partCount, validatedParts: session.validatedParts,
    receivedBytes: session.receivedBytes, totalBytes: session.totalBytes, totals: session.totals ?? null, errorCode: session.errorCode,
    operationId: session.operationId, expiresAt: session.expiresAt.toISOString(), parts,
  }
}

/** Sesión propia vigente (bloqueada si `forUpdate`), o el error genérico: ajena, inexistente y caducada responden igual. */
async function loadSession(tx: DatabaseTransaction, userId: string, sessionId: string, { forUpdate = false } = {}): Promise<SessionRow & { expired: boolean; previewExpired: boolean }> {
  const query = tx.select({ session: importSessions, expired: sql<boolean>`${importSessions.expiresAt} <= now()`, previewExpired: sql<boolean>`coalesce(${importSessions.previewExpiresAt} <= now(), false)` })
    .from(importSessions).where(and(eq(importSessions.id, sessionId), eq(importSessions.userId, userId))).limit(1)
  const [row] = forUpdate ? await query.for("update") : await query
  if (!row) throw sessionUnavailable()
  return { ...row.session, expired: row.expired, previewExpired: row.previewExpired }
}

/** Restauraciones a medias del dueño (sin publicar ni caducar), las más recientes primero. */
export async function listOpenSessions(tx: DatabaseTransaction, userId: string): Promise<RestoreSessionView[]> {
  const rows = await tx.select().from(importSessions)
    .where(and(eq(importSessions.userId, userId), sql`${importSessions.expiresAt} > now()`, sql`${importSessions.state} in ('receiving', 'validated', 'prepared')`))
    .orderBy(sql`${importSessions.createdAt} desc`, sql`${importSessions.id} desc`).limit(RESTORE_LIMITS.maxOpenSessions)
  return Promise.all(rows.map(async (row) => view(row, await readParts(tx, userId, row.id))))
}

// ── Inicio ───────────────────────────────────────────────────────────────────────────────────

export type BeginInput =
  | { kind: "manifest"; manifest: unknown }
  | { kind: "loose"; parts: { byteLength: number; sha256: string }[] }

const looseManifest = (exportSetId: string, parts: { byteLength: number; sha256: string }[]) =>
  ({ source: "loose", exportSetId, parts: parts.map((part, index) => ({ partId: partIdFor(index), index, byteLength: part.byteLength, sha256: part.sha256 })) })

/**
 * Abre una sesión con las partes esperadas. Con manifest, este fija hashes, tamaños, orden y
 * cantidades; con partes sueltas, solo tamaños y hashes, y el manifest lo genera el servidor al
 * validarlas. Rechaza límites y duplicados antes de aceptar ningún byte.
 */
export async function beginSession(tx: DatabaseTransaction, userId: string, input: BeginInput, options: { sessionId?: string } = {}): Promise<RestoreSessionView> {
  let manifest: BackupSetManifest | null = null
  let parts: { byteLength: number; sha256: string }[]
  let exportSetId: string
  try {
    if (input.kind === "manifest") {
      manifest = parseBackupSetManifest(input.manifest)
      parts = manifest.parts
      exportSetId = manifest.exportSetId
    } else {
      parts = input.parts
      if (!parts.length) throw new ManifestError("INVALID_INPUT", "Selecciona al menos una parte de la copia.")
      assertSetLimits(parts)
      assertDistinctParts(parts)
      exportSetId = randomUUID()
    }
  } catch (error) { translateStagingError(error) }

  const baseRevision = await lockCollection(tx)
  // Las sesiones vencidas del dueño se retiran al empezar otra; nunca toca la colección activa.
  await tx.delete(importSessions).where(and(eq(importSessions.userId, userId), sql`${importSessions.expiresAt} <= now()`))
  const [{ open }] = await tx.select({ open: sql<number>`count(*)::int` }).from(importSessions)
    .where(and(eq(importSessions.userId, userId), sql`${importSessions.state} in ('receiving', 'validated', 'prepared')`))
  if (open >= RESTORE_LIMITS.maxOpenSessions) {
    throw new DomainError("LIMIT_EXCEEDED", `Ya tienes ${RESTORE_LIMITS.maxOpenSessions} restauraciones a medias. Descarta alguna en Ajustes o espera a que caduquen antes de empezar otra.`)
  }
  const stored = manifest ?? looseManifest(exportSetId, parts)
  const id = options.sessionId ?? randomUUID()
  const [session] = await tx.insert(importSessions).values({
    id, userId, source: input.kind, exportSetId, payloadFormatVersion: manifest?.payloadFormatVersion ?? null,
    manifest: stored as unknown as Record<string, unknown>, manifestDigest: sha256(manifest ? manifestCanonical(manifest) : canonicalJson(stored)),
    baseRevision, rulesVersion: IMPORT_RULES_VERSION, partCount: parts.length, totalBytes: parts.reduce((total, part) => total + part.byteLength, 0),
    expiresAt: sql`now() + make_interval(days => ${RESTORE_LIMITS.sessionTtlDays})`,
  }).returning()
  await tx.insert(importSessionParts).values(parts.map((part, index) => ({
    sessionId: id, userId, partId: partIdFor(index), partIndex: index, byteLength: part.byteLength, sha256: part.sha256, totalChunks: chunkCount(part.byteLength),
  })))
  return view(session, await readParts(tx, userId, id))
}

// ── Trozos ───────────────────────────────────────────────────────────────────────────────────

export interface ChunkInput { sessionId: string; partId: string; ordinal: number; total: number; sha256: string; bytes: Uint8Array }
export interface ChunkReceipt { partId: string; ordinal: number; replayed: boolean; receivedChunks: number; partComplete: boolean; receivedBytes: number }

/**
 * Guarda un trozo de los bytes originales. Se comprueban tamaño exacto, posición, total y hash antes
 * de persistir. Repetir un trozo idéntico es idempotente; otro contenido en la misma posición es
 * conflicto. Un trozo nunca autoriza ni publica nada.
 */
export async function putChunk(tx: DatabaseTransaction, userId: string, input: ChunkInput): Promise<ChunkReceipt> {
  const session = await loadSession(tx, userId, input.sessionId, { forUpdate: true })
  if (session.expired) throw sessionExpired()
  const [part] = await tx.select().from(importSessionParts)
    .where(and(eq(importSessionParts.sessionId, session.id), eq(importSessionParts.userId, userId), eq(importSessionParts.partId, input.partId))).limit(1)
  if (!part) throw new DomainError("MANIFEST_MISMATCH", "Ese archivo no es una de las partes de esta restauración.")
  if (input.total !== part.totalChunks || input.ordinal < 0 || input.ordinal >= part.totalChunks) throw new DomainError("MANIFEST_MISMATCH", "El trozo no corresponde al tamaño declarado de la parte. Vuelve a seleccionar el archivo.")
  const expected = input.ordinal < part.totalChunks - 1 ? RESTORE_LIMITS.chunkBytes : part.byteLength - RESTORE_LIMITS.chunkBytes * (part.totalChunks - 1)
  if (input.bytes.byteLength !== expected) throw new DomainError("MANIFEST_MISMATCH", "El trozo no tiene el tamaño esperado para esa parte. Vuelve a seleccionar el archivo.")
  const digest = sha256(input.bytes)
  if (digest !== input.sha256) throw new DomainError("MANIFEST_MISMATCH", "El trozo llegó dañado. Vuelve a intentarlo.")

  const [existing] = await tx.execute<{ sha256: string }>(sql`select sha256 from biblib.import_session_chunks where session_id = ${session.id}::uuid and part_id = ${part.partId} and ordinal = ${input.ordinal}`)
  let replayed = false
  if (existing) {
    if (existing.sha256 !== digest) throw new DomainError("CONFLICT", "Esa parte ya se recibió con otro contenido. Comprueba que has seleccionado los archivos de la misma copia.")
    replayed = true
  } else {
    if (session.state !== "receiving") throw new DomainError("CONFLICT", "Esta restauración ya no admite más datos: está validada, publicada o ha caducado.")
    await tx.execute(sql`insert into biblib.import_session_chunks (session_id, user_id, part_id, ordinal, byte_length, sha256, bytes)
      values (${session.id}::uuid, ${userId}::uuid, ${part.partId}, ${input.ordinal}, ${expected}, ${digest}, ${Buffer.from(input.bytes)}::bytea)`)
    await tx.update(importSessions).set({ receivedBytes: sql`${importSessions.receivedBytes} + ${expected}`, updatedAt: sql`now()` }).where(eq(importSessions.id, session.id))
  }
  const [{ received }] = await tx.execute<{ received: number }>(sql`select count(*)::int as received from biblib.import_session_chunks where session_id = ${session.id}::uuid and part_id = ${part.partId}`)
  const complete = received === part.totalChunks
  if (complete && part.state === "pending") {
    await tx.update(importSessionParts).set({ state: "received" }).where(and(eq(importSessionParts.sessionId, session.id), eq(importSessionParts.partId, part.partId)))
  }
  const [{ bytes }] = await tx.select({ bytes: importSessions.receivedBytes }).from(importSessions).where(eq(importSessions.id, session.id))
  return { partId: part.partId, ordinal: input.ordinal, replayed, receivedChunks: received, partComplete: complete, receivedBytes: bytes }
}

// ── Validación ───────────────────────────────────────────────────────────────────────────────

/** Ejecuta trabajo en una transacción propia del dueño (withRlsContext en la app). */
export type OwnerTransaction = <T>(work: (tx: DatabaseTransaction) => Promise<T>) => Promise<T>

export interface ValidatedSession { session: RestoreSessionView; manifest: BackupSetManifest; warnings: string[] }

const decoder = new TextDecoder("utf-8", { fatal: true })

/** Reconstruye una parte con sus trozos en orden y comprueba tamaño y hash sobre los bytes exactos. */
async function assemblePart(tx: DatabaseTransaction, userId: string, sessionId: string, part: typeof importSessionParts.$inferSelect): Promise<Buffer> {
  const rows = await tx.execute<{ ordinal: number; bytes: Buffer }>(sql`select ordinal, bytes from biblib.import_session_chunks
    where session_id = ${sessionId}::uuid and user_id = ${userId}::uuid and part_id = ${part.partId} order by ordinal`)
  const chunks = [...rows]
  if (chunks.length !== part.totalChunks || chunks.some((chunk, index) => chunk.ordinal !== index)) {
    throw new ManifestError("MANIFEST_MISMATCH", `Falta parte del archivo ${part.partIndex + 1}. Vuelve a seleccionarlo para completar la subida.`)
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.bytes)))
  if (bytes.byteLength !== part.byteLength || sha256(bytes) !== part.sha256) {
    throw new ManifestError("MANIFEST_MISMATCH", `La parte ${part.partIndex + 1} no coincide con el manifiesto: está dañada o pertenece a otra copia. No se ha modificado nada.`)
  }
  return bytes
}

function decodePart(bytes: Buffer, index: number): unknown {
  try { return JSON.parse(decoder.decode(bytes)) }
  catch { throw new ManifestError("INVALID_INPUT", `La parte ${index + 1} no es un JSON válido. No se ha modificado nada.`) }
}

const shelfData = (shelf: Shelf) => ({ id: shelf.id, title: shelf.title, isDefault: Boolean(shelf.isDefault) })

/** Comprueba, normaliza y deja en staging una parte; las estanterías compartidas deben ser compatibles. */
async function validatePart(tx: DatabaseTransaction, userId: string, session: SessionRow, part: typeof importSessionParts.$inferSelect, manifest: BackupSetManifest | null): Promise<void> {
  const raw = decodePart(await assemblePart(tx, userId, session.id, part), part.partIndex)
  const declared = payloadCounts(raw)
  if (manifest) {
    if (declared.formatVersion !== manifest.payloadFormatVersion) throw new ManifestError("MANIFEST_MISMATCH", `La parte ${part.partIndex + 1} usa otro formato que el manifiesto.`)
    if (!sameCounts(declared.counts, manifest.parts[part.partIndex].counts)) throw new ManifestError("MANIFEST_MISMATCH", `Las cantidades de la parte ${part.partIndex + 1} no coinciden con las del manifiesto. No se ha modificado nada.`)
  }
  let library: LibraryData
  try { library = parseLibraryImport(raw) }
  catch (error) { throw new ManifestError("INVALID_INPUT", `Parte ${part.partIndex + 1}: ${error instanceof Error ? error.message : "no tiene un formato de biblioteca válido."}`) }

  const shelfRows = library.shelves.map((shelf, position) => ({ kind: "shelf" as const, rowKey: shelf.id, position, data: shelfData(shelf) }))
  const bookRows = library.books.map((book, position) => ({ kind: "book" as const, rowKey: book.id, position, data: { ...book, shelf_name: "" } }))
  for (let offset = 0; offset < shelfRows.length; offset += 200) {
    const batch = shelfRows.slice(offset, offset + 200)
    const inserted = await tx.execute<{ row_key: string }>(sql`insert into biblib.import_session_rows (session_id, user_id, kind, row_key, part_index, position, data)
      select ${session.id}::uuid, ${userId}::uuid, 'shelf', r.key, ${part.partIndex}, r.position, r.data
      from jsonb_to_recordset(${JSON.stringify(batch.map((row) => ({ key: row.rowKey, position: row.position, data: row.data })))}::jsonb) as r(key text, position integer, data jsonb)
      on conflict do nothing returning row_key`)
    const fresh = new Set([...inserted].map((row) => row.row_key))
    const shared = batch.filter((row) => !fresh.has(row.rowKey))
    if (!shared.length) continue
    const previous = await tx.execute<{ row_key: string; data: Record<string, unknown> }>(sql`select row_key, data from biblib.import_session_rows
      where session_id = ${session.id}::uuid and kind = 'shelf' and row_key in (${sql.join(shared.map((row) => sql`${row.rowKey}`), sql`, `)})`)
    const stored = new Map([...previous].map((row) => [row.row_key, row.data]))
    for (const row of shared) {
      if (canonicalJson(stored.get(row.rowKey)) !== canonicalJson(row.data)) {
        throw new ManifestError("MANIFEST_MISMATCH", `La estantería «${row.data.title}» aparece con datos distintos en varias partes. Resuelve la contradicción antes de restaurar.`)
      }
    }
  }
  for (let offset = 0; offset < bookRows.length; offset += 500) {
    const batch = bookRows.slice(offset, offset + 500)
    const [{ inserted }] = await tx.execute<{ inserted: number }>(sql`with added as (insert into biblib.import_session_rows (session_id, user_id, kind, row_key, part_index, position, data)
      select ${session.id}::uuid, ${userId}::uuid, 'book', r.key, ${part.partIndex}, r.position, r.data
      from jsonb_to_recordset(${JSON.stringify(batch.map((row) => ({ key: row.rowKey, position: row.position, data: row.data })))}::jsonb) as r(key text, position integer, data jsonb)
      on conflict do nothing returning 1) select count(*)::int as inserted from added`)
    if (inserted !== batch.length) throw new ManifestError("MANIFEST_MISMATCH", "Hay libros repetidos en varias partes: el conjunto no es coherente. No se ha modificado nada.")
  }
  await tx.update(importSessionParts).set({ state: "validated", formatVersion: declared.formatVersion, counts: declared.counts as Record<string, number>,
    exportedAt: typeof (raw as { exportedAt?: unknown }).exportedAt === "string" ? (raw as { exportedAt: string }).exportedAt : null })
    .where(and(eq(importSessionParts.sessionId, session.id), eq(importSessionParts.partId, part.partId)))
  await tx.update(importSessions).set({ validatedParts: sql`${importSessions.validatedParts} + 1`, updatedAt: sql`now()` }).where(eq(importSessions.id, session.id))
}

/** Comprobaciones globales sobre todas las filas: ISBN repetidos, nombres contradictorios, una sola predeterminada y límites. */
async function crossValidate(tx: DatabaseTransaction, sessionId: string): Promise<RestoreSessionTotals> {
  const [facts] = await tx.execute<{ books: number; shelves: number; defaults: number; isbn_dupes: number; title_dupes: number; orphans: number }>(sql`
    select
      (select count(*)::int from biblib.import_session_rows where session_id = ${sessionId}::uuid and kind = 'book') as books,
      (select count(*)::int from biblib.import_session_rows where session_id = ${sessionId}::uuid and kind = 'shelf') as shelves,
      (select count(*)::int from biblib.import_session_rows where session_id = ${sessionId}::uuid and kind = 'shelf' and (data->>'isDefault')::boolean) as defaults,
      (select count(*)::int from (select 1 from biblib.import_session_rows where session_id = ${sessionId}::uuid and kind = 'book' group by data->>'isbn' having count(*) > 1) d) as isbn_dupes,
      (select count(*)::int from (select 1 from biblib.import_session_rows where session_id = ${sessionId}::uuid and kind = 'shelf' group by lower(data->>'title') having count(*) > 1) t) as title_dupes,
      (select count(*)::int from biblib.import_session_rows b where b.session_id = ${sessionId}::uuid and b.kind = 'book'
        and not exists (select 1 from biblib.import_session_rows s where s.session_id = b.session_id and s.kind = 'shelf' and s.row_key = b.data->>'shelf_id')) as orphans`)
  if (facts.isbn_dupes) throw new ManifestError("MANIFEST_MISMATCH", "Varias partes contienen libros con el mismo ISBN o identificador. No se ha modificado nada.")
  if (facts.title_dupes) throw new ManifestError("MANIFEST_MISMATCH", "Varias partes contienen estanterías distintas con el mismo nombre. Resuelve la contradicción antes de restaurar.")
  if (facts.defaults > 1) throw new ManifestError("MANIFEST_MISMATCH", "Las partes tienen más de una estantería predeterminada: no parecen de la misma copia.")
  if (facts.orphans) throw new ManifestError("MANIFEST_MISMATCH", "Hay libros que hacen referencia a una estantería inexistente en el conjunto.")
  assertSetLimits([], { books: facts.books, shelves: facts.shelves })
  return { books: facts.books, shelves: facts.shelves }
}

async function rejectSession(run: OwnerTransaction, userId: string, sessionId: string, code: string): Promise<void> {
  // El rechazo se registra en su propia transacción y libera el staging: la colección activa no se toca.
  await run(async (tx) => {
    await tx.execute(sql`delete from biblib.import_session_rows where session_id = ${sessionId}::uuid and user_id = ${userId}::uuid`)
    await tx.execute(sql`delete from biblib.import_session_chunks where session_id = ${sessionId}::uuid and user_id = ${userId}::uuid`)
    await tx.update(importSessions).set({ state: "rejected", errorCode: code, updatedAt: sql`now()` })
      .where(and(eq(importSessions.id, sessionId), eq(importSessions.userId, userId), sql`${importSessions.state} = 'receiving'`))
  })
}

/**
 * Valida todas las partes en pasos acotados (una transacción por parte) y después el conjunto. Un
 * fallo de integridad o de límites rechaza la sesión sin tocar la colección activa. Repetir tras una
 * interrupción continúa por las partes que faltan; una sesión ya validada devuelve su resultado.
 */
export async function validateSession(run: OwnerTransaction, userId: string, sessionId: string): Promise<ValidatedSession> {
  const initial = await run(async (tx) => {
    const session = await loadSession(tx, userId, sessionId)
    if (session.expired) throw sessionExpired()
    return { session, parts: await tx.select().from(importSessionParts).where(and(eq(importSessionParts.sessionId, sessionId), eq(importSessionParts.userId, userId))).orderBy(asc(importSessionParts.partIndex)) }
  })
  if (initial.session.state === "rejected") throw new DomainError((initial.session.errorCode as "MANIFEST_MISMATCH" | "LIMIT_EXCEEDED" | "INVALID_INPUT" | null) ?? "MANIFEST_MISMATCH", "Esta restauración se rechazó al validarla y no se puede publicar. Empieza otra con los archivos correctos.")
  if (initial.session.state !== "receiving") return run(async (tx) => validatedResult(tx, userId, sessionId))
  const missing = initial.parts.filter((part) => part.state === "pending")
  if (missing.length) {
    throw new DomainError("MANIFEST_MISMATCH", `Faltan ${missing.length} de ${initial.parts.length} partes por subir completas (${missing.map((part) => part.partIndex + 1).join(", ")}). Selecciona todos los archivos de la copia.`)
  }
  const manifest = initial.session.source === "manifest" ? parseBackupSetManifest(initial.session.manifest) : null
  try {
    for (const part of initial.parts.filter((entry) => entry.state === "received")) {
      await run(async (tx) => {
        const session = await loadSession(tx, userId, sessionId, { forUpdate: true })
        if (session.state !== "receiving") throw new DomainError("CONFLICT", "La restauración cambió mientras se validaba. Vuelve a consultarla.")
        await validatePart(tx, userId, session, part, manifest)
      })
    }
    return await run(async (tx) => {
      const session = await loadSession(tx, userId, sessionId, { forUpdate: true })
      if (session.state !== "receiving") return validatedResult(tx, userId, sessionId)
      const totals = await crossValidate(tx, sessionId)
      const parts = await tx.select().from(importSessionParts).where(eq(importSessionParts.sessionId, sessionId)).orderBy(asc(importSessionParts.partIndex))
      let final = manifest
      if (!final) {
        // Asistente de partes sueltas: el servidor genera el manifest a partir de lo que inspeccionó.
        const formats = new Set(parts.map((part) => part.formatVersion))
        if (formats.size !== 1) throw new ManifestError("MANIFEST_MISMATCH", "Las partes seleccionadas usan formatos distintos: no pertenecen a la misma copia.")
        const formatVersion = parts[0].formatVersion === 2 ? 2 : 1
        const dates = parts.map((part) => part.exportedAt).filter((date): date is string => Boolean(date)).sort()
        final = createBackupSetManifest({
          exportSetId: session.exportSetId, exportedAt: dates.at(-1) ?? new Date().toISOString(), payloadFormatVersion: formatVersion,
          parts: parts.map((part) => ({ byteLength: part.byteLength, sha256: part.sha256, counts: part.counts as PartCounts })),
          totals: formatVersion === 2 ? { works: 0, editions: totals.books, copies: totals.books, shelves: totals.shelves } : totals,
        })
      } else if (!sameCounts(bookAndShelfCounts(final.totals), totals)) {
        throw new ManifestError("MANIFEST_MISMATCH", "Los totales del manifiesto no coinciden con el contenido de las partes. No se ha modificado nada.")
      }
      await tx.update(importSessions).set({ state: "validated", totals, payloadFormatVersion: final.payloadFormatVersion,
        manifest: final as unknown as Record<string, unknown>, manifestDigest: sha256(manifestCanonical(final)), updatedAt: sql`now()` }).where(eq(importSessions.id, sessionId))
      return validatedResult(tx, userId, sessionId)
    })
  } catch (error) {
    const code = error instanceof ManifestError ? error.code : error instanceof DomainError && ["MANIFEST_MISMATCH", "LIMIT_EXCEEDED", "INVALID_INPUT"].includes(error.code) ? error.code : null
    if (code) await rejectSession(run, userId, sessionId, code)
    translateStagingError(error)
  }
}

async function validatedResult(tx: DatabaseTransaction, userId: string, sessionId: string): Promise<ValidatedSession> {
  const session = await loadSession(tx, userId, sessionId)
  const parts = await readParts(tx, userId, sessionId)
  const manifest = parseBackupSetManifest(session.manifest)
  const warnings: string[] = []
  const dates = new Set(parts.map((part) => part.exportedAt).filter(Boolean))
  if (session.source === "loose") warnings.push("Estas partes no traían manifiesto: BibLib las ha comprobado entre sí y ha generado uno. Que compartan fecha no demuestra que sean de la misma copia; confírmalo antes de restaurar.")
  if (dates.size > 1) warnings.push("Las partes tienen fechas de exportación distintas. Comprueba que pertenecen a la misma copia.")
  return { session: view(session, parts), manifest, warnings }
}

// ── Vista previa ─────────────────────────────────────────────────────────────────────────────

export interface PreparedRestore {
  sessionId: string
  previewId: string
  revision: string
  expiresAt: string
  plan: ImportPlan
  totals: RestoreSessionTotals
  /** Títulos acotados de lo que se eliminará. */
  changes: { removed: string[]; removedTotal: number }
}

/** Contenido validado de la sesión en la forma legacy común, en el orden de sus partes. */
async function stagedLibrary(tx: DatabaseTransaction, userId: string, sessionId: string): Promise<LibraryData> {
  const rows = await tx.execute<{ kind: "book" | "shelf"; data: Record<string, unknown> }>(sql`select kind, data from biblib.import_session_rows
    where session_id = ${sessionId}::uuid and user_id = ${userId}::uuid order by kind desc, part_index, position`)
  const library: LibraryData = { shelves: [], books: [] }
  for (const row of rows) {
    if (row.kind === "shelf") library.shelves.push({ ...(row.data as unknown as Shelf), book_count: 0 })
    else library.books.push(row.data as unknown as Book)
  }
  return library
}

/**
 * Prepara (o renueva) la vista previa de la restauración frente a la colección actual: reemplazo
 * completo, con la predeterminada protegida y los IDs propios reconocidos. La revisión queda fijada
 * bajo el bloqueo de colección; una edición posterior invalidará la confirmación.
 */
export async function prepareSession(tx: DatabaseTransaction, userId: string, sessionId: string, options: { previewId?: string; ttlMinutes: number }): Promise<PreparedRestore> {
  const revision = await lockCollection(tx)
  const session = await loadSession(tx, userId, sessionId, { forUpdate: true })
  if (session.expired) throw sessionExpired()
  if (session.state === "committed") throw new DomainError("CONFLICT", "Esta restauración ya se publicó. Consulta tu biblioteca o el historial de versiones anteriores.")
  if (session.state !== "validated" && session.state !== "prepared") throw new DomainError("CONFLICT", "Antes de revisar la restauración hay que subir y validar todas las partes.")
  const payload = await stagedLibrary(tx, userId, sessionId)
  const previewId = options.previewId ?? randomUUID()
  const plan = buildImportPlan({ imported: payload, current: await readCollectionSnapshot(tx, userId), mode: "replace", allocateId: previewAllocator(previewId) })
  const covers = new Map(payload.books.map((book) => [book.id, book.cover.large]))
  plan.counts.coversPending = plan.books.insert.filter((entry) => covers.get(entry.sourceId) === DEFAULT_BOOK_COVER).length
  const removedIds = plan.books.delete.slice(0, 20)
  const titles = removedIds.length ? new Map((await tx.select({ id: books.id, title: books.title }).from(books).where(and(eq(books.userId, userId), inArray(books.id, removedIds)))).map((row) => [row.id, row.title])) : new Map<string, string>()
  const [stored] = await tx.update(importSessions).set({
    state: "prepared", previewId, previewRevision: revision, plan, previewExpiresAt: sql`now() + make_interval(mins => ${options.ttlMinutes})`, updatedAt: sql`now()`,
  }).where(eq(importSessions.id, sessionId)).returning({ expiresAt: importSessions.previewExpiresAt })
  return {
    sessionId, previewId, revision, expiresAt: stored.expiresAt!.toISOString(), plan, totals: session.totals ?? { books: payload.books.length, shelves: payload.shelves.length },
    changes: { removed: removedIds.map((id) => titles.get(id) ?? "Libro sin título disponible"), removedTotal: plan.books.delete.length },
  }
}

// ── Publicación ──────────────────────────────────────────────────────────────────────────────

export interface CommitRequest { userId: string; sessionId: string; previewId: string; expectedRevision: string; idempotencyKey: string }
export interface CommitOutcome { operationId: string; result: ImportOperationResult; replayed: boolean; snapshotId: string | null }

/** Puntos de prueba dentro de la transacción final; producción no los usa. */
export interface CommitHooks {
  afterCapture?(snapshotId: string): Promise<void> | void
  /** Justo antes de la última sentencia (marcar la sesión como publicada). */
  beforeFinalize?(): Promise<void> | void
}

/** Hash de la entrada canónica de una publicación: conjunto, modo y reglas. La clave se limita a esto. */
export function restoreCommitDigest(session: { manifestDigest: string; rulesVersion: number }): string {
  return sha256(canonicalJson({ operation: RESTORE_OPERATION, manifestDigest: session.manifestDigest, mode: "replace", rulesVersion: session.rulesVersion }))
}

/**
 * Publica una sesión preparada en una sola transacción: bloqueo de colección con `lock_timeout`,
 * decisión por clave, caducidad/reglas y revisión (nunca fuerza), operación durable, versión anterior
 * del estado sustituido y SQL por conjuntos desde staging, con `statement_timeout` por sentencia y un
 * presupuesto total. Cualquier fallo revierte todo, incluido el indicador de éxito, y deja el staging.
 */
export async function publishRestoreSession(tx: DatabaseTransaction, request: CommitRequest, options: { budget?: CommitBudget; hooks?: CommitHooks; publishEnabled?: boolean } = {}): Promise<CommitOutcome> {
  const budget = options.budget ?? DEFAULT_COMMIT_BUDGET
  const hooks = options.hooks ?? {}
  const started = Date.now()
  const step = async <T>(work: () => Promise<T>): Promise<T> => {
    const remaining = budget.totalMs - (Date.now() - started)
    if (remaining <= 0) throw commitTimedOut()
    await tx.execute(sql`select set_config('statement_timeout', ${String(Math.max(1, Math.min(budget.statementTimeoutMs, remaining)))}, true)`)
    return work()
  }
  const { userId, sessionId, previewId, expectedRevision, idempotencyKey } = request
  await tx.execute(sql`select set_config('lock_timeout', ${String(budget.lockTimeoutMs)}, true)`)
  const currentRevision = await step(() => lockCollection(tx))
  const [row] = await step(() => tx.select({ session: importSessions, expired: sql<boolean>`${importSessions.expiresAt} <= now()`, previewExpired: sql<boolean>`coalesce(${importSessions.previewExpiresAt} <= now(), true)` })
    .from(importSessions).where(and(eq(importSessions.id, sessionId), eq(importSessions.userId, userId))).limit(1).for("update"))
  const [existing] = await step(() => tx.select().from(libraryOperations)
    .where(and(eq(libraryOperations.userId, userId), eq(libraryOperations.operation, RESTORE_OPERATION), eq(libraryOperations.idempotencyKey, idempotencyKey))).limit(1))
  const session = row?.session
  const matches = session && session.previewId === previewId
  const digest = session ? restoreCommitDigest(session) : null
  const decision = decideConfirmation({
    existing: existing ? { operationId: existing.id, inputDigest: existing.inputDigest, previewId: existing.previewId } : null,
    preview: matches ? { id: previewId, revision: session.previewRevision!, expired: row.expired || row.previewExpired, rulesVersion: session.rulesVersion, confirmed: session.state === "committed" } : null,
    previewId, digest, expectedRevision, currentRevision,
  })
  if (decision.kind === "replay") {
    const [snapshot] = await step(() => tx.select({ id: librarySnapshots.id }).from(librarySnapshots)
      .where(and(eq(librarySnapshots.userId, userId), eq(librarySnapshots.sourceOperationId, existing!.id))).limit(1))
    return { operationId: existing!.id, result: existing!.result, replayed: true, snapshotId: snapshot?.id ?? null }
  }
  if (decision.kind === "reject") {
    if (decision.code === "IDEMPOTENCY_CONFLICT") throw idempotencyConflict()
    if (decision.code === "PREVIEW_EXPIRED") throw new DomainError("PREVIEW_EXPIRED", "La revisión de la restauración ha caducado. Las partes se conservan: vuelve a revisarla con los datos actuales.")
    if (decision.code === "REVISION_CONFLICT") throw new DomainError("REVISION_CONFLICT", "Tu biblioteca ha cambiado desde que revisaste la restauración. No se ha aplicado nada y las partes se conservan: vuelve a revisarla con los datos actuales.")
    if (decision.code === "ALREADY_CONFIRMED") throw new DomainError("CONFLICT", "Esta restauración ya se publicó. Consulta tu biblioteca o el historial de versiones anteriores.")
    throw sessionUnavailable()
  }
  if (options.publishEnabled === false) throw new DomainError("CONFLICT", "La publicación de restauraciones por partes está desactivada temporalmente. Las partes y la revisión se conservan; tu biblioteca no ha cambiado.")
  const plan = session!.plan!
  const result = operationResult(plan)
  const operationId = randomUUID()
  await step(() => tx.insert(libraryOperations).values({ id: operationId, userId, operation: RESTORE_OPERATION, idempotencyKey, inputDigest: digest!, previewId, status: "committed", result }))
  const snapshot = await step(() => captureSnapshot(tx, { operationId, reason: "import.replace" }))
  await hooks.afterCapture?.(snapshot.id)
  await step(() => tx.delete(books).where(eq(books.userId, userId)))
  await step(() => tx.delete(shelves).where(and(eq(shelves.userId, userId), eq(shelves.isDefault, false))))
  await step(() => tx.execute(sql`insert into biblib.shelves (id, user_id, title, is_default)
    select p.id, s.user_id, p.title, false from biblib.import_sessions s
    cross join lateral jsonb_to_recordset(s.plan->'shelves'->'create') as p(id uuid, title text)
    where s.id = ${sessionId}::uuid and s.user_id = ${userId}::uuid`))
  const [{ inserted }] = await step(() => tx.execute<{ inserted: number }>(sql`with added as (
    insert into biblib.books (id, user_id, isbn, title, subtitle, authors, publishers, catalogue, number_of_pages, publish_date, cover_small, cover_medium, cover_large, status, shelf_id)
    select p.id, s.user_id, r.data->>'isbn', r.data->>'title', r.data->>'subtitle', coalesce(r.data->'authors', '[]'::jsonb), coalesce(r.data->'publishers', '[]'::jsonb),
      coalesce(r.data->'catalogue', '{"source":"import","isbnVerified":false}'::jsonb), (r.data->>'number_of_pages')::integer, r.data->>'publish_date',
      r.data#>>'{cover,small}', r.data#>>'{cover,medium}', r.data#>>'{cover,large}', r.data->>'status', p."shelfId"
    from biblib.import_sessions s
    cross join lateral jsonb_to_recordset(s.plan->'books'->'insert') as p("sourceId" text, id uuid, "shelfId" uuid)
    join biblib.import_session_rows r on r.session_id = s.id and r.user_id = s.user_id and r.kind = 'book' and r.row_key = p."sourceId"
    where s.id = ${sessionId}::uuid and s.user_id = ${userId}::uuid
    returning 1) select count(*)::int as inserted from added`))
  if (inserted !== plan.books.insert.length) throw revisionConflict()
  await hooks.beforeFinalize?.()
  await step(() => tx.update(importSessions).set({ state: "committed", operationId, updatedAt: sql`now()` }).where(eq(importSessions.id, sessionId)))
  return { operationId, result, replayed: false, snapshotId: snapshot.id }
}

/** Tras publicar, el staging ya no hace falta: se liberan trozos y filas y se conserva el resumen. */
export async function releaseStaging(tx: DatabaseTransaction, userId: string, sessionId: string): Promise<void> {
  await tx.execute(sql`delete from biblib.import_session_rows where session_id = ${sessionId}::uuid and user_id = ${userId}::uuid`)
  await tx.execute(sql`delete from biblib.import_session_chunks where session_id = ${sessionId}::uuid and user_id = ${userId}::uuid`)
}

/** Descarta una sesión propia con todo su staging. La colección activa no cambia. */
export async function discardSession(tx: DatabaseTransaction, userId: string, sessionId: string): Promise<void> {
  const removed = await tx.delete(importSessions).where(and(eq(importSessions.id, sessionId), eq(importSessions.userId, userId))).returning({ id: importSessions.id })
  if (!removed.length) throw sessionUnavailable()
}

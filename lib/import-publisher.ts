import { createHash, randomUUID } from "node:crypto"
import { and, asc, eq, sql } from "drizzle-orm"
import type { DatabaseTransaction } from "./db/client"
import { books, importPreviews, importSessions, libraryOperations, librarySnapshots, shelves } from "./db/schema"
import { deleteAllCopies, insertPlannedCopies } from "./db/model"
import { applyProductData, deleteAccountProduct, readProductTargets } from "./db/product"
import { DomainError, idempotencyConflict, previewExpired, revisionConflict } from "./domain-errors"
import { parseLibraryImport } from "./library-import"
import {
  buildImportPlan, canonicalJson, confirmationInput, decideConfirmation, operationResult,
  type CollectionSnapshot, type ConfirmDecision, type IdAllocator, type ImportOperationResult, type ImportPlan,
} from "./import-plan"
import {
  applyRestorePlan, buildRestorePlan, captureSnapshot, foreignSnapshotIds, readSnapshotContent, readSnapshotHeader, restoreDigest,
  snapshotExpired, snapshotUnavailable,
} from "./library-snapshots"
import type { LibraryData } from "./types"

// Publicador base de importaciones (U-DAT-03), extraído de la confirmación de U-DAT-01. Recibe una
// transacción ya situada en el contexto RLS del dueño y no hace red: bloqueo de colección, CAS de
// revisión, mapeo de IDs, SQL por conjuntos y resultado durable. U-DAT-02 añade la versión anterior:
// un reemplazo o una restauración capturan el estado que sustituyen en esta misma transacción, antes
// de escribir; si la captura falla no se publica nada. U-DAT-04 añadirá los conjuntos multiparte.
// U-DAT-06: cada fila es un ejemplar; la publicación crea sus obras y ediciones en las tablas del modelo.

export interface PublishRequest {
  userId: string
  previewId: string
  expectedRevision: string
  idempotencyKey: string
}

export interface PublishOutcome {
  operationId: string
  result: ImportOperationResult
  /** true si se recuperó el resultado durable de una confirmación anterior con la misma clave. */
  replayed: boolean
  /** IDs de los libros insertados por esta publicación (vacío al recuperar un resultado). */
  insertedBookIds: string[]
  /** Versión anterior capturada por esta publicación (reemplazo o restauración); null al fusionar o recuperar. */
  snapshotId: string | null
}

/** Puntos de prueba entre la captura y la publicación; producción no los usa. */
export interface PublishHooks {
  afterCapture?(snapshotId: string): Promise<void> | void
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

/** IDs nuevos derivados de la vista previa: la misma entrada produce el mismo plan al confirmar. */
export function previewAllocator(seed: string): IdAllocator {
  return (kind, sourceId) => {
    const hex = sha256(`${seed}\u0000${kind}\u0000${sourceId}`)
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
}

/** Hash de la entrada canónica de una confirmación: archivo, modo y reglas de la vista previa. */
export function confirmationDigest(preview: { inputDigest: string; mode: "merge" | "replace"; rulesVersion: number }): string {
  return sha256(canonicalJson(confirmationInput(preview)))
}

/** Bloqueo de colección de U-DAT-01: el dueño sale de `auth.uid()` de la transacción. */
export async function lockCollection(tx: DatabaseTransaction): Promise<string> {
  const rows = await tx.execute<{ revision: string }>(sql`select biblib.lock_library() as revision`)
  const revision = rows[0]?.revision
  if (!revision) throw new Error("No se pudo bloquear la colección.")
  return revision
}

export async function readCollectionSnapshot(tx: DatabaseTransaction, userId: string): Promise<CollectionSnapshot> {
  const shelfRows = await tx.select({ id: shelves.id, title: shelves.title, isDefault: shelves.isDefault }).from(shelves)
    .where(eq(shelves.userId, userId)).orderBy(asc(shelves.createdAt), asc(shelves.id))
  // Vista plana: un elemento por ejemplar con su identificador, su edición y su obra.
  const bookRows = await tx.select({ id: books.id, isbn: books.isbn, editionId: books.editionId, workId: books.workId }).from(books)
    .where(eq(books.userId, userId)).orderBy(asc(books.id))
  return { shelves: shelfRows, books: bookRows }
}

async function applyPlan(tx: DatabaseTransaction, userId: string, payload: LibraryData, plan: ImportPlan, allocateId: IdAllocator): Promise<void> {
  // Datos de producto (0014): qué es del dueño se lee antes de retirar nada; al reemplazar, la colección resultante es la
  // del archivo también en etiquetas, ubicaciones y series (un archivo anterior las deja vacías).
  const targets = await readProductTargets(tx, userId, payload, plan.mode)
  if (plan.mode === "replace") {
    await deleteAllCopies(tx, userId)
    await tx.delete(shelves).where(and(eq(shelves.userId, userId), eq(shelves.isDefault, false)))
    await deleteAccountProduct(tx, userId)
  }
  if (plan.shelves.create.length) {
    await tx.insert(shelves).values(plan.shelves.create.map((shelf) => ({ id: shelf.id, userId, title: shelf.title, isDefault: false })))
  }
  const source = new Map(payload.books.map((book) => [book.id, book]))
  if (plan.books.insert.some((entry) => !source.has(entry.sourceId))) throw revisionConflict()
  await insertPlannedCopies(tx, userId, plan, source)
  await applyProductData(tx, userId, payload, plan, plan.mode, targets, allocateId)
}

/**
 * Publica una vista previa confirmada. Bajo el bloqueo de colección decide por este orden: clave
 * (una repetición idéntica recupera el resultado durable), caducidad/reglas y revisión. Nunca
 * fuerza: un rechazo lanza `DomainError` sin escribir nada.
 */
export async function publishImport(tx: DatabaseTransaction, request: PublishRequest, hooks: PublishHooks = {}): Promise<PublishOutcome> {
  const { userId, previewId, expectedRevision, idempotencyKey } = request
  const currentRevision = await lockCollection(tx)
  const [preview] = await tx.select({ preview: importPreviews, expired: sql<boolean>`${importPreviews.expiresAt} <= now()` }).from(importPreviews)
    .where(and(eq(importPreviews.id, previewId), eq(importPreviews.userId, userId))).limit(1)
  const [existing] = await tx.select().from(libraryOperations)
    .where(and(eq(libraryOperations.userId, userId), eq(libraryOperations.operation, "import.confirm"), eq(libraryOperations.idempotencyKey, idempotencyKey))).limit(1)
  const [consumed] = preview ? await tx.select({ id: libraryOperations.id }).from(libraryOperations)
    .where(and(eq(libraryOperations.userId, userId), eq(libraryOperations.previewId, previewId))).limit(1) : []
  const digest = preview ? confirmationDigest(preview.preview) : null

  const decision = decideConfirmation({
    existing: existing ? { operationId: existing.id, inputDigest: existing.inputDigest, previewId: existing.previewId } : null,
    preview: preview ? { id: preview.preview.id, revision: preview.preview.revision, expired: preview.expired, rulesVersion: preview.preview.rulesVersion, confirmed: Boolean(consumed) } : null,
    previewId, digest, expectedRevision, currentRevision,
  })
  if (decision.kind === "replay") return { operationId: existing!.id, result: existing!.result as ImportOperationResult, replayed: true, insertedBookIds: [], snapshotId: null }
  if (decision.kind === "reject") rejectConfirmation(decision.code, {
    notFound: "La revisión de la importación no está disponible. Prepárala de nuevo.",
    alreadyConfirmed: "Esta revisión ya se confirmó. Prepara una nueva si quieres volver a importar el archivo.",
  })

  // Se vuelve a validar la entrada almacenada y a derivar el plan: con la misma revisión debe coincidir.
  const stored = preview!.preview
  const csv = stored.plan.csv
  if (csv) {
    const [session] = await tx.select().from(importSessions).where(and(eq(importSessions.id, csv.sessionId), eq(importSessions.userId, userId),
      eq(importSessions.source, "csv"), eq(importSessions.state, "prepared"), eq(importSessions.previewId, stored.id), sql`${importSessions.expiresAt} > now()`)).limit(1).for("update")
    if (!session || session.mappingSha256 !== csv.mappingHash || session.csvMappingVersion !== csv.mappingVersion || session.inputSha256 !== csv.inputHash) throw previewExpired()
  }
  // Una vista previa de restauración solo se confirma con restoreSnapshotAction.
  if (stored.snapshotId || !stored.payload) throw new DomainError("NOT_FOUND", "La revisión de la importación no está disponible. Prepárala de nuevo.")
  let payload: LibraryData
  try { payload = parseLibraryImport(stored.payload) } catch { throw previewExpired() }
  const plan = buildImportPlan({ imported: payload, current: await readCollectionSnapshot(tx, userId), mode: stored.mode, allocateId: previewAllocator(csv?.sessionId ?? stored.id), duplicatePolicy: stored.plan.duplicatePolicy,
    covers: { found: stored.plan.counts.coversFound, pending: stored.plan.counts.coversPending } })
  if (csv) plan.csv = csv
  if (canonicalJson(plan) !== canonicalJson(stored.plan)) throw revisionConflict()
  const result = operationResult(plan)
  // La operación se registra antes de escribir para que la versión anterior la cite en esta misma transacción.
  const operationId = randomUUID()
  await tx.insert(libraryOperations).values({
    id: operationId, userId, operation: "import.confirm", idempotencyKey, inputDigest: digest!, previewId: stored.id, status: "committed", result,
  })
  let snapshotId: string | null = null
  if (plan.mode === "replace") {
    snapshotId = (await captureSnapshot(tx, { operationId, reason: "import.replace" })).id
    await hooks.afterCapture?.(snapshotId)
  }
  await applyPlan(tx, userId, payload, plan, previewAllocator(stored.id))
  if (csv) await tx.update(importSessions).set({ state: "committed", operationId, version: randomUUID(), updatedAt: sql`now()` }).where(and(eq(importSessions.id, csv.sessionId), eq(importSessions.userId, userId)))
  return { operationId, result, replayed: false, insertedBookIds: plan.books.insert.map((entry) => entry.id), snapshotId }
}

function rejectConfirmation(code: Extract<ConfirmDecision, { kind: "reject" }>["code"], messages: { notFound: string; alreadyConfirmed: string }): never {
  if (code === "IDEMPOTENCY_CONFLICT") throw idempotencyConflict()
  if (code === "PREVIEW_EXPIRED") throw previewExpired()
  if (code === "REVISION_CONFLICT") throw revisionConflict()
  if (code === "ALREADY_CONFIRMED") throw new DomainError("CONFLICT", messages.alreadyConfirmed)
  throw new DomainError("NOT_FOUND", messages.notFound)
}

/**
 * Restaura una versión anterior propia a partir de su vista previa (U-DAT-02), con el mismo orden de
 * decisión que una importación: clave, caducidad/reglas y revisión, bajo el bloqueo de colección.
 * Antes de sustituir nada captura otra versión del estado actual en esta transacción. La versión
 * restaurada se verifica por hash y el plan se vuelve a derivar: si la colección cambió, conflicto.
 */
export async function publishSnapshotRestore(tx: DatabaseTransaction, request: PublishRequest, hooks: PublishHooks = {}): Promise<PublishOutcome> {
  const { userId, previewId, expectedRevision, idempotencyKey } = request
  const currentRevision = await lockCollection(tx)
  const [preview] = await tx.select({ preview: importPreviews, expired: sql<boolean>`${importPreviews.expiresAt} <= now()` }).from(importPreviews)
    .where(and(eq(importPreviews.id, previewId), eq(importPreviews.userId, userId))).limit(1)
  const restorable = preview?.preview.snapshotId ? preview : undefined
  const [existing] = await tx.select().from(libraryOperations)
    .where(and(eq(libraryOperations.userId, userId), eq(libraryOperations.operation, "snapshot.restore"), eq(libraryOperations.idempotencyKey, idempotencyKey))).limit(1)
  const [consumed] = restorable ? await tx.select({ id: libraryOperations.id }).from(libraryOperations)
    .where(and(eq(libraryOperations.userId, userId), eq(libraryOperations.previewId, previewId))).limit(1) : []
  const digest = restorable ? restoreDigest(restorable.preview) : null

  const decision = decideConfirmation({
    existing: existing ? { operationId: existing.id, inputDigest: existing.inputDigest, previewId: existing.previewId } : null,
    preview: restorable ? { id: restorable.preview.id, revision: restorable.preview.revision, expired: restorable.expired, rulesVersion: restorable.preview.rulesVersion, confirmed: Boolean(consumed) } : null,
    previewId, digest, expectedRevision, currentRevision,
  })
  if (decision.kind === "replay") {
    const [snapshot] = await tx.select({ id: librarySnapshots.id }).from(librarySnapshots)
      .where(and(eq(librarySnapshots.userId, userId), eq(librarySnapshots.sourceOperationId, existing!.id))).limit(1)
    return { operationId: existing!.id, result: existing!.result as ImportOperationResult, replayed: true, insertedBookIds: [], snapshotId: snapshot?.id ?? null }
  }
  // Borrar la versión borra sus vistas previas: una restauración en preparación responde «no disponible».
  if (decision.kind === "reject") rejectConfirmation(decision.code, {
    notFound: snapshotUnavailable().message,
    alreadyConfirmed: "Esta restauración ya se aplicó. Revisa el historial y prepara otra si la necesitas.",
  })

  const stored = restorable!.preview
  const header = await readSnapshotHeader(tx, userId, stored.snapshotId!)
  if (!header) throw snapshotUnavailable()
  if (header.expired) throw snapshotExpired()
  if (header.digest !== stored.inputDigest) throw revisionConflict()
  const content = await readSnapshotContent(tx, userId, header)
  const foreign = await foreignSnapshotIds(tx, header.id)
  const plan = buildRestorePlan({ snapshot: content, current: await readCollectionSnapshot(tx, userId), foreign, allocateId: previewAllocator(stored.id) })
  if (canonicalJson(plan) !== canonicalJson(stored.plan)) throw revisionConflict()
  const result = operationResult(plan)
  const operationId = randomUUID()
  await tx.insert(libraryOperations).values({
    id: operationId, userId, operation: "snapshot.restore", idempotencyKey, inputDigest: digest!, previewId: stored.id, status: "committed", result,
  })
  const snapshotId = (await captureSnapshot(tx, { operationId, reason: "snapshot.restore" })).id
  await hooks.afterCapture?.(snapshotId)
  await applyRestorePlan(tx, userId, content, plan, { foreign, allocateId: previewAllocator(stored.id) })
  return { operationId, result, replayed: false, insertedBookIds: [], snapshotId }
}

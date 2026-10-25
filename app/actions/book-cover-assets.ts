"use server"

import { createHash } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { versionTokenSchema } from "@/lib/book-validation"
import type { ActionResult } from "@/lib/action-result"
import { OPEN_LIBRARY_COVERS_HOST } from "@/lib/bibliographic-catalog/providers/endpoints"
import { assertBookVersion, bookVersionConflict } from "@/lib/book-version"
import { withRlsContext, type DatabaseTransaction } from "@/lib/db/client"
import { lockLibrary, mapRowToBook } from "@/lib/db/library"
import { bookFields, books, libraryJobs, shelves } from "@/lib/db/schema"
import { DomainError, idempotencyConflict, jobConflict } from "@/lib/domain-errors"
import { IDEMPOTENCY_KEY_PATTERN, isTerminal } from "@/lib/jobs/contracts"
import { controlJob } from "@/lib/jobs/server"
import { domainMutation } from "@/lib/server-action"
import { getRequiredUserId } from "@/lib/server-user"
import type { Book } from "@/lib/types"
import {
  ACCEPTED_IMAGE_TYPES, ASSET_LIMITS, AssetRejectedError, coverAssetRights, coverStorageKey, parseProviderCoverKey, providerCoverKeyFromUrl,
  readCoverAssetsMode, type BookCoverAssetState, type CoverAssetJobView, type CoverAssetView,
} from "@/lib/assets/contracts"
import { validateAndNormalizeImage } from "@/lib/assets/image-validation"
import { assetView, attachAsset, beginUpload, detachAsset, discardAsset, findDuplicate, readAsset, readAssetByJob, registerAsset, requestAcquisition, storedUsage, StorageDeniedError } from "@/lib/assets/repository"
import { ownerStorage, purgeOwnerAssets, runAssetJob } from "@/lib/assets/server"

// U-DAT-10 · Portadas privadas de una ficha. El dueño sale de la sesión; el servidor deriva bucket,
// ruta y propietario y comprueba los derechos vigentes antes de cualquier red. La portada visible no
// cambia hasta que la imagen está validada, registrada y adjunta con la versión de la ficha.

const keySchema = z.string().regex(IDEMPOTENCY_KEY_PATTERN)
const requestSchema = z.object({ entityId: z.uuid(), expectedVersion: versionTokenSchema, providerCoverKey: z.string().max(80), idempotencyKey: keySchema })
const jobSchema = z.object({ jobId: z.uuid() })
const controlSchema = z.object({ jobId: z.uuid(), expectedVersion: z.uuid() })
const attachSchema = z.object({ assetId: z.uuid(), entityId: z.uuid(), expectedVersion: versionTokenSchema })
const detachSchema = z.object({ entityId: z.uuid(), expectedVersion: versionTokenSchema })
const uploadSchema = z.object({ entityId: z.uuid(), mime: z.enum(ACCEPTED_IMAGE_TYPES), bytes: z.coerce.number().int().min(1) })

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError("INVALID_INPUT", message)
  return parsed.data
}

function requireMode(kind: "uploads" | "full"): void {
  const mode = readCoverAssetsMode()
  if (mode === "off" || (kind === "full" && mode !== "full")) throw new DomainError("CONFLICT", "Las portadas privadas no están disponibles en este momento. La portada actual no cambia.")
}

const inactive = () => new DomainError("UNAUTHORIZED", "Tu cuenta no admite operaciones nuevas en este momento.")
const quotaExceeded = (quota: "quarantine" | "stored") => new DomainError("LIMIT_EXCEEDED", quota === "quarantine"
  ? "Ya tienes varias imágenes pendientes de validar. Espera a que terminen antes de añadir otra."
  : "Has alcanzado el espacio de portadas privadas (500 imágenes o 200 MiB). Retira alguna antes de añadir otra.")

async function findBook(tx: DatabaseTransaction, userId: string, id: string): Promise<Book | null> {
  const [row] = await tx.select({ book: bookFields, shelfTitle: shelves.title }).from(books)
    .innerJoin(shelves, and(eq(books.shelfId, shelves.id), eq(shelves.userId, userId)))
    .where(and(eq(books.id, id), eq(books.userId, userId))).limit(1)
  return row ? mapRowToBook(row) : null
}

/** La purga del dueño nunca hace fallar la acción: lo pendiente se retira en la siguiente. */
async function purgeQuietly(owner: string): Promise<void> {
  try { await purgeOwnerAssets(owner, await ownerStorage(), 20) } catch { /* Se reintenta en la siguiente acción o en el script administrativo. */ }
}

function jobViewOf(row: typeof libraryJobs.$inferSelect, assetId: string | null): CoverAssetJobView {
  const result = row.result && typeof row.result === "object" ? row.result as Record<string, unknown> : {}
  return {
    jobId: row.id, assetId: typeof result.assetId === "string" ? result.assetId : assetId, state: row.state, version: row.version, errorCode: row.errorCode,
    attached: result.attached === true, deduplicated: result.deduplicated === true,
    nextAttemptAt: row.state === "waiting_retry" ? row.nextAttemptAt.toISOString() : null,
  }
}

async function readJobView(owner: string, jobId: string): Promise<CoverAssetJobView> {
  return withRlsContext(owner, async (tx) => {
    const [row] = await tx.select().from(libraryJobs).where(and(eq(libraryJobs.id, jobId), eq(libraryJobs.userId, owner), eq(libraryJobs.kind, "cover_asset"))).limit(1)
    // Un trabajo ajeno o inexistente responde igual: no se confirma su existencia.
    if (!row) throw new DomainError("NOT_FOUND", "No se encontró la copia de portada.")
    const asset = await readAssetByJob(tx, owner, jobId)
    return jobViewOf(row, asset?.id ?? null)
  })
}

/** Estado de la portada privada de una ficha y lo que se puede hacer con ella, decidido en el servidor. */
export async function getBookCoverAssetsAction(bookId: string): Promise<ActionResult<BookCoverAssetState>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const entityId = parse(z.uuid(), bookId, "La ficha no es válida.")
    const mode = readCoverAssetsMode()
    return withRlsContext(owner, async (tx) => {
      const book = await findBook(tx, owner, entityId)
      if (!book) throw new DomainError("NOT_FOUND", "El libro ya no está disponible.")
      const current = book.coverAssetId ? await readAsset(tx, owner, book.coverAssetId) : null
      // Solo se ofrece copiar una portada de proveedor si su política vigente lo permite (hoy, ninguna).
      const key = providerCoverKeyFromUrl(book.cover.large, OPEN_LIBRARY_COVERS_HOST)
      const providerCoverKey = mode === "full" && key && coverAssetRights(key.provider).rehost ? key.ref : null
      return { mode, current: current ? assetView(current) : null, providerCoverKey, canUpload: mode !== "off", quota: await storedUsage(tx, owner) }
    })
  })
}

/**
 * Pide una copia privada de la portada de un proveedor. Los derechos se comprueban aquí, antes de
 * crear nada o de cualquier red, y otra vez en el ejecutor. Se ejecuta en esta petición (la subida
 * necesita la sesión del dueño); si queda pendiente, `getCoverAssetJobAction` la continúa.
 */
export async function requestProviderCoverAssetAction(input: { entityId: string; expectedVersion: string; providerCoverKey: string; idempotencyKey: string }): Promise<ActionResult<CoverAssetJobView>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    requireMode("full")
    const parsed = parse(requestSchema, input, "La solicitud de copia no es válida.")
    const key = parseProviderCoverKey(parsed.providerCoverKey)
    if (!key) throw new DomainError("INVALID_INPUT", "La portada indicada no es válida.")
    const rights = coverAssetRights(key.provider)
    if (!rights.rehost) throw new AssetRejectedError("RIGHTS_DENIED")
    const digest = createHash("sha256").update(JSON.stringify({ kind: "cover_asset", entity: parsed.entityId, version: parsed.expectedVersion, key: key.ref, contract: 1 })).digest("hex")
    const result = await withRlsContext(owner, (tx) => requestAcquisition(tx, { bookId: parsed.entityId, bookVersion: parsed.expectedVersion, sourceRef: key.ref, policyVersion: rights.policy.version, attribution: rights.policy.attribution, idempotencyKey: parsed.idempotencyKey, digest }))
    if (result.status === "conflict") throw idempotencyConflict()
    if (result.status === "not_found") throw new DomainError("NOT_FOUND", "El libro ya no está disponible.")
    if (result.status === "stale") throw bookVersionConflict()
    if (result.status === "limit") throw jobConflict("Ya tienes varios trabajos en curso. Espera a que terminen antes de pedir otra copia.")
    if (result.status === "inactive") throw inactive()
    if (result.status === "quota") throw quotaExceeded(result.quota)
    if (result.status !== "created" && result.status !== "existing") throw new DomainError("PROVIDER_UNAVAILABLE", "No se pudo crear la copia. Inténtalo de nuevo.")
    const storage = await ownerStorage()
    await runAssetJob(owner, result.job_id, storage, 15_000)
    return readJobView(owner, result.job_id)
  })
}

/** Estado de una adquisición; si tiene un paso vencido, lo ejecuta con la sesión del dueño. */
export async function getCoverAssetJobAction(input: { jobId: string }): Promise<ActionResult<CoverAssetJobView>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const { jobId } = parse(jobSchema, input, "La copia indicada no es válida.")
    const view = await readJobView(owner, jobId)
    if (!isTerminal(view.state as never) && readCoverAssetsMode() === "full") {
      await runAssetJob(owner, jobId, await ownerStorage(), 15_000)
      return readJobView(owner, jobId)
    }
    return view
  })
}

/** Cancelar impide que un resultado tardío se registre o se adjunte (el lease deja de valer). */
export async function cancelCoverAssetJobAction(input: { jobId: string; expectedVersion: string }): Promise<ActionResult<CoverAssetJobView>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const { jobId, expectedVersion } = parse(controlSchema, input, "La copia indicada no es válida.")
    await readJobView(owner, jobId)
    await controlJob(owner, jobId, expectedVersion, "cancel")
    return readJobView(owner, jobId)
  })
}

/**
 * Sube una portada propia. El tipo y el tamaño declarados no son prueba: los bytes pasan las mismas
 * validaciones que una descarga y se guardan reencodificados como WebP. Devuelve el asset sin
 * adjuntarlo; `attachCoverAssetAction` lo adjunta con la versión de la ficha.
 */
export async function beginOwnCoverUploadAction(form: FormData): Promise<ActionResult<{ asset: CoverAssetView; deduplicated: boolean }>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    requireMode("uploads")
    const fields = parse(uploadSchema, { entityId: form.get("entityId"), mime: form.get("mime"), bytes: form.get("bytes") }, "La imagen no es válida. Elige un archivo JPEG, PNG o WebP de hasta 5 MiB.")
    const file = form.get("file")
    if (!(file instanceof Blob)) throw new DomainError("INVALID_INPUT", "Elige una imagen para subir.")
    if (fields.bytes > ASSET_LIMITS.maxBytes || file.size > ASSET_LIMITS.maxBytes) throw new AssetRejectedError("TOO_LARGE")
    if (file.size !== fields.bytes) throw new DomainError("INVALID_INPUT", "La imagen llegó incompleta. Vuelve a intentarlo.")
    const exists = await withRlsContext(owner, (tx) => findBook(tx, owner, fields.entityId))
    if (!exists) throw new DomainError("NOT_FOUND", "El libro ya no está disponible.")

    const normalized = await validateAndNormalizeImage(new Uint8Array(await file.arrayBuffer()), { declaredType: fields.mime })
    const duplicate = await withRlsContext(owner, (tx) => findDuplicate(tx, owner, normalized.sha256))
    if (duplicate?.state === "ready") return { asset: assetView(duplicate), deduplicated: true }

    const begun = await withRlsContext(owner, (tx) => beginUpload(tx))
    if (begun.status === "inactive") throw inactive()
    if (begun.status === "quota") throw quotaExceeded(begun.quota)
    const storage = await ownerStorage()
    const key = coverStorageKey(owner, begun.asset_id, begun.upload_token)
    try {
      if (await storage.upload(key, normalized.webp) !== "created") throw new DomainError("PROVIDER_UNAVAILABLE", "No se pudo guardar la imagen. Inténtalo de nuevo.")
      const registered = await withRlsContext(owner, (tx) => registerAsset(tx, { assetId: begun.asset_id, token: begun.upload_token, sha256: normalized.sha256, bytes: normalized.bytes, width: normalized.width, height: normalized.height, licenseExpiresAt: null }))
      if (registered.status === "inactive") throw inactive()
      if (registered.status !== "ready" && registered.status !== "duplicate") throw new DomainError("PROVIDER_UNAVAILABLE", "La subida caducó antes de terminar. Vuelve a intentarlo.")
      if (registered.status === "duplicate") await storage.remove([key]).catch(() => 0)
      const row = await withRlsContext(owner, (tx) => readAsset(tx, owner, registered.asset_id))
      if (!row) throw new DomainError("PROVIDER_UNAVAILABLE", "No se pudo guardar la imagen. Inténtalo de nuevo.")
      return { asset: assetView(row), deduplicated: registered.status === "duplicate" }
    } catch (error) {
      // La cuarentena se descarta; el objeto, si llegó a subirse, queda huérfano para la purga.
      await withRlsContext(owner, (tx) => discardAsset(tx, begun.asset_id)).catch(() => false)
      await storage.remove([key]).catch(() => 0)
      if (error instanceof StorageDeniedError) throw new DomainError("UNAUTHORIZED", "No se pudo guardar la imagen con tu sesión. Vuelve a iniciar sesión e inténtalo de nuevo.")
      throw error
    }
  })
}

/** Adjunta un asset propio utilizable a la ficha si conserva la versión vista. */
export async function attachCoverAssetAction(input: { assetId: string; entityId: string; expectedVersion: string }): Promise<ActionResult<Book>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    requireMode("uploads")
    const { assetId, entityId, expectedVersion } = parse(attachSchema, input, "La portada indicada no es válida.")
    const book = await withRlsContext(owner, async (tx) => {
      await lockLibrary(tx)
      const current = await findBook(tx, owner, entityId)
      if (!current) throw new DomainError("NOT_FOUND", "El libro ya no está disponible.")
      assertBookVersion(current, expectedVersion)
      const outcome = await attachAsset(tx, owner, { bookId: entityId, expectedVersion, assetId })
      if (outcome === "changed") throw bookVersionConflict()
      if (outcome === "unavailable") throw new DomainError("NOT_FOUND", "Esa portada privada ya no está disponible.")
      return (await findBook(tx, owner, entityId))!
    })
    await purgeQuietly(owner)
    return book
  })
}

/** Vuelve a mostrar la portada original de la ficha; la imagen privada se purga cuando nada la cite. */
export async function detachCoverAssetAction(input: { entityId: string; expectedVersion: string }): Promise<ActionResult<Book>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const { entityId, expectedVersion } = parse(detachSchema, input, "La ficha no es válida.")
    const book = await withRlsContext(owner, async (tx) => {
      await lockLibrary(tx)
      const current = await findBook(tx, owner, entityId)
      if (!current) throw new DomainError("NOT_FOUND", "El libro ya no está disponible.")
      assertBookVersion(current, expectedVersion)
      if (!(await detachAsset(tx, owner, { bookId: entityId, expectedVersion }))) throw bookVersionConflict()
      return (await findBook(tx, owner, entityId))!
    })
    await purgeQuietly(owner)
    return book
  })
}


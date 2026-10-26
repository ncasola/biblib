import "server-only"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { withRlsContext } from "@/lib/db/client"
import { mediaAssets } from "@/lib/db/schema"
import { accountInactive, DomainError } from "@/lib/domain-errors"
import { getRequiredUserId } from "@/lib/server-user"
import { createClient } from "@/lib/supabase/server"
import { MEDIA_BUCKET, MEDIA_KINDS, mediaStorageKey, type MediaKind, type MediaBeginResult, type MediaRegisterResult, type MediaDiscardResult } from "@/lib/product/contracts"
import { normalizeMediaImage } from "./image-validation"
import type { NormalizedImage } from "@/lib/assets/image-validation"

export interface UploadAsset { assetId: string; storageKey: string; kind: MediaKind }
const uuid = z.uuid()
function validId(id: string) {
  if (!uuid.safeParse(id).success) throw new DomainError("INVALID_INPUT", "La imagen no es válida.")
}
const unavailable = () => new DomainError("PROVIDER_UNAVAILABLE", "No se pudo acceder a la imagen. Comprueba la conexión y vuelve a intentarlo.")

/** Reserva del contrato 0014. Nunca acepta un dueño ni una ruta elegidos por el cliente. */
export async function beginUpload(kind: MediaKind): Promise<UploadAsset> {
  if (!MEDIA_KINDS.includes(kind)) throw new DomainError("INVALID_INPUT", "El tipo de imagen no es válido.")
  const owner = await getRequiredUserId()
  const result = await withRlsContext(owner, async (tx) => (await tx.execute<{ result: MediaBeginResult }>(sql`select biblib.media_asset_begin_upload(${kind}) as result`))[0].result)
  if (result.status === "inactive") throw accountInactive()
  if (result.status === "quota") throw new DomainError("LIMIT_EXCEEDED", "Has alcanzado el límite de imágenes. Vuelve a intentarlo más tarde o retira alguna imagen.")
  return { assetId: result.asset_id, storageKey: result.storage_key, kind }
}

async function ownAsset(assetId: string) {
  validId(assetId)
  const owner = await getRequiredUserId()
  const asset = await withRlsContext(owner, async (tx) => (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.userId, owner), eq(mediaAssets.id, assetId))))[0])
  if (!asset || asset.storageKey !== mediaStorageKey(owner, asset.kind, asset.id)) throw new DomainError("NOT_FOUND", "La imagen no está disponible.")
  return asset
}

/** Decodifica y reencodifica antes de subir; Storage usa exclusivamente la sesión de la petición. */
export async function upload(asset: UploadAsset, bytes: Uint8Array, declaredType?: string): Promise<NormalizedImage> {
  const row = await ownAsset(asset.assetId)
  if (row.storageKey !== asset.storageKey || row.kind !== asset.kind || row.state !== "quarantine") throw new DomainError("ASSET_REJECTED", "La reserva de imagen no es válida.")
  const image = await normalizeMediaImage(row.kind, bytes, declaredType)
  const client = await createClient()
  const { error } = await client.storage.from(MEDIA_BUCKET).upload(row.storageKey, image.webp, { contentType: "image/webp", upsert: false })
  if (error) throw unavailable()
  return image
}

export async function register(assetId: string, image: Pick<NormalizedImage, "sha256" | "bytes" | "width" | "height">): Promise<void> {
  validId(assetId)
  const owner = await getRequiredUserId()
  const result = await withRlsContext(owner, async (tx) => (await tx.execute<{ result: MediaRegisterResult }>(sql`select biblib.media_asset_register(${assetId}::uuid, ${image.sha256}, ${image.bytes}::integer, ${image.width}::integer, ${image.height}::integer) as result`))[0].result)
  if (result.status === "inactive") throw accountInactive()
  if (result.status !== "ready") throw new DomainError("ASSET_REJECTED", "No se pudo registrar la imagen. La imagen anterior se conserva.")
}

/** Una referencia activa o una versión anterior impiden el descarte. El script recoge fallos de limpieza. */
export async function discard(assetId: string): Promise<MediaDiscardResult> {
  validId(assetId)
  const owner = await getRequiredUserId()
  const result = await withRlsContext(owner, async (tx) => (await tx.execute<{ result: MediaDiscardResult }>(sql`select biblib.media_asset_discard(${assetId}::uuid) as result`))[0].result)
  if (result.status === "discarded") {
    const { error } = await (await createClient()).storage.from(MEDIA_BUCKET).remove([result.storage_key])
    if (error) throw unavailable()
  }
  return result
}

/** TTL fijo y corto; la política SELECT comprueba la propiedad también en Storage. */
export async function signedUrl(assetId: string): Promise<string> {
  const asset = await ownAsset(assetId)
  if (asset.state !== "ready") throw new DomainError("NOT_FOUND", "La imagen no está disponible.")
  const { data, error } = await (await createClient()).storage.from(MEDIA_BUCKET).createSignedUrl(asset.storageKey, 60)
  if (error || !data) throw unavailable()
  return data.signedUrl
}

/** Lectura autenticada para vistas duraderas: no se guarda ni se expone una URL pública. */
export async function read(assetId: string): Promise<Blob> {
  const asset = await ownAsset(assetId)
  if (asset.state !== "ready") throw new DomainError("NOT_FOUND", "La imagen no está disponible.")
  const { data, error } = await (await createClient()).storage.from(MEDIA_BUCKET).download(asset.storageKey)
  if (error || !data) throw unavailable()
  return data
}

import "server-only"
import { sql } from "drizzle-orm"
import { withRlsContext } from "@/lib/db/client"
import { accountInactive, DomainError } from "@/lib/domain-errors"
import { createClient } from "@/lib/supabase/server"
import type { NormalizedImage } from "@/lib/assets/image-validation"
import { createSupabaseAssetStorage, sha256Hex, StorageDeniedError, type AssetStorage } from "@/lib/assets/repository"
import {
  MEDIA_BUCKET, type MediaBeginResult, type MediaDiscardResult, type MediaKind, type MediaRegisterResult,
} from "@/lib/product/contracts"

// Flujo de imágenes privadas de 0014 (contratos-o13 → «Imágenes privadas»): reserva en cuarentena, subida con la sesión del
// dueño, registro, cita y descarte. Lo comparten el avatar (U-EXP-06), la foto de ubicación (U-PRO-03) y la foto fuente
// (U-DAT-07). Versión mínima creada por U-PRO-03 con la ruta y firma acordadas (`beginUpload`, `upload`, `register`,
// `discard`, `signedUrl`); el coordinador la concilia con la de U-EXP-06 al integrar. El proceso Next no tiene la
// credencial administrativa: cada operación pasa por `auth.uid()` y por las políticas `biblib_media_*` de Storage.

/** Plazo de una URL firmada: lo justo para que el navegador cargue la imagen. */
export const SIGNED_URL_TTL_SECONDS = 60

export { normalizeMedia } from "@/lib/media/images"

/** Storage del bucket `biblib-media` con la sesión de la petición. */
export async function mediaStorage(): Promise<AssetStorage> {
  return createSupabaseAssetStorage(await createClient(), MEDIA_BUCKET)
}

/** Paso 1: reserva una subida en cuarentena (15 minutos). */
export async function beginUpload(owner: string, kind: MediaKind): Promise<MediaBeginResult> {
  return withRlsContext(owner, async (tx) => (await tx.execute<{ result: MediaBeginResult }>(sql`select biblib.media_asset_begin_upload(${kind}) as result`))[0].result)
}

/** Paso 2: sube los bytes ya validados a la ruta reservada, una sola vez y con la sesión del dueño. */
export async function upload(storageKey: string, bytes: Buffer, storage?: AssetStorage): Promise<void> {
  const target = storage ?? await mediaStorage()
  try {
    if (await target.upload(storageKey, bytes) !== "created") throw new DomainError("PROVIDER_UNAVAILABLE", "No se pudo guardar la imagen. Inténtalo de nuevo.")
  } catch (error) {
    if (error instanceof StorageDeniedError) throw new DomainError("UNAUTHORIZED", "No se pudo guardar la imagen con tu sesión. Vuelve a iniciar sesión e inténtalo de nuevo.")
    throw error
  }
}

/** Paso 3: registra el objeto subido; exige que esté presente con ese tamaño y dentro de los límites del tipo. */
export async function register(owner: string, input: { assetId: string; sha256: string; bytes: number; width: number; height: number }): Promise<MediaRegisterResult> {
  return withRlsContext(owner, async (tx) => (await tx.execute<{ result: MediaRegisterResult }>(sql`
    select biblib.media_asset_register(${input.assetId}::uuid, ${input.sha256}, ${input.bytes}, ${input.width}, ${input.height}) as result`))[0].result)
}

/**
 * Paso 5: descarta un asset que ya nada cita y retira su objeto con la sesión del dueño. Si la retirada del objeto falla,
 * queda un objeto sin fila que la purga administrativa encuentra (`media_asset_purge_candidates`).
 */
export async function discard(owner: string, assetId: string, storage?: AssetStorage): Promise<MediaDiscardResult> {
  const result = await withRlsContext(owner, async (tx) => (await tx.execute<{ result: MediaDiscardResult }>(sql`select biblib.media_asset_discard(${assetId}::uuid) as result`))[0].result)
  if (result.status === "discarded") {
    try { await (storage ?? await mediaStorage()).remove([result.storage_key]) } catch { /* Lo retira la purga administrativa. */ }
  }
  return result
}

/** URL firmada de TTL corto creada con la sesión del dueño (la política `select` solo firma lo propio); nunca pública. */
export async function signedUrl(storageKey: string, ttlSeconds = SIGNED_URL_TTL_SECONDS): Promise<string | null> {
  const client = await createClient()
  const { data, error } = await client.storage.from(MEDIA_BUCKET).createSignedUrl(storageKey, Math.min(Math.max(ttlSeconds, 1), 300))
  return error || !data?.signedUrl ? null : data.signedUrl
}

/**
 * Pasos 1–3 de una vez para una imagen ya normalizada: reserva, sube y registra. Si algo falla, descarta la cuarentena y
 * retira el objeto; la imagen que la entidad cite hasta ahora no cambia (no se suelta hasta citar la nueva).
 */
export async function storeImage(owner: string, kind: MediaKind, image: NormalizedImage): Promise<{ assetId: string; storageKey: string }> {
  const begun = await beginUpload(owner, kind)
  if (begun.status === "inactive") throw accountInactive()
  if (begun.status === "quota") throw new DomainError("LIMIT_EXCEEDED", begun.quota === "quarantine"
    ? "Ya tienes varias imágenes pendientes de validar. Espera unos minutos antes de añadir otra."
    : "Has alcanzado el espacio de imágenes privadas (500 imágenes o 200 MiB). Retira alguna antes de añadir otra.")
  const storage = await mediaStorage()
  try {
    await upload(begun.storage_key, image.webp, storage)
    const registered = await register(owner, { assetId: begun.asset_id, sha256: image.sha256, bytes: image.bytes, width: image.width, height: image.height })
    if (registered.status === "inactive") throw accountInactive()
    if (registered.status !== "ready") throw new DomainError("PROVIDER_UNAVAILABLE", "La subida caducó antes de terminar. Vuelve a intentarlo.")
    return { assetId: begun.asset_id, storageKey: begun.storage_key }
  } catch (error) {
    await discard(owner, begun.asset_id, storage).catch(() => null)
    throw error
  }
}

/** Bytes de un asset listo y propio, solo si coinciden con su sha256 registrado; `null` en cualquier otro caso. */
export async function readImage(storageKey: string, sha256: string, storage?: AssetStorage): Promise<Buffer | null> {
  const bytes = await (storage ?? await mediaStorage()).download(storageKey)
  return bytes && sha256Hex(bytes) === sha256 ? bytes : null
}

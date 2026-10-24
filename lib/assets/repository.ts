import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm"
import type { DatabaseTransaction } from "../db/client"
import { books, coverAssets } from "../db/schema"
import { DomainError, databaseErrorCode } from "../domain-errors"
import { ASSET_QUOTAS, COVER_BUCKET, coverAssetUrl, PURGE_GRACE_SECONDS, type CoverAssetView } from "./contracts"

// Acceso a datos de los assets (U-DAT-10). Las transiciones usan las funciones `biblib.cover_asset_*`
// dentro de una transacción con los claims del dueño (`withRlsContext` o `asOwner` del ejecutor); el
// dueño sale siempre de `auth.uid()`. Los objetos se escriben con la sesión del dueño: las políticas
// de storage.objects de 0009 deciden, igual que la tabla, qué puede leer, subir o retirar.

/** Almacenamiento de objetos del bucket privado, ligado a una identidad (sesión del dueño o administración). */
export interface AssetStorage {
  /** `created` si se guardó; `exists` si ya había un objeto en esa ruta. Una denegación de RLS lanza `StorageDeniedError`. */
  upload(key: string, bytes: Buffer): Promise<"created" | "exists">
  download(key: string): Promise<Buffer | null>
  remove(keys: string[]): Promise<number>
}

/** Storage rechazó la operación por permisos: lease vencido, otro intento, cuenta bloqueada o ruta ajena. */
export class StorageDeniedError extends Error {
  constructor() { super("Storage denegó la operación.") ; this.name = "StorageDeniedError" }
}

interface StorageErrorShape { message?: string; statusCode?: string | number; status?: number }

function storageStatus(error: unknown): number {
  const shape = error as StorageErrorShape | null
  const value = Number(shape?.statusCode ?? shape?.status)
  if (Number.isFinite(value) && value > 0) return value
  const message = String(shape?.message ?? "")
  if (/duplicate|already exists/i.test(message)) return 409
  if (/row-level security|unauthorized|not allowed|forbidden/i.test(message)) return 403
  if (/not found|object not found/i.test(message)) return 404
  return 500
}

/** Adaptador de Supabase Storage. Con el cliente de la sesión, cada operación pasa por las políticas de 0009. */
export function createSupabaseAssetStorage(client: Pick<SupabaseClient, "storage">, bucket = COVER_BUCKET): AssetStorage {
  const store = () => client.storage.from(bucket)
  return {
    async upload(key, bytes) {
      const { error } = await store().upload(key, bytes, { contentType: "image/webp", upsert: false, cacheControl: "no-store" })
      if (!error) return "created"
      const status = storageStatus(error)
      if (status === 409) return "exists"
      if (status === 400 || status === 401 || status === 403) throw new StorageDeniedError()
      throw new DomainError("PROVIDER_UNAVAILABLE", "No se pudo guardar la imagen. Inténtalo de nuevo.")
    },
    async download(key) {
      const { data, error } = await store().download(key)
      if (error || !data) {
        const status = storageStatus(error)
        if (status === 400 || status === 403 || status === 404) return null
        throw new DomainError("PROVIDER_UNAVAILABLE", "No se pudo leer la imagen. Inténtalo de nuevo.")
      }
      return Buffer.from(await data.arrayBuffer())
    },
    async remove(keys) {
      if (!keys.length) return 0
      const { data, error } = await store().remove(keys)
      if (error) throw new DomainError("PROVIDER_UNAVAILABLE", "No se pudo retirar una imagen. Se reintentará en la siguiente purga.")
      return data?.length ?? 0
    },
  }
}

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

type AssetRow = typeof coverAssets.$inferSelect

export function assetView(row: AssetRow): CoverAssetView {
  return {
    id: row.id, state: row.state, sourceKind: row.sourceKind, width: row.width, height: row.height, bytes: row.bytes,
    attribution: row.attribution, createdAt: row.createdAt.toISOString(), url: row.state === "ready" ? coverAssetUrl(row.id) : null,
  }
}

async function call<T>(tx: DatabaseTransaction, query: ReturnType<typeof sql>): Promise<T> {
  const rows = await tx.execute<{ result: T }>(query)
  return rows[0]?.result as T
}

export type RequestStatus = { status: "created" | "existing"; job_id: string; asset_id: string | null }
  | { status: "conflict" | "not_found" | "stale" | "limit" | "inactive" }
  | { status: "quota"; quota: "quarantine" | "stored" }

export function requestAcquisition(tx: DatabaseTransaction, input: { bookId: string; bookVersion: string; sourceRef: string; policyVersion: string; attribution: string | null; idempotencyKey: string; digest: string }) {
  return call<RequestStatus>(tx, sql`select biblib.cover_asset_request(${input.bookId}::uuid, ${input.bookVersion}::uuid, ${input.sourceRef}, ${input.policyVersion}, ${input.attribution}, ${input.idempotencyKey}, ${input.digest}) as result`)
}

export type BeginStatus = { status: "created"; asset_id: string; upload_token: string } | { status: "inactive" } | { status: "quota"; quota: "quarantine" | "stored" }

export function beginUpload(tx: DatabaseTransaction) {
  return call<BeginStatus>(tx, sql`select biblib.cover_asset_begin_upload() as result`)
}

export async function authorizeUpload(tx: DatabaseTransaction, assetId: string, token: string): Promise<boolean> {
  return (await call<boolean>(tx, sql`select biblib.cover_asset_authorize(${assetId}::uuid, ${token}) as result`)) === true
}

export type RegisterStatus = { status: "ready" | "duplicate"; asset_id: string } | { status: "not_found" | "inactive" | "stale" | "missing_object" }

export function registerAsset(tx: DatabaseTransaction, input: { assetId: string; token: string; sha256: string; bytes: number; width: number; height: number; licenseExpiresAt: Date | null }) {
  return call<RegisterStatus>(tx, sql`select biblib.cover_asset_register(${input.assetId}::uuid, ${input.token}, ${input.sha256}, ${input.bytes}::integer, ${input.width}::integer, ${input.height}::integer, ${input.licenseExpiresAt?.toISOString() ?? null}::timestamptz) as result`)
}

export async function discardAsset(tx: DatabaseTransaction, assetId: string): Promise<boolean> {
  return (await call<boolean>(tx, sql`select biblib.cover_asset_discard(${assetId}::uuid) as result`)) === true
}

export function revalidateAsset(tx: DatabaseTransaction, assetId: string, accept: boolean) {
  return call<"ready" | "discarded" | "not_found">(tx, sql`select biblib.cover_asset_revalidate(${assetId}::uuid, ${accept}) as result`)
}

export async function readAsset(tx: DatabaseTransaction, owner: string, assetId: string): Promise<AssetRow | null> {
  const [row] = await tx.select().from(coverAssets).where(and(eq(coverAssets.id, assetId), eq(coverAssets.userId, owner))).limit(1)
  return row ?? null
}

export async function readAssetByJob(tx: DatabaseTransaction, owner: string, jobId: string): Promise<AssetRow | null> {
  const [row] = await tx.select().from(coverAssets).where(and(eq(coverAssets.jobId, jobId), eq(coverAssets.userId, owner))).limit(1)
  return row ?? null
}

/** Asset utilizable del mismo dueño con los mismos bytes: la deduplicación nunca cruza cuentas. */
export async function findDuplicate(tx: DatabaseTransaction, owner: string, sha256: string, exceptId?: string): Promise<AssetRow | null> {
  const [row] = await tx.select().from(coverAssets)
    .where(and(eq(coverAssets.userId, owner), eq(coverAssets.sha256, sha256), inArray(coverAssets.state, ["ready", "restored"]), exceptId ? ne(coverAssets.id, exceptId) : undefined)).limit(1)
  return row ?? null
}

export async function storedUsage(tx: DatabaseTransaction, owner: string) {
  const [row] = await tx.select({ stored: sql<number>`count(*)::int`, storedBytes: sql<number>`coalesce(sum(${coverAssets.bytes}), 0)::bigint` })
    .from(coverAssets).where(and(eq(coverAssets.userId, owner), ne(coverAssets.state, "quarantine")))
  return { stored: Number(row?.stored ?? 0), storedBytes: Number(row?.storedBytes ?? 0), limit: ASSET_QUOTAS.stored, limitBytes: ASSET_QUOTAS.storedBytes }
}

export type AttachOutcome = "attached" | "changed" | "unavailable"

/**
 * Adjunta un asset a la ficha si conserva la versión vista. La guarda BA001 de 0009 impide citar un
 * asset en cuarentena, sin revisar o vencido, y la FK con propietario uno ajeno.
 */
export async function attachAsset(tx: DatabaseTransaction, owner: string, input: { bookId: string; expectedVersion: string; assetId: string }): Promise<AttachOutcome> {
  try {
    const rows = await tx.update(books).set({ coverAssetId: input.assetId, updatedAt: new Date() })
      .where(and(eq(books.id, input.bookId), eq(books.userId, owner), eq(books.version, input.expectedVersion))).returning({ id: books.id })
    return rows.length ? "attached" : "changed"
  } catch (error) {
    const code = databaseErrorCode(error)
    if (code === "BA001" || code === "23503") return "unavailable"
    throw error
  }
}

export async function detachAsset(tx: DatabaseTransaction, owner: string, input: { bookId: string; expectedVersion: string }): Promise<boolean> {
  const rows = await tx.update(books).set({ coverAssetId: null, updatedAt: new Date() })
    .where(and(eq(books.id, input.bookId), eq(books.userId, owner), eq(books.version, input.expectedVersion), isNotNull(books.coverAssetId))).returning({ id: books.id })
  return rows.length > 0
}

export interface PurgeCandidates {
  assets: { id: string; owner: string; key: string | null; reason: "quarantine" | "license" | "unreferenced" }[]
  objects: { owner: string; key: string }[]
}

export interface PurgeReport { assets: number; objects: number; failedObjects: number }

/**
 * Purga acotada con una conexión de servidor (rol con acceso a las funciones de purga) y un
 * almacenamiento capaz de retirar los objetos: la sesión del dueño (`owner` fijado) o la administración
 * (script fuera del proceso Next, `owner` nulo). Primero se retiran las filas que siguen siendo
 * candidatas bajo bloqueo y después sus objetos, ya huérfanos; un objeto que no se pudo retirar
 * vuelve a salir como huérfano en la siguiente purga.
 */
export async function purgeCoverAssets(run: <T>(query: ReturnType<typeof sql>) => Promise<T>, storage: AssetStorage, input: { owner: string | null; limit?: number; graceSeconds?: number }): Promise<PurgeReport> {
  const grace = input.graceSeconds ?? PURGE_GRACE_SECONDS
  const candidates = await run<PurgeCandidates>(sql`select biblib.cover_asset_purge_candidates(${input.owner}::uuid, ${input.limit ?? 100}::integer, ${grace}::integer) as result`)
  const ids = candidates.assets.map((asset) => asset.id)
  const released = ids.length ? await run<string[]>(sql`select biblib.cover_asset_purge_confirm(${input.owner}::uuid, ${`{${ids.join(",")}}`}::uuid[], ${grace}::integer) as result`) : []
  const keys = [...new Set([...released, ...candidates.objects.map((object) => object.key)])]
  let removed = 0, failed = 0
  for (let offset = 0; offset < keys.length; offset += 100) {
    try { removed += await storage.remove(keys.slice(offset, offset + 100)) } catch { failed += Math.min(100, keys.length - offset) }
  }
  return { assets: released.length, objects: removed, failedObjects: failed }
}

import "server-only"
import postgres from "postgres"
import type { SQL } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import { readCatalogConfig } from "@/lib/bibliographic-catalog/config"
import { DomainError } from "@/lib/domain-errors"
import { JOB_LIMITS } from "@/lib/jobs/contracts"
import { workerDeps } from "@/lib/jobs/server"
import { drainJobs, type StepReport, type WorkerDeps } from "@/lib/jobs/worker"
import { createClient } from "@/lib/supabase/server"
import { ASSET_LIMITS, type ProviderCoverKey } from "@/lib/assets/contracts"
import { fetchProviderCover } from "@/lib/assets/fetch-policy"
import { fixtureCoverBytes } from "@/lib/assets/image-validation"
import { createSupabaseAssetStorage, purgeCoverAssets, type AssetStorage, type PurgeReport } from "@/lib/assets/repository"

// Cableado de servidor de las portadas privadas (U-DAT-10). El proceso Next no tiene `service_role`
// (U-OPS-04): los objetos se leen, suben y retiran con la sesión del dueño, y las políticas de
// storage.objects de 0009 son la segunda barrera tras las comprobaciones del servidor. La purga global
// la hace un script administrativo fuera de Next (`pnpm assets:purge:local`).

const shared = globalThis as typeof globalThis & { biblibAssetsSql?: postgres.Sql }

/** Storage con la sesión de la petición: cada operación pasa por las políticas por propietario. */
export async function ownerStorage(): Promise<AssetStorage> {
  return createSupabaseAssetStorage(await createClient())
}

/**
 * Descarga de la portada de un proveedor. En `fixture` no hay red: una imagen ficticia determinista
 * por clave. En `live`, la política de fetch-policy (host fijo, IP fijada, sin redirecciones).
 */
export function providerCoverFetcher(): (key: ProviderCoverKey, options: { timeoutMs: number }) => Promise<{ bytes: Buffer; contentType: string }> {
  const mode = readCatalogConfig().mode
  if (mode !== "live") return async (key) => ({ bytes: await fixtureCoverBytes(key.ref), contentType: "image/jpeg" })
  return (key, options) => fetchProviderCover(key, { limits: { timeoutMs: Math.min(options.timeoutMs, ASSET_LIMITS.downloadTimeoutMs) } })
}

/** Dependencias del ejecutor con la sesión del dueño: solo así se reclaman adquisiciones de portada. */
export function assetWorkerDeps(storage: AssetStorage): WorkerDeps {
  return { ...workerDeps(), assets: { storage, fetchCover: providerCoverFetcher() } }
}

/** Ejecuta en esta petición los pasos vencidos de la adquisición del dueño, con presupuesto acotado. */
export function runAssetJob(owner: string, jobId: string, storage: AssetStorage, budgetMs = 20_000): Promise<StepReport[]> {
  return drainJobs({ ...assetWorkerDeps(storage), limits: { ...JOB_LIMITS } }, { jobId, owner }, budgetMs)
}

function assetsSql(): postgres.Sql {
  const url = process.env.SUPABASE_DB_URL
  if (!url) throw new DomainError("PROVIDER_UNAVAILABLE", "No se ha configurado la conexión de la biblioteca.")
  shared.biblibAssetsSql ??= postgres(url, {
    max: 1, prepare: false, ssl: ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname) ? false : "require", idle_timeout: 20, connect_timeout: 5,
    connection: { application_name: "biblib-assets", statement_timeout: 10_000, lock_timeout: 5_000 },
  })
  return shared.biblibAssetsSql
}

/** Purga acotada de las cuarentenas, licencias vencidas y huérfanos del dueño, con su sesión. */
export async function purgeOwnerAssets(owner: string, storage: AssetStorage, limit = 20): Promise<PurgeReport> {
  const db = drizzle(assetsSql())
  const run = async <T,>(query: SQL): Promise<T> => (await db.execute<{ result: T }>(query))[0]?.result as T
  return purgeCoverAssets(run, storage, { owner, limit })
}

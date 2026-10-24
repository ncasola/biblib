import { coverAssetRights, coverStorageKey, licenseExpiry, parseProviderCoverKey, type ProviderCoverKey, type RightsResolver } from "../assets/contracts"
import { AssetFetchError } from "../assets/fetch-policy"
import { validateAndNormalizeImage } from "../assets/image-validation"
import { attachAsset, authorizeUpload, discardAsset, findDuplicate, readAssetByJob, registerAsset, sha256Hex, StorageDeniedError, type AssetStorage } from "../assets/repository"
import { DomainError } from "../domain-errors"
import { lockCollection } from "../import-publisher"
import { emitSafely, noopTelemetry, type TelemetryEmitter } from "../observability/emitter"
import { retryDelayMs, type JobState } from "./contracts"
import { LeaseLostError, type ClaimedJob, type FencedContext, type JobRepository } from "./repository"

// Adquisición de una copia privada de portada (U-DAT-10), como paso del ejecutor de U-DAT-03. Solo la
// ejecuta una petición con la sesión del dueño (subir exige sus credenciales de Storage). Antes de
// cualquier red se comprueban los derechos vigentes; la descarga y la validación van fuera de toda
// transacción; la subida la autoriza Storage solo para el fencing y el lease vigentes; y el registro y
// el adjunto se confirman en una transacción cercada que comprueba la versión de la ficha.

export interface AssetWorkerHooks {
  /** Tras subir y antes de registrar: las pruebas simulan aquí la caída del trabajador. */
  afterUpload?(job: ClaimedJob, key: string): Promise<void> | void
  beforeRegister?(job: ClaimedJob): Promise<void> | void
}

export interface AssetWorkerDeps {
  /** Storage con la sesión del dueño de la fila reclamada. */
  storage: AssetStorage
  /** Descarga de la portada: red con la política de fetch-policy en `live`, bytes ficticios en `fixture`. */
  fetchCover(key: ProviderCoverKey, options: { timeoutMs: number }): Promise<{ bytes: Buffer; contentType: string }>
  /** Derechos vigentes; sin él se usa la política publicada de U-BIB-04. */
  rights?: RightsResolver
  validate?: typeof validateAndNormalizeImage
  hooks?: AssetWorkerHooks
}

export interface AssetStepDeps {
  repo: JobRepository
  assets?: AssetWorkerDeps
  telemetry?: TelemetryEmitter
  random: () => number
  now: () => number
}

export interface AssetStepLimits { leaseMs: number; renewMarginMs: number; fetchTimeoutMs: number; maxItemAttempts: number }

/** Resultado durable de la adquisición: IDs técnicos y códigos, nunca la URL de origen ni bytes. */
export interface CoverAssetJobResult extends Record<string, unknown> {
  assetId: string | null
  attached: boolean
  deduplicated: boolean
  reason?: string
}

type StepState = { state: JobState; errorCode?: string | null }

async function close(deps: AssetStepDeps, job: ClaimedJob, input: { state: JobState; errorCode?: string | null; result?: CoverAssetJobResult; discard?: string | null; delayMs?: number; keepAttempts?: boolean }): Promise<StepState> {
  await deps.repo.fenced(job, async (context) => {
    if (input.discard) await context.asOwner((tx) => discardAsset(tx, input.discard!))
    await context.finish({ state: input.state, phase: input.state === "waiting_retry" ? "asset" : "done", errorCode: input.errorCode ?? null, result: input.result, delayMs: input.delayMs, keepAttempts: input.keepAttempts })
  })
  return { state: input.state, errorCode: input.errorCode ?? null }
}

/** Adjunta dentro de la transacción cercada: solo si la ficha conserva la versión vista al pedirla. */
async function attachIntent(context: FencedContext, asset: { attachBookId: string | null; attachBookVersion: string | null }, assetId: string): Promise<boolean> {
  if (!asset.attachBookId || !asset.attachBookVersion) return false
  return context.asOwner(async (tx) => {
    await lockCollection(tx)
    return (await attachAsset(tx, context.owner, { bookId: asset.attachBookId!, expectedVersion: asset.attachBookVersion!, assetId })) === "attached"
  })
}

export async function coverAssetStep(deps: AssetStepDeps, job: ClaimedJob, limits: AssetStepLimits): Promise<StepState> {
  const telemetry = deps.telemetry ?? noopTelemetry
  // Sin sesión del dueño no hay credenciales de Storage: se devuelve a la cola sin consumir intentos.
  if (!deps.assets) return close(deps, job, { state: "waiting_retry", errorCode: "SESSION_REQUIRED", delayMs: 60_000, keepAttempts: false })
  const assets = deps.assets

  // 1. Derechos vigentes antes de cualquier red; un trabajo antiguo o una fila manipulada no los saltan.
  const prepared = await deps.repo.fenced(job, async (context) => {
    const asset = await context.asOwner((tx) => readAssetByJob(tx, context.owner, job.id))
    if (!asset || asset.state !== "quarantine") return { kind: "missing" as const }
    const key = parseProviderCoverKey(asset.sourceRef)
    if (!key || !coverAssetRights(key.provider, assets.rights).rehost) {
      await context.asOwner((tx) => discardAsset(tx, asset.id))
      await context.finish({ state: "failed", phase: "done", errorCode: "RIGHTS_DENIED", result: { assetId: null, attached: false, deduplicated: false, reason: "RIGHTS_DENIED" } satisfies CoverAssetJobResult })
      return { kind: "denied" as const }
    }
    // El único intento que Storage aceptará es el de este fencing, mientras dure el lease.
    if (!(await context.asOwner((tx) => authorizeUpload(tx, asset.id, job.fencing)))) return { kind: "missing" as const }
    return { kind: "ready" as const, asset, key }
  })
  if (prepared.kind === "denied") {
    emitSafely(telemetry, "job.failed", { operation: "job.cover_asset.asset", result: "skipped", errorCode: "RIGHTS_DENIED" })
    return { state: "failed", errorCode: "RIGHTS_DENIED" }
  }
  if (prepared.kind === "missing") return close(deps, job, { state: "failed", errorCode: "NOT_FOUND", result: { assetId: null, attached: false, deduplicated: false, reason: "NOT_FOUND" } })
  const { asset, key } = prepared
  const policy = coverAssetRights(key.provider, assets.rights).policy

  // 2. Descarga y validación fuera de transacciones, con plazo.
  let normalized: Awaited<ReturnType<typeof validateAndNormalizeImage>>
  try {
    const downloaded = await assets.fetchCover(key, { timeoutMs: limits.fetchTimeoutMs })
    normalized = await (assets.validate ?? validateAndNormalizeImage)(downloaded.bytes)
  } catch (error) {
    if (error instanceof AssetFetchError && error.retryable) {
      if (job.attempts >= limits.maxItemAttempts) return close(deps, job, { state: "failed", errorCode: "PROVIDER_UNAVAILABLE", discard: asset.id, result: { assetId: null, attached: false, deduplicated: false, reason: error.code } })
      emitSafely(telemetry, "job.retried", { operation: "job.cover_asset.asset", result: "error", errorCode: error.code, attempt: job.attempts })
      return close(deps, job, { state: "waiting_retry", errorCode: error.code, keepAttempts: true, delayMs: retryDelayMs(job.attempts, deps.random) })
    }
    const reason = error instanceof DomainError && "reason" in error ? String(error.reason) : error instanceof AssetFetchError ? error.code : "DECODE_FAILED"
    emitSafely(telemetry, "job.failed", { operation: "job.cover_asset.asset", result: "error", errorCode: "ASSET_REJECTED" })
    return close(deps, job, { state: "failed", errorCode: error instanceof AssetFetchError ? error.code : "ASSET_REJECTED", discard: asset.id, result: { assetId: null, attached: false, deduplicated: false, reason } })
  }

  // 3. La misma imagen del mismo dueño ya existe: no se sube otra copia.
  const duplicate = await deps.repo.fenced(job, (context) => context.asOwner((tx) => findDuplicate(tx, context.owner, normalized.sha256, asset.id)))
  if (duplicate) {
    let attached = false
    await deps.repo.fenced(job, async (context) => {
      await context.asOwner((tx) => discardAsset(tx, asset.id))
      attached = await attachIntent(context, asset, duplicate.id)
      await context.finish({ state: "succeeded", phase: "done", errorCode: attached || !asset.attachBookId ? null : "CHANGED", result: { assetId: duplicate.id, attached, deduplicated: true } satisfies CoverAssetJobResult })
    })
    return { state: "succeeded", errorCode: attached || !asset.attachBookId ? null : "CHANGED" }
  }

  // 4. Subida con la sesión del dueño: Storage solo la admite para este fencing con el lease vigente.
  if (!(await deps.repo.renew(job, limits.leaseMs))) throw new LeaseLostError("lease")
  const objectKey = coverStorageKey(job.userId, asset.id, job.fencing)
  try {
    let stored = await assets.storage.upload(objectKey, normalized.webp)
    if (stored === "exists") {
      // Repetición tras una caída entre subir y registrar: solo vale si son exactamente los mismos bytes.
      const existing = await assets.storage.download(objectKey)
      if (!existing || sha256Hex(existing) !== normalized.sha256) {
        await assets.storage.remove([objectKey])
        stored = await assets.storage.upload(objectKey, normalized.webp)
        if (stored !== "created") throw new DomainError("PROVIDER_UNAVAILABLE", "No se pudo guardar la imagen.")
      }
    }
  } catch (error) {
    if (error instanceof StorageDeniedError) throw new LeaseLostError("lease")
    throw error
  }
  emitSafely(telemetry, "storage.upload", { operation: "cover_asset.upload", result: "ok" })
  await assets.hooks?.afterUpload?.(job, objectKey)

  // 5. Registro y adjunto en una transacción cercada. Un trabajador antiguo no llega aquí.
  await assets.hooks?.beforeRegister?.(job)
  const outcome = await deps.repo.fenced(job, async (context) => {
    const registered = await context.asOwner((tx) => registerAsset(tx, { assetId: asset.id, token: job.fencing, sha256: normalized.sha256, bytes: normalized.bytes, width: normalized.width, height: normalized.height, licenseExpiresAt: licenseExpiry(policy, new Date(deps.now())) }))
    if (registered.status !== "ready" && registered.status !== "duplicate") {
      await context.finish({ state: "failed", phase: "done", errorCode: "ASSET_REJECTED", result: { assetId: null, attached: false, deduplicated: false, reason: registered.status } satisfies CoverAssetJobResult })
      return { state: "failed" as JobState, errorCode: "ASSET_REJECTED", orphan: true }
    }
    const attached = await attachIntent(context, asset, registered.asset_id)
    const errorCode = attached || !asset.attachBookId ? null : "CHANGED"
    await context.finish({ state: "succeeded", phase: "done", errorCode, result: { assetId: registered.asset_id, attached, deduplicated: registered.status === "duplicate" } satisfies CoverAssetJobResult })
    return { state: "succeeded" as JobState, errorCode, orphan: registered.status === "duplicate" }
  })
  // Un objeto que no quedó registrado es huérfano: se retira ya o en la siguiente purga.
  if (outcome.orphan) await assets.storage.remove([objectKey]).catch(() => 0)
  return { state: outcome.state, errorCode: outcome.errorCode }
}

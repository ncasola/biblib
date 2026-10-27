import "server-only"
import { createHmac } from "node:crypto"
import { after } from "next/server"
import postgres from "postgres"
import { and, desc, eq, sql } from "drizzle-orm"
import { readCatalogConfig } from "@/lib/bibliographic-catalog/config"
import { createCatalogGateway, createPostgresCoordinationStore, type CatalogGateway, type CoordinationStore } from "@/lib/bibliographic-catalog/gateway"
import { createConfiguredCatalog } from "@/lib/bibliographic-catalog/registry"
import { withRlsContext } from "@/lib/db/client"
import { importPreviews, libraryJobs } from "@/lib/db/schema"
import { DomainError, idempotencyConflict, jobConflict, jobExpired, previewExpired, revisionConflict, type DomainErrorCode } from "@/lib/domain-errors"
import { confirmationDigest } from "@/lib/import-publisher"
import { snapshotCaptureBlocked } from "@/lib/library-snapshots"
import { telemetry } from "@/lib/observability/server"
import { JOB_LIMITS, isTerminal, type ControlResult, type JobControl, type LibraryJobView } from "@/lib/jobs/contracts"
import { createJobDatabase, createJobRepository, jobView, type JobRepository } from "@/lib/jobs/repository"
import { drainJobs, type WorkerDeps } from "@/lib/jobs/worker"

// Cableado de servidor de los trabajos (U-DAT-03): conexión propia del ejecutor, servicio
// bibliográfico en modo lote, altas y control con el dueño de la sesión y ejecución en segundo plano
// con `after()` del propio servidor Next. El scheduler de despliegue (F4) usa la entrada interna.

const shared = globalThis as typeof globalThis & { biblibJobsSql?: postgres.Sql; biblibCatalogueSql?: postgres.Sql; biblibJobsDeps?: WorkerDeps; biblibJobsDraining?: Set<string> }

function databaseUrl(): string {
  const url = process.env.SUPABASE_DB_URL
  if (!url) throw new DomainError("PROVIDER_UNAVAILABLE", "No se ha configurado la conexión de la biblioteca.")
  return url
}

const ssl = (url: string) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname) ? false : "require" as const

/** Conexión del ejecutor, separada de la de las acciones y con plazos acotados. */
function jobRepository(): JobRepository {
  const url = databaseUrl()
  shared.biblibJobsSql ??= postgres(url, {
    max: 2, prepare: false, ssl: ssl(url), idle_timeout: 20, connect_timeout: 5,
    connection: { application_name: "biblib-jobs", statement_timeout: 30_000, lock_timeout: 10_000 },
  })
  return createJobRepository(createJobDatabase(shared.biblibJobsSql))
}

/**
 * Servicio bibliográfico de los trabajos: mismo orquestador U-BIB, pero cada consulta pasa por el
 * gateway U-DAT-05 con propósito `batch` (toma una plaza libre o devuelve `rateLimited`, sin hacer
 * cola por delante de las búsquedas interactivas). En `fixture` no hay red.
 */
function batchCatalog() {
  const config = readCatalogConfig()
  if (config.mode !== "live") return createConfiguredCatalog(config, { telemetry })
  const url = process.env.SUPABASE_DB_URL
  const unavailable = () => Promise.reject(new Error("La coordinación del catálogo no está configurada."))
  let store: CoordinationStore = { begin: unavailable, complete: unavailable, reserve: unavailable, release: unavailable, privateGet: unavailable, privatePut: unavailable, invalidate: unavailable }
  if (url) {
    // Misma conexión de coordinación que lib/bibliographic-catalog/server.ts.
    shared.biblibCatalogueSql ??= postgres(url, {
      max: 2, prepare: false, ssl: ssl(url), idle_timeout: 20, connect_timeout: 5,
      connection: { application_name: "biblib-catalogue", statement_timeout: 3000, lock_timeout: 2000 },
    })
    store = createPostgresCoordinationStore(shared.biblibCatalogueSql)
  }
  const secret = process.env.BIBLIB_CATALOGUE_CACHE_SECRET
  const gateway = createCatalogGateway({ store, telemetry, privateKeySecret: secret && secret.length >= 32 ? secret : undefined })
  const batch: CatalogGateway = { ...gateway, execute: (request, fetcher, context) => gateway.execute({ ...request, purpose: "batch" }, fetcher, context) }
  return createConfiguredCatalog(config, { telemetry, fetch: gateway.fetch, gateway: batch })
}

export function workerDeps(): WorkerDeps {
  shared.biblibJobsDeps ??= { repo: jobRepository(), catalog: batchCatalog(), telemetry, reviewEnabled: () => { try { return readCatalogConfig().reviewEnabled } catch { return false } } }
  return shared.biblibJobsDeps
}

/**
 * Presupuesto de un disparo con `after()`: un paso que empieza justo antes del final puede tardar
 * otros 20 s en confirmar, y todo cabe en el `maxDuration` de 60 s de Ajustes (app/settings/layout.tsx).
 */
const DRAIN_BUDGET_MS = 30_000

/**
 * Ejecuta en segundo plano, tras responder, los pasos vencidos del trabajo del dueño. Si el proceso
 * se detiene, el lease caduca y otro disparo (consulta, ejecutor interno o runner) lo continúa.
 */
export function scheduleDrain(owner: string, jobId: string): void {
  const draining = shared.biblibJobsDraining ??= new Set<string>()
  if (draining.has(jobId)) return
  draining.add(jobId)
  try {
    after(async () => {
      try { await drainJobs(workerDeps(), { jobId, owner }, DRAIN_BUDGET_MS) }
      catch { /* El estado confirmado se conserva; el siguiente disparo lo reintenta. */ }
      finally { draining.delete(jobId) }
    })
  } catch {
    draining.delete(jobId)
  }
}

type CreateStatus = "created" | "existing" | "conflict" | "busy" | "limit" | "inactive" | "not_found"

async function createJob(owner: string, input: { kind: "import" | "covers"; idempotencyKey: string; digest: string; previewId?: string; expectedRevision?: string }): Promise<{ id: string; status: CreateStatus }> {
  const rows = await withRlsContext(owner, (tx) => tx.execute<{ result: { status: CreateStatus; id?: string } }>(
    sql`select biblib.library_job_create(${input.kind}, ${input.idempotencyKey}, ${input.digest}, ${input.previewId ?? null}::uuid, ${input.expectedRevision ?? null}::uuid) as result`))
  const result = rows[0]?.result
  if (!result) throw new DomainError("PROVIDER_UNAVAILABLE", "No se pudo crear el trabajo. Inténtalo de nuevo.")
  if (result.status === "conflict") throw idempotencyConflict()
  if (result.status === "not_found") throw new DomainError("NOT_FOUND", "La revisión de la importación no está disponible. Prepárala de nuevo.")
  if (result.status === "inactive") throw new DomainError("UNAUTHORIZED", "Tu cuenta no admite operaciones nuevas en este momento.")
  if (result.status === "limit") throw jobConflict("Ya tienes varios trabajos en curso. Espera a que terminen o cancela alguno antes de iniciar otro.")
  if (result.status === "busy") throw jobConflict("Ya hay una búsqueda de portadas en curso. Puedes seguirla, pausarla o cancelarla desde Ajustes.")
  return { id: result.id!, status: result.status }
}

/** Trabajo de importación de una vista previa del dueño. La clave se limita a archivo, modo y reglas. */
export async function startImportJob(owner: string, input: { previewId: string; expectedRevision?: string; idempotencyKey: string }): Promise<{ id: string; created: boolean }> {
  const [preview] = await withRlsContext(owner, (tx) => tx.select({ revision: importPreviews.revision, inputDigest: importPreviews.inputDigest, mode: importPreviews.mode, rulesVersion: importPreviews.rulesVersion })
    .from(importPreviews).where(and(eq(importPreviews.id, input.previewId), eq(importPreviews.userId, owner))).limit(1))
  if (!preview) {
    // Una vista previa purgada todavía permite recuperar el trabajo ya creado con la misma clave.
    const [existing] = await withRlsContext(owner, (tx) => tx.select({ id: libraryJobs.id, previewId: libraryJobs.previewId }).from(libraryJobs)
      .where(and(eq(libraryJobs.userId, owner), eq(libraryJobs.kind, "import"), eq(libraryJobs.idempotencyKey, input.idempotencyKey))).limit(1))
    if (existing && existing.previewId === input.previewId) return { id: existing.id, created: false }
    if (existing) throw idempotencyConflict()
    throw new DomainError("NOT_FOUND", "La revisión de la importación no está disponible. Prepárala de nuevo.")
  }
  const created = await createJob(owner, { kind: "import", idempotencyKey: input.idempotencyKey, digest: confirmationDigest(preview), previewId: input.previewId, expectedRevision: input.expectedRevision ?? preview.revision })
  return { id: created.id, created: created.status === "created" }
}

const COVERS_DIGEST = createHmac("sha256", "biblib.jobs").update(JSON.stringify({ kind: "covers", scope: "missing", contract: 1 })).digest("hex")

export async function startCoverJob(owner: string, idempotencyKey: string): Promise<{ id: string; created: boolean }> {
  const created = await createJob(owner, { kind: "covers", idempotencyKey, digest: COVERS_DIGEST })
  return { id: created.id, created: created.status === "created" }
}

export async function readJob(owner: string, jobId: string): Promise<LibraryJobView> {
  const [row] = await withRlsContext(owner, (tx) => tx.select().from(libraryJobs).where(and(eq(libraryJobs.id, jobId), eq(libraryJobs.userId, owner))).limit(1))
  // Un trabajo ajeno o inexistente responde igual: no se confirma su existencia.
  if (!row) throw new DomainError("NOT_FOUND", "No se encontró el trabajo.")
  return jobView(row)
}

/** Trabajos activos y los últimos terminados del dueño, para retomarlos tras recargar o cerrar. */
export async function listJobs(owner: string, limit = 10): Promise<LibraryJobView[]> {
  const rows = await withRlsContext(owner, (tx) => tx.select().from(libraryJobs).where(eq(libraryJobs.userId, owner))
    .orderBy(desc(libraryJobs.createdAt), desc(libraryJobs.id)).limit(Math.min(Math.max(limit, 1), 20)))
  return rows.map((row) => jobView(row))
}

export async function controlJob(owner: string, jobId: string, expectedVersion: string, action: JobControl): Promise<ControlResult> {
  const rows = await withRlsContext(owner, (tx) => tx.execute<{ result: { status: "ok" | "not_found" | "conflict" | "expired"; published?: boolean } }>(
    sql`select biblib.library_job_control(${jobId}::uuid, ${expectedVersion}::uuid, ${action}) as result`))
  const result = rows[0]?.result
  if (!result || result.status === "not_found") throw new DomainError("NOT_FOUND", "No se encontró el trabajo.")
  if (result.status === "expired") throw jobExpired()
  if (result.status === "conflict") throw jobConflict()
  const job = await readJob(owner, jobId)
  return { job, publication: job.kind !== "import" || action !== "cancel" ? "none" : result.published ? "after" : "before" }
}

const FAILURE_MESSAGES: Partial<Record<DomainErrorCode, () => DomainError>> = {
  REVISION_CONFLICT: revisionConflict,
  PREVIEW_EXPIRED: previewExpired,
  IDEMPOTENCY_CONFLICT: idempotencyConflict,
  JOB_EXPIRED: jobExpired,
  // U-DAT-02: un reemplazo bloqueado por la cuota o el tamaño de las versiones anteriores.
  LIMIT_EXCEEDED: snapshotCaptureBlocked,
}

/** Traduce el final no satisfactorio de una publicación al error de dominio que verá la persona. */
export function publicationFailure(view: LibraryJobView): DomainError {
  if (view.state === "needs_review") return revisionConflict()
  if (view.errorCode === "ACCOUNT_INACTIVE") return new DomainError("UNAUTHORIZED", "Tu cuenta no admite operaciones nuevas en este momento.")
  const code = (view.errorCode ?? "PROVIDER_UNAVAILABLE") as DomainErrorCode
  if (view.state === "cancelled") return jobConflict("La importación se canceló antes de publicarse. No se ha aplicado nada.")
  if (code === "CONFLICT") return new DomainError("CONFLICT", "Esta revisión ya se confirmó. Prepara una nueva si quieres volver a importar el archivo.")
  if (code === "NOT_FOUND") return new DomainError("NOT_FOUND", "La revisión de la importación no está disponible. Prepárala de nuevo.")
  return FAILURE_MESSAGES[code]?.() ?? new DomainError("PROVIDER_UNAVAILABLE", "La importación no se pudo publicar todavía. Su estado se conserva y se reintentará.")
}

/**
 * Publica en línea una importación encolada: reclama el trabajo del dueño y ejecuta su paso de
 * publicación. Si otro trabajador lo tiene, espera su resultado confirmado durante un tiempo acotado.
 */
export async function publishInline(owner: string, jobId: string, waitMs = 15_000): Promise<LibraryJobView> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const view = await readJob(owner, jobId)
    if (view.published || view.phase !== "publish" || isTerminal(view.state) || view.state === "needs_review" || view.state === "paused") return view
    if (view.state === "waiting_retry" || Date.now() >= deadline) return view
    const steps = await drainJobs({ ...workerDeps(), limits: { ...JOB_LIMITS } }, { jobId, owner }, 1)
    if (!steps.length) await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

export { isRunnerAuthorized, runnerToken } from "@/lib/jobs/runner-auth"

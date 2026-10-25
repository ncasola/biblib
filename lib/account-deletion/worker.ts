import type postgres from "postgres"

// U-OPS-03 · Worker administrativo de eliminación de cuentas. Se ejecuta fuera de Next (scripts/account/), con la
// conexión administrativa y la credencial de servicio del entorno, que el proceso Next nunca recibe. Cada paso
// es reintentable e idempotente: solo borra, bajo el lease y el fencing de `biblib.account_deletions` (0013), y avanza
// cuando la base confirma que el paso está vacío. Storage pendiente o un fallo dejan el error visible y reintentable;
// nunca se afirma que terminó con objetos o filas restantes. Solo usa `import type` y sintaxis borrable, para que
// Node lo cargue tal cual desde los scripts .mjs.

/** Pasos en orden: primero las sesiones y los objetos, después las filas (hijas antes que padres) y al final Auth. */
export const DELETION_STEPS = ["sessions", "storage", "covers", "snapshots", "staging", "jobs", "views", "previews", "operations", "private_cache", "product", "media", "copies", "editions", "works", "shelves", "state", "auth", "verify"] as const
export type DeletionStep = (typeof DELETION_STEPS)[number]
export type DatabaseStep = Exclude<DeletionStep, "sessions" | "storage" | "auth" | "verify">

export interface InventoryEntry {
  /** Tabla de `biblib`, bucket de Storage o sistema externo. */
  name: string
  kind: "table" | "storage" | "auth"
  step: DeletionStep
  /** Qué contiene, en términos de retención (docs/retencion.md). */
  contents: string
}

/**
 * Inventario de limpieza. Toda tabla de `biblib` con dueño debe estar aquí y en `account_deletion_step_tables`
 * (0013, ampliada en 0014); la prueba SQL y tests/account-deletion.test.ts fallan si una tabla nueva queda fuera. Lectura
 * y préstamos (O14) se añadirán con su migración.
 */
export const ACCOUNT_DATA_INVENTORY: readonly InventoryEntry[] = [
  { name: "auth.sessions", kind: "auth", step: "sessions", contents: "Sesiones y refresh tokens de GoTrue: se cierran al solicitar y la cuenta se bloquea para nuevos inicios de sesión." },
  { name: "biblib-covers", kind: "storage", step: "storage", contents: "Imágenes de portadas privadas (`<dueño>/<asset>/<intento>.webp`)." },
  { name: "biblib-media", kind: "storage", step: "storage", contents: "Avatar propio, fotos de ubicaciones y fotos fuente de evidencias (`<dueño>/<tipo>/<asset>`)." },
  { name: "storage.objects", kind: "storage", step: "storage", contents: "Cualquier otro objeto con prefijo o propietario de la cuenta, en cualquier bucket." },
  { name: "cover_assets", kind: "table", step: "covers", contents: "Metadatos de portadas privadas (clave, hash, tamaño, origen); antes se sueltan de sus ediciones." },
  { name: "library_snapshot_chunks", kind: "table", step: "snapshots", contents: "Trozos de versiones anteriores de la colección." },
  { name: "library_snapshots", kind: "table", step: "snapshots", contents: "Cabeceras de versiones anteriores." },
  { name: "import_session_rows", kind: "table", step: "staging", contents: "Filas validadas de restauraciones por partes." },
  { name: "import_session_chunks", kind: "table", step: "staging", contents: "Bytes de las partes recibidas." },
  { name: "import_session_parts", kind: "table", step: "staging", contents: "Partes esperadas de una restauración." },
  { name: "import_sessions", kind: "table", step: "staging", contents: "Sesiones de restauración por partes." },
  { name: "library_job_items", kind: "table", step: "jobs", contents: "Elementos de trabajos (portadas, importación)." },
  { name: "library_jobs", kind: "table", step: "jobs", contents: "Trabajos persistentes y sus resultados." },
  { name: "saved_book_views", kind: "table", step: "views", contents: "Vistas guardadas (nombre y filtros)." },
  { name: "import_previews", kind: "table", step: "previews", contents: "Vistas previas de importación con el archivo leído." },
  { name: "library_operations", kind: "table", step: "operations", contents: "Resultados idempotentes de operaciones confirmadas." },
  { name: "catalogue_private_cache", kind: "table", step: "private_cache", contents: "Caché privada de búsquedas por título o autor (consulta reducida a HMAC)." },
  { name: "catalogue_quota_reservations", kind: "table", step: "private_cache", contents: "Reservas de cuota de proveedores a nombre de la cuenta." },
  { name: "review_decisions", kind: "table", step: "product", contents: "Decisiones de revisión bibliográfica (campos elegidos y evidencias citadas)." },
  { name: "review_issues", kind: "table", step: "product", contents: "Incidencias de revisión (motivo, IDs de las entidades y estado)." },
  { name: "bibliographic_evidence", kind: "table", step: "product", contents: "Evidencias bibliográficas de ediciones y ejemplares (fuente, afirmaciones, confianza, foto citada)." },
  { name: "copy_tags", kind: "table", step: "product", contents: "Etiquetas de cada ejemplar." },
  { name: "copy_annotations", kind: "table", step: "product", contents: "Notas privadas y valoración de cada ejemplar." },
  { name: "copy_locations", kind: "table", step: "product", contents: "Ubicación física actual de cada ejemplar." },
  { name: "series_editions", kind: "table", step: "product", contents: "Ediciones en series con su posición." },
  { name: "tags", kind: "table", step: "product", contents: "Etiquetas de la cuenta." },
  { name: "locations", kind: "table", step: "product", contents: "Árbol de ubicaciones físicas (se retira de las hojas a la raíz)." },
  { name: "series", kind: "table", step: "product", contents: "Series privadas." },
  { name: "csv_mapping_profiles", kind: "table", step: "product", contents: "Perfiles de mapeo CSV guardados (sin muestras de filas)." },
  { name: "profiles", kind: "table", step: "product", contents: "Perfil privado: referencia al avatar propio." },
  { name: "media_assets", kind: "table", step: "media", contents: "Metadatos de imágenes privadas (ruta, hash, tamaño), tras retirar quien las cita." },
  { name: "copies", kind: "table", step: "copies", contents: "Ejemplares: estado, estantería, comprobación física e identificador legacy." },
  { name: "editions", kind: "table", step: "editions", contents: "Ediciones: descripción bibliográfica, ISBN-13 y portada (las huérfanas ya las poda la cascada)." },
  { name: "works", kind: "table", step: "works", contents: "Obras." },
  { name: "shelves", kind: "table", step: "shelves", contents: "Estanterías, incluida la predeterminada." },
  { name: "library_state", kind: "table", step: "state", contents: "Revisión de la colección." },
  { name: "model_migration_report", kind: "table", step: "state", contents: "Informe del backfill obra/edición/ejemplar." },
  { name: "books_legacy", kind: "table", step: "state", contents: "Copia congelada de la ficha plana anterior a 0011." },
  { name: "account_lifecycle", kind: "table", step: "auth", contents: "Estado `deleting` que bloquea las escrituras; lo retira la cascada al borrar la identidad." },
  { name: "auth.users", kind: "auth", step: "auth", contents: "Identidad, identidades vinculadas, factores y sesiones de GoTrue (borrado por la API admin)." },
]

/** Plazo de la marca técnica de supresión tras terminar (más que la copia administrativa más antigua, docs/retencion.md). */
export const MARK_RETENTION_DAYS = 90

export const DELETION_LIMITS = Object.freeze({
  leaseMs: 120_000,
  batchRows: 500,
  storageBatch: 100,
  maxAttempts: 5,
  retryBaseMs: 30_000,
  retryMaxMs: 3_600_000,
})
export type DeletionLimits = { -readonly [K in keyof typeof DELETION_LIMITS]: number }

export type DeletionErrorCode = "SESSIONS_UNAVAILABLE" | "STORAGE_UNAVAILABLE" | "STORAGE_PENDING" | "DATABASE_UNAVAILABLE" | "STEP_INCOMPLETE" | "AUTH_UNAVAILABLE" | "RESIDUE_FOUND" | "UNEXPECTED"

export interface ClaimedDeletion { userId: string; step: DeletionStep; token: string; fence: number; attempts: number }
export interface StorageObjectRef { bucket: string; name: string }

export interface DeletionDatabase {
  claim(owner: string | null, leaseMs: number): Promise<ClaimedDeletion | null>
  renew(owner: string, token: string, leaseMs: number): Promise<boolean>
  purge(owner: string, token: string, step: DatabaseStep, limit: number): Promise<number>
  objects(owner: string, limit: number): Promise<StorageObjectRef[]>
  advance(owner: string, token: string, step: DeletionStep, counts: Record<string, number>, leaseMs: number): Promise<DeletionStep>
  fail(owner: string, token: string, code: DeletionErrorCode, retryMs: number, maxAttempts: number): Promise<"waiting_retry" | "failed" | "lease_lost">
  complete(owner: string, token: string, markDays: number): Promise<void>
}

/** Storage con la credencial administrativa: retira objetos; lanza si el servicio no responde. */
export interface DeletionStorage { remove(bucket: string, names: string[]): Promise<void> }

/** GoTrue admin: bloquea nuevos inicios de sesión y refrescos, y borra la identidad al final. */
export interface DeletionAuth {
  revokeSessions(owner: string): Promise<void>
  deleteIdentity(owner: string): Promise<void>
}

export interface DeletionDeps {
  db: DeletionDatabase
  storage: DeletionStorage
  auth: DeletionAuth
  limits?: Partial<DeletionLimits>
  /** Solo para pruebas: punto de interrupción antes de cada paso. */
  hooks?: { beforeStep?: (step: DeletionStep, claimed: ClaimedDeletion) => Promise<void> | void }
}

export type DeletionOutcome = "completed" | "waiting_retry" | "failed" | "lease_lost"

export interface DeletionReport {
  outcome: DeletionOutcome
  /** Paso en el que terminó o falló. */
  step: DeletionStep | "done"
  errorCode?: DeletionErrorCode
  counts: Record<string, number>
}

/** El testigo ya no es de este worker (venció o lo reclamó otro): se detiene sin tocar nada más. */
export class LeaseLostError extends Error {
  constructor() {
    super("El worker de eliminación perdió su lease.")
    this.name = "LeaseLostError"
  }
}

/** Fallo de un paso con su código técnico; el worker lo registra y la eliminación se reintenta. */
export class DeletionStepError extends Error {
  readonly code: DeletionErrorCode
  constructor(code: DeletionErrorCode, message: string) {
    super(message)
    this.name = "DeletionStepError"
    this.code = code
  }
}

const isDatabaseStep = (step: DeletionStep): step is DatabaseStep => !["sessions", "storage", "auth", "verify"].includes(step)

async function removeObjects(deps: DeletionDeps, claimed: ClaimedDeletion, limits: DeletionLimits): Promise<Record<string, number>> {
  let removed = 0
  let previous = ""
  for (;;) {
    const objects = await deps.db.objects(claimed.userId, limits.storageBatch)
    if (!objects.length) return { objects: removed }
    // El mismo lote tras retirarlo: Storage aceptó la petición pero los objetos siguen. Pendiente, no terminado.
    const batch = objects.map((object) => `${object.bucket}/${object.name}`).join("\n")
    if (batch === previous) throw new DeletionStepError("STORAGE_PENDING", "Storage conserva objetos de la cuenta tras retirarlos.")
    previous = batch
    const buckets = new Map<string, string[]>()
    for (const object of objects) buckets.set(object.bucket, [...(buckets.get(object.bucket) ?? []), object.name])
    for (const [bucket, names] of buckets) {
      try { await deps.storage.remove(bucket, names) } catch {
        throw new DeletionStepError("STORAGE_UNAVAILABLE", "Storage no retiró los objetos de la cuenta.")
      }
    }
    removed += objects.length
    if (!await deps.db.renew(claimed.userId, claimed.token, limits.leaseMs)) throw new LeaseLostError()
  }
}

async function runStep(deps: DeletionDeps, claimed: ClaimedDeletion, step: DeletionStep, limits: DeletionLimits): Promise<Record<string, number>> {
  if (step === "sessions") {
    try { await deps.auth.revokeSessions(claimed.userId) } catch {
      throw new DeletionStepError("SESSIONS_UNAVAILABLE", "GoTrue no bloqueó las sesiones de la cuenta.")
    }
    return { sessions: 1 }
  }
  if (step === "storage") return removeObjects(deps, claimed, limits)
  if (step === "auth") {
    try { await deps.auth.deleteIdentity(claimed.userId) } catch {
      throw new DeletionStepError("AUTH_UNAVAILABLE", "GoTrue no borró la identidad de la cuenta.")
    }
    return { identity: 1 }
  }
  if (!isDatabaseStep(step)) return {}
  let total = 0
  for (;;) {
    const removed = await deps.db.purge(claimed.userId, claimed.token, step, limits.batchRows)
    if (removed === 0) return { [step]: total }
    total += removed
  }
}

/** Ejecuta, desde su paso pendiente, una eliminación ya reclamada. */
export async function processDeletion(deps: DeletionDeps, claimed: ClaimedDeletion): Promise<DeletionReport> {
  const limits: DeletionLimits = { ...DELETION_LIMITS, ...deps.limits }
  const counts: Record<string, number> = {}
  let step: DeletionStep = claimed.step
  try {
    for (;;) {
      await deps.hooks?.beforeStep?.(step, claimed)
      if (step === "verify") {
        await deps.db.complete(claimed.userId, claimed.token, MARK_RETENTION_DAYS)
        return { outcome: "completed", step: "done", counts }
      }
      const done = await runStep(deps, claimed, step, limits)
      Object.assign(counts, done)
      step = await deps.db.advance(claimed.userId, claimed.token, step, done, limits.leaseMs)
    }
  } catch (error) {
    if (error instanceof LeaseLostError) return { outcome: "lease_lost", step, counts }
    const code: DeletionErrorCode = error instanceof DeletionStepError ? error.code : "UNEXPECTED"
    const retryMs = Math.min(limits.retryMaxMs, limits.retryBaseMs * 2 ** Math.max(0, claimed.attempts - 1))
    try {
      const outcome = await deps.db.fail(claimed.userId, claimed.token, code, retryMs, limits.maxAttempts)
      return { outcome, step, errorCode: code, counts }
    } catch (failure) {
      if (failure instanceof LeaseLostError) return { outcome: "lease_lost", step, errorCode: code, counts }
      throw failure
    }
  }
}

/** Reclama y procesa eliminaciones vencidas (o la de `owner`) hasta agotar el presupuesto. */
export async function drainDeletions(deps: DeletionDeps, { owner = null, budgetMs = 60_000, now = Date.now }: { owner?: string | null; budgetMs?: number; now?: () => number } = {}): Promise<DeletionReport[]> {
  const limits: DeletionLimits = { ...DELETION_LIMITS, ...deps.limits }
  const deadline = now() + budgetMs
  const reports: DeletionReport[] = []
  while (now() < deadline) {
    const claimed = await deps.db.claim(owner, limits.leaseMs)
    if (!claimed) break
    reports.push(await processDeletion(deps, claimed))
    if (owner) break
  }
  return reports
}

// Adaptador Postgres. Solo lo usa el proceso administrativo, con la conexión del operador; el de GoTrue y Storage está
// en scripts/account/deletion-services.mjs (la app no contiene código con la credencial de servicio).

type Sql = postgres.Sql

function databaseError(error: unknown, incomplete: DeletionErrorCode = "STEP_INCOMPLETE"): Error {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
  if (code === "BD003") return new LeaseLostError()
  if (code === "BD004") return new DeletionStepError(incomplete, "El paso aún tiene recursos de la cuenta.")
  return new DeletionStepError("DATABASE_UNAVAILABLE", "La base no completó el paso.")
}

async function single<T>(query: Promise<readonly { result: T }[]>, incomplete?: DeletionErrorCode): Promise<T> {
  try { return (await query)[0].result } catch (error) { throw databaseError(error, incomplete) }
}

const STEP_SET = new Set<string>(DELETION_STEPS)
function asStep(value: unknown): DeletionStep {
  if (typeof value !== "string" || !STEP_SET.has(value)) throw new DeletionStepError("UNEXPECTED", "Paso de eliminación desconocido.")
  return value as DeletionStep
}

/** Funciones administrativas de 0013 sobre una conexión `postgres` del operador. */
export function createDeletionDatabase(sql: Sql): DeletionDatabase {
  return {
    async claim(owner, leaseMs) {
      const raw = await single<Record<string, unknown> | null>(sql`select biblib.account_deletion_claim(${owner}::uuid, ${leaseMs}::integer) as result`)
      if (!raw) return null
      return { userId: String(raw.userId), step: asStep(raw.step), token: String(raw.token), fence: Number(raw.fence), attempts: Number(raw.attempts) }
    },
    renew: (owner, token, leaseMs) => single<boolean>(sql`select biblib.account_deletion_renew(${owner}::uuid, ${token}::uuid, ${leaseMs}::integer) as result`),
    purge: (owner, token, step, limit) => single<number>(sql`select biblib.account_deletion_purge(${owner}::uuid, ${token}::uuid, ${step}, ${limit}::integer) as result`),
    async objects(owner, limit) {
      const raw = await single<{ bucket: string; name: string }[]>(sql`select biblib.account_deletion_objects(${owner}::uuid, ${limit}::integer) as result`)
      return raw.map((object) => ({ bucket: object.bucket, name: object.name }))
    },
    async advance(owner, token, step, counts, leaseMs) {
      return asStep(await single<string>(sql`select biblib.account_deletion_advance(${owner}::uuid, ${token}::uuid, ${step}, ${sql.json(counts)}::jsonb, ${leaseMs}::integer) as result`))
    },
    async fail(owner, token, code, retryMs, maxAttempts) {
      const state = await single<string>(sql`select biblib.account_deletion_fail(${owner}::uuid, ${token}::uuid, ${code}, ${retryMs}::integer, ${maxAttempts}::integer) as result`)
      return state === "failed" || state === "waiting_retry" ? state : "lease_lost"
    },
    async complete(owner, token, markDays) {
      await single(sql`select biblib.account_deletion_complete(${owner}::uuid, ${token}::uuid, ${markDays}::integer) as result`, "RESIDUE_FOUND")
    },
  }
}

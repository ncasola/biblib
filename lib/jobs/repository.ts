import type postgres from "postgres"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import * as schema from "../db/schema"
import { books, libraryJobItems, libraryJobs } from "../db/schema"
import type { DatabaseTransaction } from "../db/client"
import { databaseErrorCode } from "../domain-errors"
import { DEFAULT_BOOK_COVER } from "../book-covers"
import {
  countsFromItems, EMPTY_COUNTS, isTerminal, rotatesVersion,
  type ImportJobResult, type JobCounts, type JobItemState, type JobKind, type JobPhase, type JobState, type LibraryJobView,
} from "./contracts"
import type { Book } from "../types"

// Acceso a Postgres del ejecutor de trabajos (U-DAT-03). Reclamar, renovar y cercar el lease usan
// las funciones de 0005, que solo ejecuta la conexión del servidor. Cada transacción de escritura
// empieza por `library_job_fence`: bloquea la fila del trabajo y comprueba token, fencing y cuenta
// activa; las escrituras de dominio se hacen después con el rol `authenticated` y los claims del
// dueño de la fila reclamada, nunca de una entrada de cliente.

export function createJobDatabase(client: postgres.Sql) {
  return drizzle(client, { schema })
}
export type JobDatabase = ReturnType<typeof createJobDatabase>

export interface LeaseRef {
  id: string
  leaseToken: string
  /** Número de fencing como texto: bigint sin pérdida de precisión. */
  fencing: string
}

export interface ClaimedJob extends LeaseRef {
  userId: string
  kind: JobKind
  phase: JobPhase
  previewId: string | null
  expectedRevision: string | null
  idempotencyKey: string
  cursor: string | null
  counts: JobCounts
  published: boolean
  /** Reclamaciones consecutivas sin completar un paso (se reinicia al terminar uno). */
  attempts: number
}

/** El lease se perdió (caducó, lo reclamó otro trabajador, se pausó o canceló) o la cuenta ya no está activa. */
export class LeaseLostError extends Error {
  constructor(readonly reason: "lease" | "account") {
    super(reason === "account" ? "La cuenta del trabajo no está activa." : "El lease del trabajo ya no es válido.")
    this.name = "LeaseLostError"
  }
}

export interface ItemUpdate {
  itemKey: string
  state: JobItemState
  /** Suma 1 a los intentos del elemento (una espera de cuota no cuenta). */
  attempt: boolean
  delayMs: number
  result?: Record<string, unknown> | null
  errorCode?: string | null
}

export interface FinishUpdate {
  state: JobState
  phase?: JobPhase
  counts?: JobCounts
  cursor?: string | null
  result?: ImportJobResult
  published?: boolean
  errorCode?: string | null
  delayMs?: number
  /** Conserva el contador de reclamaciones (paso fallido): permite cerrar un trabajo que falla siempre. */
  keepAttempts?: boolean
}

export interface CoverSnapshot {
  id: string
  isbn: string
  version: string
  cover: Book["cover"]
}

export interface DueItem {
  itemKey: string
  state: JobItemState
  targetVersion: string | null
  attempts: number
}

export interface Recount {
  counts: JobCounts
  pendingDue: number
}

const PLACEHOLDERS = ["", DEFAULT_BOOK_COVER, "/placeholder.svg"]
const missingCover = (alias: string) => sql.raw(["cover_small", "cover_medium", "cover_large"]
  .map((column) => `split_part(btrim(${alias}.${column}), '?', 1) in (${PLACEHOLDERS.map((value) => `'${value}'`).join(", ")})`).join(" and "))

/** Operaciones dentro de una transacción cercada: el trabajo está bloqueado y el lease es vigente. */
export interface FencedContext {
  tx: DatabaseTransaction
  owner: string
  /** Ejecuta escrituras de dominio con RLS del dueño (rol `authenticated` y sus claims). */
  asOwner<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T>
  seedCoverItems(bookIds?: string[]): Promise<number>
  updateItems(updates: ItemUpdate[]): Promise<void>
  recount(): Promise<Recount>
  finish(update: FinishUpdate): Promise<void>
}

function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function claimedFromJson(row: Record<string, unknown>): ClaimedJob {
  const counts = row.counts && typeof row.counts === "object" ? row.counts as Partial<JobCounts> : {}
  return {
    id: String(row.id), leaseToken: String(row.lease_token), fencing: String(row.fencing_number),
    userId: String(row.user_id), kind: row.kind as JobKind, phase: row.phase as JobPhase,
    previewId: asText(row.preview_id), expectedRevision: asText(row.expected_revision), idempotencyKey: String(row.idempotency_key),
    cursor: asText(row.cursor), counts: { ...EMPTY_COUNTS, ...counts }, published: row.published_at !== null && row.published_at !== undefined,
    attempts: Number(row.attempts ?? 0),
  }
}

export function jobView(row: typeof libraryJobs.$inferSelect, now = new Date()): LibraryJobView {
  const state = row.state as JobState
  // La caducidad la persiste el ejecutor o el control; la vista ya la muestra al vencer.
  const shown: JobState = !isTerminal(state) && row.expiresAt <= now ? "expired" : state
  const result = row.result && typeof row.result === "object" && "operationId" in row.result ? row.result as unknown as ImportJobResult : null
  return {
    id: row.id, kind: row.kind, state: shown, phase: row.phase as JobPhase, version: row.version,
    counts: { ...EMPTY_COUNTS, ...row.counts },
    published: row.publishedAt !== null, publishedAt: row.publishedAt?.toISOString() ?? null,
    result, errorCode: shown === "expired" && state !== "expired" ? "JOB_EXPIRED" : row.errorCode,
    nextAttemptAt: shown === "waiting_retry" ? row.nextAttemptAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null, expiresAt: row.expiresAt.toISOString(),
  }
}

export function createJobRepository(db: JobDatabase) {
  async function claim(filter: { jobId?: string; owner?: string }, leaseMs: number): Promise<ClaimedJob | null> {
    const rows = await db.execute<{ job: Record<string, unknown> | null }>(sql`select biblib.library_job_claim(${filter.jobId ?? null}::uuid, ${filter.owner ?? null}::uuid, ${Math.round(leaseMs)}::integer) as job`)
    const job = rows[0]?.job
    return job ? claimedFromJson(job) : null
  }

  async function renew(job: LeaseRef, leaseMs: number): Promise<boolean> {
    const rows = await db.execute<{ renewed: boolean }>(sql`select biblib.library_job_renew(${job.id}::uuid, ${job.leaseToken}::uuid, ${job.fencing}::bigint, ${Math.round(leaseMs)}::integer) as renewed`)
    return rows[0]?.renewed === true
  }

  async function fenced<T>(job: LeaseRef, work: (context: FencedContext) => Promise<T>): Promise<T> {
    try {
      return await db.transaction(async (tx) => {
        const rows = await tx.execute<{ owner: string }>(sql`select biblib.library_job_fence(${job.id}::uuid, ${job.leaseToken}::uuid, ${job.fencing}::bigint) as owner`)
        const owner = rows[0].owner
        const context: FencedContext = {
          tx, owner,
          async asOwner(ownerWork) {
            const claims = JSON.stringify({ sub: owner, role: "authenticated" })
            await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true), set_config('request.jwt.claim.sub', ${owner}, true)`)
            await tx.execute(sql`set local role authenticated`)
            const value = await ownerWork(tx)
            // Las anotaciones del trabajo vuelven a la conexión del servidor; un error aborta la transacción entera.
            await tx.execute(sql`reset role`)
            return value
          },
          async seedCoverItems(bookIds) {
            const only = bookIds ? sql`and b.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(bookIds)}::jsonb))` : sql``
            const inserted = await tx.execute(sql`insert into biblib.library_job_items (job_id, user_id, item_key, phase, target_version)
              select ${job.id}::uuid, b.user_id, b.id::text, 'covers', b.version from biblib.books as b
              where b.user_id = ${owner}::uuid and ${missingCover("b")} ${only}
              on conflict (job_id, item_key, phase) do nothing`)
            return inserted.count ?? 0
          },
          async updateItems(updates) {
            if (!updates.length) return
            const payload = JSON.stringify(updates.map((update) => ({ item_key: update.itemKey, state: update.state, attempt: update.attempt ? 1 : 0, delay_ms: Math.max(0, Math.round(update.delayMs)), result: update.result ?? null, error_code: update.errorCode ?? null })))
            await tx.execute(sql`update biblib.library_job_items as i
              set state = u.state, attempts = i.attempts + u.attempt, next_attempt_at = clock_timestamp() + u.delay_ms * interval '1 millisecond',
                result = u.result, error_code = u.error_code, fencing_number = ${job.fencing}::bigint, updated_at = clock_timestamp()
              from jsonb_to_recordset(${payload}::jsonb) as u(item_key text, state text, attempt integer, delay_ms integer, result jsonb, error_code text)
              where i.job_id = ${job.id}::uuid and i.phase = 'covers' and i.item_key = u.item_key and i.state in ('pending', 'waiting_retry')`)
          },
          async recount() {
            const rows = await tx.execute<{ state: JobItemState; n: number; due: number }>(sql`select i.state, count(*)::int as n,
              count(*) filter (where i.state in ('pending', 'waiting_retry') and i.next_attempt_at <= clock_timestamp())::int as due
              from biblib.library_job_items as i where i.job_id = ${job.id}::uuid group by i.state`)
            return { counts: countsFromItems([...rows]), pendingDue: [...rows].reduce((total, row) => total + row.due, 0) }
          },
          async finish(update) {
            const terminal = isTerminal(update.state)
            const rotate = rotatesVersion("running", update.state)
            const counts = update.counts ? JSON.stringify(update.counts) : null
            const result = update.result ? JSON.stringify(update.result) : null
            const nextAttempt = update.state === "waiting_retry" && !update.delayMs
              ? sql`coalesce((select min(i.next_attempt_at) from biblib.library_job_items as i where i.job_id = ${job.id}::uuid and i.state in ('pending', 'waiting_retry')), clock_timestamp())`
              : sql`clock_timestamp() + ${Math.max(0, Math.round(update.delayMs ?? 0))}::integer * interval '1 millisecond'`
            await tx.execute(sql`update biblib.library_jobs as j set
                state = ${update.state}, phase = coalesce(${update.phase ?? null}::text, j.phase),
                counts = coalesce(${counts}::jsonb, j.counts), result = coalesce(${result}::jsonb, j.result),
                cursor = ${update.cursor === undefined ? sql`j.cursor` : sql`${update.cursor}::text`},
                published_at = ${update.published ? sql`coalesce(j.published_at, clock_timestamp())` : sql`j.published_at`},
                error_code = ${update.errorCode ?? null}::text,
                attempts = ${update.keepAttempts ? sql`j.attempts` : sql`0`},
                lease_token = null, lease_until = null, next_attempt_at = ${nextAttempt},
                version = ${rotate ? sql`gen_random_uuid()` : sql`j.version`},
                finished_at = ${terminal ? sql`clock_timestamp()` : sql`null`},
                expires_at = ${terminal ? sql`clock_timestamp() + interval '30 days'` : sql`j.expires_at`},
                updated_at = clock_timestamp()
              where j.id = ${job.id}::uuid`)
          },
        }
        return work(context)
      })
    } catch (error) {
      const code = databaseErrorCode(error)
      if (code === "BJ001") throw new LeaseLostError("lease")
      if (code === "BJ002") throw new LeaseLostError("account")
      throw error
    }
  }

  /** Elementos vencidos del trabajo; continúa tras el cursor para repartir los pasos. */
  async function dueItems(job: { id: string; cursor: string | null }, limit: number): Promise<DueItem[]> {
    const after = job.cursor ?? ""
    const rows = await db.select({ itemKey: libraryJobItems.itemKey, state: libraryJobItems.state, targetVersion: libraryJobItems.targetVersion, attempts: libraryJobItems.attempts })
      .from(libraryJobItems)
      .where(and(eq(libraryJobItems.jobId, job.id), inArray(libraryJobItems.state, ["pending", "waiting_retry"]), sql`${libraryJobItems.nextAttemptAt} <= clock_timestamp()`))
      .orderBy(sql`case when ${libraryJobItems.itemKey} > ${after} then 0 else 1 end`, asc(libraryJobItems.itemKey))
      .limit(limit)
    return rows.map((row) => ({ ...row, state: row.state as JobItemState }))
  }

  /** Estado actual de los libros del dueño de la fila reclamada (lectura sin bloqueo, fuera de la transacción). */
  async function coverSnapshots(owner: string, ids: string[]): Promise<Map<string, CoverSnapshot>> {
    const valid = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id))
    if (!valid.length) return new Map()
    const rows = await db.select({ id: books.id, isbn: books.isbn, version: books.version, small: books.coverSmall, medium: books.coverMedium, large: books.coverLarge })
      .from(books).where(and(eq(books.userId, owner), inArray(books.id, valid)))
    return new Map(rows.map((row) => [row.id, { id: row.id, isbn: row.isbn, version: row.version, cover: { small: row.small, medium: row.medium, large: row.large } }]))
  }

  async function read(jobId: string): Promise<typeof libraryJobs.$inferSelect | null> {
    const [row] = await db.select().from(libraryJobs).where(eq(libraryJobs.id, jobId)).limit(1)
    return row ?? null
  }

  return { claim, renew, fenced, dueItems, coverSnapshots, read }
}

export type JobRepository = ReturnType<typeof createJobRepository>

/** Portada recuperada solo si el libro conserva la versión y la preimagen vistas al crear el elemento. */
export async function applyRecoveredCovers(tx: DatabaseTransaction, owner: string, recovered: { id: string; version: string; cover: Book["cover"] }[]): Promise<Set<string>> {
  const applied = new Set<string>()
  for (const entry of recovered) {
    const rows = await tx.update(books).set({ coverSmall: entry.cover.small, coverMedium: entry.cover.medium, coverLarge: entry.cover.large, updatedAt: new Date() })
      .where(and(eq(books.userId, owner), eq(books.id, entry.id), eq(books.version, entry.version), missingCover("biblib.books")))
      .returning({ id: books.id })
    if (rows.length) applied.add(entry.id)
  }
  return applied
}

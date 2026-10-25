"use server"

import { and, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import type { ActionResult } from "@/lib/action-result"
import { withRlsContext, type DatabaseTransaction } from "@/lib/db/client"
import { lockLibrary, mapRowToBook } from "@/lib/db/library"
import { bookFields, books, shelves } from "@/lib/db/schema"
import { DomainError } from "@/lib/domain-errors"
import { readingProgress, type ReadingCycleCloseResult, type ReadingCycleStartResult, type ReadingCycleStatus, type ReadingProgress } from "@/lib/product/reading-loans"
import {
  isOwnCloseRetry, knownTotal, pageAboveTotal, parseEntryFields, parseOptionalInstant, READING_MESSAGES, readingDomainError, readingPeriods,
  sameEntry, safeTimeZone, summarizeReading, type CopyReadingView, type ReadingCycleView, type ReadingEntryFields, type ReadingEntryView,
  type ReadingErrorScope, type ReadingMutation, type ReadingStats,
} from "@/lib/reading"
import { domainMutation } from "@/lib/server-action"
import { getRequiredUserId } from "@/lib/server-user"
import type { Book } from "@/lib/types"

// U-PRO-02 · Ciclos, sesiones y progreso de lectura sobre el contrato de 0015 (docs/spec-pendientes/contratos-o14.md).
// Un ciclo es una lectura o relectura (`reading_cycle_start`/`reading_cycle_close`); una entrada, una sesión o un cambio
// de progreso con su `occurred_at` explícito. Ninguna acción rellena fechas que la persona no afirmó ni toca el estado
// actual del ejemplar (`copies.status`). Las mutaciones comparan versión y reconocen su propio reintento (respuesta
// perdida): no es un conflicto. El dueño sale de la sesión; RLS y las FK con dueño son la segunda barrera. Todas
// devuelven `ActionResult`.

const UTC = (column: ReturnType<typeof sql>) => sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
const versionSchema = z.uuid()

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new DomainError("INVALID_INPUT", message)
  return parsed.data
}

/** Transacción de escritura del dueño: bloqueo de colección primero (mismo orden que el resto de mutaciones) y errores traducidos. */
async function write<T>(owner: string, scope: ReadingErrorScope, work: (tx: DatabaseTransaction) => Promise<T>, totalPages?: () => number | null): Promise<T> {
  try {
    return await withRlsContext(owner, async (tx) => { await lockLibrary(tx); return work(tx) })
  } catch (error) { throw readingDomainError(error, scope, totalPages?.() ?? null) }
}

// ── Lectura de un ejemplar ──────────────────────────────────────────────────────────────────────────

interface CycleRow extends Record<string, unknown> {
  id: string; cycle_number: number; status: ReadingCycleStatus; started_at: string | null; finished_at: string | null; version: string
}
interface EntryRow extends Record<string, unknown> {
  id: string; cycle_id: string; occurred_at: string; page_from: number | null; page_to: number | null; note: string | null; version: string
}

const entryView = (row: EntryRow): ReadingEntryView => ({ id: row.id, occurredAt: row.occurred_at, pageFrom: row.page_from, pageTo: row.page_to, note: row.note, version: row.version })

async function copyPages(tx: DatabaseTransaction, owner: string, copyId: string): Promise<number | null | undefined> {
  const [copy] = await tx.execute<{ pages: number }>(sql`
    select e.number_of_pages as pages from biblib.copies as c join biblib.editions as e on e.user_id = c.user_id and e.id = c.edition_id
    where c.user_id = ${owner}::uuid and c.id = ${copyId}::uuid`)
  return copy ? knownTotal(copy.pages) : undefined
}

async function readCopyReading(tx: DatabaseTransaction, owner: string, copyId: string): Promise<CopyReadingView> {
  const totalPages = await copyPages(tx, owner, copyId)
  if (totalPages === undefined) throw new DomainError("NOT_FOUND", READING_MESSAGES.copyGone)
  const cycles = await tx.execute<CycleRow>(sql`
    select id, cycle_number, status, ${UTC(sql`started_at`)} as started_at, ${UTC(sql`finished_at`)} as finished_at, version
    from biblib.reading_cycles where user_id = ${owner}::uuid and copy_id = ${copyId}::uuid order by cycle_number desc`)
  const entries = await tx.execute<EntryRow>(sql`
    select e.id, e.cycle_id, ${UTC(sql`e.occurred_at`)} as occurred_at, e.page_from, e.page_to, e.note, e.version
    from biblib.reading_entries as e join biblib.reading_cycles as r on r.user_id = e.user_id and r.id = e.cycle_id
    where e.user_id = ${owner}::uuid and r.copy_id = ${copyId}::uuid order by e.occurred_at desc, e.created_at desc, e.id`)
  const byCycle = new Map<string, ReadingEntryView[]>()
  for (const row of entries) byCycle.set(row.cycle_id, [...(byCycle.get(row.cycle_id) ?? []), entryView(row)])
  return {
    copyId, totalPages,
    cycles: [...cycles].map((row): ReadingCycleView => ({
      id: row.id, cycleNumber: row.cycle_number, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, version: row.version,
      entries: byCycle.get(row.id) ?? [],
    })),
  }
}

/** Ciclo del dueño bloqueado para escribir; uno ajeno o inexistente es `NOT_FOUND`. */
async function lockCycle(tx: DatabaseTransaction, owner: string, cycleId: string) {
  const [row] = await tx.execute<{ id: string; copy_id: string; status: ReadingCycleStatus; version: string }>(sql`
    select id, copy_id, status, version from biblib.reading_cycles where user_id = ${owner}::uuid and id = ${cycleId}::uuid for update`)
  if (!row) throw new DomainError("NOT_FOUND", READING_MESSAGES.cycleGone)
  return row
}

/** Lectura del ejemplar: ciclos (lecturas y relecturas) con sus entradas y el total de páginas conocido. */
export async function getCopyReadingAction(copyId: string): Promise<ActionResult<CopyReadingView>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const id = parse(z.uuid(), copyId, "La ficha no es válida.")
    return withRlsContext(owner, (tx) => readCopyReading(tx, owner, id))
  })
}

// ── Ciclos ──────────────────────────────────────────────────────────────────────────────────────────

const startSchema = z.object({
  copyId: z.uuid(),
  /** Instante en que la persona dice que empezó; null si no consta (nunca se rellena con la fecha actual). */
  startedAt: z.string().nullable(),
  /** Último ciclo que vio la persona (null si no había ninguno): si cambió en otro dispositivo, se recarga. */
  expectedLatestCycleId: z.uuid().nullable(),
  /** Una relectura (ya hay ciclos) exige confirmarla: los anteriores no se tocan. */
  confirmReread: z.boolean().optional(),
})

/**
 * Inicia una lectura o una relectura (ciclo nuevo con el número siguiente). Si ya hay un ciclo abierto —reintento tras
 * perder la respuesta o un segundo dispositivo—, devuelve ese con `already-open`, sin crear otro ni dar error.
 */
export async function startReadingAction(input: { copyId: string; startedAt: string | null; expectedLatestCycleId: string | null; confirmReread?: boolean }): Promise<ActionResult<ReadingMutation>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const fields = parse(startSchema, input, "Los datos para empezar la lectura no son válidos.")
    const startedAt = parseOptionalInstant(fields.startedAt, "La fecha de inicio")
    return write(owner, "cycle", async (tx) => {
      const [state] = await tx.execute<{ open: string | null; latest: string | null; copy: boolean }>(sql`
        select (select id from biblib.reading_cycles where user_id = ${owner}::uuid and copy_id = ${fields.copyId}::uuid and status in ('reading', 'paused')) as open,
          (select id from biblib.reading_cycles where user_id = ${owner}::uuid and copy_id = ${fields.copyId}::uuid order by cycle_number desc limit 1) as latest,
          exists (select 1 from biblib.copies where user_id = ${owner}::uuid and id = ${fields.copyId}::uuid) as copy`)
      if (!state.copy) throw new DomainError("NOT_FOUND", READING_MESSAGES.copyGone)
      if (state.open) return { reading: await readCopyReading(tx, owner, fields.copyId), outcome: "already-open" as const }
      if (state.latest !== fields.expectedLatestCycleId) throw new DomainError("CONFLICT", READING_MESSAGES.cycleChanged)
      if (state.latest && fields.confirmReread !== true) throw new DomainError("INVALID_INPUT", "Confirma que empiezas una relectura: las lecturas anteriores se conservan tal cual.")
      const [{ result }] = await tx.execute<{ result: ReadingCycleStartResult }>(sql`select biblib.reading_cycle_start(${fields.copyId}::uuid, ${startedAt}::timestamptz) as result`)
      if (result.status === "not_found") throw new DomainError("NOT_FOUND", READING_MESSAGES.copyGone)
      return { reading: await readCopyReading(tx, owner, fields.copyId), outcome: result.status === "open" ? "already-open" as const : "applied" as const }
    })
  })
}

const openStatusSchema = z.object({ cycleId: z.uuid(), expectedVersion: versionSchema })

/** Pausa o reanuda un ciclo abierto con la versión vista. Si ya está en el estado pedido, es el propio reintento. */
async function setOpenStatus(input: unknown, target: "reading" | "paused"): Promise<ReadingMutation> {
  const owner = await getRequiredUserId()
  const fields = parse(openStatusSchema, input, "La lectura indicada no es válida.")
  return write(owner, "cycle", async (tx) => {
    const cycle = await lockCycle(tx, owner, fields.cycleId)
    const changed = await tx.execute(sql`
      update biblib.reading_cycles set status = ${target}, finished_at = null, updated_at = now()
      where user_id = ${owner}::uuid and id = ${fields.cycleId}::uuid and version = ${fields.expectedVersion}::uuid and status in ('reading', 'paused')
      returning id`)
    if (!changed.length && cycle.status !== target) throw new DomainError("CONFLICT", READING_MESSAGES.cycleChanged)
    return { reading: await readCopyReading(tx, owner, cycle.copy_id), outcome: changed.length ? "applied" as const : "retry" as const }
  })
}

export async function pauseReadingAction(input: { cycleId: string; expectedVersion: string }): Promise<ActionResult<ReadingMutation>> {
  return domainMutation(() => setOpenStatus(input, "paused"))
}

export async function resumeReadingAction(input: { cycleId: string; expectedVersion: string }): Promise<ActionResult<ReadingMutation>> {
  return domainMutation(() => setOpenStatus(input, "reading"))
}

const closeSchema = z.object({
  cycleId: z.uuid(), expectedVersion: versionSchema, status: z.enum(["finished", "abandoned"]),
  /** Instante en que terminó o lo dejó; null si no consta. */
  finishedAt: z.string().nullable(),
  confirm: z.literal(true),
})

/**
 * Termina o abandona la lectura con `reading_cycle_close` y la versión vista, tras confirmarlo. `already_closed` con el
 * mismo estado y fecha es el propio reintento; otro cierre u otra versión, un conflicto (otra pestaña o dispositivo).
 */
export async function closeReadingAction(input: { cycleId: string; expectedVersion: string; status: "finished" | "abandoned"; finishedAt: string | null; confirm: true }): Promise<ActionResult<ReadingMutation>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const fields = parse(closeSchema, input, "Confirma cómo termina la lectura.")
    const finishedAt = parseOptionalInstant(fields.finishedAt, fields.status === "finished" ? "La fecha de fin" : "La fecha en que la dejaste")
    return write(owner, "cycle", async (tx) => {
      const cycle = await lockCycle(tx, owner, fields.cycleId)
      const [{ result }] = await tx.execute<{ result: ReadingCycleCloseResult }>(sql`
        select biblib.reading_cycle_close(${fields.cycleId}::uuid, ${fields.expectedVersion}::uuid, ${fields.status}, ${finishedAt}::timestamptz) as result`)
      if (result.status === "not_found") throw new DomainError("NOT_FOUND", READING_MESSAGES.cycleGone)
      if (result.status === "conflict") throw new DomainError("CONFLICT", READING_MESSAGES.cycleChanged)
      if (result.status === "already_closed" && !isOwnCloseRetry(result, { status: fields.status, finishedAt })) throw new DomainError("CONFLICT", READING_MESSAGES.cycleChanged)
      return { reading: await readCopyReading(tx, owner, cycle.copy_id), outcome: result.status === "closed" ? "applied" as const : "retry" as const }
    })
  })
}

const reopenSchema = z.object({ cycleId: z.uuid(), expectedVersion: versionSchema, confirm: z.literal(true) })

/**
 * Reabre una lectura terminada o abandonada (vuelve a «Leyendo» y pierde su fecha de fin), tras confirmarlo. Con otra
 * lectura abierta del mismo ejemplar, la base responde 23505 → «ya hay una lectura en curso».
 */
export async function reopenReadingAction(input: { cycleId: string; expectedVersion: string; confirm: true }): Promise<ActionResult<ReadingMutation>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const fields = parse(reopenSchema, input, "Confirma que quieres reabrir la lectura.")
    return write(owner, "cycle", async (tx) => {
      const cycle = await lockCycle(tx, owner, fields.cycleId)
      const changed = await tx.execute(sql`
        update biblib.reading_cycles set status = 'reading', finished_at = null, updated_at = now()
        where user_id = ${owner}::uuid and id = ${fields.cycleId}::uuid and version = ${fields.expectedVersion}::uuid and status in ('finished', 'abandoned')
        returning id`)
      if (!changed.length && cycle.status !== "reading") throw new DomainError("CONFLICT", READING_MESSAGES.cycleChanged)
      return { reading: await readCopyReading(tx, owner, cycle.copy_id), outcome: changed.length ? "applied" as const : "retry" as const }
    })
  })
}

// ── Entradas (sesiones y progreso) ──────────────────────────────────────────────────────────────────

const entryFieldsSchema = { occurredAt: z.string(), pageFrom: z.number().int().nullable().optional(), pageTo: z.number().int().nullable().optional(), note: z.string().nullable().optional() }
const addEntrySchema = z.object({ cycleId: z.uuid(), entryId: z.uuid(), ...entryFieldsSchema })

interface StoredEntry extends Record<string, unknown> {
  id: string; cycle_id: string; copy_id: string; occurred_at: string; page_from: number | null; page_to: number | null; note: string | null; version: string
}

async function readEntry(tx: DatabaseTransaction, owner: string, entryId: string, lock = false): Promise<StoredEntry | undefined> {
  const [row] = await tx.execute<StoredEntry>(sql`
    select e.id, e.cycle_id, r.copy_id, ${UTC(sql`e.occurred_at`)} as occurred_at, e.page_from, e.page_to, e.note, e.version
    from biblib.reading_entries as e join biblib.reading_cycles as r on r.user_id = e.user_id and r.id = e.cycle_id
    where e.user_id = ${owner}::uuid and e.id = ${entryId}::uuid ${lock ? sql`for update of e` : sql``}`)
  return row
}

const storedFields = (row: StoredEntry): ReadingEntryFields => ({ occurredAt: row.occurred_at, pageFrom: row.page_from, pageTo: row.page_to, note: row.note })

/**
 * Registra una entrada con su `occurred_at` explícito. El identificador lo genera el navegador: repetir el envío tras un
 * corte de red encuentra la misma entrada y no la duplica (reintento propio); otra con ese ID es un conflicto.
 */
export async function addReadingEntryAction(input: { cycleId: string; entryId: string; occurredAt: string; pageFrom?: number | null; pageTo?: number | null; note?: string | null }): Promise<ActionResult<ReadingMutation>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const fields = parse(addEntrySchema, input, "Los datos de la sesión no son válidos.")
    let total: number | null = null
    return write(owner, "entry", async (tx) => {
      const cycle = await lockCycle(tx, owner, fields.cycleId)
      total = (await copyPages(tx, owner, cycle.copy_id)) ?? null
      const entry = parseEntryFields(fields, total)
      const inserted = await tx.execute(sql`
        insert into biblib.reading_entries (id, user_id, cycle_id, occurred_at, page_from, page_to, note)
        values (${fields.entryId}::uuid, ${owner}::uuid, ${fields.cycleId}::uuid, ${entry.occurredAt}::timestamptz, ${entry.pageFrom}, ${entry.pageTo}, ${entry.note})
        on conflict (id) do nothing returning id`)
      if (!inserted.length) {
        const stored = await readEntry(tx, owner, fields.entryId)
        if (!stored || stored.cycle_id !== fields.cycleId || !sameEntry(storedFields(stored), entry)) throw new DomainError("CONFLICT", "No se pudo registrar la sesión: recarga la ficha y vuelve a intentarlo.")
      }
      return { reading: await readCopyReading(tx, owner, cycle.copy_id), outcome: inserted.length ? "applied" as const : "retry" as const }
    }, () => total)
  })
}

const updateEntrySchema = z.object({ entryId: z.uuid(), expectedVersion: versionSchema, ...entryFieldsSchema })

/** Corrige una entrada con la versión vista. Si ya tiene exactamente esos datos, es el propio reintento. */
export async function updateReadingEntryAction(input: { entryId: string; expectedVersion: string; occurredAt: string; pageFrom?: number | null; pageTo?: number | null; note?: string | null }): Promise<ActionResult<ReadingMutation>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const fields = parse(updateEntrySchema, input, "Los datos de la sesión no son válidos.")
    let total: number | null = null
    return write(owner, "entry", async (tx) => {
      const stored = await readEntry(tx, owner, fields.entryId, true)
      if (!stored) throw new DomainError("NOT_FOUND", READING_MESSAGES.entryGone)
      total = (await copyPages(tx, owner, stored.copy_id)) ?? null
      // Un total corregido a la baja después no bloquea editar la nota: la página solo se comprueba si cambia.
      const entry = parseEntryFields(fields)
      if (entry.pageTo !== null && entry.pageTo !== stored.page_to && total !== null && entry.pageTo > total) throw new DomainError("INVALID_INPUT", pageAboveTotal(total))
      if (stored.version !== fields.expectedVersion) {
        if (sameEntry(storedFields(stored), entry)) return { reading: await readCopyReading(tx, owner, stored.copy_id), outcome: "retry" as const }
        throw new DomainError("CONFLICT", READING_MESSAGES.entryChanged)
      }
      await tx.execute(sql`
        update biblib.reading_entries set occurred_at = ${entry.occurredAt}::timestamptz, page_from = ${entry.pageFrom}, page_to = ${entry.pageTo}, note = ${entry.note}, updated_at = now()
        where user_id = ${owner}::uuid and id = ${fields.entryId}::uuid and version = ${fields.expectedVersion}::uuid`)
      return { reading: await readCopyReading(tx, owner, stored.copy_id), outcome: "applied" as const }
    }, () => total)
  })
}

const deleteEntrySchema = z.object({ entryId: z.uuid(), copyId: z.uuid(), expectedVersion: versionSchema, confirm: z.literal(true) })

/**
 * Borra una entrada con la versión vista, tras confirmarlo. Si ya no existe (reintento tras perder la respuesta), el
 * resultado es el mismo; si cambió en otro dispositivo, conflicto.
 */
export async function deleteReadingEntryAction(input: { entryId: string; copyId: string; expectedVersion: string; confirm: true }): Promise<ActionResult<ReadingMutation>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const fields = parse(deleteEntrySchema, input, "Confirma que quieres borrar la entrada.")
    return write(owner, "entry", async (tx) => {
      const stored = await readEntry(tx, owner, fields.entryId, true)
      if (!stored) return { reading: await readCopyReading(tx, owner, fields.copyId), outcome: "retry" as const }
      if (stored.copy_id !== fields.copyId) throw new DomainError("NOT_FOUND", READING_MESSAGES.entryGone)
      if (stored.version !== fields.expectedVersion) throw new DomainError("CONFLICT", READING_MESSAGES.entryChanged)
      await tx.execute(sql`delete from biblib.reading_entries where user_id = ${owner}::uuid and id = ${fields.entryId}::uuid and version = ${fields.expectedVersion}::uuid`)
      return { reading: await readCopyReading(tx, owner, stored.copy_id), outcome: "applied" as const }
    })
  })
}

// ── Inicio: seguir leyendo y estadísticas ───────────────────────────────────────────────────────────

export interface ContinueReadingItem {
  book: Book
  cycleId: string
  cycleNumber: number
  status: ReadingCycleStatus
  startedAt: string | null
  /** Progreso de la última entrada con página; null si no hay ninguna. Sin total conocido, sin porcentaje. */
  progress: ReadingProgress | null
  /** Instante de la última entrada registrada (no de `updated_at`); null si no hay entradas. */
  lastEntryAt: string | null
}

const CONTINUE_READING_LIMIT = 6

/** Ciclos abiertos reales (leyendo primero, luego en pausa), por actividad registrada más reciente. */
export async function getContinueReadingAction(): Promise<ActionResult<{ items: ContinueReadingItem[]; open: number }>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    return withRlsContext(owner, async (tx) => {
      const [{ open }] = await tx.execute<{ open: number }>(sql`select count(*)::int as open from biblib.reading_cycles where user_id = ${owner}::uuid and status in ('reading', 'paused')`)
      const cycles = await tx.execute<CycleRow & { copy_id: string; last_at: string | null; page_to: number | null; activity: string }>(sql`
        select r.id, r.copy_id, r.cycle_number, r.status, ${UTC(sql`r.started_at`)} as started_at, null as finished_at, r.version,
          ${UTC(sql`act.last_at`)} as last_at, last.page_to
        from biblib.reading_cycles as r
        left join lateral (select max(e.occurred_at) as last_at from biblib.reading_entries as e where e.user_id = r.user_id and e.cycle_id = r.id) as act on true
        left join lateral (select e.page_to from biblib.reading_entries as e where e.user_id = r.user_id and e.cycle_id = r.id and e.page_to is not null
          order by e.occurred_at desc, e.created_at desc limit 1) as last on true
        where r.user_id = ${owner}::uuid and r.status in ('reading', 'paused')
        order by (r.status = 'reading') desc, coalesce(act.last_at, r.started_at, r.created_at) desc, r.id
        limit ${CONTINUE_READING_LIMIT}`)
      if (!cycles.length) return { items: [], open }
      const copyIds = cycles.map((row) => row.copy_id)
      const rows = await tx.select({ book: bookFields, shelfTitle: shelves.title }).from(books)
        .innerJoin(shelves, and(eq(books.shelfId, shelves.id), eq(shelves.userId, owner)))
        .where(and(eq(books.userId, owner), inArray(books.id, copyIds)))
      const byId = new Map(rows.map((row) => [row.book.id, mapRowToBook(row)]))
      return {
        open,
        items: cycles.flatMap((row): ContinueReadingItem[] => {
          const book = byId.get(row.copy_id)
          if (!book) return []
          const progress = row.page_to === null ? null : readingProgress(row.page_to, book.number_of_pages)
          return [{ book, cycleId: row.id, cycleNumber: row.cycle_number, status: row.status, startedAt: row.started_at, progress, lastEntryAt: row.last_at }]
        }),
      }
    })
  })
}

/**
 * Estadísticas del inicio solo con datos registrados, con periodo y denominador, calculadas en la zona horaria de la
 * persona (la del navegador). Los libros `read` sin ciclos se cuentan aparte, como lectura legada sin fecha.
 */
export async function getReadingStatsAction(input: { timeZone: string }): Promise<ActionResult<ReadingStats>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const periods = readingPeriods(new Date(), safeTimeZone(input?.timeZone))
    return withRlsContext(owner, async (tx) => {
      const entries = await tx.execute<{ occurred_at: string; page_from: number | null; page_to: number | null }>(sql`
        select ${UTC(sql`occurred_at`)} as occurred_at, page_from, page_to from biblib.reading_entries
        where user_id = ${owner}::uuid and occurred_at >= ${periods.sessionsSince}::timestamptz`)
      const closed = await tx.execute<{ status: ReadingCycleStatus; finished_at: string }>(sql`
        select status, ${UTC(sql`finished_at`)} as finished_at from biblib.reading_cycles
        where user_id = ${owner}::uuid and status in ('finished', 'abandoned') and finished_at >= ${periods.yearSince}::timestamptz`)
      const [counts] = await tx.execute<{ undated: number; open: number; total: number; legacy: number }>(sql`
        select count(*) filter (where status in ('finished', 'abandoned') and finished_at is null)::int as undated,
          count(*) filter (where status in ('reading', 'paused'))::int as open, count(*)::int as total,
          (select count(*)::int from biblib.copies as c where c.user_id = ${owner}::uuid and c.status = 'read'
            and not exists (select 1 from biblib.reading_cycles as r where r.user_id = c.user_id and r.copy_id = c.id)) as legacy
        from biblib.reading_cycles where user_id = ${owner}::uuid`)
      return summarizeReading({
        entries: [...entries].map((row) => ({ occurredAt: row.occurred_at, pageFrom: row.page_from, pageTo: row.page_to })),
        closed: [...closed].map((row) => ({ status: row.status, finishedAt: row.finished_at })),
        closedWithoutDate: counts.undated, openCycles: counts.open, totalCycles: counts.total, legacyReadWithoutCycles: counts.legacy,
      }, periods)
    })
  })
}

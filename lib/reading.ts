import { databaseErrorCode, DomainError, accountInactive } from "./domain-errors"
import {
  civilDateInZone, READING_LIMITS, READING_PAGE_SQLSTATE, readingProgress, type ReadingCycleCloseResult, type ReadingCycleStatus, type ReadingProgress,
} from "./product/reading-loans"
import { PRODUCT_LIMIT_SQLSTATE } from "./product/contracts"

// U-PRO-02 · Ciclos, sesiones y progreso de lectura: vistas, validación de entradas, progreso honesto, estadísticas y
// fechas en la zona de la persona. Funciones puras, válidas en cliente y servidor. Las restricciones las impone también
// Postgres (0015); aquí se anticipan para dar mensajes claros. Un ciclo es una lectura o relectura; una entrada, una
// sesión o un cambio de progreso dentro de un ciclo. Nada de este módulo deduce fechas ni convierte el estado `read`.

// ── Vistas ──────────────────────────────────────────────────────────────────────────────────────────

/** Entrada de un ciclo para su dueño. `occurredAt` es un instante UTC (ISO 8601 con `Z`) que registró la persona. */
export interface ReadingEntryView {
  id: string
  occurredAt: string
  pageFrom: number | null
  pageTo: number | null
  note: string | null
  version: string
}

/** Ciclo de lectura con sus entradas (de la más reciente a la más antigua). Fechas ausentes si no constan. */
export interface ReadingCycleView {
  id: string
  cycleNumber: number
  status: ReadingCycleStatus
  startedAt: string | null
  finishedAt: string | null
  version: string
  entries: ReadingEntryView[]
}

/** Lectura de un ejemplar: ciclos del más reciente al más antiguo y total de páginas conocido (null si es desconocido). */
export interface CopyReadingView {
  copyId: string
  totalPages: number | null
  cycles: ReadingCycleView[]
}

/** Resultado de una mutación: la lectura actualizada y qué pasó (`retry`: el cambio ya constaba, p. ej. tras perder la respuesta). */
export interface ReadingMutation {
  reading: CopyReadingView
  outcome: "applied" | "retry" | "already-open"
}

export const OPEN_STATUSES: readonly ReadingCycleStatus[] = ["reading", "paused"]

export function isOpenCycle(cycle: Pick<ReadingCycleView, "status">): boolean {
  return OPEN_STATUSES.includes(cycle.status)
}

/** El ciclo abierto del ejemplar (como mucho uno), o null. */
export function openCycle(reading: Pick<CopyReadingView, "cycles">): ReadingCycleView | null {
  return reading.cycles.find(isOpenCycle) ?? null
}

/** Ciclo más reciente (número más alto), abierto o cerrado. */
export function latestCycle(reading: Pick<CopyReadingView, "cycles">): ReadingCycleView | null {
  return reading.cycles.reduce<ReadingCycleView | null>((latest, cycle) => (!latest || cycle.cycleNumber > latest.cycleNumber ? cycle : latest), null)
}

export function cycleLabel(cycleNumber: number): string {
  return cycleNumber === 1 ? "Lectura n.º 1" : `Relectura · lectura n.º ${cycleNumber}`
}

/** Total de páginas conocido: un entero > 0; 0 o cualquier otro valor es desconocido. */
export function knownTotal(pages: number | null | undefined): number | null {
  return typeof pages === "number" && Number.isInteger(pages) && pages > 0 ? pages : null
}

/**
 * Última página registrada del ciclo: la de la entrada más reciente (por instante) que tiene página. Sin entradas con
 * página, null: el progreso no se deduce de otros datos.
 */
export function lastRegisteredPage(entries: readonly Pick<ReadingEntryView, "occurredAt" | "pageTo">[]): { page: number; occurredAt: string } | null {
  let found: { page: number; occurredAt: string } | null = null
  for (const entry of entries) {
    if (entry.pageTo === null) continue
    if (!found || Date.parse(entry.occurredAt) > Date.parse(found.occurredAt)) found = { page: entry.pageTo, occurredAt: entry.occurredAt }
  }
  return found
}

/** Progreso del ciclo con `readingProgress`: null si no hay página registrada; `percent` null si no hay total conocido. */
export function cycleProgress(cycle: Pick<ReadingCycleView, "entries">, totalPages: number | null | undefined): ReadingProgress | null {
  const last = lastRegisteredPage(cycle.entries)
  return last ? readingProgress(last.page, totalPages) : null
}

/** Texto del progreso: «Página 140 de 230 (60 %)», o sin total ni porcentaje cuando el total es desconocido. */
export function progressText(progress: ReadingProgress | null): string {
  if (!progress) return "Sin progreso registrado"
  if (progress.total === null) return `Página ${progress.page} · total de páginas desconocido`
  if (progress.percent === null) return `Página ${progress.page}, por encima del total actual de ${progress.total}`
  return `Página ${progress.page} de ${progress.total} (${progress.percent} %)`
}

// ── Validación de entradas ──────────────────────────────────────────────────────────────────────────

/** Margen admitido hacia el futuro por relojes desajustados entre dispositivos. */
export const FUTURE_SKEW_MS = 5 * 60_000
/** Primer instante admitido: nada de fechas imposibles o de relleno. */
export const EARLIEST_INSTANT = Date.UTC(1900, 0, 1)
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message)
}

/**
 * Instante explícito (ISO 8601 con zona) que afirma la persona; se devuelve en UTC con `Z`. Nunca en el futuro (más allá
 * de un margen de reloj) ni antes de 1900. `what` nombra el dato en el mensaje («La fecha de la sesión…»).
 */
export function parseInstant(input: unknown, what: string, now = Date.now()): string {
  if (typeof input !== "string" || !ISO_INSTANT.test(input)) invalid(`${what} no es una fecha y hora válida.`)
  const time = Date.parse(input)
  if (!Number.isFinite(time)) invalid(`${what} no es una fecha y hora válida.`)
  if (time < EARLIEST_INSTANT) invalid(`${what} es anterior a 1900.`)
  if (time > now + FUTURE_SKEW_MS) invalid(`${what} está en el futuro. Registra solo lo que ya ha pasado.`)
  return new Date(time).toISOString()
}

/** Igual que `parseInstant`, pero admite null: la fecha no consta y no se rellena con ninguna otra. */
export function parseOptionalInstant(input: unknown, what: string, now = Date.now()): string | null {
  return input === null || input === undefined ? null : parseInstant(input, what, now)
}

function parsePage(input: unknown, what: string): number | null {
  if (input === null || input === undefined || input === "") return null
  const value = typeof input === "string" && /^\d+$/.test(input.trim()) ? Number(input.trim()) : input
  if (typeof value !== "number" || !Number.isInteger(value)) invalid(`${what} debe ser un número entero.`)
  if (value < 0) invalid(`${what} no puede ser negativa.`)
  if (value > READING_LIMITS.pageMax) invalid(`${what} admite como máximo ${READING_LIMITS.pageMax}.`)
  return value
}

export interface ReadingEntryFields {
  occurredAt: string
  pageFrom: number | null
  pageTo: number | null
  note: string | null
}

/**
 * Valida una entrada: instante obligatorio y explícito, páginas enteras entre 0 y el máximo (la inicial exige la final y
 * no la supera), nota opcional de hasta 1000 caracteres y al menos una página final o una nota. Con un total conocido,
 * la página final no lo supera (la base lo vuelve a comprobar con BR001).
 */
export function parseEntryFields(input: { occurredAt?: unknown; pageFrom?: unknown; pageTo?: unknown; note?: unknown }, totalPages: number | null = null, now = Date.now()): ReadingEntryFields {
  const occurredAt = parseInstant(input.occurredAt, "La fecha de la sesión", now)
  const pageFrom = parsePage(input.pageFrom, "La página inicial")
  const pageTo = parsePage(input.pageTo, "La página final")
  if (input.note !== null && input.note !== undefined && typeof input.note !== "string") invalid("La nota no es válida.")
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null
  if (note !== null && [...note].length > READING_LIMITS.noteMax) invalid(`La nota admite como máximo ${READING_LIMITS.noteMax} caracteres.`)
  if (note !== null && CONTROL.test(note)) invalid("La nota contiene caracteres no admitidos.")
  if (pageFrom !== null && pageTo === null) invalid("Indica también la página final de la sesión.")
  if (pageFrom !== null && pageTo !== null && pageFrom > pageTo) invalid("La página inicial no puede ser mayor que la final.")
  if (pageTo === null && note === null) invalid("Registra al menos la página a la que llegaste o una nota.")
  const total = knownTotal(totalPages)
  if (total !== null && pageTo !== null && pageTo > total) invalid(pageAboveTotal(total))
  return { occurredAt, pageFrom, pageTo, note }
}

export function pageAboveTotal(total: number | null): string {
  return total === null
    ? "La página supera el total de páginas conocido de esta edición. Corrige la página o, si el total está mal, edita la ficha."
    : `La página supera el total de esta edición (${total}). Corrige la página o, si el total está mal, edita la ficha.`
}

/** Misma entrada (reintento propio tras perder la respuesta): mismos instante, páginas y nota. */
export function sameEntry(stored: ReadingEntryFields, requested: ReadingEntryFields): boolean {
  return Date.parse(stored.occurredAt) === Date.parse(requested.occurredAt) && stored.pageFrom === requested.pageFrom
    && stored.pageTo === requested.pageTo && stored.note === requested.note
}

/**
 * `already_closed` de `reading_cycle_close` es el reintento propio si el ciclo quedó con el estado y la fecha de fin que
 * se pedían (ambas ausentes cuenta como iguales). Cualquier otra cosa la cerró otro dispositivo.
 */
export function isOwnCloseRetry(result: Extract<ReadingCycleCloseResult, { status: "already_closed" }>, requested: { status: "finished" | "abandoned"; finishedAt: string | null }): boolean {
  if (result.cycle_status !== requested.status) return false
  if (result.finished_at === null || requested.finishedAt === null) return result.finished_at === requested.finishedAt
  return Date.parse(result.finished_at) === Date.parse(requested.finishedAt)
}

// ── Errores de la base ──────────────────────────────────────────────────────────────────────────────

export const READING_MESSAGES = Object.freeze({
  copyGone: "El libro ya no está disponible.",
  cycleGone: "Esta lectura ya no existe. Recarga la ficha.",
  entryGone: "Esta entrada ya no existe. Recarga la ficha.",
  cycleChanged: "La lectura ha cambiado en otra pestaña o dispositivo. No se ha guardado nada: recarga la ficha y vuelve a intentarlo.",
  entryChanged: "La entrada ha cambiado en otra pestaña o dispositivo. No se ha guardado nada: recarga la ficha y vuelve a intentarlo.",
  alreadyOpen: "Ya hay una lectura en curso de este libro. Termínala o abandónala antes de reabrir otra.",
  datesOrder: "La fecha de fin no puede ser anterior a la de inicio.",
})

export type ReadingErrorScope = "cycle" | "entry"

/**
 * Traduce los errores de Postgres de la lectura: BR001 (página por encima del total) y 23514 → INVALID_INPUT, 23505 (otro
 * ciclo abierto) → CONFLICT, BP001 (límite) → LIMIT_EXCEEDED, 23503 → NOT_FOUND y BD001 → ACCOUNT_INACTIVE. El resto
 * no se presenta como un error de datos.
 */
export function readingDomainError(error: unknown, scope: ReadingErrorScope, totalPages: number | null = null): DomainError {
  if (error instanceof DomainError) return error
  switch (databaseErrorCode(error)) {
    case READING_PAGE_SQLSTATE: return new DomainError("INVALID_INPUT", pageAboveTotal(knownTotal(totalPages)))
    case "23505": return new DomainError("CONFLICT", READING_MESSAGES.alreadyOpen)
    case PRODUCT_LIMIT_SQLSTATE: return new DomainError("LIMIT_EXCEEDED", scope === "cycle"
      ? `Este libro ya tiene el máximo de ${READING_LIMITS.cyclesPerCopy} lecturas registradas (o tu cuenta, el de ${READING_LIMITS.cyclesPerAccount}). No se ha creado ninguna.`
      : `Esta lectura ya tiene el máximo de ${READING_LIMITS.entriesPerCycle} entradas (o tu cuenta, el de ${READING_LIMITS.entriesPerAccount}). No se ha registrado nada.`)
    case "23514": return new DomainError("INVALID_INPUT", scope === "cycle" ? READING_MESSAGES.datesOrder : "Algún dato de la entrada no es válido. Revisa las páginas y la nota.")
    case "22023": return new DomainError("INVALID_INPUT", "La forma de terminar la lectura no es válida.")
    case "23503": return new DomainError("NOT_FOUND", scope === "cycle" ? READING_MESSAGES.copyGone : READING_MESSAGES.cycleGone)
    case "BD001": return accountInactive()
    case "40P01": return new DomainError("PROVIDER_UNAVAILABLE", "Otra operación estaba modificando tu biblioteca. No se ha aplicado nada; inténtalo de nuevo.")
    default: return new DomainError("PROVIDER_UNAVAILABLE", "No se pudo guardar el cambio. Inténtalo de nuevo.")
  }
}

// ── Zona horaria de la persona ──────────────────────────────────────────────────────────────────────

/** Zona IANA válida (la del navegador de la persona); cualquier otra cosa → UTC. */
export function safeTimeZone(input: unknown): string {
  if (typeof input !== "string" || !input || input.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(input)) return "UTC"
  try { return new Intl.DateTimeFormat("en-US", { timeZone: input }).resolvedOptions().timeZone } catch { return "UTC" }
}

/** Desfase (ms) de la zona respecto de UTC en ese instante. */
function zoneOffset(instant: number, timeZone: string): number {
  const base = Math.floor(instant / 1000) * 1000
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(base))
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value)
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second")) - base
}

/** Instante en que empieza el día civil `AAAA-MM-DD` en la zona (medianoche local, con su horario de verano). */
export function startOfCivilDay(civil: string, timeZone: string): Date {
  const [year, month, day] = civil.split("-").map(Number)
  const guess = Date.UTC(year, month - 1, day)
  const first = guess - zoneOffset(guess, timeZone)
  return new Date(guess - zoneOffset(first, timeZone))
}

export function addCivilDays(civil: string, days: number): string {
  const [year, month, day] = civil.split("-").map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

const DATE_TIME = new Map<string, Intl.DateTimeFormat>()
function formatter(options: Intl.DateTimeFormatOptions, timeZone?: string): Intl.DateTimeFormat {
  const key = JSON.stringify([options, timeZone ?? ""])
  let format = DATE_TIME.get(key)
  if (!format) { format = new Intl.DateTimeFormat("es-ES", { ...options, ...(timeZone ? { timeZone } : {}) }); DATE_TIME.set(key, format) }
  return format
}

/** Fecha y hora de un instante en la zona de la persona (por defecto, la del navegador): «2 feb 2026, 21:00». */
export function formatInstant(iso: string, timeZone?: string): string {
  return formatter({ day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }, timeZone).format(new Date(iso))
}

/** Solo la fecha de un instante en la zona de la persona: «2 feb 2026». */
export function formatInstantDate(iso: string, timeZone?: string): string {
  return formatter({ day: "numeric", month: "short", year: "numeric" }, timeZone).format(new Date(iso))
}

/** Fecha civil `AAAA-MM-DD` sin conversión de zona: «26 sept 2026». */
export function formatCivilDate(civil: string): string {
  return formatter({ day: "numeric", month: "short", year: "numeric" }, "UTC").format(new Date(`${civil}T12:00:00Z`))
}

/** Valor de un `<input type="datetime-local">` para un instante, en la zona local del navegador. */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Instante UTC de un valor de `datetime-local` interpretado en la zona local del navegador; null si no es válido. */
export function fromDateTimeLocalValue(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

// ── Estadísticas honestas ───────────────────────────────────────────────────────────────────────────

/** Días del periodo de sesiones: los últimos 30 días civiles en la zona de la persona, hoy incluido. */
export const SESSION_PERIOD_DAYS = 30

export interface ReadingPeriods {
  timeZone: string
  today: string
  /** Primer día del periodo de sesiones y su inicio como instante. */
  sessionsFrom: string
  sessionsSince: string
  /** Año en curso en la zona de la persona y su inicio como instante. */
  year: number
  yearFrom: string
  yearSince: string
}

export function readingPeriods(now: Date, timeZone: string): ReadingPeriods {
  const zone = safeTimeZone(timeZone)
  const today = civilDateInZone(now, zone)
  const sessionsFrom = addCivilDays(today, -(SESSION_PERIOD_DAYS - 1))
  const yearFrom = `${today.slice(0, 4)}-01-01`
  return {
    timeZone: zone, today, sessionsFrom, sessionsSince: startOfCivilDay(sessionsFrom, zone).toISOString(),
    year: Number(today.slice(0, 4)), yearFrom, yearSince: startOfCivilDay(yearFrom, zone).toISOString(),
  }
}

/** Datos registrados que entran en las estadísticas: entradas y cierres con su instante, y recuentos de lo que no tiene fecha. */
export interface ReadingStatsInput {
  /** Entradas desde `sessionsSince` (la consulta ya acota; aquí se vuelve a filtrar). */
  entries: { occurredAt: string; pageFrom: number | null; pageTo: number | null }[]
  /** Ciclos cerrados con fecha de fin desde `yearSince`. */
  closed: { status: ReadingCycleStatus; finishedAt: string }[]
  /** Ciclos cerrados sin fecha de fin: no entran en ningún periodo. */
  closedWithoutDate: number
  openCycles: number
  totalCycles: number
  /** Ejemplares con estado `read` y ningún ciclo: lectura legada sin fecha, que no cuenta como lectura registrada. */
  legacyReadWithoutCycles: number
}

export interface ReadingStats {
  periods: ReadingPeriods
  sessions: {
    /** Entradas registradas en el periodo (sesiones o cambios de progreso). */
    entries: number
    /** Días del periodo con al menos una entrada, sobre `SESSION_PERIOD_DAYS`. */
    activeDays: number
    days: number
    /** Páginas avanzadas (página final − inicial) de las entradas que registran ambas. */
    pages: number
    entriesWithRange: number
  }
  year: { finished: number; abandoned: number; closed: number }
  closedWithoutDate: number
  openCycles: number
  totalCycles: number
  legacyReadWithoutCycles: number
}

/**
 * Estadísticas solo con datos registrados: cada cifra tiene su periodo (en la zona de la persona) y su denominador. Un
 * libro `read` sin ciclo nunca cuenta como lectura con fecha; un cierre sin fecha no entra en ningún periodo.
 */
export function summarizeReading(input: ReadingStatsInput, periods: ReadingPeriods): ReadingStats {
  const since = Date.parse(periods.sessionsSince)
  const entries = input.entries.filter((entry) => Date.parse(entry.occurredAt) >= since && civilDateInZone(new Date(entry.occurredAt), periods.timeZone) <= periods.today)
  const days = new Set(entries.map((entry) => civilDateInZone(new Date(entry.occurredAt), periods.timeZone)))
  const ranged = entries.filter((entry) => entry.pageFrom !== null && entry.pageTo !== null)
  const yearSince = Date.parse(periods.yearSince)
  const closed = input.closed.filter((cycle) => Date.parse(cycle.finishedAt) >= yearSince && civilDateInZone(new Date(cycle.finishedAt), periods.timeZone).startsWith(String(periods.year)))
  return {
    periods,
    sessions: {
      entries: entries.length, activeDays: days.size, days: SESSION_PERIOD_DAYS,
      pages: ranged.reduce((sum, entry) => sum + ((entry.pageTo ?? 0) - (entry.pageFrom ?? 0)), 0), entriesWithRange: ranged.length,
    },
    year: { finished: closed.filter((cycle) => cycle.status === "finished").length, abandoned: closed.filter((cycle) => cycle.status === "abandoned").length, closed: closed.length },
    closedWithoutDate: input.closedWithoutDate,
    openCycles: input.openCycles,
    totalCycles: input.totalCycles,
    legacyReadWithoutCycles: input.legacyReadWithoutCycles,
  }
}

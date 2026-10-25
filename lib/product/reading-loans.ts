// Contratos de datos de O14 (lote D, migración 0015): ciclos y entradas de lectura (U-PRO-02) y préstamos (U-PRO-04).
// Solo tipos, límites y funciones puras: los usan el schema, el formato v2, las versiones anteriores y las unidades, en
// el servidor y en el navegador. Los límites son los que imponen las restricciones y triggers de 0015; cambiarlos exige
// una migración. Lectura y préstamo son estados independientes entre sí y del estado actual del ejemplar
// (`copies.status`). Documentación: docs/spec-pendientes/contratos-o14.md.

/** Página por encima del total conocido de la edición (`biblib.guard_reading_entry_pages`). → INVALID_INPUT. */
export const READING_PAGE_SQLSTATE = "BR001"

// ── U-PRO-02 · Ciclos y entradas de lectura ─────────────────────────────────────────────────────────

/**
 * Estado de un ciclo. `reading` y `paused` son ciclos abiertos (como mucho uno por ejemplar); `finished` y `abandoned`,
 * cerrados. Una relectura es un ciclo nuevo con el número siguiente: los anteriores no se tocan.
 */
export const READING_CYCLE_STATUSES = ["reading", "paused", "finished", "abandoned"] as const
export type ReadingCycleStatus = (typeof READING_CYCLE_STATUSES)[number]
export const OPEN_READING_STATUSES = ["reading", "paused"] as const satisfies readonly ReadingCycleStatus[]
export const CLOSED_READING_STATUSES = ["finished", "abandoned"] as const satisfies readonly ReadingCycleStatus[]

export const READING_CYCLE_STATUS_LABELS: Readonly<Record<ReadingCycleStatus, string>> = Object.freeze({
  reading: "Leyendo",
  paused: "En pausa",
  finished: "Terminado",
  abandoned: "Abandonado",
})

export const READING_LIMITS = Object.freeze({
  /** Ciclos (lecturas y relecturas) por ejemplar y por cuenta. */
  cyclesPerCopy: 50,
  cyclesPerAccount: 20_000,
  /** Número de ciclo: 1, 2, 3… por ejemplar. */
  cycleNumberMax: 1_000,
  /** Entradas (sesiones o cambios de progreso) por ciclo y por cuenta. */
  entriesPerCycle: 1_000,
  entriesPerAccount: 50_000,
  /** Página máxima admitida (igual que `editions.number_of_pages`). */
  pageMax: 100_000,
  noteMax: 1_000,
})

export function isOpenReadingStatus(status: ReadingCycleStatus): boolean {
  return (OPEN_READING_STATUSES as readonly ReadingCycleStatus[]).includes(status)
}

/**
 * Entrada de un ciclo: una sesión real o un cambio de progreso. `occurredAt` es un instante UTC (ISO 8601 con zona) que
 * la persona registra; nunca se deduce de `updated_at`. Páginas enteras ≥ 0, `pageFrom ≤ pageTo` y nunca por encima del
 * total conocido de la edición. Lleva al menos `pageTo` o `note`.
 */
export interface ReadingEntry {
  id: string
  occurredAt: string
  pageFrom?: number
  pageTo?: number
  note?: string
}

/**
 * Ciclo de lectura de un ejemplar. Las fechas son instantes UTC; ausentes si se desconocen (nunca se rellenan con la
 * fecha actual). Un ciclo abierto no tiene `finishedAt`; uno cerrado puede no tenerla si no consta.
 */
export interface ReadingCycle {
  id: string
  cycleNumber: number
  status: ReadingCycleStatus
  startedAt?: string
  finishedAt?: string
  entries?: ReadingEntry[]
}

/** Progreso honesto: sin total conocido (0 o desconocido) o con una página por encima del total, no hay porcentaje. */
export interface ReadingProgress {
  page: number
  total: number | null
  percent: number | null
}

export function readingProgress(page: number, totalPages: number | null | undefined): ReadingProgress {
  const total = typeof totalPages === "number" && Number.isInteger(totalPages) && totalPages > 0 ? totalPages : null
  if (total === null || page < 0 || page > total) return { page, total, percent: null }
  return { page, total, percent: Math.floor((page / total) * 100) }
}

/** Resultado de `biblib.reading_cycle_start(copy_id, started_at)`. `open`: ya había un ciclo abierto (reintento o dos dispositivos). */
export type ReadingCycleStartResult =
  | { status: "started"; cycle_id: string; cycle_number: number; version: string }
  | { status: "open"; cycle_id: string; cycle_number: number; version: string }
  | { status: "not_found" }

/** Resultado de `biblib.reading_cycle_close(cycle_id, expected_version, status, finished_at)`. */
export type ReadingCycleCloseResult =
  | { status: "closed"; version: string }
  | { status: "already_closed"; cycle_status: ReadingCycleStatus; finished_at: string | null; version: string }
  | { status: "conflict"; version: string }
  | { status: "not_found" }

// ── U-PRO-04 · Préstamos ────────────────────────────────────────────────────────────────────────────

export const LOAN_LIMITS = Object.freeze({
  /** Alias corto de quien tiene el libro; nunca un correo ni un teléfono. */
  borrowerLabelMax: 40,
  /** Dígitos admitidos en el alias (un número de teléfono no cabe). */
  borrowerLabelDigitsMax: 6,
  noteMax: 500,
  perCopy: 200,
  perAccount: 20_000,
})

/** Rango de fechas civiles admitido (`loans_dates_check`). */
export const CIVIL_DATE_RANGE = Object.freeze({ min: "1900-01-01", max: "2999-12-31" })

/** Texto de un préstamo sin vencimiento: nunca se inventa una fecha. */
export const LOAN_NO_DUE_DATE_TEXT = "Sin fecha acordada"

/**
 * BibLib no envía recordatorios de préstamo ni guarda que se hayan enviado: no hay columna ni estado para ello. La interfaz
 * solo puede mostrar el vencimiento («Vence el…», «Venció el…» o `LOAN_NO_DUE_DATE_TEXT`).
 */
export const LOAN_REMINDERS_SENT = false as const

/**
 * Alias válido (como `loans_borrower_label_check`): 1–40 caracteres, sin espacios en los extremos ni caracteres de
 * control, sin «@» (un correo) y con 6 dígitos como mucho (un teléfono no cabe).
 */
export function isValidBorrowerLabel(label: string): boolean {
  const length = [...label].length
  return length >= 1 && length <= LOAN_LIMITS.borrowerLabelMax && !label.startsWith(" ") && !label.endsWith(" ") && !/[\u0000-\u001f\u007f-\u009f]/.test(label)
    && !label.includes("@") && label.replace(/[^0-9]/g, "").length <= LOAN_LIMITS.borrowerLabelDigitsMax
}

/** Fecha civil `AAAA-MM-DD` existente en el calendario y dentro de `CIVIL_DATE_RANGE`. Sin hora ni zona. */
export function isCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < CIVIL_DATE_RANGE.min || value > CIVIL_DATE_RANGE.max) return false
  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/**
 * Fecha civil de un instante en la zona horaria de la persona (p. ej. «hoy» al prestar). Las fechas civiles se guardan
 * como `DATE` sin conversión: el 29-03 en Madrid es el 29-03 en la base aunque en UTC aún fuese el 28.
 */
export function civilDateInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant)
  const part = (type: "year" | "month" | "day") => parts.find((entry) => entry.type === type)?.value ?? ""
  return `${part("year")}-${part("month")}-${part("day")}`
}

/**
 * Préstamo de un ejemplar. Fechas civiles `AAAA-MM-DD` (columnas `DATE`): `dueOn` y `returnedOn` nunca antes de
 * `loanedOn`. Activo mientras no hay `returnedOn`: como mucho uno por ejemplar.
 */
export interface Loan {
  id: string
  borrowerLabel: string
  loanedOn: string
  dueOn?: string
  returnedOn?: string
  note?: string
}

export function isActiveLoan(loan: Pick<Loan, "returnedOn">): boolean {
  return loan.returnedOn === undefined
}

/** Vencido: activo, con vencimiento y `today` (fecha civil de la persona) posterior a él. Sin vencimiento, nunca. */
export function isLoanOverdue(loan: Pick<Loan, "dueOn" | "returnedOn">, today: string): boolean {
  return isActiveLoan(loan) && loan.dueOn !== undefined && today > loan.dueOn
}

/** Resultado de `biblib.loan_open(copy_id, borrower_label, loaned_on, due_on, note)`. `active`: el ejemplar ya está prestado. */
export type LoanOpenResult =
  | { status: "opened"; loan_id: string; version: string }
  | { status: "active"; loan_id: string; borrower_label: string; loaned_on: string; version: string }
  | { status: "not_found" }

/** Resultado de `biblib.loan_return(loan_id, expected_version, returned_on)`. */
export type LoanReturnResult =
  | { status: "returned"; version: string }
  | { status: "already_returned"; returned_on: string; version: string }
  | { status: "conflict"; version: string }
  | { status: "not_found" }

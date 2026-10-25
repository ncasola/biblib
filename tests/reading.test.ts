import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { DomainError } from "../lib/domain-errors"
import { READING_LIMITS } from "../lib/product/reading-loans"
import {
  cycleLabel, cycleProgress, formatCivilDate, formatInstant, fromDateTimeLocalValue, isOwnCloseRetry, lastRegisteredPage, latestCycle, openCycle, parseEntryFields,
  parseInstant, parseOptionalInstant, progressText, readingDomainError, readingPeriods, safeTimeZone, sameEntry, startOfCivilDay, summarizeReading,
  type ReadingCycleView, type ReadingEntryView, type ReadingStatsInput,
} from "../lib/reading"

// U-PRO-02 · Lógica pura de lectura: progreso honesto (sin porcentaje si el total es desconocido), validación de entradas
// con instante explícito, reintento propio frente a conflicto, traducción de BR001/23505/BP001, periodos en la zona de
// la persona y estadísticas solo con datos registrados (cero ciclos, varios ciclos, legado `read` sin fecha).

const NOW = Date.parse("2026-10-25T18:00:00Z")
const entry = (occurredAt: string, pageTo: number | null, pageFrom: number | null = null, note: string | null = null): ReadingEntryView =>
  ({ id: occurredAt, occurredAt, pageFrom, pageTo, note, version: "v" })
const cycle = (cycleNumber: number, status: ReadingCycleView["status"], entries: ReadingEntryView[] = []): ReadingCycleView =>
  ({ id: `c${cycleNumber}`, cycleNumber, status, startedAt: null, finishedAt: null, version: "v", entries })
const code = (sqlstate: string) => Object.assign(new Error("db"), { code: sqlstate })
const invalidMessage = (work: () => unknown): string => {
  try { work() } catch (error) { assert.ok(error instanceof DomainError); assert.equal(error.code, "INVALID_INPUT"); return error.message }
  assert.fail("debía rechazarse")
}

describe("progreso honesto", () => {
  test("la última página es la de la entrada más reciente por instante, no por orden de llegada", () => {
    const entries = [entry("2026-10-02T10:00:00Z", 80), entry("2026-10-03T10:00:00Z", 60), entry("2026-10-04T10:00:00Z", null, null, "Solo nota")]
    assert.deepEqual(lastRegisteredPage(entries), { page: 60, occurredAt: "2026-10-03T10:00:00Z" })
  })

  test("sin total conocido no hay porcentaje; sin entradas con página no hay progreso", () => {
    const reading = cycle(1, "reading", [entry("2026-10-02T10:00:00Z", 120)])
    assert.deepEqual(cycleProgress(reading, 0), { page: 120, total: null, percent: null })
    assert.deepEqual(cycleProgress(reading, null), { page: 120, total: null, percent: null })
    assert.deepEqual(cycleProgress(reading, 240), { page: 120, total: 240, percent: 50 })
    assert.equal(cycleProgress(cycle(1, "reading", [entry("2026-10-02T10:00:00Z", null, null, "Nota")]), 240), null)
    assert.equal(progressText(null), "Sin progreso registrado")
    assert.equal(progressText(cycleProgress(reading, 0)), "Página 120 · total de páginas desconocido")
    assert.equal(progressText(cycleProgress(reading, 240)), "Página 120 de 240 (50 %)")
    assert.equal(progressText(cycleProgress(reading, 100)), "Página 120, por encima del total actual de 100", "un total corregido a la baja no inventa un porcentaje")
  })

  test("ciclo abierto, último ciclo y etiquetas de relectura", () => {
    const reading = { cycles: [cycle(3, "paused"), cycle(2, "finished"), cycle(1, "abandoned")] }
    assert.equal(openCycle(reading)?.cycleNumber, 3)
    assert.equal(latestCycle(reading)?.cycleNumber, 3)
    assert.equal(openCycle({ cycles: [cycle(1, "finished")] }), null)
    assert.equal(latestCycle({ cycles: [] }), null)
    assert.equal(cycleLabel(1), "Lectura n.º 1")
    assert.equal(cycleLabel(2), "Relectura · lectura n.º 2")
  })
})

describe("entradas con instante explícito", () => {
  test("acepta la sesión válida y guarda el instante en UTC", () => {
    assert.deepEqual(parseEntryFields({ occurredAt: "2026-10-24T21:30:00+02:00", pageFrom: "10", pageTo: 40, note: "  Capítulo 3  " }, 300, NOW),
      { occurredAt: "2026-10-24T19:30:00.000Z", pageFrom: 10, pageTo: 40, note: "Capítulo 3" })
    assert.deepEqual(parseEntryFields({ occurredAt: "2026-10-24T19:30:00Z", note: "Solo una nota" }, null, NOW),
      { occurredAt: "2026-10-24T19:30:00.000Z", pageFrom: null, pageTo: null, note: "Solo una nota" })
  })

  test("con total desconocido se registra cualquier página sin porcentaje", () => {
    assert.equal(parseEntryFields({ occurredAt: "2026-10-24T19:30:00Z", pageTo: 4000 }, 0, NOW).pageTo, 4000)
  })

  test("rechaza páginas negativas, invertidas, sin final, por encima del total y entradas vacías", () => {
    const at = "2026-10-24T19:30:00Z"
    assert.match(invalidMessage(() => parseEntryFields({ occurredAt: at, pageTo: -1 }, 300, NOW)), /no puede ser negativa/)
    assert.match(invalidMessage(() => parseEntryFields({ occurredAt: at, pageFrom: 20, pageTo: 10 }, 300, NOW)), /inicial no puede ser mayor/)
    assert.match(invalidMessage(() => parseEntryFields({ occurredAt: at, pageFrom: 20 }, 300, NOW)), /página final/)
    assert.match(invalidMessage(() => parseEntryFields({ occurredAt: at, pageTo: 301 }, 300, NOW)), /supera el total de esta edición \(300\)/)
    assert.match(invalidMessage(() => parseEntryFields({ occurredAt: at, note: "   " }, 300, NOW)), /al menos la página/)
    assert.match(invalidMessage(() => parseEntryFields({ occurredAt: at, pageTo: 1.5 }, 300, NOW)), /número entero/)
    assert.match(invalidMessage(() => parseEntryFields({ occurredAt: at, pageTo: READING_LIMITS.pageMax + 1 }, null, NOW)), /como máximo/)
    assert.match(invalidMessage(() => parseEntryFields({ occurredAt: at, note: "x".repeat(READING_LIMITS.noteMax + 1) }, null, NOW)), /1000 caracteres/)
  })

  test("el instante es obligatorio, real y no futuro; null solo donde no consta", () => {
    assert.match(invalidMessage(() => parseEntryFields({ pageTo: 10 }, null, NOW)), /no es una fecha/)
    assert.match(invalidMessage(() => parseInstant("2026-10-24", "La fecha", NOW)), /no es una fecha/, "sin hora ni zona no hay instante")
    assert.match(invalidMessage(() => parseInstant("2026-10-24T19:30:00", "La fecha", NOW)), /no es una fecha/, "sin zona no se adivina")
    assert.match(invalidMessage(() => parseInstant("2026-10-26T18:00:00Z", "La fecha", NOW)), /en el futuro/)
    assert.match(invalidMessage(() => parseInstant("1899-12-31T23:00:00Z", "La fecha", NOW)), /anterior a 1900/)
    assert.equal(parseInstant("2026-10-25T18:04:00Z", "La fecha", NOW), "2026-10-25T18:04:00.000Z", "margen de reloj entre dispositivos")
    assert.equal(parseOptionalInstant(null, "La fecha de inicio", NOW), null, "sin fecha no se rellena con la actual")
    assert.equal(parseOptionalInstant(undefined, "La fecha de inicio", NOW), null)
  })

  test("misma entrada: reintento propio aunque el instante llegue con otra zona", () => {
    const stored = { occurredAt: "2026-10-24T19:30:00.000Z", pageFrom: null, pageTo: 40, note: null }
    assert.equal(sameEntry(stored, { ...stored, occurredAt: "2026-10-24T21:30:00+02:00" }), true)
    assert.equal(sameEntry(stored, { ...stored, pageTo: 41 }), false)
    assert.equal(sameEntry(stored, { ...stored, note: "Otra" }), false)
  })
})

describe("cierre: reintento propio frente a otro dispositivo", () => {
  const closed = (cycle_status: "finished" | "abandoned", finished_at: string | null) => ({ status: "already_closed" as const, cycle_status, finished_at, version: "v" })

  test("mismo estado y misma fecha (también ambas sin fecha) es el propio reintento", () => {
    assert.equal(isOwnCloseRetry(closed("finished", "2026-02-01T20:00:00+00:00"), { status: "finished", finishedAt: "2026-02-01T20:00:00.000Z" }), true)
    assert.equal(isOwnCloseRetry(closed("abandoned", null), { status: "abandoned", finishedAt: null }), true)
  })

  test("otro estado u otra fecha lo cerró otro dispositivo", () => {
    assert.equal(isOwnCloseRetry(closed("abandoned", "2026-02-01T20:00:00Z"), { status: "finished", finishedAt: "2026-02-01T20:00:00Z" }), false)
    assert.equal(isOwnCloseRetry(closed("finished", "2026-02-02T20:00:00Z"), { status: "finished", finishedAt: "2026-02-01T20:00:00Z" }), false)
    assert.equal(isOwnCloseRetry(closed("finished", null), { status: "finished", finishedAt: "2026-02-01T20:00:00Z" }), false)
  })
})

describe("errores de la base", () => {
  test("BR001, 23505, BP001, 23514, 23503 y BD001 tienen mensajes claros y su código de dominio", () => {
    const cases: [string, "cycle" | "entry", string, RegExp][] = [
      ["BR001", "entry", "INVALID_INPUT", /supera el total de esta edición \(300\)/],
      ["23505", "cycle", "CONFLICT", /ya hay una lectura en curso/i],
      ["BP001", "cycle", "LIMIT_EXCEEDED", /máximo de 50 lecturas/],
      ["BP001", "entry", "LIMIT_EXCEEDED", /máximo de 1000 entradas/],
      ["23514", "cycle", "INVALID_INPUT", /fin no puede ser anterior/],
      ["23503", "entry", "NOT_FOUND", /ya no existe/],
      ["BD001", "entry", "ACCOUNT_INACTIVE", /se está eliminando/],
      ["XX000", "entry", "PROVIDER_UNAVAILABLE", /No se pudo guardar/],
    ]
    for (const [sqlstate, scope, expected, message] of cases) {
      const error = readingDomainError(code(sqlstate), scope, 300)
      assert.equal(error.code, expected, sqlstate)
      assert.match(error.message, message, sqlstate)
    }
    assert.match(readingDomainError(code("BR001"), "entry", 0).message, /total de páginas conocido/, "sin total no se inventa uno en el mensaje")
    const own = new DomainError("CONFLICT", "propio")
    assert.equal(readingDomainError(own, "cycle"), own)
  })
})

describe("zona horaria de la persona", () => {
  test("zona no válida → UTC", () => {
    assert.equal(safeTimeZone("Europe/Madrid"), "Europe/Madrid")
    assert.equal(safeTimeZone("Marte/Olympus"), "UTC")
    assert.equal(safeTimeZone("'; drop table"), "UTC")
    assert.equal(safeTimeZone(undefined), "UTC")
  })

  test("medianoche local con horario de verano", () => {
    assert.equal(startOfCivilDay("2026-03-29", "Europe/Madrid").toISOString(), "2026-03-28T23:00:00.000Z")
    assert.equal(startOfCivilDay("2026-03-30", "Europe/Madrid").toISOString(), "2026-03-29T22:00:00.000Z")
    assert.equal(startOfCivilDay("2026-01-01", "Pacific/Auckland").toISOString(), "2025-12-31T11:00:00.000Z")
    assert.equal(startOfCivilDay("2026-01-01", "America/Los_Angeles").toISOString(), "2026-01-01T08:00:00.000Z")
  })

  test("el mismo instante es otro día y otro año según la zona", () => {
    const instant = new Date("2025-12-31T23:30:00Z")
    const madrid = readingPeriods(instant, "Europe/Madrid")
    assert.deepEqual({ today: madrid.today, year: madrid.year, yearSince: madrid.yearSince, sessionsFrom: madrid.sessionsFrom },
      { today: "2026-01-01", year: 2026, yearSince: "2025-12-31T23:00:00.000Z", sessionsFrom: "2025-12-03" })
    const mexico = readingPeriods(instant, "America/Mexico_City")
    assert.deepEqual({ today: mexico.today, year: mexico.year }, { today: "2025-12-31", year: 2025 })
  })

  test("las fechas se presentan en la zona indicada", () => {
    assert.match(formatInstant("2026-02-01T20:00:00Z", "Europe/Madrid"), /21:00/)
    assert.match(formatInstant("2026-02-01T20:00:00Z", "America/New_York"), /15:00/)
    assert.match(formatCivilDate("2026-09-26"), /26 sept 2026/)
    assert.equal(fromDateTimeLocalValue("ayer"), null)
    assert.equal(fromDateTimeLocalValue("2026-13-40T25:00"), null)
  })
})

describe("estadísticas solo con datos registrados", () => {
  const madridNow = new Date("2026-10-25T18:00:00Z")
  const periods = readingPeriods(madridNow, "Europe/Madrid")
  const empty: ReadingStatsInput = { entries: [], closed: [], closedWithoutDate: 0, openCycles: 0, totalCycles: 0, legacyReadWithoutCycles: 4 }

  test("cero ciclos: todo a cero con periodo y denominador; los leídos legados no reciben fecha", () => {
    const stats = summarizeReading(empty, periods)
    assert.deepEqual(stats.sessions, { entries: 0, activeDays: 0, days: 30, pages: 0, entriesWithRange: 0 })
    assert.deepEqual(stats.year, { finished: 0, abandoned: 0, closed: 0 })
    assert.equal(stats.totalCycles, 0)
    assert.equal(stats.legacyReadWithoutCycles, 4)
    assert.deepEqual({ from: stats.periods.sessionsFrom, today: stats.periods.today, year: stats.periods.year }, { from: "2026-09-26", today: "2026-10-25", year: 2026 })
  })

  test("varios ciclos: días activos por día local, páginas solo con rango y cierres del año en curso", () => {
    const stats = summarizeReading({
      entries: [
        { occurredAt: "2026-10-24T22:30:00Z", pageFrom: 10, pageTo: 40 }, // 25-10 a las 00:30 en Madrid
        { occurredAt: "2026-10-25T07:00:00Z", pageFrom: null, pageTo: 60 }, // mismo día local: sin rango, no suma páginas
        { occurredAt: "2026-10-20T19:00:00Z", pageFrom: 0, pageTo: 25 },
        { occurredAt: "2026-09-25T21:59:00Z", pageFrom: 0, pageTo: 500 }, // 25-09 en Madrid: fuera del periodo
      ],
      closed: [
        { status: "finished", finishedAt: "2026-02-01T20:00:00Z" },
        { status: "abandoned", finishedAt: "2026-06-01T20:00:00Z" },
        { status: "finished", finishedAt: "2025-12-31T22:30:00Z" }, // 31-12-2025 a las 23:30 en Madrid: año anterior
      ],
      closedWithoutDate: 2, openCycles: 1, totalCycles: 6, legacyReadWithoutCycles: 0,
    }, periods)
    assert.deepEqual(stats.sessions, { entries: 3, activeDays: 2, days: 30, pages: 55, entriesWithRange: 2 })
    assert.deepEqual(stats.year, { finished: 1, abandoned: 1, closed: 2 })
    assert.equal(stats.closedWithoutDate, 2, "un cierre sin fecha no entra en ningún periodo")
  })

  test("el día de una sesión depende de la zona de la persona", () => {
    const input = { ...empty, entries: [{ occurredAt: "2026-10-24T22:30:00Z", pageFrom: null, pageTo: 10 }, { occurredAt: "2026-10-25T07:00:00Z", pageFrom: null, pageTo: 20 }], totalCycles: 1 }
    assert.equal(summarizeReading(input, readingPeriods(madridNow, "Europe/Madrid")).sessions.activeDays, 1)
    assert.equal(summarizeReading(input, readingPeriods(madridNow, "UTC")).sessions.activeDays, 2)
  })
})

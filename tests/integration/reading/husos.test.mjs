import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { readingActionsContext, value } from "./lib/context.mjs"

// U-PRO-02 · Husos horarios: los instantes llegan con la zona de cada dispositivo y se guardan en UTC; las estadísticas
// cuentan días y años en la zona de la persona (la del navegador), de modo que dos sesiones a ambos lados de la medianoche
// UTC son un mismo día en Madrid, y un cierre en la Nochevieja UTC es del año nuevo en Madrid.

const HOUR = 3_600_000
let ctx, a, session, lib, base

/** Instante con un desfase fijo explícito, p. ej. +14:00 o -12:00, como lo enviaría un dispositivo en esa zona. */
function withOffset(ms, minutes) {
  const local = new Date(ms + minutes * 60_000).toISOString().slice(0, 19)
  const sign = minutes < 0 ? "-" : "+"
  const abs = Math.abs(minutes)
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`
}

before(async () => {
  ctx = await readingActionsContext()
  a = await ctx.account("a")
  session = await ctx.signIn(a)
  lib = await ctx.library(a.id)
  const today = new Date()
  // Medianoche UTC de hace cinco días: dentro del periodo de 30 días en cualquier zona.
  base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 5)
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

test("instantes con +14:00 y -12:00 se guardan y se devuelven en UTC", async () => {
  const cycle = value(await ctx.call("startReadingAction", [{ copyId: lib.books[0].id, startedAt: withOffset(base - 2 * HOUR, 14 * 60), expectedLatestCycleId: null }], session)).reading.cycles[0]
  value(await ctx.call("addReadingEntryAction", [{ cycleId: cycle.id, entryId: ctx.entryId(), occurredAt: withOffset(base - HOUR / 2, 14 * 60), pageTo: 10 }], session))
  value(await ctx.call("addReadingEntryAction", [{ cycleId: cycle.id, entryId: ctx.entryId(), occurredAt: withOffset(base + HOUR / 2, -12 * 60), pageTo: 20 }], session))
  const iso = (ms) => new Date(ms).toISOString()
  assert.deepEqual((await ctx.entries(lib.books[0].id)).map((row) => row.occurred_at), [iso(base - HOUR / 2), iso(base + HOUR / 2)])
  const view = value(await ctx.call("getCopyReadingAction", [lib.books[0].id], session))
  assert.equal(view.cycles[0].startedAt, iso(base - 2 * HOUR))
  assert.deepEqual(view.cycles[0].entries.map((entry) => entry.occurredAt), [iso(base + HOUR / 2), iso(base - HOUR / 2)], "más reciente primero, en UTC con Z")
})

test("las sesiones a ambos lados de la medianoche UTC son dos días en UTC y uno en Madrid, Nueva York o Kiritimati", async () => {
  const days = {}
  for (const zone of ["UTC", "Europe/Madrid", "America/New_York", "Pacific/Kiritimati"]) {
    const stats = value(await ctx.call("getReadingStatsAction", [{ timeZone: zone }], session))
    assert.equal(stats.periods.timeZone, zone)
    assert.equal(stats.sessions.entries, 2, zone)
    days[zone] = stats.sessions.activeDays
  }
  assert.deepEqual(days, { UTC: 2, "Europe/Madrid": 1, "America/New_York": 1, "Pacific/Kiritimati": 1 })
  const unknown = value(await ctx.call("getReadingStatsAction", [{ timeZone: "Marte/Olympus" }], session))
  assert.equal(unknown.periods.timeZone, "UTC", "una zona desconocida no rompe el cálculo")
})

test("un cierre en la Nochevieja UTC cuenta en el año nuevo de Madrid y en el anterior en UTC", async () => {
  const year = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric" }).format(new Date()))
  const cycle = value(await ctx.call("startReadingAction", [{ copyId: lib.books[1].id, startedAt: null, expectedLatestCycleId: null }], session)).reading.cycles[0]
  value(await ctx.call("closeReadingAction", [{ cycleId: cycle.id, expectedVersion: cycle.version, status: "finished", finishedAt: `${year}-01-01T00:30:00+01:00`, confirm: true }], session))
  assert.equal((await ctx.cycles(lib.books[1].id))[0].finished_at, `${year - 1}-12-31T23:30:00.000Z`)
  const madrid = value(await ctx.call("getReadingStatsAction", [{ timeZone: "Europe/Madrid" }], session))
  const utc = value(await ctx.call("getReadingStatsAction", [{ timeZone: "UTC" }], session))
  assert.deepEqual([madrid.periods.year, madrid.year.finished], [year, 1])
  assert.equal(utc.year.finished, 0)
  assert.equal(madrid.periods.yearSince, `${year - 1}-12-31T23:00:00.000Z`, "el año empieza a medianoche de Madrid")
})

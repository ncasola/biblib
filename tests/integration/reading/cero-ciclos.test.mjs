import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { readingActionsContext, value } from "./lib/context.mjs"

// U-PRO-02 · Cero ciclos y estado `read` legado: una cuenta con libros marcados como leídos y ninguna lectura registrada
// no tiene sesiones, ni lecturas terminadas, ni «Seguir leyendo»; el libro leído no recibe ciclo ni fecha, ni al leerlo
// ni al pedir sus estadísticas, y se menciona aparte como legado sin fecha.

let ctx, a, session, lib

before(async () => {
  ctx = await readingActionsContext()
  a = await ctx.account("a")
  session = await ctx.signIn(a)
  lib = await ctx.library(a.id)
  await ctx.sql`update biblib.copies set status = 'read' where id in ${ctx.sql([lib.books[0].id, lib.books[1].id])}`
  await ctx.sql`update biblib.copies set status = 'reading' where id = ${lib.books[2].id}`
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

test("estadísticas con cero ciclos: todo a cero, con periodo y denominador, y los leídos legados aparte", async () => {
  const stats = value(await ctx.call("getReadingStatsAction", [{ timeZone: "Europe/Madrid" }], session))
  assert.deepEqual(stats.sessions, { entries: 0, activeDays: 0, days: 30, pages: 0, entriesWithRange: 0 })
  assert.deepEqual(stats.year, { finished: 0, abandoned: 0, closed: 0 })
  assert.deepEqual({ total: stats.totalCycles, open: stats.openCycles, undated: stats.closedWithoutDate, legacy: stats.legacyReadWithoutCycles }, { total: 0, open: 0, undated: 0, legacy: 2 })
  assert.match(stats.periods.sessionsFrom, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(stats.periods.timeZone, "Europe/Madrid")
})

test("«Seguir leyendo» no deduce lecturas del estado actual: sin ciclos abiertos, vacío aunque haya un libro «Leyendo»", async () => {
  assert.deepEqual(value(await ctx.call("getContinueReadingAction", [], session)), { items: [], open: 0 })
})

test("consultar la lectura de un libro leído no crea ciclos ni fechas", async () => {
  const view = value(await ctx.call("getCopyReadingAction", [lib.books[0].id], session))
  assert.deepEqual(view.cycles, [])
  const [{ cycles, entries }] = await ctx.sql`select (select count(*)::int from biblib.reading_cycles where user_id = ${a.id}) as cycles,
    (select count(*)::int from biblib.reading_entries where user_id = ${a.id}) as entries`
  assert.deepEqual({ cycles, entries }, { cycles: 0, entries: 0 })
  assert.equal((await ctx.copy(lib.books[0].id)).status, "read")
})

test("al empezar a leer un libro legado, sus estadísticas solo cuentan lo registrado desde entonces", async () => {
  const started = value(await ctx.call("startReadingAction", [{ copyId: lib.books[0].id, startedAt: null, expectedLatestCycleId: null }], session))
  assert.deepEqual(started.reading.cycles.map((cycle) => [cycle.cycleNumber, cycle.startedAt, cycle.finishedAt]), [[1, null, null]], "sin fechas inventadas")
  const stats = value(await ctx.call("getReadingStatsAction", [{ timeZone: "UTC" }], session))
  assert.deepEqual({ total: stats.totalCycles, open: stats.openCycles, legacy: stats.legacyReadWithoutCycles, finished: stats.year.finished }, { total: 1, open: 1, legacy: 1, finished: 0 })
})

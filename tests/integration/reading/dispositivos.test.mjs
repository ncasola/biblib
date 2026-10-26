import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { errorCode, readingActionsContext, value } from "./lib/context.mjs"

// U-PRO-02 · Dos dispositivos de la misma cuenta (dos sesiones GoTrue) usan las acciones a la vez: iniciar no crea dos
// ciclos abiertos y ambos ven el mismo; quien actúa con una versión vieja recibe CONFLICT y no pisa al otro; sus sesiones
// conviven sin perderse. El estado actual del ejemplar no cambia.

let ctx, a, phone, laptop, lib

before(async () => {
  ctx = await readingActionsContext()
  a = await ctx.account("a")
  ;[phone, laptop] = [await ctx.signIn(a), await ctx.signIn(a)]
  lib = await ctx.library(a.id)
  await ctx.setPages(lib.books[0].id, 400)
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

test("iniciar a la vez desde dos dispositivos: un solo ciclo abierto, el mismo para ambos y ninguno es un error", async () => {
  const copyId = lib.books[0].id
  const before = await ctx.copy(copyId)
  const input = { copyId, startedAt: "2026-10-01T08:00:00Z", expectedLatestCycleId: null }
  const [one, two] = await Promise.all([ctx.call("startReadingAction", [input], phone), ctx.call("startReadingAction", [{ ...input, startedAt: "2026-10-01T08:00:30Z" }], laptop)])
  const outcomes = [value(one).outcome, value(two).outcome].sort()
  assert.deepEqual(outcomes, ["already-open", "applied"])
  assert.equal(value(one).reading.cycles[0].id, value(two).reading.cycles[0].id)
  const cycles = await ctx.cycles(copyId)
  assert.equal(cycles.length, 1)
  assert.equal(cycles[0].status, "reading")
  assert.deepEqual(await ctx.copy(copyId), before, "leer no cambia el estado ni la versión del ejemplar")
})

test("una versión vista en el otro dispositivo es un conflicto y no pisa el cambio", async () => {
  const copyId = lib.books[0].id
  const seen = value(await ctx.call("getCopyReadingAction", [copyId], laptop)).cycles[0]
  value(await ctx.call("pauseReadingAction", [{ cycleId: seen.id, expectedVersion: seen.version }], phone))
  const stale = await ctx.call("closeReadingAction", [{ cycleId: seen.id, expectedVersion: seen.version, status: "finished", finishedAt: "2026-10-20T20:00:00Z", confirm: true }], laptop)
  assert.equal(errorCode(stale), "CONFLICT")
  assert.match(stale.value.error.message, /otra pestaña o dispositivo/)
  assert.equal((await ctx.cycles(copyId))[0].status, "paused", "la pausa del otro dispositivo sigue")
  // La pausa del otro dispositivo dejó el ciclo en «paused»: reanudar con la versión vieja tampoco la pisa.
  assert.equal(errorCode(await ctx.call("resumeReadingAction", [{ cycleId: seen.id, expectedVersion: seen.version }], laptop)), "CONFLICT")
  // Pedir la pausa con la versión vieja es redundante, no un conflicto: el estado ya es el pedido.
  assert.equal(value(await ctx.call("pauseReadingAction", [{ cycleId: seen.id, expectedVersion: seen.version }], laptop)).outcome, "retry")
  const fresh = value(await ctx.call("getCopyReadingAction", [copyId], laptop)).cycles[0]
  assert.equal(value(await ctx.call("resumeReadingAction", [{ cycleId: fresh.id, expectedVersion: fresh.version }], laptop)).outcome, "applied", "tras recargar, sí")
})

test("sesiones registradas a la vez desde los dos dispositivos se conservan las dos", async () => {
  const copyId = lib.books[0].id
  const cycle = value(await ctx.call("getCopyReadingAction", [copyId], phone)).cycles[0]
  const [first, second] = await Promise.all([
    ctx.call("addReadingEntryAction", [{ cycleId: cycle.id, entryId: ctx.entryId(), occurredAt: "2026-10-02T21:00:00Z", pageFrom: 0, pageTo: 30 }], phone),
    ctx.call("addReadingEntryAction", [{ cycleId: cycle.id, entryId: ctx.entryId(), occurredAt: "2026-10-03T07:30:00Z", pageFrom: 30, pageTo: 45, note: "En el tren" }], laptop),
  ])
  assert.deepEqual([errorCode(first), errorCode(second)], ["OK", "OK"])
  const entries = await ctx.entries(copyId)
  assert.deepEqual(entries.map((row) => [row.occurred_at, row.page_from, row.page_to, row.note]), [
    ["2026-10-02T21:00:00.000Z", 0, 30, null],
    ["2026-10-03T07:30:00.000Z", 30, 45, "En el tren"],
  ])
  const view = value(await ctx.call("getCopyReadingAction", [copyId], laptop))
  assert.equal(view.cycles[0].entries.length, 2, "el otro dispositivo ve ambas")
})

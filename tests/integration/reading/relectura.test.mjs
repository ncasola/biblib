import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { errorCode, readingActionsContext, value } from "./lib/context.mjs"

// U-PRO-02 · Relectura: un ciclo nuevo con el número siguiente que no toca los anteriores (estado, fechas ni sesiones).
// Exige confirmación y la última lectura vista; reabrir una lectura con otra en curso es «ya hay una lectura en curso».

let ctx, a, session, lib, first

before(async () => {
  ctx = await readingActionsContext()
  a = await ctx.account("a")
  session = await ctx.signIn(a)
  lib = await ctx.library(a.id)
  await ctx.setPages(lib.books[0].id, 250)
  await ctx.sql`update biblib.copies set status = 'read' where id = ${lib.books[0].id}`
  const started = value(await ctx.call("startReadingAction", [{ copyId: lib.books[0].id, startedAt: "2025-03-01T09:00:00Z", expectedLatestCycleId: null }], session))
  first = started.reading.cycles[0]
  value(await ctx.call("addReadingEntryAction", [{ cycleId: first.id, entryId: ctx.entryId(), occurredAt: "2025-03-02T21:00:00Z", pageFrom: 0, pageTo: 250 }], session))
  const seen = value(await ctx.call("getCopyReadingAction", [lib.books[0].id], session)).cycles[0]
  value(await ctx.call("closeReadingAction", [{ cycleId: seen.id, expectedVersion: seen.version, status: "finished", finishedAt: "2025-03-20T22:00:00Z", confirm: true }], session))
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

test("la relectura exige confirmarla y la última lectura vista", async () => {
  const copyId = lib.books[0].id
  const unconfirmed = await ctx.call("startReadingAction", [{ copyId, startedAt: null, expectedLatestCycleId: first.id }], session)
  assert.equal(errorCode(unconfirmed), "INVALID_INPUT")
  assert.match(unconfirmed.value.error.message, /relectura/)
  const stale = await ctx.call("startReadingAction", [{ copyId, startedAt: null, expectedLatestCycleId: null, confirmReread: true }], session)
  assert.equal(errorCode(stale), "CONFLICT", "quien no vio la primera lectura no crea otra a ciegas")
  assert.equal((await ctx.cycles(copyId)).length, 1)
})

test("releer crea la lectura n.º 2 y la primera conserva estado, fechas y sesiones", async () => {
  const copyId = lib.books[0].id
  const before = { cycles: await ctx.cycles(copyId), entries: await ctx.entries(copyId), copy: await ctx.copy(copyId) }
  const reread = value(await ctx.call("startReadingAction", [{ copyId, startedAt: "2026-09-01T08:00:00Z", expectedLatestCycleId: first.id, confirmReread: true }], session))
  assert.equal(reread.outcome, "applied")
  assert.deepEqual(reread.reading.cycles.map((cycle) => [cycle.cycleNumber, cycle.status]), [[2, "reading"], [1, "finished"]])
  const after = await ctx.cycles(copyId)
  assert.deepEqual(after[0], before.cycles[0], "la primera lectura no cambia (ni su versión)")
  assert.deepEqual(after[1].started_at, "2026-09-01T08:00:00.000Z")
  assert.deepEqual(await ctx.entries(copyId), before.entries)
  assert.deepEqual(await ctx.copy(copyId), before.copy, "el estado «leído» y la versión del ejemplar no cambian")
})

test("reabrir la primera con la relectura en curso: «ya hay una lectura en curso» (23505) y nada cambia", async () => {
  const copyId = lib.books[0].id
  const view = value(await ctx.call("getCopyReadingAction", [copyId], session))
  const old = view.cycles.find((cycle) => cycle.cycleNumber === 1)
  const reopened = await ctx.call("reopenReadingAction", [{ cycleId: old.id, expectedVersion: old.version, confirm: true }], session)
  assert.equal(errorCode(reopened), "CONFLICT")
  assert.match(reopened.value.error.message, /ya hay una lectura en curso/i)
  assert.equal((await ctx.cycles(copyId))[0].status, "finished")
})

test("abandonar la relectura y reabrirla: vuelve a «Leyendo» sin fecha de fin y conserva su inicio", async () => {
  const copyId = lib.books[0].id
  const current = value(await ctx.call("getCopyReadingAction", [copyId], session)).cycles[0]
  const abandoned = value(await ctx.call("closeReadingAction", [{ cycleId: current.id, expectedVersion: current.version, status: "abandoned", finishedAt: null, confirm: true }], session))
  assert.deepEqual([abandoned.reading.cycles[0].status, abandoned.reading.cycles[0].finishedAt], ["abandoned", null], "sin fecha, ninguna inventada")
  const closed = abandoned.reading.cycles[0]
  value(await ctx.call("reopenReadingAction", [{ cycleId: closed.id, expectedVersion: closed.version, confirm: true }], session))
  const [, second] = await ctx.cycles(copyId)
  assert.deepEqual({ status: second.status, started: second.started_at, finished: second.finished_at }, { status: "reading", started: "2026-09-01T08:00:00.000Z", finished: null })
})

test("las fechas cruzadas (fin antes del inicio) se rechazan con un mensaje claro", async () => {
  const current = value(await ctx.call("getCopyReadingAction", [lib.books[0].id], session)).cycles[0]
  const crossed = await ctx.call("closeReadingAction", [{ cycleId: current.id, expectedVersion: current.version, status: "finished", finishedAt: "2026-08-01T08:00:00Z", confirm: true }], session)
  assert.equal(errorCode(crossed), "INVALID_INPUT")
  assert.match(crossed.value.error.message, /fin no puede ser anterior/)
  assert.equal((await ctx.cycles(lib.books[0].id))[1].status, "reading")
})

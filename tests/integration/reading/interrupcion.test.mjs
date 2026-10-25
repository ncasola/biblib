import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { errorCode, readingActionsContext, value } from "./lib/context.mjs"

// U-PRO-02 · Interrupción de red: el navegador pierde la respuesta y repite exactamente la misma petición. Cada acción
// reconoce su propio reintento (`retry` o `already-open`) sin duplicar ni dar conflicto; una repetición con datos distintos
// sí es un conflicto.

let ctx, a, session, lib, cycle

before(async () => {
  ctx = await readingActionsContext()
  a = await ctx.account("a")
  session = await ctx.signIn(a)
  lib = await ctx.library(a.id)
  await ctx.setPages(lib.books[0].id, 300)
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

const again = async (name, args) => [await ctx.call(name, args, session), await ctx.call(name, args, session)]

test("iniciar dos veces: la segunda devuelve el ciclo abierto sin crear otro", async () => {
  const [first, second] = await again("startReadingAction", [{ copyId: lib.books[0].id, startedAt: null, expectedLatestCycleId: null }])
  assert.equal(value(first).outcome, "applied")
  assert.equal(value(second).outcome, "already-open")
  cycle = value(second).reading.cycles[0]
  assert.equal((await ctx.cycles(lib.books[0].id)).length, 1)
  assert.equal(cycle.startedAt, null, "sin fecha de inicio no se rellena con la actual")
})

test("registrar la misma sesión dos veces (mismo ID) no la duplica", async () => {
  const args = [{ cycleId: cycle.id, entryId: ctx.entryId(), occurredAt: "2026-10-10T20:15:00+02:00", pageFrom: 0, pageTo: 25, note: "Corte de red" }]
  const [first, second] = await again("addReadingEntryAction", args)
  assert.deepEqual([value(first).outcome, value(second).outcome], ["applied", "retry"])
  assert.equal((await ctx.entries(lib.books[0].id)).length, 1)
  const reused = await ctx.call("addReadingEntryAction", [{ ...args[0], pageTo: 26 }], session)
  assert.equal(errorCode(reused), "CONFLICT", "el mismo ID con otros datos no es un reintento")
  assert.equal((await ctx.entries(lib.books[0].id)).length, 1)
})

test("corregir y borrar repetidos con la versión vieja: reintento propio", async () => {
  const [entry] = value(await ctx.call("getCopyReadingAction", [lib.books[0].id], session)).cycles[0].entries
  const fix = [{ entryId: entry.id, expectedVersion: entry.version, occurredAt: entry.occurredAt, pageFrom: 0, pageTo: 28, note: "Corte de red" }]
  const [first, second] = await again("updateReadingEntryAction", fix)
  assert.deepEqual([value(first).outcome, value(second).outcome], ["applied", "retry"])
  const other = await ctx.call("updateReadingEntryAction", [{ ...fix[0], pageTo: 29 }], session)
  assert.equal(errorCode(other), "CONFLICT", "otra corrección con la versión vieja sí es un conflicto")
  const [current] = value(await ctx.call("getCopyReadingAction", [lib.books[0].id], session)).cycles[0].entries
  const [removed, removedAgain] = await again("deleteReadingEntryAction", [{ entryId: current.id, copyId: lib.books[0].id, expectedVersion: current.version, confirm: true }])
  assert.deepEqual([value(removed).outcome, value(removedAgain).outcome], ["applied", "retry"])
  assert.deepEqual(await ctx.entries(lib.books[0].id), [])
})

test("terminar dos veces con la misma fecha: reintento; con otra fecha o abandonando, conflicto", async () => {
  const [seen] = value(await ctx.call("getCopyReadingAction", [lib.books[0].id], session)).cycles
  const close = { cycleId: seen.id, expectedVersion: seen.version, status: "finished", finishedAt: "2026-10-12T22:00:00+02:00", confirm: true }
  const [first, second] = await again("closeReadingAction", [close])
  assert.deepEqual([value(first).outcome, value(second).outcome], ["applied", "retry"])
  assert.equal(errorCode(await ctx.call("closeReadingAction", [{ ...close, finishedAt: "2026-10-13T22:00:00Z" }], session)), "CONFLICT")
  assert.equal(errorCode(await ctx.call("closeReadingAction", [{ ...close, status: "abandoned" }], session)), "CONFLICT")
  const [stored] = await ctx.cycles(lib.books[0].id)
  assert.deepEqual({ status: stored.status, finished: stored.finished_at }, { status: "finished", finished: "2026-10-12T20:00:00.000Z" })
})

test("reabrir dos veces: la segunda ya lo encuentra en curso", async () => {
  const [seen] = value(await ctx.call("getCopyReadingAction", [lib.books[0].id], session)).cycles
  const [first, second] = await again("reopenReadingAction", [{ cycleId: seen.id, expectedVersion: seen.version, confirm: true }])
  assert.deepEqual([value(first).outcome, value(second).outcome], ["applied", "retry"])
  const [stored] = await ctx.cycles(lib.books[0].id)
  assert.deepEqual({ status: stored.status, finished: stored.finished_at }, { status: "reading", finished: null })
})

test("sin confirmación no se termina, no se reabre ni se borra", async () => {
  const [seen] = value(await ctx.call("getCopyReadingAction", [lib.books[0].id], session)).cycles
  assert.equal(errorCode(await ctx.call("closeReadingAction", [{ cycleId: seen.id, expectedVersion: seen.version, status: "finished", finishedAt: null }], session)), "INVALID_INPUT")
  assert.equal((await ctx.cycles(lib.books[0].id))[0].status, "reading")
})

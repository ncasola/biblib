import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { errorCode, readingActionsContext, value } from "./lib/context.mjs"

// U-PRO-02 · Aislamiento A/B por las acciones: B conoce los IDs de A (ejemplar, ciclo, entrada y versiones) y prueba cada
// acción de lectura. Recibe NOT_FOUND como si no existieran, A no cambia y las estadísticas y «Seguir leyendo» de B no
// cuentan nada de A. El anónimo no llega a las acciones. Una cuenta en eliminación no escribe por ninguna (ACCOUNT_INACTIVE).

let ctx, a, b, c, sessionA, sessionB, sessionC, libA, libB, libC, cycleA, entryA

before(async () => {
  ctx = await readingActionsContext()
  a = await ctx.account("a")
  b = await ctx.account("b")
  c = await ctx.account("c")
  ;[sessionA, sessionB, sessionC] = [await ctx.signIn(a), await ctx.signIn(b), await ctx.signIn(c)]
  ;[libA, libB, libC] = [await ctx.library(a.id), await ctx.library(b.id), await ctx.library(c.id)]
  cycleA = value(await ctx.call("startReadingAction", [{ copyId: libA.books[0].id, startedAt: "2026-10-01T08:00:00Z", expectedLatestCycleId: null }], sessionA)).reading.cycles[0]
  const added = value(await ctx.call("addReadingEntryAction", [{ cycleId: cycleA.id, entryId: ctx.entryId(), occurredAt: "2026-10-02T21:00:00Z", pageTo: 40, note: "Privada de A" }], sessionA))
  cycleA = added.reading.cycles[0]
  entryA = cycleA.entries[0]
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

const snapshot = async (copyId) => ({ cycles: await ctx.cycles(copyId), entries: await ctx.entries(copyId), copy: await ctx.copy(copyId) })

test("B con los IDs de A: NOT_FOUND en cada acción y A no cambia", async () => {
  const before = await snapshot(libA.books[0].id)
  const attempts = {
    read: await ctx.call("getCopyReadingAction", [libA.books[0].id], sessionB),
    start: await ctx.call("startReadingAction", [{ copyId: libA.books[0].id, startedAt: null, expectedLatestCycleId: cycleA.id, confirmReread: true }], sessionB),
    pause: await ctx.call("pauseReadingAction", [{ cycleId: cycleA.id, expectedVersion: cycleA.version }], sessionB),
    resume: await ctx.call("resumeReadingAction", [{ cycleId: cycleA.id, expectedVersion: cycleA.version }], sessionB),
    close: await ctx.call("closeReadingAction", [{ cycleId: cycleA.id, expectedVersion: cycleA.version, status: "finished", finishedAt: null, confirm: true }], sessionB),
    reopen: await ctx.call("reopenReadingAction", [{ cycleId: cycleA.id, expectedVersion: cycleA.version, confirm: true }], sessionB),
    add: await ctx.call("addReadingEntryAction", [{ cycleId: cycleA.id, entryId: ctx.entryId(), occurredAt: "2026-10-03T21:00:00Z", note: "Intrusa" }], sessionB),
    update: await ctx.call("updateReadingEntryAction", [{ entryId: entryA.id, expectedVersion: entryA.version, occurredAt: entryA.occurredAt, pageTo: 41 }], sessionB),
    remove: await ctx.call("deleteReadingEntryAction", [{ entryId: entryA.id, copyId: libA.books[0].id, expectedVersion: entryA.version, confirm: true }], sessionB),
  }
  assert.deepEqual(Object.entries(attempts).filter(([, result]) => errorCode(result) !== "NOT_FOUND").map(([name, result]) => `${name}: ${errorCode(result)}`), [])
  // Con un ejemplar propio y la entrada de A, el borrado no encuentra nada que borrar y A sigue igual.
  const own = await ctx.call("deleteReadingEntryAction", [{ entryId: entryA.id, copyId: libB.books[0].id, expectedVersion: entryA.version, confirm: true }], sessionB)
  assert.equal(value(own).reading.cycles.length, 0)
  // El mismo ID de entrada que ya usa A no se puede reutilizar desde B.
  const cycleB = value(await ctx.call("startReadingAction", [{ copyId: libB.books[0].id, startedAt: null, expectedLatestCycleId: null }], sessionB)).reading.cycles[0]
  assert.equal(errorCode(await ctx.call("addReadingEntryAction", [{ cycleId: cycleB.id, entryId: entryA.id, occurredAt: "2026-10-03T21:00:00Z", note: "Choque" }], sessionB)), "CONFLICT")
  assert.deepEqual(await snapshot(libA.books[0].id), before, "A no cambia")
})

test("las estadísticas y «Seguir leyendo» de B no cuentan nada de A", async () => {
  const stats = value(await ctx.call("getReadingStatsAction", [{ timeZone: "UTC" }], sessionB))
  assert.deepEqual({ total: stats.totalCycles, entries: stats.sessions.entries }, { total: 1, entries: 0 }, "solo la lectura propia de B, sin sesiones")
  const { items } = value(await ctx.call("getContinueReadingAction", [], sessionB))
  assert.deepEqual(items.map((item) => item.book.id), [libB.books[0].id])
  const ownA = value(await ctx.call("getContinueReadingAction", [], sessionA))
  assert.deepEqual(ownA.items.map((item) => item.book.id), [libA.books[0].id])
})

test("el anónimo no llega a las acciones de lectura", async () => {
  const anonymous = await ctx.call("getCopyReadingAction", [libA.books[0].id], { cookies: () => [] })
  assert.ok([303, 307, 401].includes(anonymous.status) || errorCode(anonymous) === "UNAUTHORIZED", `respuesta ${errorCode(anonymous)}`)
})

test("una cuenta en eliminación no escribe por ninguna acción de lectura (ACCOUNT_INACTIVE) y no cambia nada", async () => {
  const cycleC = value(await ctx.call("startReadingAction", [{ copyId: libC.books[0].id, startedAt: null, expectedLatestCycleId: null }], sessionC)).reading.cycles[0]
  const withEntry = value(await ctx.call("addReadingEntryAction", [{ cycleId: cycleC.id, entryId: ctx.entryId(), occurredAt: "2026-10-04T21:00:00Z", pageTo: 12 }], sessionC)).reading.cycles[0]
  const entryC = withEntry.entries[0]
  await ctx.requestDeletion(c.id)
  const before = { first: await snapshot(libC.books[0].id), second: await snapshot(libC.books[1].id) }
  const attempts = {
    start: await ctx.call("startReadingAction", [{ copyId: libC.books[1].id, startedAt: null, expectedLatestCycleId: null }], sessionC),
    pause: await ctx.call("pauseReadingAction", [{ cycleId: withEntry.id, expectedVersion: withEntry.version }], sessionC),
    close: await ctx.call("closeReadingAction", [{ cycleId: withEntry.id, expectedVersion: withEntry.version, status: "abandoned", finishedAt: null, confirm: true }], sessionC),
    add: await ctx.call("addReadingEntryAction", [{ cycleId: withEntry.id, entryId: ctx.entryId(), occurredAt: "2026-10-05T21:00:00Z", pageTo: 20 }], sessionC),
    update: await ctx.call("updateReadingEntryAction", [{ entryId: entryC.id, expectedVersion: entryC.version, occurredAt: entryC.occurredAt, pageTo: 13 }], sessionC),
    remove: await ctx.call("deleteReadingEntryAction", [{ entryId: entryC.id, copyId: libC.books[0].id, expectedVersion: entryC.version, confirm: true }], sessionC),
  }
  assert.deepEqual(Object.entries(attempts).filter(([, result]) => errorCode(result) !== "ACCOUNT_INACTIVE").map(([name, result]) => `${name}: ${errorCode(result)}`), [])
  assert.match(attempts.add.value.error.message, /se está eliminando/)
  assert.deepEqual({ first: await snapshot(libC.books[0].id), second: await snapshot(libC.books[1].id) }, before)
  assert.equal(errorCode(await ctx.call("getCopyReadingAction", [libC.books[0].id], sessionC)), "OK", "sigue leyendo lo suyo")
})

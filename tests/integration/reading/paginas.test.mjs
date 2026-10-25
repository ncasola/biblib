import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { errorCode, readingActionsContext, value } from "./lib/context.mjs"

// U-PRO-02 · Páginas y progreso: con el total desconocido (0) se registra la página sin porcentaje en la ficha ni en
// «Seguir leyendo»; con total conocido no se admite una página negativa ni por encima de él; un total corregido a la baja
// después no bloquea editar la nota ni inventa un porcentaje.

let ctx, a, session, lib, known, unknown

before(async () => {
  ctx = await readingActionsContext()
  a = await ctx.account("a")
  session = await ctx.signIn(a)
  lib = await ctx.library(a.id)
  await ctx.setPages(lib.books[0].id, 300)
  await ctx.setPages(lib.books[1].id, 0)
  known = value(await ctx.call("startReadingAction", [{ copyId: lib.books[0].id, startedAt: null, expectedLatestCycleId: null }], session)).reading
  unknown = value(await ctx.call("startReadingAction", [{ copyId: lib.books[1].id, startedAt: null, expectedLatestCycleId: null }], session)).reading
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

const add = (cycleId, fields) => ctx.call("addReadingEntryAction", [{ cycleId, entryId: ctx.entryId(), occurredAt: "2026-10-05T20:00:00Z", ...fields }], session)

test("copia sin páginas: se registra la página y no hay porcentaje en la ficha ni en el inicio", async () => {
  assert.equal(unknown.totalPages, null)
  const saved = value(await add(unknown.cycles[0].id, { pageTo: 4000 })).reading
  assert.equal(saved.totalPages, null)
  assert.equal(saved.cycles[0].entries[0].pageTo, 4000)
  const { items } = value(await ctx.call("getContinueReadingAction", [], session))
  const item = items.find((entry) => entry.book.id === lib.books[1].id)
  assert.deepEqual(item.progress, { page: 4000, total: null, percent: null })
})

test("con total conocido: porcentaje real; negativa, invertida o por encima del total se rechazan sin escribir", async () => {
  value(await add(known.cycles[0].id, { pageFrom: 0, pageTo: 150 }))
  const { items } = value(await ctx.call("getContinueReadingAction", [], session))
  assert.deepEqual(items.find((entry) => entry.book.id === lib.books[0].id).progress, { page: 150, total: 300, percent: 50 })
  const attempts = { above: await add(known.cycles[0].id, { pageTo: 301 }), negative: await add(known.cycles[0].id, { pageTo: -1 }),
    backwards: await add(known.cycles[0].id, { pageFrom: 40, pageTo: 20 }), empty: await add(known.cycles[0].id, { note: "  " }) }
  assert.deepEqual(Object.fromEntries(Object.entries(attempts).map(([name, result]) => [name, errorCode(result)])),
    { above: "INVALID_INPUT", negative: "INVALID_INPUT", backwards: "INVALID_INPUT", empty: "INVALID_INPUT" })
  assert.match(attempts.above.value.error.message, /supera el total de esta edición \(300\)/)
  assert.equal((await ctx.entries(lib.books[0].id)).length, 1)
})

test("un total corregido a la baja después: la nota se edita, la página no sube y no hay porcentaje", async () => {
  await ctx.setPages(lib.books[0].id, 100)
  const [entry] = value(await ctx.call("getCopyReadingAction", [lib.books[0].id], session)).cycles[0].entries
  const noted = value(await ctx.call("updateReadingEntryAction", [{ entryId: entry.id, expectedVersion: entry.version, occurredAt: entry.occurredAt, pageFrom: 0, pageTo: 150, note: "Total corregido" }], session))
  const updated = noted.reading.cycles[0].entries[0]
  assert.equal(updated.note, "Total corregido")
  const raised = await ctx.call("updateReadingEntryAction", [{ entryId: updated.id, expectedVersion: updated.version, occurredAt: updated.occurredAt, pageFrom: 0, pageTo: 160, note: "Total corregido" }], session)
  assert.equal(errorCode(raised), "INVALID_INPUT")
  const { items } = value(await ctx.call("getContinueReadingAction", [], session))
  assert.deepEqual(items.find((item) => item.book.id === lib.books[0].id).progress, { page: 150, total: 100, percent: null })
})

import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { readingProgress } from "../../../lib/product/reading-loans.ts"
import { readingContext } from "./lib/context.mjs"

// O14 · 0015. Lectura en Postgres real: un ciclo abierto por ejemplar aunque dos dispositivos lo inicien a la vez, una
// relectura que conserva la historia, páginas fuera de rango y total desconocido sin porcentaje inventado, instantes en
// UTC y ningún ciclo deducido del estado `read` actual.

let ctx, a, lib

before(async () => {
  ctx = await readingContext()
  a = await ctx.account("a")
  lib = await ctx.library(a.id)
  await ctx.setPages(lib.books[0].id, 300)
  await ctx.sql`update biblib.copies set status = 'read' where id = ${lib.books[1].id}`
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

const start = (tx, copyId, startedAt = null) => tx`select biblib.reading_cycle_start(${copyId}::uuid, ${startedAt}::timestamptz) as result`.then(([row]) => row.result)

test("dos dispositivos inician la misma lectura a la vez: un solo ciclo abierto y el mismo para ambos", async () => {
  const [first, second] = await Promise.all([
    ctx.asUser(a.id, (tx) => start(tx, lib.books[0].id, "2026-01-10T10:00:00Z")),
    ctx.asUserElsewhere(a.id, (tx) => start(tx, lib.books[0].id, "2026-01-10T10:00:05Z")),
  ])
  assert.deepEqual([first.status, second.status].sort(), ["open", "started"])
  assert.equal(first.cycle_id, second.cycle_id)
  const [{ n }] = await ctx.sql`select count(*)::int as n from biblib.reading_cycles where copy_id = ${lib.books[0].id} and status in ('reading', 'paused')`
  assert.equal(n, 1)
})

test("terminar con la versión y releer crea el ciclo 2; el 1 conserva estado y fechas, y el ejemplar no cambia", async () => {
  const [before] = await ctx.sql`select status, version from biblib.copies where id = ${lib.books[0].id}`
  const [cycle] = await ctx.sql`select id, version from biblib.reading_cycles where copy_id = ${lib.books[0].id} and cycle_number = 1`
  const stale = await ctx.asUser(a.id, async (tx) => (await tx`select biblib.reading_cycle_close(${cycle.id}::uuid, gen_random_uuid(), 'finished', '2026-02-01T20:00:00Z') as result`)[0].result)
  assert.equal(stale.status, "conflict", "otra pestaña con una versión anterior no cierra")
  const closed = await ctx.asUser(a.id, async (tx) => (await tx`select biblib.reading_cycle_close(${cycle.id}::uuid, ${cycle.version}::uuid, 'finished', '2026-02-01T21:00:00+01:00') as result`)[0].result)
  assert.equal(closed.status, "closed")
  const retry = await ctx.asUser(a.id, async (tx) => (await tx`select biblib.reading_cycle_close(${cycle.id}::uuid, ${cycle.version}::uuid, 'finished', '2026-02-01T20:00:00Z') as result`)[0].result)
  assert.equal(retry.status, "already_closed", "un reintento tras una respuesta perdida ve el cierre")
  const reread = await ctx.asUser(a.id, (tx) => start(tx, lib.books[0].id))
  assert.equal(reread.status, "started")
  assert.equal(reread.cycle_number, 2)
  const cycles = await ctx.sql`select cycle_number, status, to_char(started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as started, to_char(finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as finished
    from biblib.reading_cycles where copy_id = ${lib.books[0].id} order by cycle_number`
  assert.deepEqual(cycles.map((row) => ({ ...row })), [
    { cycle_number: 1, status: "finished", started: "2026-01-10T10:00:00Z", finished: "2026-02-01T20:00:00Z" },
    { cycle_number: 2, status: "reading", started: null, finished: null },
  ], "fin guardado en UTC; la relectura sin fecha de inicio no recibe la actual")
  const [after] = await ctx.sql`select status, version from biblib.copies where id = ${lib.books[0].id}`
  assert.deepEqual({ ...after }, { ...before }, "leer no cambia el estado ni la versión del ejemplar")
})

test("páginas: dentro del total conocido, nunca por encima (BR001); con total desconocido se registran sin porcentaje", async () => {
  const [cycle] = await ctx.sql`select id from biblib.reading_cycles where copy_id = ${lib.books[0].id} and cycle_number = 2`
  const unknown = await ctx.asUser(a.id, (tx) => start(tx, lib.books[2].id, "2026-03-01T09:00:00Z"))
  const codes = await ctx.rolledBack(a.id, async (tx) => ({
    last: await ctx.state(tx, (sp) => sp`insert into biblib.reading_entries (user_id, cycle_id, occurred_at, page_from, page_to) values (${a.id}, ${cycle.id}, '2026-03-02T21:30:00+01:00', 250, 300)`),
    beyond: await ctx.state(tx, (sp) => sp`insert into biblib.reading_entries (user_id, cycle_id, occurred_at, page_to) values (${a.id}, ${cycle.id}, now(), 301)`),
    negative: await ctx.state(tx, (sp) => sp`insert into biblib.reading_entries (user_id, cycle_id, occurred_at, page_to) values (${a.id}, ${cycle.id}, now(), -1)`),
    backwards: await ctx.state(tx, (sp) => sp`insert into biblib.reading_entries (user_id, cycle_id, occurred_at, page_from, page_to) values (${a.id}, ${cycle.id}, now(), 20, 10)`),
    empty: await ctx.state(tx, (sp) => sp`insert into biblib.reading_entries (user_id, cycle_id, occurred_at) values (${a.id}, ${cycle.id}, now())`),
    noInstant: await ctx.state(tx, (sp) => sp`insert into biblib.reading_entries (user_id, cycle_id, note) values (${a.id}, ${cycle.id}, 'Sin instante')`),
    unknownTotal: await ctx.state(tx, (sp) => sp`insert into biblib.reading_entries (user_id, cycle_id, occurred_at, page_to) values (${a.id}, ${unknown.cycle_id}, now(), 4000)`),
    stored: (await tx`select to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at from biblib.reading_entries where cycle_id = ${cycle.id} and page_to = 300`)[0]?.at,
  }))
  assert.deepEqual(codes, { last: null, beyond: "BR001", negative: "23514", backwards: "23514", empty: "23514", noInstant: "23502", unknownTotal: null, stored: "2026-03-02T20:30:00Z" })
  const [{ pages }] = await ctx.sql`select e.number_of_pages as pages from biblib.copies c join biblib.editions e on e.id = c.edition_id where c.id = ${lib.books[2].id}`
  assert.equal(pages, 0)
  assert.deepEqual(readingProgress(4000, pages), { page: 4000, total: null, percent: null }, "sin total conocido no hay porcentaje")
  assert.deepEqual(readingProgress(150, 300), { page: 150, total: 300, percent: 50 })
})

test("el estado read actual no se convierte en ciclos, sesiones ni fechas", async () => {
  const [{ cycles, status }] = await ctx.sql`select (select count(*)::int from biblib.reading_cycles where copy_id = ${lib.books[1].id}) as cycles, (select status from biblib.copies where id = ${lib.books[1].id}) as status`
  assert.deepEqual({ cycles, status }, { cycles: 0, status: "read" })
})

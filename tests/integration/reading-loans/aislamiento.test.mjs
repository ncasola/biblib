import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { readingContext } from "./lib/context.mjs"

// O14 · 0015. Aislamiento A/B en Postgres real con los roles de Supabase y los claims del dueño: B no lee, no escribe a
// nombre de A ni cita ejemplares o ciclos de A, y las funciones de lectura y préstamo no le revelan nada. Una cuenta en
// eliminación no escribe ni por SQL ni por las funciones. Cada intento ocurre en una transacción revertida.

let ctx, a, b, libA, libB, seeded

before(async () => {
  ctx = await readingContext()
  a = await ctx.account("a")
  b = await ctx.account("b")
  libA = await ctx.library(a.id)
  libB = await ctx.library(b.id)
  seeded = await ctx.asUser(a.id, async (tx) => {
    const [started] = await tx`select biblib.reading_cycle_start(${libA.books[0].id}::uuid, '2026-10-01T08:00:00Z') as result`
    const cycle = started.result.cycle_id
    await tx`insert into biblib.reading_entries (user_id, cycle_id, occurred_at, page_to, note) values (${a.id}, ${cycle}, '2026-10-02T21:00:00Z', 40, 'Nota privada de A')`
    const [opened] = await tx`select biblib.loan_open(${libA.books[1].id}::uuid, 'Prima Lola', '2026-10-03', null, null) as result`
    return { cycle, cycleVersion: started.result.version, loan: opened.result.loan_id, loanVersion: opened.result.version }
  })
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

const TABLES = ["reading_cycles", "reading_entries", "loans"]

test("B no lee nada de la lectura ni de los préstamos de A y A ve lo suyo", async () => {
  const seen = await ctx.rolledBack(b.id, async (tx) => Object.fromEntries(await Promise.all(TABLES.map(async (table) =>
    [table, (await tx`select count(*)::int as n from ${tx("biblib")}.${tx(table)} where user_id = ${a.id}`)[0].n]))))
  assert.deepEqual(seen, { reading_cycles: 0, reading_entries: 0, loans: 0 })
  const own = await ctx.rolledBack(a.id, async (tx) => Object.fromEntries(await Promise.all(TABLES.map(async (table) =>
    [table, (await tx`select count(*)::int as n from ${tx("biblib")}.${tx(table)}`)[0].n]))))
  assert.deepEqual(own, { reading_cycles: 1, reading_entries: 1, loans: 1 })
})

test("B no escribe a nombre de A ni cita ejemplares o ciclos de A; las funciones no le revelan nada", async () => {
  const codes = await ctx.rolledBack(b.id, async (tx) => ({
    loanForA: await ctx.state(tx, (sp) => sp`insert into biblib.loans (user_id, copy_id, borrower_label, loaned_on) values (${a.id}, ${libA.books[2].id}, 'Intruso', '2026-10-04')`),
    loanOnACopy: await ctx.state(tx, (sp) => sp`insert into biblib.loans (user_id, copy_id, borrower_label, loaned_on) values (${b.id}, ${libA.books[2].id}, 'Intruso', '2026-10-04')`),
    cycleOnACopy: await ctx.state(tx, (sp) => sp`insert into biblib.reading_cycles (user_id, copy_id, cycle_number) values (${b.id}, ${libA.books[2].id}, 1)`),
    entryInACycle: await ctx.state(tx, (sp) => sp`insert into biblib.reading_entries (user_id, cycle_id, occurred_at, note) values (${b.id}, ${seeded.cycle}, now(), 'Intrusa')`),
    updated: (await tx`update biblib.loans set returned_on = '2026-10-05' where id = ${seeded.loan}`).count,
    deleted: (await tx`delete from biblib.reading_cycles where id = ${seeded.cycle}`).count,
    start: (await tx`select biblib.reading_cycle_start(${libA.books[0].id}::uuid, null) as result`)[0].result.status,
    close: (await tx`select biblib.reading_cycle_close(${seeded.cycle}::uuid, ${seeded.cycleVersion}::uuid, 'finished', null) as result`)[0].result.status,
    open: (await tx`select biblib.loan_open(${libA.books[2].id}::uuid, 'Intruso', '2026-10-04', null, null) as result`)[0].result.status,
    give: (await tx`select biblib.loan_return(${seeded.loan}::uuid, ${seeded.loanVersion}::uuid, '2026-10-05') as result`)[0].result.status,
  }))
  assert.deepEqual(codes, { loanForA: "42501", loanOnACopy: "23503", cycleOnACopy: "23503", entryInACycle: "23503", updated: 0, deleted: 0,
    start: "not_found", close: "not_found", open: "not_found", give: "not_found" })
  const [loan] = await ctx.sql`select returned_on, version from biblib.loans where id = ${seeded.loan}`
  assert.deepEqual({ ...loan }, { returned_on: null, version: seeded.loanVersion }, "el préstamo de A sigue intacto")
})

test("B usa sus propios ejemplares con normalidad", async () => {
  const result = await ctx.rolledBack(b.id, async (tx) => ({
    start: (await tx`select biblib.reading_cycle_start(${libB.books[0].id}::uuid, null) as result`)[0].result.status,
    open: (await tx`select biblib.loan_open(${libB.books[0].id}::uuid, 'Vecino', '2026-10-04', '2026-11-04', null) as result`)[0].result.status,
  }))
  assert.deepEqual(result, { start: "started", open: "opened" })
})

test("una cuenta en eliminación no escribe lectura ni préstamos, tampoco por las funciones (BD001)", async () => {
  const codes = await ctx.rolledBack(a.id, async (tx) => {
    await tx`select biblib.account_deletion_request(${ctx.key("eliminar")})`
    return {
      start: await ctx.state(tx, (sp) => sp`select biblib.reading_cycle_start(${libA.books[2].id}::uuid, null)`),
      close: await ctx.state(tx, (sp) => sp`select biblib.reading_cycle_close(${seeded.cycle}::uuid, ${seeded.cycleVersion}::uuid, 'finished', null)`),
      open: await ctx.state(tx, (sp) => sp`select biblib.loan_open(${libA.books[2].id}::uuid, 'Tarde', '2026-10-04', null, null)`),
      give: await ctx.state(tx, (sp) => sp`select biblib.loan_return(${seeded.loan}::uuid, ${seeded.loanVersion}::uuid, '2026-10-05')`),
      entry: await ctx.state(tx, (sp) => sp`insert into biblib.reading_entries (user_id, cycle_id, occurred_at, note) values (${a.id}, ${seeded.cycle}, now(), 'Tarde')`),
      pause: await ctx.state(tx, (sp) => sp`update biblib.reading_cycles set status = 'paused' where id = ${seeded.cycle}`),
      forget: await ctx.state(tx, (sp) => sp`delete from biblib.loans where id = ${seeded.loan}`),
    }
  })
  assert.deepEqual(codes, { start: "BD001", close: "BD001", open: "BD001", give: "BD001", entry: "BD001", pause: "BD001", forget: "BD001" })
})

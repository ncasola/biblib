import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { readingContext, value } from "./lib/context.mjs"

// O14 · 0015. Préstamos en Postgres real: un préstamo activo por ejemplar aunque dos dispositivos presten a la vez,
// devolución con versión y préstamo sucesivo con su historial, fechas civiles idénticas en cualquier huso de sesión,
// independencia del estado de lectura (también cambiándolo por la app) y la copia borrada por la app sin restos.

let ctx, a, session, lib

before(async () => {
  ctx = await readingContext()
  a = await ctx.account("a")
  session = await ctx.signIn(a)
  lib = await ctx.library(a.id)
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

const lend = (tx, copyId, label, loanedOn, dueOn = null) =>
  tx`select biblib.loan_open(${copyId}::uuid, ${label}, ${loanedOn}::date, ${dueOn}::date, null) as result`.then(([row]) => row.result)

test("dos dispositivos prestan el mismo ejemplar a la vez: un solo préstamo activo", async () => {
  const [first, second] = await Promise.all([
    ctx.asUser(a.id, (tx) => lend(tx, lib.books[0].id, "Tía Ana", "2026-03-29")),
    ctx.asUserElsewhere(a.id, (tx) => lend(tx, lib.books[0].id, "Luis", "2026-03-29")),
  ])
  assert.deepEqual([first.status, second.status].sort(), ["active", "opened"])
  const [{ n }] = await ctx.sql`select count(*)::int as n from biblib.loans where copy_id = ${lib.books[0].id} and returned_on is null`
  assert.equal(n, 1)
  const direct = await ctx.rolledBack(a.id, (tx) => ctx.state(tx, (sp) => sp`insert into biblib.loans (user_id, copy_id, borrower_label, loaned_on) values (${a.id}, ${lib.books[0].id}, 'Otra', '2026-03-30')`))
  assert.equal(direct, "23505", "ni siquiera por SQL directo hay dos activos")
})

test("devolver con la versión libera el ejemplar; el préstamo sucesivo conserva el historial", async () => {
  const [loan] = await ctx.sql`select id, version from biblib.loans where copy_id = ${lib.books[0].id} and returned_on is null`
  const call = (statement) => ctx.asUser(a.id, async (tx) => (await statement(tx))[0].result)
  assert.equal((await call((tx) => tx`select biblib.loan_return(${loan.id}::uuid, gen_random_uuid(), '2026-04-05') as result`)).status, "conflict")
  const early = await ctx.rolledBack(a.id, (tx) => ctx.state(tx, (sp) => sp`select biblib.loan_return(${loan.id}::uuid, ${loan.version}::uuid, '2026-03-28')`))
  assert.equal(early, "23514", "no se devuelve antes de prestarse")
  assert.equal((await call((tx) => tx`select biblib.loan_return(${loan.id}::uuid, ${loan.version}::uuid, '2026-04-05') as result`)).status, "returned")
  const retry = await call((tx) => tx`select biblib.loan_return(${loan.id}::uuid, ${loan.version}::uuid, '2026-04-05') as result`)
  assert.deepEqual({ status: retry.status, returned_on: retry.returned_on }, { status: "already_returned", returned_on: "2026-04-05" }, "el reintento ve la devolución")
  const next = await ctx.asUser(a.id, (tx) => lend(tx, lib.books[0].id, "Luis", "2026-04-06", "2026-05-06"))
  assert.equal(next.status, "opened")
  const history = await ctx.sql`select borrower_label, loaned_on::text as loaned_on, due_on::text as due_on, returned_on::text as returned_on
    from biblib.loans where copy_id = ${lib.books[0].id} order by loaned_on`
  assert.deepEqual(history.map((row) => ({ ...row })), [
    { borrower_label: history[0].borrower_label, loaned_on: "2026-03-29", due_on: null, returned_on: "2026-04-05" },
    { borrower_label: "Luis", loaned_on: "2026-04-06", due_on: "2026-05-06", returned_on: null },
  ], "sin vencimiento no se inventa fecha («Sin fecha acordada»)")
})

test("fechas civiles idénticas con cualquier huso de sesión; alias sin correo ni teléfono", async () => {
  const readIn = (timeZone) => ctx.inTimeZone(a.id, timeZone, async (tx) => {
    const opened = await lend(tx, lib.books[1].id, "Vecina 3.º B", "2026-03-29", "2026-10-25")
    const [row] = await tx`select loaned_on::text as loaned_on, due_on::text as due_on, to_jsonb(loaned_on) as json, current_setting('TimeZone') as zone from biblib.loans where id = ${opened.loan_id}`
    return { ...row }
  })
  for (const zone of ["Pacific/Kiritimati", "America/Los_Angeles", "Europe/Madrid", "UTC"]) {
    assert.deepEqual(await readIn(zone), { loaned_on: "2026-03-29", due_on: "2026-10-25", json: "2026-03-29", zone }, zone)
  }
  // Un intento tras otro: los savepoints de una misma transacción no pueden solaparse.
  const codes = await ctx.rolledBack(a.id, async (tx) => {
    const found = {}
    for (const label of ["ana@example.com", "+34 600 123 456", " Ana", "x".repeat(41)]) {
      found[label] = await ctx.state(tx, (sp) => sp`select biblib.loan_open(${lib.books[2].id}::uuid, ${label}, '2026-04-06', null, null)`)
    }
    return found
  })
  assert.ok(Object.values(codes).every((code) => code === "23514"), JSON.stringify(codes))
})

test("prestar no cambia el estado de lectura y cambiarlo por la app no toca el préstamo", async () => {
  const [before] = await ctx.sql`select status, version from biblib.copies where id = ${lib.books[0].id}`
  const [loan] = await ctx.sql`select id, version from biblib.loans where copy_id = ${lib.books[0].id} and returned_on is null`
  const changed = value(await ctx.call("updateBookStatusAction", [lib.books[0].id, "reading", before.version], session))
  assert.equal(changed.status, "reading")
  const [after] = await ctx.sql`select id, version, returned_on from biblib.loans where id = ${loan.id}`
  assert.deepEqual({ ...after }, { id: loan.id, version: loan.version, returned_on: null })
})

test("borrar el ejemplar por la app se lleva su lectura y sus préstamos; el resto de la cuenta sigue", async () => {
  const target = lib.books[0].id
  await ctx.asUser(a.id, async (tx) => {
    const [started] = await tx`select biblib.reading_cycle_start(${target}::uuid, null) as result`
    await tx`insert into biblib.reading_entries (user_id, cycle_id, occurred_at, note) values (${a.id}, ${started.result.cycle_id}, now(), 'Se irá con la copia')`
  })
  const [copy] = await ctx.sql`select version from biblib.copies where id = ${target}`
  value(await ctx.call("deleteBookAction", [target, copy.version], session))
  const [left] = await ctx.sql`select (select count(*)::int from biblib.reading_cycles where copy_id = ${target}) as cycles,
    (select count(*)::int from biblib.reading_entries e where not exists (select 1 from biblib.reading_cycles c where c.id = e.cycle_id)) as orphans,
    (select count(*)::int from biblib.loans where copy_id = ${target}) as loans, (select count(*)::int from biblib.loans where user_id = ${a.id}) as others`
  assert.deepEqual({ ...left }, { cycles: 0, orphans: 0, loans: 0, others: 0 }, "los préstamos de la copia 2 se ensayaron en transacciones revertidas")
  const [{ copies }] = await ctx.sql`select count(*)::int as copies from biblib.copies where user_id = ${a.id}`
  assert.equal(copies, 2)
})

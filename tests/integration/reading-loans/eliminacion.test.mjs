import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { readingContext } from "./lib/context.mjs"

// O14 · 0015. Eliminación de cuenta con lectura y préstamos: el worker real (lease, fencing, GoTrue y Storage) los retira
// al principio del paso `product` y no da la cuenta por eliminada mientras quede una fila con dueño. B no cambia.

let ctx, a, b

before(async () => {
  ctx = await readingContext()
  a = await ctx.account("a")
  b = await ctx.account("b")
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

test("el worker retira ciclos, entradas y préstamos; la cuenta queda sin restos y B sigue intacta", async () => {
  const lib = await ctx.library(a.id)
  const libB = await ctx.library(b.id)
  for (const [owner, books] of [[a.id, lib.books], [b.id, libB.books]]) {
    await ctx.asUser(owner, async (tx) => {
      const [started] = await tx`select biblib.reading_cycle_start(${books[0].id}::uuid, '2026-10-01T08:00:00Z') as result`
      await tx`insert into biblib.reading_entries (user_id, cycle_id, occurred_at, page_to) values (${owner}, ${started.result.cycle_id}, '2026-10-02T08:00:00Z', 12)`
      await tx`select biblib.loan_open(${books[1].id}::uuid, 'Primo', '2026-10-03', null, null)`
    })
  }
  const before = await ctx.residue(a.id)
  assert.ok(["reading_cycles", "reading_entries", "loans"].every((table) => before.tables[table] === 1), JSON.stringify(before))
  const bBefore = await ctx.residue(b.id)

  const requested = await ctx.asUser(a.id, async (tx) => (await tx`select biblib.account_deletion_request(${ctx.key("eliminar")}) as r`)[0].r)
  assert.equal(requested.state, "pending")
  const report = await ctx.deleteAccount(a.id)
  assert.equal(report?.outcome, "completed", JSON.stringify(report))
  assert.ok(report.counts.product >= 3, `paso product: ${JSON.stringify(report.counts)}`)
  assert.deepEqual(await ctx.residue(a.id), { rows: 0, tables: {}, objects: 0, account: false })
  assert.deepEqual(await ctx.residue(b.id), bBefore, "B no cambia")
})

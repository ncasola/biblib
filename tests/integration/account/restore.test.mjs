import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { applySuppressions } from "../../../scripts/lib/suppressions.mjs"
import { accountContext } from "./lib/context.mjs"

// U-OPS-03 · Un respaldo restaurado no resucita una cuenta suprimida: la fase suppress de db:restore:local, contra
// Postgres, GoTrue y Storage reales, retira la cuenta que el respaldo devolvió (identidad, filas y objetos) y deja su
// marca antes de abrir el destino. El ensayo completo backup → reset → restore → verify está en la evidencia de O12.

let ctx
before(async () => { ctx = await accountContext() })
after(async () => { if (ctx) { await ctx.cleanup(); await ctx.close() } })

test("una cuenta suprimida que vuelve con un respaldo anterior se retira entera antes de abrir; B no cambia", async () => {
  // Estado de un destino recién restaurado desde una copia anterior a la supresión: C entera, sin marca.
  const c = await ctx.account("restaurada"), b = await ctx.account("b")
  await ctx.library(c.id)
  await ctx.library(b.id)
  const beforeB = { residue: await ctx.residue(b.id), objects: await ctx.objects(b.id) }
  const entries = [{ userId: c.id, requestedAt: new Date(Date.now() - 86_400_000).toISOString() }]
  const manifest = { digests: [{ schema: "biblib", table: "copies" }, { schema: "auth", table: "users" }, { schema: "storage", table: "objects" }], sample: [] }

  const applied = await applySuppressions({ sql: ctx.sql, admin: ctx.admin, entries, manifest })
  assert.deepEqual({ accounts: applied.accounts, marks: applied.marks, objects: applied.objects }, { accounts: 1, marks: 1, objects: 2 })
  assert.deepEqual(applied.adjusted.map((d) => `${d.schema}.${d.table}`).sort(), ["auth.users", "biblib.copies", "storage.objects"], "las tablas que cambian se registran para verify")
  assert.deepEqual(await ctx.residue(c.id), { rows: 0, tables: {}, objects: 0, account: false })
  assert.equal(await ctx.identity(c.id), null)
  assert.equal((await ctx.deletion(c.id)).state, "completed", "queda la marca para el siguiente restore")
  assert.deepEqual({ residue: await ctx.residue(b.id), objects: await ctx.objects(b.id) }, beforeB)

  // Idempotente: repetir la fase (restore reintentado) no encuentra nada que suprimir.
  const again = await applySuppressions({ sql: ctx.sql, admin: ctx.admin, entries, manifest })
  assert.deepEqual({ accounts: again.accounts, objects: again.objects, adjusted: again.adjusted }, { accounts: 0, objects: 0, adjusted: [] })
})

test("una solicitud a medias restaurada con el respaldo también se aplica antes de abrir", async () => {
  const c = await ctx.account("a-medias")
  await ctx.library(c.id)
  await ctx.asUser(c.id, (tx) => tx`select biblib.account_deletion_request(${ctx.key("medias")})`)
  const applied = await applySuppressions({ sql: ctx.sql, admin: ctx.admin, entries: [], manifest: { digests: [], sample: [] } })
  assert.ok(applied.accounts >= 1)
  assert.deepEqual(await ctx.residue(c.id), { rows: 0, tables: {}, objects: 0, account: false })
  assert.equal((await ctx.deletion(c.id)).state, "completed")
})

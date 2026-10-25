import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { rotateRestoredTokens } from "../../../scripts/lib/backup-db.mjs"
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
  assert.deepEqual({ accounts: applied.accounts, objects: applied.objects }, { accounts: 1, objects: 2 }, "solo C vuelve con el respaldo")
  assert.ok(applied.marks >= 1, "su marca (y las del destino, si las hay) se reafirman")
  assert.deepEqual(applied.adjusted.map((d) => `${d.schema}.${d.table}`).sort(), ["auth.users", "biblib.copies", "storage.objects"], "las tablas que cambian se registran para verify")
  assert.deepEqual(await ctx.residue(c.id), { rows: 0, tables: {}, objects: 0, account: false })
  assert.equal(await ctx.identity(c.id), null)
  assert.equal((await ctx.deletion(c.id)).state, "completed", "queda la marca para el siguiente restore")
  assert.deepEqual({ residue: await ctx.residue(b.id), objects: await ctx.objects(b.id) }, beforeB)

  // Idempotente: repetir la fase (restore reintentado) no encuentra nada que suprimir.
  const again = await applySuppressions({ sql: ctx.sql, admin: ctx.admin, entries, manifest })
  assert.deepEqual({ accounts: again.accounts, objects: again.objects, adjusted: again.adjusted }, { accounts: 0, objects: 0, adjusted: [] })
})

test("un trabajo y una eliminación en ejecución en el respaldo se reanudan como reintento, sin su lease", async () => {
  const c = await ctx.account("en-vuelo")
  const library = await ctx.library(c.id)
  await ctx.asUser(c.id, (tx) => tx`select biblib.account_deletion_request(${ctx.key("vuelo")})`)
  await ctx.sql`update biblib.library_jobs set state = 'running', lease_token = gen_random_uuid(), lease_until = now() + interval '5 minutes', error_code = null where id = ${library.job.id}`
  const claimed = await ctx.deps().db.claim(c.id, 60_000)
  const ROLLBACK = new Error("rollback")
  // La rotación del restore, en una transacción que se revierte: no cambia el perfil compartido.
  await assert.rejects(ctx.sql.begin(async (tx) => {
    const rotation = await rotateRestoredTokens(tx)
    assert.ok(rotation.invalidated.some((entry) => entry.table === "biblib.library_jobs" && entry.action === "resume-as-retry"))
    const [job] = await tx`select state, lease_token, lease_until from biblib.library_jobs where id = ${library.job.id}`
    assert.deepEqual(job, { state: "waiting_retry", lease_token: null, lease_until: null })
    const [deletion] = await tx`select state, lease_token, fencing_number from biblib.account_deletions where user_id = ${c.id}`
    assert.equal(deletion.state, "waiting_retry")
    assert.equal(deletion.lease_token, null, "el worker anterior al respaldo no conserva su testigo")
    assert.ok(Number(deletion.fencing_number) > claimed.fence)
    throw ROLLBACK
  }), (error) => error === ROLLBACK)
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

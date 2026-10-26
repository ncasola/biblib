import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { LeaseLostError } from "../../../lib/account-deletion/worker.ts"
import { accountContext } from "./lib/context.mjs"

// U-OPS-03 · Worker administrativo real (lib/account-deletion con Postgres, Storage y GoTrue del perfil): cuenta con
// varios ejemplares y portadas privadas, trabajo en vuelo, Storage caído, worker interrumpido que otro continúa sin
// recrear datos, identidad al final y ausencia total de recursos de A; B intacto.

let ctx
before(async () => { ctx = await accountContext() })
after(async () => { if (ctx) { await ctx.cleanup(); await ctx.close() } })

const counts = async (owner) => (await ctx.sql`select
    (select count(*)::int from biblib.copies where user_id = ${owner}) as copies,
    (select count(*)::int from biblib.editions where user_id = ${owner}) as editions,
    (select count(*)::int from biblib.shelves where user_id = ${owner}) as shelves,
    (select count(*)::int from biblib.cover_assets where user_id = ${owner}) as covers,
    (select count(*)::int from biblib.library_snapshots where user_id = ${owner}) as snapshots,
    (select count(*)::int from biblib.saved_book_views where user_id = ${owner}) as views`)[0]

test("eliminación completa: trabajo en vuelo, Storage caído, worker interrumpido y continuación sin recrear datos", async () => {
  const a = await ctx.account("a"), b = await ctx.account("b")
  const libraryA = await ctx.library(a.id)
  const libraryB = await ctx.library(b.id)
  const beforeB = { ...await counts(b.id), objects: await ctx.objects(b.id) }
  assert.deepEqual({ copies: (await counts(a.id)).copies, objects: (await ctx.objects(a.id)).length }, { copies: 3, objects: 2 }, "A con tres ejemplares y dos portadas privadas")

  await ctx.asUser(a.id, (tx) => tx`select biblib.account_deletion_request(${ctx.key("worker")})`)
  // El trabajo de portadas que estaba en vuelo queda expirado: su trabajador ya no renueva ni cerca el lease.
  const job = (await ctx.sql`select state, lease_token from biblib.library_jobs where id = ${libraryA.job.id}`)[0]
  assert.deepEqual(job, { state: "expired", lease_token: null })
  assert.equal((await ctx.sql`select biblib.library_job_renew(${libraryA.job.id}, ${libraryA.job.lease}, ${libraryA.job.fencing}, 60000) as ok`)[0].ok, false)
  await assert.rejects(ctx.sql`select biblib.library_job_fence(${libraryA.job.id}, ${libraryA.job.lease}, ${libraryA.job.fencing})`, (error) => error.code === "BJ001")

  // Storage caído: el paso falla, queda visible y reintentable; nada de identidad ni de filas.
  const down = await ctx.work(a.id, { storage: { remove: async () => { throw new Error("Storage no disponible") } } })
  assert.deepEqual({ outcome: down.outcome, step: down.step, errorCode: down.errorCode }, { outcome: "waiting_retry", step: "storage", errorCode: "STORAGE_UNAVAILABLE" })
  assert.deepEqual((({ state, step, error_code }) => ({ state, step, error_code }))(await ctx.deletion(a.id)), { state: "waiting_retry", step: "storage", error_code: "STORAGE_UNAVAILABLE" })
  assert.equal((await ctx.objects(a.id)).length, 2)
  assert.ok(await ctx.identity(a.id), "la identidad sigue mientras Storage esté pendiente")
  assert.equal((await counts(a.id)).copies, 3)

  // Storage vuelve; el worker muere al llegar a los ejemplares (lease sin soltar, como un proceso caído).
  const crashed = await ctx.work(a.id, { hooks: { beforeStep: (step) => { if (step === "copies") throw new LeaseLostError() } } })
  assert.deepEqual({ outcome: crashed.outcome, step: crashed.step }, { outcome: "lease_lost", step: "copies" })
  const half = await ctx.deletion(a.id)
  assert.deepEqual({ state: half.state, step: half.step }, { state: "running", step: "copies" })
  assert.deepEqual(await ctx.objects(a.id), [], "Storage ya está vacío")
  assert.deepEqual(await counts(a.id), { copies: 3, editions: 2, shelves: 2, covers: 0, snapshots: 0, views: 0 }, "los pasos hechos no vuelven")
  assert.equal(await ctx.work(a.id), null, "con el lease vigente nadie más la reclama")

  // El lease vence: otro worker continúa desde los ejemplares; el testigo antiguo ya no hace nada.
  await ctx.sql`update biblib.account_deletions set lease_until = clock_timestamp() - interval '1 second' where user_id = ${a.id}`
  await assert.rejects(ctx.sql`select biblib.account_deletion_purge(${a.id}, ${half.lease_token}, 'copies', 10)`, (error) => error.code === "BD003")
  const finished = await ctx.work(a.id)
  assert.equal(finished.outcome, "completed")
  assert.equal(finished.counts.copies, 3)
  assert.equal(finished.counts.sessions, undefined, "no repite pasos anteriores")

  // Ausencia de recursos de A: tablas, Storage e identidad. Solo la marca mínima.
  assert.deepEqual(await ctx.residue(a.id), { rows: 0, tables: {}, objects: 0, account: false })
  assert.equal(await ctx.identity(a.id), null)
  const mark = await ctx.deletion(a.id)
  assert.equal(mark.state, "completed")
  assert.deepEqual(mark.counts, {})
  assert.ok(mark.purge_after > new Date(Date.now() + 89 * 86_400_000), "marca con plazo de 90 días")
  // B intacto: datos, objetos y sesión.
  assert.deepEqual({ ...await counts(b.id), objects: await ctx.objects(b.id) }, beforeB)
  assert.deepEqual(await ctx.objects(b.id), [...libraryB.keys].sort())
  assert.ok((await ctx.signIn(b)).session, "B sigue entrando")
})

test("un worker vencido tras terminar no recrea nada y repetir el ciclo no hace nada", async () => {
  const a = await ctx.account("vencido")
  await ctx.library(a.id)
  await ctx.asUser(a.id, (tx) => tx`select biblib.account_deletion_request(${ctx.key("vencido")})`)
  const deps = ctx.deps()
  const claimed = await deps.db.claim(a.id, 60_000)
  // Otro worker se lo quita (lease vencido) y termina la eliminación.
  await ctx.sql`update biblib.account_deletions set lease_until = clock_timestamp() - interval '1 second' where user_id = ${a.id}`
  assert.equal((await ctx.work(a.id)).outcome, "completed")
  // El primero despierta: cualquier paso suyo pierde el lease y no toca la base.
  await assert.rejects(deps.db.purge(a.id, claimed.token, "copies", 10), LeaseLostError)
  assert.equal(await deps.db.renew(a.id, claimed.token, 60_000), false)
  assert.equal(await ctx.work(a.id), null, "una eliminación terminada no se vuelve a reclamar")
  // Ni un JWT antiguo ni un trabajo pueden recrear filas: la identidad ya no existe.
  await assert.rejects(ctx.asUser(a.id, (tx) => tx`select biblib.lock_library()`), (error) => error.code === "BD001")
  await assert.rejects(ctx.sql`insert into biblib.shelves (user_id, title) values (${a.id}, 'Recreada')`, (error) => error.code === "23503")
  assert.deepEqual(await ctx.residue(a.id), { rows: 0, tables: {}, objects: 0, account: false })
})

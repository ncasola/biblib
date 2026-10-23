import assert from "node:assert/strict"
import { after, afterEach, before, test } from "node:test"
import { jobsContext, runWorker, sleep } from "./lib/context.mjs"

// U-DAT-03 · Importación publicada a través de un trabajo, contra la app y la base reales del perfil.
// La vista previa se prepara por HTTP con la sesión GoTrue de A; los pasos de publicación los
// ejecutan procesos independientes que mueren o se detienen en puntos concretos. Los archivos usan
// identificadores manuales: ni preparar ni publicar consultan la red.

let ctx, a
const ok = (result) => result.status === 200 && result.value?.ok === true

before(async () => { ctx = await jobsContext(); await ctx.cleanup(); a = await ctx.signIn("a") })
afterEach(async () => { await ctx.recordImported(ctx.users.a); await ctx.cleanup() })
after(async () => { if (ctx) { await ctx.recordImported(ctx.users.a); await ctx.cleanup(); await a?.client.auth.signOut({ scope: "local" }).catch(() => {}); await ctx.close() } })

const operations = async (previewId) => (await ctx.sql`select id from biblib.library_operations where preview_id = ${previewId} and user_id = ${ctx.users.a}`).map((row) => row.id)
const leaseExpired = (jobId) => ctx.waitFor(async () => (await ctx.sql`select state = 'running' and lease_until < clock_timestamp() as expired from biblib.library_jobs where id = ${jobId}`)[0]?.expired, { message: "lease vencido" })

test("matar la publicación antes del commit: otro trabajador publica una sola vez, sin duplicados", async () => {
  const prepared = await ctx.prepare(a, ctx.users.a, ctx.importFile("caida", 3))
  const jobId = await ctx.createImportJob(ctx.users.a, prepared.previewId, ctx.key("caida"))
  const killed = await runWorker(ctx, { jobId, limits: { leaseMs: 1500 }, at: { beforeCommit: "kill" } })
  assert.equal(killed.code, 137)
  assert.equal(killed.killed, "beforeCommit")
  assert.equal((await ctx.markedBooks(ctx.users.a, "Importado caida")).length, 0, "la transacción interrumpida no dejó nada")
  assert.deepEqual(await operations(prepared.previewId), [])
  assert.equal((await ctx.job(jobId)).published_at, null)
  await leaseExpired(jobId)
  const second = await runWorker(ctx, { jobId, drain: true })
  assert.equal(second.reports[0].outcome, "progressed")
  assert.equal((await ctx.markedBooks(ctx.users.a, "Importado caida")).length, 3, "cada libro una vez")
  assert.equal((await operations(prepared.previewId)).length, 1)
  const job = await ctx.job(jobId)
  assert.ok(job.published_at)
  assert.equal(job.state, "succeeded", "los identificadores manuales se omiten sin red en la fase de portadas")
  assert.equal(job.result.result.imported, 3)
})

test("matar tras el commit con la respuesta perdida: consultar y repetir devuelven el mismo resultado", async () => {
  const prepared = await ctx.prepare(a, ctx.users.a, ctx.importFile("perdida", 2))
  const key = ctx.key("perdida")
  const jobId = await ctx.createImportJob(ctx.users.a, prepared.previewId, key)
  const killed = await runWorker(ctx, { jobId, at: { afterCommit: "kill" } })
  assert.equal(killed.killed, "afterCommit")
  const [operationId] = await operations(prepared.previewId)
  assert.ok(operationId, "la publicación quedó confirmada")
  const view = await ctx.call("getLibraryJobAction", [{ jobId }], a)
  assert.ok(ok(view))
  assert.equal(view.value.value.published, true)
  assert.equal(view.value.value.result.operationId, operationId)
  assert.equal(view.value.value.result.result.imported, 2)
  const again = await ctx.call("confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: key }], a)
  assert.ok(ok(again), `la repetición devuelve el resultado (${again.value?.error?.code ?? again.status})`)
  assert.deepEqual([again.value.value.operationId, again.value.value.status, again.value.value.replayed, again.value.value.jobId], [operationId, "committed", true, jobId])
  assert.equal((await ctx.markedBooks(ctx.users.a, "Importado perdida")).length, 2, "sin duplicados")
})

test("cancelar antes de publicar: no se aplica nada", async () => {
  const prepared = await ctx.prepare(a, ctx.users.a, ctx.importFile("antes", 2))
  const jobId = await ctx.createImportJob(ctx.users.a, prepared.previewId, ctx.key("antes"))
  const cancel = await ctx.call("cancelLibraryJobAction", [{ jobId, expectedVersion: (await ctx.job(jobId)).version }], a)
  assert.ok(ok(cancel))
  assert.equal(cancel.value.value.publication, "before")
  assert.equal(cancel.value.value.job.state, "cancelled")
  assert.deepEqual((await runWorker(ctx, { jobId })).reports, [], "un trabajo cancelado no se reclama")
  assert.equal((await ctx.markedBooks(ctx.users.a, "Importado antes")).length, 0)
})

test("cancelar durante la publicación atómica: espera al commit y responde que llegó después", async () => {
  const prepared = await ctx.prepare(a, ctx.users.a, ctx.importFile("durante", 2))
  const jobId = await ctx.createImportJob(ctx.users.a, prepared.previewId, ctx.key("durante"))
  // La publicación se detiene 3 s dentro de su transacción, con la fila del trabajo bloqueada.
  const publishing = runWorker(ctx, { jobId, at: { beforeCommit: 3000 } })
  await ctx.waitFor(async () => (await ctx.job(jobId)).state === "running", { message: "publicación en curso" })
  const version = (await ctx.job(jobId)).version
  await sleep(800)
  const started = Date.now()
  const cancel = await ctx.call("cancelLibraryJobAction", [{ jobId, expectedVersion: version }], a)
  const worker = await publishing
  assert.equal(worker.reports[0].outcome, "progressed", "la publicación no se corta a medias")
  assert.ok(ok(cancel), `cancelar responde (${cancel.value?.error?.code ?? cancel.status})`)
  assert.equal(cancel.value.value.publication, "after")
  assert.ok(Date.now() - started >= 1000, "la cancelación esperó al final de la transacción")
  assert.equal((await ctx.markedBooks(ctx.users.a, "Importado durante")).length, 2, "la importación publicada se conserva")
  assert.equal((await ctx.job(jobId)).state, "cancelled")
})

test("cancelar en la fase de portadas: la importación publicada se conserva", async () => {
  const prepared = await ctx.prepare(a, ctx.users.a, ctx.importFile("portadas", 2))
  const jobId = await ctx.createImportJob(ctx.users.a, prepared.previewId, ctx.key("portadas"))
  await runWorker(ctx, { jobId })
  const published = await ctx.job(jobId)
  assert.equal(published.phase, "covers")
  assert.equal(published.state, "queued")
  const cancel = await ctx.call("cancelLibraryJobAction", [{ jobId, expectedVersion: published.version }], a)
  assert.ok(ok(cancel))
  assert.equal(cancel.value.value.publication, "after")
  assert.equal((await ctx.markedBooks(ctx.users.a, "Importado portadas")).length, 2)
})

test("una revisión cambiada deja el trabajo en revisión y repetir no lo aplica", async () => {
  const prepared = await ctx.prepare(a, ctx.users.a, ctx.importFile("revision", 2))
  const key = ctx.key("revision")
  const jobId = await ctx.createImportJob(ctx.users.a, prepared.previewId, key)
  await ctx.createBooks(ctx.users.a, ["manual-dat03-cambio-" + ctx.run])
  await runWorker(ctx, { jobId })
  const job = await ctx.job(jobId)
  assert.equal(job.state, "needs_review")
  assert.equal(job.error_code, "REVISION_CONFLICT")
  const retry = await ctx.call("confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: key }], a)
  assert.equal(retry.value?.error?.code, "REVISION_CONFLICT")
  assert.equal((await ctx.markedBooks(ctx.users.a, "Importado revision")).length, 0)
})

test("confirmImportAction publica mediante un trabajo y la misma clave recupera el mismo resultado", async () => {
  const prepared = await ctx.prepare(a, ctx.users.a, ctx.importFile("confirmar", 2))
  const key = ctx.key("confirmar")
  const first = await ctx.call("confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: key }], a)
  assert.ok(ok(first), `confirmar (${first.value?.error?.code ?? first.status})`)
  assert.equal(first.value.value.status, "committed")
  assert.equal(first.value.value.replayed, false)
  assert.equal(first.value.value.result.imported, 2)
  const jobId = first.value.value.jobId
  ctx.created.jobs.push(jobId)
  const job = await ctx.job(jobId)
  assert.ok(job.published_at)
  assert.equal(job.idempotency_key, key)
  const second = await ctx.call("confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: key }], a)
  assert.ok(ok(second))
  assert.deepEqual([second.value.value.operationId, second.value.value.replayed], [first.value.value.operationId, true])
  const other = await ctx.call("confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: ctx.key("otra") }], a)
  assert.equal(other.value?.error?.code, "CONFLICT", "una vista previa ya confirmada no admite otra clave")
  await ctx.waitFor(async () => (await ctx.job(jobId)).state === "succeeded", { message: "fase de portadas terminada por el servidor" })
})

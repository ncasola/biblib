import assert from "node:assert/strict"
import { after, afterEach, before, test } from "node:test"
import { fakeIsbn, jobsContext, runWorker } from "./lib/context.mjs"

// U-DAT-03 · Acciones de trabajos por HTTP contra la app real del perfil, con sesiones GoTrue de A y
// B: recargar y continuar desde otra sesión, aislamiento A/B y la entrada interna del ejecutor. La
// app usa el catálogo fixture (sin red): los ISBN sintéticos responden «sin portada».

let ctx, a, b
const ok = (result) => result.status === 200 && result.value?.ok === true
const code = (result) => result.value?.error?.code

before(async () => { ctx = await jobsContext(); await ctx.cleanup(); a = await ctx.signIn("a"); b = await ctx.signIn("b") })
afterEach(async () => { await ctx.cleanup() })
after(async () => {
  if (!ctx) return
  await ctx.cleanup()
  for (const session of [a, b]) await session?.client.auth.signOut({ scope: "local" }).catch(() => {})
  await ctx.close()
})

const view = async (session, jobId) => {
  const result = await ctx.call("getLibraryJobAction", [{ jobId }], session)
  assert.ok(ok(result), `consulta del trabajo (${code(result) ?? result.status})`)
  return result.value.value
}

test("crear, recargar y continuar: otra sesión del dueño ve el mismo progreso y lo controla", async () => {
  await ctx.createBooks(ctx.users.a, [fakeIsbn(9101), fakeIsbn(9102), fakeIsbn(9103)])
  const jobId = await ctx.createCoverJob(ctx.users.a)
  // Un primer paso confirma parte del trabajo y el proceso termina, como al cerrar la página.
  await runWorker(ctx, { jobId, limits: { maxItemsPerStep: 2 } })
  const stored = await ctx.job(jobId)
  assert.equal(stored.state, "queued")
  assert.equal(stored.counts.processed, 2)

  // Antes de cerrar la página, la primera sesión pausa con la versión que tenía en pantalla.
  const paused = await ctx.call("pauseLibraryJobAction", [{ jobId, expectedVersion: stored.version }], a)
  assert.ok(ok(paused), `pausar (${code(paused) ?? paused.status})`)
  assert.equal(paused.value.value.job.state, "paused")

  const reloaded = await ctx.signIn("a")
  try {
    const listed = await ctx.call("listLibraryJobsAction", [], reloaded)
    assert.ok(ok(listed))
    const found = listed.value.value.find((job) => job.id === jobId)
    assert.ok(found, "la nueva sesión encuentra el trabajo")
    assert.equal(found.state, "paused")
    assert.deepEqual(found.counts, { ...found.counts, total: stored.counts.total, processed: 2 }, "cantidades confirmadas, no estimadas")
    assert.ok(!JSON.stringify(found).includes(ctx.users.a), "la vista no expone el dueño")
    assert.equal((await view(reloaded, jobId)).counts.processed, 2)

    const stale = await ctx.call("resumeLibraryJobAction", [{ jobId, expectedVersion: stored.version }], reloaded)
    assert.equal(code(stale), "JOB_CONFLICT", "una versión antigua no reanuda")
    assert.equal(stale.value.error.retryable, false)
    const resumed = await ctx.call("resumeLibraryJobAction", [{ jobId, expectedVersion: found.version }], reloaded)
    assert.ok(ok(resumed))
    // El servidor continúa en segundo plano tras responder; la primera sesión ve el final.
    const done = await ctx.waitFor(async () => { const current = await view(a, jobId); return current.state === "succeeded" ? current : null }, { message: "trabajo terminado por el servidor" })
    assert.equal(done.counts.processed, done.counts.total)
    assert.ok(done.counts.processed >= 2)
    const finished = await ctx.call("cancelLibraryJobAction", [{ jobId, expectedVersion: done.version }], a)
    assert.equal(code(finished), "JOB_CONFLICT", "un trabajo terminado no se cancela")
  } finally {
    await reloaded.client.auth.signOut({ scope: "local" }).catch(() => {})
  }
})

test("recuperar portadas desde Ajustes inicia un trabajo que el servidor completa", async () => {
  const started = await ctx.call("recoverMissingCoversAction", [{ idempotencyKey: ctx.key("ajustes") }], b)
  assert.ok(ok(started), `iniciar (${code(started) ?? started.status})`)
  const jobId = started.value.value.id
  ctx.created.jobs.push(jobId)
  assert.equal(started.value.value.kind, "covers")
  const busy = await ctx.call("recoverMissingCoversAction", [{ idempotencyKey: ctx.key("ajustes") }], b)
  if (!ok(busy)) assert.equal(code(busy), "JOB_CONFLICT", "solo una búsqueda de portadas activa por cuenta")
  const done = await ctx.waitFor(async () => { const current = await view(b, jobId); return ["succeeded", "partially_succeeded"].includes(current.state) ? current : null }, { message: "portadas de B" })
  assert.equal(done.counts.recovered, 0, "el catálogo fixture no tiene imágenes: sin cambios en los libros de B")
})

test("A no usa IDs de B: consultar, controlar o confirmar responde como inexistente y B no cambia", async () => {
  const jobId = await ctx.createCoverJob(ctx.users.b, "ajeno")
  const before = await ctx.job(jobId)
  for (const [name, args] of [
    ["getLibraryJobAction", [{ jobId }]],
    ["pauseLibraryJobAction", [{ jobId, expectedVersion: before.version }]],
    ["resumeLibraryJobAction", [{ jobId, expectedVersion: before.version }]],
    ["cancelLibraryJobAction", [{ jobId, expectedVersion: before.version }]],
  ]) assert.equal(code(await ctx.call(name, args, a)), "NOT_FOUND", `${name} no confirma un trabajo ajeno`)
  const listed = await ctx.call("listLibraryJobsAction", [], a)
  assert.ok(ok(listed) && !listed.value.value.some((job) => job.id === jobId))
  const preview = await ctx.prepare(b, ctx.users.b, ctx.importFile("ajena", 1))
  const confirm = await ctx.call("confirmImportAction", [{ previewId: preview.previewId, expectedRevision: preview.revision, idempotencyKey: ctx.key("ajena") }], a)
  assert.equal(code(confirm), "NOT_FOUND", "A no publica una vista previa de B")
  const after = await ctx.job(jobId)
  assert.deepEqual([after.state, after.version, after.updated_at.getTime()], [before.state, before.version, before.updated_at.getTime()])
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.library_jobs where user_id = ${ctx.users.a} and preview_id = ${preview.previewId}`)[0].n, 0)
})

test("la entrada interna solo acepta el token del ejecutor y nunca un dueño de la petición", async () => {
  const jobId = await ctx.createCoverJob(ctx.users.b, "interna")
  const url = `${ctx.app.url}/api/internal/jobs/run`
  const cookie = ctx.cookies(a).map(({ name, value }) => `${name}=${value}`).join("; ")
  const attempts = [
    { headers: { cookie } },
    { headers: { authorization: `Bearer ${ctx.env.SUPABASE_ANON_KEY}` } },
    { headers: { authorization: `Bearer ${a.session.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ owner: ctx.users.b, jobId }) },
    { headers: { authorization: `Bearer ${ctx.runnerToken()}x` } },
  ]
  for (const attempt of attempts) {
    const response = await fetch(url, { method: "POST", redirect: "manual", ...attempt })
    assert.equal(response.status, 401)
    assert.doesNotMatch(await response.text(), /steps|biblib|postgres/i)
  }
  assert.equal((await ctx.job(jobId)).state, "queued", "nada se ejecutó")
  const get = await fetch(url, { redirect: "manual" })
  assert.ok([401, 405].includes(get.status))
  const runner = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${ctx.runnerToken()}` }, body: JSON.stringify({ owner: ctx.users.a }) })
  assert.equal(runner.status, 200)
  const body = await runner.json()
  assert.ok(body.steps >= 1, "el ejecutor reclama trabajos vencidos de la base")
  // El dueño sale de la fila reclamada: el trabajo de B avanzó y A no recibió nada.
  assert.notEqual((await ctx.job(jobId)).state, "queued")
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.library_jobs where user_id = ${ctx.users.a} and idempotency_key like ${`dat03-${ctx.run}-%`}`)[0].n, 0)
})

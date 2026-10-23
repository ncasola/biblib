import assert from "node:assert/strict"
import { after, afterEach, before, test } from "node:test"
import { fakeIsbn, jobsContext, runWorker, sleep } from "./lib/context.mjs"

// U-DAT-03 contra Postgres real: trabajos de portadas ejecutados por procesos Node distintos con el
// worker compilado, el servicio bibliográfico y el gateway en modo lote. El fetch es simulado y
// solo los ISBN sintéticos del run tienen portada: los libros del seed nunca cambian.

let ctx
let serial = 0
const isbns = (count) => Array.from({ length: count }, () => fakeIsbn(++serial + (Date.now() % 900) * 10))

before(async () => { ctx = await jobsContext(); await ctx.cleanup() })
afterEach(async () => { await ctx.cleanup() })
after(async () => { if (ctx) { await ctx.cleanup(); await ctx.close() } })

const leaseExpired = (jobId) => ctx.waitFor(async () => (await ctx.sql`select state = 'running' and lease_until < clock_timestamp() as expired from biblib.library_jobs where id = ${jobId}`)[0]?.expired, { message: "lease vencido" })
const item = async (jobId, bookId) => (await ctx.items(jobId)).find((row) => row.item_key === bookId)
const fixtureBooks = async () => (await ctx.sql`select id, version, cover_large from biblib.books where user_id = ${ctx.users.a} and title not like '[DAT-03 %' order by id`).map((row) => ({ ...row }))

test("crear y continuar: los pasos confirman progreso y portadas sin tocar los libros del seed", async () => {
  const before = await fixtureBooks()
  const books = await ctx.createBooks(ctx.users.a, isbns(2))
  const jobId = await ctx.createCoverJob(ctx.users.a)
  const first = await runWorker(ctx, { jobId, limits: { maxItemsPerStep: 1 } })
  assert.equal(first.reports[0].outcome, "progressed")
  const partial = await ctx.job(jobId)
  assert.equal(partial.state, "queued", "queda trabajo pendiente para otro paso")
  assert.ok(partial.counts.total >= 2 && partial.counts.processed === 1, "el progreso confirmado sobrevive al proceso")
  const rest = await runWorker(ctx, { jobId, drain: true })
  assert.ok(rest.reports.every((report) => report.outcome === "progressed"))
  const done = await ctx.job(jobId)
  assert.equal(done.state, "succeeded")
  assert.equal(done.counts.processed, done.counts.total)
  for (const book of books) {
    const row = await ctx.book(book.id)
    assert.match(row.cover_large, /^https:\/\/covers\.openlibrary\.org\/b\/id\/\d+-L\.jpg$/)
    assert.equal(row.cover_small, row.cover_large.replace("-L.jpg", "-S.jpg"))
    assert.equal((await item(jobId, book.id)).state, "succeeded")
  }
  assert.deepEqual(await fixtureBooks(), before, "los libros del seed no cambian (sin portada no es escritura)")
})

test("dos trabajadores sobre el mismo elemento: solo el que tiene el lease vigente confirma", async () => {
  const [book] = await ctx.createBooks(ctx.users.a, isbns(1))
  const jobId = await ctx.createCoverJob(ctx.users.a)
  // El primero se queda parado tras consultar, más allá de su lease de 1,5 s.
  const stalled = runWorker(ctx, { jobId, limits: { leaseMs: 1500 }, at: { afterFetch: 7000 } })
  await leaseExpired(jobId)
  const second = await runWorker(ctx, { jobId })
  const first = await stalled
  assert.equal(second.reports[0].outcome, "progressed")
  assert.equal(first.reports[0].outcome, "lease_lost", "el trabajador tardío no escribe")
  assert.ok(first.calls.some((call) => call.isbn === book.isbn), "el primero llegó a consultar el elemento")
  const row = await item(jobId, book.id)
  assert.equal(row.state, "succeeded")
  assert.ok(BigInt(row.fencing_number) > BigInt(first.events[0].fencing), "el resultado lleva el fencing del titular vigente")
  const updated = await ctx.book(book.id)
  assert.notEqual(updated.version, book.version)
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.library_job_items where job_id = ${jobId} and item_key = ${book.id}`)[0].n, 1)
})

test("matar el trabajador tras la consulta y antes de persistir: otro lo recupera sin duplicar", async () => {
  const [book] = await ctx.createBooks(ctx.users.a, isbns(1))
  const jobId = await ctx.createCoverJob(ctx.users.a)
  const killed = await runWorker(ctx, { jobId, limits: { leaseMs: 1500 }, at: { afterFetch: "kill" } })
  assert.equal(killed.code, 137)
  assert.equal(killed.killed, "afterFetch")
  assert.equal((await item(jobId, book.id)).state, "pending", "nada de lo consultado se confirmó")
  assert.equal((await ctx.book(book.id)).version, book.version)
  await leaseExpired(jobId)
  const recovered = await runWorker(ctx, { jobId, drain: true })
  assert.equal(recovered.reports[0].outcome, "progressed")
  assert.equal((await ctx.job(jobId)).state, "succeeded")
  assert.equal((await item(jobId, book.id)).state, "succeeded")
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.library_job_items where job_id = ${jobId}`)[0].n, (await ctx.job(jobId)).counts.total, "un elemento por libro")
})

test("lease vencido: el trabajador antiguo no escribe aunque nadie lo haya reclamado", async () => {
  const [book] = await ctx.createBooks(ctx.users.a, isbns(1))
  const jobId = await ctx.createCoverJob(ctx.users.a)
  const late = await runWorker(ctx, { jobId, limits: { leaseMs: 1000 }, at: { afterFetch: 2500 } })
  assert.equal(late.reports[0].outcome, "lease_lost")
  assert.equal((await ctx.book(book.id)).version, book.version)
  const job = await ctx.job(jobId)
  assert.equal(job.state, "running", "sigue reclamable cuando venza el lease")
  await runWorker(ctx, { jobId, drain: true })
  assert.ok(BigInt((await ctx.job(jobId)).fencing_number) > BigInt(job.fencing_number), "el siguiente titular tiene un fencing mayor")
  assert.equal((await ctx.job(jobId)).state, "succeeded")
})

test("429 con Retry-After: espera compartida, sin más peticiones y nunca «sin portada»", async () => {
  const [book] = await ctx.createBooks(ctx.users.a, isbns(1))
  const jobId = await ctx.createCoverJob(ctx.users.a)
  const result = await runWorker(ctx, { jobId, replies: { [book.isbn]: "429" }, retryAfter: 4 })
  const limited = await item(jobId, book.id)
  assert.equal(limited.state, "waiting_retry")
  assert.equal(limited.error_code, "RATE_LIMITED")
  assert.equal(limited.attempts, 0, "esperar cuota no consume intentos")
  const index = result.calls.findIndex((call) => call.isbn === book.isbn)
  assert.equal(result.calls.length, index + 1, "tras el 429 no sale ninguna petición más en el paso")
  const [job] = await ctx.sql`select state, error_code, extract(epoch from next_attempt_at - clock_timestamp()) as wait from biblib.library_jobs where id = ${jobId}`
  assert.equal(job.state, "waiting_retry")
  assert.ok(Number(job.wait) >= 2.5, `todo el trabajo espera el Retry-After (${job.wait} s)`)
  const [bucket] = await ctx.sql`select cooldown_until > clock_timestamp() as cooling from biblib.catalogue_quota_buckets where provider = 'open-library' and credential_scope = ${ctx.scope}`
  assert.equal(bucket.cooling, true, "el cooldown es compartido entre procesos")
  // Antes de que venza, otro trabajador no reclama el trabajo.
  assert.deepEqual((await runWorker(ctx, { jobId })).reports, [])
  // Reanudación tras la espera (simulada adelantando el reloj de la fila): la portada llega.
  await ctx.sql`update biblib.library_job_items set next_attempt_at = clock_timestamp() where job_id = ${jobId}`
  await ctx.sql`update biblib.library_jobs set next_attempt_at = clock_timestamp() where id = ${jobId}`
  await ctx.sql`update biblib.catalogue_quota_buckets set cooldown_until = null, next_slot_at = clock_timestamp() where credential_scope = ${ctx.scope}`
  await runWorker(ctx, { jobId, drain: true })
  assert.equal((await item(jobId, book.id)).state, "succeeded")
})

test("503 y JSON roto se reintentan con backoff y cuentan como intento; nunca son ausencia", async () => {
  const [down, broken] = await ctx.createBooks(ctx.users.a, isbns(2))
  const jobId = await ctx.createCoverJob(ctx.users.a)
  await runWorker(ctx, { jobId, replies: { [down.isbn]: "503", [broken.isbn]: "broken" } })
  for (const book of [down, broken]) {
    const row = await item(jobId, book.id)
    assert.equal(row.state, "waiting_retry", `${book.isbn} no es «sin portada»`)
    assert.equal(row.error_code, "PROVIDER_UNAVAILABLE")
    assert.equal(row.attempts, 1)
  }
  assert.equal((await ctx.job(jobId)).state, "waiting_retry")
  // Tras agotar los intentos, el elemento queda fallido y el trabajo, completado con incidencias.
  await ctx.sql`update biblib.library_job_items set attempts = 4, next_attempt_at = clock_timestamp() where job_id = ${jobId} and item_key = ${down.id}`
  await ctx.sql`update biblib.library_job_items set next_attempt_at = clock_timestamp() where job_id = ${jobId} and item_key = ${broken.id}`
  await ctx.sql`update biblib.library_jobs set next_attempt_at = clock_timestamp() where id = ${jobId}`
  await runWorker(ctx, { jobId, drain: true, replies: { [down.isbn]: "503" } })
  assert.equal((await item(jobId, down.id)).state, "failed")
  assert.equal((await item(jobId, broken.id)).state, "succeeded")
  assert.equal((await ctx.job(jobId)).state, "partially_succeeded")
  assert.equal((await ctx.book(down.id)).version, down.version, "un fallo no escribe la ficha")
})

test("cancelar durante las portadas: el paso en curso no escribe", async () => {
  const [book] = await ctx.createBooks(ctx.users.a, isbns(1))
  const jobId = await ctx.createCoverJob(ctx.users.a)
  const running = runWorker(ctx, { jobId, at: { afterFetch: 4000 } })
  await ctx.waitFor(async () => (await ctx.job(jobId)).counts.total > 0 && (await ctx.job(jobId)).state === "running", { message: "paso de portadas en curso" })
  await sleep(500)
  const version = (await ctx.job(jobId)).version
  const [{ r }] = await ctx.asUser(ctx.users.a, (tx) => tx`select biblib.library_job_control(${jobId}, ${version}, 'cancel') as r`)
  assert.equal(r.status, "ok")
  assert.equal((await running).reports[0].outcome, "lease_lost")
  assert.equal((await ctx.job(jobId)).state, "cancelled")
  assert.equal((await ctx.book(book.id)).version, book.version)
})

test("cuenta bloqueada: el trabajador antiguo no escribe y el trabajo queda no autorizado", async () => {
  const [book] = await ctx.createBooks(ctx.users.a, isbns(1))
  const jobId = await ctx.createCoverJob(ctx.users.a)
  const running = runWorker(ctx, { jobId, at: { afterFetch: 4000 } })
  await ctx.waitFor(async () => (await ctx.job(jobId)).state === "running", { message: "trabajo en ejecución" })
  try {
    // Devuelve los trabajos activos de A invalidados: en la suite completa otros grupos dejan trabajos de A, así que ≥ 1.
    const invalidated = Number((await ctx.sql`select biblib.account_set_state(${ctx.users.a}, 'blocked') as n`)[0].n)
    assert.ok(invalidated >= 1, `trabajos invalidados: ${invalidated}`)
    assert.equal((await running).reports[0].outcome, "lease_lost")
    const job = await ctx.job(jobId)
    assert.equal(job.state, "expired")
    assert.equal(job.error_code, "ACCOUNT_INACTIVE")
    assert.equal((await ctx.book(book.id)).version, book.version, "ningún dato se recrea ni modifica")
    assert.deepEqual((await runWorker(ctx, { jobId })).reports, [], "nadie vuelve a reclamarlo")
  } finally {
    await ctx.sql`select biblib.account_set_state(${ctx.users.a}, 'active')`
  }
})

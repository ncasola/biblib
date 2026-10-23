import assert from "node:assert/strict"
import { after, before, beforeEach, test } from "node:test"
import { catalogueContext, fakeIsbn, policyVersion, runWorker, startAt } from "./lib/context.mjs"

// U-DAT-05 contra Postgres real: procesos Node distintos comparten caché, consultas en vuelo y
// cuota mediante las funciones biblib.catalogue_*. El fetch de cada proceso es simulado y cuenta
// peticiones; ninguna prueba sale a Internet.

let ctx
const TOLERANCE_MS = 30
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

before(async () => { ctx = await catalogueContext() })
beforeEach(async () => { await ctx.cleanup() })
after(async () => { if (ctx) { await ctx.cleanup(); await ctx.close() } })

const gaps = (times) => times.slice(1).map((time, i) => time - times[i])
const cacheRows = (isbn) => ctx.sql`select status, payload, provenance, fence, policy_version, schema_version, extract(epoch from expires_at - fetched_at)::int as ttl from biblib.catalogue_cache where credential_scope = ${ctx.scope} and canonical_key = ${isbn}`

test("dos procesos piden a la vez el mismo ISBN: una única consulta en vuelo y resultado equivalente", async () => {
  const isbn = fakeIsbn(1)
  const at = startAt()
  const [one, two] = await Promise.all([
    runWorker(ctx, { mode: "lookup", isbns: [isbn], owner: ctx.users.a, startAt: at, delayMs: 600 }),
    runWorker(ctx, { mode: "lookup", isbns: [isbn], owner: ctx.users.b, startAt: at, delayMs: 600 }),
  ])
  assert.equal(one.calls.length + two.calls.length, 1, "Solo un proceso consulta al proveedor")
  assert.equal(one.results[0].status, "found")
  assert.equal(two.results[0].status, "found")
  assert.deepEqual(one.results[0].candidates, two.results[0].candidates)
  const [row] = await cacheRows(isbn)
  assert.equal(row.status, "found")
  assert.equal(row.ttl, 3600, "Ficha OL: TTL de 1 h")
  // La fila compartida no referencia a ningún dueño.
  const shared = JSON.stringify(row)
  assert.ok(!shared.includes(ctx.users.a) && !shared.includes(ctx.users.b))
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.catalogue_inflight where credential_scope = ${ctx.scope}`)[0].n, 0, "La consulta en vuelo se cerró")
})

test("ISBN distintos desde búsqueda, importación y portada respetan el intervalo global de OL", async () => {
  const at = startAt()
  const [search, batch, cover] = await Promise.all([
    runWorker(ctx, { mode: "lookup", isbns: [fakeIsbn(10), fakeIsbn(11)], owner: ctx.users.a, startAt: at }),
    runWorker(ctx, { mode: "batch", isbns: [fakeIsbn(20), fakeIsbn(21)], owner: ctx.users.b, startAt: at }),
    runWorker(ctx, { mode: "cover", isbns: [fakeIsbn(30)], owner: ctx.users.b, startAt: at }),
  ])
  const times = [...search.calls, ...batch.calls, ...cover.calls].filter((call) => call.host === "openlibrary.org").map((call) => call.at).sort((x, y) => x - y)
  assert.equal(times.length, 5, "Cada ISBN distinto produce una petición")
  for (const gap of gaps(times)) assert.ok(gap >= 1000 - TOLERANCE_MS, `Dos peticiones OL separadas ${gap} ms`)
  assert.ok(search.results.every((r) => r.status === "found"))
  assert.ok(batch.results.every((r) => r.status === 200), "El lote espera su turno en lugar de fallar")
  assert.equal(cover.results[0].status, "notFound", "La ficha ficticia no tiene portada; no es una caída")
  const [bucket] = await ctx.sql`select interval_ms from biblib.catalogue_quota_buckets where provider = 'open-library' and credential_scope = ${ctx.scope}`
  assert.equal(bucket.interval_ms, 1000)
  const reservations = await ctx.sql`select owner_id, purpose from biblib.catalogue_quota_reservations where credential_scope = ${ctx.scope}`
  assert.equal(reservations.length, 5)
  assert.ok(reservations.some((r) => r.purpose === "batch" && r.owner_id === ctx.users.b), "La reserva de lote queda a nombre de su dueño")
})

test("OL y BNE no comparten reserva: cada proveedor tiene su cubo y su intervalo", async () => {
  const result = await runWorker(ctx, { mode: "fetch", owner: ctx.users.a, urls: [
    `https://openlibrary.org/api/books?bibkeys=ISBN:${fakeIsbn(40)}&format=json&jscmd=data`,
    "https://catalogo.bne.es/view/sru/ficticio",
    `https://openlibrary.org/api/books?bibkeys=ISBN:${fakeIsbn(41)}&format=json&jscmd=data`,
  ] })
  const ol = result.calls.filter((c) => c.host === "openlibrary.org").map((c) => c.at).sort((x, y) => x - y)
  const [bne] = result.calls.filter((c) => c.host.endsWith("bne.es")).map((c) => c.at)
  assert.equal(ol.length, 2)
  assert.ok(ol[1] - ol[0] >= 1000 - TOLERANCE_MS, "OL mantiene su intervalo")
  assert.ok(Math.abs(bne - ol[0]) < 900, "BNE no espera la plaza de OL")
  const buckets = await ctx.sql`select provider, interval_ms from biblib.catalogue_quota_buckets where credential_scope = ${ctx.scope} order by provider`
  assert.deepEqual(buckets.map((b) => [b.provider, b.interval_ms]), [["bne", 2000], ["open-library", 1000]])
})

test("429 con Retry-After: cooldown compartido entre procesos, sin peticiones y sin caché de ausencia", async () => {
  const isbn = fakeIsbn(50)
  const limited = await runWorker(ctx, { mode: "lookup", isbns: [isbn], owner: ctx.users.a, reply: "429", retryAfter: 3 })
  assert.equal(limited.calls.length, 1)
  assert.equal(limited.results[0].providers[0].status, "rateLimited")
  assert.equal(limited.results[0].providers[0].retryAfterSeconds, 3)
  const [bucket] = await ctx.sql`select extract(epoch from cooldown_until - clock_timestamp()) as seconds from biblib.catalogue_quota_buckets where provider = 'open-library' and credential_scope = ${ctx.scope}`
  assert.ok(Number(bucket.seconds) > 1 && Number(bucket.seconds) <= 3, "Cooldown según Retry-After")
  const other = await runWorker(ctx, { mode: "lookup", isbns: [fakeIsbn(51)], owner: ctx.users.b })
  assert.equal(other.calls.length, 0, "Otro proceso respeta el cooldown sin salir a la red")
  assert.equal(other.results[0].providers[0].status, "rateLimited")
  assert.ok(other.results[0].providers[0].retryAfterSeconds >= 1)
  assert.equal((await cacheRows(isbn)).length, 0, "Un 429 nunca se guarda como ausencia")
  const [{ seconds }] = await ctx.sql`select greatest(0, extract(epoch from cooldown_until - clock_timestamp())) as seconds from biblib.catalogue_quota_buckets where provider = 'open-library' and credential_scope = ${ctx.scope}`
  await sleep(Number(seconds) * 1000 + 200)
  const recovered = await runWorker(ctx, { mode: "lookup", isbns: [isbn], owner: ctx.users.a })
  assert.equal(recovered.calls.length, 1)
  assert.equal(recovered.results[0].status, "found")
})

test("worker muerto tras reservar: su concesión caduca, otro proceso la toma y la cuota sigue contando", async () => {
  const isbn = fakeIsbn(60)
  const dead = await runWorker(ctx, { mode: "die", isbns: [isbn], owner: ctx.users.a, leaseMs: 1500 })
  assert.equal(dead.code, 137)
  assert.deepEqual([dead.results[0].lease, dead.results[0].quota], ["leased", "reserved"])
  const started = Date.now()
  const heir = await runWorker(ctx, { mode: "lookup", isbns: [isbn], owner: ctx.users.a })
  assert.equal(heir.results[0].status, "found")
  assert.equal(heir.calls.length, 1)
  assert.ok(heir.calls[0].at - started >= 1000, "Esperó a que caducara la concesión del proceso muerto")
  const reservations = await ctx.sql`select id, slot_at, released_at from biblib.catalogue_quota_reservations where credential_scope = ${ctx.scope} order by slot_at`
  assert.equal(reservations.length, 2)
  assert.equal(reservations[0].id, dead.results[0].reservationId)
  assert.equal(reservations[0].released_at, null, "La reserva del muerto no se liberó, solo caduca")
  assert.ok(reservations[1].slot_at - reservations[0].slot_at >= 1000, "La plaza consumida por el muerto sigue respetando el intervalo")
  assert.notEqual(reservations[1].released_at, null)
})

test("carrera de caducidad: un worker tardío no publica una entrada vieja sobre la reciente (fencing)", async () => {
  const isbn = fakeIsbn(70)
  // El tardío obtiene la concesión (500 ms) y tarda 1,8 s; el reciente la toma al caducar y publica antes.
  const late = runWorker(ctx, { mode: "lookup", isbns: [isbn], owner: ctx.users.a, leaseMs: 500, delayMs: 1800, title: "Entrada vieja" })
  await sleep(1200)
  const fresh = await runWorker(ctx, { mode: "lookup", isbns: [isbn], owner: ctx.users.b, leaseMs: 500, title: "Entrada reciente" })
  const old = await late
  assert.equal(old.calls.length, 1)
  assert.equal(fresh.calls.length, 1)
  assert.equal(fresh.results[0].candidates[0].title, "Entrada reciente")
  // El tardío entrega su resultado a su solicitante, pero la base rechaza la publicación.
  assert.equal(old.results[0].candidates[0].title, "Entrada vieja")
  const [row] = await cacheRows(isbn)
  assert.equal(row.payload[0].title, "Entrada reciente")
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.catalogue_inflight where credential_scope = ${ctx.scope}`)[0].n, 0)
})

test("caché malformada se descarta y se vuelve a consultar; nunca llega como ficha ni ausencia", async () => {
  const isbn = fakeIsbn(80)
  const version = policyVersion("open-library")
  await ctx.sql`insert into biblib.catalogue_cache (provider, policy_version, credential_scope, schema_version, operation, canonical_key, status, payload, fence, fetched_at, expires_at)
    values ('open-library', ${version}, ${ctx.scope}, 1, 'lookupISBN', ${isbn}, 'found', ${ctx.sql.json([{ provider: "open-library", title: 42 }])}, 1, now(), now() + interval '1 hour')`
  const result = await runWorker(ctx, { mode: "lookup", isbns: [isbn], owner: ctx.users.a })
  assert.equal(result.results[0].status, "found")
  assert.equal(result.calls.length, 1)
  const [row] = await cacheRows(isbn)
  assert.equal(row.payload[0].title, "Ficha ficticia compartida")
  assert.ok(BigInt(row.fence) > 1n)
})

test("cambio de política o de schema invalida entradas incompatibles; una política que deniega no escribe", async () => {
  const isbn = fakeIsbn(90)
  for (const [policy, schema] of [["2020-01-01.0", 1], [policyVersion("open-library"), 0]]) {
    await ctx.sql`insert into biblib.catalogue_cache (provider, policy_version, credential_scope, schema_version, operation, canonical_key, status, payload, fence, fetched_at, expires_at)
      values ('open-library', ${policy}, ${ctx.scope}, ${schema}, 'lookupISBN', ${isbn}, 'notFound', '[]'::jsonb, 1, now(), now() + interval '1 hour')`
  }
  const result = await runWorker(ctx, { mode: "lookup", isbns: [isbn], owner: ctx.users.a })
  assert.equal(result.results[0].status, "found", "Las ausencias de otra política o schema no se reutilizan")
  assert.equal(result.calls.length, 1)
  const rows = await cacheRows(isbn)
  assert.deepEqual(rows.map((r) => [r.policy_version, r.schema_version, r.status]), [[policyVersion("open-library"), 1, "found"]], "Las incompatibles se retiraron")
  // Con la caché denegada por política: se consulta, no se escribe y se retiran las existentes del proveedor.
  const denied = await runWorker(ctx, { mode: "lookup", isbns: [isbn, fakeIsbn(91)], owner: ctx.users.a, denyCache: true })
  assert.equal(denied.calls.length, 2, "Sin caché permitida cada consulta va al proveedor")
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.catalogue_cache where credential_scope = ${ctx.scope}`)[0].n, 0)
})

test("búsqueda de texto: caché privada por dueño con HMAC; B no reutiliza la de A y no queda el texto", async () => {
  const query = JSON.stringify(["consulta ficticia privada", ""])
  const secret = "clave-de-prueba-".repeat(3)
  const a = await runWorker(ctx, { mode: "text", query, owner: ctx.users.a, secret })
  assert.deepEqual(a.results, ["found", "found"])
  assert.equal(a.calls.length, 1, "La segunda búsqueda de A sale de su caché privada")
  const b = await runWorker(ctx, { mode: "text", query, owner: ctx.users.b, secret })
  assert.equal(b.calls.length, 1, "B no reutiliza la entrada privada de A")
  const rows = await ctx.sql`select owner_id, key_hmac, payload from biblib.catalogue_private_cache where credential_scope = ${ctx.scope} order by owner_id`
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].key_hmac, rows[1].key_hmac)
  assert.ok(rows.every((row) => /^[0-9a-f]{64}$/.test(row.key_hmac) && !JSON.stringify(row).includes("consulta ficticia")))
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.catalogue_cache where credential_scope = ${ctx.scope}`)[0].n, 0, "Nada de la búsqueda privada llega a la caché compartida")
})

test("Postgres no disponible: unavailable sin ráfaga externa", async () => {
  const result = await runWorker(ctx, { mode: "lookup", isbns: [fakeIsbn(95)], owner: ctx.users.a }, { dbUrl: "postgresql://postgres:postgres@127.0.0.1:9/postgres" })
  assert.equal(result.calls.length, 0)
  assert.equal(result.results[0].status, "incomplete")
  assert.equal(result.results[0].providers[0].status, "unavailable")
})

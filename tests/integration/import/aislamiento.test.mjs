import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fixtureLibrary, runId, runTitle } from "../lib/context.mjs"
import { callAction } from "../lib/app.mjs"
import { liveCookies, signIn } from "../lib/sessions.mjs"
import { setupSuite } from "../lib/suite.mjs"

// library_state, import_previews y library_operations con los roles reales de Supabase en SQL y por la
// Data API. Cada intento SQL ocurre en una transacción que siempre se revierte.

let s, lib, preview, tokenA
const ROLLBACK = Symbol("rollback")

before(async () => {
  s = await setupSuite()
  lib = await fixtureLibrary(s.ctx, s.sql)
  const fixture = await signIn("a")
  tokenA = fixture.session.access_token
  const shelfTitle = runTitle("Aislamiento")
  const input = { shelves: [{ id: "s", title: shelfTitle, book_count: 1 }], books: [{ id: "l", isbn: `manual-qa01-${runId()}-aislamiento`, title: runTitle("Libro aislamiento"), authors: [], number_of_pages: 1, publish_date: "", cover: {}, status: "unread", shelf_id: "s", shelf_name: shelfTitle }] }
  const result = await callAction(s.app, "prepareImportAction", [input, "merge"], { cookies: liveCookies(fixture) })
  assert.equal(result.value?.ok, true)
  preview = result.value.value
  s.record("previews", { id: preview.previewId, userId: lib.a.userId })
})
after(async () => {
  await s?.cleanupOwn()
  await s?.close()
})

async function as(userId, body, { role = "authenticated" } = {}) {
  let result
  try {
    await s.sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role })}, true)`
      await tx.unsafe(`set local role ${role === "anon" ? "anon" : "authenticated"}`)
      result = await body(tx)
      throw ROLLBACK
    })
  } catch (error) { if (error !== ROLLBACK) throw error }
  return result
}

async function sqlState(tx, statement) {
  try { await tx.savepoint((sp) => statement(sp)); return null } catch (error) { return error.code ?? "desconocido" }
}

test("B no lee, enumera ni confirma vistas previas u operaciones de A por SQL", async () => {
  const seen = await as(lib.b.userId, async (tx) => ({
    byId: await tx`select id from biblib.import_previews where id = ${preview.previewId}`,
    previews: await tx`select user_id from biblib.import_previews`,
    operations: await tx`select user_id from biblib.library_operations`,
    states: await tx`select user_id from biblib.library_state`,
    forgedOperation: await sqlState(tx, (sp) => sp`insert into biblib.library_operations(user_id, operation, idempotency_key, input_digest, preview_id, status, result)
      values (${lib.a.userId}, 'import.confirm', ${`qa01-${runId()}-forjada`}, ${"a".repeat(64)}, ${preview.previewId}, 'committed', '{}')`),
    deletePreview: await tx`delete from biblib.import_previews where id = ${preview.previewId} returning id`,
  }))
  assert.equal(seen.byId.length, 0, "Pedir el ID de A no lo revela.")
  assert.ok(seen.previews.every((row) => row.user_id === lib.b.userId))
  assert.ok(seen.operations.every((row) => row.user_id === lib.b.userId))
  assert.deepEqual(seen.states.map((row) => row.user_id), [lib.b.userId], "B solo ve su propia revisión.")
  assert.equal(seen.forgedOperation, "42501", "B no puede registrar un resultado a nombre de A.")
  assert.equal(seen.deletePreview.length, 0)
  const [{ n }] = await s.sql`select count(*)::int as n from biblib.import_previews where id = ${preview.previewId}`
  assert.equal(n, 1)
})

test("authenticated no altera library_state, ni la suya ni la de otro; lock_library solo bloquea la propia", async () => {
  const revisionA = (await s.sql`select revision from biblib.library_state where user_id = ${lib.a.userId}`)[0].revision
  for (const [owner, target] of [[lib.b.userId, lib.a.userId], [lib.a.userId, lib.a.userId]]) {
    const states = await as(owner, async (tx) => ({
      update: await sqlState(tx, (sp) => sp`update biblib.library_state set revision = gen_random_uuid() where user_id = ${target}`),
      insert: await sqlState(tx, (sp) => sp`insert into biblib.library_state(user_id) values (${target}) on conflict do nothing`),
      remove: await sqlState(tx, (sp) => sp`delete from biblib.library_state where user_id = ${target}`),
      truncate: await sqlState(tx, (sp) => sp`truncate biblib.library_state`),
      rotate: await sqlState(tx, (sp) => sp`select biblib.rotate_library_revision()`),
      locked: (await tx`select biblib.lock_library() as revision`)[0].revision,
      own: (await tx`select revision from biblib.library_state`)[0].revision,
    }))
    for (const name of ["update", "insert", "remove", "truncate"]) assert.equal(states[name], "42501", `${name} debe rechazarse por privilegios.`)
    assert.ok(states.rotate, "La función del trigger no se invoca directamente.")
    assert.equal(states.locked, states.own, "lock_library devuelve la revisión de la sesión.")
  }
  assert.equal((await s.sql`select revision from biblib.library_state where user_id = ${lib.a.userId}`)[0].revision, revisionA)
})

test("anon no accede a la revisión, las vistas previas ni la función de bloqueo", async () => {
  const states = await as(lib.a.userId, async (tx) => ({
    state: await sqlState(tx, (sp) => sp`select * from biblib.library_state`),
    previews: await sqlState(tx, (sp) => sp`select * from biblib.import_previews`),
    lock: await sqlState(tx, (sp) => sp`select biblib.lock_library()`),
  }), { role: "anon" })
  assert.deepEqual(states, { state: "42501", previews: "42501", lock: "42501" })
})

function rest(route, { method = "GET", bearer, body } = {}) {
  const headers = { apikey: s.ctx.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${bearer ?? s.ctx.env.SUPABASE_ANON_KEY}`, [method === "GET" ? "Accept-Profile" : "Content-Profile"]: "biblib" }
  if (body) headers["Content-Type"] = "application/json"
  return fetch(`${s.ctx.env.SUPABASE_URL}${route}`, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(10000) })
}

test("la Data API no expone revisión, vistas previas, operaciones ni lock_library", async () => {
  for (const bearer of [undefined, tokenA]) {
    for (const table of ["library_state", "import_previews", "library_operations"]) {
      const read = await rest(`/rest/v1/${table}?select=*`, { bearer })
      assert.equal(read.status, 406, `GET ${table} debe rechazarse.`)
      assert.equal((await read.json()).code, "PGRST106")
    }
    const patch = await rest(`/rest/v1/library_state?user_id=eq.${lib.a.userId}`, { method: "PATCH", bearer, body: { revision: "00000000-0000-4000-8000-000000000000" } })
    assert.equal(patch.status, 406)
    const rpc = await rest("/rest/v1/rpc/lock_library", { method: "POST", bearer, body: {} })
    assert.equal(rpc.status, 406)
  }
})

import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fixtureLibrary } from "../lib/context.mjs"
import { setupSuite } from "../lib/suite.mjs"

// Reproduce, sobre una única conexión reutilizada, las mismas sentencias de withRlsContext
// (lib/db/client.ts): claims y rol locales a la transacción. Tras cada commit o rollback la
// conexión debe volver a postgres sin claims. La variante de app está en rls/acciones-ab.

let s, lib

before(async () => {
  s = await setupSuite()
  lib = await fixtureLibrary(s.ctx, s.sql)
})
after(() => s?.close())

function withRlsContext(userId, body) {
  return s.sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`
    await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`
    await tx`set local role authenticated`
    return body(tx)
  })
}

async function residue() {
  const [row] = await s.sql`select pg_backend_pid() as pid, current_user as role, auth.uid() as uid,
    nullif(current_setting('request.jwt.claims', true), '') as claims, nullif(current_setting('request.jwt.claim.sub', true), '') as sub`
  return row
}

async function visibleOwners(tx) {
  return [...new Set((await tx`select user_id from biblib.books`).map((row) => row.user_id))]
}

test("conexión reutilizada A → B → sin claims, también tras una transacción fallida", async () => {
  const start = await residue()
  assert.deepEqual({ role: start.role, uid: start.uid, claims: start.claims, sub: start.sub }, { role: "postgres", uid: null, claims: null, sub: null })

  assert.deepEqual(await withRlsContext(lib.a.userId, visibleOwners), [lib.a.userId])
  const afterA = await residue()
  assert.equal(afterA.pid, start.pid, "Debe ser la misma conexión física.")
  assert.deepEqual({ role: afterA.role, uid: afterA.uid, claims: afterA.claims, sub: afterA.sub }, { role: "postgres", uid: null, claims: null, sub: null })

  assert.deepEqual(await withRlsContext(lib.b.userId, visibleOwners), [lib.b.userId])

  await assert.rejects(withRlsContext(lib.a.userId, async (tx) => {
    await tx`update biblib.books set status = status where user_id = ${lib.a.userId}`
    await tx`select 1 / 0`
  }), { code: "22012" })
  const afterFailure = await residue()
  assert.equal(afterFailure.pid, start.pid)
  assert.deepEqual({ role: afterFailure.role, uid: afterFailure.uid, claims: afterFailure.claims, sub: afterFailure.sub }, { role: "postgres", uid: null, claims: null, sub: null })

  assert.deepEqual(await withRlsContext(lib.b.userId, visibleOwners), [lib.b.userId], "B no hereda claims de la transacción fallida de A.")
  const [{ n }] = await s.sql.begin(async (tx) => {
    await tx`set local role authenticated`
    return tx`select count(*)::int as n from biblib.books`
  })
  assert.equal(n, 0, "Sin claims, el rol authenticated no ve ninguna fila.")
})

import assert from "node:assert/strict"
import { createClient } from "@supabase/supabase-js"
import { after, before, test } from "node:test"
import { signInFixture } from "../support/session.mjs"
import { catalogueContext, fakeIsbn, policyVersion } from "./lib/context.mjs"

// A no puede ver ni manipular la cuota, las reservas, la caché compartida ni la caché privada de B:
// ni con SQL bajo el rol `authenticated` (claims como PostgREST) ni por la Data API con su JWT real.
// Cada intento SQL va en una transacción que se revierte siempre.

let ctx, session, signedIn
const ROLLBACK = Symbol("rollback")
const SHARED = ["catalogue_cache", "catalogue_inflight", "catalogue_quota_buckets", "catalogue_quota_reservations"]
const FUNCTIONS = [
  "catalogue_reserve('open-library', 'x', null, 'interactive', 1000, 2500, 2, 10000)",
  "catalogue_release(gen_random_uuid(), 1, 1000)",
  "catalogue_begin('open-library', 'v', 'x', 1, 'lookupISBN', 'k', true, 1000, null)",
  "catalogue_complete('open-library', 'v', 'x', 1, 'lookupISBN', 'k', 1, 'found', '[]'::jsonb, '{}'::jsonb, 1000)",
  "catalogue_private_get(gen_random_uuid(), 'open-library', 'v', 'x', 1, 'searchTitleAuthor', 'k')",
  "catalogue_private_put(gen_random_uuid(), 'open-library', 'v', 'x', 1, 'searchTitleAuthor', 'k', 'found', '[]'::jsonb, 1000)",
  "catalogue_invalidate('open-library', null, 1)",
]
const hmac = (char) => char.repeat(64)

before(async () => {
  ctx = await catalogueContext()
  signedIn = await signInFixture("a", { profile: ctx.profile })
  session = signedIn.session
  const version = policyVersion("open-library")
  // Filas reales de A y B: cuota/reserva de B y caché privada de ambos.
  await ctx.sql`select biblib.catalogue_reserve('open-library', ${ctx.scope}, ${ctx.users.b}::uuid, 'interactive', 1000, 2500, 2, 60000)`
  await ctx.sql`insert into biblib.catalogue_cache (provider, policy_version, credential_scope, schema_version, operation, canonical_key, status, payload, fence, fetched_at, expires_at)
    values ('open-library', ${version}, ${ctx.scope}, 1, 'lookupISBN', ${fakeIsbn(100)}, 'notFound', '[]'::jsonb, 1, now(), now() + interval '1 hour')`
  for (const [owner, char] of [[ctx.users.a, "a"], [ctx.users.b, "b"]]) {
    await ctx.sql`select biblib.catalogue_private_put(${owner}::uuid, 'open-library', ${version}, ${ctx.scope}, 1, 'searchTitleAuthor', ${hmac(char)}, 'notFound', '[]'::jsonb, 600000)`
  }
})
after(async () => {
  await signedIn?.client.auth.signOut({ scope: "local" }).catch(() => {})
  if (ctx) { await ctx.cleanup(); await ctx.close() }
})

async function as(userId, body, role = "authenticated") {
  let result
  try {
    await ctx.sql.begin(async (tx) => {
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

test("authenticated y anon no leen ni escriben la caché compartida, las consultas en vuelo ni las cuotas", async () => {
  for (const role of ["authenticated", "anon"]) {
    const states = await as(ctx.users.a, async (tx) => {
      const out = {}
      for (const table of SHARED) {
        out[`${table}.select`] = await sqlState(tx, (sp) => sp.unsafe(`select * from biblib.${table}`))
        out[`${table}.delete`] = await sqlState(tx, (sp) => sp.unsafe(`delete from biblib.${table}`))
        out[`${table}.update`] = await sqlState(tx, (sp) => sp.unsafe(`update biblib.${table} set provider = provider`))
      }
      out["reservations.insert"] = await sqlState(tx, (sp) => sp`insert into biblib.catalogue_quota_reservations (provider, credential_scope, owner_id, purpose, fence, slot_at, expires_at) values ('open-library', ${ctx.scope}, ${ctx.users.a}::uuid, 'interactive', 1, now(), now() + interval '1 hour')`)
      out.sequence = await sqlState(tx, (sp) => sp`select nextval('biblib.catalogue_fence_seq')`)
      return out
    }, role)
    for (const [operation, state] of Object.entries(states)) assert.equal(state, "42501", `${role}: ${operation} debe denegarse por privilegios`)
  }
})

test("ninguna función catalogue_* es ejecutable con rol de cliente", async () => {
  for (const role of ["authenticated", "anon"]) {
    const states = await as(ctx.users.a, async (tx) => {
      const out = {}
      for (const call of FUNCTIONS) out[call.split("(")[0]] = await sqlState(tx, (sp) => sp.unsafe(`select biblib.${call}`))
      return out
    }, role)
    for (const [name, state] of Object.entries(states)) assert.equal(state, "42501", `${role} no puede ejecutar ${name}`)
  }
  // Las filas de B siguen intactas tras todos los intentos.
  const [{ n }] = await ctx.sql`select count(*)::int as n from biblib.catalogue_quota_reservations where credential_scope = ${ctx.scope} and owner_id = ${ctx.users.b}`
  assert.equal(n, 1)
})

test("caché privada: A solo ve y purga lo suyo; no escribe, no actualiza y no toca lo de B", async () => {
  const seen = await as(ctx.users.a, async (tx) => {
    const rows = await tx`select owner_id, key_hmac from biblib.catalogue_private_cache where credential_scope = ${ctx.scope}`
    const insert = await sqlState(tx, (sp) => sp`insert into biblib.catalogue_private_cache (owner_id, provider, policy_version, credential_scope, schema_version, operation, key_hmac, status, payload, fetched_at, expires_at)
      values (${ctx.users.a}::uuid, 'open-library', 'v', ${ctx.scope}, 1, 'searchTitleAuthor', ${hmac("c")}, 'found', '[]'::jsonb, now(), now() + interval '1 hour')`)
    const update = await sqlState(tx, (sp) => sp`update biblib.catalogue_private_cache set status = 'found' where owner_id = ${ctx.users.b}::uuid`)
    const deleteB = await tx`delete from biblib.catalogue_private_cache where owner_id = ${ctx.users.b}::uuid returning 1`
    const deleteOwn = await tx`delete from biblib.catalogue_private_cache where owner_id = ${ctx.users.a}::uuid and credential_scope = ${ctx.scope} returning 1`
    return { rows, insert, update, deletedB: deleteB.length, deletedOwn: deleteOwn.length }
  })
  assert.deepEqual(seen.rows.map((r) => [r.owner_id, r.key_hmac]), [[ctx.users.a, hmac("a")]])
  assert.equal(seen.insert, "42501")
  assert.equal(seen.update, "42501")
  assert.equal(seen.deletedB, 0, "RLS oculta las filas de B: borrar no afecta a nada")
  assert.equal(seen.deletedOwn, 1)
  const [{ n }] = await ctx.sql`select count(*)::int as n from biblib.catalogue_private_cache where credential_scope = ${ctx.scope} and owner_id = ${ctx.users.b}`
  assert.equal(n, 1, "La fila privada de B sigue en su sitio")
  const anon = await as(ctx.users.a, (tx) => sqlState(tx, (sp) => sp`select * from biblib.catalogue_private_cache`), "anon")
  assert.equal(anon, "42501")
})

test("la Data API con el JWT real de A no expone tablas ni funciones de coordinación", async () => {
  const rest = (route, { method = "GET", profile, body } = {}) => fetch(`${ctx.env.SUPABASE_URL}${route}`, {
    method, signal: AbortSignal.timeout(10000), body: body && JSON.stringify(body),
    headers: { apikey: ctx.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...(profile ? { [method === "GET" ? "Accept-Profile" : "Content-Profile"]: profile } : {}) },
  })
  for (const table of [...SHARED, "catalogue_private_cache"]) {
    const read = await rest(`/rest/v1/${table}?select=*`, { profile: "biblib" })
    assert.equal(read.status, 406, `${table} no se sirve por la Data API`)
    assert.equal((await read.json()).code, "PGRST106")
    const plain = await rest(`/rest/v1/${table}?select=*`)
    assert.equal(plain.status, 404)
  }
  for (const fn of ["catalogue_reserve", "catalogue_begin", "catalogue_complete", "catalogue_release"]) {
    const call = await rest(`/rest/v1/rpc/${fn}`, { method: "POST", profile: "biblib", body: {} })
    assert.equal(call.status, 406, `${fn} no es invocable por RPC`)
    await call.body?.cancel()
  }
  const client = createClient(ctx.env.SUPABASE_URL, ctx.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${session.access_token}` } } })
  const { data, error } = await client.schema("biblib").rpc("catalogue_invalidate", { p_provider: "open-library", p_policy_version: null, p_schema_version: 1 })
  assert.equal(data, null)
  assert.ok(error)
  const [{ n }] = await ctx.sql`select count(*)::int as n from biblib.catalogue_cache where credential_scope = ${ctx.scope}`
  assert.equal(n, 1, "Ningún intento por la Data API invalidó la caché")
})

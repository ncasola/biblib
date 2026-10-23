import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { anonClient } from "../lib/context.mjs"
import { signIn } from "../lib/sessions.mjs"
import { setupSuite } from "../lib/suite.mjs"

// `biblib` no está en api.schemas: la Data API (PostgREST/GraphQL vía Kong) debe rechazarlo
// tanto para anónimo como para una sesión real; el dominio solo pasa por Server Actions.

let s, token

before(async () => {
  s = await setupSuite()
  token = (await signIn("a")).session.access_token
})
after(() => s?.close())

function rest(route, { method = "GET", profile, bearer, body } = {}) {
  const headers = { apikey: s.ctx.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${bearer ?? s.ctx.env.SUPABASE_ANON_KEY}` }
  if (profile) headers[method === "GET" ? "Accept-Profile" : "Content-Profile"] = profile
  if (body) headers["Content-Type"] = "application/json"
  return fetch(`${s.ctx.env.SUPABASE_URL}${route}`, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(10000) })
}

test("PostgREST rechaza el esquema biblib para anónimo y para A (lectura y escritura)", async () => {
  for (const bearer of [undefined, token]) {
    for (const table of ["books", "shelves"]) {
      const read = await rest(`/rest/v1/${table}?select=*`, { profile: "biblib", bearer })
      const json = await read.json()
      assert.equal(read.status, 406, `GET ${table} con perfil biblib debe rechazarse.`)
      assert.equal(json.code, "PGRST106")
      assert.ok(!Array.isArray(json))
    }
    const write = await rest("/rest/v1/books", { method: "POST", profile: "biblib", bearer, body: { title: "Intruso" } })
    assert.equal(write.status, 406)
  }
})

test("el esquema público no expone tablas de BibLib", async () => {
  const response = await rest("/rest/v1/books?select=*", { bearer: token })
  assert.equal(response.status, 404)
  assert.equal((await response.json()).code, "PGRST205")
})

test("supabase-js con .schema('biblib') no obtiene datos", async () => {
  for (const client of [anonClient(s.ctx), anonClient(s.ctx, token)]) {
    const { data, error } = await client.schema("biblib").from("books").select("id")
    assert.equal(data, null)
    assert.ok(error, "El SDK debe devolver error.")
  }
})

test("GraphQL no expone libros ni estanterías (pg_graphql desactivado en el stack)", async () => {
  const response = await fetch(`${s.ctx.env.SUPABASE_URL}/graphql/v1`, {
    method: "POST", signal: AbortSignal.timeout(10000),
    headers: { apikey: s.ctx.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ __schema { queryType { fields { name } } } }" }),
  })
  const json = await response.json()
  assert.equal(response.status, 200)
  // Hoy la extensión no está habilitada; si se activara, la introspección tampoco debe mencionar biblib.
  const disabled = json.errors?.some((e) => /pg_graphql extension is not enabled/.test(e.message))
  assert.ok(disabled || (json.data && !/books|shelves/i.test(JSON.stringify(json.data))), "GraphQL no debe reflejar tablas de biblib.")
})

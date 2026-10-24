import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { FILTERS, value, viewsContext } from "./lib/context.mjs"

let ctx, a, b
before(async () => { ctx = await viewsContext(); a = await ctx.signIn("a"); b = await ctx.signIn("b") })
after(async () => { if (ctx) { await ctx.cleanup(); await ctx.close() } })
const failed = (response, code) => assert.equal(response.value?.error?.code, code)

test("CRUD por acciones reales: persistencia, versiones y revisión de colección intacta", async () => {
  const revision = await ctx.revision(ctx.users.a)
  const view = value(await ctx.call("saveCurrentViewAction", [{ name: ctx.name("Lecturas"), filters: FILTERS }], a))
  assert.deepEqual(view.filters, FILTERS)
  assert.ok(value(await ctx.call("listSavedViewsAction", [], a)).some((entry) => entry.id === view.id))
  const renamed = value(await ctx.call("renameSavedViewAction", [{ id: view.id, name: ctx.name("Renombrada"), expectedVersion: view.version }], a))
  assert.notEqual(renamed.version, view.version)
  failed(await ctx.call("renameSavedViewAction", [{ id: view.id, name: ctx.name("Obsoleta"), expectedVersion: view.version }], a), "CONFLICT")
  failed(await ctx.call("overwriteSavedViewAction", [{ id: view.id, filters: { ...FILTERS, status: "read" }, expectedVersion: view.version }], a), "CONFLICT")
  failed(await ctx.call("deleteSavedViewAction", [{ id: view.id, expectedVersion: view.version }], a), "CONFLICT")
  const overwritten = value(await ctx.call("overwriteSavedViewAction", [{ id: view.id, filters: { ...FILTERS, view: "grid", pageSize: 48 }, expectedVersion: renamed.version }], a))
  assert.equal(overwritten.filters.view, "grid")
  assert.equal(overwritten.filters.pageSize, 48)
  value(await ctx.call("deleteSavedViewAction", [{ id: view.id, expectedVersion: overwritten.version }], a))
  assert.equal(await ctx.revision(ctx.users.a), revision)
})

test("A/B: B no ve, renombra, sobrescribe ni borra lo de A por acción, SQL o Data API", async () => {
  const view = value(await ctx.call("saveCurrentViewAction", [{ name: ctx.name("Privada"), filters: FILTERS }], a))
  assert.equal(value(await ctx.call("listSavedViewsAction", [], b)).some((entry) => entry.id === view.id), false)
  for (const [action, extra] of [["renameSavedViewAction", { name: ctx.name("Intrusión") }], ["overwriteSavedViewAction", { filters: FILTERS }], ["deleteSavedViewAction", {}]]) {
    failed(await ctx.call(action, [{ id: view.id, expectedVersion: view.version, ...extra }], b), "NOT_FOUND")
  }
  await ctx.asUser(ctx.users.b, async (tx) => {
    assert.equal((await tx`select * from biblib.saved_book_views where id = ${view.id}`).length, 0)
    assert.equal((await tx`update biblib.saved_book_views set name = 'Intrusión' where id = ${view.id}`).count, 0)
    assert.equal((await tx`delete from biblib.saved_book_views where id = ${view.id}`).count, 0)
  })
  await assert.rejects(ctx.asUser(ctx.users.b, (tx) => tx`insert into biblib.saved_book_views (user_id,name,filters) values (${ctx.users.a}, ${ctx.name("Ajena")}, ${tx.json(FILTERS)})`), { code: "42501" })
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    const env = ctx.resolved.target.env()
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/saved_book_views?id=eq.${view.id}`, {
      method, signal: AbortSignal.timeout(10_000), headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${b.session.access_token}`, [method === "GET" ? "Accept-Profile" : "Content-Profile"]: "biblib", "Content-Type": "application/json" },
      ...(method === "POST" || method === "PATCH" ? { body: JSON.stringify({ name: "Intrusión" }) } : {}),
    })
    assert.equal(response.status, 406)
    assert.equal((await response.json()).code, "PGRST106")
  }
})

test("servidor y base rechazan nombres largos, duplicados y criterios arbitrarios", async () => {
  const name = ctx.name("Nombre único")
  value(await ctx.call("saveCurrentViewAction", [{ name, filters: FILTERS }], a))
  failed(await ctx.call("saveCurrentViewAction", [{ name: name.toUpperCase(), filters: FILTERS }], a), "CONFLICT")
  for (const input of [{ name: "x".repeat(81), filters: FILTERS }, { name: ctx.name("SQL"), filters: { ...FILTERS, sql: "select *" } }, { name: ctx.name("Selección"), filters: { ...FILTERS, selectedIds: [] } }]) {
    failed(await ctx.call("saveCurrentViewAction", [input], a), "INVALID_INPUT")
  }
  for (const filters of [{ ...FILTERS, page: 2 }, { ...FILTERS, status: null }, { ...FILTERS, pageSize: "10" }, { ...FILTERS, pageSize: 10.1 }, []]) {
    await assert.rejects(ctx.asUser(ctx.users.a, (tx) => tx`insert into biblib.saved_book_views (user_id,name,filters) values (${ctx.users.a}, ${ctx.name("Inválida")}, ${tx.json(filters)})`), { code: "23514" })
  }
  // Un filtro nulo lo rechaza antes la restricción NOT NULL de la columna (23502) que el CHECK de contenido.
  await assert.rejects(ctx.asUser(ctx.users.a, (tx) => tx`insert into biblib.saved_book_views (user_id,name,filters) values (${ctx.users.a}, ${ctx.name("Nula")}, ${null})`), { code: "23502" })
  await assert.rejects(ctx.asUser(ctx.users.a, (tx) => tx`insert into biblib.saved_book_views (user_id,name,filters) values (${ctx.users.a}, ${"x".repeat(81)}, ${tx.json(FILTERS)})`), { code: "23514" })
})

test("límite 100 en servidor y base, incluidas dos altas simultáneas para el último hueco", async () => {
  const [{ n }] = await ctx.sql`select count(*)::int n from biblib.saved_book_views where user_id = ${ctx.users.a}`
  try {
    await ctx.asUser(ctx.users.a, async (tx) => {
      for (let i = n; i < 99; i++) await tx`insert into biblib.saved_book_views (user_id,name,filters) values (${ctx.users.a}, ${ctx.name(`Cuota ${i}`)}, ${tx.json(FILTERS)})`
    })
    const concurrent = await Promise.allSettled([1, 2].map((i) => ctx.asUser(ctx.users.a, (tx) => tx`insert into biblib.saved_book_views (user_id,name,filters) values (${ctx.users.a}, ${ctx.name(`Carrera ${i}`)}, ${tx.json(FILTERS)})`)))
    assert.equal(concurrent.filter((entry) => entry.status === "fulfilled").length, 1)
    assert.equal(concurrent.find((entry) => entry.status === "rejected").reason.code, "BV001")
    assert.equal((await ctx.sql`select count(*)::int n from biblib.saved_book_views where user_id = ${ctx.users.a}`)[0].n, 100)
    failed(await ctx.call("saveCurrentViewAction", [{ name: ctx.name("Exceso"), filters: FILTERS }], a), "LIMIT_EXCEEDED")
    await assert.rejects(ctx.asUser(ctx.users.a, (tx) => tx`insert into biblib.saved_book_views (user_id,name,filters) values (${ctx.users.a}, ${ctx.name("Exceso SQL")}, ${tx.json(FILTERS)})`), { code: "BV001" })
  } finally { await ctx.cleanup() }
})

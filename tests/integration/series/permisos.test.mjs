import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { seriesContext, value } from "./lib/context.mjs"

// U-PRO-05 · Series privadas por cuenta: un título repetido en otra cuenta es válido y cada una ve solo lo suyo; B no
// lee, edita, borra ni enlaza series o ediciones de A (la respuesta es «no disponible», la misma que para un
// identificador inexistente), y ni siquiera con SQL con los claims de B se cruza una edición o serie ajena.

let ctx, a, b, sessionA, sessionB, libA, libB, sagaA, sagaB, linkA
const MISSING = "00000000-0000-4000-8000-0000000000aa"

before(async () => {
  ctx = await seriesContext()
  a = await ctx.account("a")
  b = await ctx.account("b")
  sessionA = await ctx.signIn(a)
  sessionB = await ctx.signIn(b)
  libA = await ctx.library(a.id)
  libB = await ctx.library(b.id)
  const title = ctx.label("Saga compartida de nombre")
  sagaA = value(await ctx.call("createSeriesAction", [{ title, description: "De A" }], sessionA))
  sagaB = value(await ctx.call("createSeriesAction", [{ title }], sessionB))
  linkA = value(await ctx.call("linkEditionToSeriesAction", [{ editionId: libA.books[0].editionId, seriesId: sagaA.id, position: "1" }], sessionA))
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

test("el mismo título en otra cuenta es válido y cada cuenta lista solo lo suyo", async () => {
  assert.notEqual(sagaA.id, sagaB.id)
  const listA = value(await ctx.call("listSeriesAction", [], sessionA))
  const listB = value(await ctx.call("listSeriesAction", [], sessionB))
  assert.deepEqual(listA.map((item) => item.id), [sagaA.id])
  assert.deepEqual(listB.map((item) => item.id), [sagaB.id])
  assert.equal(listA[0].title, listB[0].title)
  // Dentro de una misma cuenta el título también puede repetirse (dos ediciones de una saga con el mismo nombre).
  const twin = await ctx.attempt("createSeriesAction", [{ title: sagaA.title }], sessionA)
  assert.equal(twin.ok, true)
})

test("B no abre, edita ni borra la serie de A: responde como una serie inexistente", async () => {
  const missing = await ctx.attempt("getSeriesAction", [MISSING], sessionB)
  assert.equal(missing.ok, false)
  const read = await ctx.attempt("getSeriesAction", [sagaA.id], sessionB)
  assert.deepEqual({ code: read.code, message: read.message }, { code: missing.code, message: missing.message })
  const edit = await ctx.attempt("updateSeriesAction", [{ id: sagaA.id, expectedVersion: sagaA.version, title: "Robada" }], sessionB)
  const remove = await ctx.attempt("deleteSeriesAction", [{ id: sagaA.id, expectedVersion: sagaA.version }], sessionB)
  assert.equal(edit.code, "NOT_FOUND")
  assert.equal(remove.code, "NOT_FOUND")
  const [row] = await ctx.sql`select title, description from biblib.series where id = ${sagaA.id}`
  assert.deepEqual({ ...row }, { title: sagaA.title, description: "De A" })
})

test("B no vincula una edición de A ni usa una serie de A, y A no ve los de B", async () => {
  const ghost = await ctx.attempt("linkEditionToSeriesAction", [{ editionId: MISSING, seriesId: sagaB.id }], sessionB)
  const foreignEdition = await ctx.attempt("linkEditionToSeriesAction", [{ editionId: libA.books[1].editionId, seriesId: sagaB.id, position: "1" }], sessionB)
  const foreignSeries = await ctx.attempt("linkEditionToSeriesAction", [{ editionId: libB.books[0].editionId, seriesId: sagaA.id, position: "2" }], sessionB)
  assert.deepEqual({ code: foreignEdition.code, message: foreignEdition.message }, { code: ghost.code, message: ghost.message }, "no confirma que la edición exista en A")
  assert.equal(foreignEdition.code, "NOT_FOUND")
  assert.equal(foreignSeries.code, "NOT_FOUND")
  const state = await ctx.attempt("getEditionSeriesAction", [libA.books[0].editionId], sessionB)
  assert.equal(state.code, "NOT_FOUND", "B no consulta el vínculo de una edición de A")
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.series_editions where user_id = ${b.id}`)[0].n, 0)
})

test("B no mueve ni quita el vínculo de A aunque conozca su versión", async () => {
  const move = await ctx.attempt("moveSeriesVolumeAction", [{ editionId: libA.books[0].editionId, seriesId: sagaB.id, expectedVersion: linkA.link.version, position: "9" }], sessionB)
  const unlink = await ctx.attempt("unlinkEditionFromSeriesAction", [{ editionId: libA.books[0].editionId, expectedVersion: linkA.link.version }], sessionB)
  assert.equal(move.code, "NOT_FOUND")
  assert.equal(unlink.code, "NOT_FOUND")
  const [row] = await ctx.sql`select series_id, trim_scale(position)::text as position, version from biblib.series_editions where edition_id = ${libA.books[0].editionId}`
  assert.deepEqual({ series: row.series_id, position: row.position, version: row.version }, { series: sagaA.id, position: "1", version: linkA.link.version })
})

test("con SQL y los claims de B, ninguna fila de series cruza cuentas", async () => {
  const outcome = await ctx.rolledBack(b.id, async (tx) => ({
    seesA: (await tx`select count(*)::int as n from biblib.series where user_id = ${a.id}`)[0].n,
    seesLinks: (await tx`select count(*)::int as n from biblib.series_editions where user_id = ${a.id}`)[0].n,
    forA: await ctx.state(tx, (sp) => sp`insert into biblib.series (user_id, title) values (${a.id}, 'Intrusa')`),
    aEdition: await ctx.state(tx, (sp) => sp`insert into biblib.series_editions (user_id, edition_id, series_id) values (${b.id}, ${libA.books[1].editionId}, ${sagaB.id})`),
    aSeries: await ctx.state(tx, (sp) => sp`insert into biblib.series_editions (user_id, edition_id, series_id) values (${b.id}, ${libB.books[1].editionId}, ${sagaA.id})`),
    update: (await tx`update biblib.series set title = 'Robada' where id = ${sagaA.id} returning id`).length,
    remove: (await tx`delete from biblib.series where id = ${sagaA.id} returning id`).length,
  }))
  assert.deepEqual(outcome, { seesA: 0, seesLinks: 0, forA: "42501", aEdition: "23503", aSeries: "23503", update: 0, remove: 0 })
})

test("sin sesión ninguna acción de series responde con datos", async () => {
  const anonymous = { cookies: () => [] }
  for (const [name, args] of [["listSeriesAction", []], ["getSeriesAction", [sagaA.id]], ["createSeriesAction", [{ title: "Anónima" }]], ["getEditionSeriesAction", [libA.books[0].editionId]]]) {
    const result = await ctx.call(name, args, anonymous)
    assert.notEqual(result.value?.ok, true, `${name} sin sesión no devuelve datos`)
  }
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.series where title = 'Anónima'`)[0].n, 0)
})

test("las series y los vínculos de A siguen intactos tras todos los intentos de B", async () => {
  const detail = value(await ctx.call("getSeriesAction", [sagaA.id], sessionA))
  assert.equal(detail.title, sagaA.title)
  assert.deepEqual(detail.items.map((item) => [item.editionId, item.position]), [[libA.books[0].editionId, "1"]])
})

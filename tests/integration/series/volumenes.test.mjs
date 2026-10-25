import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { seriesContext, value } from "./lib/context.mjs"

// U-PRO-05 · Crear una serie, vincular ediciones con posición decimal exacta, mover y quitar volúmenes, y borrar la serie,
// por las Server Actions reales con sesión GoTrue. El orden sale de la posición NUMERIC (1, 1.5, 2) y un orden desconocido
// queda al final: nunca se infiere de la fecha de publicación. Borrar una serie no borra ediciones ni ejemplares.

let ctx, a, sessionA, lib, saga, other

before(async () => {
  ctx = await seriesContext()
  a = await ctx.account("a")
  sessionA = await ctx.signIn(a)
  lib = await ctx.library(a.id)
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

const link = (editionId, seriesId, extra = {}) => ctx.attempt("linkEditionToSeriesAction", [{ editionId, seriesId, ...extra }], sessionA)
const detail = async (id) => value(await ctx.call("getSeriesAction", [id], sessionA))
const order = (series) => series.items.map((item) => item.editionId)

test("crea una serie privada con título y descripción opcional y la lista sin volúmenes", async () => {
  saga = value(await ctx.call("createSeriesAction", [{ title: ctx.label("Saga"), description: "Una trilogía incompleta" }], sessionA))
  other = value(await ctx.call("createSeriesAction", [{ title: ctx.label("Otra") }], sessionA))
  assert.equal(saga.volumes, 0)
  assert.equal(saga.description, "Una trilogía incompleta")
  assert.equal(other.description, undefined)
  const listed = value(await ctx.call("listSeriesAction", [], sessionA))
  assert.deepEqual(listed.filter((item) => [saga.id, other.id].includes(item.id)).map((item) => item.volumes), [0, 0])
  const empty = await ctx.attempt("createSeriesAction", [{ title: "   " }], sessionA)
  assert.equal(empty.ok, false)
  assert.equal(empty.code, "INVALID_INPUT")
})

test("el orden es exacto: 1, 1.5 y 2 por posición, con el orden desconocido al final y sin usar la fecha", async () => {
  const [first, second, third] = lib.books
  // La fecha de publicación empuja en sentido contrario: no debe influir en el orden.
  await ctx.asUser(a.id, async (tx) => {
    await tx`update biblib.editions set publish_date = '1990' where id = ${third.editionId}`
    await tx`update biblib.editions set publish_date = '2020' where id = ${first.editionId}`
  })
  assert.equal((await link(third.editionId, saga.id, { position: "2", volumeLabel: "II" })).ok, true)
  assert.equal((await link(first.editionId, saga.id, { position: "1" })).ok, true)
  const middle = await link(second.editionId, saga.id, { position: "1,50", orderNote: "Va entre el 1 y el 2" })
  assert.equal(middle.ok, true)
  assert.equal(middle.value.link.position, "1.5", "la coma decimal y los ceros finales se guardan como «1.5»")

  const ordered = await detail(saga.id)
  assert.deepEqual(order(ordered), [first.editionId, second.editionId, third.editionId])
  assert.deepEqual(ordered.items.map((item) => item.position), ["1", "1.5", "2"])
  assert.equal(ordered.items[1].orderNote, "Va entre el 1 y el 2")
  assert.equal(ordered.items[2].volumeLabel, "II")
  assert.equal(ordered.volumes, 3)
  assert.ok(ordered.items.every((item) => typeof item.bookId === "string" && item.copies === 1), "cada volumen abre su ficha")
  const [{ type }] = await ctx.sql`select pg_typeof(position)::text as type from biblib.series_editions where user_id = ${a.id} limit 1`
  assert.equal(type, "numeric", "la posición es NUMERIC, nunca un flotante")
})

test("una serie incompleta es válida y un volumen sin posición se muestra como orden desconocido, al final", async () => {
  const extra = await ctx.library(a.id)
  const [unknown] = extra.books
  const added = await link(unknown.editionId, saga.id)
  assert.equal(added.ok, true)
  assert.equal(added.value.link.position, undefined)
  const ordered = await detail(saga.id)
  assert.equal(ordered.items.at(-1).editionId, unknown.editionId, "el orden desconocido va el último")
  assert.equal(ordered.items.at(-1).position, undefined)
  assert.deepEqual(ordered.items.slice(0, 3).map((item) => item.position), ["1", "1.5", "2"])
})

test("rechaza posiciones con ceros a la izquierda, negativas o no numéricas sin tocar la serie", async () => {
  const [first] = lib.books
  const before = await ctx.seriesRows(a.id, saga.id)
  for (const position of ["01.50", "-1", "abc", "1e3", "1.00001", "1000000", "NaN"]) {
    const moved = await ctx.attempt("moveSeriesVolumeAction", [{ editionId: first.editionId, seriesId: saga.id, expectedVersion: (await detail(saga.id)).items[0].version, position }], sessionA)
    assert.equal(moved.ok, false, position)
    assert.equal(moved.code, "INVALID_INPUT", position)
  }
  assert.deepEqual(await ctx.seriesRows(a.id, saga.id), before)
})

test("una edición pertenece a cero o una serie: vincularla otra vez es un conflicto", async () => {
  const [first] = lib.books
  const again = await link(first.editionId, other.id, { position: "1" })
  assert.equal(again.ok, false)
  assert.equal(again.code, "CONFLICT")
  assert.equal((await ctx.seriesRows(a.id, other.id)).length, 0)
})

test("mover un volumen cambia la posición con su versión y una versión antigua es un conflicto", async () => {
  const [first, second, third] = lib.books
  const items = (await detail(saga.id)).items
  const volumeOne = items.find((item) => item.editionId === first.editionId)
  const moved = await ctx.attempt("moveSeriesVolumeAction", [{ editionId: first.editionId, seriesId: saga.id, expectedVersion: volumeOne.version, position: "1.75", volumeLabel: "I bis" }], sessionA)
  assert.equal(moved.ok, true)
  assert.equal(moved.value.link.position, "1.75")
  assert.deepEqual(order(await detail(saga.id)).slice(0, 3), [second.editionId, first.editionId, third.editionId])
  const stale = await ctx.attempt("moveSeriesVolumeAction", [{ editionId: first.editionId, seriesId: saga.id, expectedVersion: volumeOne.version, position: "9" }], sessionA)
  assert.equal(stale.ok, false)
  assert.equal(stale.code, "CONFLICT")
  assert.equal((await ctx.seriesRows(a.id, saga.id)).find((row) => row.edition_id === first.editionId).position, "1.75")
})

test("mover un volumen a otra serie lo retira de la primera y conserva el libro", async () => {
  const [, second] = lib.books
  const current = (await detail(saga.id)).items.find((item) => item.editionId === second.editionId)
  const moved = await ctx.attempt("moveSeriesVolumeAction", [{ editionId: second.editionId, seriesId: other.id, expectedVersion: current.version, position: "3" }], sessionA)
  assert.equal(moved.ok, true)
  assert.equal(moved.value.link.series.id, other.id)
  assert.equal((await detail(saga.id)).items.some((item) => item.editionId === second.editionId), false)
  assert.deepEqual((await detail(other.id)).items.map((item) => item.position), ["3"])
})

test("quitar un volumen exige su versión y no borra la edición ni el ejemplar", async () => {
  const [, second] = lib.books
  const current = (await detail(other.id)).items[0]
  const stale = await ctx.attempt("unlinkEditionFromSeriesAction", [{ editionId: second.editionId, expectedVersion: "00000000-0000-4000-8000-000000000000" }], sessionA)
  assert.equal(stale.ok, false)
  assert.equal(stale.code, "CONFLICT")
  const removed = await ctx.attempt("unlinkEditionFromSeriesAction", [{ editionId: second.editionId, expectedVersion: current.version }], sessionA)
  assert.equal(removed.ok, true)
  assert.equal(removed.value.link, null)
  assert.equal((await detail(other.id)).items.length, 0)
  const [{ editions, copies }] = await ctx.sql`select (select count(*)::int from biblib.editions where id = ${second.editionId}) as editions, (select count(*)::int from biblib.copies where id = ${second.id}) as copies`
  assert.deepEqual({ editions, copies }, { editions: 1, copies: 1 })
  const gone = await ctx.attempt("unlinkEditionFromSeriesAction", [{ editionId: second.editionId, expectedVersion: current.version }], sessionA)
  assert.equal(gone.code, "NOT_FOUND")
})

test("el estado de la ficha refleja el vínculo y las series disponibles", async () => {
  const [first, second] = lib.books
  const linked = value(await ctx.call("getEditionSeriesAction", [first.editionId], sessionA))
  assert.equal(linked.link.series.id, saga.id)
  assert.equal(linked.link.position, "1.75")
  assert.ok(linked.available.some((item) => item.id === other.id))
  const free = value(await ctx.call("getEditionSeriesAction", [second.editionId], sessionA))
  assert.equal(free.link, null, "un libro sin serie no tiene vínculo")
})

test("editar la serie compara su versión y borrarla retira los vínculos sin borrar libros", async () => {
  const [first, , third] = lib.books
  const current = value(await ctx.call("listSeriesAction", [], sessionA)).find((item) => item.id === saga.id)
  const renamed = value(await ctx.call("updateSeriesAction", [{ id: saga.id, expectedVersion: current.version, title: ctx.label("Saga renombrada"), description: "" }], sessionA))
  assert.equal(renamed.description, undefined)
  assert.equal(renamed.volumes, 3)
  const staleEdit = await ctx.attempt("updateSeriesAction", [{ id: saga.id, expectedVersion: current.version, title: "Tarde" }], sessionA)
  assert.equal(staleEdit.code, "CONFLICT")
  const staleDelete = await ctx.attempt("deleteSeriesAction", [{ id: saga.id, expectedVersion: current.version }], sessionA)
  assert.equal(staleDelete.code, "CONFLICT")
  assert.equal((await ctx.seriesRows(a.id, saga.id)).length, 3)

  const books = await ctx.sql`select count(*)::int as n from biblib.copies where user_id = ${a.id}`
  const deleted = value(await ctx.call("deleteSeriesAction", [{ id: saga.id, expectedVersion: renamed.version }], sessionA))
  assert.equal(deleted.unlinked, 3)
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.series where id = ${saga.id}`)[0].n, 0)
  assert.equal((await ctx.seriesRows(a.id, saga.id)).length, 0)
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.copies where user_id = ${a.id}`)[0].n, books[0].n, "los ejemplares se conservan")
  const sheet = value(await ctx.call("getEditionSeriesAction", [first.editionId], sessionA))
  assert.equal(sheet.link, null)
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.editions where id in ${ctx.sql([first.editionId, third.editionId])}`)[0].n, 2)
  assert.equal((await ctx.attempt("getSeriesAction", [saga.id], sessionA)).code, "NOT_FOUND")
})

test("el filtro por serie del catálogo devuelve solo las ediciones de esa serie", async () => {
  const filtered = value(await ctx.call("createSeriesAction", [{ title: ctx.label("Filtrada") }], sessionA))
  const [first, second] = lib.books
  assert.equal((await link(second.editionId, filtered.id, { position: "1" })).ok, true)
  const result = await ctx.call("listBooksAction", [{ series: filtered.id, pageSize: 100 }], sessionA)
  assert.deepEqual(result.value.books.map((book) => book.id), [second.id])
  assert.equal(result.value.total, 1)
  const all = await ctx.call("listBooksAction", [{ pageSize: 100 }], sessionA)
  assert.ok(all.value.books.some((book) => book.id === first.id), "sin filtro, todos los libros")
  const invalid = await ctx.call("listBooksAction", [{ series: "no-es-un-uuid" }], sessionA)
  assert.equal(invalid.thrown || invalid.value?.books === undefined, true, "un identificador no válido se rechaza")
})

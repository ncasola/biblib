import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { productState, seriesContext, value } from "./lib/context.mjs"

// U-PRO-05 · Ida y vuelta v2 de las series por la app real: la exportación lleva las series y la serie de cada edición con
// la posición en texto canónico; reemplazar desde ese archivo y restaurar la versión anterior devuelve el orden exacto; otra
// cuenta lo importa con IDs propios; y un archivo anterior (v1) queda sin series.

let ctx, a, b, sessionA, sessionB, lib, exported, original

before(async () => {
  ctx = await seriesContext()
  a = await ctx.account("a")
  b = await ctx.account("b")
  sessionA = await ctx.signIn(a)
  sessionB = await ctx.signIn(b)
  lib = await ctx.library(a.id)
  const saga = value(await ctx.call("createSeriesAction", [{ title: ctx.label("Saga de la ida y vuelta"), description: "Incompleta" }], sessionA))
  for (const [index, extra] of [{ position: "2", volumeLabel: "II" }, { position: "1,50", orderNote: "Entre el 1 y el 2" }, {}].entries()) {
    value(await ctx.call("linkEditionToSeriesAction", [{ editionId: lib.books[index].editionId, seriesId: saga.id, ...extra }], sessionA))
  }
  original = await productState(ctx.sql, a.id)
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

async function exportParts(session) {
  const prepared = value(await ctx.call("prepareLibraryExportAction", [], session))
  const parts = []
  for (const part of prepared.parts) {
    const response = await ctx.get(part.href, session)
    assert.equal(response.status, 200, `la parte ${part.index} se descarga`)
    parts.push(JSON.parse(response.body.toString("utf8")))
  }
  return parts
}

async function importFile(session, file, mode) {
  const prepared = value(await ctx.call("prepareImportAction", [file, mode], session))
  const confirmed = value(await ctx.call("confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: ctx.key("importar") }], session))
  assert.equal(confirmed.status, "committed")
  return prepared
}

test("la exportación v2 declara la capacidad de series y lleva posiciones en texto canónico", async () => {
  const parts = await exportParts(sessionA)
  assert.equal(parts.length, 1)
  exported = parts[0]
  assert.ok(exported.requiredCapabilities.includes("editions.series"))
  assert.equal(exported.series.length, 1)
  assert.equal(exported.series[0].description, "Incompleta")
  const byEdition = new Map(exported.editions.map((edition) => [edition.id, edition.series]))
  assert.equal(byEdition.get(lib.books[0].editionId).position, "2")
  assert.equal(byEdition.get(lib.books[1].editionId).position, "1.5", "«1,50» se guardó como «1.5»")
  assert.equal(byEdition.get(lib.books[2].editionId).position, undefined, "el orden desconocido no se inventa")
  assert.equal(byEdition.get(lib.books[1].editionId).orderNote, "Entre el 1 y el 2")
  assert.ok(Object.values(byEdition.get(lib.books[0].editionId)).every((entry) => typeof entry === "string"), "ningún número de JS")
})

test("reemplazar desde la propia copia y restaurar la versión anterior devuelven el orden exacto", async () => {
  assert.ok(exported, "depende de la exportación")
  await ctx.asUser(a.id, async (tx) => {
    await tx`update biblib.series_editions set position = 7, volume_label = 'cambiado' where edition_id = ${lib.books[0].editionId}`
    await tx`delete from biblib.series_editions where edition_id = ${lib.books[1].editionId}`
  })
  const mutated = await productState(ctx.sql, a.id)
  assert.notDeepEqual(mutated.seriesEditions, original.seriesEditions)
  await importFile(sessionA, exported, "replace")
  assert.deepEqual((await productState(ctx.sql, a.id)).seriesEditions, original.seriesEditions)
  assert.deepEqual((await productState(ctx.sql, a.id)).series, original.series)

  // La versión anterior capturada por el reemplazo conserva el estado mutado, también sus series.
  const page = value(await ctx.call("listLibrarySnapshotsAction", [{}], sessionA))
  const preview = value(await ctx.call("previewSnapshotRestoreAction", [{ snapshotId: page.items[0].id }], sessionA))
  value(await ctx.call("restoreSnapshotAction", [{ previewId: preview.previewId, expectedRevision: preview.revision, idempotencyKey: ctx.key("restaurar") }], sessionA))
  assert.deepEqual((await productState(ctx.sql, a.id)).seriesEditions, mutated.seriesEditions)
})

test("otra cuenta importa la copia con series de IDs propios y el orden intacto", async () => {
  assert.ok(exported, "depende de la exportación")
  await ctx.library(b.id)
  await importFile(sessionB, exported, "merge")
  const state = await productState(ctx.sql, b.id)
  assert.equal(state.series.length, 1)
  assert.notEqual(state.series[0].id, original.series[0].id, "B no hereda el ID de la serie de A")
  assert.equal(state.series[0].title, original.series[0].title)
  // Solo las ediciones nuevas reciben serie: las que B ya tenía no se tocan, y las nuevas llegan con su posición.
  assert.deepEqual(state.seriesEditions.map((row) => row.position).sort((x, y) => (x === null) - (y === null) || String(x).localeCompare(String(y))), ["1.5", "2", null])
  // Repetir la fusión no añade volúmenes ni toca los vínculos de B: ninguna edición es nueva. Según el contrato
  // (contratos-o13, «Fusión») solo se reutilizan las series propias por ID; la de A vuelve a llegar con un ID nuevo.
  const again = await productState(ctx.sql, b.id)
  await importFile(sessionB, exported, "merge")
  const repeated = await productState(ctx.sql, b.id)
  assert.deepEqual(repeated.seriesEditions, again.seriesEditions, "repetir la fusión no duplica volúmenes")
  assert.equal(repeated.series.length, again.series.length + 1)
  assert.ok(repeated.series.every((entry) => entry.id !== original.series[0].id), "B tampoco hereda el ID al repetir")
})

test("un archivo v1 se importa sin series ni vínculos inventados", async () => {
  const before = await productState(ctx.sql, b.id)
  const legacy = {
    formatVersion: 1, exportedAt: new Date().toISOString(),
    shelves: [{ id: "s1", title: "Principal", book_count: 1, isDefault: true }],
    books: [{ id: "l1", isbn: `manual-o13d-${ctx.run}-series-v1`, title: ctx.label("de un archivo v1"), authors: [], number_of_pages: 0, publish_date: "", status: "unread", shelf_id: "s1", shelf_name: "Principal" }],
  }
  await importFile(sessionB, legacy, "merge")
  const after = await productState(ctx.sql, b.id)
  assert.deepEqual(after.series, before.series)
  assert.deepEqual(after.seriesEditions, before.seriesEditions)
})

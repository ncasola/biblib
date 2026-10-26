import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { productContext, productState, value } from "./lib/context.mjs"

// O13 · 0014. Ida y vuelta v2 por la app real: exportación (acción + ruta de partes), reemplazo desde ese archivo,
// restauración de la versión anterior que captura el reemplazo, importación del mismo archivo en otra cuenta (sin sus
// fotos) y un archivo anterior sin secciones nuevas. Los datos de producto vuelven exactos, con sus IDs propios.

let ctx, a, b, sessionA, sessionB, lib, exported, original, mutated

before(async () => {
  ctx = await productContext()
  a = await ctx.account("a")
  b = await ctx.account("b")
  sessionA = await ctx.signIn(a)
  sessionB = await ctx.signIn(b)
  lib = await ctx.library(a.id)
  const roomPhoto = await ctx.uploadMedia(a.id, sessionA, "location")
  const spinePhoto = await ctx.uploadMedia(a.id, sessionA, "evidence")
  await ctx.asUser(a.id, async (tx) => {
    const [fantasy] = await tx`insert into biblib.tags (user_id, name) values (${a.id}, 'Fantasía'), (${a.id}, 'Sin usar') returning id`
    await tx`insert into biblib.copy_tags (user_id, copy_id, tag_id) values (${a.id}, ${lib.books[0].id}, ${fantasy.id})`
    await tx`insert into biblib.copy_annotations (user_id, copy_id, notes, rating) values (${a.id}, ${lib.books[0].id}, 'Regalo ✨ de 2015', 5), (${a.id}, ${lib.books[1].id}, null, 3)`
    const [room] = await tx`insert into biblib.locations (user_id, name, kind, photo_asset_id) values (${a.id}, 'Salón', 'room', ${roomPhoto.id}) returning id`
    const [shelf] = await tx`insert into biblib.locations (user_id, parent_id, name, kind) values (${a.id}, ${room.id}, 'Balda 3', 'shelf') returning id`
    await tx`insert into biblib.locations (user_id, name, kind) values (${a.id}, 'Caja vacía', 'box')`
    await tx`insert into biblib.copy_locations (user_id, copy_id, location_id, shelf_label, position) values (${a.id}, ${lib.books[0].id}, ${shelf.id}, 'Fila de atrás', 3)`
    const [saga] = await tx`insert into biblib.series (user_id, title, description) values (${a.id}, 'Saga', 'Trilogía') returning id`
    await tx`insert into biblib.series_editions (user_id, edition_id, series_id, position, volume_label) values
      (${a.id}, ${lib.books[0].editionId}, ${saga.id}, '1', 'I'), (${a.id}, ${lib.books[1].editionId}, ${saga.id}, '1.5', null), (${a.id}, ${lib.books[2].editionId}, ${saga.id}, '2', 'II')`
    await tx`insert into biblib.bibliographic_evidence (user_id, edition_id, source_kind, source_ref, source_url, field_claims, confidence, origin) values
      (${a.id}, ${lib.books[0].editionId}, 'provider', 'open-library', 'https://openlibrary.org/books/OL1M', ${tx.json({ fields: { title: { provider: "open-library", selection: "user-selected" } } })}, 'bibliographic_match', 'review')`
    await tx`insert into biblib.bibliographic_evidence (user_id, copy_id, source_kind, photo_asset_id, observed_at, field_claims, confidence, origin) values
      (${a.id}, ${lib.books[0].id}, 'photo', ${spinePhoto.id}, '2026-10-01T10:00:00.000Z', ${tx.json({ isbn: "lomo" })}, 'provisional', 'review')`
  })
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
  return { prepared, parts }
}

async function importFile(session, file, mode) {
  const prepared = value(await ctx.call("prepareImportAction", [file, mode], session))
  const confirmed = value(await ctx.call("confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: ctx.key("importar") }], session))
  assert.equal(confirmed.status, "committed")
  return { prepared, confirmed }
}

test("la exportación v2 declara y lleva etiquetas, notas, ubicaciones, series y evidencias, con fotos por referencia y sha256", async () => {
  const { prepared, parts } = await exportParts(sessionA)
  assert.equal(prepared.formatVersion, 2)
  assert.equal(parts.length, 1)
  exported = parts[0]
  for (const capability of ["copies.personal", "copies.locations", "editions.series", "bibliographic.evidence"]) assert.ok(exported.requiredCapabilities.includes(capability), capability)
  assert.deepEqual(exported.tags.map((tag) => tag.name).sort(), ["Fantasía", "Sin usar"])
  assert.equal(exported.locations.length, 3, "también la caja vacía")
  assert.equal(exported.locations.find((location) => location.name === "Salón").photo.sha256.length, 64)
  assert.deepEqual(exported.editions.map((edition) => edition.series?.position).sort(), ["1", "1.5", "2"])
  const copy = exported.copies.find((entry) => entry.id === lib.books[0].id)
  assert.deepEqual(copy.personal, { notes: "Regalo ✨ de 2015", rating: 5, tagIds: [original.tags.find((tag) => tag.name === "Fantasía").id] })
  assert.deepEqual(copy.location, { locationId: original.copyLocations[0].location_id, shelfLabel: "Fila de atrás", position: 3 })
  assert.equal(copy.evidence[0].photo.assetId, original.evidence.find((row) => row.copy_id).photo_asset_id)
  assert.ok(!JSON.stringify(exported).includes("biblib-media/"), "ninguna ruta de Storage ni URL firmada")
})

test("reemplazar desde la propia copia devuelve los datos de producto exactos, con los mismos IDs y fotos propias", async () => {
  assert.ok(exported, "depende de la exportación")
  // Cambios sin retirar entidades: como con los ejemplares, el reemplazo conserva los IDs que la cuenta aún tiene.
  await ctx.asUser(a.id, async (tx) => {
    await tx`update biblib.tags set name = 'Renombrada' where user_id = ${a.id} and name = 'Sin usar'`
    await tx`update biblib.copy_annotations set notes = 'Cambiada', rating = 1 where copy_id = ${lib.books[0].id}`
    await tx`delete from biblib.copy_tags where copy_id = ${lib.books[0].id}`
    await tx`update biblib.copy_locations set location_id = (select id from biblib.locations where user_id = ${a.id} and name = 'Caja vacía'), position = null where copy_id = ${lib.books[0].id}`
    await tx`update biblib.series_editions set position = 3 where edition_id = ${lib.books[2].editionId}`
    await tx`update biblib.bibliographic_evidence set field_claims = '{}', confidence = 'provisional' where edition_id = ${lib.books[0].editionId}`
  })
  mutated = await productState(ctx.sql, a.id)
  assert.notDeepEqual(mutated, original)
  await importFile(sessionA, exported, "replace")
  assert.deepEqual(await productState(ctx.sql, a.id), original)
})

test("la versión anterior que capturó el reemplazo restaura también sus datos de producto", async () => {
  assert.ok(mutated, "depende del reemplazo")
  const page = value(await ctx.call("listLibrarySnapshotsAction", [{}], sessionA))
  const latest = page.items[0]
  const preview = value(await ctx.call("previewSnapshotRestoreAction", [{ snapshotId: latest.id }], sessionA))
  value(await ctx.call("restoreSnapshotAction", [{ previewId: preview.previewId, expectedRevision: preview.revision, idempotencyKey: ctx.key("restaurar") }], sessionA))
  assert.deepEqual(await productState(ctx.sql, a.id), mutated)
})

test("otra cuenta importa el archivo sin las fotos de A y con IDs propios; los ejemplares ya existentes no reciben datos", async () => {
  assert.ok(exported, "depende de la exportación")
  await ctx.library(b.id)
  await importFile(sessionB, exported, "merge")
  const state = await productState(ctx.sql, b.id)
  assert.deepEqual(state.tags.map((tag) => tag.name).sort(), ["Fantasía", "Sin usar"])
  assert.equal(state.locations.length, 3)
  assert.ok(state.locations.every((location) => location.photo_asset_id === null), "la foto de A no pasa a B")
  assert.ok(state.evidence.every((row) => row.photo_asset_id === null), "la foto fuente de A tampoco")
  assert.deepEqual(state.seriesEditions.map((row) => row.position).sort(), ["1", "1.5", "2"])
  const ids = (rows) => new Set(rows.map((row) => row.id))
  for (const key of ["tags", "locations", "series", "evidence"]) assert.ok(state[key].every((row) => !ids(original[key]).has(row.id)), `${key}: IDs propios de B`)
  // Repetir la fusión no duplica nada: los ejemplares ya existen, las etiquetas se reutilizan por nombre.
  await importFile(sessionB, exported, "merge")
  const again = await productState(ctx.sql, b.id)
  assert.equal(again.tags.length, 2)
  assert.equal(again.copyTags.length, state.copyTags.length)
})

test("un archivo anterior (v2 sin secciones nuevas o v1) se importa con los datos de producto vacíos", async () => {
  assert.ok(exported, "depende de la exportación")
  const before = await productState(ctx.sql, b.id)
  const legacy = {
    formatVersion: 1, exportedAt: new Date().toISOString(),
    shelves: [{ id: "s1", title: "Principal", book_count: 1, isDefault: true }],
    books: [{ id: "l1", isbn: `manual-o13d-${ctx.run}-v1`, title: ctx.label("de un archivo v1"), authors: [], number_of_pages: 0, publish_date: "", status: "unread", shelf_id: "s1", shelf_name: "Principal" }],
  }
  const { prepared } = await importFile(sessionB, legacy, "merge")
  const inserted = prepared.plan.books.insert.map((entry) => entry.id)
  assert.equal(inserted.length, 1)
  const after = await productState(ctx.sql, b.id)
  assert.deepEqual({ ...after, evidence: undefined }, { ...before, evidence: undefined }, "nada nuevo en etiquetas, notas, ubicaciones ni series")
  assert.ok(!after.evidence.some((row) => row.copy_id === inserted[0]), "ninguna evidencia inventada para la copia nueva")
})

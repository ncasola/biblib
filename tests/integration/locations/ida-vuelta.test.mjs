import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { errorCode, locationsContext, photoWithExif, value } from "./lib/context.mjs"

// U-PRO-03 · Las ubicaciones creadas por las acciones entran en la copia portable v2 y vuelven al reemplazar (con su foto,
// por referencia y sha256); un JSON antiguo se importa con la ubicación vacía; la foto sustituida que cita una versión
// anterior no se descarta; y una cuenta en eliminación no escribe por ninguna acción de ubicaciones.

let ctx, a, b, sessionA, sessionB, lib, room, shelf, empty, exported

before(async () => {
  ctx = await locationsContext()
  a = await ctx.account("ida")
  b = await ctx.account("inactiva")
  sessionA = await ctx.signIn(a)
  sessionB = await ctx.signIn(b)
  lib = await ctx.library(a.id)
  room = value(await ctx.call("createLocationAction", [{ name: "Despacho", kind: "room" }], sessionA))
  room = value(await ctx.uploadPhoto(sessionA, room, await photoWithExif()))
  shelf = value(await ctx.call("createLocationAction", [{ name: "Balda 2", kind: "shelf", parentId: room.id }], sessionA))
  empty = value(await ctx.call("createLocationAction", [{ name: "Caja vacía", kind: "box" }], sessionA))
  value(await ctx.call("setCopyLocationAction", [{ copyId: lib.books[0], locationId: shelf.id, shelfLabel: "Fila de atrás", position: 3, expectedVersion: null }], sessionA))
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

async function exportFile(session) {
  const prepared = value(await ctx.call("prepareLibraryExportAction", [], session))
  assert.equal(prepared.parts.length, 1)
  const response = await ctx.get(prepared.parts[0].href, session)
  assert.equal(response.status, 200)
  return JSON.parse(response.body.toString("utf8"))
}

async function importFile(session, file, mode) {
  const prepared = value(await ctx.call("prepareImportAction", [file, mode], session))
  const confirmed = value(await ctx.call("confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: ctx.key("importar") }], session))
  assert.equal(confirmed.status, "committed")
  return prepared
}

test("la exportación v2 declara copies.locations y lleva el árbol (también la caja vacía), la foto por referencia y la ubicación del ejemplar", async () => {
  exported = await exportFile(sessionA)
  assert.equal(exported.formatVersion, 2)
  assert.ok(exported.requiredCapabilities.includes("copies.locations"))
  assert.deepEqual(exported.locations.map((location) => location.name).sort(), ["Balda 2", "Caja vacía", "Despacho"])
  const [asset] = await ctx.mediaAssets(a.id)
  assert.deepEqual(exported.locations.find((location) => location.id === room.id).photo, { assetId: room.photoAssetId, sha256: asset.sha256 })
  assert.deepEqual(exported.copies.find((copy) => copy.id === lib.books[0]).location, { locationId: shelf.id, shelfLabel: "Fila de atrás", position: 3 })
  assert.equal(exported.copies.find((copy) => copy.id === lib.books[1]).location, undefined, "sin ubicación, nada inventado")
  assert.ok(!JSON.stringify(exported).includes("biblib-media"), "ni rutas de Storage ni URL firmadas")
})

test("reemplazar desde esa copia devuelve el árbol, la ubicación del ejemplar y la foto tras moverlos con las acciones", async () => {
  assert.ok(exported, "depende de la exportación")
  const original = { locations: await ctx.locations(a.id), copies: await ctx.copyLocations(a.id) }
  const current = value(await ctx.call("getCopyLocationAction", [lib.books[0]], sessionA)).current
  value(await ctx.call("setCopyLocationAction", [{ copyId: lib.books[0], locationId: empty.id, shelfLabel: null, position: 1, expectedVersion: current.version }], sessionA))
  const freshShelf = value(await ctx.call("getLocationsAction", [], sessionA)).locations.find((location) => location.id === shelf.id)
  value(await ctx.call("updateLocationAction", [{ id: shelf.id, name: "Renombrada", kind: "other", expectedVersion: freshShelf.version }], sessionA))
  assert.notDeepEqual({ locations: await ctx.locations(a.id), copies: await ctx.copyLocations(a.id) }, original)
  await importFile(sessionA, exported, "replace")
  assert.deepEqual({ locations: await ctx.locations(a.id), copies: await ctx.copyLocations(a.id) }, original)
  assert.equal((await ctx.get(`/api/media/${room.photoAssetId}`, sessionA)).status, 200, "la foto sigue citada y legible")
})

test("sustituir una foto que cita una versión anterior la conserva para poder restaurarla", async () => {
  const cited = (await ctx.mediaAssets(a.id)).map((asset) => asset.id)
  const latest = value(await ctx.call("getLocationsAction", [], sessionA)).locations.find((location) => location.id === room.id)
  const replaced = value(await ctx.uploadPhoto(sessionA, latest, await photoWithExif({ color: { r: 0, g: 0, b: 200 } })))
  const ids = (await ctx.mediaAssets(a.id)).map((asset) => asset.id)
  assert.ok(cited.every((id) => ids.includes(id)), "la anterior la cita la versión que capturó el reemplazo: no se descarta")
  assert.ok(ids.includes(replaced.photoAssetId))
})

test("un JSON antiguo (v1) se importa con la ubicación vacía y sin inventar ubicaciones", async () => {
  await ctx.library(b.id)
  const legacy = {
    formatVersion: 1, exportedAt: new Date().toISOString(),
    shelves: [{ id: "s1", title: "Principal", book_count: 1, isDefault: true }],
    books: [{ id: "l1", isbn: `manual-pro03-${ctx.run}-v1`, title: ctx.label("de un archivo v1"), authors: [], number_of_pages: 0, publish_date: "", status: "unread", shelf_id: "s1", shelf_name: "Principal" }],
  }
  const prepared = await importFile(sessionB, legacy, "merge")
  const [inserted] = prepared.plan.books.insert.map((entry) => entry.id)
  assert.deepEqual(await ctx.locations(b.id), [])
  assert.deepEqual(await ctx.copyLocations(b.id), [])
  assert.equal(value(await ctx.call("getCopyLocationAction", [inserted], sessionB)).current, null)
})

test("una cuenta en eliminación no escribe por ninguna acción de ubicaciones (ACCOUNT_INACTIVE) y no cambia nada", async () => {
  const location = value(await ctx.call("createLocationAction", [{ name: "Antes de eliminar", kind: "box" }], sessionB))
  const [copy] = await ctx.sql`select id from biblib.copies where user_id = ${b.id} limit 1`
  await ctx.sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: b.id, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${b.id}, true)`
    await tx`set local role authenticated`
    await tx`select biblib.account_deletion_request(${ctx.key("eliminar")})`
  })
  const before = { locations: await ctx.locations(b.id), copies: await ctx.copyLocations(b.id), assets: await ctx.mediaAssets(b.id) }
  const attempts = {
    create: await ctx.call("createLocationAction", [{ name: "Tarde", kind: "box" }], sessionB),
    rename: await ctx.call("updateLocationAction", [{ id: location.id, name: "Tarde", kind: "box", expectedVersion: location.version }], sessionB),
    move: await ctx.call("moveLocationAction", [{ id: location.id, parentId: null, expectedVersion: location.version }], sessionB),
    remove: await ctx.call("deleteLocationAction", [{ id: location.id, expectedVersion: location.version }], sessionB),
    place: await ctx.call("setCopyLocationAction", [{ copyId: copy.id, locationId: location.id, expectedVersion: null }], sessionB),
    photo: await ctx.uploadPhoto(sessionB, location, await photoWithExif()),
  }
  assert.deepEqual(Object.entries(attempts).filter(([, result]) => errorCode(result) !== "ACCOUNT_INACTIVE").map(([name, result]) => `${name}: ${errorCode(result)}`), [])
  assert.deepEqual({ locations: await ctx.locations(b.id), copies: await ctx.copyLocations(b.id), assets: await ctx.mediaAssets(b.id) }, before)
  assert.equal(errorCode(await ctx.call("getLocationsAction", [], sessionB)), "OK", "sigue leyendo lo suyo")
})

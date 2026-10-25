import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { errorCode, locationsContext, photoWithExif, value } from "./lib/context.mjs"

// U-PRO-03 · Usuario cruzado: B conoce los IDs de A (ubicaciones, ejemplares, versiones) y prueba cada acción y la ruta de
// la foto. Recibe la misma respuesta que para algo inexistente (NOT_FOUND o 404) y A no cambia. El anónimo no llega a las
// acciones ni a la foto.

let ctx, a, b, sessionA, sessionB, libA, libB, roomA, shelfA, roomB

before(async () => {
  ctx = await locationsContext()
  a = await ctx.account("a")
  b = await ctx.account("b")
  sessionA = await ctx.signIn(a)
  sessionB = await ctx.signIn(b)
  libA = await ctx.library(a.id)
  libB = await ctx.library(b.id)
  roomA = value(await ctx.call("createLocationAction", [{ name: "Salón de A", kind: "room" }], sessionA))
  shelfA = value(await ctx.call("createLocationAction", [{ name: "Balda de A", kind: "shelf", parentId: roomA.id }], sessionA))
  roomA = value(await ctx.uploadPhoto(sessionA, roomA, await photoWithExif()))
  value(await ctx.call("setCopyLocationAction", [{ copyId: libA.books[0], locationId: shelfA.id, position: 2, expectedVersion: null }], sessionA))
  roomB = value(await ctx.call("createLocationAction", [{ name: "Salón de B", kind: "room" }], sessionB))
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

const snapshot = async () => ({ locations: await ctx.locations(a.id), copies: await ctx.copyLocations(a.id), assets: await ctx.mediaAssets(a.id), objects: await ctx.objects(a.id) })

test("B no ve las ubicaciones de A", async () => {
  const overview = value(await ctx.call("getLocationsAction", [], sessionB))
  assert.deepEqual(overview.locations.map((location) => location.name), ["Salón de B"])
  assert.equal(value(await ctx.call("getCopyLocationAction", [libB.books[0]], sessionB)).locations.length, 1)
})

test("B manipula IDs de A en cada acción: responde como si no existieran y A no cambia", async () => {
  const before = await snapshot()
  const copyOfA = (await ctx.call("getCopyLocationAction", [libA.books[0]], sessionA)).value.value.current
  const attempts = {
    createInside: await ctx.call("createLocationAction", [{ name: "Intrusa", kind: "box", parentId: roomA.id }], sessionB),
    rename: await ctx.call("updateLocationAction", [{ id: roomA.id, name: "Mía", kind: "room", expectedVersion: roomA.version }], sessionB),
    moveForeign: await ctx.call("moveLocationAction", [{ id: shelfA.id, parentId: null, expectedVersion: shelfA.version }], sessionB),
    moveOwnIntoForeign: await ctx.call("moveLocationAction", [{ id: roomB.id, parentId: roomA.id, expectedVersion: roomB.version }], sessionB),
    remove: await ctx.call("deleteLocationAction", [{ id: shelfA.id, expectedVersion: shelfA.version, contents: "move-to-parent" }], sessionB),
    contents: await ctx.call("getLocationContentsAction", [{ locationId: shelfA.id, includeNested: true }], sessionB),
    readCopy: await ctx.call("getCopyLocationAction", [libA.books[0]], sessionB),
    placeForeignCopy: await ctx.call("setCopyLocationAction", [{ copyId: libA.books[0], locationId: roomB.id, expectedVersion: copyOfA.version }], sessionB),
    placeOwnInForeign: await ctx.call("setCopyLocationAction", [{ copyId: libB.books[0], locationId: shelfA.id, expectedVersion: null }], sessionB),
    clearForeign: await ctx.call("clearCopyLocationAction", [{ copyId: libA.books[0], expectedVersion: copyOfA.version }], sessionB),
    photo: await ctx.uploadPhoto(sessionB, roomA, await photoWithExif()),
    removePhoto: await ctx.call("removeLocationPhotoAction", [{ locationId: roomA.id, expectedVersion: roomA.version }], sessionB),
  }
  assert.deepEqual(Object.entries(attempts).filter(([, result]) => errorCode(result) !== "NOT_FOUND").map(([name, result]) => `${name}: ${errorCode(result)}`), [])
  assert.deepEqual(await snapshot(), before, "A no cambia")
  assert.deepEqual(await ctx.mediaAssets(b.id), [], "B no deja imágenes")
  assert.deepEqual(await ctx.copyLocations(b.id), [])
  assert.equal(value(await ctx.call("getLocationsAction", [], sessionB)).locations.find((location) => location.id === roomB.id).parentId, null)
})

test("la foto de A no se sirve a B ni sin sesión, aunque se conozca la ruta", async () => {
  assert.equal((await ctx.get(`/api/media/${roomA.photoAssetId}`, sessionA)).status, 200)
  assert.equal((await ctx.get(`/api/media/${roomA.photoAssetId}`, sessionB)).status, 404)
  assert.equal((await ctx.get(`/api/media/${roomA.photoAssetId}`, null)).status, 401)
  // Con su propio JWT, B tampoco descarga el objeto de A directamente de Storage.
  const [key] = await ctx.objects(a.id)
  const storageB = (await import("@supabase/supabase-js")).createClient(ctx.env.SUPABASE_URL, ctx.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${sessionB.session.access_token}` } },
  }).storage.from("biblib-media")
  assert.ok((await storageB.download(key)).error, "B no descarga el objeto de A")
  assert.ok((await storageB.createSignedUrl(key, 60)).error, "ni lo firma")
})

test("el anónimo no llega a las acciones ni a la pantalla", async () => {
  const anonymous = await ctx.call("getLocationsAction", [], null)
  assert.ok([307, 401].includes(anonymous.status) || errorCode(anonymous) === "UNAUTHORIZED", `respuesta ${errorCode(anonymous)}`)
  const page = await ctx.get("/locations", null)
  assert.equal(page.status, 307)
  assert.match(page.location ?? "", /\/login/)
})

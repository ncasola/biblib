import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { after, before, test } from "node:test"
import sharp from "sharp"
import { EXIF_MARKER, errorCode, locationsContext, MEDIA_BUCKET, photoWithExif, value } from "./lib/context.mjs"

// U-PRO-03 · Foto de referencia de una ubicación con Storage real (`biblib-media`) por la acción real: reencodificada a WebP
// sin EXIF ni GPS (se comprueban los bytes guardados), lectura solo por la ruta autenticada, foto inválida rechazada sin
// dejar nada, sustitución que retira la anterior y un fallo de sustitución que la conserva. Nunca hay URL pública.

let ctx, a, session, location

before(async () => {
  ctx = await locationsContext()
  a = await ctx.account("fotos")
  session = await ctx.signIn(a)
  location = value(await ctx.call("createLocationAction", [{ name: "Estantería del pasillo", kind: "bookcase" }], session))
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const fresh = async () => value(await ctx.call("getLocationsAction", [], session)).locations.find((entry) => entry.id === location.id)

test("subir: se guarda un WebP sin EXIF ni GPS, solo en la ruta del dueño, y se lee por la ruta autenticada", async () => {
  const original = await photoWithExif()
  assert.ok(original.includes(Buffer.from(EXIF_MARKER)), "el original lleva el marcador en su EXIF")
  const updated = value(await ctx.uploadPhoto(session, location, original))
  assert.ok(updated.photoAssetId)
  assert.notEqual(updated.version, location.version)
  const [asset] = await ctx.mediaAssets(a.id)
  assert.deepEqual({ kind: asset.kind, state: asset.state, key: asset.storage_key }, { kind: "location", state: "ready", key: `${a.id}/location/${updated.photoAssetId}` })
  const stored = await ctx.download(asset.storage_key)
  assert.equal(sha(stored), asset.sha256)
  const metadata = await sharp(stored).metadata()
  assert.equal(metadata.format, "webp")
  assert.equal(metadata.exif, undefined, "sin EXIF")
  assert.equal(stored.includes(Buffer.from(EXIF_MARKER)), false, "ningún byte del EXIF original")
  assert.equal(stored.includes(Buffer.from("Exif")), false)
  assert.equal(stored.includes(Buffer.from("GPS")), false)

  const served = await ctx.get(`/api/media/${updated.photoAssetId}`, session)
  assert.equal(served.status, 200)
  assert.equal(served.contentType, "image/webp")
  assert.equal(sha(served.body), asset.sha256)
  assert.equal((await ctx.get(`/api/media/${updated.photoAssetId}`, null)).status, 401, "sin sesión no se sirve")
  const publicUrl = ctx.admin.storage.from(MEDIA_BUCKET).getPublicUrl(asset.storage_key).data.publicUrl
  assert.notEqual((await fetch(publicUrl)).status, 200, "el bucket no es público")
  location = updated
})

test("una foto inválida se rechaza sin cambiar la ubicación ni dejar imágenes en cuarentena", async () => {
  const before = { location: await fresh(), assets: await ctx.mediaAssets(a.id), objects: await ctx.objects(a.id) }
  const svg = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>")
  const cases = {
    svgDeclared: await ctx.uploadPhoto(session, before.location, svg, { mime: "image/svg+xml" }),
    svgAsJpeg: await ctx.uploadPhoto(session, before.location, svg),
    text: await ctx.uploadPhoto(session, before.location, Buffer.from("no soy una imagen")),
    mismatch: await ctx.uploadPhoto(session, before.location, await photoWithExif(), { mime: "image/png" }),
    truncated: await ctx.uploadPhoto(session, before.location, await photoWithExif(), { declared: 10 }),
    tooLarge: await ctx.uploadPhoto(session, before.location, Buffer.alloc(5 * 1024 * 1024 + 1, 0xff)),
  }
  assert.deepEqual(Object.fromEntries(Object.entries(cases).map(([name, result]) => [name, errorCode(result)])), {
    svgDeclared: "INVALID_INPUT", svgAsJpeg: "ASSET_REJECTED", text: "ASSET_REJECTED", mismatch: "ASSET_REJECTED", truncated: "INVALID_INPUT", tooLarge: "ASSET_REJECTED",
  })
  assert.deepEqual(await fresh(), before.location, "la ubicación y su foto no cambian")
  assert.deepEqual(await ctx.mediaAssets(a.id), before.assets, "sin cuarentenas ni assets nuevos")
  assert.deepEqual(await ctx.objects(a.id), before.objects, "sin objetos nuevos")
})

test("sustituir retira la anterior; una sustitución con versión antigua falla y conserva la foto vigente", async () => {
  const previous = (await ctx.mediaAssets(a.id))[0]
  const replaced = value(await ctx.uploadPhoto(session, await fresh(), await photoWithExif({ color: { r: 10, g: 140, b: 60 } })))
  assert.notEqual(replaced.photoAssetId, previous.id)
  const assets = await ctx.mediaAssets(a.id)
  assert.deepEqual(assets.map((asset) => asset.id), [replaced.photoAssetId], "el asset anterior se descarta")
  assert.deepEqual(await ctx.objects(a.id), [`${a.id}/location/${replaced.photoAssetId}`], "y su objeto se retira")
  assert.equal((await ctx.get(`/api/media/${replaced.photoAssetId}`, session)).status, 200)
  assert.equal((await ctx.get(`/api/media/${previous.id}`, session)).status, 404, "la anterior ya no se sirve")

  // Versión antigua: la nueva imagen se descarta y la vigente sigue citada y legible.
  const stale = await ctx.uploadPhoto(session, location, await photoWithExif({ color: { r: 200, g: 200, b: 0 } }))
  assert.equal(errorCode(stale), "CONFLICT")
  assert.equal((await fresh()).photoAssetId, replaced.photoAssetId)
  assert.deepEqual((await ctx.mediaAssets(a.id)).map((asset) => asset.id), [replaced.photoAssetId])
  assert.deepEqual(await ctx.objects(a.id), [`${a.id}/location/${replaced.photoAssetId}`])
  location = await fresh()
})

test("quitar la foto la descarta; borrar una ubicación con foto también retira su imagen", async () => {
  const removed = value(await ctx.call("removeLocationPhotoAction", [{ locationId: location.id, expectedVersion: location.version }], session))
  assert.equal(removed.photoAssetId, null)
  assert.deepEqual(await ctx.mediaAssets(a.id), [])
  assert.deepEqual(await ctx.objects(a.id), [])
  assert.equal((await ctx.get(`/api/media/${location.photoAssetId}`, session)).status, 404)
  const withPhoto = value(await ctx.uploadPhoto(session, removed, await photoWithExif()))
  value(await ctx.call("deleteLocationAction", [{ id: location.id, expectedVersion: withPhoto.version }], session))
  assert.deepEqual(await ctx.mediaAssets(a.id), [])
  assert.deepEqual(await ctx.objects(a.id), [])
})

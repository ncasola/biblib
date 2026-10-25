import assert from "node:assert/strict"
import { test } from "node:test"
import sharp from "sharp"
import { normalizeMediaImage } from "../lib/media/image-validation"
import { replaceAvatar } from "../lib/media/avatar-workflow"

const image = () => sharp({ create: { width: 64, height: 48, channels: 3, background: "red" } })
for (const format of ["jpeg", "png", "webp"] as const) {
  test(`media: ${format} se decodifica y se convierte a WebP`, async () => {
    const normalized = await normalizeMediaImage("avatar", await image().toFormat(format).toBuffer(), `image/${format}`)
    assert.equal((await sharp(normalized.webp).metadata()).format, "webp")
    assert.equal(normalized.width, 64)
    assert.equal(normalized.height, 48)
    assert.match(normalized.sha256, /^[0-9a-f]{64}$/)
  })
}
test("media: rechaza SVG, HTML, GIF, tipo falso, truncado y bytes añadidos", async () => {
  for (const input of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from("<html>"), await image().gif().toBuffer(), Buffer.from([0xff, 0xd8, 0xff])]) {
    await assert.rejects(normalizeMediaImage("avatar", input), { code: "ASSET_REJECTED" })
  }
  const png = await image().png().toBuffer()
  await assert.rejects(normalizeMediaImage("avatar", png, "image/jpeg"), { code: "ASSET_REJECTED" })
  await assert.rejects(normalizeMediaImage("avatar", Buffer.concat([png, Buffer.from("extra") ])), { code: "ASSET_REJECTED" })
})
test("media: límites por tipo en bytes y dimensiones, sin recorte silencioso", async () => {
  const large = await sharp({ create: { width: 1025, height: 20, channels: 3, background: "red" } }).png().toBuffer()
  await assert.rejects(normalizeMediaImage("avatar", large), { code: "ASSET_REJECTED" })
  assert.equal((await normalizeMediaImage("location", large)).width, 1025)
  assert.equal((await normalizeMediaImage("evidence", large)).width, 1025)
  await assert.rejects(normalizeMediaImage("avatar", Buffer.alloc(1_048_577)), { code: "ASSET_REJECTED" })
  await assert.rejects(normalizeMediaImage("location", Buffer.alloc(5_242_881)), { code: "ASSET_REJECTED" })
})
test("media: reencodificación elimina EXIF y GPS", async () => {
  const input = await image().jpeg().withExif({ IFD0: { Copyright: "privado" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "28/1 0/1 0/1" } }).toBuffer()
  assert.ok((await sharp(input).metadata()).exif)
  const normalized = await normalizeMediaImage("avatar", input)
  const metadata = await sharp(normalized.webp).metadata()
  assert.equal(metadata.exif, undefined)
  assert.equal(metadata.xmp, undefined)
  assert.equal(metadata.icc, undefined)
  assert.equal(normalized.webp.includes(Buffer.from("privado")), false)
})
test("avatar: fallo de red en preparación no publica ni descarta el anterior", async () => {
  let published = false, discarded = false
  await assert.rejects(replaceAvatar({
    prepare: async () => { throw new Error("red") },
    publish: async () => { published = true; return { previousId: "anterior", value: "ok" } },
    discard: async () => { discarded = true },
  }), /red/)
  assert.equal(published, false); assert.equal(discarded, false)
})
test("avatar: conflicto limpia solo el nuevo y fallo de limpieza tras publicar no simula fallo de guardado", async () => {
  const discarded: string[] = []
  await assert.rejects(replaceAvatar({ prepare: async () => "nuevo", publish: async () => { throw new Error("conflicto") }, discard: async (id) => { discarded.push(id) } }), /conflicto/)
  assert.deepEqual(discarded, ["nuevo"])
  const result = await replaceAvatar({ prepare: async () => "nuevo", publish: async () => ({ previousId: "anterior", value: "guardado" }), discard: async () => { throw new Error("red") } })
  assert.equal(result, "guardado")
})

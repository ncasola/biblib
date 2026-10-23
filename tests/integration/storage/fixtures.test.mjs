import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { anonClient, ASSET, BUCKET, defaultCoverBytes, runId } from "../lib/context.mjs"
import { get } from "../lib/app.mjs"
import { signIn } from "../lib/sessions.mjs"
import { setupSuite } from "../lib/suite.mjs"

// Storage real del perfil test: bucket privado de fixtures (U-INF-05). Las firmas las emite este
// proceso de pruebas con la credencial local; no se verifican aún las políticas por cuenta de U-DAT-10.

let s, admin, token

before(async () => {
  s = await setupSuite()
  admin = s.admin()
  token = (await signIn("a")).session.access_token
})
after(() => s?.close())

const objectUrl = (kind, path) => `${s.ctx.env.SUPABASE_URL}/storage/v1/object/${kind}/${BUCKET}/${path}`
const fetchStatus = async (url, headers = {}) => (await fetch(url, { headers, signal: AbortSignal.timeout(10000) })).status

test("el bucket de fixtures es privado y rechaza la lectura anónima por todas las rutas", async () => {
  const bucket = await admin.storage.getBucket(BUCKET)
  assert.equal(bucket.error, null)
  assert.equal(bucket.data.public, false)
  const anon = anonClient(s.ctx)
  const download = await anon.storage.from(BUCKET).download(ASSET)
  assert.ok(download.error && !download.data, "La descarga anónima debe fallar.")
  const listed = await anon.storage.from(BUCKET).list("fixtures")
  assert.ok(listed.error || listed.data.length === 0, "El anónimo no lista objetos.")
  assert.notEqual(await fetchStatus(objectUrl("public", ASSET)), 200, "La URL pública no sirve el objeto.")
  assert.notEqual(await fetchStatus(objectUrl("authenticated", ASSET), { apikey: s.ctx.env.SUPABASE_ANON_KEY }), 200)
})

test("una sesión de A tampoco lee el bucket de fixtures sin firma (sin políticas por cuenta todavía)", async () => {
  const download = await anonClient(s.ctx, token).storage.from(BUCKET).download(ASSET)
  assert.ok(download.error && !download.data)
})

test("la URL firmada por el proceso de prueba descarga los bytes exactos; alterada o caducada se rechaza", async () => {
  const signed = await admin.storage.from(BUCKET).createSignedUrl(ASSET, 60)
  assert.equal(signed.error, null)
  const response = await fetch(signed.data.signedUrl, { signal: AbortSignal.timeout(10000) })
  assert.equal(response.status, 200)
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(defaultCoverBytes()), "El objeto coincide con public/default-book-cover.webp.")

  const url = new URL(signed.data.signedUrl)
  const parts = url.searchParams.get("token").split(".")
  parts[2] = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1)
  url.searchParams.set("token", parts.join("."))
  assert.notEqual(await fetchStatus(url.href), 200, "Una firma alterada se rechaza.")
  const other = new URL(signed.data.signedUrl)
  other.pathname = other.pathname.replace(ASSET, "fixtures/otro.webp")
  assert.notEqual(await fetchStatus(other.href), 200, "La firma no sirve para otra ruta.")

  const short = await admin.storage.from(BUCKET).createSignedUrl(ASSET, 1)
  assert.equal(short.error, null)
  await new Promise((resolve) => setTimeout(resolve, 2500))
  assert.notEqual(await fetchStatus(short.data.signedUrl), 200, "Una firma caducada se rechaza.")
})

test("un objeto creado por el run se sirve solo firmado y se elimina sin tocar el fixture", async () => {
  const path = `qa-01/${runId()}/sonda.webp`
  s.record("objects", { bucket: BUCKET, path })
  const upload = await admin.storage.from(BUCKET).upload(path, defaultCoverBytes(), { contentType: "image/webp", upsert: true })
  assert.equal(upload.error, null)
  assert.ok((await anonClient(s.ctx).storage.from(BUCKET).download(path)).error)
  const signed = await admin.storage.from(BUCKET).createSignedUrl(path, 30)
  assert.equal(await fetchStatus(signed.data.signedUrl), 200)
  assert.equal((await admin.storage.from(BUCKET).remove([path])).error, null)
  s.forget("objects", { bucket: BUCKET, path })
  assert.ok((await admin.storage.from(BUCKET).download(path)).error, "El objeto del run ya no existe.")
  const fixture = await admin.storage.from(BUCKET).download(ASSET)
  assert.equal(fixture.error, null, "El fixture del bucket se conserva.")
})

test("la portada por defecto se sirve desde la app, sin red externa ni sesión", async () => {
  const response = await get(s.app, "/default-book-cover.webp")
  assert.equal(response.status, 200)
  assert.equal(response.contentType, "image/webp")
  assert.ok(response.body.equals(defaultCoverBytes()))
})

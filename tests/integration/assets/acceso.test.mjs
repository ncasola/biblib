import assert from "node:assert/strict"
import { after, afterEach, before, test } from "node:test"
import sharp from "sharp"
import { assetsContext, BUCKET, failed, ok, ORIGINAL_COVER, sha256 } from "./lib/context.mjs"

// U-DAT-10 · Acceso a las portadas privadas contra Postgres, GoTrue, Storage y la app compilada del
// perfil. Subida y adjunto por las acciones reales (multipart, como el navegador), lectura por la ruta
// autenticada y, además, intentos directos contra Storage con el JWT de cada cuenta y sin sesión.

let ctx, a, b
before(async () => {
  ctx = await assetsContext()
  await ctx.cleanup()
  a = await ctx.signIn("a")
  b = await ctx.signIn("b")
})
afterEach(async () => { await ctx.cleanup() })
after(async () => {
  if (!ctx) return
  await ctx.cleanup()
  for (const session of [a, b]) await session?.client.auth.signOut({ scope: "local" }).catch(() => {})
  await ctx.close()
})

const jpeg = (color = "#7a2030", width = 320, height = 480) => sharp({ create: { width, height, channels: 3, background: color } }).jpeg().withMetadata({ exif: { IFD0: { Copyright: "dato privado" } } }).toBuffer()

async function uploadAs(session, book, bytes, { mime = "image/jpeg", declared = bytes.length } = {}) {
  return ctx.form("beginOwnCoverUploadAction", { entityId: book.id, mime, bytes: String(declared), file: new Blob([bytes], { type: mime }) }, session)
}

test("A sube y adjunta su portada propia; la lee por la ruta autenticada y B no puede obtenerla ni firmarla, tampoco por Storage", async () => {
  const book = await ctx.book(ctx.users.a, "propia")
  const bytes = await jpeg()
  const uploaded = await uploadAs(a, book, bytes)
  assert.ok(ok(uploaded), `subida: ${JSON.stringify(uploaded.value?.error ?? uploaded.status)}`)
  const asset = uploaded.value.value.asset
  assert.equal(asset.state, "ready")
  assert.equal(asset.url, `/api/covers/${asset.id}`)
  assert.equal((await ctx.bookRow(book.id)).cover_asset_id, null, "subir no cambia la portada visible")

  const attached = await ctx.call("attachCoverAssetAction", [{ assetId: asset.id, entityId: book.id, expectedVersion: book.version }], a)
  assert.ok(ok(attached), `adjunto: ${JSON.stringify(attached.value?.error)}`)
  assert.equal(attached.value.value.coverAssetId, asset.id)
  assert.equal(attached.value.value.cover.large, ORIGINAL_COVER, "la URL original se conserva para editar y exportar")
  const row = await ctx.assetRow(asset.id)
  assert.match(row.storage_key, new RegExp(`^${ctx.users.a}/${asset.id}/[A-Za-z0-9_-]+\\.webp$`))
  assert.notEqual((await ctx.bookRow(book.id)).version, book.version, "adjuntar rota la versión de la ficha")

  const own = await ctx.read(asset.id, a)
  assert.equal(own.status, 200)
  assert.equal(own.contentType, "image/webp")
  assert.equal(sha256(own.body), row.sha256)
  const metadata = await sharp(own.body).metadata()
  assert.equal(metadata.format, "webp")
  assert.equal(metadata.exif, undefined, "sin metadatos del original")
  const headers = await fetch(`${ctx.app.url}/api/covers/${asset.id}`, { headers: { Cookie: ctx.cookies(a).map(({ name, value }) => `${name}=${value}`).join("; ") } })
  assert.equal(headers.headers.get("cache-control"), "private, no-store")
  assert.equal(headers.headers.get("x-content-type-options"), "nosniff")
  assert.match(headers.headers.get("content-security-policy") ?? "", /default-src 'none'; sandbox/)

  // B conoce el UUID y la ruta exacta: ni la app, ni Storage con su JWT, ni sin sesión.
  assert.equal((await ctx.read(asset.id, b)).status, 404, "B recibe lo mismo que para un asset inexistente")
  assert.equal((await ctx.read("00000000-0000-4000-8000-000000000000", b)).status, 404)
  assert.equal((await ctx.read(asset.id)).status, 401)
  const asB = ctx.storageAs(b).storage.from(BUCKET)
  const download = await asB.download(row.storage_key)
  assert.ok(download.error, "B no descarga el objeto de A")
  const signed = await asB.createSignedUrl(row.storage_key, 60)
  assert.ok(signed.error || !signed.data?.signedUrl, "B no firma la ruta de A")
  const listed = await asB.list(ctx.users.a)
  assert.deepEqual(listed.data ?? [], [], "B no lista la carpeta de A")
  const overwrite = await asB.upload(row.storage_key, Buffer.from("x"), { upsert: true, contentType: "image/webp" })
  assert.ok(overwrite.error, "B no sustituye el objeto")
  const removal = await asB.remove([row.storage_key])
  assert.equal(removal.data?.length ?? 0, 0, "B no retira el objeto")
  const anon = ctx.anon().storage.from(BUCKET)
  assert.ok((await anon.download(row.storage_key)).error, "sin sesión no se descarga")
  assert.ok((await anon.createSignedUrl(row.storage_key, 60)).error, "sin sesión no se firma")
  // A sí puede leer y firmar su propio objeto con su JWT; el enlace firmado sería temporal (docs/seguridad.md).
  const asA = ctx.storageAs(a).storage.from(BUCKET)
  assert.equal(sha256(Buffer.from(await (await asA.download(row.storage_key)).data.arrayBuffer())), row.sha256)
  // Ni A puede borrar o sustituir el objeto registrado: solo el servidor lo retira al purgar.
  assert.equal((await asA.remove([row.storage_key])).data?.length ?? 0, 0)
  assert.ok((await asA.upload(row.storage_key, Buffer.from("x"), { upsert: true, contentType: "image/webp" })).error)
  assert.equal((await ctx.objects(row.storage_key)).length, 1)

  // B tampoco puede adjuntarlo a su ficha ni leerlo por SQL con sus claims.
  const bBook = await ctx.book(ctx.users.b, "ajena")
  assert.ok(failed(await ctx.call("attachCoverAssetAction", [{ assetId: asset.id, entityId: bBook.id, expectedVersion: bBook.version }], b), "NOT_FOUND"))
  assert.equal((await ctx.bookRow(bBook.id)).cover_asset_id, null)
  assert.equal((await ctx.asUser(ctx.users.b, (tx) => tx`select count(*)::int as n from biblib.cover_assets where id = ${asset.id}`))[0].n, 0)
  assert.equal((await ctx.asUser(ctx.users.b, (tx) => tx`select count(*)::int as n from storage.objects where name = ${row.storage_key}`))[0].n, 0)

  // Volver a la portada original no borra nada al instante; la imagen queda para la purga.
  const current = await ctx.bookRow(book.id)
  const detached = await ctx.call("detachCoverAssetAction", [{ entityId: book.id, expectedVersion: current.version }], a)
  assert.ok(ok(detached))
  assert.equal(detached.value.value.coverAssetId, undefined)
})

test("la subida propia pasa las mismas validaciones: tipo falso, SVG, políglota, tamaño y dimensiones; repetir no duplica", async () => {
  const book = await ctx.book(ctx.users.a, "validaciones")
  const png = await sharp({ create: { width: 200, height: 300, channels: 3, background: "#204060" } }).png().toBuffer()
  assert.ok(failed(await uploadAs(a, book, png, { mime: "image/jpeg" }), "ASSET_REJECTED"), "PNG declarado como JPEG")
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>')
  assert.ok(failed(await uploadAs(a, book, svg, { mime: "image/png" }), "ASSET_REJECTED"), "SVG con tipo falso")
  assert.ok(failed(await ctx.form("beginOwnCoverUploadAction", { entityId: book.id, mime: "image/svg+xml", bytes: String(svg.length), file: new Blob([svg]) }, a), "INVALID_INPUT"), "SVG declarado")
  const polyglot = Buffer.concat([await jpeg(), Buffer.from("<html><script>alert(1)</script></html>")])
  assert.ok(failed(await uploadAs(a, book, polyglot), "ASSET_REJECTED"), "JPEG con HTML añadido")
  const bomb = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#000000" } }).png({ compressionLevel: 9 }).toBuffer()
  assert.ok(failed(await uploadAs(a, book, bomb, { mime: "image/png" }), "ASSET_REJECTED"), "12 megapíxeles")
  const big = Buffer.concat([await jpeg(), Buffer.alloc(5 * 1024 * 1024)])
  assert.ok(failed(await uploadAs(a, book, big), "ASSET_REJECTED"), "más de 5 MiB")
  assert.ok(failed(await uploadAs(a, book, await jpeg(), { declared: 10 }), "INVALID_INPUT"), "tamaño declarado distinto")
  assert.equal((await ctx.assetsOf(ctx.users.a)).length, 0, "ningún rechazo deja filas")
  assert.equal((await ctx.objects(`${ctx.users.a}/`)).filter((object) => object.created_at >= new Date(Date.now() - 60_000)).length, 0, "ni objetos")

  const bytes = await jpeg("#336633")
  const first = await uploadAs(a, book, bytes)
  const second = await uploadAs(a, book, bytes)
  assert.ok(ok(first) && ok(second))
  assert.equal(second.value.value.asset.id, first.value.value.asset.id, "la misma imagen del mismo dueño se reutiliza")
  assert.equal(second.value.value.deduplicated, true)
  assert.equal((await ctx.assetsOf(ctx.users.a)).length, 1)
  assert.equal((await ctx.objects(`${ctx.users.a}/${first.value.value.asset.id}/`)).length, 1, "un solo objeto")
  // B sube la misma imagen: la deduplicación nunca cruza cuentas.
  const bBook = await ctx.book(ctx.users.b, "misma")
  const fromB = await uploadAs(b, bBook, bytes)
  assert.ok(ok(fromB))
  assert.notEqual(fromB.value.value.asset.id, first.value.value.asset.id)
})

test("Google Books o una política sin rehostCover no generan red ni objeto, ni por la acción ni con un trabajo antiguo", async () => {
  const book = await ctx.book(ctx.users.a, "derechos")
  for (const providerCoverKey of ["google-books:id:zyTCAlFPjgYC", "open-library:id:8739161", "bne:id:123"]) {
    const result = await ctx.call("requestProviderCoverAssetAction", [{ entityId: book.id, expectedVersion: book.version, providerCoverKey, idempotencyKey: ctx.key("derechos") }], a)
    assert.ok(failed(result, "ASSET_REJECTED"), `${providerCoverKey}: ${JSON.stringify(result.value?.error)}`)
  }
  assert.equal((await ctx.sql`select count(*)::int as n from biblib.library_jobs where user_id = ${ctx.users.a} and kind = 'cover_asset'`)[0].n, 0, "ni siquiera se crea el trabajo")
  const state = await ctx.call("getBookCoverAssetsAction", [book.id], a)
  assert.ok(ok(state))
  assert.equal(state.value.value.providerCoverKey, null, "la interfaz no ofrece copiar mientras ninguna política lo permita")

  // Un cliente manipulado no puede guardar una clave de Google ni con la función de la base.
  await assert.rejects(ctx.request(ctx.users.a, book, "google-books:id:zyTCAlFPjgYC"), (error) => error.code === "23514")
  // Un trabajo antiguo de Open Library: el ejecutor revalida la política publicada y no descarga nada.
  const requested = await ctx.request(ctx.users.a, book, "open-library:id:8739161")
  assert.equal(requested.status, "created")
  const { fetches } = await ctx.work(a, requested.job_id, { network: { resolve: async () => { throw new Error("sin DNS") }, transport: async () => { throw new Error("sin red") } } })
  assert.deepEqual(fetches, [], "ninguna descarga")
  const job = await ctx.jobRow(requested.job_id)
  assert.equal(job.state, "failed")
  assert.equal(job.error_code, "RIGHTS_DENIED")
  assert.equal(await ctx.assetRow(requested.asset_id), undefined, "la cuarentena se descarta")
  assert.equal((await ctx.objects(`${ctx.users.a}/${requested.asset_id}/`)).length, 0, "ningún objeto")
  assert.equal((await ctx.bookRow(book.id)).cover_large, ORIGINAL_COVER)
})

test("tras un restore, la ruta revalida bytes y derechos vigentes del dueño antes de volver a servir", async () => {
  const book = await ctx.book(ctx.users.a, "restaurada")
  const uploaded = await uploadAs(a, book, await jpeg("#556b2f"))
  assert.ok(ok(uploaded))
  const asset = uploaded.value.value.asset
  assert.ok(ok(await ctx.call("attachCoverAssetAction", [{ assetId: asset.id, entityId: book.id, expectedVersion: book.version }], a)))
  // Lo que hace biblib.cover_asset_quarantine_restored() en db:restore:local, solo para este asset.
  await ctx.sql`update biblib.cover_assets set state = 'restored' where id = ${asset.id}`
  assert.equal((await ctx.read(asset.id, b)).status, 404, "B tampoco lo obtiene en revisión")
  assert.equal((await ctx.assetRow(asset.id)).state, "restored", "ni lo revalida")
  const served = await ctx.read(asset.id, a)
  assert.equal(served.status, 200)
  assert.equal((await ctx.assetRow(asset.id)).state, "ready", "la subida propia supera la revalidación")

  // Una copia de proveedor restaurada cuya política vigente no permite respaldarla se descarta: la
  // ficha vuelve a su URL original y el objeto queda para la purga.
  const other = await ctx.book(ctx.users.a, "restaurada proveedor")
  const second = await uploadAs(a, other, await jpeg("#8b6f47"))
  assert.ok(ok(second))
  const providerAsset = second.value.value.asset.id
  assert.ok(ok(await ctx.call("attachCoverAssetAction", [{ assetId: providerAsset, entityId: other.id, expectedVersion: other.version }], a)))
  await ctx.sql`update biblib.cover_assets set state = 'restored', source_kind = 'provider', source_ref = 'open-library:id:8739161', rights_policy_version = 'prueba' where id = ${providerAsset}`
  assert.equal((await ctx.read(providerAsset, a)).status, 404)
  assert.equal(await ctx.assetRow(providerAsset), undefined, "se descarta")
  const row = await ctx.bookRow(other.id)
  assert.equal(row.cover_asset_id, null)
  assert.equal(row.cover_large, ORIGINAL_COVER)
})

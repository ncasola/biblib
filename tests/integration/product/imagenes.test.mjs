import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { productContext } from "./lib/context.mjs"

// O13 · 0014. Imágenes privadas con Storage real (bucket `biblib-media`): ruta `{user_id}/{kind}/{asset_id}`, subida única
// de un asset propio en cuarentena con el JWT del dueño, registro solo con el objeto presente, lectura solo del dueño,
// avatar en el perfil privado (sin tocar la metadata OAuth) y descarte que respeta lo citado.

let ctx, a, b, sessionA, sessionB

before(async () => {
  ctx = await productContext()
  a = await ctx.account("a")
  b = await ctx.account("b")
  sessionA = await ctx.signIn(a)
  sessionB = await ctx.signIn(b)
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

test("el bucket es privado, solo WebP y 5 MiB, con las tres políticas del dueño", async () => {
  const [bucket] = await ctx.sql`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'biblib-media'`
  assert.deepEqual({ ...bucket, file_size_limit: Number(bucket.file_size_limit) }, { public: false, file_size_limit: 5242880, allowed_mime_types: ["image/webp"] })
  const policies = (await ctx.sql`select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'biblib_media_%' order by 1`).map((row) => row.policyname)
  assert.deepEqual(policies, ["biblib_media_delete_own", "biblib_media_insert_own", "biblib_media_select_own"])
})

test("avatar propio: subida autorizada, B no lo lee ni lo sustituye, perfil privado y metadata OAuth intacta", async () => {
  const metadataBefore = (await ctx.admin.auth.admin.getUserById(a.id)).data.user.user_metadata
  const avatar = await ctx.uploadMedia(a.id, sessionA, "avatar")
  assert.equal(avatar.key, `${a.id}/avatar/${avatar.id}`)
  await ctx.asUser(a.id, (tx) => tx`insert into biblib.profiles (user_id, avatar_asset_id) values (${a.id}, ${avatar.id})`)
  const own = await ctx.storageAs(sessionA).download(avatar.key)
  assert.equal(own.error, null)
  assert.equal(Buffer.from(await own.data.arrayBuffer()).equals(avatar.bytes), true)
  const foreign = await ctx.storageAs(sessionB).download(avatar.key)
  assert.ok(foreign.error, "B no descarga el avatar de A conociendo la ruta")
  const replaced = await ctx.storageAs(sessionB).upload(avatar.key, avatar.bytes, { contentType: "image/webp", upsert: true })
  assert.ok(replaced.error, "B no sustituye el avatar de A")
  const overwrite = await ctx.storageAs(sessionA).upload(avatar.key, avatar.bytes, { contentType: "image/webp", upsert: true })
  assert.ok(overwrite.error, "ni A sobrescribe un objeto registrado")
  const removed = await ctx.storageAs(sessionA).remove([avatar.key])
  assert.equal((await ctx.admin.storage.from("biblib-media").list(`${a.id}/avatar`)).data.length, 1, `el objeto registrado no se retira desde el cliente (${removed.error?.message ?? "sin error"})`)
  // B no puede citar el asset de A en su perfil aunque conozca su ID: la guarda responde como si no existiera (BA010) y
  // la FK con dueño (23503) lo impediría igualmente.
  const code = await ctx.rolledBack(b.id, (tx) => ctx.state(tx, (sp) => sp`insert into biblib.profiles (user_id, avatar_asset_id) values (${b.id}, ${avatar.id})`))
  assert.equal(code, "BA010")
  assert.deepEqual((await ctx.admin.auth.admin.getUserById(a.id)).data.user.user_metadata, metadataBefore, "la metadata OAuth no cambia")
})

test("sin reserva no se sube; otra ruta del mismo dueño tampoco; un asset en cuarentena no se cita", async () => {
  const random = crypto.randomUUID()
  const unreserved = await ctx.storageAs(sessionA).upload(`${a.id}/location/${random}`, Buffer.from("x"), { contentType: "image/webp" })
  assert.ok(unreserved.error, "sin asset en cuarentena no hay subida")
  const begun = await ctx.asUser(a.id, async (tx) => (await tx`select biblib.media_asset_begin_upload('location') as result`)[0].result)
  const wrongKind = await ctx.storageAs(sessionA).upload(`${a.id}/avatar/${begun.asset_id}`, Buffer.from("x"), { contentType: "image/webp" })
  assert.ok(wrongKind.error, "el tipo de la ruta debe ser el del asset")
  const missing = await ctx.asUser(a.id, async (tx) => (await tx`select biblib.media_asset_register(${begun.asset_id}::uuid, ${"a".repeat(64)}, 10, 10, 10) as result`)[0].result)
  assert.equal(missing.status, "missing_object", "sin objeto no se registra")
  const quarantined = await ctx.rolledBack(a.id, (tx) => ctx.state(tx, (sp) => sp`insert into biblib.locations (user_id, name, kind, photo_asset_id) values (${a.id}, 'Salón', 'room', ${begun.asset_id})`))
  assert.equal(quarantined, "BA010")
  const discarded = await ctx.asUser(a.id, async (tx) => (await tx`select biblib.media_asset_discard(${begun.asset_id}::uuid) as result`)[0].result)
  assert.equal(discarded.status, "discarded")
})

test("foto de ubicación: citada no se descarta; sustituida se descarta y su objeto se retira con la sesión del dueño", async () => {
  const photo = await ctx.uploadMedia(a.id, sessionA, "location")
  const [room] = await ctx.asUser(a.id, (tx) => tx`insert into biblib.locations (user_id, name, kind, photo_asset_id) values (${a.id}, 'Despacho', 'room', ${photo.id}) returning id`)
  const referenced = await ctx.asUser(a.id, async (tx) => (await tx`select biblib.media_asset_discard(${photo.id}::uuid) as result`)[0].result)
  assert.equal(referenced.status, "referenced")
  await ctx.asUser(a.id, (tx) => tx`update biblib.locations set photo_asset_id = null where id = ${room.id}`)
  const discarded = await ctx.asUser(a.id, async (tx) => (await tx`select biblib.media_asset_discard(${photo.id}::uuid) as result`)[0].result)
  assert.deepEqual(discarded, { status: "discarded", storage_key: photo.key })
  const removed = await ctx.storageAs(sessionA).remove([photo.key])
  assert.equal(removed.error, null)
  assert.equal((await ctx.admin.storage.from("biblib-media").list(`${a.id}/location`)).data.filter((object) => object.name === photo.id).length, 0)
})

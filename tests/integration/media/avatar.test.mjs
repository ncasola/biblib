import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { createClient } from "@supabase/supabase-js"
import sharp from "sharp"
import { productContext, value } from "../product/lib/context.mjs"
import { callActionWithForm } from "../assets/lib/context.mjs"
import { purgeBatch } from "../../../scripts/jobs/purge-media-assets.mjs"
import { replaceAvatar } from "../../../lib/media/avatar-workflow.ts"

let ctx, a, b, sa, sb
before(async () => {
  ctx = await productContext()
  a = await ctx.account("avatar-a"); b = await ctx.account("avatar-b")
  sa = await ctx.signIn(a); sb = await ctx.signIn(b)
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })
const image = (color) => sharp({ create: { width: 80, height: 80, channels: 3, background: color } }).png().toBuffer()
const profile = async (owner) => (await ctx.sql`select * from biblib.profiles where user_id = ${owner}`)[0]
const upload = async (bytes, version, session = sa, type = "image/png") => callActionWithForm(ctx.app, "uploadProfileAvatarAction", { image: new File([bytes], "avatar.png", { type }), version: version ?? "" }, { cookies: session.cookies() })

test("avatar: subir, persistir, sustituir y quitar por acciones reales; Google no cambia", async () => {
  const before = (await ctx.admin.auth.admin.getUserById(a.id)).data.user.user_metadata
  const first = value(await upload(await image("red"), null))
  assert.ok(first.avatar.startsWith("/api/media/"))
  assert.equal(value(await ctx.call("getProfileAvatarAction", [], sa)).avatar, first.avatar)
  const served = await ctx.get(first.avatar, sa)
  assert.equal(served.status, 200); assert.equal(served.contentType, "image/webp")
  assert.equal((await sharp(served.body).metadata()).exif, undefined)
  const second = value(await upload(await image("blue"), first.version))
  assert.notEqual(second.avatar, first.avatar)
  assert.equal((await ctx.get(first.avatar, sa)).status, 404)
  assert.equal((await ctx.get(second.avatar, sa)).status, 200)
  const removed = value(await ctx.call("removeProfileAvatarAction", [second.version], sa))
  assert.equal(removed.avatar, undefined)
  assert.equal((await profile(a.id)).avatar_asset_id, null)
  assert.equal((await ctx.get(second.avatar, sa)).status, 404)
  assert.deepEqual((await ctx.admin.auth.admin.getUserById(a.id)).data.user.user_metadata, before)
})

test("avatar: B no lee la ruta ni modifica el perfil de A; ruta manipulada y versión antigua fallan", async () => {
  const current = await profile(a.id)
  const own = value(await upload(await image("green"), current.version))
  const row = await profile(a.id)
  assert.equal((await ctx.get(own.avatar, sb)).status, 404)
  const foreignVersion = await ctx.call("removeProfileAvatarAction", [own.version], sb)
  assert.equal(foreignVersion.value.error.code, "CONFLICT")
  assert.equal((await profile(a.id)).avatar_asset_id, row.avatar_asset_id)
  const forged = await ctx.storageAs(sb).upload(`${a.id}/avatar/${row.avatar_asset_id}`, await image("red"), { contentType: "image/webp", upsert: true })
  assert.ok(forged.error)
  const stale = await upload(await image("blue"), current.version)
  assert.equal(stale.value.error.code, "CONFLICT")
  assert.equal((await profile(a.id)).version, row.version)
  const invalid = await upload(Buffer.from("<svg/>"), row.version, sa, "image/svg+xml")
  assert.equal(invalid.value.error.code, "ASSET_REJECTED")
  assert.equal((await profile(a.id)).version, row.version)
})

test("avatar: fallo de red de Storage conserva los bytes y la referencia anterior", async () => {
  const previous = await profile(a.id)
  const original = await ctx.get(`/api/media/${previous.avatar_asset_id}`, sa)
  const broken = createClient(ctx.env.SUPABASE_URL, ctx.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${sa.session.access_token}` }, fetch: async () => { throw new TypeError("fetch failed (red simulada)") } },
  }).storage.from("biblib-media")
  let published = false
  await assert.rejects(replaceAvatar({
    prepare: async () => {
      const [{ result: asset }] = await ctx.asUser(a.id, (tx) => tx`select biblib.media_asset_begin_upload('avatar') as result`)
      assert.equal(asset.status, "created")
      const result = await broken.upload(asset.storage_key, await image("red"), { contentType: "image/webp", upsert: false })
      assert.ok(result.error)
      await ctx.asUser(a.id, (tx) => tx`select biblib.media_asset_discard(${asset.asset_id}::uuid)`)
      throw new Error("red simulada")
    },
    publish: async () => { published = true; throw new Error("no debe publicar") },
    discard: async () => { throw new Error("no debe soltar el anterior") },
  }), /red simulada/)
  assert.equal(published, false)
  assert.equal((await profile(a.id)).version, previous.version)
  assert.deepEqual((await ctx.get(`/api/media/${previous.avatar_asset_id}`, sa)).body, original.body)
})

test("media: purga cuarentenas vencidas y huérfanos, mantiene avatar citado y permite reintento", async () => {
  const live = (await profile(a.id)).avatar_asset_id
  const abandoned = await ctx.uploadMedia(a.id, sa, "location")
  await ctx.sql`update biblib.media_assets set updated_at = now() - interval '2 days' where id = ${abandoned.id}`
  const [{ result: expired }] = await ctx.asUser(a.id, (tx) => tx`select biblib.media_asset_begin_upload('avatar') as result`)
  await ctx.sql`update biblib.media_assets set expires_at = now() - interval '1 minute' where id = ${expired.asset_id}`
  // Acota el lote a la cuenta desechable para no tocar ninguna otra biblioteca del perfil.
  const ownerSql = async (parts, ...args) => parts.join("").includes("purge_candidates")
    ? ctx.sql`select biblib.media_asset_purge_candidates(${a.id}::uuid, ${args[0]}::integer, ${args[1]}::integer) as result`
    : ctx.sql`select biblib.media_asset_purge_confirm(${a.id}::uuid, ${args[0]}::uuid[], ${args[1]}::integer) as result`
  const failed = await purgeBatch({ sql: ownerSql, storage: { remove: async () => ({ error: new Error("red") }) }, limit: 100, graceSeconds: 0 })
  assert.ok(failed.failedObjects > 0)
  await ctx.sql`update storage.objects set created_at = now() - interval '11 minutes' where bucket_id = 'biblib-media' and name = ${abandoned.key}`
  const retried = await purgeBatch({ sql: ownerSql, storage: ctx.admin.storage.from("biblib-media"), limit: 100, graceSeconds: 0 })
  assert.equal(retried.failedObjects, 0); assert.ok(retried.objects > 0)
  assert.equal((await ctx.get(`/api/media/${live}`, sa)).status, 200)
  assert.equal((await ctx.sql`select id from biblib.media_assets where id = ${expired.asset_id}`).length, 0)
})

test("avatar: una cuenta inactiva no sube ni quita con su JWT anterior", async () => {
  const inactive = await ctx.account("inactiva"), session = await ctx.signIn(inactive)
  const own = value(await upload(await image("red"), null, session))
  await ctx.asUser(inactive.id, (tx) => tx`select biblib.account_deletion_request(${ctx.key("eliminar")})`)
  const result = await upload(await image("blue"), own.version, session)
  assert.equal(result.value.error.code, "ACCOUNT_INACTIVE")
  const removed = await ctx.call("removeProfileAvatarAction", [own.version], session)
  assert.equal(removed.value.error.code, "ACCOUNT_INACTIVE")
  assert.equal((await profile(inactive.id)).avatar_asset_id, own.avatar.split("/").at(-1))
})

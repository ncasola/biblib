// U-DAT-10 · Portada privada de ensayo para el ciclo respaldo → reset → restore → verify en scratch.
// `node docs/validacion/2026-10-24/O11/dat-10/portada-de-ensayo.mjs crear|comprobar|retirar`
// Crea, con la sesión GoTrue real de A y las mismas funciones que usa la app, un asset validado en el
// bucket privado y lo adjunta a una ficha de A; comprueba su estado tras el restore; o lo retira.
// Solo imprime IDs técnicos y estados.
import { createHash } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import sharp from "sharp"
import { signInFixture } from "../../../../../tests/integration/support/session.mjs"
import { resolveSeedTarget } from "../../../../../scripts/db/seed-local.mjs"
import { closeConnection, connect } from "../../../../../scripts/db/target.mjs"

const mode = process.argv[2]
const resolved = await resolveSeedTarget("scratch")
const sql = connect(resolved, { applicationName: "biblib-dat10-ensayo" })
const asUser = (userId, work) => sql.begin(async (tx) => {
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${userId}, true)`
  await tx`set local role authenticated`
  return work(tx)
})
try {
  const a = await signInFixture("a", { profile: "scratch" })
  const owner = a.user.id
  const env = resolved.target.env()
  const storage = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${a.session.access_token}` } } }).storage.from("biblib-covers")
  if (mode === "crear") {
    const [book] = await sql`select id, version from biblib.books where user_id = ${owner} order by id limit 1`
    const webp = await sharp({ create: { width: 300, height: 450, channels: 3, background: "#6b4e8b" } }).webp({ quality: 82 }).toBuffer()
    const [{ begun }] = await asUser(owner, (tx) => tx`select biblib.cover_asset_begin_upload() as begun`)
    const key = `${owner}/${begun.asset_id}/${begun.upload_token}.webp`
    const { error } = await storage.upload(key, webp, { contentType: "image/webp", upsert: false })
    if (error) throw new Error("Storage rechazó la subida de ensayo")
    const sha = createHash("sha256").update(webp).digest("hex")
    const [{ registered }] = await asUser(owner, (tx) => tx`select biblib.cover_asset_register(${begun.asset_id}::uuid, ${begun.upload_token}, ${sha}, ${webp.length}::integer, 300, 450, null) as registered`)
    await asUser(owner, (tx) => tx`update biblib.books set cover_asset_id = ${begun.asset_id} where id = ${book.id} and version = ${book.version}`)
    console.log(JSON.stringify({ asset: begun.asset_id, book: book.id, registered: registered.status, bytes: webp.length }))
  } else if (mode === "comprobar") {
    const rows = await sql`select a.id, a.state, a.sha256 = encode(sha256(convert_to('', 'UTF8')), 'hex') as vacio, (select count(*)::int from biblib.books b where b.cover_asset_id = a.id) as fichas,
        exists (select 1 from storage.objects o where o.bucket_id = 'biblib-covers' and o.name = a.storage_key) as objeto
      from biblib.cover_assets a where a.user_id = ${owner}`
    const { data } = await storage.download(rows[0]?.id ? (await sql`select storage_key from biblib.cover_assets where id = ${rows[0].id}`)[0].storage_key : "x")
    console.log(JSON.stringify({ assets: rows.map(({ id, state, fichas, objeto }) => ({ id, state, fichas, objeto })), descargaConSesionDeA: Boolean(data) }))
  } else if (mode === "retirar") {
    const assets = await sql`select id, storage_key from biblib.cover_assets where user_id = ${owner}`
    await sql`update biblib.books set cover_asset_id = null where user_id = ${owner} and cover_asset_id is not null`
    await sql`delete from biblib.cover_assets where user_id = ${owner}`
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const keys = assets.map((asset) => asset.storage_key).filter(Boolean)
    if (keys.length) await admin.storage.from("biblib-covers").remove(keys)
    console.log(JSON.stringify({ retirados: assets.length }))
  } else throw new Error("Modo: crear | comprobar | retirar")
  await a.client.auth.signOut({ scope: "local" }).catch(() => {})
} finally { await closeConnection(sql) }

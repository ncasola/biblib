// U-QA-05 (O16) · Ensayo del respaldo administrativo de la versión final sobre el perfil scratch: Storage
// (`biblib-media` y `biblib-covers`), datos de producto y lectura/préstamos, borrado de cuenta y no resurrección.
// node docs/validacion/2026-10-26/O16/qa-05/ensayo-final.mjs cargar|solicitar|comprobar|retirar
//   cargar     crea dos cuentas desechables `o13d-<run>-…@biblib.test`: K (se conserva) y C (se suprimirá), cada una con
//              biblioteca, avatar y foto de ubicación privados en biblib-media por el flujo real de subida, portada privada
//              en biblib-covers, etiquetas, nota, serie, ciclo de lectura con entrada y préstamo.
//   solicitar  pide la eliminación de C con sus propios claims; el worker es `pnpm account:deletions:local`.
//   comprobar  imprime, sin datos de biblioteca, restos de K y C, identidad, objetos y sha256 de los objetos de K.
//   retirar    retira K (objetos e identidad; la cascada de auth.users retira sus filas) y el registro privado.
// El registro privado (.biblib/ensayo-qa05.json, fuera de Git) guarda IDs y claves de objetos; nunca contraseñas en la salida.
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { REPO_ROOT } from "../../../../../scripts/lib/profiles.mjs"

process.env.BIBLIB_PROFILE = "scratch"
process.env.BIBLIB_PRODUCT_RUN_ID ||= randomBytes(6).toString("hex")
const { productContext, MEDIA_BUCKET } = await import("../../../../../tests/integration/product/lib/context.mjs")
const COVERS = "biblib-covers"
const COVER = readFileSync(path.join(REPO_ROOT, "public", "default-book-cover.webp"))
const file = path.join(REPO_ROOT, ".biblib", "ensayo-qa05.json")
const command = process.argv[2]
const ctx = await productContext()
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")

async function populate(label) {
  const account = await ctx.account(label)
  const owner = account.id
  const { shelf, books } = await ctx.library(owner)
  const session = await ctx.signIn(account)
  const avatar = await ctx.uploadMedia(owner, session, "avatar")
  const photo = await ctx.uploadMedia(owner, session, "location")
  const { sql } = ctx
  await sql`insert into biblib.profiles (user_id, avatar_asset_id) values (${owner}, ${avatar.id})`
  const [location] = await sql`insert into biblib.locations (user_id, name, kind, photo_asset_id) values (${owner}, ${ctx.label("salón")}, 'bookcase', ${photo.id}) returning id`
  await sql`insert into biblib.copy_locations (user_id, copy_id, location_id, shelf_label, position) values (${owner}, ${books[0].id}, ${location.id}, 'B2', 3)`
  const [tag] = await sql`insert into biblib.tags (user_id, name) values (${owner}, 'ensayo') returning id`
  await sql`insert into biblib.copy_tags (user_id, copy_id, tag_id) values (${owner}, ${books[0].id}, ${tag.id})`
  await sql`insert into biblib.copy_annotations (user_id, copy_id, notes, rating) values (${owner}, ${books[0].id}, ${ctx.label("nota")}, 4)`
  const [series] = await sql`insert into biblib.series (user_id, title) values (${owner}, ${ctx.label("serie")}) returning id`
  await sql`insert into biblib.series_editions (user_id, edition_id, series_id, position) values (${owner}, ${books[1].editionId}, ${series.id}, 1.5)`
  const [cycle] = await sql`insert into biblib.reading_cycles (user_id, copy_id, cycle_number, status, started_at, finished_at) values (${owner}, ${books[0].id}, 1, 'finished', '2026-01-10T10:00:00Z', '2026-02-01T20:00:00Z') returning id`
  await sql`insert into biblib.reading_entries (user_id, cycle_id, occurred_at, page_to) values (${owner}, ${cycle.id}, '2026-01-20T10:00:00Z', 120)`
  await sql`insert into biblib.loans (user_id, copy_id, borrower_label, loaned_on, due_on) values (${owner}, ${books[2].id}, 'Prestatario ficticio', '2026-10-01', '2026-11-01')`
  const coverId = randomUUID()
  const coverKey = `${owner}/${coverId}/v1.webp`
  const coverBytes = Buffer.concat([COVER, randomBytes(8)])
  const { error } = await ctx.admin.storage.from(COVERS).upload(coverKey, coverBytes, { contentType: "image/webp", upsert: false })
  if (error) throw new Error("Storage no aceptó la portada del ensayo.")
  await sql`insert into biblib.cover_assets (id, user_id, storage_key, sha256, mime, width, height, bytes, state, source_kind, source_ref, rights_policy_version)
    values (${coverId}, ${owner}, ${coverKey}, ${sha(coverBytes)}, 'image/webp', 10, 10, ${coverBytes.length}, 'ready', 'upload', 'upload', 'v1')`
  await sql`update biblib.editions set cover_asset_id = ${coverId} where id = ${books[0].editionId}`
  return {
    id: owner,
    objects: [
      { bucket: MEDIA_BUCKET, key: avatar.key, sha256: avatar.sha256 },
      { bucket: MEDIA_BUCKET, key: photo.key, sha256: photo.sha256 },
      { bucket: COVERS, key: coverKey, sha256: sha(coverBytes) },
    ],
    shelf, copies: books.length,
  }
}

async function objectState(entry) {
  const { data, error } = await ctx.admin.storage.from(entry.bucket).download(entry.key)
  if (error || !data) return { bucket: entry.bucket, present: false }
  return { bucket: entry.bucket, present: true, sha256Matches: sha(Buffer.from(await data.arrayBuffer())) === entry.sha256 }
}

async function counts(owner) {
  const [row] = await ctx.sql`select
    (select count(*)::int from biblib.copies where user_id = ${owner}) as copies,
    (select count(*)::int from biblib.media_assets where user_id = ${owner}) as media,
    (select count(*)::int from biblib.cover_assets where user_id = ${owner}) as covers,
    (select count(*)::int from biblib.reading_cycles where user_id = ${owner}) as cycles,
    (select count(*)::int from biblib.reading_entries where user_id = ${owner}) as entries,
    (select count(*)::int from biblib.loans where user_id = ${owner}) as loans,
    (select count(*)::int from biblib.copy_tags where user_id = ${owner}) as copy_tags,
    (select count(*)::int from biblib.series_editions where user_id = ${owner}) as series_editions,
    (select count(*)::int from biblib.copy_locations where user_id = ${owner}) as copy_locations,
    (select count(*)::int from biblib.profiles where user_id = ${owner} and avatar_asset_id is not null) as avatar`
  return row
}

async function prefixObjects(owner) {
  const [row] = await ctx.sql`select count(*)::int as n from storage.objects where name like ${`${owner}/%`} and bucket_id in (${MEDIA_BUCKET}, ${COVERS})`
  return row.n
}

try {
  if (command === "cargar") {
    if (existsSync(file)) throw new Error("Ya existe un registro del ensayo; ejecuta «retirar» antes de cargar otra vez.")
    const k = await populate("conserva")
    const c = await populate("suprime")
    writeFileSync(file, JSON.stringify({ run: ctx.run, k, c }), { mode: 0o600 })
    console.log(JSON.stringify({ K: await counts(k.id), C: await counts(c.id), objetosK: await prefixObjects(k.id), objetosC: await prefixObjects(c.id) }))
  } else {
    if (!existsSync(file)) throw new Error("Falta el registro del ensayo; ejecuta antes «cargar».")
    const { k, c } = JSON.parse(readFileSync(file, "utf8"))
    if (command === "solicitar") {
      const [{ r }] = await ctx.asUser(c.id, (tx) => tx`select biblib.account_deletion_request(${ctx.key("qa05")}) as r`)
      console.log(JSON.stringify({ cuenta: "C", estado: r.state, paso: r.step, creada: r.created }))
    } else if (command === "comprobar") {
      const mark = (await ctx.sql`select state, step from biblib.account_deletions where user_id = ${c.id}`)[0] ?? null
      const identity = async (id) => { const { data, error } = await ctx.admin.auth.admin.getUserById(id); return !error && Boolean(data.user) }
      console.log(JSON.stringify({
        K: { identidad: await identity(k.id), filas: await counts(k.id), objetos: await Promise.all(k.objects.map(objectState)), restos: await ctx.residue(k.id) },
        C: { identidad: await identity(c.id), filas: await counts(c.id), objetosEnStorage: await prefixObjects(c.id), restos: await ctx.residue(c.id), marca: mark },
      }, null, 2))
    } else if (command === "retirar") {
      for (const entry of k.objects) await ctx.admin.storage.from(entry.bucket).remove([entry.key])
      await ctx.admin.auth.admin.deleteUser(k.id)
      rmSync(file, { force: true })
      console.log(JSON.stringify({ retirada: "K", objetosRestantes: await prefixObjects(k.id) }))
    } else throw new Error("Uso: ensayo-final.mjs cargar|solicitar|comprobar|retirar")
  }
} finally {
  await ctx.close()
}

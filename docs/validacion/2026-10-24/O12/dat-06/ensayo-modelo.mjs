// U-DAT-06 · Ensayo de la migración del modelo en scratch con datos legacy.
// `node docs/validacion/2026-10-24/O12/dat-06/ensayo-modelo.mjs cargar|comprobar|retirar`
//
// cargar (head 0009): crea la cuenta de ensayo `modelo-ensayo@biblib.test` en GoTrue, escribe en `books`
//   el fixture sintético de 111 fichas y el de equivalencias ISBN-10/13 (IDs derivados y estables) y adjunta
//   una portada privada validada a una ficha con la sesión real de la cuenta.
// comprobar: lee el estado (0009, 0010 o 0011+) y compara cada ficha con lo cargado: ID, ubicación, autores,
//   editoriales, estado, portadas (URL y asset), procedencia, comprobación física e identificador (mismo texto
//   o ISBN-13 equivalente). Informa ediciones, ejemplares, obras, agrupaciones y conflictos.
// retirar: borra la cuenta (cascada) y su objeto de Storage.
// Solo imprime IDs técnicos, recuentos y estados; la contraseña queda en .biblib/state (ignorado por Git).
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"
import sharp from "sharp"
import { REPO_ROOT } from "../../../../../scripts/lib/profiles.mjs"
import { resolveSeedTarget } from "../../../../../scripts/db/seed-local.mjs"
import { closeConnection, connect } from "../../../../../scripts/db/target.mjs"

const EMAIL = "modelo-ensayo@biblib.test"
const STATE = path.join(REPO_ROOT, ".biblib", "state", "dat06-ensayo.json")
const DEFAULT_COVER = "/default-book-cover.webp"
const readJson = (relative) => JSON.parse(readFileSync(path.join(REPO_ROOT, relative), "utf8"))
const synthetic = readJson("tests/fixtures/import/sintetico-111.json")
const equivalences = readJson("tests/fixtures/migrations/model-equivalencias.json")

function stableId(kind, source) {
  const hex = createHash("sha256").update(`dat06|${kind}|${source}`).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function normalizeIsbn(value) {
  const isbn = value.replace(/[\s-]/g, "").toUpperCase()
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const sum = [...isbn].reduce((total, digit, index) => total + (digit === "X" ? 10 : Number(digit)) * (10 - index), 0)
    if (sum % 11 !== 0) return null
    const prefix = `978${isbn.slice(0, 9)}`
    return `${prefix}${(10 - [...prefix].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0) % 10) % 10}`
  }
  if (!/^97[89]\d{10}$/.test(isbn)) return null
  return [...isbn].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0) % 10 === 0 ? isbn : null
}

/** Filas legacy tal como se escriben en `books`, con la expectativa de identificador de cada una. */
function legacyRows() {
  const rows = []
  for (const [set, data] of [["sintetico", synthetic], ["equivalencias", equivalences]]) {
    data.books.forEach((book, index) => {
      const cover = book.cover ?? {}
      rows.push({
        source: `${set}:${book.id}`, id: stableId("book", `${set}:${book.id}`), isbn: book.isbn, title: book.title, subtitle: book.subtitle ?? null,
        authors: book.authors, publishers: book.publishers ?? [], number_of_pages: book.number_of_pages, publish_date: book.publish_date,
        cover_small: cover.small || DEFAULT_COVER, cover_medium: cover.medium || DEFAULT_COVER, cover_large: cover.large || DEFAULT_COVER,
        status: book.status, shelf_id: stableId("shelf", `${set}:${book.shelf_id}`), catalogue: book.catalogue ?? { source: "import", isbnVerified: false },
        created_at: book.createdAt ?? new Date(Date.UTC(2026, 0, 1, 9, 0, index)).toISOString(), expect: book.expect ?? {},
      })
    })
  }
  return rows
}

function shelvesOf() {
  return [["sintetico", synthetic], ["equivalencias", equivalences]].flatMap(([set, data]) => data.shelves.map((shelf, index) => ({ id: stableId("shelf", `${set}:${shelf.id}`), title: `${shelf.title} (${set})`, position: index })))
}

const mode = process.argv[2]
const resolved = await resolveSeedTarget("scratch")
const env = resolved.target.env()
const sql = connect(resolved, { applicationName: "biblib-dat06-ensayo" })
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const asUser = (userId, work) => sql.begin(async (tx) => {
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${userId}, true)`
  await tx`set local role authenticated`
  return work(tx)
})
const relkind = async (name) => (await sql`select c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'biblib' and c.relname = ${name}`)[0]?.relkind ?? null

try {
  if (mode === "cargar") {
    if (existsSync(STATE)) throw new Error("Ya hay una cuenta de ensayo registrada; retírala antes de volver a cargar.")
    if (await relkind("copies")) throw new Error("La carga legacy se hace con head 0009 (sin copies).")
    const password = randomBytes(18).toString("base64url")
    const { data, error } = await admin.auth.admin.createUser({ email: EMAIL, password, email_confirm: true })
    if (error || !data.user) throw new Error("GoTrue no creó la cuenta de ensayo.")
    const owner = data.user.id
    mkdirSync(path.dirname(STATE), { recursive: true, mode: 0o700 })
    writeFileSync(STATE, JSON.stringify({ owner, email: EMAIL, password }), { mode: 0o600 })
    const rows = legacyRows()
    await sql.begin(async (tx) => {
      await tx`insert into biblib.shelves (id, user_id, title, is_default) values (${stableId("shelf", "default")}, ${owner}, 'Predeterminada', true)`
      for (const shelf of shelvesOf()) await tx`insert into biblib.shelves (id, user_id, title, is_default, created_at) values (${shelf.id}, ${owner}, ${shelf.title}, false, ${new Date(Date.UTC(2026, 0, 1, 8, shelf.position)).toISOString()})`
      for (const row of rows) {
        await tx`insert into biblib.books (id, user_id, isbn, title, subtitle, authors, publishers, catalogue, number_of_pages, publish_date, cover_small, cover_medium, cover_large, status, shelf_id, created_at)
          values (${row.id}, ${owner}, ${row.isbn}, ${row.title}, ${row.subtitle}, ${tx.json(row.authors)}, ${tx.json(row.publishers)}, ${tx.json(row.catalogue)}, ${row.number_of_pages}, ${row.publish_date},
            ${row.cover_small}, ${row.cover_medium}, ${row.cover_large}, ${row.status}, ${row.shelf_id}, ${row.created_at})`
      }
    })
    // Portada privada validada con la sesión real de la cuenta, adjunta a la primera ficha sintética.
    const user = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const signed = await user.auth.signInWithPassword({ email: EMAIL, password })
    if (signed.error || !signed.data.session) throw new Error("GoTrue no abrió la sesión de ensayo.")
    const storage = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${signed.data.session.access_token}` } } }).storage.from("biblib-covers")
    const webp = await sharp({ create: { width: 300, height: 450, channels: 3, background: "#6b7c3f" } }).webp({ quality: 82 }).toBuffer()
    const [{ begun }] = await asUser(owner, (tx) => tx`select biblib.cover_asset_begin_upload() as begun`)
    const upload = await storage.upload(`${owner}/${begun.asset_id}/${begun.upload_token}.webp`, webp, { contentType: "image/webp", upsert: false })
    if (upload.error) throw new Error("Storage rechazó la portada de ensayo.")
    const sha = createHash("sha256").update(webp).digest("hex")
    const [{ registered }] = await asUser(owner, (tx) => tx`select biblib.cover_asset_register(${begun.asset_id}::uuid, ${begun.upload_token}, ${sha}, ${webp.length}::integer, 300, 450, null) as registered`)
    await asUser(owner, (tx) => tx`update biblib.books set cover_asset_id = ${begun.asset_id} where id = ${rows[0].id}`)
    await user.auth.signOut({ scope: "local" }).catch(() => {})
    console.log(JSON.stringify({ cuenta: owner, fichas: rows.length, estanterias: shelvesOf().length + 1, portada: { asset: begun.asset_id, ficha: rows[0].id, registro: registered.status } }))
  } else if (mode === "comprobar") {
    const { owner } = JSON.parse(readFileSync(STATE, "utf8"))
    const stage = !(await relkind("copies")) ? "0009" : (await relkind("books")) === "v" ? "0011" : "0010"
    const rows = legacyRows()
    const [asset] = await sql`select id, state from biblib.cover_assets where user_id = ${owner}`
    const flat = stage === "0009"
      ? await sql`select id, isbn, null::text as isbn13, null::text as legacy_identifier, id as edition_id, title, subtitle, authors, publishers, catalogue, number_of_pages, publish_date, cover_small, cover_medium, cover_large, cover_asset_id, status, shelf_id, created_at from biblib.books where user_id = ${owner}`
      : stage === "0010"
        ? await sql`select c.id, coalesce(e.isbn13, c.legacy_identifier) as isbn, e.isbn13, c.legacy_identifier, c.edition_id, e.title, e.subtitle, e.authors, e.publishers,
            e.catalogue || jsonb_build_object('isbnVerified', c.edition_verification->'isbnVerified') as catalogue, e.number_of_pages, e.publish_date, e.cover_small, e.cover_medium, e.cover_large, e.cover_asset_id, c.status, c.shelf_id, c.created_at
            from biblib.copies c join biblib.editions e on e.user_id = c.user_id and e.id = c.edition_id where c.user_id = ${owner}`
        : await sql`select id, isbn, isbn13, legacy_identifier, edition_id, title, subtitle, authors, publishers, catalogue, number_of_pages, publish_date, cover_small, cover_medium, cover_large, cover_asset_id, status, shelf_id, created_at from biblib.books where user_id = ${owner}`
    const byId = new Map(flat.map((row) => [row.id, row]))
    const mismatches = []
    const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const catalogueOf = (value) => ({ ...value, isbnVerified: value.isbnVerified === true })
    for (const expected of rows) {
      const found = byId.get(expected.id)
      if (!found) { mismatches.push({ id: expected.id, campo: "ausente" }); continue }
      const normalized = normalizeIsbn(expected.isbn)
      // En 0010 toda equivalencia que no ganó el ISBN-13 queda en conflicto; 0011 agrupa solo las compatibles.
      const conflict = expected.expect.conflict === true || (stage === "0010" && Boolean(expected.expect.group) && expected.isbn !== normalized)
      const identifierOk = stage === "0009" ? found.isbn === expected.isbn
        : conflict ? found.isbn13 === null && found.legacy_identifier === expected.isbn
          : normalized ? found.isbn13 === normalized && found.legacy_identifier === null
            : found.isbn13 === null && found.legacy_identifier === expected.isbn
      const checks = {
        identificador: identifierOk, titulo: found.title === expected.title, subtitulo: found.subtitle === expected.subtitle,
        autores: sameJson(found.authors, expected.authors), editoriales: sameJson(found.publishers, expected.publishers),
        paginas: found.number_of_pages === expected.number_of_pages, fecha: found.publish_date === expected.publish_date,
        portadas: found.cover_small === expected.cover_small && found.cover_medium === expected.cover_medium && found.cover_large === expected.cover_large,
        portadaPrivada: expected.id === rows[0].id ? found.cover_asset_id === asset?.id : found.cover_asset_id === null,
        estado: found.status === expected.status, ubicacion: found.shelf_id === expected.shelf_id,
        procedencia: sameJson(Object.entries(catalogueOf(found.catalogue)).sort(), Object.entries(catalogueOf(expected.catalogue)).sort()),
        alta: new Date(found.created_at).toISOString() === new Date(expected.created_at).toISOString(),
      }
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([field]) => field)
      if (failed.length) mismatches.push({ id: expected.id, campos: failed })
    }
    const groups = new Map()
    for (const row of flat) groups.set(row.edition_id, [...(groups.get(row.edition_id) ?? []), row.id])
    const shared = [...groups.values()].filter((ids) => ids.length > 1).map((ids) => ids.sort())
    const counts = stage === "0009" ? null : (await sql`select (select count(*)::int from biblib.copies where user_id = ${owner}) as ejemplares, (select count(*)::int from biblib.editions where user_id = ${owner}) as ediciones,
      (select count(*)::int from biblib.works where user_id = ${owner}) as obras`)[0]
    const report = stage === "0009" ? [] : await sql`select migration, kind, count(*)::int as n from biblib.model_migration_report where user_id = ${owner} group by 1, 2 order by 1, 2`
    const compared = stage === "0009" ? null : (await sql`select biblib.model_compare(${owner}::uuid) as r`)[0].r
    console.log(JSON.stringify({ etapa: stage, fichas: rows.length, encontradas: flat.length, coinciden: rows.length - mismatches.length, distintas: mismatches.slice(0, 20),
      ...(counts ?? {}), edicionesCompartidas: shared, portadaPrivada: asset ? { asset: asset.id, estado: asset.state } : null,
      informe: report.map((entry) => `${entry.migration}:${entry.kind}=${entry.n}`), comparacion: compared }, null, 1))
    if (mismatches.length) process.exitCode = 1
  } else if (mode === "retirar") {
    const { owner } = JSON.parse(readFileSync(STATE, "utf8"))
    const keys = (await sql`select storage_key from biblib.cover_assets where user_id = ${owner} and storage_key is not null`).map((row) => row.storage_key)
    if (keys.length) await admin.storage.from("biblib-covers").remove(keys)
    const { error } = await admin.auth.admin.deleteUser(owner)
    if (error) throw new Error("GoTrue no retiró la cuenta de ensayo.")
    rmSync(STATE, { force: true })
    console.log(JSON.stringify({ retirada: owner, objetos: keys.length }))
  } else throw new Error("Modo: cargar | comprobar | retirar")
} finally { await closeConnection(sql) }

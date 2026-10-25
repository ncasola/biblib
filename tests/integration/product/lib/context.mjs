import { createHash, randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import { BiblibError, EXIT } from "../../../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../../../scripts/lib/profiles.mjs"
import { resolveSeedTarget } from "../../../../scripts/db/seed-local.mjs"
import { closeConnection, connect } from "../../../../scripts/db/target.mjs"
import { callAction, get, loadActions } from "../../lib/app.mjs"

// Contexto del grupo product (O13, lote D de 0014): Postgres, GoTrue, Storage y la app compilada del perfil scratch o test.
// Cada prueba crea cuentas desechables `o13d-<run>-…@biblib.test` con su biblioteca y sesiones GoTrue reales; las
// escrituras de cliente se hacen con los claims del dueño y el rol `authenticated`, como `withRlsContext` de la app, y la
// ida y vuelta v2 pasa por las Server Actions y la ruta de exportación reales. Al terminar no queda ninguna cuenta ni objeto.
export const PROFILES = ["scratch", "test"]
export const MEDIA_BUCKET = "biblib-media"
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
const WEBP = readFileSync(path.join(REPO_ROOT, "public", "default-book-cover.webp"))
const ROLLBACK = Symbol("rollback")

export function runId() {
  const id = process.env.BIBLIB_PRODUCT_RUN_ID || process.env.BIBLIB_INTEGRATION_RUN_ID
  if (!id || !/^[0-9a-f]{12}$/.test(id)) throw new BiblibError(EXIT.INVALID_ARGS, "suite", "Ejecuta el grupo con pnpm test:integration:product o pnpm test:integration:local.")
  return id
}

export async function productContext() {
  const profile = process.env.BIBLIB_PROFILE || "test"
  if (!PROFILES.includes(profile)) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo product solo usa los perfiles scratch o test.")
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo product solo admite BIBLIB_TARGET=local.")
  const run = runId()
  const resolved = await resolveSeedTarget(profile)
  const env = resolved.target.env()
  const sql = connect(resolved, { applicationName: "biblib-product-tests" })
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, clientOptions)
  const { host, port } = resolved.stack.profile.app
  const app = { url: `http://${host}:${port}`, actions: loadActions(resolved.stack.root) }
  const created = []
  let sequence = 0

  const claims = async (tx, userId) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${userId}, true)`
    await tx`set local role authenticated`
  }

  const ctx = {
    profile, run, resolved, env, sql, admin, app,
    key: (label = "op") => `o13d-${label}-${randomUUID().replaceAll("-", "")}`.slice(0, 64),
    label: (text) => `[O13-D ${run}] ${text}`,

    /** Cuenta desechable con contraseña aleatoria; se registra para retirarla al terminar. */
    async account(label) {
      const email = `o13d-${run}-${label}-${++sequence}@biblib.test`
      const password = randomBytes(24).toString("base64url")
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { biblib_o13d: run } })
      if (error || !data.user) throw new BiblibError(EXIT.SERVICE_UNAVAILABLE, "auth", "GoTrue no creó la cuenta desechable.")
      created.push(data.user.id)
      return { id: data.user.id, email, password }
    },

    /** Sesión GoTrue real con las cookies de @supabase/ssr, como en el navegador. */
    async signIn(account) {
      const jar = new Map()
      const client = createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, detectSessionInUrl: false },
        cookies: { getAll: () => [...jar.values()].map(({ name, value }) => ({ name, value })), setAll: (items) => { for (const item of items) jar.set(item.name, item) } },
      })
      const { data, error } = await client.auth.signInWithPassword({ email: account.email, password: account.password })
      if (error || !data.session) throw new BiblibError(EXIT.SERVICE_UNAVAILABLE, "auth", "GoTrue no abrió la sesión de la cuenta desechable.")
      return { session: data.session, cookies: () => [...jar.values()].filter((cookie) => cookie.value !== "").map(({ name, value }) => ({ name, value })) }
    },
    call(name, args, session) { return callAction(app, name, args, { cookies: session.cookies() }) },
    get(route, session) { return get(app, route, { cookies: session.cookies() }) },
    /** Storage del bucket de imágenes con el JWT de la sesión: lo mismo que puede hacer el navegador con su token. */
    storageAs(session) { return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { ...clientOptions, global: { headers: { Authorization: `Bearer ${session.session.access_token}` } } }).storage.from(MEDIA_BUCKET) },

    /** Transacción confirmada con los claims del dueño y el rol `authenticated`, como withRlsContext de la app. */
    asUser(userId, work) { return sql.begin(async (tx) => { await claims(tx, userId); return work(tx) }) },
    /** Igual, pero siempre revertida: los intentos de escritura de una prueba no dejan rastro. */
    async rolledBack(userId, work, { before } = {}) {
      let result
      try {
        await sql.begin(async (tx) => {
          if (before) await before(tx)
          await claims(tx, userId)
          result = await work(tx)
          throw ROLLBACK
        })
      } catch (error) { if (error !== ROLLBACK) throw error }
      return result
    },
    /** SQLSTATE de una sentencia en un savepoint (null si no falló). */
    async state(tx, statement) {
      try { await tx.savepoint((sp) => statement(sp)); return null } catch (error) { return error.code ?? "desconocido" }
    },

    /** Biblioteca mínima: estantería predeterminada y tres ejemplares de ediciones distintas (identificadores manuales). */
    async library(owner) {
      const [shelf] = await sql`insert into biblib.shelves (user_id, title, is_default) values (${owner}, 'Principal', true) returning id`
      const books = []
      for (const title of ["primero", "segundo", "tercero"]) {
        const [row] = await sql`insert into biblib.books (user_id, isbn, title, shelf_id, catalogue) values (${owner}, ${`manual-o13d-${run}-${++sequence}`}, ${ctx.label(title)}, ${shelf.id},
          ${sql.json({ source: "open-library", sourceUrl: "https://openlibrary.org/books/OL1M", isbnVerified: false })}) returning id, edition_id`
        books.push({ id: row.id, editionId: row.edition_id })
      }
      return { shelf: shelf.id, books }
    },

    /** Imagen privada propia por el flujo real: reserva con la sesión, subida por la API de Storage con su JWT y registro. */
    async uploadMedia(owner, session, kind) {
      const begun = await ctx.asUser(owner, async (tx) => (await tx`select biblib.media_asset_begin_upload(${kind}) as result`)[0].result)
      if (begun.status !== "created") throw new BiblibError(EXIT.SERVICE_UNAVAILABLE, "storage", `No se reservó la subida (${begun.status}).`)
      const bytes = Buffer.concat([WEBP, randomBytes(8)])
      const { error } = await ctx.storageAs(session).upload(begun.storage_key, bytes, { contentType: "image/webp", upsert: false })
      if (error) throw new BiblibError(EXIT.SERVICE_UNAVAILABLE, "storage", `Storage rechazó la subida autorizada: ${error.message}`)
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      const registered = await ctx.asUser(owner, async (tx) => (await tx`select biblib.media_asset_register(${begun.asset_id}::uuid, ${sha256}, ${bytes.length}, 64, 64) as result`)[0].result)
      if (registered.status !== "ready") throw new BiblibError(EXIT.SERVICE_UNAVAILABLE, "storage", `No se registró la imagen (${registered.status}).`)
      return { id: begun.asset_id, key: begun.storage_key, sha256, bytes }
    },

    /** Retira objetos y cuentas del run (la cascada de auth.users retira sus filas). */
    async cleanup() {
      for (const owner of created) {
        for (const prefix of ["avatar", "location", "evidence"]) {
          const { data } = await admin.storage.from(MEDIA_BUCKET).list(`${owner}/${prefix}`, { limit: 100 })
          if (data?.length) await admin.storage.from(MEDIA_BUCKET).remove(data.map((object) => `${owner}/${prefix}/${object.name}`))
        }
        await admin.auth.admin.deleteUser(owner)
      }
      created.length = 0
    },
    async close() { await closeConnection(sql) },
  }
  return ctx
}

/** Valor de una acción `ActionResult` correcta; lanza con el código si no lo es. */
export function value(result) {
  if (result.status !== 200 || result.value?.ok !== true) throw new Error(`Acción fallida: ${result.value?.error?.code ?? result.status} ${result.value?.error?.message ?? ""}`)
  return result.value.value
}

/** Estado de producto comparable de una cuenta: sin versiones ni fechas, con IDs. */
export async function productState(sql, owner) {
  const rows = async (query) => [...await query].map((row) => ({ ...row }))
  return {
    tags: await rows(sql`select id, name, normalized_name from biblib.tags where user_id = ${owner} order by id`),
    copyTags: await rows(sql`select copy_id, tag_id from biblib.copy_tags where user_id = ${owner} order by copy_id, tag_id`),
    annotations: await rows(sql`select copy_id, notes, rating from biblib.copy_annotations where user_id = ${owner} order by copy_id`),
    locations: await rows(sql`select id, parent_id, name, kind, photo_asset_id from biblib.locations where user_id = ${owner} order by id`),
    copyLocations: await rows(sql`select copy_id, location_id, shelf_label, position from biblib.copy_locations where user_id = ${owner} order by copy_id`),
    series: await rows(sql`select id, title, description from biblib.series where user_id = ${owner} order by id`),
    seriesEditions: await rows(sql`select edition_id, series_id, position::text as position, volume_label, order_note from biblib.series_editions where user_id = ${owner} order by edition_id`),
    evidence: await rows(sql`select id, edition_id, copy_id, source_kind, source_ref, source_url, photo_asset_id, observed_at, field_claims, confidence, origin
      from biblib.bibliographic_evidence where user_id = ${owner} order by id`),
  }
}

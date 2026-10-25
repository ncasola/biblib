import { randomBytes, randomUUID } from "node:crypto"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import sharp from "sharp"
import { BiblibError, EXIT } from "../../../../scripts/lib/exit-codes.mjs"
import { resolveSeedTarget } from "../../../../scripts/db/seed-local.mjs"
import { closeConnection, connect } from "../../../../scripts/db/target.mjs"
import { callAction, cookieHeader, decodeActionResponse, get, loadActions } from "../../lib/app.mjs"

// Contexto del grupo locations (U-PRO-03): Postgres, GoTrue, Storage y la app compilada del perfil scratch o test. Cada
// prueba crea cuentas desechables `pro03-<run>-…@biblib.test` con su biblioteca y sesiones GoTrue reales; todas las
// operaciones de ubicaciones pasan por las Server Actions reales (la foto, en multipart como el navegador) y la lectura de la
// foto por su ruta autenticada. Las consultas directas del proceso de pruebas solo comprueban el resultado. Al terminar no
// queda ninguna cuenta ni objeto del run.
export const PROFILES = ["scratch", "test"]
export const MEDIA_BUCKET = "biblib-media"
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

export function runId() {
  const id = process.env.BIBLIB_LOCATIONS_RUN_ID || process.env.BIBLIB_INTEGRATION_RUN_ID
  if (!id || !/^[0-9a-f]{12}$/.test(id)) throw new BiblibError(EXIT.INVALID_ARGS, "suite", "Ejecuta el grupo con pnpm test:integration:locations o pnpm test:integration:local.")
  return id
}

/** Marcador de texto que se escribe en el EXIF de las fotos de prueba: no debe aparecer en ningún byte guardado. */
export const EXIF_MARKER = "BIBLIB-PRO03-EXIF"

/** JPEG con EXIF (autoría y GPS) para comprobar que el servidor lo reencodifica sin metadatos. */
export function photoWithExif({ width = 320, height = 200, color = { r: 120, g: 90, b: 30 } } = {}) {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 85 })
    .withExif({ IFD0: { Artist: "Autora de prueba", Copyright: EXIF_MARKER }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 25/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "3/1 42/1 0/1" } })
    .toBuffer()
}

export async function locationsContext() {
  const profile = process.env.BIBLIB_PROFILE || "test"
  if (!PROFILES.includes(profile)) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo locations solo usa los perfiles scratch o test.")
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo locations solo admite BIBLIB_TARGET=local.")
  const run = runId()
  const resolved = await resolveSeedTarget(profile)
  const env = resolved.target.env()
  const sql = connect(resolved, { applicationName: "biblib-locations-tests" })
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, clientOptions)
  const { host, port } = resolved.stack.profile.app
  const app = { url: `http://${host}:${port}`, actions: loadActions(resolved.stack.root) }
  const created = []
  let sequence = 0

  const ctx = {
    profile, run, resolved, env, sql, admin, app,
    key: (label = "op") => `pro03-${label}-${randomUUID().replaceAll("-", "")}`.slice(0, 64),
    label: (text) => `[PRO-03 ${run}] ${text}`,

    /** Cuenta desechable con contraseña aleatoria; se registra para retirarla al terminar. */
    async account(label) {
      const email = `pro03-${run}-${label}-${++sequence}@biblib.test`
      const password = randomBytes(24).toString("base64url")
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { biblib_pro03: run } })
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
    call(name, args, session) { return callAction(app, name, args, { cookies: session?.cookies() ?? [] }) },
    get(route, session) { return get(app, route, { cookies: session?.cookies() ?? [] }) },

    /** Server Action con un FormData como único argumento, serializado como lo hace React en el navegador. */
    async form(name, fields, session) {
      const action = app.actions.get(name)
      if (!action) throw new BiblibError(EXIT.VERIFICATION_FAILED, "app", `La acción ${name} no está en el build.`)
      const form = new FormData()
      for (const [key, value] of Object.entries(fields)) form.append(`_1_${key}`, value)
      form.append("0", JSON.stringify(["$K1"]))
      const response = await fetch(`${app.url}${action.route}`, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(60_000),
        headers: { "Next-Action": action.id, Accept: "text/x-component", Origin: app.url, Cookie: cookieHeader(session.cookies()) }, body: form,
      })
      const body = Buffer.from(await response.arrayBuffer())
      const result = { status: response.status, value: undefined, thrown: false }
      if (response.status !== 200 || !(response.headers.get("content-type") ?? "").startsWith("text/x-component")) return result
      return { ...result, ...decodeActionResponse(body) }
    },
    /** Sube una foto de ubicación por la acción real. */
    uploadPhoto(session, location, bytes, { mime = "image/jpeg", declared = bytes.length } = {}) {
      return ctx.form("uploadLocationPhotoAction", { locationId: location.id, expectedVersion: location.version, mime, bytes: String(declared), file: new Blob([bytes], { type: mime }) }, session)
    },

    /** Biblioteca mínima: estantería predeterminada, otra estantería y tres ejemplares con estados distintos. */
    async library(owner) {
      const [shelf] = await sql`insert into biblib.shelves (user_id, title, is_default) values (${owner}, 'Principal', true) returning id`
      const [other] = await sql`insert into biblib.shelves (user_id, title) values (${owner}, ${ctx.label("Ensayo")}) returning id`
      const books = []
      for (const [index, title] of ["primero", "segundo", "tercero"].entries()) {
        const [row] = await sql`insert into biblib.books (user_id, isbn, title, authors, shelf_id, status, catalogue)
          values (${owner}, ${`manual-pro03-${run}-${++sequence}`}, ${ctx.label(title)}, ${sql.json([{ name: `Autora ${title}` }])}, ${index === 2 ? other.id : shelf.id},
            ${["unread", "reading", "read"][index]}, ${sql.json({ source: "manual", isbnVerified: false })}) returning id`
        books.push(row.id)
      }
      return { shelf: shelf.id, other: other.id, books }
    },

    /** Lo que ninguna acción de ubicaciones puede cambiar de un ejemplar: estantería, estado y versiones. */
    async copyState(owner) {
      return [...await sql`select c.id, c.shelf_id, c.status, c.version, b.version as flat_version from biblib.copies as c
        join biblib.books as b on b.user_id = c.user_id and b.id = c.id where c.user_id = ${owner} order by c.id`].map((row) => ({ ...row }))
    },
    async locations(owner) {
      return [...await sql`select id, parent_id, name, kind, photo_asset_id from biblib.locations where user_id = ${owner} order by name, id`].map((row) => ({ ...row }))
    },
    async copyLocations(owner) {
      return [...await sql`select copy_id, location_id, shelf_label, position from biblib.copy_locations where user_id = ${owner} order by copy_id`].map((row) => ({ ...row }))
    },
    async mediaAssets(owner) {
      return [...await sql`select id, kind, state, storage_key, sha256, bytes from biblib.media_assets where user_id = ${owner} order by created_at, id`].map((row) => ({ ...row }))
    },
    /** Objetos del dueño en el bucket (vista administrativa, solo para comprobar). */
    async objects(owner, kind = "location") {
      const { data } = await admin.storage.from(MEDIA_BUCKET).list(`${owner}/${kind}`, { limit: 100 })
      return (data ?? []).map((object) => `${owner}/${kind}/${object.name}`)
    },
    async download(key) {
      const { data, error } = await admin.storage.from(MEDIA_BUCKET).download(key)
      if (error || !data) return null
      return Buffer.from(await data.arrayBuffer())
    },

    /** Retira objetos y cuentas del run (la cascada de auth.users retira sus filas) y sus marcas de supresión. */
    async cleanup() {
      for (const owner of created) {
        for (const kind of ["avatar", "location", "evidence"]) {
          const keys = await ctx.objects(owner, kind)
          if (keys.length) await admin.storage.from(MEDIA_BUCKET).remove(keys)
        }
        await admin.auth.admin.deleteUser(owner)
        await sql`delete from biblib.account_deletions where user_id = ${owner}`
        await sql`delete from biblib.account_lifecycle where user_id = ${owner}`.catch(() => undefined)
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

/** Código de error de una acción `ActionResult` fallida (o el estado HTTP si no llegó a ejecutarse). */
export function errorCode(result) {
  if (result.status !== 200) return `HTTP ${result.status}`
  return result.value?.ok === false ? result.value.error.code : result.thrown ? "THROWN" : "OK"
}

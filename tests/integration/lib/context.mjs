import { readFileSync } from "node:fs"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"
import { BiblibError, EXIT } from "../../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../../scripts/lib/profiles.mjs"
import { ASSET, BUCKET, loadCensus, resolveSeedTarget } from "../../../scripts/db/seed-local.mjs"
import { fixtureId, readFixtureStore } from "../../../scripts/db/fixture-store.mjs"
import { closeConnection, connect } from "../../../scripts/db/target.mjs"

// Contexto compartido de la suite U-QA-01. Solo el perfil test; las credenciales administrativas
// locales quedan en este proceso de pruebas y nunca se pasan a Next ni a la salida.
export const PROFILE = "test"
export const RUN_MARKER = "QA-01"
export { ASSET, BUCKET }

export function runId() {
  const id = process.env.BIBLIB_INTEGRATION_RUN_ID
  if (!id || !/^[0-9a-f]{12}$/.test(id)) throw new BiblibError(EXIT.INVALID_ARGS, "suite", "Ejecuta la suite con pnpm test:integration:local; los archivos no se lanzan sueltos.")
  return id
}

export function runTitle(text) {
  return `[${RUN_MARKER} ${runId()}] ${text}`
}

export async function integrationContext() {
  if (process.env.BIBLIB_PROFILE && process.env.BIBLIB_PROFILE !== PROFILE) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "La integración local solo usa el perfil test.")
  const resolved = await resolveSeedTarget(PROFILE)
  const census = loadCensus()
  const store = readFixtureStore(resolved, census)
  if (!store?.accounts?.a?.id || !store?.accounts?.b?.id || store.phase !== "completado") throw new BiblibError(EXIT.SEED_FAILED, "suite", "Faltan fixtures A/B completos; ejecuta pnpm db:seed:local --profile test.")
  const env = resolved.target.env()
  const app = resolved.stack.profile.app
  return {
    resolved, census, store, env,
    root: resolved.stack.root,
    ports: resolved.stack.profile.ports,
    projectId: resolved.stack.profile.projectId,
    appUrl: `http://${app.host}:${app.port}`,
    users: { a: store.accounts.a.id, b: store.accounts.b.id },
  }
}

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

export function adminClient(ctx) {
  if (!ctx.env.SUPABASE_SERVICE_ROLE_KEY) throw new BiblibError(EXIT.SEED_FAILED, "suite", "Falta la credencial administrativa local del perfil.")
  return createClient(ctx.env.SUPABASE_URL, ctx.env.SUPABASE_SERVICE_ROLE_KEY, clientOptions)
}

export function anonClient(ctx, accessToken) {
  const options = accessToken ? { ...clientOptions, global: { headers: { Authorization: `Bearer ${accessToken}` } } } : clientOptions
  return createClient(ctx.env.SUPABASE_URL, ctx.env.SUPABASE_ANON_KEY, options)
}

/** Conexión administrativa dedicada (una sola, como la de la app) para preparar y comprobar. */
export function database(ctx, applicationName = "biblib-integration") {
  return connect(ctx.resolved, { applicationName })
}

export { closeConnection }

/** Estado real de las bibliotecas fixture: IDs derivados del censo y filas de Postgres. */
export async function fixtureLibrary(ctx, sql) {
  const result = {}
  for (const account of ctx.census.accounts) {
    const userId = ctx.users[account.key]
    const books = await sql`select id, title, version, shelf_id, status, user_id from biblib.books where user_id = ${userId} order by id`
    const shelves = await sql`select id, title, is_default from biblib.shelves where user_id = ${userId} order by id`
    const fixtureBooks = account.books.map((book) => fixtureId(ctx.census.censusId, userId, "book", book.fixtureKey))
    const missing = fixtureBooks.filter((id) => !books.some((row) => row.id === id))
    if (missing.length) throw new BiblibError(EXIT.SEED_FAILED, "suite", `Faltan ${missing.length} libro(s) fixture de ${account.key.toUpperCase()}; repite pnpm db:seed:local --profile test.`)
    const defaultShelf = shelves.find((shelf) => shelf.is_default)
    result[account.key] = {
      userId, books, shelves, fixtureBooks,
      defaultShelf: defaultShelf.id,
      customShelves: shelves.filter((shelf) => !shelf.is_default).map((shelf) => shelf.id),
      book: (fixtureKey) => books.find((row) => row.id === fixtureId(ctx.census.censusId, userId, "book", fixtureKey)),
    }
  }
  return result
}

export function defaultCoverBytes() {
  return readFileSync(path.join(REPO_ROOT, "public/default-book-cover.webp"))
}

import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { BiblibError, EXIT } from "../../../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../../../scripts/lib/profiles.mjs"
import { loadCensus, resolveSeedTarget } from "../../../../scripts/db/seed-local.mjs"
import { readFixtureStore } from "../../../../scripts/db/fixture-store.mjs"
import { closeConnection, connect } from "../../../../scripts/db/target.mjs"
import { callAction, loadActions } from "../../lib/app.mjs"
import { signInFixture } from "../../support/session.mjs"

// Contexto del grupo snapshots (U-DAT-02): Postgres, GoTrue y app reales del perfil scratch o test,
// cuentas A/B del seed y el publicador compilado para inyectar fallos dentro de su transacción.
// Reemplazar o restaurar sustituye la biblioteca ficticia de A: se guarda antes en .biblib y se
// devuelve exactamente igual al terminar cada prueba (también tras una caída del proceso anterior).

export const PROFILES = ["scratch", "test"]
export const MARKER = "DAT-02"
export const DEFAULT_COVER = "/default-book-cover.webp"
const require = createRequire(import.meta.url)

export function snapshotsProfile() {
  const profile = process.env.BIBLIB_PROFILE || "test"
  if (!PROFILES.includes(profile)) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo snapshots solo usa los perfiles scratch o test.")
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo snapshots solo admite BIBLIB_TARGET=local.")
  return profile
}

export function runId() {
  const id = process.env.BIBLIB_SNAPSHOTS_RUN_ID || process.env.BIBLIB_INTEGRATION_RUN_ID
  if (!id || !/^[0-9a-f]{12}$/.test(id)) throw new BiblibError(EXIT.INVALID_ARGS, "suite", "Ejecuta el grupo con pnpm test:integration:snapshots o pnpm test:integration:local.")
  return id
}

/** Publicador y esquema compilados por tsconfig.tests.json (los mismos módulos que usa la app). */
export function compiled() {
  const build = path.join(REPO_ROOT, ".next", "tests", "lib")
  // Dentro de test:integration:local nadie compila las pruebas TS: se compila si falta o es anterior al código.
  const output = path.join(build, "library-snapshots.js")
  const sources = ["lib/import-publisher.ts", "lib/library-snapshots.ts", "lib/db/schema.ts"].map((file) => statSync(path.join(REPO_ROOT, file)).mtimeMs)
  if (!existsSync(output) || statSync(output).mtimeMs < Math.max(...sources)) {
    execFileSync(process.execPath, [path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.tests.json"], { cwd: REPO_ROOT, stdio: "ignore", windowsHide: true })
  }
  return { publisher: require(path.join(build, "import-publisher.js")), schema: require(path.join(build, "db", "schema.js")) }
}

export async function snapshotsContext() {
  const profile = snapshotsProfile()
  const resolved = await resolveSeedTarget(profile)
  const store = readFixtureStore(resolved, loadCensus())
  if (!store?.accounts?.a?.id || !store?.accounts?.b?.id || store.phase !== "completado") throw new BiblibError(EXIT.SEED_FAILED, "suite", `Faltan fixtures A/B completos; ejecuta pnpm db:seed:local --profile ${profile}.`)
  const sql = connect(resolved, { applicationName: "biblib-snapshots-tests" })
  const appConfig = resolved.stack.profile.app
  const users = { a: store.accounts.a.id, b: store.accounts.b.id }
  const run = runId()
  const savedFile = path.join(REPO_ROOT, ".biblib", "integration", `snapshots-${profile}-biblioteca.json`)
  let sequence = 0
  // Conexión propia para Drizzle: su driver ajusta los parsers del cliente y no debe afectar a `sql`.
  let publisherSql
  const created = { previews: [] }
  const ctx = {
    profile, resolved, sql, users, run,
    app: { url: `http://${appConfig.host}:${appConfig.port}`, actions: loadActions(resolved.stack.root) },
    title: (text) => `[${MARKER} ${run}] ${text}`,
    key: (label) => `dat02-${run}-${label}-${++sequence}-${randomBytes(3).toString("hex")}`.slice(0, 120),
    async signIn(as) { return signInFixture(as, { profile }) },
    cookies(session) { return session.cookies().filter((cookie) => cookie.value !== "").map(({ name, value }) => ({ name, value })) },
    call(name, args, session) { return callAction(ctx.app, name, args, { cookies: ctx.cookies(session) }) },
    /** Ejecuta SQL con el rol authenticated y los claims del dueño, como una sesión real de la app. */
    asUser(userId, work) {
      return sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${userId}, true)`
        await tx`set local role authenticated`
        return work(tx)
      })
    },
    /** Transacción Drizzle en el contexto RLS del dueño, igual que withRlsContext de la app. */
    async asOwnerDrizzle(userId, work) {
      const { drizzle } = require("drizzle-orm/postgres-js")
      const { sql: q } = require("drizzle-orm")
      publisherSql ??= connect(resolved, { applicationName: "biblib-snapshots-publisher" })
      const db = drizzle(publisherSql, { schema: compiled().schema })
      return db.transaction(async (tx) => {
        await tx.execute(q`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${userId}, true)`)
        await tx.execute(q`set local role authenticated`)
        return work(tx)
      })
    },
    async revision(userId) { return (await sql`select revision from biblib.library_state where user_id = ${userId}`)[0]?.revision },
    async library(userId) {
      const shelves = await sql`select id, title, is_default from biblib.shelves where user_id = ${userId} order by id`
      const books = await sql`select id, version, isbn, title, subtitle, authors, publishers, catalogue, number_of_pages, publish_date, cover_small, cover_medium, cover_large, status, shelf_id, created_at from biblib.books where user_id = ${userId} order by id`
      return { shelves: [...shelves], books: [...books] }
    },
    async snapshots(userId) { return [...await sql`select * from biblib.library_snapshots where user_id = ${userId} order by created_at, id`] },
    async chunks(snapshotId) { return [...await sql`select seq, kind, item_count, digest, payload, digest = encode(sha256(convert_to(payload::text, 'UTF8')), 'hex') as valid from biblib.library_snapshot_chunks where snapshot_id = ${snapshotId} order by seq`] },
    async operations(userId, operation) { return [...await sql`select id, preview_id, idempotency_key, result from biblib.library_operations where user_id = ${userId} and operation = ${operation} and idempotency_key like ${`dat02-${run}-%`}`] },
    /** Archivo legacy pequeño con identificadores manuales: preparar y publicar no consultan la red. */
    importFile(tag, count = 2) {
      const shelfId = `estante-${tag}`, shelfTitle = ctx.title(`Importación ${tag}`)
      return {
        shelves: [{ id: shelfId, title: shelfTitle, book_count: count }],
        books: Array.from({ length: count }, (_, index) => ({
          id: `libro-${tag}-${index}`, isbn: `manual-dat02-${run}-${tag}-${index}`, title: ctx.title(`Importado ${tag} ${index}`), authors: [],
          number_of_pages: 10, publish_date: "", cover: { small: DEFAULT_COVER, medium: DEFAULT_COVER, large: DEFAULT_COVER }, status: "unread", shelf_id: shelfId, shelf_name: shelfTitle,
        })),
      }
    },
    async prepare(session, file, mode = "replace") {
      const result = await ctx.call("prepareImportAction", [file, mode], session)
      if (result.status !== 200 || result.value?.ok !== true) throw new Error(`La preparación falló (${result.value?.error?.code ?? result.status}).`)
      created.previews.push(result.value.value.previewId)
      return result.value.value
    },
    /** Reemplaza la biblioteca de la cuenta con un archivo marcado y devuelve la confirmación. */
    async replace(session, tag, count = 2) {
      const prepared = await ctx.prepare(session, ctx.importFile(tag, count), "replace")
      const confirmed = await ctx.call("confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: ctx.key(tag) }], session)
      return { prepared, confirmed }
    },
    /** Llena la cuota con versiones capturadas por el protocolo (una operación por transacción). */
    async fillQuota(userId, until = 10) {
      for (let used = (await ctx.snapshots(userId)).length; used < until; used++) {
        await ctx.asUser(userId, async (tx) => {
          const [operation] = await tx`insert into biblib.library_operations (user_id, operation, idempotency_key, input_digest, status, result)
            values (${userId}, 'import.confirm', ${ctx.key("cuota")}, ${"c".repeat(64)}, 'committed', '{}'::jsonb) returning id`
          await tx`select biblib.library_snapshot_capture(${operation.id}, 'import.replace')`
        })
      }
    },
    /** Guarda la biblioteca de A y B (fichas, IDs y fechas) antes de una operación destructiva. */
    async saveLibraries() {
      const saved = { profile, users: {} }
      for (const userId of [users.a, users.b]) {
        saved.users[userId] = {
          shelves: (await sql`select to_jsonb(s) as row from biblib.shelves s where s.user_id = ${userId} order by s.id`).map((r) => r.row),
          books: (await sql`select to_jsonb(b) as row from biblib.books b where b.user_id = ${userId} order by b.id`).map((r) => r.row),
        }
      }
      mkdirSync(path.dirname(savedFile), { recursive: true, mode: 0o700 })
      writeFileSync(savedFile, JSON.stringify(saved), { mode: 0o600 })
      return saved
    },
    /** Devuelve A y B exactamente a lo guardado y retira todo lo que el run creó. */
    async restoreLibraries() {
      if (!existsSync(savedFile)) return false
      const saved = JSON.parse(readFileSync(savedFile, "utf8"))
      await sql.begin(async (tx) => {
        for (const [userId, library] of Object.entries(saved.users)) {
          if (![users.a, users.b].includes(userId)) continue
          await tx`delete from biblib.books where user_id = ${userId}`
          await tx`delete from biblib.shelves where user_id = ${userId} and not is_default`
          const defaults = library.shelves.filter((shelf) => shelf.is_default)
          const [current] = await tx`select id from biblib.shelves where user_id = ${userId} and is_default`
          if (defaults[0] && current?.id !== defaults[0].id) {
            await tx`delete from biblib.shelves where user_id = ${userId} and is_default`
            await tx`insert into biblib.shelves select * from jsonb_populate_recordset(null::biblib.shelves, ${tx.json(defaults)})`
          }
          const custom = library.shelves.filter((shelf) => !shelf.is_default)
          if (custom.length) await tx`insert into biblib.shelves select * from jsonb_populate_recordset(null::biblib.shelves, ${tx.json(custom)})`
          if (library.books.length) await tx`insert into biblib.books select * from jsonb_populate_recordset(null::biblib.books, ${tx.json(library.books)})`
        }
      })
      rmSync(savedFile, { force: true })
      return true
    },
    async cleanup() {
      const owners = [users.a, users.b]
      await sql`delete from biblib.account_lifecycle where user_id in ${sql(owners)}`
      // Versiones del run: las de sus operaciones y las de la cuota de prueba; después, sus operaciones.
      await sql`delete from biblib.library_snapshots where user_id in ${sql(owners)} and source_operation_id in (select id from biblib.library_operations where user_id in ${sql(owners)} and idempotency_key like ${`dat02-${run}-%`})`
      await sql`delete from biblib.library_jobs where user_id in ${sql(owners)} and idempotency_key like ${`dat02-${run}-%`}`
      await sql`delete from biblib.library_operations where user_id in ${sql(owners)} and idempotency_key like ${`dat02-${run}-%`}`
      // Las vistas previas de restauración caen con sus versiones; las de importación se borran por ID.
      if (created.previews.length) await sql`delete from biblib.import_previews where user_id in ${sql(owners)} and id in ${sql(created.previews)}`
      created.previews = []
    },
    async close() { await closeConnection(publisherSql); await closeConnection(sql) },
  }
  return ctx
}

/** `sql` de Drizzle para consultar dentro de la transacción del publicador compilado. */
export const drizzleSql = require("drizzle-orm").sql

export const ok = (result) => result.status === 200 && result.value?.ok === true
export const failed = (result, code) => result.status === 200 && result.value?.ok === false && result.value.error.code === code

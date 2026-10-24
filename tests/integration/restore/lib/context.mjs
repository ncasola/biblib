import { execFileSync } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { BiblibError, EXIT } from "../../../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../../../scripts/lib/profiles.mjs"
import { loadCensus, resolveSeedTarget } from "../../../../scripts/db/seed-local.mjs"
import { readFixtureStore } from "../../../../scripts/db/fixture-store.mjs"
import { closeConnection, connect } from "../../../../scripts/db/target.mjs"
import { callAction, cookieHeader, decodeActionResponse, loadActions } from "../../lib/app.mjs"
import { signInFixture } from "../../support/session.mjs"

// Contexto del grupo restore (U-DAT-04): Postgres, GoTrue y app reales del perfil scratch o test,
// cuentas A/B del seed, copias por partes generadas con el código real de exportación y el
// publicador compilado para inyectar fallos. Restaurar sustituye la biblioteca ficticia de A: se
// guarda antes en .biblib y se devuelve exactamente igual al terminar cada prueba.

export const PROFILES = ["scratch", "test"]
export const MARKER = "DAT-04"
export const DEFAULT_COVER = "/default-book-cover.webp"
export const CHUNK = 256 * 1024
const require = createRequire(import.meta.url)
export const sha256 = (data) => createHash("sha256").update(data).digest("hex")

export function restoreProfile() {
  const profile = process.env.BIBLIB_PROFILE || "test"
  if (!PROFILES.includes(profile)) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo restore solo usa los perfiles scratch o test.")
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo restore solo admite BIBLIB_TARGET=local.")
  return profile
}

export function runId() {
  const id = process.env.BIBLIB_RESTORE_RUN_ID || process.env.BIBLIB_INTEGRATION_RUN_ID
  if (!id || !/^[0-9a-f]{12}$/.test(id)) throw new BiblibError(EXIT.INVALID_ARGS, "suite", "Ejecuta el grupo con pnpm test:integration:restore o pnpm test:integration:local.")
  return id
}

/** Módulos compilados por tsconfig.tests.json (los mismos que usa la app). */
export function compiled() {
  const build = path.join(REPO_ROOT, ".next", "tests", "lib")
  const output = path.join(build, "import-staging.js")
  const sources = ["lib/import-staging.ts", "lib/import-manifest.ts", "lib/library-export.ts", "lib/import-publisher.ts", "lib/db/schema.ts"].map((file) => statSync(path.join(REPO_ROOT, file)).mtimeMs)
  if (!existsSync(output) || statSync(output).mtimeMs < Math.max(...sources)) {
    execFileSync(process.execPath, [path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.tests.json"], { cwd: REPO_ROOT, stdio: "ignore", windowsHide: true })
  }
  return {
    staging: require(path.join(build, "import-staging.js")),
    manifest: require(path.join(build, "import-manifest.js")),
    exporter: require(path.join(build, "library-export.js")),
    schema: require(path.join(build, "db", "schema.js")),
  }
}

/**
 * Server Action con un Blob, como la serializa React en el navegador: multipart con el modelo en
 * el campo «0» y el Blob como referencia `$B1`. Nada de base64.
 */
export async function callActionWithBlob(app, name, input, blob, { cookies = [] } = {}) {
  const action = app.actions.get(name)
  if (!action) throw new BiblibError(EXIT.VERIFICATION_FAILED, "app", `La acción ${name} no está en el build.`)
  const form = new FormData()
  form.append("1", blob)
  form.append("0", JSON.stringify([{ ...input, chunk: "$B1" }]))
  const response = await fetch(`${app.url}${action.route}`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
    headers: { "Next-Action": action.id, Accept: "text/x-component", Origin: app.url, Cookie: cookieHeader(cookies) }, body: form,
  })
  const body = Buffer.from(await response.arrayBuffer())
  const result = { status: response.status, value: undefined, thrown: false }
  if (response.status !== 200 || !(response.headers.get("content-type") ?? "").startsWith("text/x-component")) return result
  return { ...result, ...decodeActionResponse(body) }
}

export const ok = (result) => result.status === 200 && result.value?.ok === true
export const failed = (result, code) => result.status === 200 && result.value?.ok === false && result.value.error.code === code

export async function restoreContext() {
  const profile = restoreProfile()
  const resolved = await resolveSeedTarget(profile)
  const store = readFixtureStore(resolved, loadCensus())
  if (!store?.accounts?.a?.id || !store?.accounts?.b?.id || store.phase !== "completado") throw new BiblibError(EXIT.SEED_FAILED, "suite", `Faltan fixtures A/B completos; ejecuta pnpm db:seed:local --profile ${profile}.`)
  const sql = connect(resolved, { applicationName: "biblib-restore-tests" })
  const appConfig = resolved.stack.profile.app
  const users = { a: store.accounts.a.id, b: store.accounts.b.id }
  const run = runId()
  const savedFile = path.join(REPO_ROOT, ".biblib", "integration", `restore-${profile}-biblioteca.json`)
  const [{ started }] = await sql`select now() as started`
  let sequence = 0
  let publisherSql
  const modules = compiled()
  const ctx = {
    profile, resolved, sql, users, run, modules,
    app: { url: `http://${appConfig.host}:${appConfig.port}`, actions: loadActions(resolved.stack.root) },
    title: (text) => `[${MARKER} ${run}] ${text}`,
    key: (label) => `dat04-${run}-${label}-${++sequence}-${randomBytes(3).toString("hex")}`.slice(0, 120),
    async signIn(as) { return signInFixture(as, { profile }) },
    cookies(session) { return session.cookies().filter((cookie) => cookie.value !== "").map(({ name, value }) => ({ name, value })) },
    call(name, args, session) { return callAction(ctx.app, name, args, { cookies: session ? ctx.cookies(session) : [] }) },
    upload(session, input, bytes) { return callActionWithBlob(ctx.app, "uploadRestorePartAction", { ...input, sha256: input.sha256 ?? sha256(bytes) }, new Blob([bytes]), { cookies: ctx.cookies(session) }) },

    /** Biblioteca ficticia marcada: `count` libros repartidos entre estanterías (y vacías) con IDs nuevos. */
    library(tag, count, { shelves = 2, empty = 0 } = {}) {
      const shelfRows = [{ id: randomUUID(), title: ctx.title(`${tag} predeterminada`), book_count: 0, isDefault: true },
        ...Array.from({ length: shelves - 1 + empty }, (_, index) => ({ id: randomUUID(), title: ctx.title(`${tag} estante ${index + 1}`), book_count: 0 }))]
      const withBooks = shelfRows.slice(0, shelves)
      return {
        shelves: shelfRows,
        books: Array.from({ length: count }, (_, index) => ({
          id: randomUUID(), isbn: `manual-dat04-${run}-${tag}-${index}`, title: ctx.title(`${tag} libro ${String(index).padStart(5, "0")}`), authors: [{ name: "Autoría QA" }],
          number_of_pages: index % 500, publish_date: "2026", cover: { small: DEFAULT_COVER, medium: DEFAULT_COVER, large: DEFAULT_COVER }, status: "unread",
          shelf_id: withBooks[index % withBooks.length].id, shelf_name: "",
        })),
      }
    },
    /** Copia por partes real (los mismos bytes que se descargarían) con su manifest. */
    backupSet(library, exportedAt = new Date()) {
      const set = modules.exporter.buildBackupSet(library, { exportedAt, exportSetId: randomUUID(), sha256 })
      return { ...set, bytes: set.files.map((file) => Buffer.from(file.text, "utf8")), manifestObject: JSON.parse(set.manifestText) }
    },
    async begin(session, input) { return ctx.call("beginRestoreSessionAction", [input], session) },
    /** Sube todas las partes de una sesión en trozos de 256 KiB y devuelve el último recibo. */
    async uploadAll(session, view, parts) {
      let receipt
      for (const part of view.parts) {
        const bytes = parts[part.index]
        for (let ordinal = 0; ordinal < part.totalChunks; ordinal++) {
          receipt = await ctx.upload(session, { sessionId: view.sessionId, partId: part.partId, ordinal, total: part.totalChunks }, bytes.subarray(ordinal * CHUNK, (ordinal + 1) * CHUNK))
          if (!ok(receipt)) throw new Error(`La subida falló (${receipt.value?.error?.code ?? receipt.status}).`)
        }
      }
      return receipt
    },
    /** Inicia, sube, valida y prepara: devuelve sesión y vista previa. */
    async staged(session, set, { loose = false } = {}) {
      const begun = await ctx.begin(session, loose ? { parts: set.bytes.map((bytes) => ({ byteLength: bytes.byteLength, sha256: sha256(bytes) })) } : { manifest: set.manifestObject })
      if (!ok(begun)) throw new Error(`El inicio falló (${begun.value?.error?.code ?? begun.status}).`)
      const view = begun.value.value
      await ctx.uploadAll(session, view, set.bytes)
      const validated = await ctx.call("validateRestoreSessionAction", [{ sessionId: view.sessionId }], session)
      if (!ok(validated)) throw new Error(`La validación falló (${validated.value?.error?.code ?? validated.status}: ${validated.value?.error?.message ?? ""}).`)
      const prepared = await ctx.call("prepareRestoreSessionAction", [{ sessionId: view.sessionId }], session)
      if (!ok(prepared)) throw new Error(`La preparación falló (${prepared.value?.error?.code ?? prepared.status}).`)
      return { view, validated: validated.value.value, prepared: prepared.value.value }
    },
    commit(session, prepared, idempotencyKey) {
      return ctx.call("commitRestoreSessionAction", [{ sessionId: prepared.sessionId, previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey }], session)
    },

    /** Transacción Drizzle en el contexto RLS del dueño, igual que withRlsContext de la app. */
    async asOwnerDrizzle(userId, work) {
      const { drizzle } = require("drizzle-orm/postgres-js")
      const { sql: q } = require("drizzle-orm")
      publisherSql ??= connect(resolved, { applicationName: "biblib-restore-publisher" })
      const db = drizzle(publisherSql, { schema: modules.schema })
      return db.transaction(async (tx) => {
        await tx.execute(q`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${userId}, true)`)
        await tx.execute(q`set local role authenticated`)
        return work(tx)
      })
    },
    asUser(userId, work) {
      return sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${userId}, true)`
        await tx`set local role authenticated`
        return work(tx)
      })
    },
    async revision(userId) { return (await sql`select revision from biblib.library_state where user_id = ${userId}`)[0]?.revision },
    async libraryRows(userId) {
      const shelves = await sql`select id, title, is_default from biblib.shelves where user_id = ${userId} order by id`
      const books = await sql`select id, version, isbn, title, catalogue, status, shelf_id from biblib.books where user_id = ${userId} order by id`
      return { shelves: [...shelves], books: [...books] }
    },
    async session(sessionId) { return (await sql`select * from biblib.import_sessions where id = ${sessionId}`)[0] },
    async staging(sessionId) {
      const [row] = await sql`select (select count(*)::int from biblib.import_session_chunks where session_id = ${sessionId}) as chunks, (select count(*)::int from biblib.import_session_rows where session_id = ${sessionId}) as rows`
      return row
    },
    async snapshots(userId) { return [...await sql`select * from biblib.library_snapshots where user_id = ${userId} order by created_at, id`] },
    async operations(userId) { return [...await sql`select id, idempotency_key, result from biblib.library_operations where user_id = ${userId} and operation = 'restore.commit' and idempotency_key like ${`dat04-${run}-%`}`] },
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
    /** Devuelve A y B exactamente a lo guardado. */
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
      await sql`delete from biblib.library_snapshots where user_id in ${sql(owners)} and source_operation_id in (select id from biblib.library_operations where user_id in ${sql(owners)} and idempotency_key like ${`dat04-${run}-%`})`
      await sql`delete from biblib.library_operations where user_id in ${sql(owners)} and idempotency_key like ${`dat04-${run}-%`}`
      await sql`delete from biblib.import_previews where user_id in ${sql(owners)} and created_at >= ${started}`
      // Las sesiones de este run y su staging (las demás de A/B no se tocan).
      await sql`delete from biblib.import_sessions where user_id in ${sql(owners)} and created_at >= ${started}`
    },
    async close() { await closeConnection(publisherSql); await closeConnection(sql) },
  }
  return ctx
}

/** `sql` de Drizzle para consultar dentro de la transacción del publicador compilado. */
export const drizzleSql = require("drizzle-orm").sql

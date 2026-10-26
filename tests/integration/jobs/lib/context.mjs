import { spawn } from "node:child_process"
import { createHash, createHmac, randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { BiblibError, EXIT } from "../../../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../../../scripts/lib/profiles.mjs"
import { loadCensus, resolveSeedTarget } from "../../../../scripts/db/seed-local.mjs"
import { readFixtureStore } from "../../../../scripts/db/fixture-store.mjs"
import { closeConnection, connect } from "../../../../scripts/db/target.mjs"
import { callAction, loadActions } from "../../lib/app.mjs"
import { signInFixture } from "../../support/session.mjs"

// Contexto del grupo jobs (U-DAT-03): Postgres, GoTrue y app reales del perfil scratch o test,
// cuentas A/B del seed y procesos Node independientes que ejecutan el worker compilado con un fetch
// simulado. Ninguna prueba sale a Internet ni modifica los fixtures A/B: todo lo creado lleva la
// marca del run y se borra por ID y propietario.

export const PROFILES = ["scratch", "test"]
export const MARKER = "DAT-03"
const WORKER = fileURLToPath(new URL("./worker.mjs", import.meta.url))
export const DEFAULT_COVER = "/default-book-cover.webp"

export function jobsProfile() {
  const profile = process.env.BIBLIB_PROFILE || "test"
  if (!PROFILES.includes(profile)) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo jobs solo usa los perfiles scratch o test.")
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo jobs solo admite BIBLIB_TARGET=local.")
  return profile
}

export function runId() {
  const id = process.env.BIBLIB_JOBS_RUN_ID || process.env.BIBLIB_INTEGRATION_RUN_ID
  if (!id || !/^[0-9a-f]{12}$/.test(id)) throw new BiblibError(EXIT.INVALID_ARGS, "suite", "Ejecuta el grupo con pnpm test:integration:jobs o pnpm test:integration:local.")
  return id
}

export const sha256 = (text) => createHash("sha256").update(text).digest("hex")

/** ISBN-13 sintético válido (prefijo 979-0-0003, sin correspondencia con libros reales). */
export function fakeIsbn(n) {
  const body = `97900003${String(n).padStart(4, "0")}`
  const sum = [...body].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0)
  return `${body}${(10 - (sum % 10)) % 10}`
}

export async function jobsContext() {
  const profile = jobsProfile()
  const resolved = await resolveSeedTarget(profile)
  const store = readFixtureStore(resolved, loadCensus())
  if (!store?.accounts?.a?.id || !store?.accounts?.b?.id || store.phase !== "completado") throw new BiblibError(EXIT.SEED_FAILED, "suite", `Faltan fixtures A/B completos; ejecuta pnpm db:seed:local --profile ${profile}.`)
  const sql = connect(resolved, { applicationName: "biblib-jobs-tests" })
  const env = resolved.target.env()
  const appConfig = resolved.stack.profile.app
  const users = { a: store.accounts.a.id, b: store.accounts.b.id }
  const run = runId()
  const scope = `dat03-${randomBytes(5).toString("hex")}`
  const created = { books: [], jobs: [], previews: [], shelves: [] }
  let sequence = 0
  const ctx = {
    profile, resolved, sql, env, users, run, scope, created,
    app: { url: `http://${appConfig.host}:${appConfig.port}`, actions: loadActions(resolved.stack.root) },
    title: (text) => `[${MARKER} ${run}] ${text}`,
    key: (label) => `dat03-${run}-${label}-${++sequence}`.slice(0, 120),
    /** Token de la entrada interna derivado igual que el servidor (lib/jobs/runner-auth.ts). */
    runnerToken: () => createHmac("sha256", env.SUPABASE_DB_URL).update("biblib.jobs.runner.v1").digest("base64url"),
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
    async defaultShelf(userId) {
      return (await sql`select id from biblib.shelves where user_id = ${userId} and is_default`)[0].id
    },
    /** Libros marcados con portada genérica e ISBN sintético en la estantería predeterminada. */
    async createBooks(userId, isbns) {
      const shelf = await ctx.defaultShelf(userId)
      const rows = []
      for (const isbn of isbns) {
        const [row] = await sql`insert into biblib.books (user_id, isbn, title, status, shelf_id) values (${userId}, ${isbn}, ${ctx.title(`Libro ${isbn}`)}, 'unread', ${shelf}) returning id, version`
        created.books.push({ id: row.id, userId })
        rows.push({ ...row, isbn })
      }
      return rows
    },
    async createCoverJob(userId, label = "portadas") {
      const key = ctx.key(label)
      const result = await ctx.asUser(userId, (tx) => tx`select biblib.library_job_create('covers', ${key}, ${sha256(key)}, null, null) as r`)
      const value = result[0].r
      if (value.status !== "created") throw new Error(`No se creó el trabajo de portadas (${value.status}).`)
      created.jobs.push(value.id)
      return value.id
    },
    /** Trabajo de importación creado sin la app (ningún ejecutor en segundo plano lo toca). */
    async createImportJob(userId, previewId, idempotencyKey) {
      const [preview] = await sql`select input_digest, mode, rules_version, revision from biblib.import_previews where id = ${previewId} and user_id = ${userId}`
      const digest = sha256(JSON.stringify({ inputDigest: preview.input_digest, mode: preview.mode, operation: "import.confirm", rulesVersion: preview.rules_version }))
      const result = await ctx.asUser(userId, (tx) => tx`select biblib.library_job_create('import', ${idempotencyKey}, ${digest}, ${previewId}, ${preview.revision}) as r`)
      const value = result[0].r
      if (!["created", "existing"].includes(value.status)) throw new Error(`No se creó el trabajo de importación (${value.status}).`)
      created.jobs.push(value.id)
      return value.id
    },
    async job(id) { return (await sql`select * from biblib.library_jobs where id = ${id}`)[0] },
    async items(id) { return sql`select item_key, state, attempts, error_code, fencing_number, result from biblib.library_job_items where job_id = ${id} order by item_key` },
    async book(id) { return (await sql`select id, version, cover_small, cover_medium, cover_large from biblib.books where id = ${id}`)[0] },
    async markedBooks(userId, label) { return sql`select id, isbn, title from biblib.books where user_id = ${userId} and title like ${`${ctx.title(label)}%`} order by title` },
    /** Archivo legacy pequeño con identificadores manuales: preparar la importación no consulta la red. */
    importFile(tag, count = 3) {
      const shelfId = `estante-${tag}`, shelfTitle = ctx.title(`Importación ${tag}`)
      return {
        shelves: [{ id: shelfId, title: shelfTitle, book_count: count }],
        books: Array.from({ length: count }, (_, index) => ({
          id: `libro-${tag}-${index}`, isbn: `manual-dat03-${run}-${tag}-${index}`, title: ctx.title(`Importado ${tag} ${index}`), authors: [],
          number_of_pages: 10, publish_date: "", cover: { small: DEFAULT_COVER, medium: DEFAULT_COVER, large: DEFAULT_COVER }, status: "unread", shelf_id: shelfId, shelf_name: shelfTitle,
        })),
      }
    },
    async prepare(session, userId, file, mode = "merge") {
      const result = await ctx.call("prepareImportAction", [file, mode], session)
      if (result.status !== 200 || result.value?.ok !== true) throw new Error(`La preparación falló (${result.value?.error?.code ?? result.status}).`)
      created.previews.push({ id: result.value.value.previewId, userId })
      return result.value.value
    },
    /** Libros y estanterías de una importación del run, para limpiarlos por ID y propietario. */
    async recordImported(userId) {
      for (const row of await sql`select id from biblib.books where user_id = ${userId} and title like ${`[${MARKER} ${run}]%`}`) if (!created.books.some((b) => b.id === row.id)) created.books.push({ id: row.id, userId })
      for (const row of await sql`select id from biblib.shelves where user_id = ${userId} and title like ${`[${MARKER} ${run}]%`} and not is_default`) if (!created.shelves.some((s) => s.id === row.id)) created.shelves.push({ id: row.id, userId })
    },
    async waitFor(check, { timeoutMs = 30_000, intervalMs = 250, message = "condición" } = {}) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const value = await check()
        if (value) return value
        if (Date.now() > deadline) throw new Error(`Tiempo agotado esperando: ${message}.`)
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
    },
    async cleanup() {
      // Sin fila, la cuenta está activa: es el estado de partida de los fixtures A/B.
      await sql`delete from biblib.account_lifecycle where user_id in (${users.a}, ${users.b})`
      if (created.jobs.length) await sql`delete from biblib.library_jobs where id in ${sql(created.jobs)} and user_id in (${users.a}, ${users.b})`
      // Trabajos que creó la app durante el run (acciones por HTTP) con la clave marcada.
      await sql`delete from biblib.library_jobs where user_id in (${users.a}, ${users.b}) and idempotency_key like ${`dat03-${run}-%`}`
      for (const { id, userId } of created.books) await sql`delete from biblib.books where id = ${id} and user_id = ${userId} and title like ${`[${MARKER} %`}`
      for (const { id, userId } of created.shelves) await sql`delete from biblib.shelves where id = ${id} and user_id = ${userId} and title like ${`[${MARKER} %`} and not is_default`
      for (const { id, userId } of created.previews) {
        await sql`delete from biblib.library_operations where preview_id = ${id} and user_id = ${userId}`
        await sql`delete from biblib.import_previews where id = ${id} and user_id = ${userId}`
      }
      await sql`delete from biblib.catalogue_cache where credential_scope like 'dat03-%'`
      await sql`delete from biblib.catalogue_inflight where credential_scope like 'dat03-%'`
      await sql`delete from biblib.catalogue_quota_buckets where credential_scope like 'dat03-%'`
      created.books = []; created.jobs = []; created.previews = []; created.shelves = []
    },
    async close() { await closeConnection(sql) },
  }
  return ctx
}

/**
 * Lanza un proceso Node distinto con el worker compilado. La URL de la base viaja por variable de
 * entorno y nunca se imprime; el hijo responde con una línea JSON (o muere a propósito con 137).
 */
export function runWorker(ctx, task) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, BIBLIB_JOBS_TEST_DB_URL: ctx.env.SUPABASE_DB_URL }
    const child = spawn(process.execPath, [WORKER, JSON.stringify({ scope: ctx.scope, ...task })], { cwd: REPO_ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { err += chunk })
    const timer = setTimeout(() => child.kill(), 90_000)
    child.once("error", reject)
    child.once("close", (code) => {
      clearTimeout(timer)
      const lines = out.trim().split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
      const last = lines.at(-1)
      if (!last) { reject(new Error(`El proceso de prueba no devolvió JSON (código ${code}): ${err.split("\n").slice(0, 4).join(" ").slice(0, 400)}`)); return }
      resolve({ code, ...last })
    })
  })
}

export const startAt = (delayMs = 1500) => Date.now() + delayMs
export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

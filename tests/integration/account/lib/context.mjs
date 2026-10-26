import { createHash, randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import { createDeletionDatabase, processDeletion } from "../../../../lib/account-deletion/worker.ts"
import { createSupabaseDeletionServices } from "../../../../scripts/account/deletion-services.mjs"
import { BiblibError, EXIT } from "../../../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../../../scripts/lib/profiles.mjs"
import { resolveSeedTarget } from "../../../../scripts/db/seed-local.mjs"
import { closeConnection, connect } from "../../../../scripts/db/target.mjs"
import { callAction, loadActions } from "../../lib/app.mjs"

// Contexto del grupo account (U-OPS-03): Postgres, GoTrue, Storage y la app compilada del perfil scratch o test. Cada
// prueba crea cuentas desechables `ops03-<run>-…@biblib.test` con su biblioteca (varios ejemplares, portadas privadas
// con sus objetos, vista, versión anterior, trabajo en vuelo y caché privada) y sesiones GoTrue reales; el worker es
// el motor real de lib/account-deletion con sus adaptadores. Al terminar no queda ninguna cuenta ni marca del run.
export const PROFILES = ["scratch", "test"]
export const BUCKET = "biblib-covers"
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
const COVER = readFileSync(path.join(REPO_ROOT, "public", "default-book-cover.webp"))

export function runId() {
  const id = process.env.BIBLIB_ACCOUNT_RUN_ID || process.env.BIBLIB_INTEGRATION_RUN_ID
  if (!id || !/^[0-9a-f]{12}$/.test(id)) throw new BiblibError(EXIT.INVALID_ARGS, "suite", "Ejecuta el grupo con pnpm test:integration:account o pnpm test:integration:local.")
  return id
}

export async function accountContext() {
  const profile = process.env.BIBLIB_PROFILE || "test"
  if (!PROFILES.includes(profile)) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo account solo usa los perfiles scratch o test.")
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo account solo admite BIBLIB_TARGET=local.")
  const run = runId()
  const resolved = await resolveSeedTarget(profile)
  const env = resolved.target.env()
  const sql = connect(resolved, { applicationName: "biblib-account-tests" })
  const workerSql = connect(resolved, { applicationName: "biblib-account-worker" })
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, clientOptions)
  const { host, port } = resolved.stack.profile.app
  const app = { url: `http://${host}:${port}`, actions: loadActions(resolved.stack.root) }
  const created = []
  let sequence = 0

  const ctx = {
    profile, run, resolved, env, sql, admin, app,
    key: (label = "op") => `ops03-${label}-${randomUUID().replaceAll("-", "")}`.slice(0, 64),

    /** Cuenta desechable con contraseña aleatoria; se registra para retirarla al terminar. */
    async account(label) {
      const email = `ops03-${run}-${label}-${++sequence}@biblib.test`
      const password = randomBytes(24).toString("base64url")
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { biblib_ops03: run } })
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
      if (error || !data.session) return { error }
      return { client, session: data.session, cookies: () => [...jar.values()].filter((cookie) => cookie.value !== "").map(({ name, value }) => ({ name, value })) }
    },
    call(name, args, session) { return callAction(app, name, args, { cookies: session ? session.cookies() : [] }) },
    /** Clientes con el JWT de la sesión: lo mismo que puede hacer el navegador con su token, fuera de la app. */
    storageAs(session) { return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { ...clientOptions, global: { headers: { Authorization: `Bearer ${session.session.access_token}` } } }).storage.from(BUCKET) },
    rest(session, table, { method = "GET", body } = {}) {
      return fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
        method, signal: AbortSignal.timeout(10_000), body: body ? JSON.stringify(body) : undefined,
        headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${session.session.access_token}`, "Content-Type": "application/json", [method === "GET" ? "Accept-Profile" : "Content-Profile"]: "biblib", Prefer: "return=minimal" },
      })
    },
    /** Transacción con los claims del dueño, como withRlsContext de la app. */
    asUser(userId, work) {
      return sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${userId}, true)`
        await tx`set local role authenticated`
        return work(tx)
      })
    },

    /**
     * Biblioteca de la cuenta: dos estanterías, tres ejemplares (dos de la misma edición), dos portadas privadas con su
     * objeto en Storage, una vista, una versión anterior con un trozo, un trabajo de portadas en vuelo (lease vigente) y
     * una fila de caché privada. Todo por SQL administrativo y la API de Storage con la credencial de servicio.
     */
    async library(owner) {
      const [shelf] = await sql`insert into biblib.shelves (user_id, title, is_default) values (${owner}, 'Principal', true) returning id`
      const [other] = await sql`insert into biblib.shelves (user_id, title) values (${owner}, ${`[OPS-03 ${run}] otra`}) returning id`
      const [first] = await sql`insert into biblib.books (user_id, isbn, title, shelf_id) values (${owner}, ${`manual-ops03-${run}-${++sequence}`}, ${`[OPS-03 ${run}] primera`}, ${shelf.id}) returning id, edition_id`
      await sql`insert into biblib.copies (user_id, edition_id, shelf_id) values (${owner}, ${first.edition_id}, ${other.id})`
      const [second] = await sql`insert into biblib.books (user_id, isbn, title, shelf_id) values (${owner}, ${`manual-ops03-${run}-${++sequence}`}, ${`[OPS-03 ${run}] segunda`}, ${other.id}) returning id, edition_id`
      const keys = []
      for (const edition of [first.edition_id, second.edition_id]) {
        const asset = randomUUID()
        const key = `${owner}/${asset}/v${++sequence}.webp`
        // Bytes distintos por portada: la deduplicación por dueño (cover_assets_user_sha_unique) no admite dos iguales.
        const bytes = Buffer.concat([COVER, randomBytes(8)])
        const { error } = await admin.storage.from(BUCKET).upload(key, bytes, { contentType: "image/webp", upsert: false })
        if (error) throw new BiblibError(EXIT.SERVICE_UNAVAILABLE, "storage", "Storage no aceptó la portada de prueba.")
        await sql`insert into biblib.cover_assets (id, user_id, storage_key, sha256, mime, width, height, bytes, state, source_kind, source_ref, rights_policy_version)
          values (${asset}, ${owner}, ${key}, ${createHash("sha256").update(bytes).digest("hex")}, 'image/webp', 10, 10, ${bytes.length}, 'ready', 'upload', 'upload', 'v1')`
        await sql`update biblib.editions set cover_asset_id = ${asset} where id = ${edition}`
        keys.push(key)
      }
      await sql`insert into biblib.saved_book_views (user_id, name, filters) values (${owner}, 'Vista', ${sql.json({ status: "all", shelf: "all", sort: "title", view: "table", pageSize: 25 })})`
      const [operation] = await sql`insert into biblib.library_operations (user_id, operation, idempotency_key, input_digest, status, result) values (${owner}, 'import.confirm', ${ctx.key("op")}, ${"a".repeat(64)}, 'committed', '{}') returning id`
      const [snapshot] = await sql`insert into biblib.library_snapshots (user_id, source_operation_id, reason, captured_revision, expires_at) values (${owner}, ${operation.id}, 'import.replace', ${randomUUID()}, now() + interval '30 days') returning id`
      await sql`insert into biblib.library_snapshot_chunks (snapshot_id, user_id, seq, kind, item_count, payload, digest) values (${snapshot.id}, ${owner}, 0, 'shelves', 1, ${sql.json([{ id: shelf.id }])}, ${"b".repeat(64)})`
      const lease = randomUUID()
      const [job] = await sql`insert into biblib.library_jobs (user_id, kind, idempotency_key, input_digest, state, phase, expires_at, lease_token, lease_until, fencing_number)
        values (${owner}, 'covers', ${ctx.key("job")}, ${"c".repeat(64)}, 'running', 'covers', now() + interval '1 day', ${lease}, now() + interval '5 minutes', 7) returning id`
      await sql`insert into biblib.catalogue_private_cache (owner_id, provider, policy_version, credential_scope, schema_version, operation, key_hmac, status, payload, fetched_at, expires_at)
        values (${owner}, 'open-library', 'v1', 'local', 1, 'searchTitleAuthor', ${"d".repeat(64)}, 'found', '[]', now(), now() + interval '1 day')`
      return { shelf: shelf.id, other: other.id, books: [first.id, second.id], keys, job: { id: job.id, lease, fencing: 7 } }
    },

    async residue(owner) { return (await sql`select biblib.account_residue(${owner}::uuid) as r`)[0].r },
    async deletion(owner) { return (await sql`select state, step, error_code, attempts, lease_token, completed_at, purge_after, counts from biblib.account_deletions where user_id = ${owner}`)[0] },
    async objects(owner) { return [...await sql`select name from storage.objects where bucket_id = ${BUCKET} and name like ${`${owner}/%`} order by name`].map((row) => row.name) },
    async identity(owner) { const { data, error } = await admin.auth.admin.getUserById(owner); return error ? null : data.user },

    /** Motor real con sus adaptadores; `storage`, `auth` o `hooks` sustituyen a los reales para simular fallos. */
    deps(overrides = {}) {
      const services = createSupabaseDeletionServices(admin)
      return { db: createDeletionDatabase(workerSql), storage: services.storage, auth: services.auth, limits: { retryBaseMs: 0 }, ...overrides }
    },
    /** Reclama la eliminación de `owner` (vencida) y la procesa. */
    async work(owner, overrides) {
      const deps = ctx.deps(overrides)
      const claimed = await deps.db.claim(owner, 60_000)
      if (!claimed) return null
      return processDeletion(deps, claimed)
    },

    async cleanup() {
      for (const owner of created.splice(0)) {
        for (let names = await ctx.objects(owner); names.length; names = await ctx.objects(owner)) await admin.storage.from(BUCKET).remove(names)
        const { error } = await admin.auth.admin.deleteUser(owner)
        if (error && error.status !== 404) throw new BiblibError(EXIT.SERVICE_UNAVAILABLE, "limpieza", "GoTrue no retiró una cuenta desechable del run.")
        await sql`delete from biblib.account_deletions where user_id = ${owner}`
      }
    },
    async close() {
      await closeConnection(workerSql)
      await closeConnection(sql)
    },
  }
  return ctx
}

/** Valor de una acción `ActionResult` correcta; lanza con el código si no lo es. */
export function value(result) {
  if (result.status !== 200 || result.value?.ok !== true) throw new Error(`Acción fallida: ${result.status} ${result.value?.error?.code ?? ""}`)
  return result.value.value
}

/** Código de error de una acción `ActionResult` fallida. */
export function errorCode(result) {
  if (result.status !== 200 || result.value?.ok !== false) throw new Error(`Se esperaba un error y la acción respondió ${result.status}`)
  return result.value.error.code
}

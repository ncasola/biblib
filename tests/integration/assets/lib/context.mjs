import { execFileSync, spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { createRequire } from "node:module"
import { existsSync, statSync } from "node:fs"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"
import { BiblibError, EXIT } from "../../../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../../../scripts/lib/profiles.mjs"
import { loadCensus, resolveSeedTarget } from "../../../../scripts/db/seed-local.mjs"
import { readFixtureStore } from "../../../../scripts/db/fixture-store.mjs"
import { closeConnection, connect } from "../../../../scripts/db/target.mjs"
import { callAction, cookieHeader, decodeActionResponse, get, loadActions } from "../../lib/app.mjs"
import { signInFixture } from "../../support/session.mjs"

// Contexto del grupo assets (U-DAT-10): Postgres, GoTrue, Storage y app reales del perfil scratch o
// test, cuentas A/B del seed, sus sesiones (cookies para las acciones y clientes Storage con su JWT) y
// los módulos compilados del ejecutor, la política de red y la validación. La red siempre es simulada:
// el transporte y el DNS se inyectan y registran cada destino. Cada prueba crea sus fichas marcadas y
// las retira al terminar, con sus assets, trabajos y objetos.

export const PROFILES = ["scratch", "test"]
export const MARKER = "DAT-10"
export const BUCKET = "biblib-covers"
export const ORIGINAL_COVER = "https://covers.openlibrary.org/b/id/8739161-L.jpg"
const require = createRequire(import.meta.url)
export const sha256 = (data) => createHash("sha256").update(data).digest("hex")

export function assetsProfile() {
  const profile = process.env.BIBLIB_PROFILE || "test"
  if (!PROFILES.includes(profile)) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo assets solo usa los perfiles scratch o test.")
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo assets solo admite BIBLIB_TARGET=local.")
  return profile
}

export function runId() {
  const id = process.env.BIBLIB_ASSETS_RUN_ID || process.env.BIBLIB_INTEGRATION_RUN_ID
  if (!id || !/^[0-9a-f]{12}$/.test(id)) throw new BiblibError(EXIT.INVALID_ARGS, "suite", "Ejecuta el grupo con pnpm test:integration:assets o pnpm test:integration:local.")
  return id
}

/** Módulos compilados por tsconfig.tests.json (los mismos que usa la app). */
export function compiled() {
  const build = path.join(REPO_ROOT, ".next", "tests", "lib")
  const output = path.join(build, "jobs", "cover-assets.js")
  const sources = ["lib/jobs/cover-assets.ts", "lib/jobs/worker.ts", "lib/assets/repository.ts", "lib/assets/fetch-policy.ts", "lib/assets/image-validation.ts", "lib/assets/contracts.ts", "lib/db/schema.ts"].map((file) => statSync(path.join(REPO_ROOT, file)).mtimeMs)
  if (!existsSync(output) || statSync(output).mtimeMs < Math.max(...sources)) {
    execFileSync(process.execPath, [path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.tests.json"], { cwd: REPO_ROOT, stdio: "ignore", windowsHide: true })
  }
  return {
    worker: require(path.join(build, "jobs", "worker.js")),
    jobs: require(path.join(build, "jobs", "repository.js")),
    repository: require(path.join(build, "assets", "repository.js")),
    contracts: require(path.join(build, "assets", "contracts.js")),
    policy: require(path.join(build, "assets", "fetch-policy.js")),
    images: require(path.join(build, "assets", "image-validation.js")),
    rights: require(path.join(build, "bibliographic-catalog", "rights.js")),
  }
}

/** Server Action con un FormData como único argumento, serializado como lo hace React en el navegador. */
export async function callActionWithForm(app, name, fields, { cookies = [] } = {}) {
  const action = app.actions.get(name)
  if (!action) throw new BiblibError(EXIT.VERIFICATION_FAILED, "app", `La acción ${name} no está en el build.`)
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(`_1_${key}`, value)
  form.append("0", JSON.stringify(["$K1"]))
  const response = await fetch(`${app.url}${action.route}`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(60_000),
    headers: { "Next-Action": action.id, Accept: "text/x-component", Origin: app.url, Cookie: cookieHeader(cookies) }, body: form,
  })
  const body = Buffer.from(await response.arrayBuffer())
  const result = { status: response.status, value: undefined, thrown: false }
  if (response.status !== 200 || !(response.headers.get("content-type") ?? "").startsWith("text/x-component")) return result
  return { ...result, ...decodeActionResponse(body) }
}

export const ok = (result) => result.status === 200 && result.value?.ok === true
export const failed = (result, code) => result.status === 200 && result.value?.ok === false && result.value.error.code === code

/** Política de derechos solo de prueba: Open Library con rehostCover (las publicadas lo deniegan). */
export function permissiveRights(rights, overrides = {}) {
  return (provider) => ({ ...rights.providerRightsPolicy(provider), ...(provider === "open-library" ? { rehostCover: true, backupAsset: true, ...overrides } : {}) })
}

/** Red simulada: registra cada resolución y conexión; nunca sale a Internet. */
export function fakeNetwork({ addresses = [{ address: "151.101.1.1", family: 4 }], respond }) {
  const log = { lookups: [], connections: [] }
  return {
    log,
    resolve: async (host) => { log.lookups.push(host); return typeof addresses === "function" ? addresses(log.lookups.length) : addresses },
    transport: async (request) => { log.connections.push({ host: request.url.hostname, address: request.address.address, path: request.url.pathname }); return respond(request) },
  }
}

export async function* chunks(...parts) { for (const part of parts) yield part }

export async function assetsContext() {
  const profile = assetsProfile()
  const resolved = await resolveSeedTarget(profile)
  const store = readFixtureStore(resolved, loadCensus())
  if (!store?.accounts?.a?.id || !store?.accounts?.b?.id || store.phase !== "completado") throw new BiblibError(EXIT.SEED_FAILED, "suite", `Faltan fixtures A/B completos; ejecuta pnpm db:seed:local --profile ${profile}.`)
  const env = resolved.target.env()
  const sql = connect(resolved, { applicationName: "biblib-assets-tests" })
  const workerSql = connect(resolved, { applicationName: "biblib-assets-worker" })
  const appConfig = resolved.stack.profile.app
  const users = { a: store.accounts.a.id, b: store.accounts.b.id }
  const run = runId()
  const modules = compiled()
  const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, clientOptions)
  const [{ started }] = await sql`select now() as started`
  let sequence = 0
  const ctx = {
    profile, resolved, sql, users, run, modules, env, admin,
    app: { url: `http://${appConfig.host}:${appConfig.port}`, actions: loadActions(resolved.stack.root) },
    title: (text) => `[${MARKER} ${run}] ${text}`,
    key: (label) => `dat10${run}${label}${++sequence}${randomBytes(3).toString("hex")}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120),
    async signIn(as) { return signInFixture(as, { profile }) },
    cookies(session) { return session.cookies().filter((cookie) => cookie.value !== "").map(({ name, value }) => ({ name, value })) },
    call(name, args, session) { return callAction(ctx.app, name, args, { cookies: session ? ctx.cookies(session) : [] }) },
    form(name, fields, session) { return callActionWithForm(ctx.app, name, fields, { cookies: session ? ctx.cookies(session) : [] }) },
    read(assetId, session) { return get(ctx.app, `/api/covers/${assetId}`, { cookies: session ? ctx.cookies(session) : [] }) },
    /** Cliente Storage con el JWT de la sesión: lo mismo que puede hacer el navegador con su token. */
    storageAs(session) { return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { ...clientOptions, global: { headers: { Authorization: `Bearer ${session.session.access_token}` } } }) },
    anon() { return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, clientOptions) },
    assetStorage(session) { return modules.repository.createSupabaseAssetStorage(ctx.storageAs(session)) },

    /** Ficha marcada del dueño con una portada original de Open Library. */
    async book(owner, label) {
      const [shelf] = await sql`select id from biblib.shelves where user_id = ${owner} and is_default`
      const [row] = await sql`insert into biblib.books (user_id, isbn, title, shelf_id, cover_small, cover_medium, cover_large, catalogue)
        values (${owner}, ${`manual-dat10-${run}-${label}-${++sequence}`}, ${ctx.title(label)}, ${shelf.id}, ${ORIGINAL_COVER.replace("-L.", "-S.")}, ${ORIGINAL_COVER.replace("-L.", "-M.")}, ${ORIGINAL_COVER}, ${sql.json({ source: "manual", isbnVerified: false })})
        returning id, version, cover_large, cover_asset_id`
      return row
    },
    async bookRow(id) { return (await sql`select id, version, cover_small, cover_medium, cover_large, cover_asset_id from biblib.books where id = ${id}`)[0] },
    async assetRow(id) { return (await sql`select * from biblib.cover_assets where id = ${id}`)[0] },
    async assetsOf(owner) { return [...await sql`select * from biblib.cover_assets where user_id = ${owner} and created_at >= ${started} order by created_at`] },
    async objects(prefix) { return [...await sql`select name, (metadata->>'size')::int as size, created_at from storage.objects where bucket_id = ${BUCKET} and name like ${`${prefix}%`} order by created_at`] },
    async jobRow(id) { return (await sql`select * from biblib.library_jobs where id = ${id}`)[0] },

    /** Transacción con los claims del dueño, como withRlsContext de la app. */
    asUser(userId, work) {
      return sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${userId}, true)`
        await tx`set local role authenticated`
        return work(tx)
      })
    },
    /**
     * Solicitud de adquisición directamente por la función de 0009, como lo haría la acción tras
     * comprobar los derechos. Sirve para un trabajo antiguo o un cliente manipulado que se saltara la acción.
     */
    async request(owner, book, sourceRef, idempotencyKey = ctx.key("req")) {
      const digest = sha256(`${book.id}|${book.version}|${sourceRef}`)
      const [{ result }] = await ctx.asUser(owner, (tx) => tx`select biblib.cover_asset_request(${book.id}::uuid, ${book.version}::uuid, ${sourceRef}, 'prueba', 'Atribución de prueba', ${idempotencyKey}, ${digest}) as result`)
      return result
    },
    /** Ejecutor compilado con la sesión del dueño y la red o los derechos que indique la prueba. */
    async work(session, jobId, { network, rights, fetchCover, hooks = {}, limits = {}, budgetMs = 20_000 } = {}) {
      const repo = modules.jobs.createJobRepository(modules.jobs.createJobDatabase(workerSql))
      const fetches = []
      const assets = {
        storage: ctx.assetStorage(session),
        rights,
        hooks,
        fetchCover: fetchCover ?? (async (key, options) => {
          fetches.push(key.ref)
          if (!network) throw new Error("La prueba no preparó red")
          return modules.policy.fetchProviderCover(key, { resolve: network.resolve, transport: network.transport, limits: { timeoutMs: options.timeoutMs, ...limits.fetch } })
        }),
      }
      const reports = await modules.worker.drainJobs({ repo, catalog: { getCover: async () => { throw new Error("sin catálogo") } }, random: () => 0, assets, limits: limits.worker ?? {} }, { jobId, owner: session.user.id }, budgetMs)
      return { reports, fetches }
    },
    /** Proceso trabajador independiente que puede morir de golpe (137) en un punto del paso. */
    workInChild(session, task) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(REPO_ROOT, "tests", "integration", "assets", "lib", "worker.mjs"), JSON.stringify(task)], {
          cwd: REPO_ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, BIBLIB_ASSETS_TEST_DB_URL: env.SUPABASE_DB_URL, BIBLIB_ASSETS_TEST_SUPABASE_URL: env.SUPABASE_URL, BIBLIB_ASSETS_TEST_ANON_KEY: env.SUPABASE_ANON_KEY, BIBLIB_ASSETS_TEST_TOKEN: session.session.access_token },
        })
        let out = ""
        child.stdout.on("data", (data) => { out += data })
        child.on("error", reject)
        child.on("close", (code) => {
          const line = out.trim().split(/\r?\n/).at(-1)
          try { resolve({ code, ...(line ? JSON.parse(line) : {}) }) } catch { resolve({ code, raw: out }) }
        })
      })
    },
    /** Purga con la administración (como el script fuera de Next): todas las cuentas, gracia indicada. */
    async purge({ owner = null, graceSeconds = 0 } = {}) {
      const { drizzle } = require("drizzle-orm/postgres-js")
      const db = drizzle(workerSql)
      const run = async (query) => (await db.execute(query))[0]?.result
      return modules.repository.purgeCoverAssets(run, modules.repository.createSupabaseAssetStorage(admin), { owner, limit: 500, graceSeconds })
    },
    /** Hace antiguos los objetos de un prefijo para que la purga los considere (10 minutos de margen). */
    async ageObjects(prefix) { await sql`update storage.objects set created_at = now() - interval '1 hour' where bucket_id = ${BUCKET} and name like ${`${prefix}%`}` },

    async cleanup() {
      const owners = [users.a, users.b]
      await sql`select biblib.account_set_state(${users.a}, 'active'), biblib.account_set_state(${users.b}, 'active')`
      await sql`delete from biblib.books where user_id in ${sql(owners)} and title like ${`[${MARKER} ${run}]%`}`
      await sql`update biblib.books set cover_asset_id = null where user_id in ${sql(owners)} and cover_asset_id is not null and cover_asset_id in (select id from biblib.cover_assets where created_at >= ${started})`
      await sql`delete from biblib.library_snapshots where user_id in ${sql(owners)} and created_at >= ${started}`
      await sql`delete from biblib.library_operations where user_id in ${sql(owners)} and idempotency_key like ${`dat10${run}%`}`
      await sql`delete from biblib.cover_assets where user_id in ${sql(owners)} and created_at >= ${started}`
      // Objetos de A/B que ya no registra ningún asset (los de este run y huérfanos de pruebas).
      const keys = (await sql`select o.name from storage.objects o where o.bucket_id = ${BUCKET} and split_part(o.name, '/', 1) in ${sql(owners)} and not exists (select 1 from biblib.cover_assets a where a.storage_key = o.name)`).map((row) => row.name)
      await sql`delete from biblib.library_jobs where user_id in ${sql(owners)} and kind = 'cover_asset' and created_at >= ${started}`
      for (let offset = 0; offset < keys.length; offset += 100) await admin.storage.from(BUCKET).remove(keys.slice(offset, offset + 100))
    },
    async close() { await closeConnection(workerSql); await closeConnection(sql) },
  }
  return ctx
}

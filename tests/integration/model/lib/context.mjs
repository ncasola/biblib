import { randomBytes, randomUUID } from "node:crypto"
import { BiblibError, EXIT } from "../../../../scripts/lib/exit-codes.mjs"
import { loadCensus, resolveSeedTarget } from "../../../../scripts/db/seed-local.mjs"
import { readFixtureStore } from "../../../../scripts/db/fixture-store.mjs"
import { closeConnection, connect } from "../../../../scripts/db/target.mjs"
import { callAction, get, loadActions } from "../../lib/app.mjs"
import { signInFixture } from "../../support/session.mjs"

// Contexto del grupo model (U-DAT-06): sesiones GoTrue reales A/B, Server Actions por HTTP contra la app
// compilada y una conexión administrativa solo para preparar y comprobar. Todo lo que crea lleva el prefijo
// del run y se retira al terminar.
export const PROFILES = ["scratch", "test"]

/** ISBN-13 válido en el prefijo 979-12 (sin uso real en los fixtures), distinto por run y número. */
export function syntheticIsbn(seed, n) {
  const body = `97912${String(parseInt(seed.slice(0, 6), 16) % 1_000_000).padStart(6, "0")}${String(n % 10)}`
  const check = (10 - [...body].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0) % 10) % 10
  return `${body}${check}`
}

export async function modelContext() {
  const profile = process.env.BIBLIB_PROFILE || "test"
  if (!PROFILES.includes(profile)) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo model solo usa scratch o test.")
  const run = process.env.BIBLIB_MODEL_RUN_ID || process.env.BIBLIB_INTEGRATION_RUN_ID
  if (!run || !/^[0-9a-f]{12}$/.test(run)) throw new BiblibError(EXIT.INVALID_ARGS, "suite", "Ejecuta test:integration:model o test:integration:local.")
  const resolved = await resolveSeedTarget(profile)
  const store = readFixtureStore(resolved, loadCensus())
  const sql = connect(resolved, { applicationName: "biblib-model-tests" })
  const users = { a: store.accounts.a.id, b: store.accounts.b.id }
  const { host, port } = resolved.stack.profile.app
  const app = { url: `http://${host}:${port}`, actions: loadActions(resolved.stack.root) }
  const prefix = `[DAT-06 ${run}]`
  const ctx = {
    profile, resolved, sql, users, app, prefix, run,
    title: (label) => `${prefix} ${label} ${randomBytes(2).toString("hex")}`,
    key: (label = "op") => `dat06-${label}-${randomUUID().replaceAll("-", "")}`.slice(0, 64),
    isbn: (n) => syntheticIsbn(run, n),
    async signIn(as) { return signInFixture(as, { profile }) },
    call(name, args, session) { return callAction(app, name, args, { cookies: session.cookies() }) },
    get(route, session) { return get(app, route, { cookies: session.cookies() }) },
    async defaultShelf(owner) { return (await sql`select id from biblib.shelves where user_id = ${owner} and is_default`)[0].id },
    async shelf(owner, label) {
      const [row] = await sql`insert into biblib.shelves (user_id, title) values (${owner}, ${`${prefix} ${label}`}) returning id`
      return row.id
    },
    async revision(owner) { return (await sql`select revision from biblib.library_state where user_id = ${owner}`)[0]?.revision },
    async cleanup() {
      for (const owner of Object.values(users)) {
        await sql`delete from biblib.copies where user_id = ${owner} and edition_id in (select id from biblib.editions where user_id = ${owner} and title like ${`${prefix}%`})`
        await sql`delete from biblib.shelves where user_id = ${owner} and title like ${`${prefix}%`} and not is_default`
        // Las importaciones confirmadas dejan trabajo, operación y vista previa: se retiran por su clave dat06-….
        const previews = (await sql`select preview_id from biblib.library_jobs where user_id = ${owner} and idempotency_key like 'dat06-%' and preview_id is not null
          union select preview_id from biblib.library_operations where user_id = ${owner} and idempotency_key like 'dat06-%' and preview_id is not null`).map((row) => row.preview_id)
        await sql`delete from biblib.library_jobs where user_id = ${owner} and idempotency_key like 'dat06-%'`
        await sql`delete from biblib.library_operations where user_id = ${owner} and idempotency_key like 'dat06-%'`
        if (previews.length) await sql`delete from biblib.import_previews where user_id = ${owner} and id = any(${previews}::uuid[])`
      }
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

/** Valor de una acción de lectura que no devuelve `ActionResult`. */
export function raw(result) {
  if (result.status !== 200 || result.thrown) throw new Error(`Lectura fallida: ${result.status}`)
  return result.value
}

/** Código de error de una acción `ActionResult` fallida. */
export function errorCode(result) {
  if (result.status !== 200 || result.value?.ok !== false) throw new Error(`Se esperaba un error y la acción respondió ${result.status} ${JSON.stringify(result.value).slice(0, 120)}`)
  return result.value.error.code
}

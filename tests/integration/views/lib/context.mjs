import { randomBytes } from "node:crypto"
import { BiblibError, EXIT } from "../../../../scripts/lib/exit-codes.mjs"
import { loadCensus, resolveSeedTarget } from "../../../../scripts/db/seed-local.mjs"
import { readFixtureStore } from "../../../../scripts/db/fixture-store.mjs"
import { closeConnection, connect } from "../../../../scripts/db/target.mjs"
import { callAction, loadActions } from "../../lib/app.mjs"
import { signInFixture } from "../../support/session.mjs"

export const PROFILES = ["scratch", "test"]
export const FILTERS = Object.freeze({ q: "", status: "all", shelf: "all", sort: "title", view: "table", pageSize: 10 })
export async function viewsContext() {
  const profile = process.env.BIBLIB_PROFILE || "test"
  if (!PROFILES.includes(profile)) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo views solo usa scratch o test.")
  const run = process.env.BIBLIB_VIEWS_RUN_ID || process.env.BIBLIB_INTEGRATION_RUN_ID
  if (!run || !/^[0-9a-f]{12}$/.test(run)) throw new BiblibError(EXIT.INVALID_ARGS, "suite", "Ejecuta test:integration:views o test:integration:local.")
  const resolved = await resolveSeedTarget(profile)
  const store = readFixtureStore(resolved, loadCensus())
  const sql = connect(resolved, { applicationName: "biblib-views-tests" })
  const users = { a: store.accounts.a.id, b: store.accounts.b.id }
  const { host, port } = resolved.stack.profile.app
  const app = { url: `http://${host}:${port}`, actions: loadActions(resolved.stack.root) }
  const prefix = `[EXP-02 ${run}]`
  const ctx = {
    profile, resolved, sql, users, app, prefix,
    name: (label) => `${prefix} ${label} ${randomBytes(2).toString("hex")}`,
    async signIn(as) { return signInFixture(as, { profile }) },
    call(name, args, session) { return callAction(app, name, args, { cookies: session.cookies() }) },
    async revision(owner) { return (await sql`select revision from biblib.library_state where user_id = ${owner}`)[0]?.revision },
    async asUser(userId, work) {
      // Una conexión por sesión: las altas concurrentes deben competir en Postgres.
      const connection = connect(resolved, { applicationName: "biblib-views-session" })
      try { return await connection.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${userId}, true)`
        await tx`set local role authenticated`
        return work(tx)
      }) } finally { await closeConnection(connection) }
    },
    async cleanup() {
      await sql`delete from biblib.saved_book_views where user_id in ${sql(Object.values(users))} and name like ${`${prefix}%`}`
      await sql`delete from biblib.books where user_id in ${sql(Object.values(users))} and title like ${`${prefix}%`}`
      await sql`delete from biblib.shelves where user_id in ${sql(Object.values(users))} and title like ${`${prefix}%`} and not is_default`
    },
    async close() { await closeConnection(sql) },
  }
  return ctx
}
export function value(result) {
  if (result.status !== 200 || result.value?.ok !== true) throw new Error(`Acción fallida: ${result.value?.error?.code ?? result.status}`)
  return result.value.value
}

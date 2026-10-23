import assert from "node:assert/strict"
import { createHash, createHmac, randomBytes } from "node:crypto"
import { after, before, test } from "node:test"
import { liveCookies, readSession } from "../lib/sessions.mjs"
import { securityContext } from "./lib/context.mjs"

// U-FIX-02 · Una sola verificación con GoTrue por petición sin aceptar tokens revocados. El proxy verifica
// con GoTrue y entrega a la acción una atestación firmada con una clave del proceso; aquí se comprueba que
// una sesión cerrada (access token aún no caducado) no escribe ni por las acciones ni por /api (fuera del
// proxy), que una atestación fabricada por el cliente no sirve y que nunca sale en una respuesta.

const HEADER = "x-biblib-session-attestation"
const RUN = process.env.BIBLIB_SECURITY_RUN_ID
const TITLE = `[FIX-02 ${RUN}] revocación`

let ctx
before(async () => { ctx = await securityContext() })
after(async () => {
  if (ctx) {
    await ctx.sql`delete from biblib.books where user_id in (${ctx.accounts.a.id}, ${ctx.accounts.b.id}) and title like ${`[FIX-02 ${RUN}]%`}`
    await ctx.sql`delete from biblib.shelves where user_id in (${ctx.accounts.a.id}, ${ctx.accounts.b.id}) and title like ${`[FIX-02 ${RUN}]%`}`
    await ctx.close()
  }
})

/** Atestación con el formato real pero firmada con otra clave: lo máximo que puede fabricar un cliente. */
function forgedAttestation(userId, accessToken, nonce = "bm9uY2U=") {
  const issuedAt = Date.now()
  const hash = createHash("sha256").update(accessToken).digest("base64url")
  const mac = createHmac("sha256", randomBytes(32)).update(`v1|${issuedAt}|${nonce}|${userId}|${hash}`).digest("base64url")
  return ["v1", String(issuedAt), Buffer.from(nonce).toString("base64url"), userId, mac].join(".")
}

const shelvesNamed = async (userId, title) => (await ctx.sql`select count(*)::int as n from biblib.shelves where user_id = ${userId} and title = ${title}`)[0].n
const booksNamed = async (userId, title) => (await ctx.sql`select count(*)::int as n from biblib.books where user_id = ${userId} and title = ${title}`)[0].n

async function closedSession() {
  const fixture = await ctx.signIn("a")
  const cookies = liveCookies(fixture)
  const session = readSession(cookies)
  const logout = await fetch(`${ctx.env.SUPABASE_URL}/auth/v1/logout?scope=local`, {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { apikey: ctx.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
  })
  assert.equal(logout.status, 204)
  assert.ok(session.expires_at > Math.floor(Date.now() / 1000) + 60, "El access token de la sesión cerrada sigue sin caducar.")
  return { cookies, session }
}

test("una sesión viva escribe con una sola verificación por petición (control)", async () => {
  const cookies = liveCookies(await ctx.signIn("a"))
  const created = await ctx.action("createShelfAction", [`${TITLE} control`], { cookies })
  assert.equal(created.status, 200)
  assert.equal(created.value?.ok, true)
  assert.equal(await shelvesNamed(ctx.accounts.a.id, `${TITLE} control`), 1)
  assert.equal(created.headers.get(HEADER), null, "La atestación es interna y no sale en la respuesta.")
})

test("token revocado: ninguna escritura por acciones, ni con una atestación fabricada por el cliente", async () => {
  const { cookies, session } = await closedSession()
  const plain = await ctx.action("createShelfAction", [`${TITLE} acción`], { cookies })
  assert.equal(plain.status, 307, "El proxy verifica con GoTrue y devuelve al acceso.")
  assert.equal(plain.value, undefined)

  const action = ctx.actions.get("createShelfAction")
  const forged = await ctx.request(action.route, {
    cookies, method: "POST", body: JSON.stringify([`${TITLE} acción`]),
    headers: { "Next-Action": action.id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Origin: ctx.appUrl, [HEADER]: forgedAttestation(ctx.accounts.a.id, session.access_token) },
  })
  assert.equal(forged.status, 307, "La cabecera del cliente se descarta y la sesión cerrada vuelve al acceso.")
  assert.equal(await shelvesNamed(ctx.accounts.a.id, `${TITLE} acción`), 0, "No se creó nada.")
})

test("token revocado: /api (fuera del proxy) verifica con GoTrue y no escribe, con o sin atestación fabricada", async () => {
  const { cookies, session } = await closedSession()
  const body = JSON.stringify({ isbn: "", title: `${TITLE} api`, authors: [{ name: "Prueba" }], number_of_pages: 1, publish_date: "2026", status: "unread" })
  for (const extra of [{}, { [HEADER]: forgedAttestation(ctx.accounts.a.id, session.access_token) }]) {
    const response = await ctx.request("/api/books/add", { cookies, method: "POST", body, headers: { "Content-Type": "application/json", ...extra } })
    assert.equal(response.status, 401, "Sin atestación válida, la acción consulta a GoTrue y rechaza la sesión cerrada.")
  }
  assert.equal(await booksNamed(ctx.accounts.a.id, `${TITLE} api`), 0)
})

test("una atestación fabricada no cambia el usuario: B con la cabecera de A sigue siendo B", async () => {
  const b = liveCookies(await ctx.signIn("b"))
  const token = readSession(b).access_token
  const action = ctx.actions.get("createShelfAction")
  const response = await ctx.request(action.route, {
    cookies: b, method: "POST", body: JSON.stringify([`${TITLE} b`]),
    headers: { "Next-Action": action.id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Origin: ctx.appUrl, [HEADER]: forgedAttestation(ctx.accounts.a.id, token) },
  })
  assert.equal(response.status, 200)
  assert.equal(await shelvesNamed(ctx.accounts.b.id, `${TITLE} b`), 1, "La escritura queda en la cuenta de la sesión (B).")
  assert.equal(await shelvesNamed(ctx.accounts.a.id, `${TITLE} b`), 0, "Nunca en la cuenta nombrada por la cabecera.")
  const api = await ctx.request("/api/books/add", {
    cookies: b, method: "POST", headers: { "Content-Type": "application/json", [HEADER]: forgedAttestation(ctx.accounts.a.id, token) },
    body: JSON.stringify({ isbn: "", title: `${TITLE} b api`, authors: [{ name: "Prueba" }], number_of_pages: 1, publish_date: "2026", status: "unread" }),
  })
  assert.notEqual(api.status, 401, "B conserva su sesión por la API.")
  assert.equal(await booksNamed(ctx.accounts.a.id, `${TITLE} b api`), 0, "Ningún libro aparece en la cuenta de A.")
})

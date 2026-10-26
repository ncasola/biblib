import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { anonClient, runTitle } from "../lib/context.mjs"
import { callAction, get } from "../lib/app.mjs"
import { applySetCookies, liveCookies, readSession, signIn, withExpiredAccess } from "../lib/sessions.mjs"
import { setupSuite } from "../lib/suite.mjs"

// Sesiones reales de GoTrue y cookies SSR de @supabase/ssr frente al proxy y las acciones de la app.
// Las aserciones comparan identidades y booleanos; nunca muestran tokens ni valores de cookie.

let s, fa, fb

before(async () => {
  s = await setupSuite()
  fa = await signIn("a")
  fb = await signIn("b")
})
after(() => s?.close())

const sessionCookies = (cookies) => cookies.filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))
const redirectTarget = (location) => new URL(location, s.app.url).searchParams.get("redirect")

test("getUser identifica a A y B en GoTrue y rechaza un token alterado", async () => {
  for (const [fixture, key] of [[fa, "a"], [fb, "b"]]) {
    const { data, error } = await fixture.client.auth.getUser()
    assert.equal(error, null)
    assert.equal(data.user.id, s.ctx.users[key])
    assert.ok(data.user.email.endsWith("@biblib.test"))
    const parts = fixture.session.access_token.split(".")
    parts[1] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], "base64url").toString()), sub: s.ctx.users[key === "a" ? "b" : "a"] })).toString("base64url")
    const forged = await anonClient(s.ctx).auth.getUser(parts.join("."))
    assert.ok(forged.error && !forged.data.user, "GoTrue debe rechazar un token con el sujeto cambiado.")
  }
})

test("cookies SSR: nombre sb-<ref>-auth-token, Path=/, SameSite=Lax y sesión en base64url", async () => {
  const cookies = fa.cookies()
  assert.ok(sessionCookies(cookies).length >= 1)
  for (const cookie of sessionCookies(cookies)) {
    assert.equal(cookie.options.path, "/")
    assert.equal(String(cookie.options.sameSite).toLowerCase(), "lax")
    assert.ok(cookie.value.startsWith("base64-"), "La sesión se codifica en base64url.")
  }
  assert.equal(readSession(cookies).user.id, s.ctx.users.a)
})

test("renovación por el SDK: tokens nuevos, misma identidad y cookies actualizadas", async () => {
  const before = readSession(liveCookies(fb))
  const { data, error } = await fb.client.auth.refreshSession()
  assert.equal(error, null)
  assert.ok(data.session.access_token !== before.access_token && data.session.refresh_token !== before.refresh_token, "La renovación debe emitir tokens nuevos.")
  assert.equal((await fb.client.auth.getUser()).data.user.id, s.ctx.users.b)
  assert.ok(readSession(liveCookies(fb)).access_token === data.session.access_token, "Las cookies SSR deben guardar la sesión renovada.")
})

test("anónimo en una ruta privada con consulta vuelve al acceso conservando la ruta", async () => {
  const response = await get(s.app, "/books?status=read&page=2")
  assert.equal(response.status, 307)
  assert.equal(new URL(response.location, s.app.url).pathname, "/login")
  assert.equal(redirectTarget(response.location), "/books?status=read&page=2")
})

test("con sesión, /login devuelve a la ruta con consulta y descarta destinos externos", async () => {
  const cookies = liveCookies(fa)
  assert.equal((await get(s.app, "/books?status=read&page=2", { cookies })).status, 200)
  const back = await get(s.app, `/login?redirect=${encodeURIComponent("/books?status=read&page=2")}`, { cookies })
  assert.equal(back.status, 307)
  assert.equal(new URL(back.location, s.app.url).pathname + new URL(back.location, s.app.url).search, "/books?status=read&page=2")
  const external = await get(s.app, `/login?redirect=${encodeURIComponent("//ejemplo.invalid/robo")}`, { cookies })
  assert.equal(new URL(external.location, s.app.url).origin, s.app.url)
  assert.equal(new URL(external.location, s.app.url).pathname, "/")
})

test("una sesión vencida con refresh válido se renueva en el proxy y mantiene el destino", async () => {
  const expired = withExpiredAccess(liveCookies(fa))
  const response = await get(s.app, "/books?status=read", { cookies: expired })
  assert.equal(response.status, 200, "La renovación válida no debe redirigir.")
  const renewedCookies = applySetCookies(expired, response.setCookies)
  const renewed = readSession(renewedCookies)
  assert.ok(renewed && renewed.access_token !== readSession(expired).access_token, "El proxy debe emitir una sesión renovada.")
  assert.ok(renewed.expires_at > Math.floor(Date.now() / 1000), "La sesión renovada no está vencida.")
  for (const header of response.setCookies.filter((h) => /^sb-.+-auth-token/.test(h))) assert.match(header, /Path=\//i)
  assert.equal((await anonClient(s.ctx).auth.getUser(renewed.access_token)).data.user?.id, s.ctx.users.a)
  const shelves = await callAction(s.app, "getShelvesAction", [], { cookies: renewedCookies })
  assert.ok(Array.isArray(shelves.value) && shelves.value.length >= 3, "La acción funciona con la sesión renovada.")
})

test("cookies fragmentadas producidas por el SDK funcionan en el proxy y en las acciones", async () => {
  const key = "qa01_relleno"
  s.record("metadata", { userId: s.ctx.users.b, key })
  // Un metadato grande, solo de este run, hace que @supabase/ssr reparta la sesión en .0, .1…
  const { error } = await fb.client.auth.updateUser({ data: { [key]: `${runTitle("relleno")} ${"x".repeat(2600)}` } })
  assert.equal(error, null)
  const cookies = liveCookies(fb)
  const names = sessionCookies(cookies).map((c) => c.name)
  assert.ok(names.some((n) => n.endsWith(".0")) && names.some((n) => n.endsWith(".1")), "El SDK debe producir cookies partidas.")
  assert.ok(!names.some((n) => !/\.\d+$/.test(n)), "Sin cookie entera junto a los fragmentos.")
  assert.equal((await get(s.app, "/shelves", { cookies })).status, 200)
  const shelves = await callAction(s.app, "getShelvesAction", [], { cookies })
  assert.ok(Array.isArray(shelves.value) && shelves.value.length >= 3)
  const cleared = await fb.client.auth.updateUser({ data: { [key]: null } })
  assert.equal(cleared.error, null)
  assert.ok(!(key in cleared.data.user.user_metadata))
  s.forget("metadata", { userId: s.ctx.users.b, key })
})

test("cerrar sesión elimina la vista privada, también con una copia antigua de las cookies", async () => {
  const stale = liveCookies(fb)
  const staleSession = readSession(stale)
  assert.equal((await get(s.app, "/books", { cookies: stale })).status, 200)
  assert.equal((await fb.client.auth.signOut({ scope: "local" })).error, null)
  assert.ok(fb.cookies().filter((c) => /auth-token/.test(c.name)).every((c) => c.value === ""), "SSR debe vaciar las cookies al cerrar sesión.")
  assert.equal(liveCookies(fb).length, 0)

  const withCleared = await get(s.app, "/books")
  assert.equal(withCleared.status, 307)
  const withStale = await get(s.app, "/books?status=read", { cookies: stale })
  assert.equal(withStale.status, 307, "GoTrue ya no reconoce la sesión cerrada.")
  assert.equal(redirectTarget(withStale.location), "/books?status=read")
  const action = await callAction(s.app, "listBooksAction", [{ pageSize: 100 }], { cookies: stale })
  assert.equal(action.status, 307)
  assert.equal(action.value, undefined)
  assert.ok((await anonClient(s.ctx).auth.getUser(staleSession.access_token)).error, "El access token de la sesión cerrada se rechaza.")
  assert.ok((await anonClient(s.ctx).auth.refreshSession({ refresh_token: staleSession.refresh_token })).error, "La renovación tras el cierre se rechaza.")

  const expired = await get(s.app, "/books?status=read", { cookies: withExpiredAccess(stale) })
  assert.equal(expired.status, 307, "Una renovación revocada vuelve al acceso.")
  assert.equal(new URL(expired.location, s.app.url).pathname, "/login")
  assert.equal(redirectTarget(expired.location), "/books?status=read")
})

test("cierre y renovación concurrentes no dejan ninguna sesión utilizable", async () => {
  const fixture = await signIn("a")
  const { access_token: access, refresh_token: refresh } = fixture.session
  const auth = (route, init) => fetch(`${s.ctx.env.SUPABASE_URL}/auth/v1${route}`, { ...init, signal: AbortSignal.timeout(10000), headers: { apikey: s.ctx.env.SUPABASE_ANON_KEY, "Content-Type": "application/json", ...init.headers } })
  const [renewal, logout] = await Promise.all([
    auth("/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: refresh }) }),
    auth("/logout?scope=local", { method: "POST", headers: { Authorization: `Bearer ${access}` } }),
  ])
  assert.equal(logout.status, 204)
  const renewed = renewal.status === 200 ? await renewal.json() : null
  const client = anonClient(s.ctx)
  assert.ok((await client.auth.getUser(access)).error, "El access token original queda invalidado.")
  if (renewed) {
    assert.ok((await client.auth.getUser(renewed.access_token)).error, "El token emitido en paralelo tampoco sirve tras el cierre.")
    assert.ok((await client.auth.refreshSession({ refresh_token: renewed.refresh_token })).error)
  }
  assert.ok((await client.auth.refreshSession({ refresh_token: refresh })).error)
})

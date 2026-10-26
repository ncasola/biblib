import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { createClient } from "@supabase/supabase-js"
import { applySetCookies, readSession, withExpiredAccess } from "../lib/sessions.mjs"
import { authCookies, securityContext } from "./lib/context.mjs"

// U-OPS-04 · Sesión local real: formulario de U-LOC-01 contra GoTrue, cookies SSR, renovación en el
// proxy, cierre y callback PKCE con destino interno. Los destinos externos, `//` y `/\` se descartan.

let ctx
before(async () => { ctx = await securityContext() })
after(() => ctx?.close())

const loginTarget = (location) => new URL(location, ctx.appUrl).searchParams.get("redirect")
const anon = () => createClient(ctx.env.SUPABASE_URL, ctx.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })

test("formulario local: GoTrue real, cookies SSR y destino interno conservado", async () => {
  const login = await ctx.localLogin({ email: ctx.accounts.a.email, password: ctx.accounts.a.password, redirect: "/books?status=read" })
  assert.equal(login.status, 200)
  assert.deepEqual(login.value, { ok: true, redirectTo: "/books?status=read" })
  const sessionHeaders = login.setCookies.filter((header) => /^sb-.+-auth-token/.test(header))
  assert.ok(sessionHeaders.length > 0, "La acción debe fijar la cookie de sesión SSR.")
  for (const header of sessionHeaders) {
    assert.match(header, /Path=\//i)
    assert.match(header, /SameSite=Lax/i)
  }
  assert.match(login.headers.get("cache-control") ?? "", /no-store/)
  const session = readSession(login.cookies)
  assert.equal(session?.user?.id, ctx.accounts.a.id, "La cookie corresponde a la cuenta A de GoTrue.")
  const page = await ctx.request("/books?status=read", { cookies: login.cookies })
  assert.equal(page.status, 200)
  assert.equal(page.headers.get("cache-control"), "private, no-store")
})

test("formulario local: credenciales erróneas no fijan cookies ni revelan la cuenta", async () => {
  const wrong = await ctx.localLogin({ email: ctx.accounts.a.email, password: "contraseña-incorrecta", redirect: "/books" })
  const unknown = await ctx.localLogin({ email: "nadie@biblib.test", password: "contraseña-incorrecta", redirect: "/books" })
  for (const result of [wrong, unknown]) {
    assert.equal(result.status, 200)
    assert.equal(result.value?.ok, false)
    assert.equal(result.value?.code, "UNAUTHORIZED")
    assert.equal(authCookies(result.cookies).length, 0)
  }
  assert.equal(wrong.value.message, unknown.value.message, "El mensaje no distingue usuario existente de inexistente.")
  // El limitador es por proceso: un acceso correcto lo reinicia para las pruebas siguientes.
  assert.equal((await ctx.localLogin({ email: ctx.accounts.a.email, password: ctx.accounts.a.password })).value?.ok, true)
})

test("formulario local: destinos externos, // y /\\ vuelven a la portada", async () => {
  for (const redirect of ["https://externo.invalid/robar", "//externo.invalid/robar", "/\\externo.invalid/robar", "/login?redirect=%2F%2Fexterno.invalid"]) {
    const login = await ctx.localLogin({ email: ctx.accounts.a.email, password: ctx.accounts.a.password, redirect })
    assert.deepEqual(login.value, { ok: true, redirectTo: "/" }, `Destino rechazado: ${redirect}`)
  }
})

test("renovación: una sesión con el acceso vencido se renueva en el proxy y mantiene identidad y destino", async () => {
  const login = await ctx.localLogin({ email: ctx.accounts.a.email, password: ctx.accounts.a.password })
  const original = readSession(login.cookies)
  const expired = withExpiredAccess(login.cookies)
  const page = await ctx.request("/shelves?vista=lista", { cookies: expired })
  assert.equal(page.status, 200, "El proxy renueva con el refresh token real y sirve la página.")
  assert.equal(page.headers.get("cache-control"), "private, no-store", "Una respuesta que renueva cookies no es cacheable.")
  const renewedCookies = applySetCookies(expired, page.setCookies)
  const renewed = readSession(renewedCookies)
  assert.equal(renewed?.user?.id, ctx.accounts.a.id)
  assert.notEqual(renewed.refresh_token, original.refresh_token, "GoTrue rota el refresh token.")
  assert.ok(renewed.expires_at > Math.floor(Date.now() / 1000), "El acceso renovado está vigente.")
  const summary = await ctx.action("getLibrarySummaryAction", [], { cookies: renewedCookies })
  assert.equal(summary.status, 200)
  assert.equal(summary.thrown, false)
})

test("cierre: el logout de GoTrue invalida la sesión y sus cookies vuelven al acceso con el destino", async () => {
  const login = await ctx.localLogin({ email: ctx.accounts.a.email, password: ctx.accounts.a.password })
  const session = readSession(login.cookies)
  assert.equal((await ctx.request("/settings", { cookies: login.cookies })).status, 200)
  // El cierre de la app (AuthProvider.signOut) llama a este mismo endpoint de GoTrue y vacía las cookies.
  const logout = await fetch(`${ctx.env.SUPABASE_URL}/auth/v1/logout?scope=local`, {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { apikey: ctx.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
  })
  assert.equal(logout.status, 204)
  const stale = await ctx.request("/settings?seccion=exportar", { cookies: withExpiredAccess(login.cookies) })
  assert.equal(stale.status, 307, "Una renovación revocada vuelve al acceso.")
  assert.equal(new URL(stale.location, ctx.appUrl).pathname, "/login")
  assert.equal(loginTarget(stale.location), "/settings?seccion=exportar")
  assert.equal(stale.headers.get("cache-control"), "private, no-store")
  assert.ok((await anon().auth.refreshSession({ refresh_token: session.refresh_token })).error, "El refresh token cerrado se rechaza.")
  const anonymous = await ctx.request("/settings")
  assert.equal(anonymous.status, 307)
})

test("callback PKCE real: GoTrue → /auth/callback con destino interno fija la sesión y redirige", async () => {
  const { callback, cookies } = await ctx.pkceCallback("a", "/books?status=reading")
  assert.equal(callback.origin, ctx.appUrl)
  assert.equal(callback.pathname, "/auth/callback")
  assert.ok(callback.searchParams.get("code"), "GoTrue entrega un código PKCE, no tokens en la URL.")
  const response = await ctx.request(`${callback.pathname}${callback.search}`, { cookies })
  assert.equal(response.status, 303)
  assert.equal(response.location, "/books?status=reading")
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  const jar = applySetCookies(cookies, response.setCookies)
  assert.equal(readSession(jar)?.user?.id, ctx.accounts.a.id)
  assert.equal((await ctx.request("/books?status=reading", { cookies: jar })).status, 200)
  const replay = await ctx.request(`${callback.pathname}${callback.search}`, { cookies })
  assert.equal(replay.status, 303)
  assert.equal(new URL(replay.location, ctx.appUrl).pathname, "/login", "Un código ya canjeado no vuelve a abrir sesión.")
})

test("callback PKCE real: destino externo, // y /\\ se descartan aunque el código sea válido", async () => {
  for (const next of ["https://externo.invalid/robar", "//externo.invalid/robar", "/\\externo.invalid/robar"]) {
    const { callback, cookies } = await ctx.pkceCallback("b", next)
    const response = await ctx.request(`${callback.pathname}${callback.search}`, { cookies })
    assert.equal(response.status, 303, `next=${next}`)
    assert.equal(response.location, "/", `next=${next} debe volver a la portada`)
    assert.equal(readSession(applySetCookies(cookies, response.setCookies))?.user?.id, ctx.accounts.b.id)
  }
})

test("callback sin código o con error del proveedor vuelve al acceso sin sesión", async () => {
  for (const query of ["?next=%2Fbooks", "?code=invalido&next=%2Fbooks", "?error=access_denied&code=x&next=%2Fbooks"]) {
    const response = await ctx.request(`/auth/callback${query}`)
    assert.equal(response.status, 303)
    assert.equal(response.location, "/login?error=oauth&redirect=%2Fbooks")
    assert.equal(response.setCookies.filter((header) => /^sb-.+-auth-token=[^;]/.test(header)).length, 0)
  }
})

import { createServerClient } from "@supabase/ssr"
import { BiblibError, EXIT } from "../../../../scripts/lib/exit-codes.mjs"
import { loadCensus, resolveSeedTarget } from "../../../../scripts/db/seed-local.mjs"
import { readFixtureStore } from "../../../../scripts/db/fixture-store.mjs"
import { closeConnection, connect } from "../../../../scripts/db/target.mjs"
import { cookieHeader, decodeActionResponse, loadActions } from "../../lib/app.mjs"
import { applySetCookies } from "../../lib/sessions.mjs"

// Contexto del grupo security (U-OPS-04): GoTrue, Postgres, Mailpit y la app compilada del perfil
// scratch o test. Las sesiones nacen en GoTrue real (formulario local, OTP con PKCE o el SDK) y viajan
// en cookies SSR como en el navegador. Nunca se imprimen cookies ni tokens; nada sale a Internet.

export const PROFILES = ["scratch", "test"]
export const AUTH_COOKIE = /^sb-.+-auth-token(\.\d+)?$/

export function securityProfile() {
  const profile = process.env.BIBLIB_PROFILE || "scratch"
  if (!PROFILES.includes(profile)) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo security solo usa los perfiles scratch o test.")
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo security solo admite BIBLIB_TARGET=local.")
  if (!/^[0-9a-f]{12}$/.test(process.env.BIBLIB_SECURITY_RUN_ID ?? "")) throw new BiblibError(EXIT.INVALID_ARGS, "suite", "Ejecuta el grupo con pnpm test:integration:security.")
  return profile
}

/** Tarro de cookies con el mismo cliente SSR que la app; sirve para OTP/PKCE y para leer la sesión. */
export function cookieClient(env) {
  const jar = new Map()
  const client = createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false },
    cookies: {
      getAll: () => [...jar.values()].map(({ name, value }) => ({ name, value })),
      setAll: (items) => { for (const item of items) jar.set(item.name, item) },
    },
  })
  return { client, cookies: () => [...jar.values()].filter((cookie) => cookie.value !== "").map(({ name, value }) => ({ name, value })) }
}

export async function securityContext() {
  const profile = securityProfile()
  const resolved = await resolveSeedTarget(profile)
  const store = readFixtureStore(resolved, loadCensus())
  if (!store?.accounts?.a?.id || !store?.accounts?.b?.id || store.phase !== "completado") throw new BiblibError(EXIT.SEED_FAILED, "suite", `Faltan fixtures A/B completos; ejecuta pnpm db:seed:local --profile ${profile}.`)
  const env = resolved.target.env()
  const { host, port } = resolved.stack.profile.app
  const appUrl = `http://${host}:${port}`
  const sql = connect(resolved, { applicationName: "biblib-security-tests" })
  const ctx = {
    profile, resolved, env, sql, appUrl,
    accounts: { a: store.accounts.a, b: store.accounts.b },
    mailpitUrl: `http://127.0.0.1:${resolved.stack.profile.ports.mailpit}`,
    actions: loadActions(resolved.stack.root),
    /** Sesión real de GoTrue con el SDK SSR, reutilizando el stack ya acreditado (sin repetir la consulta a Docker). */
    async signIn(as) {
      const account = ctx.accounts[as]
      const { client, cookies } = cookieClient(env)
      const { data, error } = await client.auth.signInWithPassword({ email: account.email, password: account.password })
      if (error || !data.session || data.user?.id !== account.id) throw new BiblibError(EXIT.VERIFICATION_FAILED, "sesión", "GoTrue no validó la sesión del fixture registrado.")
      return { client, session: data.session, user: data.user, cookies }
    },
    /** Petición a la app con cookies SSR; nunca sigue redirecciones. */
    async request(route, { cookies = [], method = "GET", headers = {}, body } = {}) {
      const response = await fetch(`${appUrl}${route}`, { method, body, redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { ...headers, Cookie: cookieHeader(cookies) } })
      const buffer = Buffer.from(await response.arrayBuffer())
      return { status: response.status, headers: response.headers, location: response.headers.get("location"), setCookies: response.headers.getSetCookie(), text: buffer.toString("utf8"), buffer }
    },
    /** Server Action por HTTP; `route` permite enviar la acción a la página que la contiene. */
    async action(name, args, { cookies = [], route } = {}) {
      const action = ctx.actions.get(name)
      if (!action) throw new BiblibError(EXIT.VERIFICATION_FAILED, "app", `La acción ${name} no está en el build.`)
      const response = await ctx.request(route ?? action.route, {
        cookies, method: "POST", body: JSON.stringify(args),
        headers: { "Next-Action": action.id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Origin: appUrl },
      })
      const decoded = response.status === 200 && (response.headers.get("content-type") ?? "").startsWith("text/x-component") ? decodeActionResponse(response.buffer) : { value: undefined, thrown: false }
      return { ...response, ...decoded }
    },
    /**
     * Acceso por el formulario local (U-LOC-01): la acción recibe un FormData igual que desde el
     * navegador (codificación multipart de React: campos `_1_*` y, al final, la raíz `0` con la referencia `$K1`).
     */
    async localLogin({ email, password, redirect }) {
      const action = ctx.actions.get("signInWithLocalPasswordAction")
      if (!action) throw new BiblibError(EXIT.VERIFICATION_FAILED, "app", "El build no contiene el acceso local; compílalo para local.")
      const form = new FormData()
      form.set("_1_email", email)
      form.set("_1_password", password)
      if (redirect !== undefined) form.set("_1_redirect", redirect)
      // React añade la raíz al final y el servidor recorre los campos referenciados en orden.
      form.set("0", JSON.stringify(["$K1"]))
      const response = await fetch(`${appUrl}/login`, {
        method: "POST", body: form, redirect: "manual", signal: AbortSignal.timeout(30_000),
        headers: { "Next-Action": action.id, Accept: "text/x-component", Origin: appUrl },
      })
      const buffer = Buffer.from(await response.arrayBuffer())
      const decoded = response.status === 200 ? decodeActionResponse(buffer) : { value: undefined, thrown: false }
      const setCookies = response.headers.getSetCookie()
      return { status: response.status, headers: response.headers, setCookies, cookies: applySetCookies([], setCookies), ...decoded }
    },
    /**
     * Enlace real de acceso con PKCE: OTP de GoTrue capturado por Mailpit y verificado en GoTrue, que
     * redirige al callback de la app con `code`. Devuelve la URL del callback y el tarro con el verificador.
     */
    async pkceCallback(as, next) {
      const { client, cookies } = cookieClient(env)
      const email = ctx.accounts[as].email
      const redirectTo = `${appUrl}/auth/callback?next=${encodeURIComponent(next)}`
      let sentAfter, error
      // GoTrue local limita a un correo por segundo y usuario (auth.email.max_frequency): reintento acotado.
      for (let attempt = 0; attempt < 5; attempt++) {
        sentAfter = Date.now()
        ;({ error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } }))
        if (error?.status !== 429) break
        await new Promise((resolve) => setTimeout(resolve, 1200))
      }
      if (error) throw new Error(`GoTrue no envió el enlace (${error.status ?? "sin estado"}).`)
      const link = await ctx.waitForMagicLink(email, sentAfter)
      const verified = await fetch(link, { redirect: "manual", signal: AbortSignal.timeout(10_000) })
      const location = verified.headers.get("location")
      if (verified.status !== 303 || !location) throw new Error(`GoTrue no redirigió al callback (${verified.status}).`)
      return { callback: new URL(location), cookies: cookies() }
    },
    async waitForMagicLink(email, sentAfter) {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const search = await (await fetch(`${ctx.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=5`, { signal: AbortSignal.timeout(5000) })).json()
        const message = (search.messages ?? []).find((item) => Date.parse(item.Created) >= sentAfter - 1000)
        if (message) {
          const body = await (await fetch(`${ctx.mailpitUrl}/api/v1/message/${message.ID}`, { signal: AbortSignal.timeout(5000) })).json()
          const raw = /https?:\/\/[^\s"<>]+\/auth\/v1\/verify\?[^\s"<>]+/.exec(`${body.Text ?? ""} ${body.HTML ?? ""}`)?.[0]
          if (raw) {
            const link = new URL(raw.replace(/&amp;/g, "&"))
            if (link.origin !== env.SUPABASE_URL) throw new Error("El enlace de acceso no apunta al GoTrue del perfil.")
            return link
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      throw new Error("Mailpit no recibió el enlace de acceso a tiempo.")
    },
    close: () => closeConnection(sql),
  }
  return ctx
}

export function authCookies(cookies) {
  return cookies.filter((cookie) => AUTH_COOKIE.test(cookie.name))
}

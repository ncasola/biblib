import { signInFixture } from "../support/session.mjs"
import { PROFILE } from "./context.mjs"

// Sesiones reales de GoTrue (signInWithPassword vía tests/integration/support) y utilidades para
// leer o envejecer la sesión que guardan las cookies SSR. Nunca se fabrican ni imprimen tokens:
// solo se cambia `expires_at`, el dato del cliente que decide cuándo renovar con el refresh real.

const open = new Set()

export async function signIn(as) {
  const fixture = await signInFixture(as, { profile: PROFILE })
  open.add(fixture.client)
  return fixture
}

/** Cierra (scope local) las sesiones abiertas por este proceso que sigan activas. */
export async function signOutAll() {
  for (const client of open) await client.auth.signOut({ scope: "local" }).catch(() => {})
  open.clear()
}

export function liveCookies(fixture) {
  return fixture.cookies().filter((cookie) => cookie.value !== "").map(({ name, value }) => ({ name, value }))
}

/** Agrupa una cookie de sesión, entera o fragmentada (`.0`, `.1`…), por su nombre base. */
function sessionCookie(cookies) {
  const base = cookies.map((c) => c.name.replace(/\.\d+$/, "")).find((name) => /^sb-.+-auth-token$/.test(name))
  if (!base) return null
  const whole = cookies.find((c) => c.name === base)
  if (whole) return { base, value: whole.value }
  const chunks = cookies.filter((c) => c.name.startsWith(`${base}.`)).sort((x, y) => Number(x.name.slice(base.length + 1)) - Number(y.name.slice(base.length + 1)))
  return { base, value: chunks.map((c) => c.value).join("") }
}

export function readSession(cookies) {
  const cookie = sessionCookie(cookies)
  if (!cookie?.value) return null
  const raw = cookie.value.startsWith("base64-") ? Buffer.from(cookie.value.slice(7), "base64url").toString("utf8") : cookie.value
  try { return JSON.parse(raw) } catch { return null }
}

/** Misma sesión, pero vencida para el cliente: el SDK del servidor deberá renovarla con GoTrue. */
export function withExpiredAccess(cookies) {
  const cookie = sessionCookie(cookies)
  const session = readSession(cookies)
  if (!cookie || !session) throw new Error("No hay sesión SSR que envejecer.")
  session.expires_at = Math.floor(Date.now() / 1000) - 120
  const value = `base64-${Buffer.from(JSON.stringify(session), "utf8").toString("base64url")}`
  return [...cookies.filter((c) => c.name !== cookie.base && !c.name.startsWith(`${cookie.base}.`)), { name: cookie.base, value }]
}

/** Aplica las Set-Cookie de una respuesta de la app a un tarro de cookies. */
export function applySetCookies(cookies, headers) {
  const jar = new Map(cookies.map((c) => [c.name, c.value]))
  for (const header of headers) {
    const pair = header.split(";", 1)[0]
    const index = pair.indexOf("=")
    const name = pair.slice(0, index).trim()
    const value = decodeURIComponent(pair.slice(index + 1).trim())
    const expired = /;\s*max-age=0/i.test(header) || /;\s*expires=Thu, 01 Jan 1970/i.test(header)
    if (!value || expired) jar.delete(name)
    else jar.set(name, value)
  }
  return [...jar].map(([name, value]) => ({ name, value }))
}

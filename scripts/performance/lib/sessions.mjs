import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createServerClient } from "@supabase/ssr"
import { BiblibError, EXIT } from "../../lib/exit-codes.mjs"
import { REPO_ROOT } from "../../lib/profiles.mjs"
import { readFixtureStore } from "../../db/fixture-store.mjs"
import { scaleCensus, scaleResolved } from "../scale-seed.mjs"

// Sesiones reales de GoTrue para la medición. GoTrue limita `sign_in_sign_ups` a 30 cada 5 minutos por IP:
// las sesiones se abren una sola vez por ejecución y se reutilizan en los tres tamaños. Un registro de
// marcas de tiempo (sin tokens) en `.biblib/performance/signins.json` hace respetar el límite entre ejecuciones.

const WINDOW_MS = 5 * 60_000
const SIGNIN_BUDGET = 24
const LEDGER = path.join(REPO_ROOT, ".biblib", "performance", "signins.json")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readLedger() {
  try { return JSON.parse(readFileSync(LEDGER, "utf8")).filter((at) => Date.now() - at < WINDOW_MS) } catch { return [] }
}

/** Espera a que quepan `needed` accesos más en la ventana de 5 minutos y los anota. */
async function reserveSignIns(needed) {
  for (;;) {
    const recent = readLedger()
    if (recent.length + needed <= SIGNIN_BUDGET) {
      mkdirSync(path.dirname(LEDGER), { recursive: true, mode: 0o700 })
      writeFileSync(LEDGER, JSON.stringify([...recent, ...Array(needed).fill(Date.now())]), { mode: 0o600 })
      return
    }
    await sleep(Math.max(1000, WINDOW_MS - (Date.now() - Math.min(...recent)) + 500))
  }
}

export function cookieHeader(cookies) {
  return cookies.filter((c) => c.value !== "").map(({ name, value }) => `${name}=${value}`).join("; ")
}

/** Aplica las Set-Cookie de una respuesta (renovaciones del proxy) para no reutilizar un refresh token ya rotado. */
export function applySetCookies(session, headers) {
  if (!headers?.length) return
  const jar = new Map(session.cookies.map((c) => [c.name, c.value]))
  for (const header of headers) {
    const pair = header.split(";", 1)[0]
    const index = pair.indexOf("=")
    const name = pair.slice(0, index).trim()
    const value = decodeURIComponent(pair.slice(index + 1).trim())
    if (!value || /;\s*max-age=0/i.test(header)) jar.delete(name)
    else jar.set(name, value)
  }
  session.cookies = [...jar].map(([name, value]) => ({ name, value }))
}

async function signIn(ctx, label, email, password, expectedId) {
  const values = ctx.env
  const jar = new Map()
  const client = createServerClient(values.SUPABASE_URL, values.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false },
    cookies: { getAll: () => [...jar.values()].map(({ name, value }) => ({ name, value })), setAll: (items) => { for (const item of items) jar.set(item.name, item) } },
  })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error || !data.session || data.user?.id !== expectedId) throw new BiblibError(EXIT.VERIFICATION_FAILED, "sesión", `GoTrue no validó la sesión ${label}.`)
  return { label, userId: data.user.id, client, accessToken: data.session.access_token, cookies: [...jar.values()].filter((c) => c.value !== "").map(({ name, value }) => ({ name, value })) }
}

/** Cuenta de escala (N sesiones) y cuentas A/B (1 cada una). Los secretos permanecen en este proceso. */
export async function openSessions(ctx, { escala = 10, ab = true } = {}) {
  const scaleStore = readFixtureStore(scaleResolved(ctx.resolved), scaleCensus(ctx.census))
  const account = scaleStore?.accounts?.escala
  if (!account?.id) throw new BiblibError(EXIT.SEED_FAILED, "sesión", "Falta la cuenta de escala; ejecuta pnpm db:seed:local --profile test --scale 10000.")
  await reserveSignIns(escala + (ab ? 2 : 0))
  const sessions = { escala: [], a: null, b: null, scaleUserId: account.id, close: async () => {} }
  for (let i = 0; i < escala; i++) sessions.escala.push(await signIn(ctx, `escala-${i + 1}`, account.email, account.password, account.id))
  if (ab) {
    sessions.a = await signIn(ctx, "A", ctx.store.accounts.a.email, ctx.store.accounts.a.password, ctx.users.a)
    sessions.b = await signIn(ctx, "B", ctx.store.accounts.b.email, ctx.store.accounts.b.password, ctx.users.b)
  }
  sessions.close = async () => {
    for (const session of [...sessions.escala, sessions.a, sessions.b].filter(Boolean)) await session.client.auth.signOut({ scope: "local" }).catch(() => {})
  }
  return sessions
}

export const ledgerExists = () => existsSync(LEDGER)

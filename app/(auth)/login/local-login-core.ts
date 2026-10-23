// Lógica pura del acceso local con contraseña. No importa Next ni Supabase: la acción
// de servidor le inyecta el cliente, de modo que la guarda y el limitador se prueban sin red.
import { getSafeRedirectPath } from "../../../lib/auth-navigation"

export const LOCAL_LOGIN_TARGETS: readonly string[] = ["local", "test"]
export const EMAIL_MAX_LENGTH = 254
export const PASSWORD_MAX_LENGTH = 128
export const FAILURE_LIMIT = 5
export const FAILURE_WINDOW_MS = 60_000

export const GENERIC_CREDENTIALS_MESSAGE = "Correo o contraseña incorrectos."
export const UNAVAILABLE_MESSAGE = "El acceso local no está disponible."

export type LocalLoginResult =
  | { ok: true; redirectTo: string }
  | { ok: false; code: "INVALID_INPUT" | "UNAUTHORIZED" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE"; message: string }

/** Segunda puerta: objetivo local/test y URL de Supabase exactamente en el loopback de un perfil. */
export function isLocalLoginServerAllowed(
  { target, supabaseUrl }: { target: string | undefined; supabaseUrl: string | undefined },
  allowedPorts: readonly number[],
): boolean {
  if (!target || !LOCAL_LOGIN_TARGETS.includes(target) || !supabaseUrl) return false
  try {
    const url = new URL(supabaseUrl)
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "" && allowedPorts.includes(Number(url.port))
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
  } catch {
    return false
  }
}

/** Puertos de API de todos los perfiles declarados en `supabase/profiles.json`. */
export function profileApiPorts(profiles: { profiles: Record<string, { ports: { api: number } }> }): number[] {
  return Object.values(profiles.profiles).map((profile) => profile.ports.api)
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type LocalLoginInput =
  | { ok: true; email: string; password: string; redirect: string }
  | { ok: false; message: string }

export function parseLocalLoginInput(form: { get(name: string): unknown }): LocalLoginInput {
  const rawEmail = form.get("email")
  const rawPassword = form.get("password")
  const email = typeof rawEmail === "string" ? rawEmail.trim() : ""
  if (!email || email.length > EMAIL_MAX_LENGTH || !EMAIL_SHAPE.test(email)) return { ok: false, message: "Introduce un correo con formato válido (máximo 254 caracteres)." }
  if (typeof rawPassword !== "string" || rawPassword.length < 1 || rawPassword.length > PASSWORD_MAX_LENGTH) return { ok: false, message: "La contraseña debe tener entre 1 y 128 caracteres." }
  const rawRedirect = form.get("redirect")
  return { ok: true, email, password: rawPassword, redirect: getSafeRedirectPath(typeof rawRedirect === "string" ? rawRedirect : null) }
}

export interface FailureLimiter {
  isBlocked(): boolean
  recordFailure(): void
  reset(): void
}

/** Ventana deslizante de intentos fallidos; el reloj es inyectable para las pruebas. */
export function createFailureLimiter({ limit = FAILURE_LIMIT, windowMs = FAILURE_WINDOW_MS, now = Date.now } = {}): FailureLimiter {
  let failures: number[] = []
  const prune = () => {
    const threshold = now() - windowMs
    failures = failures.filter((time) => time > threshold)
  }
  return {
    isBlocked() { prune(); return failures.length >= limit },
    recordFailure() { prune(); failures.push(now()) },
    reset() { failures = [] },
  }
}

export type PasswordSignIn = "ok" | "invalid" | "unavailable"

export interface LocalLoginDeps {
  target: string | undefined
  supabaseUrl: string | undefined
  allowedPorts: readonly number[]
  limiter: FailureLimiter
  /** Se invoca solo después de superar la guarda; crea el cliente SSR y llama a GoTrue local. */
  signIn(email: string, password: string): Promise<PasswordSignIn>
}

export async function authenticateLocalLogin(form: { get(name: string): unknown }, deps: LocalLoginDeps): Promise<LocalLoginResult> {
  if (!isLocalLoginServerAllowed({ target: deps.target, supabaseUrl: deps.supabaseUrl }, deps.allowedPorts)) {
    return { ok: false, code: "UNAUTHORIZED", message: UNAVAILABLE_MESSAGE }
  }
  const input = parseLocalLoginInput(form)
  if (!input.ok) return { ok: false, code: "INVALID_INPUT", message: input.message }
  if (deps.limiter.isBlocked()) {
    return { ok: false, code: "RATE_LIMITED", message: "Demasiados intentos fallidos. Espera un minuto antes de volver a probar." }
  }
  const outcome = await deps.signIn(input.email, input.password)
  if (outcome === "unavailable") {
    return { ok: false, code: "PROVIDER_UNAVAILABLE", message: "No se pudo contactar con el acceso local. Comprueba que el stack local esté en marcha." }
  }
  if (outcome === "invalid") {
    deps.limiter.recordFailure()
    return { ok: false, code: "UNAUTHORIZED", message: GENERIC_CREDENTIALS_MESSAGE }
  }
  deps.limiter.reset()
  return { ok: true, redirectTo: input.redirect }
}

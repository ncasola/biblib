"use server"

import { createClient } from "@/lib/supabase/server"
import profiles from "@/supabase/profiles.json"
import {
  authenticateLocalLogin,
  createFailureLimiter,
  profileApiPorts,
  type FailureLimiter,
  type LocalLoginResult,
  type PasswordSignIn,
} from "./local-login-core"

// El límite es por proceso; se ancla en globalThis para sobrevivir a la recarga de módulos en desarrollo.
const store = globalThis as typeof globalThis & { __biblibLocalLoginLimiter?: FailureLimiter }
const limiter = (store.__biblibLocalLoginLimiter ??= createFailureLimiter())

async function signIn(email: string, password: string): Promise<PasswordSignIn> {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    // Un fallo de red o de GoTrue no cuenta como credencial incorrecta; el resto se trata igual para no revelar si el usuario existe.
    if (error) return error.name === "AuthRetryableFetchError" || (error.status ?? 0) >= 500 ? "unavailable" : "invalid"
    return data.session ? "ok" : "invalid"
  } catch {
    return "unavailable"
  }
}

/**
 * Acceso con correo y contraseña solo para desarrollo local. La comprobación de entorno ocurre antes
 * de crear el cliente; fuera de local/test o con una URL que no sea el loopback de un perfil rechaza siempre.
 */
export async function signInWithLocalPasswordAction(formData: FormData): Promise<LocalLoginResult> {
  return authenticateLocalLogin(formData, {
    target: process.env.BIBLIB_TARGET,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    allowedPorts: profileApiPorts(profiles),
    limiter,
    signIn,
  })
}

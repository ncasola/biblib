import "server-only"
import { sql } from "drizzle-orm"
import { withRlsContext } from "@/lib/db/client"
import { createClient } from "@/lib/supabase/server"
import { isRecentSignIn, toDeletionView, type AccountDeletionView } from "@/lib/account-deletion/contracts"

// U-OPS-03 · Lado Next de la eliminación de cuenta. Solo usa la sesión del dueño: la solicitud y el estado pasan por las
// funciones de 0013 con auth.uid(), y el cierre de sesiones es el logout global de GoTrue con el token del propio
// usuario. El borrado de datos, objetos e identidad lo hace el worker administrativo fuera de Next, sin credencial de servicio en la app.

async function callOwnerFunction(owner: string, query: ReturnType<typeof sql>): Promise<unknown> {
  return withRlsContext(owner, async (tx) => (await tx.execute<{ result: unknown }>(query))[0]?.result)
}

export async function readAccountDeletion(owner: string): Promise<AccountDeletionView> {
  return toDeletionView(await callOwnerFunction(owner, sql`select biblib.account_deletion_status() as result`))
}

/** Solicitud idempotente: con cualquier clave, una cuenta ya en eliminación devuelve el mismo estado. */
export async function requestAccountDeletion(owner: string, operationKey: string): Promise<AccountDeletionView> {
  return toDeletionView(await callOwnerFunction(owner, sql`select biblib.account_deletion_request(${operationKey}) as result`))
}

/** La sesión de esta petición inició sesión hace como mucho `RECENT_SIGN_IN_MS` (JWT verificado con el JWKS de GoTrue). */
export async function hasRecentSignIn(owner: string, now = Date.now()): Promise<boolean> {
  const supabase = await createClient()
  const token = await supabase.auth.getSession().then(({ data }) => data.session?.access_token ?? "", () => "")
  if (!token) return false
  const { data, error } = await supabase.auth.getClaims(token)
  if (error || data?.claims.sub !== owner) return false
  return isRecentSignIn(data.claims.amr, now)
}

/**
 * Cierra todas las sesiones de la cuenta con el logout global de GoTrue (token del propio usuario, sin credencial de servicio).
 * Si falla, el worker bloquea la cuenta en GoTrue y, mientras tanto, RLS, Storage y el bloqueo de colección rechazan
 * cualquier escritura del JWT antiguo.
 */
export async function revokeOwnSessions(): Promise<boolean> {
  try {
    const supabase = await createClient()
    const { error } = await supabase.auth.signOut({ scope: "global" })
    return !error
  } catch {
    return false
  }
}

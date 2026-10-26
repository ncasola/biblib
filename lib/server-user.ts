import "server-only"
import { headers } from "next/headers"
import { createClient } from "@/lib/supabase/server"
import { createRequestMemo, SESSION_ATTESTATION_HEADER, verifySessionAttestation } from "@/lib/supabase/session-attestation"
import { DomainError } from "@/lib/domain-errors"
import { NONCE_HEADER } from "@/lib/security-headers"
import { telemetry, withActionCorrelation } from "@/lib/observability/server"

type ServerClient = Awaited<ReturnType<typeof createClient>>
type RequestHeaders = Awaited<ReturnType<typeof headers>>

// Una sola verificación con GoTrue por petición (U-FIX-02, T3). Si el proxy ya verificó esta sesión con
// GoTrue en la misma petición, su atestación firmada (lib/supabase/session-attestation.ts) más la
// verificación local del JWT bastan; si no la hay o no valida (rutas /api, otro proceso), `getUser()`.
// El resultado se memoiza por petición y token: varias llamadas en la misma acción no repiten la verificación.
const verifiedUsers = createRequestMemo<string>()

async function attestedUserId(supabase: ServerClient, requestHeaders: RequestHeaders, accessToken: string): Promise<string | null> {
  const attestation = verifySessionAttestation(requestHeaders.get(SESSION_ATTESTATION_HEADER), { accessToken, nonce: requestHeaders.get(NONCE_HEADER) })
  if (!attestation.ok) return null
  // Firma ES256 con el JWKS de GoTrue y caducidad, en local; el usuario sale del JWT verificado.
  const { data, error } = await supabase.auth.getClaims(accessToken)
  if (error || data?.claims.sub !== attestation.userId || data.claims.role !== "authenticated") return null
  return attestation.userId
}

async function verifyUser(supabase: ServerClient, requestHeaders: RequestHeaders, accessToken: string): Promise<string> {
  try {
    if (accessToken) {
      const attested = await attestedUserId(supabase, requestHeaders, accessToken)
      if (attested) return attested
    }
    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) {
      telemetry.emit("auth.failure", { operation: "auth.getUser", result: "error", errorCode: error ? "AUTH_FAILED" : "AUTH_NO_USER" })
      throw new DomainError("UNAUTHORIZED", "La sesión ha caducado. Inicia sesión de nuevo.")
    }
    return user.id
  } catch (error) {
    if (!(error instanceof DomainError)) telemetry.emit("auth.failure", { operation: "auth.getUser", result: "error", errorCode: "AUTH_UNAVAILABLE" })
    throw error
  }
}

export async function getRequiredUserId(): Promise<string> {
  return withActionCorrelation(async () => {
    const requestHeaders = await headers()
    const supabase = await createClient()
    // Solo lee la cookie (renueva si el acceso venció); no confía en ella: la identidad sale de verifyUser.
    // Si falla, se sigue sin token y verifyUser consulta a GoTrue, que decide y registra el fallo.
    const accessToken = await supabase.auth.getSession().then(({ data }) => data.session?.access_token ?? "", () => "")
    return verifiedUsers(requestHeaders, accessToken, () => verifyUser(supabase, requestHeaders, accessToken))
  })
}

import "server-only"
import { createClient } from "@/lib/supabase/server"
import { DomainError } from "@/lib/domain-errors"
import { telemetry, withActionCorrelation } from "@/lib/observability/server"

export async function getRequiredUserId(): Promise<string> {
  return withActionCorrelation(async () => {
    try {
      const supabase = await createClient()
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
  })
}

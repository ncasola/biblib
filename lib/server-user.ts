import "server-only"
import { createClient } from "@/lib/supabase/server"
import { DomainError } from "@/lib/domain-errors"

export async function getRequiredUserId(): Promise<string> {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) throw new DomainError("UNAUTHORIZED", "La sesión ha caducado. Inicia sesión de nuevo.")
  return user.id
}

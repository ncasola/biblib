"use server"

import { z } from "zod"
import type { ActionResult } from "@/lib/action-result"
import { DELETION_CONFIRMATION, OPERATION_KEY_PATTERN, type AccountDeletionView } from "@/lib/account-deletion/contracts"
import { hasRecentSignIn, readAccountDeletion, requestAccountDeletion, revokeOwnSessions } from "@/lib/account-deletion/server"
import { DomainError, translateDatabaseError } from "@/lib/domain-errors"
import { telemetry } from "@/lib/observability/server"
import { domainMutation } from "@/lib/server-action"
import { getRequiredUserId } from "@/lib/server-user"

// U-OPS-03 · Eliminación de la cuenta de la sesión. La cuenta sale siempre de la sesión verificada: el cliente no envía
// ningún ID. Doble clic o reintento devuelven el mismo estado; la eliminación la ejecuta el worker administrativo.

const requestSchema = z.strictObject({ confirmation: z.string().max(100), operationKey: z.string().regex(OPERATION_KEY_PATTERN) })

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (error) { translateDatabaseError(error) }
}

export async function getAccountDeletionStatusAction(): Promise<ActionResult<AccountDeletionView>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    return guarded(() => readAccountDeletion(owner))
  })
}

export async function requestAccountDeletionAction(input: { confirmation: string; operationKey: string }): Promise<ActionResult<AccountDeletionView>> {
  return domainMutation(async () => {
    const owner = await getRequiredUserId()
    const parsed = requestSchema.safeParse(input)
    if (!parsed.success) throw new DomainError("INVALID_INPUT", "La solicitud no es válida. Vuelve a abrir la confirmación.")
    if (parsed.data.confirmation.trim().toLocaleUpperCase("es") !== DELETION_CONFIRMATION) {
      throw new DomainError("INVALID_INPUT", `Para confirmar, escribe exactamente «${DELETION_CONFIRMATION}».`)
    }
    const current = await guarded(() => readAccountDeletion(owner))
    // Una solicitud ya registrada se devuelve tal cual (doble clic, respuesta perdida): no exige volver a entrar.
    if (current.phase !== "none") return current
    if (!await hasRecentSignIn(owner)) {
      throw new DomainError("REAUTH_REQUIRED", "Por seguridad, vuelve a iniciar sesión y confirma la eliminación en los 15 minutos siguientes.")
    }
    const view = await guarded(() => requestAccountDeletion(owner, parsed.data.operationKey))
    const sessionsRevoked = await revokeOwnSessions()
    telemetry.emit("account.deletion", { operation: "account.deletion.request", result: "ok" })
    if (!sessionsRevoked) telemetry.emit("account.deletion", { operation: "account.deletion.revoke", result: "unavailable" })
    return { ...view, sessionsRevoked }
  })
}

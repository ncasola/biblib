import { accountInactive, databaseErrorCode, DomainError, isRetryable, type DomainErrorCode } from "./domain-errors"

export interface ActionError {
  code: DomainErrorCode
  message: string
  /** Solo los fallos transitorios pueden reintentarse sin volver a revisar. */
  retryable: boolean
  /** Identificador opaco para relacionar el fallo con los registros; nunca contiene datos. */
  correlationId?: string
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: ActionError }

export interface MutationContext {
  /** Lee el `correlationId` activo; se inyecta desde el servidor para no arrastrar módulos de Node al navegador. */
  correlation?: () => string | undefined
}

export function actionError(code: DomainErrorCode, message: string, correlationId?: string): ActionError {
  return { code, message, retryable: isRetryable(code), ...(correlationId ? { correlationId } : {}) }
}

/** Los fallos esperados viajan como datos; Next oculta los errores lanzados en producción. */
export async function mutationResult<T>(operation: () => Promise<T>, context: MutationContext = {}): Promise<ActionResult<T>> {
  try { return { ok: true, value: await operation() } }
  catch (error) {
    const correlationId = context.correlation?.()
    if (error instanceof DomainError) return { ok: false, error: actionError(error.code, error.message, correlationId) }
    // Una escritura sin traducir de una cuenta en eliminación (BD001) nunca se presenta como un fallo transitorio.
    if (databaseErrorCode(error) === "BD001") { const inactive = accountInactive(); return { ok: false, error: actionError(inactive.code, inactive.message, correlationId) } }
    console.error(JSON.stringify({ event: "mutation.failed", code: "UNEXPECTED_ERROR", ...(correlationId ? { correlationId } : {}) }))
    return { ok: false, error: actionError("PROVIDER_UNAVAILABLE", "No se pudo guardar el cambio. Inténtalo de nuevo.", correlationId) }
  }
}

export function unwrapAction<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new DomainError(result.error.code, result.error.message)
  return result.value
}

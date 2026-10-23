import "server-only"
import { mutationResult, type ActionResult } from "@/lib/action-result"
import { getCorrelationId } from "@/lib/observability/correlation"
import { withActionCorrelation } from "@/lib/observability/server"

/** Mutación de dominio con contexto de correlación: los errores llevan `retryable` y `correlationId`. */
export function domainMutation<T>(operation: () => Promise<T>): Promise<ActionResult<T>> {
  return withActionCorrelation(() => mutationResult(operation, { correlation: getCorrelationId }))
}

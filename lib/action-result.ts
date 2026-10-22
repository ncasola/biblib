import { DomainError, type DomainErrorCode } from "./domain-errors"

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: { code: DomainErrorCode; message: string } }

/** Los fallos esperados viajan como datos; Next oculta los errores lanzados en producción. */
export async function mutationResult<T>(operation: () => Promise<T>): Promise<ActionResult<T>> {
  try { return { ok: true, value: await operation() } }
  catch (error) {
    if (error instanceof DomainError) return { ok: false, error: { code: error.code, message: error.message } }
    console.error(JSON.stringify({ event: "mutation.failed", code: "UNEXPECTED_ERROR" }))
    return { ok: false, error: { code: "PROVIDER_UNAVAILABLE", message: "No se pudo guardar el cambio. Inténtalo de nuevo." } }
  }
}

export function unwrapAction<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new DomainError(result.error.code, result.error.message)
  return result.value
}

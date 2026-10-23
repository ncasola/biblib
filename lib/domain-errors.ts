export type DomainErrorCode =
  | "INVALID_INPUT" | "UNAUTHORIZED" | "NOT_FOUND" | "CONFLICT" | "PROVIDER_UNAVAILABLE" | "RATE_LIMITED"
  | "REVISION_CONFLICT" | "PREVIEW_EXPIRED" | "IDEMPOTENCY_CONFLICT" | "JOB_CONFLICT" | "JOB_EXPIRED" | "LIMIT_EXCEEDED"

/**
 * Solo los fallos transitorios admiten reintento automático. Un conflicto de revisión, una
 * vista previa caducada o una clave reutilizada exigen que la persona vuelva a revisar.
 */
const RETRYABLE: Readonly<Record<DomainErrorCode, boolean>> = {
  INVALID_INPUT: false,
  UNAUTHORIZED: false,
  NOT_FOUND: false,
  CONFLICT: false,
  PROVIDER_UNAVAILABLE: true,
  RATE_LIMITED: true,
  REVISION_CONFLICT: false,
  PREVIEW_EXPIRED: false,
  IDEMPOTENCY_CONFLICT: false,
  JOB_CONFLICT: false,
  JOB_EXPIRED: false,
  LIMIT_EXCEEDED: false,
}

export function isRetryable(code: DomainErrorCode): boolean {
  return RETRYABLE[code]
}

/** Traducción HTTP del contrato transversal de 02: 409 conflicto, 410 vista previa o trabajo caducados, 413 límite agotado. */
const HTTP_STATUS: Readonly<Record<DomainErrorCode, number>> = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PROVIDER_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  REVISION_CONFLICT: 409,
  PREVIEW_EXPIRED: 410,
  IDEMPOTENCY_CONFLICT: 409,
  JOB_CONFLICT: 409,
  JOB_EXPIRED: 410,
  LIMIT_EXCEEDED: 413,
}

export function httpStatusForDomainError(code: DomainErrorCode): number {
  return HTTP_STATUS[code]
}

export class DomainError extends Error {
  constructor(public readonly code: DomainErrorCode, message: string) {
    super(message)
    this.name = "DomainError"
  }
}

export function revisionConflict(): DomainError {
  return new DomainError("REVISION_CONFLICT", "Tu biblioteca ha cambiado desde que preparaste esta revisión. No se ha aplicado nada: vuelve a revisar el archivo con los datos actuales.")
}

export function previewExpired(): DomainError {
  return new DomainError("PREVIEW_EXPIRED", "La revisión de la importación ha caducado. Vuelve a prepararla para comprobar los datos actuales.")
}

export function idempotencyConflict(): DomainError {
  return new DomainError("IDEMPOTENCY_CONFLICT", "Esta confirmación ya se usó con otro archivo o modo de importación. No se ha aplicado nada; prepara una revisión nueva.")
}

/** El trabajo cambió de estado o de versión: hay que consultar su estado actual antes de repetir la acción. */
export function jobConflict(message = "El trabajo ha cambiado desde la última consulta. Revisa su estado actual antes de repetir la acción."): DomainError {
  return new DomainError("JOB_CONFLICT", message)
}

export function jobExpired(): DomainError {
  return new DomainError("JOB_EXPIRED", "El trabajo ha caducado y ya no se puede continuar. Su resultado confirmado se conserva; inicia uno nuevo si lo necesitas.")
}

export function databaseErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  if ("code" in error && typeof error.code === "string") return error.code
  return "cause" in error ? databaseErrorCode(error.cause) : undefined
}

export function translateDatabaseError(error: unknown): never {
  if (error instanceof DomainError) throw error
  if (databaseErrorCode(error) === "23505") throw new DomainError("CONFLICT", "Ya existe un libro con ese ISBN o una estantería con ese nombre.")
  if (databaseErrorCode(error) === "23503") throw new DomainError("CONFLICT", "La estantería ha cambiado. Actualiza los datos e inténtalo de nuevo.")
  if (databaseErrorCode(error) === "40P01") throw new DomainError("PROVIDER_UNAVAILABLE", "Otra operación estaba modificando tu biblioteca. No se ha aplicado nada; inténtalo de nuevo.")
  throw new DomainError("PROVIDER_UNAVAILABLE", "No se pudo guardar el cambio. Inténtalo de nuevo.")
}

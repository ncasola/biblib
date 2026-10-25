export type DomainErrorCode =
  | "INVALID_INPUT" | "UNAUTHORIZED" | "NOT_FOUND" | "CONFLICT" | "PROVIDER_UNAVAILABLE" | "RATE_LIMITED"
  | "REVISION_CONFLICT" | "PREVIEW_EXPIRED" | "IDEMPOTENCY_CONFLICT" | "JOB_CONFLICT" | "JOB_EXPIRED" | "LIMIT_EXCEEDED" | "MANIFEST_MISMATCH" | "ASSET_REJECTED"
  | "EDITION_SHARED" | "ACCOUNT_INACTIVE" | "REAUTH_REQUIRED"

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
  MANIFEST_MISMATCH: false,
  ASSET_REJECTED: false,
  EDITION_SHARED: false,
  ACCOUNT_INACTIVE: false,
  REAUTH_REQUIRED: false,
}

export function isRetryable(code: DomainErrorCode): boolean {
  return RETRYABLE[code]
}

/** Traducción HTTP del contrato transversal de 02: 409 conflicto, 410 vista previa o trabajo caducados, 413 límite agotado, 422 conjunto de partes incoherente o imagen rechazada. */
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
  MANIFEST_MISMATCH: 422,
  ASSET_REJECTED: 422,
  // U-DAT-06: el cambio afecta a varios ejemplares de una edición y la persona no lo ha confirmado.
  EDITION_SHARED: 409,
  // U-OPS-03: la cuenta se está eliminando (también con un JWT anterior a revocar las sesiones).
  ACCOUNT_INACTIVE: 403,
  // Confirmar la eliminación exige haber iniciado sesión hace poco.
  REAUTH_REQUIRED: 401,
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

export function idempotencyConflict(message = "Esta confirmación ya se usó con otro archivo o modo de importación. No se ha aplicado nada; prepara una revisión nueva."): DomainError {
  return new DomainError("IDEMPOTENCY_CONFLICT", message)
}

/** El trabajo cambió de estado o de versión: hay que consultar su estado actual antes de repetir la acción. */
export function jobConflict(message = "El trabajo ha cambiado desde la última consulta. Revisa su estado actual antes de repetir la acción."): DomainError {
  return new DomainError("JOB_CONFLICT", message)
}

export function jobExpired(): DomainError {
  return new DomainError("JOB_EXPIRED", "El trabajo ha caducado y ya no se puede continuar. Su resultado confirmado se conserva; inicia uno nuevo si lo necesitas.")
}

/** Cambiar una edición compartida exige confirmar cuántos ejemplares cambian. */
export function editionShared(copies: number): DomainError {
  return new DomainError("EDITION_SHARED", `Estos datos son de la edición, que comparten ${copies} ejemplares de tu biblioteca: si los guardas, cambiarán en todos. Confírmalo para continuar.`)
}

/** BD001 (0013): cualquier escritura de una cuenta en eliminación, desde las políticas RLS o el bloqueo de colección. */
export function accountInactive(): DomainError {
  return new DomainError("ACCOUNT_INACTIVE", "Tu cuenta se está eliminando y ya no admite cambios. No se ha guardado nada.")
}

export function databaseErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  if ("code" in error && typeof error.code === "string") return error.code
  return "cause" in error ? databaseErrorCode(error.cause) : undefined
}

export function translateDatabaseError(error: unknown): never {
  if (error instanceof DomainError) throw error
  if (databaseErrorCode(error) === "BD001") throw accountInactive()
  if (databaseErrorCode(error) === "23505") throw new DomainError("CONFLICT", "Ya existe una edición con ese ISBN o una estantería con ese nombre.")
  if (databaseErrorCode(error) === "BM003") throw new DomainError("EDITION_SHARED", "Esa edición la comparten varios ejemplares: cámbiala desde la ficha, confirmando cuántos ejemplares afecta.")
  if (databaseErrorCode(error) === "23503") throw new DomainError("CONFLICT", "La estantería ha cambiado. Actualiza los datos e inténtalo de nuevo.")
  if (databaseErrorCode(error) === "40P01") throw new DomainError("PROVIDER_UNAVAILABLE", "Otra operación estaba modificando tu biblioteca. No se ha aplicado nada; inténtalo de nuevo.")
  throw new DomainError("PROVIDER_UNAVAILABLE", "No se pudo guardar el cambio. Inténtalo de nuevo.")
}

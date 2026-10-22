export type DomainErrorCode = "INVALID_INPUT" | "UNAUTHORIZED" | "NOT_FOUND" | "CONFLICT" | "PROVIDER_UNAVAILABLE" | "RATE_LIMITED"

export class DomainError extends Error {
  constructor(public readonly code: DomainErrorCode, message: string) {
    super(message)
    this.name = "DomainError"
  }
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
  throw new DomainError("PROVIDER_UNAVAILABLE", "No se pudo guardar el cambio. Inténtalo de nuevo.")
}

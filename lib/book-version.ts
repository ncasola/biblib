import { DomainError } from "./domain-errors"
import { uuidSchema } from "./book-validation"

export function bookVersionConflict(): DomainError {
  return new DomainError("CONFLICT", "Esta ficha ha cambiado desde que la abriste. Conserva tus cambios y carga la versión actual antes de guardar.")
}

/** Se comprueba bajo bloqueo y también después de cualquier consulta externa. */
export function assertBookVersion(current: { version?: string }, expected: unknown): void {
  if (!uuidSchema.safeParse(expected).success || current.version !== expected) {
    throw bookVersionConflict()
  }
}

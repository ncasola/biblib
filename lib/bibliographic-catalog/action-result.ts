import { actionError, type ActionResult } from "../action-result"
import { DomainError } from "../domain-errors"
import type { CatalogLookupResult } from "./types"

/** Extensión compatible: los fallos conservan el diagnóstico en value. */
export type BibliographyActionResult<T> = ActionResult<CatalogLookupResult<T>> & { value?: CatalogLookupResult<T> }

export function catalogResultError<T>(result: CatalogLookupResult<T>): DomainError | undefined {
  if (result.status === "found") return undefined
  if (result.status === "notFound") return new DomainError("NOT_FOUND", "No se ha encontrado una ficha para este ISBN.")
  if (result.providers.some((provider) => provider.status === "rateLimited")) return new DomainError("RATE_LIMITED", "El catálogo ha limitado las consultas. Vuelve a intentarlo más tarde.")
  return new DomainError("PROVIDER_UNAVAILABLE", "No se pudo completar la consulta. Puedes reintentar o completar la ficha manualmente.")
}

export function toBibliographyActionResult<T>(value: CatalogLookupResult<T>): BibliographyActionResult<T> {
  const error = catalogResultError(value)
  return error ? { ok: false, error: actionError(error.code, error.message), value } : { ok: true, value }
}

import { DomainError } from "../domain-errors"
import type { ProviderId } from "./types"

export interface CatalogConfig {
  mode: "fixture" | "live"
  enabled: Record<ProviderId, boolean>
  googleConfigured: boolean
  reviewEnabled: boolean
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback
  if (value === "true") return true
  if (value === "false") return false
  throw new DomainError("INVALID_INPUT", "La configuración del catálogo no es válida.")
}

/** Lee exclusivamente la configuración canónica; no entrega claves en el DTO. */
export function readCatalogConfig(env: Readonly<Record<string, string | undefined>> = process.env): CatalogConfig {
  const target = env.BIBLIB_TARGET ?? (env.NODE_ENV === "production" ? "prod" : "local")
  if (!["local", "test", "preprod", "prod"].includes(target)) throw new DomainError("INVALID_INPUT", "El destino del catálogo no es válido.")
  const mode = env.BIBLIB_CATALOGUE_MODE || (["local", "test"].includes(target) ? "fixture" : "live")
  if (mode !== "fixture" && mode !== "live") throw new DomainError("INVALID_INPUT", "El modo del catálogo no es válido.")
  if (mode === "fixture" && !["local", "test"].includes(target)) throw new DomainError("INVALID_INPUT", "Los datos ficticios solo están permitidos en local y pruebas.")
  return {
    mode,
    enabled: {
      "open-library": flag(env.BIBLIB_OPEN_LIBRARY_ENABLED, true),
      // En fixture BNE participa con su adaptador ficticio (sin red) para ensayar el flujo de dos fuentes.
      bne: flag(env.BIBLIB_BNE_ENABLED, mode === "fixture"),
      "google-books": flag(env.BIBLIB_GOOGLE_BOOKS_ENABLED, false),
    },
    googleConfigured: Boolean(env.GOOGLE_BOOKS_API_KEY?.trim()),
    reviewEnabled: flag(env.BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED, false),
  }
}

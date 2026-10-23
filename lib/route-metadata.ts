import type { Metadata } from "next"
import { DomainError } from "./domain-errors"

export const SITE_NAME = "BibLib"

/** Todas las rutas de BibLib son privadas: no se indexan ni se siguen sus enlaces. */
export const PRIVATE_ROBOTS = { index: false, follow: false } as const satisfies NonNullable<Metadata["robots"]>

/** Título completo de la pestaña de una ruta con título fijo («Colección · BibLib»). */
export function siteTitle(title: string): string {
  return `${title} · ${SITE_NAME}`
}

/**
 * Metadatos de una ruta con título fijo. El título es absoluto porque la plantilla del layout raíz
 * no se aplica a un layout anidado bajo otro que ya fija su propio título (p. ej. `/books/add`).
 */
export function privateMetadata(title: string): Metadata {
  return { title: { absolute: siteTitle(title) }, robots: PRIVATE_ROBOTS }
}

export type BookTitleLookup =
  | { status: "found"; title: string }
  | { status: "not-found" }
  | { status: "unauthenticated" }
  | { status: "unavailable" }

/** Traduce el fallo de leer un libro al caso de título correspondiente, sin exponer datos. */
export function classifyBookTitleError(error: unknown): BookTitleLookup {
  if (error instanceof DomainError) {
    if (error.code === "UNAUTHORIZED") return { status: "unauthenticated" }
    if (error.code === "NOT_FOUND" || error.code === "INVALID_INPUT") return { status: "not-found" }
  }
  return { status: "unavailable" }
}

/** Título completo de la pestaña. Solo incluye el del libro cuando hay sesión y lectura autorizada. */
export function bookDocumentTitle(lookup: BookTitleLookup): string {
  switch (lookup.status) {
    case "found": return siteTitle(lookup.title.trim() || "Libro sin título")
    case "not-found": return siteTitle("Libro no encontrado")
    case "unauthenticated":
    case "unavailable": return siteTitle("Ficha del libro")
  }
}

export function bookMetadata(lookup: BookTitleLookup): Metadata {
  return { title: { absolute: bookDocumentTitle(lookup) }, robots: PRIVATE_ROBOTS }
}

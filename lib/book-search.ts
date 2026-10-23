import { getSafeRedirectPath, isProtectedPath } from "./auth-navigation"
import type { Book } from "./types"

export type BookStatusFilter = Book["status"] | "all"
export type BookSortKey = "title" | "author" | "pages" | "date" | "status"
export type BookSort = BookSortKey | `-${BookSortKey}`
export type BookView = "table" | "grid"

export interface BookSearchFilters {
  q: string
  status: BookStatusFilter
  shelf: string
  sort: BookSort
  page: number
  view: BookView
}

export const BOOK_PAGE_SIZE = 10

export function defaultBookSearchFilters(view: BookView = "table"): BookSearchFilters {
  return { q: "", status: "all", shelf: "all", sort: "title", page: 1, view }
}

export function parseBookSearchFilters(params: URLSearchParams, defaultView: BookView = "table"): BookSearchFilters {
  const statusValue = params.get("status") ?? "all"
  const statuses: readonly BookStatusFilter[] = ["all", "read", "reading", "unread", "to-read"]
  const sortValue = params.get("sort") ?? "title"
  const sorts: readonly BookSort[] = ["title", "-title", "author", "-author", "pages", "-pages", "date", "-date", "status", "-status"]
  const pageValue = Number.parseInt(params.get("page") ?? "1", 10)
  const viewValue = params.get("view")

  return {
    q: params.get("q") ?? "",
    status: statuses.includes(statusValue as BookStatusFilter) ? statusValue as BookStatusFilter : "all",
    shelf: params.get("shelf") || "all",
    sort: sorts.includes(sortValue as BookSort) ? sortValue as BookSort : "title",
    page: Number.isFinite(pageValue) && pageValue > 0 ? pageValue : 1,
    view: viewValue === "table" || viewValue === "grid" ? viewValue : defaultView,
  }
}

export function serializeBookSearchFilters(filters: BookSearchFilters, currentParams: URLSearchParams, defaultView: BookView = "table"): string {
  const params = new URLSearchParams(currentParams)
  for (const key of ["q", "status", "shelf", "sort", "page", "view"]) params.delete(key)
  if (filters.q.trim()) params.set("q", filters.q)
  if (filters.status !== "all") params.set("status", filters.status)
  if (filters.shelf !== "all") params.set("shelf", filters.shelf)
  if (filters.sort !== "title") params.set("sort", filters.sort)
  if (filters.page > 1) params.set("page", String(filters.page))
  if (filters.view !== defaultView) params.set("view", filters.view)
  return params.toString()
}

export function normalizeBookSearchQuery(query: string): string {
  const trimmed = query.trim()
  const isbnCandidate = trimmed.replace(/[\s-]/g, "")
  if (/^(?:\d{9}[\dXx]|\d{13})$/.test(isbnCandidate)) return isbnCandidate.toUpperCase()
  return trimmed.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es")
}

/** Parámetro del detalle que lleva la URL interna de la colección a la que se vuelve. */
export const BOOK_RETURN_PARAM = "from"
/** Destino de «Volver» cuando no hay una URL de retorno válida (por ejemplo, un enlace directo). */
export const BOOK_RETURN_FALLBACK = "/books"
const BOOK_RETURN_MAX_LENGTH = 2048
const BOOK_ROW_ANCHOR_PREFIX = "book-row-"
const BOOK_ROW_ANCHOR = /^#book-row-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** Identificador de la fila o tarjeta de un libro dentro del listado (sin `#`). */
export function bookRowAnchor(bookId: string): string {
  return `${BOOK_ROW_ANCHOR_PREFIX}${bookId}`
}

/** Devuelve el id del libro de un fragmento `#book-row-<uuid>`, o `null` si no es uno nuestro. */
export function parseBookRowAnchor(hash: string): string | null {
  return BOOK_ROW_ANCHOR.exec(hash)?.[1] ?? null
}

/** Ruta del listado con sus filtros; omite los valores predeterminados y descarta parámetros ajenos. */
export function buildCollectionPath(pathname: string, filters: BookSearchFilters, defaultView: BookView = "table"): string {
  const query = serializeBookSearchFilters(filters, new URLSearchParams(), defaultView)
  return query ? `${pathname}?${query}` : pathname
}

/**
 * Valida una URL de retorno procedente de la query. Solo acepta rutas internas de la aplicación
 * (nunca otro origen, `//`, esquemas, barras invertidas ni caracteres de control), excluye el
 * propio detalle y conserva únicamente un fragmento `#book-row-<uuid>`. Cualquier otro valor
 * devuelve `BOOK_RETURN_FALLBACK`.
 */
export function resolveBookReturnPath(value: string | readonly string[] | null | undefined): string {
  if (typeof value !== "string" || value.length === 0 || value.length > BOOK_RETURN_MAX_LENGTH) return BOOK_RETURN_FALLBACK
  const safe = getSafeRedirectPath(value)
  if (safe === "/" && value !== "/") return BOOK_RETURN_FALLBACK
  const url = new URL(safe, "https://biblib.invalid")
  if (!isProtectedPath(url.pathname) || url.pathname === "/book" || url.pathname.startsWith("/book/")) return BOOK_RETURN_FALLBACK
  const hash = parseBookRowAnchor(url.hash) ? url.hash : ""
  return `${url.pathname}${url.search}${hash}`
}

/** Enlace al detalle de un libro que recuerda la URL interna del listado de origen. */
export function buildBookDetailHref(bookId: string, returnPath: string): string {
  const base = `/book/${encodeURIComponent(bookId)}`
  const safe = resolveBookReturnPath(returnPath)
  if (safe === BOOK_RETURN_FALLBACK) return base
  const params = new URLSearchParams()
  params.set(BOOK_RETURN_PARAM, safe)
  return `${base}?${params.toString()}`
}

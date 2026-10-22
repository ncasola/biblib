import type { Book } from "@/lib/types"

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

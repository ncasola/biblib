import { z } from "zod"
import { BOOK_PAGE_SIZE, type BookSearchFilters } from "./book-search"
import { DomainError } from "./domain-errors"

export const SAVED_VIEWS_LIMIT = 100
export const savedViewNameSchema = z.string().trim().min(1).max(80)
export const savedViewFiltersSchema = z.strictObject({
  q: z.string().max(500).optional(),
  status: z.enum(["all", "read", "reading", "unread", "to-read"]),
  shelf: z.union([z.literal("all"), z.uuid()]),
  sort: z.enum(["title", "-title", "author", "-author", "pages", "-pages", "date", "-date", "status", "-status"]),
  view: z.enum(["table", "grid"]),
  pageSize: z.number().int().min(10).max(100),
})
export type SavedViewFilters = z.infer<typeof savedViewFiltersSchema>
export interface SavedBookView {
  id: string
  name: string
  filters: SavedViewFilters
  updatedAt: string
  version: string
}

export function parseSavedViewFilters(input: unknown): SavedViewFilters {
  const parsed = savedViewFiltersSchema.safeParse(input)
  if (!parsed.success) throw new DomainError("INVALID_INPUT", "Los filtros de la vista no son válidos.")
  return parsed.data
}

/** Solo criterios reproducibles; nunca página, selección ni datos de libros. */
export function currentViewFilters(filters: BookSearchFilters): SavedViewFilters {
  if (filters.tagIds?.length) throw new DomainError("INVALID_INPUT", "Las vistas guardadas todavía no admiten etiquetas. Conserva la dirección de esta página para recuperar estos filtros.")
  return parseSavedViewFilters({ q: filters.q, status: filters.status, shelf: filters.shelf, sort: filters.sort, view: filters.view, pageSize: filters.pageSize ?? BOOK_PAGE_SIZE })
}

export function applySavedView(filters: SavedViewFilters, shelfIds: readonly string[]): BookSearchFilters {
  const safe = parseSavedViewFilters(filters)
  return { ...safe, q: safe.q ?? "", shelf: shelfIds.includes(safe.shelf) ? safe.shelf : "all", page: 1 }
}

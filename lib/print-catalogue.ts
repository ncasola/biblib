import { buildCollectionPath, normalizeBookSearchQuery, parseBookSearchFilters, type BookSearchFilters } from "./book-search"
import type { Book } from "./types"

export const PRINT_LIMIT = 2000
export const PRINT_PAGE_SIZE = 100
export const PRINT_FIELDS = ["title", "author", "isbn", "status", "location", "notes", "cover"] as const
export type PrintField = (typeof PRINT_FIELDS)[number]
export const PRINT_FIELD_LABELS: Record<PrintField, string> = {
  title: "Título", author: "Autor", isbn: "ISBN", status: "Estado", location: "Ubicación", notes: "Notas", cover: "Portada",
}
export const DEFAULT_PRINT_FIELDS: readonly PrintField[] = ["title", "author", "isbn", "status", "location"]
export type PrintBook = Pick<Book, "id" | "title" | "authors" | "isbn" | "status" | "cover" | "coverAssetId"> & { locationText?: string; notes?: string }
export const PRINT_STATUS_LABELS: Record<Book["status"], string> = { read: "Leído", reading: "Leyendo", unread: "Sin empezar", "to-read": "Por leer" }

/** Misma interpretación de URL que /books; la página visible no limita el catálogo impreso. */
export function printQuery(params: URLSearchParams, page = 1) {
  const filters = parseBookSearchFilters(params)
  return { q: normalizeBookSearchQuery(filters.q), status: filters.status, shelf: filters.shelf, series: filters.series ?? "all",
    sort: filters.sort, tagIds: filters.tagIds ?? [], tagMode: filters.tagMode ?? "or", page, pageSize: PRINT_PAGE_SIZE }
}

export function printHref(filters: BookSearchFilters): string {
  // El serializador compartido conserva también página y vista para «Volver».
  return buildCollectionPath("/books/print", filters)
}

/** Lista blanca y orden estable; una selección vacía se mantiene vacía para deshabilitar la impresión. */
export function selectPrintFields(values: readonly string[]): PrintField[] {
  return PRINT_FIELDS.filter((field) => values.includes(field))
}

export type PrintCatalogue = { kind: "ready"; books: PrintBook[]; total: number } | { kind: "too-large"; total: number }
type PrintPage = { books: PrintBook[]; total: number; page: number }

/** Nunca entrega un catálogo truncado, duplicado o cuyo recuento cambió durante la carga. */
export async function collectPrintPages(readPage: (page: number) => Promise<PrintPage>): Promise<PrintCatalogue> {
  const first = await readPage(1)
  if (first.total > PRINT_LIMIT) return { kind: "too-large", total: first.total }
  const books = [...first.books]
  for (let page = 2; page <= Math.ceil(first.total / PRINT_PAGE_SIZE); page++) {
    const next = await readPage(page)
    if (next.total !== first.total || next.page !== page) throw new Error("La colección ha cambiado. Recarga la vista antes de imprimir.")
    books.push(...next.books)
  }
  if (books.length !== first.total || new Set(books.map((book) => book.id)).size !== books.length) {
    throw new Error("La colección ha cambiado. Recarga la vista antes de imprimir.")
  }
  return { kind: "ready", books, total: first.total }
}

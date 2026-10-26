import { DEFAULT_BOOK_COVER } from "./book-covers"
import type { Book } from "./types"

/** Compartida por búsqueda, selección y entrada manual; una respuesta antigua nunca puede publicarse. */
export function createLatestBibliographyRequest() {
  let current: AbortController | undefined
  return {
    begin() {
      current?.abort()
      current = new AbortController()
      return current
    },
    cancel() { current?.abort() },
  }
}
/** La entrada manual parte de lo escrito ahora, aunque una consulta anterior siga en vuelo; sin ISBN inventado (U-DAT-06). */
export function manualTitleAuthorDraft(title: string, author: string): Book {
  return { id: "", isbn: null, title, authors: author.trim() ? [{ name: author.trim() }] : [], publishers: [], number_of_pages: 0, publish_date: "", status: "unread", shelf_id: "", shelf_name: "", cover: { small: DEFAULT_BOOK_COVER, medium: DEFAULT_BOOK_COVER, large: DEFAULT_BOOK_COVER }, catalogue: { source: "manual", isbnVerified: false } }
}


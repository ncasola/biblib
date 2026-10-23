import { normalizeBookCover } from "./book-covers"
import { normalizeIsbn } from "./isbn"
import { upgradeOpenLibraryUrl } from "./bibliographic-catalog/providers/endpoints"
import { createOpenLibraryProvider, type OpenLibraryOptions, type OpenLibraryRecord } from "./bibliographic-catalog/providers/open-library"
import type { Book } from "./types"

export { openLibraryHeaders } from "./bibliographic-catalog/providers/open-library"
export type { OpenLibraryRecord }

/** Fachada legacy: toda la red, validación, caché y limitación pertenecen al adaptador. */
export function createOpenLibraryClient(options: OpenLibraryOptions = {}) {
  const adapter = createOpenLibraryProvider(options)
  async function searchRecordByISBN(value: string, signal?: AbortSignal) {
    const result = await adapter.readIsbnRecord(value, signal)
    if (!result) return null
    const isbn = normalizeIsbn(value)!
    const data = result.record
    const cover = normalizeBookCover(data.cover)
    for (const size of ["small", "medium", "large"] as const) {
      cover[size] = upgradeOpenLibraryUrl(cover[size]) ?? cover[size]
    }
    const sourceUrl = upgradeOpenLibraryUrl(data.url)
    const book: Book = {
      id: `book-${isbn}`, isbn, title: data.title, subtitle: data.subtitle,
      authors: data.authors?.length ? data.authors : [{ name: "Autor desconocido" }],
      number_of_pages: data.number_of_pages ?? 0, publish_date: data.publish_date ?? "",
      publishers: data.publishers?.length ? data.publishers : undefined,
      cover, status: "to-read", shelf_id: "", shelf_name: "Predeterminada",
      catalogue: { source: "open-library", isbnVerified: false, ...(sourceUrl?.startsWith("https://") ? { sourceUrl } : {}) },
    }
    return { ...result, book }
  }
  async function searchBookByISBN(value: string, signal?: AbortSignal): Promise<Book | null> {
    return (await searchRecordByISBN(value, signal))?.book ?? null
  }
  return { searchBookByISBN, searchRecordByISBN }
}

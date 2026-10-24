import type { Book } from "./types"

export const DEFAULT_BOOK_COVER = "/default-book-cover.webp"

function isRealCover(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false

  try {
    const url = new URL(value, "https://biblib.local")
    return (
      (value.startsWith("/") || /^https?:\/\//i.test(value)) &&
      ["http:", "https:"].includes(url.protocol) &&
      ![DEFAULT_BOOK_COVER, "/placeholder.svg"].includes(url.pathname)
    )
  } catch {
    return false
  }
}

/**
 * Portada que se muestra: la copia privada (U-DAT-10), servida por la ruta autenticada del propio
 * origen, o las URL guardadas en la ficha. La ruta coincide con `coverAssetUrl` de lib/assets/contracts.
 */
export function displayCover(book: Pick<Book, "cover" | "coverAssetId">): Book["cover"] {
  if (!book.coverAssetId) return book.cover
  const url = `/api/covers/${book.coverAssetId}`
  return { small: url, medium: url, large: url }
}

export function normalizeBookCover(cover?: Partial<Book["cover"]> | null): Book["cover"] {
  const available = [cover?.large, cover?.medium, cover?.small].find(isRealCover)
  return {
    small: isRealCover(cover?.small) ? cover.small : available ?? DEFAULT_BOOK_COVER,
    medium: isRealCover(cover?.medium) ? cover.medium : available ?? DEFAULT_BOOK_COVER,
    large: isRealCover(cover?.large) ? cover.large : available ?? DEFAULT_BOOK_COVER,
  }
}

import type { Book, Author, Publisher } from "./types"

interface OpenLibraryBook {
  title?: string
  subtitle?: string
  authors?: Array<{ name: string; url?: string }>
  number_of_pages?: number
  publish_date?: string
  publishers?: Array<{ name: string }>
  cover?: { small?: string; medium?: string; large?: string }
}

export async function searchBookByISBN(isbn: string): Promise<Book | null> {
  try {
    const cleanISBN = isbn.replace(/[^0-9X]/g, "")
    const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${cleanISBN}&format=json&jscmd=data`

    console.log("[v0] Searching for book with ISBN:", cleanISBN)
    const response = await fetch(url)

    if (!response.ok) {
      console.log("[v0] API response not ok:", response.status)
      return null
    }

    const data = await response.json()
    const key = `ISBN:${cleanISBN}`

    console.log("[v0] API response data keys:", Object.keys(data))
    console.log("[v0] Looking for key:", key)

    if (!data[key]) {
      console.log("[v0] Book not found in API response")
      return null
    }

    const bookData: OpenLibraryBook = data[key]
    console.log("[v0] Found book data:", bookData)

    const authors: Author[] = (bookData.authors || []).map((a) => ({
      name: a.name || "Unknown Author",
      url: a.url,
    }))

    const publishers: Publisher[] = (bookData.publishers || []).map((p) => ({
      name: p.name || "Unknown Publisher",
    }))

    const book: Book = {
      id: `book-${cleanISBN}`,
      isbn: cleanISBN,
      title: bookData.title || "Unknown Title",
      subtitle: bookData.subtitle,
      authors: authors.length > 0 ? authors : [{ name: "Unknown Author" }],
      number_of_pages: bookData.number_of_pages || 0,
      publish_date: bookData.publish_date || "",
      publishers: publishers.length > 0 ? publishers : undefined,
      cover: bookData.cover || {
        small: "/placeholder.svg?height=128&width=85",
        medium: "/placeholder.svg?height=256&width=170",
        large: "/placeholder.svg?height=512&width=341",
      },
      status: "to-read",
      shelf_id: "shelf-1",
      shelf_name: "Want to read",
    }

    console.log("[v0] Returning book object:", book)
    return book
  } catch (error) {
    console.error("[v0] Error searching for book:", error)
    return null
  }
}

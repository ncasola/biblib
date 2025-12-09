export interface Author {
  name: string
  url?: string
}

export interface Publisher {
  name: string
}

export interface Book {
  id: string
  isbn: string
  title: string
  subtitle?: string
  authors: Author[]
  number_of_pages: number
  publish_date: string
  publishers?: Publisher[]
  cover: {
    small: string
    medium: string
    large: string
  }
  status: "read" | "reading" | "unread" | "to-read"
  shelf_id: string
  shelf_name: string
}

export interface Shelf {
  id: string
  title: string
  book_count: number
  isDefault?: boolean
}

export interface LibraryData {
  books: Book[]
  shelves: Shelf[]
}

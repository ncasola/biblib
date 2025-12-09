import { type NextRequest, NextResponse } from "next/server"
import { getStoredLibraryData, loadLibraryData, saveLibraryData } from "@/lib/storage"
import type { Book } from "@/lib/types"

export async function POST(request: NextRequest) {
  try {
    const book: Book = await request.json()

    let libraryData = getStoredLibraryData()
    if (!libraryData) {
      libraryData = await loadLibraryData()
    }

    // Check if book already exists
    if (libraryData.books.some((b) => b.isbn === book.isbn)) {
      return NextResponse.json({ error: "Book already in library" }, { status: 409 })
    }

    // Add book to library
    libraryData.books.push(book)
    saveLibraryData(libraryData)

    return NextResponse.json({ success: true, book })
  } catch (error) {
    console.error("Error adding book:", error)
    return NextResponse.json({ error: "Failed to add book" }, { status: 500 })
  }
}

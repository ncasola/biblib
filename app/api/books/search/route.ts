import { searchBookByISBN } from "@/lib/api-client"
import { type NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const isbn = searchParams.get("isbn")

    if (!isbn) {
      return NextResponse.json({ error: "ISBN is required" }, { status: 400 })
    }

    const book = await searchBookByISBN(isbn)

    if (!book) {
      return NextResponse.json({ error: "Book not found" }, { status: 404 })
    }

    return NextResponse.json(book)
  } catch (error) {
    console.error("Error searching book:", error)
    return NextResponse.json({ error: "Failed to search book" }, { status: 500 })
  }
}

import { searchBookByISBN } from "@/lib/api-client"
import { type NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const isbn = searchParams.get("isbn")

    if (!isbn) {
      return NextResponse.json({ error: "El ISBN es obligatorio" }, { status: 400 })
    }

    const book = await searchBookByISBN(isbn)

    if (!book) {
      return NextResponse.json({ error: "Libro no encontrado" }, { status: 404 })
    }

    return NextResponse.json(book)
  } catch (error) {
    console.error("Error searching book:", error)
    return NextResponse.json({ error: "No se pudo buscar el libro" }, { status: 500 })
  }
}

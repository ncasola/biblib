import { type NextRequest, NextResponse } from "next/server"
import { addBookAction } from "@/app/actions/books"
import type { Book } from "@/lib/types"

export async function POST(request: NextRequest) {
  try {
    const book: Book = await request.json()
    await addBookAction(book)
    return NextResponse.json({ success: true, book })
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo agregar el libro"
    const status = message === "El libro ya está en la biblioteca" ? 409 : 500
    console.error("Error adding book:", error)
    return NextResponse.json({ error: message }, { status })
  }
}

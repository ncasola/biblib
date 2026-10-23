import { searchBookByISBN } from "@/lib/api-client"
import { DomainError } from "@/lib/domain-errors"
import { getRequiredUserId } from "@/lib/server-user"
import { withRequestCorrelation } from "@/lib/observability/server"
import { type NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  return withRequestCorrelation(request, async () => {
    try {
      await getRequiredUserId()
      const searchParams = request.nextUrl.searchParams
      const isbn = searchParams.get("isbn")

      if (!isbn) {
        return NextResponse.json({ error: "El ISBN es obligatorio" }, { status: 400 })
      }

      const book = await searchBookByISBN(isbn)

      if (!book) {
        return NextResponse.json({ error: "Libro no encontrado" }, { status: 404 })
      }

      return NextResponse.json(book, { headers: { "Cache-Control": "private, no-store" } })
    } catch (error) {
      if (error instanceof DomainError) {
        const status = { INVALID_INPUT: 400, UNAUTHORIZED: 401, NOT_FOUND: 404, CONFLICT: 409, PROVIDER_UNAVAILABLE: 503, RATE_LIMITED: 429 }[error.code]
        return NextResponse.json({ error: error.message, code: error.code }, { status, headers: { "Cache-Control": "private, no-store", ...(status === 429 ? { "Retry-After": "1" } : {}) } })
      }
      return NextResponse.json({ error: "No se pudo buscar el libro. Vuelve a intentarlo." }, { status: 500 })
    }
  })
}

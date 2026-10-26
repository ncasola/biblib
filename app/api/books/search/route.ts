import { bibliographicCatalog } from "@/lib/bibliographic-catalog/server"
import { catalogResultError } from "@/lib/bibliographic-catalog/action-result"
import { candidateToLegacyBook } from "@/lib/bibliographic-catalog/normalize"
import { retainableCandidates, retainableCovers } from "@/lib/bibliographic-catalog/retention"
import { normalizeIsbn } from "@/lib/isbn"
import { DomainError, httpStatusForDomainError } from "@/lib/domain-errors"
import { getRequiredUserId } from "@/lib/server-user"
import { withRequestCorrelation } from "@/lib/observability/server"
import { type NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  return withRequestCorrelation(request, async () => {
    try {
      const userId = await getRequiredUserId()
      const searchParams = request.nextUrl.searchParams
      const isbn = searchParams.get("isbn")

      if (!isbn) {
        return NextResponse.json({ error: "El ISBN es obligatorio" }, { status: 400 })
      }

      const result = await bibliographicCatalog.lookupISBN(isbn, { userId, signal: request.signal })

      if (result.status === "notFound") {
        return NextResponse.json({ error: "Libro no encontrado" }, { status: 404 })
      }
      const failure = catalogResultError(result)
      if (failure) throw failure
      // Esta respuesta es una ficha guardable: solo fuentes cuya política permite conservarla (nunca Google).
      const candidate = retainableCandidates(result.candidates)[0]
      if (!candidate) return NextResponse.json({ error: "Libro no encontrado" }, { status: 404 })
      const cover = candidate.coverUrl ? await bibliographicCatalog.getCover(isbn, { userId, signal: request.signal }) : undefined
      const persistentCover = cover && retainableCovers(cover.candidates).find((entry) => entry.imageUrl)
      const book = candidateToLegacyBook(candidate, normalizeIsbn(isbn)!, persistentCover?.imageUrl)

      return NextResponse.json(book, { headers: { "Cache-Control": "private, no-store" } })
    } catch (error) {
      if (error instanceof DomainError) {
        const status = httpStatusForDomainError(error.code)
        return NextResponse.json({ error: error.message, code: error.code }, { status, headers: { "Cache-Control": "private, no-store", ...(status === 429 ? { "Retry-After": "1" } : {}) } })
      }
      return NextResponse.json({ error: "No se pudo buscar el libro. Vuelve a intentarlo." }, { status: 500 })
    }
  })
}

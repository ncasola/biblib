import { type NextRequest, NextResponse } from "next/server"
import { addBookAction } from "@/app/actions/books"
import { DomainError } from "@/lib/domain-errors"
import { unwrapAction } from "@/lib/action-result"

export async function POST(request: NextRequest) {
  try {
    const input: unknown = await request.json()
    const book = unwrapAction(await addBookAction(input))
    return NextResponse.json({ success: true, book }, { status: 201, headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "El cuerpo de la solicitud debe contener un JSON válido." }, { status: 400 })
    if (error instanceof DomainError) {
      const status = { INVALID_INPUT: 400, UNAUTHORIZED: 401, NOT_FOUND: 404, CONFLICT: 409, PROVIDER_UNAVAILABLE: 503, RATE_LIMITED: 429 }[error.code]
      return NextResponse.json({ error: error.message, code: error.code }, { status })
    }
    return NextResponse.json({ error: "No se pudo agregar el libro. Vuelve a intentarlo." }, { status: 500 })
  }
}

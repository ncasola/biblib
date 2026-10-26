import { read } from "@/lib/media/server"
import { DomainError, httpStatusForDomainError } from "@/lib/domain-errors"

export const runtime = "nodejs"
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" }
  try {
    const blob = await read((await params).id)
    return new Response(blob, { headers: { ...headers, "Content-Type": "image/webp", "Content-Disposition": "inline", "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": "default-src 'none'; sandbox" } })
  } catch (error) {
    return Response.json({ error: "La imagen no está disponible." }, { status: error instanceof DomainError ? httpStatusForDomainError(error.code) : 503, headers })
  }
}

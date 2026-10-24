import { type NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { withRlsContext } from "@/lib/db/client"
import { getRequiredUserId } from "@/lib/server-user"
import { DomainError } from "@/lib/domain-errors"
import { exportSet, readExportLibrary } from "@/lib/library-export-server"

// Descarga de una parte de la copia (tarea T1, U-DAT-04). La parte se genera de nuevo en el servidor
// para la revisión, fecha y conjunto del manifest que preparó prepareLibraryExportAction; si la
// colección cambió o los bytes no coinciden con el hash del manifest, no se descarga nada.

const querySchema = z.object({
  revision: z.uuid(),
  exportedAt: z.iso.datetime(),
  set: z.uuid(),
  part: z.coerce.number().int().min(0).max(1_000),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

const noStore = { "Cache-Control": "private, no-store" }
const changed = () => NextResponse.json({ error: "Tu biblioteca ha cambiado desde que preparaste la copia. Prepárala de nuevo para descargar todas las partes del mismo estado.", code: "REVISION_CONFLICT" }, { status: 409, headers: noStore })

export async function GET(request: NextRequest) {
  // Primero la sesión: sin ella la respuesta es siempre 401, sin revelar nada sobre el enlace.
  let userId: string
  try { userId = await getRequiredUserId() } catch (error) {
    if (error instanceof DomainError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401, headers: noStore })
    throw error
  }
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: "El enlace de descarga no es válido. Prepara la copia de nuevo." }, { status: 400, headers: noStore })
  const { revision, exportedAt, set, part, sha256 } = parsed.data
  try {
    const read = await withRlsContext(userId, (tx) => readExportLibrary(tx, userId))
    if (!read || read.revision !== revision) return changed()
    const file = exportSet(read.data, new Date(exportedAt), set).files[part]
    if (!file || file.sha256 !== sha256) return changed()
    return new NextResponse(file.text, { status: 200, headers: {
      ...noStore,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
      "Content-Length": String(file.byteLength),
    } })
  } catch {
    return NextResponse.json({ error: "No se pudo preparar la parte. Vuelve a intentarlo." }, { status: 503, headers: noStore })
  }
}

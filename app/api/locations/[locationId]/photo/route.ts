import { NextResponse, type NextRequest } from "next/server"
import { sql } from "drizzle-orm"
import { withRlsContext } from "@/lib/db/client"
import { DomainError } from "@/lib/domain-errors"
import { getRequiredUserId } from "@/lib/server-user"
import { UUID } from "@/lib/assets/contracts"
import { readImage } from "@/lib/media/server"

// Lectura autenticada de la foto de una ubicación (U-PRO-03), desde el propio origen como las portadas privadas: la CSP no
// necesita hosts nuevos y nunca se entrega una URL pública. Comprueba la sesión, la ubicación y su foto (dueño por RLS y
// asset listo), descarga el objeto con la sesión del dueño (las políticas de Storage vuelven a comprobarlo) y verifica su
// sha256. Una ubicación ajena, inexistente o sin foto responde igual: 404, sin confirmar que exista.

const noStore = { "Cache-Control": "private, no-store", Vary: "Cookie" }
const notFound = () => NextResponse.json({ error: "No se encontró la imagen." }, { status: 404, headers: noStore })

export async function GET(_request: NextRequest, { params }: { params: Promise<{ locationId: string }> }) {
  let userId: string
  try { userId = await getRequiredUserId() } catch (error) {
    if (error instanceof DomainError) return NextResponse.json({ error: error.message }, { status: 401, headers: noStore })
    throw error
  }
  const { locationId } = await params
  if (!UUID.test(locationId)) return notFound()
  try {
    const [photo] = await withRlsContext(userId, (tx) => tx.execute<{ storage_key: string; sha256: string }>(sql`
      select m.storage_key, m.sha256 from biblib.locations as l
      join biblib.media_assets as m on m.user_id = l.user_id and m.id = l.photo_asset_id and m.kind = 'location' and m.state = 'ready'
      where l.user_id = ${userId}::uuid and l.id = ${locationId}::uuid`))
    if (!photo?.sha256) return notFound()
    const bytes = await readImage(photo.storage_key, photo.sha256)
    if (!bytes) return notFound()
    return new NextResponse(new Uint8Array(bytes), { status: 200, headers: {
      ...noStore,
      "Content-Type": "image/webp",
      "Content-Length": String(bytes.length),
      "Content-Disposition": "inline; filename=\"ubicacion.webp\"",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    } })
  } catch {
    return NextResponse.json({ error: "No se pudo leer la imagen. Vuelve a intentarlo." }, { status: 503, headers: noStore })
  }
}

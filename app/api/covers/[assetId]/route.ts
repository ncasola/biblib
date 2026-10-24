import { NextResponse, type NextRequest } from "next/server"
import { withRlsContext } from "@/lib/db/client"
import { DomainError } from "@/lib/domain-errors"
import { getRequiredUserId } from "@/lib/server-user"
import { coverAssetRights, parseProviderCoverKey, UUID } from "@/lib/assets/contracts"
import { validateAndNormalizeImage } from "@/lib/assets/image-validation"
import { readAsset, revalidateAsset, sha256Hex } from "@/lib/assets/repository"
import { ownerStorage } from "@/lib/assets/server"

// Lectura autenticada de una portada privada (U-DAT-10), desde el propio origen: la CSP no necesita
// hosts nuevos y nunca se entrega una URL firmada. Comprueba la sesión, el asset (dueño por RLS,
// estado utilizable y licencia vigente), descarga el objeto registrado con la sesión del dueño (las
// políticas de Storage vuelven a comprobarlo) y verifica su sha256 antes de servirlo. Un asset ajeno,
// inexistente o no disponible responde igual: 404, sin confirmar que exista.

const noStore = { "Cache-Control": "private, no-store", Vary: "Cookie" }
const notFound = () => NextResponse.json({ error: "No se encontró la imagen." }, { status: 404, headers: noStore })

export async function GET(_request: NextRequest, { params }: { params: Promise<{ assetId: string }> }) {
  let userId: string
  try { userId = await getRequiredUserId() } catch (error) {
    if (error instanceof DomainError) return NextResponse.json({ error: error.message }, { status: 401, headers: noStore })
    throw error
  }
  const { assetId } = await params
  if (!UUID.test(assetId)) return notFound()
  try {
    const asset = await withRlsContext(userId, (tx) => readAsset(tx, userId, assetId))
    if (!asset || asset.state === "quarantine" || !asset.storageKey || !asset.sha256 || (asset.expiresAt && asset.expiresAt <= new Date())) return notFound()
    const storage = await ownerStorage()
    const bytes = await storage.download(asset.storageKey)
    // Un objeto distinto del registrado (alterado o sustituido fuera del servidor) no se sirve.
    if (!bytes || sha256Hex(bytes) !== asset.sha256) return notFound()
    if (asset.state === "restored") {
      // Tras un restore: bytes y derechos vigentes antes de volver a servirlo; si no, se descarta.
      const key = asset.sourceKind === "provider" ? parseProviderCoverKey(asset.sourceRef) : null
      const allowed = asset.sourceKind === "upload" || (key !== null && coverAssetRights(key.provider).backup)
      const valid = allowed && await validateAndNormalizeImage(bytes, { declaredType: "image/webp" }).then(() => true, () => false)
      await withRlsContext(userId, (tx) => revalidateAsset(tx, asset.id, valid))
      if (!valid) return notFound()
    }
    return new NextResponse(new Uint8Array(bytes), { status: 200, headers: {
      ...noStore,
      "Content-Type": "image/webp",
      "Content-Length": String(bytes.length),
      "Content-Disposition": "inline; filename=\"portada.webp\"",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    } })
  } catch {
    return NextResponse.json({ error: "No se pudo leer la imagen. Vuelve a intentarlo." }, { status: 503, headers: noStore })
  }
}

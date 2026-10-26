import type { Metadata } from "next"
import { privateMetadata } from "@/lib/route-metadata"
import { offlineSnapshotEnabled } from "@/lib/offline-config"
import { OfflineLibraryView } from "@/components/offline-library-view"

// U-EXP-08 · Vista sin conexión. Es pública y no depende de la sesión: el service worker la guarda pedida
// sin cookies y la sirve cuando falla la red. Los datos salen solo de la copia cifrada de este dispositivo.
export const metadata: Metadata = privateMetadata("Sin conexión")

export default function OfflinePage() {
  return <OfflineLibraryView snapshotEnabled={offlineSnapshotEnabled()} />
}

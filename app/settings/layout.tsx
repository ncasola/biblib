import type { Metadata } from "next"
import type { ReactNode } from "react"
import { privateMetadata } from "@/lib/route-metadata"

export const metadata: Metadata = privateMetadata("Ajustes")

// Las acciones de Ajustes continúan los trabajos con `after()`, que vive dentro de este plazo. Con el
// de la plataforma (10 s) Vercel cortaba cada paso de portadas antes de confirmarlo (hasta 20 s).
export const maxDuration = 60
export default function SettingsLayout({ children }: { children: ReactNode }) { return children }

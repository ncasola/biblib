import type { Metadata } from "next"
import type { ReactNode } from "react"
import { privateMetadata } from "@/lib/route-metadata"

export const metadata: Metadata = privateMetadata("Ajustes")
export default function SettingsLayout({ children }: { children: ReactNode }) { return children }

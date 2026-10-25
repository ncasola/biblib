import type { Metadata } from "next"
import type { ReactNode } from "react"
import { AppShell } from "@/components/app-shell"
import { privateMetadata } from "@/lib/route-metadata"

export const metadata: Metadata = privateMetadata("Ubicaciones")
export default function LocationsLayout({ children }: { children: ReactNode }) { return <AppShell>{children}</AppShell> }

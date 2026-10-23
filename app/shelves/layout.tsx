import type { Metadata } from "next"
import type { ReactNode } from "react"
import { AppShell } from "@/components/app-shell"
import { privateMetadata } from "@/lib/route-metadata"

export const metadata: Metadata = privateMetadata("Estanterías")
export default function ShelvesLayout({ children }: { children: ReactNode }) { return <AppShell>{children}</AppShell> }

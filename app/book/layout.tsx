import type { Metadata } from "next"
import type { ReactNode } from "react"
import { AppShell } from "@/components/app-shell"
import { privateMetadata } from "@/lib/route-metadata"

export const metadata: Metadata = privateMetadata("Ficha del libro")
export default function BookLayout({ children }: { children: ReactNode }) { return <AppShell>{children}</AppShell> }

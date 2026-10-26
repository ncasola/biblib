import type { ReactNode } from "react"
import { AppShell } from "@/components/app-shell"
import { privateMetadata } from "@/lib/route-metadata"

export const metadata = privateMetadata("Prestados")
export default function LoansLayout({ children }: { children: ReactNode }) { return <AppShell>{children}</AppShell> }

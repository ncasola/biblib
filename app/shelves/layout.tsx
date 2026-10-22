import type { Metadata } from "next"
import type { ReactNode } from "react"

export const metadata: Metadata = { title: "Estanterías" }
export default function ShelvesLayout({ children }: { children: ReactNode }) { return children }

import type { Metadata } from "next"
import type { ReactNode } from "react"

export const metadata: Metadata = { title: "Ficha del libro" }
export default function BookLayout({ children }: { children: ReactNode }) { return children }

import type { Metadata } from "next"
import type { ReactNode } from "react"

export const metadata: Metadata = { title: "Colección" }
export default function BooksLayout({ children }: { children: ReactNode }) { return children }

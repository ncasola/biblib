import type { Metadata } from "next"
import type { ReactNode } from "react"
import { privateMetadata } from "@/lib/route-metadata"

export const metadata: Metadata = privateMetadata("Búsqueda avanzada")
export default function BooksSearchLayout({ children }: { children: ReactNode }) { return children }

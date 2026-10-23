import type { Metadata } from "next"
import type { ReactNode } from "react"
import { privateMetadata } from "@/lib/route-metadata"

export const metadata: Metadata = privateMetadata("Agregar libro")
export default function BooksAddLayout({ children }: { children: ReactNode }) { return children }

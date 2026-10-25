import type { Metadata } from "next"
import type { ReactNode } from "react"
import { privateMetadata } from "@/lib/route-metadata"

export const metadata: Metadata = privateMetadata("Revisión bibliográfica")
export default function BooksReviewLayout({ children }: { children: ReactNode }) { return children }

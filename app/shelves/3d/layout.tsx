import type { Metadata } from "next"
import type { ReactNode } from "react"
import { privateMetadata } from "@/lib/route-metadata"
import "./shelf-3d.css"

export const metadata: Metadata = privateMetadata("Estantería 3D")
export default function Shelves3DLayout({ children }: { children: ReactNode }) { return children }

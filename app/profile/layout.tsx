import type { Metadata } from "next"
import type { ReactNode } from "react"

export const metadata: Metadata = { title: "Perfil" }
export default function ProfileLayout({ children }: { children: ReactNode }) { return children }

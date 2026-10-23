import type { ReactNode } from "react"
import { Header } from "@/components/header"

/**
 * Estructura común de las rutas privadas: una única cabecera, el destino del enlace
 * «Saltar al contenido» y el ancho máximo. Los layouts de dominio la usan una sola vez;
 * las páginas no deben volver a pintar `Header` ni otro `<main>`.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-7xl px-4 py-8 outline-none md:py-12">
        {children}
      </main>
    </div>
  )
}

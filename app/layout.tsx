import type React from "react"
import type { Metadata, Viewport } from "next"
import { headers } from "next/headers"
import { connection } from "next/server"
import { Analytics } from "@vercel/analytics/next"
import "./globals.css"
import { fraunces, inter } from "./fonts"
import { AuthProvider } from "@/lib/auth-context"
import { ThemeProvider } from "@/components/theme-provider"
import { PRIVATE_ROBOTS } from "@/lib/route-metadata"
import { OfflineRuntime } from "@/components/offline-runtime"
import { offlineSnapshotEnabled, serviceWorkerMode, serviceWorkerUrl } from "@/lib/offline-config"

export const metadata: Metadata = {
  title: { default: "BibLib", template: "%s · BibLib" },
  description: "BibLib es una aplicación de gestión de biblioteca personal.",
  generator: "BibLib",
  robots: PRIVATE_ROBOTS,
  // U-UX-01: la pestaña usa el personaje sin fondo; el icono de inicio de iOS conserva el logo con fondo
  // blanco porque iOS rellena la transparencia de negro.
  icons: {
    icon: [{ url: "/logo-mark.png", type: "image/png", sizes: "361x361" }],
    shortcut: [{ url: "/logo-mark.png", type: "image/png", sizes: "361x361" }],
    apple: [{ url: "/logo.png", sizes: "500x500", type: "image/png" }],
  },
  manifest: "/manifest.webmanifest",
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5eddd" },
    { media: "(prefers-color-scheme: dark)", color: "#16110d" },
  ],
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // U-OPS-04: render dinámico para que Next aplique el nonce de la CSP (lo genera proxy.ts) y el HTML
  // no salga con s-maxage de página estática; el script inline de next-themes recibe el mismo nonce.
  await connection()
  const nonce = (await headers()).get("x-nonce") ?? undefined
  // U-EXP-08: banderas de servidor del worker de shell estático y de la copia de lectura (sin NEXT_PUBLIC_).
  const workerMode = serviceWorkerMode()
  return (
    <html lang="es" suppressHydrationWarning className={`${inter.variable} ${fraunces.variable}`}>
      <body className={`font-sans antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem enableColorScheme disableTransitionOnChange storageKey="theme" nonce={nonce}>
          <AuthProvider>
            <OfflineRuntime snapshotEnabled={offlineSnapshotEnabled()} serviceWorkerUrl={serviceWorkerUrl(workerMode)} cleanup={workerMode === "limpieza"} registerWorker={process.env.NODE_ENV !== "development"}>
              {children}
            </OfflineRuntime>
          </AuthProvider>
        </ThemeProvider>
        {process.env.NEXT_PUBLIC_ENABLE_ANALYTICS === "true" && <Analytics />}
      </body>
    </html>
  )
}

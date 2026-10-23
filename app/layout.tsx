import type React from "react"
import type { Metadata } from "next"
import { headers } from "next/headers"
import { connection } from "next/server"
import { Analytics } from "@vercel/analytics/next"
import "./globals.css"
import { AuthProvider } from "@/lib/auth-context"
import { ThemeProvider } from "@/components/theme-provider"
import { PRIVATE_ROBOTS } from "@/lib/route-metadata"

export const metadata: Metadata = {
  title: { default: "BibLib", template: "%s · BibLib" },
  description: "BibLib es una aplicación de gestión de biblioteca personal.",
  generator: "BibLib",
  robots: PRIVATE_ROBOTS,
  icons: {
    icon: [
      { url: "/logo.png", type: "image/png", sizes: "32x32" },
      { url: "/logo.png", type: "image/png", sizes: "192x192" },
      { url: "/logo.png", type: "image/png", sizes: "512x512" },
    ],
    shortcut: [{ url: "/logo.png", type: "image/png", sizes: "32x32" }],
    apple: [{ url: "/logo.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/manifest.webmanifest",
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
  return (
    <html lang="es" suppressHydrationWarning>
      <body className={`font-sans antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem enableColorScheme disableTransitionOnChange storageKey="theme" nonce={nonce}>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
        {process.env.NEXT_PUBLIC_ENABLE_ANALYTICS === "true" && <Analytics />}
      </body>
    </html>
  )
}

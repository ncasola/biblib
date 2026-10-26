import localFont from "next/font/local"

// U-UX-01: tipografías autoalojadas (OFL 1.1, licencias en app/fonts/). Se sirven desde /_next/static/media,
// sin red en build ni en ejecución. Subconjunto latino: cubre el español; otros glifos usan la reserva del sistema.
export const fraunces = localFont({
  src: "./fonts/fraunces-latin-opsz-normal.woff2",
  variable: "--font-fraunces",
  weight: "100 900",
  style: "normal",
  display: "swap",
  fallback: ["Georgia", "Times New Roman", "serif"],
  adjustFontFallback: "Times New Roman",
})

export const inter = localFont({
  src: "./fonts/inter-latin-wght-normal.woff2",
  variable: "--font-inter",
  weight: "100 900",
  style: "normal",
  display: "swap",
  fallback: ["ui-sans-serif", "system-ui", "Segoe UI", "Arial", "sans-serif"],
  adjustFontFallback: "Arial",
})

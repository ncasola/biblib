import { validateTarget } from "./scripts/db/environment.mjs"

const target = process.env.BIBLIB_TARGET
const STATIC_ASSET_CACHE = "public, max-age=86400, stale-while-revalidate=604800"
if (target !== undefined) validateTarget(target)

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next 16 escribe agents.md al arrancar; en Windows coincide con nuestras instrucciones AGENTS.md.
  agentRules: false,
  distDir: target ? `.next-${target}` : ".next",
  // Primera puerta del acceso local: debe estar definida siempre ("" fuera de local/test), porque Next
  // solo sustituye las variables NEXT_PUBLIC_ definidas y solo así el compilador elimina el formulario.
  env: { NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN: ["local", "test"].includes(target) ? "1" : "" },
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
  images: {
    unoptimized: true,
  },
  // Matriz de cabeceras de U-OPS-04 (docs/seguridad.md). La CSP Report-Only con nonce la añade proxy.ts.
  async headers() {
    return [
      { source: "/(.*)", headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        // Por defecto ningún documento puede usar cámara; la excepción exacta se publica debajo.
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
      ] },
      { source: "/books/add", headers: [
        { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=()" },
      ] },
      // HTML, acciones, API y callback dependen de la sesión: nada de caché compartida (CDN o proxy).
      // Quedan fuera los estáticos con hash de Next y los archivos de public/, que no llevan cookies.
      { source: "/((?!_next/static/|_next/image|.*\\.(?:png|jpe?g|svg|webp|ico|webmanifest|txt|xml)$).*)", headers: [
        { key: "Cache-Control", value: "private, no-store" },
        { key: "Vary", value: "Cookie" },
      ] },
      // Logos y portada por defecto: públicos, sin cookies y casi inmutables. Un día en caché y una semana
      // sirviendo la copia mientras se revalida; el manifiesto y el worker siguen sin caché larga.
      { source: "/:asset(logo|logo-mark|logo-dark|logo-transparent).png", headers: [{ key: "Cache-Control", value: STATIC_ASSET_CACHE }] },
      { source: "/default-book-cover.webp", headers: [{ key: "Cache-Control", value: STATIC_ASSET_CACHE }] },
    ]
  },
  // Pantallas retiradas del prototipo: el acceso publicado es solo Google OAuth,
  // así que las rutas antiguas devuelven al login en lugar de un 404.
  async redirects() {
    return [
      { source: "/signup", destination: "/login", permanent: false },
      { source: "/forgot-password", destination: "/login", permanent: false },
    ]
  },
}

export default nextConfig

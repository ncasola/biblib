import { validateTarget } from "./scripts/db/environment.mjs"

const target = process.env.BIBLIB_TARGET
if (target !== undefined) validateTarget(target)

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: target ? `.next-${target}` : ".next",
  // Primera puerta del acceso local: debe estar definida siempre ("" fuera de local/test), porque Next
  // solo sustituye las variables NEXT_PUBLIC_ definidas y solo así el compilador elimina el formulario.
  env: { NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN: ["local", "test"].includes(target) ? "1" : "" },
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
  images: {
    unoptimized: true,
  },
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ] }]
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

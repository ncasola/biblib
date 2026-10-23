/** @type {import('next').NextConfig} */
const nextConfig = {
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

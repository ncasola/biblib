import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import {
  buildContentSecurityPolicy, createNonce, cspOrigin, GOOGLE_BOOKS_IMAGE_ORIGINS, OPEN_LIBRARY_COVERS_ORIGIN,
} from "../lib/security-headers"

// U-OPS-04 · Política de cabeceras: CSP Report-Only con nonce y hosts concretos, y reglas de
// next.config.mjs (cabeceras globales y caché privada fuera de los estáticos).

const directives = (csp: string) => new Map(csp.split("; ").map((part) => {
  const [name, ...sources] = part.split(" ")
  return [name, sources] as const
}))

test("nonce aleatorio de 128 bits en base64, distinto en cada llamada", () => {
  const nonces = new Set(Array.from({ length: 50 }, createNonce))
  assert.equal(nonces.size, 50)
  for (const nonce of nonces) assert.match(nonce, /^[A-Za-z0-9+/]{22}==$/)
})

test("CSP base: nonce con strict-dynamic, sin unsafe-inline/eval en scripts y sin marcos ni objetos", () => {
  const csp = directives(buildContentSecurityPolicy({ nonce: "AAAAAAAAAAAAAAAAAAAAAA==", supabaseUrl: "http://127.0.0.1:55341" }))
  assert.deepEqual(csp.get("script-src"), ["'self'", "'nonce-AAAAAAAAAAAAAAAAAAAAAA=='", "'strict-dynamic'"])
  assert.deepEqual(csp.get("object-src"), ["'none'"])
  assert.deepEqual(csp.get("frame-ancestors"), ["'none'"])
  assert.deepEqual(csp.get("base-uri"), ["'self'"])
  assert.deepEqual(csp.get("form-action"), ["'self'"])
  assert.deepEqual(csp.get("connect-src"), ["'self'", "http://127.0.0.1:55341"])
  assert.deepEqual(csp.get("img-src"), ["'self'", "data:", "blob:", OPEN_LIBRARY_COVERS_ORIGIN, "http://127.0.0.1:55341"])
  assert.ok(!csp.has("upgrade-insecure-requests"), "Report-Only ignora upgrade-insecure-requests; se decidirá con HTTPS real.")
})

test("hosts concretos: Google solo con la vista previa activada y nunca BNE ni comodines", () => {
  const off = buildContentSecurityPolicy({ nonce: createNonce(), supabaseUrl: "https://proyecto.supabase.co" })
  assert.doesNotMatch(off, /google|bne\.es|\*|https:(?!\/\/)/)
  const on = directives(buildContentSecurityPolicy({ nonce: createNonce(), supabaseUrl: "https://proyecto.supabase.co", googleBooksPreview: true }))
  for (const origin of GOOGLE_BOOKS_IMAGE_ORIGINS) assert.ok(on.get("img-src")?.includes(origin))
  assert.ok(!on.get("connect-src")?.some((source) => source.includes("google")), "El navegador no habla con Google: lo hace el servidor.")
})

test("eval solo en desarrollo y origen de Supabase saneado", () => {
  assert.ok(directives(buildContentSecurityPolicy({ nonce: createNonce(), development: true })).get("script-src")?.includes("'unsafe-eval'"))
  assert.equal(cspOrigin("https://usuario:clave@proyecto.supabase.co/"), undefined)
  assert.equal(cspOrigin("javascript:alert(1)"), undefined)
  assert.equal(cspOrigin("https://proyecto.supabase.co/rest/v1"), "https://proyecto.supabase.co")
  assert.doesNotMatch(buildContentSecurityPolicy({ nonce: createNonce(), supabaseUrl: "no es una url" }), /no es/)
  assert.throws(() => buildContentSecurityPolicy({ nonce: "x'; script-src *" }))
})

interface HeaderRule { source: string; headers: { key: string; value: string }[] }

async function headerRules(): Promise<HeaderRule[]> {
  const loaded = await import(pathToFileURL(path.join(process.cwd(), "next.config.mjs")).href) as { default: { headers(): Promise<HeaderRule[]> } }
  return loaded.default.headers()
}

test("next.config: cámara denegada por defecto y permitida solo en la ruta exacta de alta", async () => {
  const [global] = await headerRules()
  assert.equal(global.source, "/(.*)")
  const values = Object.fromEntries(global.headers.map(({ key, value }) => [key, value]))
  assert.equal(values["X-Content-Type-Options"], "nosniff")
  assert.equal(values["X-Frame-Options"], "DENY")
  assert.equal(values["Referrer-Policy"], "strict-origin-when-cross-origin")
  assert.equal(values["Cross-Origin-Opener-Policy"], "same-origin")
  assert.match(values["Permissions-Policy"], /(^|, )camera=\(\)/)
  assert.ok(!("Content-Security-Policy" in values), "La CSP la publica el proxy, en modo informe.")
  const exceptions = (await headerRules()).slice(1).filter((rule) => rule.headers.some(({ key }) => key === "Permissions-Policy"))
  assert.deepEqual(exceptions, [{ source: "/books/add", headers: [{ key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=()" }] }])
})

test("next.config: caché privada y Vary: Cookie en todo salvo estáticos con hash y archivos de public/", async () => {
  const rule = (await headerRules()).find((item) => item.headers.some(({ key }) => key === "Cache-Control"))
  assert.ok(rule)
  assert.deepEqual(rule.headers, [{ key: "Cache-Control", value: "private, no-store" }, { key: "Vary", value: "Cookie" }])
  // Las fuentes de next.config son path-to-regexp con un grupo de expresión regular: equivalente a esta.
  const matches = new RegExp(`^${rule.source}$`)
  for (const route of ["/", "/books", "/book/0b0c", "/login", "/auth/callback", "/api/books/search", "/api/internal/jobs/run", "/books/search"]) assert.ok(matches.test(route), route)
  for (const route of ["/_next/static/chunks/a.js", "/_next/image", "/logo.png", "/default-book-cover.webp", "/manifest.webmanifest", "/favicon.ico"]) assert.ok(!matches.test(route), route)
})

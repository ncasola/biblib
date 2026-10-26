// Política de cabeceras de U-OPS-04, sin dependencias de Next ni de Supabase para poder probarla
// en aislamiento. La CSP se publica en modo informe (Report-Only) hasta recoger informes en el
// alojamiento real; el inventario y la matriz efectiva están en docs/seguridad.md.

export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only"
/** Cabecera de petición con la que proxy.ts entrega el nonce al layout raíz. */
export const NONCE_HEADER = "x-nonce"
/** HTML autenticado, acciones, API y redirecciones con cookies: nunca en caché compartida. */
export const PRIVATE_CACHE_CONTROL = "private, no-store"

export const OPEN_LIBRARY_COVERS_ORIGIN = "https://covers.openlibrary.org"
/** Solo con la vista previa de Google Books activada (BIBLIB_GOOGLE_BOOKS_ENABLED=true). */
export const GOOGLE_BOOKS_IMAGE_ORIGINS: readonly string[] = ["https://books.google.com", "https://books.googleusercontent.com"]

export interface ContentSecurityPolicyOptions {
  nonce: string
  /** NEXT_PUBLIC_SUPABASE_URL del objetivo; el navegador habla con GoTrue para la sesión. */
  supabaseUrl?: string
  googleBooksPreview?: boolean
  /** React necesita eval en desarrollo para reconstruir pilas de error; nunca en producción. */
  development?: boolean
}

/** Nonce de 128 bits en base64, distinto en cada petición. */
export function createNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
}

/** Origen http(s) sin credenciales ni ruta; cualquier otra forma se descarta. */
export function cspOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

export function buildContentSecurityPolicy({ nonce, supabaseUrl, googleBooksPreview = false, development = false }: ContentSecurityPolicyOptions): string {
  if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(nonce)) throw new Error("Nonce de CSP no válido.")
  const supabase = cspOrigin(supabaseUrl)
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(development ? ["'unsafe-eval'"] : [])]],
    // Los atributos style de React (Radix, transformaciones 3D) no admiten nonce.
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", OPEN_LIBRARY_COVERS_ORIGIN, ...(supabase ? [supabase] : []), ...(googleBooksPreview ? GOOGLE_BOOKS_IMAGE_ORIGINS : [])]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", ["'self'", ...(supabase ? [supabase] : [])]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ]
  return directives.map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ")
}

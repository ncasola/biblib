/** Solo admite destinos internos para volver después del acceso. */
export function getSafeRedirectPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) {
    return "/"
  }
  try {
    const base = "https://biblib.invalid"
    const url = new URL(value, base)
    if (url.origin !== base || /^\/(auth|login|signup|forgot-password)(\/|$)/.test(url.pathname)) return "/"
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return "/"
  }
}

export function isProtectedPath(pathname: string): boolean {
  return pathname === "/" || ["/profile", "/book", "/books", "/shelves", "/series", "/locations", "/loans", "/settings"].some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  )
}

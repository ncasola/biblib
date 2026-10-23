import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { createProxyClient } from "@/lib/supabase/proxy"
import { createSessionAttestation, SESSION_ATTESTATION_HEADER, unverifiedSubject } from "@/lib/supabase/session-attestation"
import { getSafeRedirectPath, isProtectedPath } from "@/lib/auth-navigation"
import { buildContentSecurityPolicy, createNonce, CSP_REPORT_ONLY_HEADER, NONCE_HEADER, PRIVATE_CACHE_CONTROL } from "@/lib/security-headers"

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  // CSP en modo informe con nonce por petición: Next lo lee de la cabecera de la petición y el layout de x-nonce.
  const nonce = createNonce()
  const csp = buildContentSecurityPolicy({
    nonce,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    googleBooksPreview: process.env.BIBLIB_GOOGLE_BOOKS_ENABLED === "true",
    development: process.env.NODE_ENV === "development",
  })
  // Atestación de la sesión que este proxy ha verificado con GoTrue (U-FIX-02); vacía hasta entonces.
  let attestation: string | null = null
  // Se reconstruye en cada uso para incluir las cookies renovadas que se copian a la petición.
  const forward = () => {
    const headers = new Headers(request.headers)
    // La atestación es interna: la que envíe el cliente se descarta siempre, en cualquier ruta.
    headers.delete(SESSION_ATTESTATION_HEADER)
    headers.set(NONCE_HEADER, nonce)
    headers.set(CSP_REPORT_ONLY_HEADER, csp)
    if (attestation) headers.set(SESSION_ATTESTATION_HEADER, attestation)
    return NextResponse.next({ request: { headers } })
  }
  const finish = (response: NextResponse) => {
    response.headers.set(CSP_REPORT_ONLY_HEADER, csp)
    return response
  }

  const isAuthRoute = pathname === "/login"
  if (!isProtectedPath(pathname) && !isAuthRoute) return finish(forward())

  let response = forward()
  const supabase = createProxyClient(request, (cookiesToSet) => {
    const previousCookies = response.cookies.getAll()
    cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
    response = forward()
    previousCookies.forEach((cookie) => response.cookies.set(cookie))
    cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
  })

  let isAuthenticated = false
  let sessionError = false
  try {
    const { data: { user }, error } = await supabase.auth.getUser()
    isAuthenticated = Boolean(user)
    sessionError = Boolean(error && error.name !== "AuthSessionMissingError")
    if (user && !error) {
      // El token que GoTrue acaba de validar (ya renovado si hacía falta): no hay otra llamada de red.
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token && unverifiedSubject(session.access_token) === user.id) {
        attestation = createSessionAttestation({ userId: user.id, accessToken: session.access_token, nonce })
        const previousCookies = response.cookies.getAll()
        response = forward()
        previousCookies.forEach((cookie) => response.cookies.set(cookie))
      }
    }
  } catch {
    sessionError = true
  }

  let redirectUrl: URL | undefined
  if (isProtectedPath(pathname) && !isAuthenticated) {
    redirectUrl = new URL("/login", request.url)
    redirectUrl.searchParams.set("redirect", `${pathname}${search}`)
    if (sessionError) redirectUrl.searchParams.set("error", "session")
  } else if (isAuthRoute && isAuthenticated) {
    redirectUrl = new URL(getSafeRedirectPath(request.nextUrl.searchParams.get("redirect")), request.url)
  }

  if (redirectUrl) {
    const redirectResponse = NextResponse.redirect(redirectUrl)
    response.cookies.getAll().forEach((cookie) => redirectResponse.cookies.set(cookie))
    // La redirección depende de la sesión y puede renovar cookies: nunca en caché compartida.
    redirectResponse.headers.set("Cache-Control", PRIVATE_CACHE_CONTROL)
    redirectResponse.headers.set("Vary", "Cookie")
    return finish(redirectResponse)
  }
  return finish(response)
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.svg|.*\\.webp).*)"],
}

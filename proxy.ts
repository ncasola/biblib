import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { createProxyClient } from "@/lib/supabase/proxy"
import { getSafeRedirectPath, isProtectedPath } from "@/lib/auth-navigation"

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const isAuthRoute = ["/login", "/signup"].includes(pathname)
  if (!isProtectedPath(pathname) && !isAuthRoute) return NextResponse.next()

  let response = NextResponse.next({ request })
  const supabase = createProxyClient(request, (cookiesToSet) => {
    const previousCookies = response.cookies.getAll()
    cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
    response = NextResponse.next({ request })
    previousCookies.forEach((cookie) => response.cookies.set(cookie))
    cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
  })

  let isAuthenticated = false
  let sessionError = false
  try {
    const { data: { user }, error } = await supabase.auth.getUser()
    isAuthenticated = Boolean(user)
    sessionError = Boolean(error && error.name !== "AuthSessionMissingError")
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
    return redirectResponse
  }
  return response
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.svg|.*\\.webp).*)"],
}

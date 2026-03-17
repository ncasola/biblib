import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { createProxyClient } from "@/lib/supabase/proxy"

// Routes that require authentication
const protectedRoutes = ["/profile", "/books", "/shelves", "/settings"]

// Routes that should redirect to dashboard if already authenticated
const authRoutes = ["/login", "/signup"]

export function proxy(request: NextRequest) {
  const response = NextResponse.next()
  const supabase = createProxyClient(request, response)
  const { pathname } = request.nextUrl

  return supabase.auth.getUser().then(({ data: { user } }) => {
    const isAuthenticated = Boolean(user)

    // Protect routes that require authentication
    if (protectedRoutes.some((route) => pathname.startsWith(route))) {
      if (!isAuthenticated) {
        const loginUrl = new URL("/login", request.url)
        loginUrl.searchParams.set("redirect", pathname)
        return NextResponse.redirect(loginUrl)
      }
    }

    // Redirect authenticated users away from auth pages
    if (authRoutes.some((route) => pathname.startsWith(route))) {
      if (isAuthenticated) {
        return NextResponse.redirect(new URL("/", request.url))
      }
    }

    return response
  })
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.svg|.*\\.webp).*)"],
}

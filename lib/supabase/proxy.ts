import { createServerClient, type CookieOptions } from "@supabase/ssr"
import type { NextRequest } from "next/server"

export function createProxyClient(
  request: NextRequest,
  setCookies: (cookies: { name: string; value: string; options: CookieOptions }[]) => void,
) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    throw new Error("Missing Supabase public environment variables")
  }

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        setCookies(cookiesToSet)
      },
    },
  })
}

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getSafeRedirectPath } from "@/lib/auth-navigation"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const next = getSafeRedirectPath(url.searchParams.get("next"))

  if (code && !url.searchParams.has("error")) {
    try {
      const supabase = await createClient()
      const { error } = await supabase.auth.exchangeCodeForSession(code)
      if (!error) return new NextResponse(null, { status: 303, headers: { Location: next } })
    } catch {
      // Permitir volver a intentar el acceso si falla la conexión o el intercambio.
    }
  }

  const parameters = new URLSearchParams({ error: "oauth", redirect: next })
  return new NextResponse(null, { status: 303, headers: { Location: `/login?${parameters}` } })
}

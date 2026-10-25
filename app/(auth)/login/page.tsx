"use client"

import type React from "react"

import { Suspense, useState } from "react"
import { useSearchParams } from "next/navigation"
import dynamic from "next/dynamic"
import Link from "next/link"
import Image from "next/image"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Loader2, Chrome } from "lucide-react"

// Primera puerta del acceso local: la variable la fija childEnv solo para local/test. En cualquier otro
// build se sustituye por un literal distinto de "1" y el compilador elimina el import y todo el formulario.
const LocalPasswordForm = process.env.NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN === "1"
  ? dynamic(() => import("./local-password-form"), { loading: () => null })
  : null

function LoginFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md p-8 shadow-2xl">
        <div className="flex items-center justify-center gap-3 text-muted-foreground">
          <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin text-brass-text" />
          <p className="font-medium">Cargando acceso...</p>
        </div>
      </Card>
    </div>
  )
}

function LoginContent() {
  const searchParams = useSearchParams()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const { signInWithGoogle } = useAuth()
  const accessError = searchParams.get("error") === "oauth"
    ? "No se pudo completar el acceso con Google. Vuelve a intentarlo."
    : searchParams.get("error") === "session"
      ? "No se pudo comprobar tu sesión. Inicia sesión de nuevo."
      : ""

  const handleGoogleLogin = async () => {
    setLoading(true)
    setError("")

    try {
      const redirectPath = searchParams.get("redirect") ?? undefined
      await signInWithGoogle(redirectPath)
    } catch {
      setError("No se pudo iniciar sesión con Google")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md gap-0 px-6 py-8 shadow-2xl sm:px-8">
        <div className="mb-8 flex flex-col items-center">
          {/* Logo completo sin fondo: tinta sobre crema en claro y la variante para fondos oscuros en oscuro. */}
          <Image src="/logo-transparent.png" alt="BibLib Logo" width={160} height={160} priority className="mb-2 size-40 object-contain dark:hidden" />
          <Image src="/logo-dark.png" alt="BibLib Logo" width={160} height={160} priority className="mb-2 hidden size-40 object-contain dark:block" />
          <p className="eyebrow">Biblioteca personal</p>
          <h1 className="heading-vintage mt-1 text-center text-3xl sm:text-4xl">Bienvenido a BibLib</h1>
          <p className="mt-2 text-center text-foreground-light">Inicia sesión con tu cuenta de Google</p>
        </div>

        <div className="space-y-6">
          {(error || accessError) && <p role="alert" className="text-destructive text-sm">{error || accessError}</p>}

          <Button
            type="button"
            onClick={handleGoogleLogin}
            disabled={loading}
            size="lg"
            className="w-full text-base"
          >
            {loading ? (
              <>
                <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />
                Redirigiendo...
              </>
            ) : (
              <>
                <Chrome aria-hidden="true" className="h-5 w-5" />
                Continuar con Google
              </>
            )}
          </Button>
        </div>

        {LocalPasswordForm && <LocalPasswordForm redirectPath={searchParams.get("redirect") ?? undefined} />}

        <div className="mt-6 text-center">
          <p className="text-sm text-muted-foreground">
            El acceso se gestiona con Google OAuth.{" "}
            <Link href="/" className="link-quiet">
              Volver al inicio
            </Link>
          </p>
        </div>
      </Card>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginContent />
    </Suspense>
  )
}

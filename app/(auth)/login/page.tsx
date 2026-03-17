"use client"

import type React from "react"

import { Suspense, useState } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import Image from "next/image"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Loader2, Chrome } from "lucide-react"

function LoginFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-vintage-yellow/10 via-background to-vintage-purple/10">
      <Card className="w-full max-w-md p-8 bg-card/80 backdrop-blur-xl border-2 border-border/50 shadow-2xl rounded-2xl">
        <div className="flex items-center justify-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-vintage-red" />
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
    <div className="min-h-screen flex items-center justify-center p-4 bg-linear-to-br from-vintage-yellow/10 via-background to-vintage-purple/10">
      <Card className="w-full max-w-md p-8 bg-card/80 backdrop-blur-xl border-2 border-border/50 shadow-2xl rounded-2xl">
        <div className="flex flex-col items-center mb-8">
          <Image
            src="/logo.png"
            alt="BibLib Logo"
            width={80}
            height={80}
            className="mb-4 rounded-full border-2 border-border/60 bg-card/90 p-1"
          />
          <h1 className="text-3xl font-bold heading-vintage text-center">Bienvenido a BibLib</h1>
          <p className="text-muted-foreground text-center mt-2">Inicia sesión con tu cuenta de Google</p>
        </div>

        <div className="space-y-6">
          {error && <p className="text-red-600 text-sm">{error}</p>}

          <Button
            type="button"
            onClick={handleGoogleLogin}
            disabled={loading}
            className="w-full bg-vintage-red hover:bg-vintage-red/90 text-white rounded-xl py-6 text-lg font-semibold flex items-center justify-center"
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Redirigiendo...
              </>
            ) : (
              <>
                <Chrome className="mr-2 h-5 w-5" />
                Continuar con Google
              </>
            )}
          </Button>
        </div>

        <div className="mt-6 text-center">
          <p className="text-muted-foreground">
            El acceso se gestiona con Google OAuth.{" "}
            <Link href="/" className="text-vintage-olive font-semibold hover:underline">
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

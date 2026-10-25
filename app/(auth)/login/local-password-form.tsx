"use client"

import { useId, useState, type FormEvent } from "react"
import { Loader2, LogIn } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { signInWithLocalPasswordAction } from "./actions"

// Este componente solo se compila con NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN=1 (local/test).
// El literal del atributo de abajo permite comprobar su ausencia en builds remotos.
export default function LocalPasswordForm({ redirectPath }: { redirectPath?: string }) {
  const ids = useId()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    if (redirectPath) data.set("redirect", redirectPath)
    setLoading(true)
    setError("")
    try {
      const result = await signInWithLocalPasswordAction(data)
      if (result.ok) {
        // Navegación completa: el AuthProvider lee las cookies de sesión recién creadas.
        window.location.assign(result.redirectTo)
        return
      }
      setError(result.message)
      const password = form.elements.namedItem("password")
      if (password instanceof HTMLInputElement) password.value = ""
    } catch {
      setError("No se pudo iniciar sesión en local. Inténtalo de nuevo.")
    }
    setLoading(false)
  }

  return (
    <section
      aria-labelledby={`${ids}-title`}
      data-biblib-local-login="biblib-local-password-form"
      className="mt-6 rounded-2xl border border-dashed border-control-border/70 bg-surface/60 p-4"
    >
      <h2 id={`${ids}-title`} className="heading-vintage text-lg">
        Acceso local de desarrollo
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Solo existe en este entorno local. No aparece en preproducción ni en producción y solo acepta el Supabase local de este equipo.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor={`${ids}-email`}>Correo</Label>
          <Input
            id={`${ids}-email`}
            name="email"
            type="email"
            autoComplete="username"
            required
            maxLength={254}
            disabled={loading}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${ids}-error` : undefined}
            className="bg-input"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${ids}-password`}>Contraseña</Label>
          <Input
            id={`${ids}-password`}
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            disabled={loading}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${ids}-error` : undefined}
            className="bg-input"
          />
        </div>

        {error && (
          <p id={`${ids}-error`} role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        )}

        <Button
          type="submit"
          disabled={loading}
          variant="secondary"
          size="lg"
          className="w-full"
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              Entrando...
            </>
          ) : (
            <>
              <LogIn className="mr-2 h-4 w-4" aria-hidden="true" />
              Entrar
            </>
          )}
        </Button>
      </form>
    </section>
  )
}

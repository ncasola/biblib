"use client"

import type React from "react"

import { useState } from "react"
import { useAuth, type User } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Loader2 } from "lucide-react"

export default function ProfilePage() {
  const { user, loading } = useAuth()

  if (loading || !user) {
    return <p role="status" className="py-6 text-center">{loading ? "Cargando perfil..." : "Inicia sesión para ver tu perfil."}</p>
  }

  return <ProfileForm key={user.id} user={user} />
}

function ProfileForm({ user }: { user: User }) {
  const { updateProfile } = useAuth()
  const [name, setName] = useState(user.name)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState("")

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (loading) return
    setLoading(true)
    setSuccess(false)
    setError("")
    try {
      await updateProfile(name)
      setName(name.trim())
      setSuccess(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo guardar el perfil.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
        <h1 className="text-4xl font-bold heading-vintage mb-8 text-vintage-red">Mi perfil</h1>

        <div className="grid gap-8 md:grid-cols-[300px_minmax(0,1fr)]">
          <Card className="p-6 bg-card/80 backdrop-blur-xl border-2 border-border/50 rounded-2xl h-fit">
            <div className="flex flex-col items-center">
              <div className="relative mb-4">
                <Avatar className="w-32 h-32 border-4 border-vintage-yellow">
                  <AvatarImage src={user.avatar} alt="Foto de tu cuenta de Google" />
                  <AvatarFallback className="bg-accent text-accent-foreground text-3xl">
                    {user.name?.charAt(0).toUpperCase() || user.email.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              </div>
              <h2 className="max-w-full break-words text-xl font-bold">{user.name || user.email}</h2>
              <p className="text-muted-foreground text-sm break-all">{user.email}</p>
              <p className="text-muted-foreground text-sm mt-3 text-center">Foto y correo vinculados a tu cuenta de Google.</p>
            </div>
          </Card>

          <Card className="p-5 sm:p-8 bg-card/80 backdrop-blur-xl border-2 border-border/50 rounded-2xl">
            <h2 className="text-2xl font-bold heading-vintage mb-6">Información de la cuenta</h2>

            <form onSubmit={handleSubmit} className="space-y-6" aria-busy={loading}>
              <div className="space-y-2">
                <Label htmlFor="name">Nombre</Label>
                <Input
                  id="name"
                  type="text"
                  autoComplete="name"
                  required
                  maxLength={100}
                  disabled={loading}
                  value={name}
                  onChange={(e) => { setName(e.target.value); setSuccess(false); setError("") }}
                  className="rounded-xl border-2"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Correo</Label>
                <Input
                  id="email"
                  type="email"
                  value={user.email}
                  readOnly
                  aria-describedby="email-description"
                  className="rounded-xl border-2"
                />
                <p id="email-description" className="text-sm text-muted-foreground">El correo se gestiona desde Google.</p>
              </div>

              <div className="pt-4">
                {success && <p role="status" className="text-foreground text-sm mb-4">Perfil actualizado correctamente.</p>}
                {error && <p role="alert" className="text-destructive text-sm mb-4">{error}</p>}
                <Button
                  type="submit"
                  disabled={loading || !name.trim() || name.trim() === user.name}
                  className="bg-vintage-red hover:bg-vintage-red/90 text-white rounded-xl"
                >
                  {loading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Guardando...
                    </>
                  ) : (
                    "Guardar cambios"
                  )}
                </Button>
              </div>
            </form>
          </Card>
        </div>
    </div>
  )
}

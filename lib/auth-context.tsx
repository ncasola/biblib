"use client"

import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import type { Session, User as SupabaseUser } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/client"
import { getSafeRedirectPath } from "@/lib/auth-navigation"

export interface User {
  id: string
  email: string
  name: string
  avatar?: string
  createdAt: string
}

interface AuthContextType {
  user: User | null
  session: Session | null
  loading: boolean
  signInWithGoogle: (nextPath?: string) => Promise<void>
  signOut: () => Promise<void>
  updateProfile: (name: string) => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

function mapUser(user: SupabaseUser): User {
  const fullName = user.user_metadata.display_name ?? user.user_metadata.full_name
  const fallbackName = user.email?.split("@")[0] ?? "Lector"
  return {
    id: user.id,
    email: user.email ?? "",
    name: typeof fullName === "string" && fullName.length > 0 ? fullName : fallbackName,
    avatar: typeof user.user_metadata.avatar_url === "string" ? user.user_metadata.avatar_url : undefined,
    createdAt: user.created_at,
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [supabase] = useState(() => createClient())
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    let receivedAuthEvent = false
    const loadInitialSession = async () => {
      try {
        const { data: { session: initialSession }, error } = await supabase.auth.getSession()
        if (active && !receivedAuthEvent) {
          setSession(error ? null : initialSession)
          setUser(!error && initialSession?.user ? mapUser(initialSession.user) : null)
        }
      } catch {
        if (active && !receivedAuthEvent) {
          setSession(null)
          setUser(null)
        }
      } finally {
        if (active) setLoading(false)
      }
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return
      receivedAuthEvent = true
      setSession(nextSession)
      setUser(nextSession?.user ? mapUser(nextSession.user) : null)
      setLoading(false)
    })

    void loadInitialSession()

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [supabase])

  const signInWithGoogle = async (nextPath?: string) => {
    const origin = typeof window !== "undefined" ? window.location.origin : ""
    const redirectTarget = `/auth/callback?next=${encodeURIComponent(getSafeRedirectPath(nextPath))}`
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${origin}${redirectTarget}`,
      },
    })

    if (error) {
      throw error
    }
  }

  const signOut = async () => {
    const { error } = await supabase.auth.signOut()
    if (error) throw new Error("No se pudo cerrar la sesión. Vuelve a intentarlo.")
    setUser(null)
    setSession(null)
  }

  const updateProfile = async (name: string) => {
    const displayName = name.trim()
    if (!displayName || displayName.length > 100) throw new Error("El nombre debe tener entre 1 y 100 caracteres.")
    const { data, error } = await supabase.auth.updateUser({ data: { display_name: displayName } })
    if (error || !data.user) throw new Error("No se pudo guardar el perfil. Comprueba la conexión y vuelve a intentarlo.")
    setUser(mapUser(data.user))
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        signInWithGoogle,
        signOut,
        updateProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error("useAuth debe usarse dentro de un AuthProvider")
  }
  return context
}

"use client"

import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import type { Session, User as SupabaseUser } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/client"

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
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, name: string) => Promise<void>
  signOut: () => Promise<void>
  resetPassword: (email: string) => Promise<void>
  updatePassword: (newPassword: string) => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

function mapUser(user: SupabaseUser): User {
  const fullName = user.user_metadata.full_name
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
    const loadInitialSession = async () => {
      const {
        data: { session: initialSession },
      } = await supabase.auth.getSession()
      setSession(initialSession)
      setUser(initialSession?.user ? mapUser(initialSession.user) : null)
      setLoading(false)
    }

    void loadInitialSession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setUser(nextSession?.user ? mapUser(nextSession.user) : null)
      setLoading(false)
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [supabase])

  const signInWithGoogle = async (nextPath?: string) => {
    const origin = typeof window !== "undefined" ? window.location.origin : ""
    const redirectTarget = nextPath ? `/auth/callback?next=${encodeURIComponent(nextPath)}` : "/auth/callback"
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

  const signIn = async (_email: string, _password: string) => {
    void _email
    void _password
    throw new Error("El inicio de sesión con correo/contraseña está deshabilitado. Usa Google.")
  }

  const signUp = async (_email: string, _password: string, _name: string) => {
    void _email
    void _password
    void _name
    throw new Error("El registro se gestiona con Google OAuth.")
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setUser(null)
    setSession(null)
  }

  const resetPassword = async (_email: string) => {
    void _email
    throw new Error("La recuperación de contraseña no está disponible con Google OAuth")
  }

  const updatePassword = async (_newPassword: string) => {
    void _newPassword
    throw new Error("El cambio de contraseña no está disponible con Google OAuth")
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        signInWithGoogle,
        signIn,
        signUp,
        signOut,
        resetPassword,
        updatePassword,
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

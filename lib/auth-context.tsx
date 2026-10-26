"use client"

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import type { Session, User as SupabaseUser } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/client"
import { getSafeRedirectPath } from "@/lib/auth-navigation"
import { getProfileAvatarAction } from "@/app/actions/profile"
import { purgeOfflineCopy } from "@/lib/offline-library"

/** U-EXP-08: borra la copia de lectura de la cuenta en este dispositivo; un fallo local no impide cerrar sesión. */
const purgeOfflineCopyQuietly = (userId: string) => purgeOfflineCopy(userId).catch(() => undefined)

export interface User {
  id: string
  email: string
  name: string
  avatar?: string
  googleAvatar?: string
  ownAvatar?: boolean
  createdAt: string
}

interface AuthContextType {
  user: User | null
  session: Session | null
  loading: boolean
  signInWithGoogle: (nextPath?: string) => Promise<void>
  signOut: () => Promise<void>
  updateProfile: (name: string) => Promise<void>
  refreshAvatar: (saved?: { avatar?: string; version: string }) => Promise<void>
  avatarVersion: string | null
  avatarEditorEnabled: boolean
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
    googleAvatar: typeof user.user_metadata.avatar_url === "string" ? user.user_metadata.avatar_url : undefined,
    createdAt: user.created_at,
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [supabase] = useState(() => createClient())
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [privateProfile, setPrivateProfile] = useState<{ owner: string; avatar?: string; version: string | null; editorEnabled: boolean } | null>(null)
  const owner = user?.id
  // Última cuenta con sesión: si Supabase la cierra (otra pestaña, sesión revocada al reconectar), se purga su copia.
  const lastUserId = useRef<string | null>(null)

  useEffect(() => {
    if (!owner) return
    let active = true
    void getProfileAvatarAction().then((result) => {
      if (active && result.ok) setPrivateProfile({ owner, ...result.value })
    }).catch(() => undefined)
    return () => { active = false }
  }, [owner])

  const refreshAvatar = async (saved?: { avatar?: string; version: string }) => {
    if (!owner) return
    // La respuesta confirmada ya contiene URL y versión: no añadir una lectura de red que pueda
    // presentar como fallido un guardado que terminó correctamente.
    if (saved) {
      setPrivateProfile((current) => ({ owner, ...saved, editorEnabled: current?.owner === owner && current.editorEnabled }))
      return
    }
    const result = await getProfileAvatarAction()
    if (!result.ok) throw new Error(result.error.message)
    setPrivateProfile({ owner, ...result.value })
  }
  const ownProfile = privateProfile?.owner === owner ? privateProfile : null
  const displayedUser = user ? { ...user, avatar: ownProfile?.avatar || user.avatar, ownAvatar: Boolean(ownProfile?.avatar) } : null

  useEffect(() => {
    let active = true
    let receivedAuthEvent = false
    const loadInitialSession = async () => {
      try {
        const { data: { session: initialSession }, error } = await supabase.auth.getSession()
        if (active && !receivedAuthEvent) {
          setSession(error ? null : initialSession)
          setUser(!error && initialSession?.user ? mapUser(initialSession.user) : null)
          lastUserId.current = !error && initialSession?.user ? initialSession.user.id : null
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
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return
      receivedAuthEvent = true
      if (event === "SIGNED_OUT" && lastUserId.current) void purgeOfflineCopyQuietly(lastUserId.current)
      lastUserId.current = nextSession?.user.id ?? null
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
    // Se borra antes de cerrar: la copia de esta cuenta no sobrevive al cierre de sesión en este dispositivo.
    const current = user?.id ?? session?.user.id
    if (current) await purgeOfflineCopyQuietly(current)
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
        user: displayedUser,
        session,
        loading,
        signInWithGoogle,
        signOut,
        updateProfile,
        refreshAvatar,
        avatarVersion: ownProfile?.version ?? null,
        avatarEditorEnabled: ownProfile?.editorEnabled ?? false,
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

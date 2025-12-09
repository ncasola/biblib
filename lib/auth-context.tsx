"use client"

import { createContext, useContext, useState, type ReactNode } from "react"

// Mock user type - ready for Supabase User type
export interface User {
  id: string
  email: string
  name: string
  avatar?: string
  createdAt: string
}

interface AuthContextType {
  user: User | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, name: string) => Promise<void>
  signOut: () => Promise<void>
  resetPassword: (email: string) => Promise<void>
  updatePassword: (newPassword: string) => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    if (typeof window === "undefined") return null
    const storedUser = localStorage.getItem("biblib_user")
    return storedUser ? (JSON.parse(storedUser) as User) : null
  })
  const loading = false

  const signIn = async (email: string, _password: string) => {
    void _password
    // Mock sign in - replace with Supabase auth
    await new Promise((resolve) => setTimeout(resolve, 1000))

    const mockUser: User = {
      id: "mock-user-id",
      email,
      name: email.split("@")[0],
      createdAt: new Date().toISOString(),
    }

    setUser(mockUser)
    localStorage.setItem("biblib_user", JSON.stringify(mockUser))
  }

  const signUp = async (email: string, _password: string, name: string) => {
    void _password
    // Mock sign up - replace with Supabase auth
    await new Promise((resolve) => setTimeout(resolve, 1000))

    const mockUser: User = {
      id: "mock-user-id",
      email,
      name,
      createdAt: new Date().toISOString(),
    }

    setUser(mockUser)
    localStorage.setItem("biblib_user", JSON.stringify(mockUser))
  }

  const signOut = async () => {
    // Mock sign out - replace with Supabase auth
    await new Promise((resolve) => setTimeout(resolve, 500))
    setUser(null)
    localStorage.removeItem("biblib_user")
  }

  const resetPassword = async (email: string) => {
    // Mock reset password - replace with Supabase auth
    await new Promise((resolve) => setTimeout(resolve, 1000))
    console.log("[v0] Password reset email sent to:", email)
  }

  const updatePassword = async (_newPassword: string) => {
    void _newPassword
    // Mock update password - replace with Supabase auth
    await new Promise((resolve) => setTimeout(resolve, 1000))
    console.log("[v0] Password updated")
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
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
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return context
}

"use client"

import Link from "next/link"
import Image from "next/image"
import { useTheme } from "@/hooks/use-theme"
import { Button } from "@/components/ui/button"
import { Menu, Sun, Moon, User, LogOut, Settings } from "lucide-react"
import { useState } from "react"
import { useAuth } from "@/lib/auth-context"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { useRouter } from "next/navigation"

export function Header() {
  const { theme, toggleTheme } = useTheme()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const { user, signOut } = useAuth()
  const router = useRouter()

  const handleSignOut = async () => {
    await signOut()
    router.push("/login")
  }

  return (
    <header className="sticky top-0 z-50 border-b-2 rounded-2xl border-border/50 bg-card/80 backdrop-blur-xl shadow-lg">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3 group">
          <Image
            src="/logo.png"
            alt="BibLib Logo"
            width={50}
            height={50}
            className="rounded-full border-2 border-border/60 bg-card transition-transform group-hover:scale-110"
          />
          <span className="text-2xl font-bold heading-vintage">BibLib</span>
        </Link>

        {/* Desktop Navigation */}
        <nav className="hidden md:flex gap-8 items-center">
          <Link href="/" className="text-foreground font-semibold hover:text-vintage-red transition-colors">
            Inicio
          </Link>
          <Link href="/books" className="text-foreground font-semibold hover:text-vintage-olive transition-colors">
            Libros
          </Link>
          <Link href="/shelves" className="text-foreground font-semibold hover:text-vintage-purple transition-colors">
            Estanterías
          </Link>
          <Link href="/settings" className="text-foreground font-semibold hover:text-vintage-yellow transition-colors">
            Ajustes
          </Link>
        </nav>

        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={toggleTheme} className="rounded-xl hover:bg-vintage-yellow/20">
            {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </Button>

          {user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="hidden md:flex gap-2 rounded-xl hover:bg-vintage-purple/20">
                  <Avatar className="w-8 h-8">
                    <AvatarImage src={user.avatar || "/placeholder.svg"} />
                    <AvatarFallback className="bg-vintage-yellow text-black">
                      {user.name?.charAt(0).toUpperCase() || user.email.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="font-semibold">{user.name || user.email}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 bg-card/95 backdrop-blur-xl border-2 border-border">
                <DropdownMenuLabel className="text-vintage-red">Mi cuenta</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/profile" className="cursor-pointer">
                    <User className="mr-2 h-4 w-4" />
                    <span>Perfil</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings" className="cursor-pointer">
                    <Settings className="mr-2 h-4 w-4" />
                    <span>Ajustes</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleSignOut} className="cursor-pointer text-red-600">
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Cerrar sesión</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button asChild className="hidden md:flex bg-vintage-red hover:bg-vintage-red/90 text-white rounded-xl">
              <Link href="/login">Iniciar sesión</Link>
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon"
            className="md:hidden rounded-xl"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            <Menu className="w-5 h-5" />
          </Button>
        </div>
      </div>

      {/* Mobile Navigation */}
      {mobileMenuOpen && (
        <nav className="md:hidden border-t-2 border-border px-4 py-4 flex flex-col gap-4 bg-card backdrop-blur-md">
          <Link href="/" className="text-foreground hover:text-primary transition-colors">
            Inicio
          </Link>
          <Link href="/books" className="text-foreground hover:text-primary transition-colors">
            Libros
          </Link>
          <Link href="/shelves" className="text-foreground hover:text-primary transition-colors">
            Estanterías
          </Link>
          <Link href="/settings" className="text-foreground hover:text-primary transition-colors">
            Ajustes
          </Link>
          {user ? (
            <>
              <Link href="/profile" className="text-foreground hover:text-primary transition-colors">
                Perfil
              </Link>
              <button onClick={handleSignOut} className="text-left text-red-600 hover:text-red-700 transition-colors">
                Cerrar sesión
              </button>
            </>
          ) : (
            <Link href="/login" className="text-foreground hover:text-primary transition-colors">
              Iniciar sesión
            </Link>
          )}
        </nav>
      )}
    </header>
  )
}

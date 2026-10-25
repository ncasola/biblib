"use client"

import Link from "next/link"
import Image from "next/image"
import { usePathname, useRouter } from "next/navigation"
import { useRef, useState } from "react"
import { useTheme } from "@/hooks/use-theme"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Menu, Sun, Moon, User, LogOut, Settings, X } from "lucide-react"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { UserAvatar } from "@/components/user-avatar"

const navigation = [
  { href: "/", label: "Inicio" },
  { href: "/books", label: "Libros" },
  { href: "/shelves", label: "Estanterías" },
  { href: "/settings", label: "Ajustes" },
]

export function Header() {
  const { theme, toggleTheme, mounted } = useTheme()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState("")
  const menuButton = useRef<HTMLButtonElement>(null)
  const { user, loading, signOut } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  const isActive = (href: string) => href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`) || (href === "/books" && pathname.startsWith("/book/"))
  const linkClass = (href: string) => `flex min-h-11 items-center rounded-lg px-2 py-1 font-semibold transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-ring ${isActive(href) ? "bg-primary/10 text-primary underline underline-offset-4" : "text-foreground"}`

  const closeMenu = () => setMobileMenuOpen(false)
  const handleSignOut = async () => {
    if (signingOut) return
    setSigningOut(true)
    setError("")
    try {
      await signOut()
      closeMenu()
      router.replace("/login")
      router.refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo cerrar la sesión.")
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <header onBlur={(event) => { if (mobileMenuOpen && !event.currentTarget.contains(event.relatedTarget)) closeMenu() }} onKeyDown={(event) => { if (event.key === "Escape" && mobileMenuOpen) { closeMenu(); menuButton.current?.focus() } }} className="sticky top-0 z-50 border-b-2 rounded-2xl border-border/50 bg-card/80 backdrop-blur-xl shadow-lg">
      <a tabIndex={0} href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-background focus:p-3 focus:text-foreground focus:shadow-lg">Saltar al contenido</a>
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
        <Link tabIndex={0} href="/" onClick={closeMenu} aria-label="BibLib, inicio" className="flex items-center gap-3 group shrink-0">
          <Image src="/logo.png" alt="" width={50} height={50} className="rounded-full border-2 border-border/60 bg-card transition-transform motion-safe:group-hover:scale-110" />
          <span className="text-2xl font-bold heading-vintage">BibLib</span>
        </Link>
        <nav aria-label="Navegación principal" className="hidden md:flex gap-2 lg:gap-5 items-center">
          {navigation.map(({ href, label }) => <Link tabIndex={0} key={href} href={href} aria-current={isActive(href) ? "page" : undefined} className={linkClass(href)}>{label}</Link>)}
        </nav>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={toggleTheme} disabled={!mounted} aria-label={theme === "dark" ? "Activar tema claro" : "Activar tema oscuro"} className="rounded-xl hover:bg-vintage-yellow/20">
            {theme === "dark" ? <Sun aria-hidden="true" className="w-5 h-5" /> : <Moon aria-hidden="true" className="w-5 h-5" />}
          </Button>
          {loading ? <span role="status" className="hidden md:block text-sm text-muted-foreground">Cargando cuenta...</span> : user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" aria-label={`Abrir menú de cuenta de ${user.name || user.email}`} className="hidden md:flex gap-2 rounded-xl hover:bg-vintage-purple/20 max-w-52">
                  <UserAvatar user={user} decorative className="w-8 h-8 shrink-0" />
                  <span className="hidden font-semibold truncate lg:inline">{user.name || user.email}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 bg-card/95 backdrop-blur-xl border-2 border-border">
                <DropdownMenuLabel>Mi cuenta</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild><Link href="/profile"><User aria-hidden="true" className="mr-2 h-4 w-4" />Perfil</Link></DropdownMenuItem>
                <DropdownMenuItem asChild><Link href="/settings"><Settings aria-hidden="true" className="mr-2 h-4 w-4" />Ajustes</Link></DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={signingOut} onClick={() => void handleSignOut()} className="text-destructive"><LogOut aria-hidden="true" className="mr-2 h-4 w-4" />{signingOut ? "Cerrando sesión..." : "Cerrar sesión"}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : <Button asChild className="hidden md:flex bg-vintage-red hover:bg-vintage-red/90 text-white rounded-xl"><Link href="/login">Iniciar sesión</Link></Button>}
          <Button ref={menuButton} variant="ghost" size="icon" className="md:hidden rounded-xl" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label={mobileMenuOpen ? "Cerrar menú" : "Abrir menú"} aria-expanded={mobileMenuOpen} aria-controls="mobile-navigation">
            {mobileMenuOpen ? <X aria-hidden="true" className="w-5 h-5" /> : <Menu aria-hidden="true" className="w-5 h-5" />}
          </Button>
        </div>
      </div>
      {error && <p role="alert" className="max-w-7xl mx-auto px-4 pb-3 text-sm text-destructive">{error}</p>}
      {mobileMenuOpen && (
        <nav id="mobile-navigation" aria-label="Navegación móvil" className="md:hidden max-h-[calc(100dvh-5rem)] overflow-y-auto border-t-2 border-border px-4 py-4 flex flex-col gap-3 bg-card">
          {navigation.map(({ href, label }) => <Link tabIndex={0} key={href} href={href} onClick={closeMenu} aria-current={isActive(href) ? "page" : undefined} className={linkClass(href)}>{label}</Link>)}
          {loading ? <p role="status" className="text-sm text-muted-foreground">Cargando cuenta...</p> : user ? <>
            <Link tabIndex={0} href="/profile" onClick={closeMenu} aria-current={pathname === "/profile" ? "page" : undefined} className={linkClass("/profile")}><UserAvatar user={user} decorative className="mr-2 size-8 shrink-0" />Perfil</Link>
            <Button variant="ghost" disabled={signingOut} onClick={() => void handleSignOut()} className="justify-start text-destructive">{signingOut ? "Cerrando sesión..." : "Cerrar sesión"}</Button>
          </> : <Link tabIndex={0} href="/login" onClick={closeMenu} className={linkClass("/login")}>Iniciar sesión</Link>}
        </nav>
      )}
    </header>
  )
}

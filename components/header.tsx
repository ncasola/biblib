"use client"

import Link from "next/link"
import Image from "next/image"
import { usePathname, useRouter } from "next/navigation"
import { useRef, useState } from "react"
import { useTheme } from "@/hooks/use-theme"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Menu, Sun, Moon, User, LogOut, Settings, X, Search, Plus } from "lucide-react"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { UserAvatar } from "@/components/user-avatar"

const navigation = [
  { href: "/", label: "Inicio" },
  { href: "/books", label: "Libros" },
  { href: "/shelves", label: "Estanterías" },
  { href: "/series", label: "Series" },
  { href: "/locations", label: "Ubicaciones" },
  { href: "/settings", label: "Ajustes" },
]

/**
 * Búsqueda rápida de la cabecera: un formulario GET normal hacia la colección (`/books?q=…`), que ya lee
 * la consulta de la dirección. No se muestra donde la página tiene su propio buscador.
 */
function QuickSearch({ id, className }: { id: string; className?: string }) {
  return (
    <form action="/books" method="get" role="search" aria-label="Buscar en la colección" className={className}>
      <label htmlFor={id} className="sr-only">Buscar en la colección</label>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input id={id} name="q" type="search" maxLength={500} placeholder="Título, autor o ISBN" autoComplete="off" className="h-11 w-full rounded-xl border border-control-border bg-input/70 pl-10 pr-3 text-[0.9375rem] text-foreground placeholder:text-muted-foreground transition-colors hover:bg-input" />
      </div>
    </form>
  )
}

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
  const linkClass = (href: string) => `inline-flex min-h-11 items-center rounded-full px-3.5 text-[0.9375rem] font-medium transition-colors ${isActive(href) ? "bg-foreground text-background shadow-sm" : "text-foreground-light hover:bg-accent hover:text-accent-foreground"}`
  const mobileLinkClass = (href: string) => `flex min-h-11 items-center gap-2 rounded-xl px-3 font-medium transition-colors ${isActive(href) ? "bg-foreground text-background" : "text-foreground hover:bg-accent hover:text-accent-foreground"}`
  // La colección y su búsqueda avanzada ya tienen buscador; el alta no necesita el atajo de añadir.
  const showSearch = !pathname.startsWith("/books")
  const showAdd = pathname !== "/books/add"

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
    <header onBlur={(event) => { if (mobileMenuOpen && !event.currentTarget.contains(event.relatedTarget)) closeMenu() }} onKeyDown={(event) => { if (event.key === "Escape" && mobileMenuOpen) { closeMenu(); menuButton.current?.focus() } }} className="sticky top-0 z-50 border-b border-border/70 bg-background/85 shadow-[0_10px_30px_-24px_rgb(0_0_0/0.6)] backdrop-blur-xl">
      <a tabIndex={0} href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-xl focus:bg-card focus:p-3 focus:text-foreground focus:shadow-lg">Saltar al contenido</a>
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 md:px-6 lg:px-8">
        <Link tabIndex={0} href="/" onClick={closeMenu} aria-label="BibLib, inicio" className="group flex shrink-0 items-center gap-2.5 rounded-xl">
          <Image src="/logo-mark.png" alt="" width={44} height={44} priority className="size-11 object-contain drop-shadow-[0_4px_8px_rgb(0_0_0/0.25)] transition-transform duration-300 motion-safe:group-hover:-rotate-6" />
          <span className="font-heading text-2xl font-bold tracking-tight text-heading">BibLib</span>
        </Link>
        <nav aria-label="Navegación principal" className="hidden items-center gap-1 lg:flex">
          {navigation.map(({ href, label }) => <Link tabIndex={0} key={href} href={href} aria-current={isActive(href) ? "page" : undefined} className={linkClass(href)}>{label}</Link>)}
        </nav>
        <div className="flex min-w-0 items-center gap-2">
          {showSearch && <QuickSearch id="header-search" className="hidden w-52 min-[1360px]:block" />}
          {showAdd && <Button asChild className="hidden xl:inline-flex"><Link href="/books/add"><Plus aria-hidden="true" />Añadir libro</Link></Button>}
          <Button variant="ghost" size="icon" onClick={toggleTheme} disabled={!mounted} aria-label={theme === "dark" ? "Activar tema claro" : "Activar tema oscuro"} className="rounded-full">
            {theme === "dark" ? <Sun aria-hidden="true" className="size-5" /> : <Moon aria-hidden="true" className="size-5" />}
          </Button>
          {loading ? <span role="status" className="hidden text-sm text-muted-foreground md:block">Cargando cuenta...</span> : user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" aria-label={`Abrir menú de cuenta de ${user.name || user.email}`} className="hidden max-w-52 gap-2 rounded-full px-1.5 md:flex 2xl:pr-3">
                  <UserAvatar user={user} decorative className="size-9 shrink-0 ring-2 ring-brass/50" />
                  <span className="hidden truncate font-semibold 2xl:inline">{user.name || user.email}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel className="truncate">{user.name || user.email}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild><Link href="/profile"><User aria-hidden="true" />Perfil</Link></DropdownMenuItem>
                <DropdownMenuItem asChild><Link href="/settings"><Settings aria-hidden="true" />Ajustes</Link></DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={signingOut} onClick={() => void handleSignOut()} variant="destructive"><LogOut aria-hidden="true" />{signingOut ? "Cerrando sesión..." : "Cerrar sesión"}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : <Button asChild className="hidden md:inline-flex"><Link href="/login">Iniciar sesión</Link></Button>}
          <Button ref={menuButton} variant="ghost" size="icon" className="rounded-full lg:hidden" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label={mobileMenuOpen ? "Cerrar menú" : "Abrir menú"} aria-expanded={mobileMenuOpen} aria-controls="mobile-navigation">
            {mobileMenuOpen ? <X aria-hidden="true" className="size-5" /> : <Menu aria-hidden="true" className="size-5" />}
          </Button>
        </div>
      </div>
      {error && <p role="alert" className="mx-auto max-w-7xl px-4 pb-3 text-sm text-destructive">{error}</p>}
      {mobileMenuOpen && (
        <nav id="mobile-navigation" aria-label="Navegación móvil" className="flex max-h-[calc(100dvh-5rem)] flex-col gap-1 overflow-y-auto border-t border-border bg-card px-4 py-4 shadow-xl lg:hidden">
          {navigation.map(({ href, label }) => <Link tabIndex={0} key={href} href={href} onClick={closeMenu} aria-current={isActive(href) ? "page" : undefined} className={mobileLinkClass(href)}>{label}</Link>)}
          {showAdd && <Link tabIndex={0} href="/books/add" onClick={closeMenu} className={mobileLinkClass("/books/add")}><Plus aria-hidden="true" className="size-4" />Añadir libro</Link>}
          {showSearch && <QuickSearch id="mobile-search" className="mt-2" />}
          <div className="mt-2 flex flex-col gap-1 border-t border-border pt-3">
            {loading ? <p role="status" className="text-sm text-muted-foreground">Cargando cuenta...</p> : user ? <>
              <Link tabIndex={0} href="/profile" onClick={closeMenu} aria-current={pathname === "/profile" ? "page" : undefined} className={mobileLinkClass("/profile")}><UserAvatar user={user} decorative className="size-8 shrink-0" />Perfil</Link>
              <Button variant="ghost" disabled={signingOut} onClick={() => void handleSignOut()} className="justify-start rounded-xl px-3 text-destructive">{signingOut ? "Cerrando sesión..." : "Cerrar sesión"}</Button>
            </> : <Link tabIndex={0} href="/login" onClick={closeMenu} className={mobileLinkClass("/login")}>Iniciar sesión</Link>}
          </div>
        </nav>
      )}
    </header>
  )
}

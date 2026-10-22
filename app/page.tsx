"use client"

import { Header } from "@/components/header"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loading-state"
import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { getLibrarySummaryAction } from "@/app/actions/library"
import { BookOpen, Library, Bookmark, TrendingUp } from "lucide-react"

export default function Dashboard() {
  const [data, setData] = useState<Awaited<ReturnType<typeof getLibrarySummaryAction>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const loadData = useCallback(() => getLibrarySummaryAction().then((loaded) => {
      setData(loaded)
      setLoadError(false)
    }).catch((error: unknown) => {
      console.error("Error loading library data:", error)
      setLoadError(true)
    }).finally(() => {
      setLoading(false)
    }), [])

  useEffect(() => { void loadData() }, [loadData])

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <LoadingState message="Preparando tu biblioteca..." />
      </div>
    )
  }

  const totalBooks = data?.totalBooks ?? 0
  const totalShelves = data?.totalShelves ?? 0
  const booksRead = data?.read ?? 0
  const booksReading = data?.reading ?? 0
  const booksToRead = data?.toRead ?? 0

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main id="main-content" tabIndex={-1} className="max-w-7xl mx-auto px-4 py-12 outline-none">
        {loadError ? (
          <div role="alert" className="mx-auto max-w-xl rounded-2xl border border-destructive/40 bg-card p-8 text-center shadow-xl">
            <h1 className="mb-2 text-2xl font-bold heading-vintage">No se pudo cargar tu biblioteca</h1>
            <p className="mb-5 text-muted-foreground">Inténtalo de nuevo para consultar tus libros y estanterías.</p>
            <Button onClick={() => void loadData()} disabled={loading}>{loading ? "Cargando…" : "Reintentar"}</Button>
          </div>
        ) : data ? <>
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold heading-vintage mb-3">Tu biblioteca</h1>
          <p className="text-base md:text-lg text-muted-foreground max-w-2xl">
            Continúa tus lecturas y encuentra tu próximo libro.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
          <div className="rounded-2xl border border-border/50 bg-card/80 backdrop-blur-xl p-6 shadow-lg hover:scale-105 transition-transform duration-200">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-vintage-red/20">
                <BookOpen className="w-6 h-6 text-vintage-red" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Libros totales</p>
                <p className="text-3xl font-bold text-vintage-red">{totalBooks}</p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-border/50 bg-card/80 backdrop-blur-xl p-6 shadow-lg hover:scale-105 transition-transform duration-200">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-vintage-olive/20">
                <Library className="w-6 h-6 text-vintage-olive" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Estanterías</p>
                <p className="text-3xl font-bold text-vintage-olive">{totalShelves}</p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-border/50 bg-card/80 backdrop-blur-xl p-6 shadow-lg hover:scale-105 transition-transform duration-200">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-vintage-purple/20">
                <Bookmark className="w-6 h-6 text-vintage-purple" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Libros leídos</p>
                <p className="text-3xl font-bold text-vintage-purple">{booksRead}</p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-border/50 bg-card/80 backdrop-blur-xl p-6 shadow-lg hover:scale-105 transition-transform duration-200">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-vintage-yellow/20">
                <TrendingUp className="w-6 h-6 text-vintage-brown" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Leyendo ahora</p>
                <p className="text-3xl font-bold text-vintage-brown">{booksReading}</p>
              </div>
            </div>
          </div>
        </div>

        {(data.currentlyReading.length > 0 || data.recent.length > 0) && (
          <div className="grid gap-6 md:grid-cols-2 mb-8">
            {([{ title: "Continuar leyendo", entries: data.currentlyReading }, { title: "Últimas incorporaciones", entries: data.recent }]).map((section) => (
              <section key={section.title} className="rounded-2xl border border-border bg-card p-6 shadow-sm">
                <h2 className="text-xl font-semibold mb-4">{section.title}</h2>
                {section.entries.length ? <ul className="space-y-3">{section.entries.map((book) => <li key={book.id}>
                  <Link href={`/book/${book.id}`} className="block rounded-lg p-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="block font-medium text-primary">{book.title}</span>
                    <span className="block text-sm text-muted-foreground">{book.authors.map((author) => author.name).join(", ") || "Autor desconocido"} · {book.shelf_name}</span>
                  </Link>
                </li>)}</ul> : <p className="text-muted-foreground">Aún no hay lecturas en curso.</p>}
              </section>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-8 flex flex-col gap-4 shadow-xl hover:shadow-2xl hover:shadow-vintage-red/20 transition-all duration-300">
            <div className="p-4 rounded-2xl bg-vintage-red/10 w-fit">
              <BookOpen className="w-8 h-8 text-vintage-red" />
            </div>
            <h2 className="text-2xl font-bold text-foreground">Agregar libro</h2>
            <p className="text-muted-foreground flex-1">Busca y agrega libros a tu biblioteca con su número ISBN</p>
            <Button asChild className="w-full bg-primary text-primary-foreground px-6 py-3 rounded-xl font-semibold hover:scale-105 active:scale-95 transition-all duration-200 shadow-lg shadow-primary/30">
              <Link href="/books/add">
                Agregar libro
              </Link>
            </Button>
          </div>

          <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-8 flex flex-col gap-4 shadow-xl hover:shadow-2xl hover:shadow-vintage-olive/20 transition-all duration-300">
            <div className="p-4 rounded-2xl bg-vintage-olive/10 w-fit">
              <Library className="w-8 h-8 text-vintage-olive" />
            </div>
            <h2 className="text-2xl font-bold text-foreground">Explorar libros</h2>
            <p className="text-muted-foreground flex-1">
              Consulta todos tus libros en tabla o explora la estantería 3D
            </p>
            <Button asChild className="w-full bg-secondary text-secondary-foreground px-6 py-3 rounded-xl font-semibold hover:scale-105 active:scale-95 transition-all duration-200 shadow-lg shadow-secondary/30">
              <Link href="/books">
                Ver biblioteca
              </Link>
            </Button>
          </div>

          <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-8 flex flex-col gap-4 shadow-xl hover:shadow-2xl hover:shadow-vintage-purple/20 transition-all duration-300">
            <div className="p-4 rounded-2xl bg-vintage-purple/10 w-fit">
              <Bookmark className="w-8 h-8 text-vintage-purple" />
            </div>
            <h2 className="text-2xl font-bold text-foreground">Gestionar estanterías</h2>
            <p className="text-muted-foreground flex-1">Crea y organiza tus libros en estanterías personalizadas</p>
            <Button asChild className="w-full bg-transparent border-2 border-border text-foreground px-6 py-3 rounded-xl font-semibold hover:bg-muted hover:scale-105 active:scale-95 transition-all duration-200">
              <Link href="/shelves">
                Gestionar estanterías
              </Link>
            </Button>
          </div>
        </div>

        {totalBooks > 0 && (
          <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-8 shadow-xl">
            <h2 className="text-2xl font-bold text-foreground mb-8">Progreso de lectura</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              <div className="text-center">
                <div className="w-20 h-20 mx-auto mb-3 rounded-full bg-vintage-yellow/20 flex items-center justify-center">
                  <p className="text-2xl font-bold text-vintage-brown">{booksToRead}</p>
                </div>
                <p className="text-sm font-medium text-muted-foreground">Por leer</p>
              </div>
              <div className="text-center">
                <div className="w-20 h-20 mx-auto mb-3 rounded-full bg-vintage-olive/20 flex items-center justify-center">
                  <p className="text-2xl font-bold text-vintage-olive">{booksReading}</p>
                </div>
                <p className="text-sm font-medium text-muted-foreground">En lectura</p>
              </div>
              <div className="text-center">
                <div className="w-20 h-20 mx-auto mb-3 rounded-full bg-vintage-purple/20 flex items-center justify-center">
                  <p className="text-2xl font-bold text-vintage-purple">{booksRead}</p>
                </div>
                <p className="text-sm font-medium text-muted-foreground">Completados</p>
              </div>
              <div className="text-center">
                <div className="w-20 h-20 mx-auto mb-3 rounded-full bg-vintage-red/20 flex items-center justify-center">
                  <p className="text-2xl font-bold text-vintage-red">
                    {data.unread}
                  </p>
                </div>
                <p className="text-sm font-medium text-muted-foreground">Sin empezar</p>
              </div>
            </div>
          </div>
        )}
        </> : null}
      </main>
    </div>
  )
}

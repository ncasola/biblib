"use client"

import { Header } from "@/components/header"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loading-state"
import Link from "next/link"
import { useEffect, useState } from "react"
import type { LibraryData } from "@/lib/types"
import { getLibraryDataAction } from "@/app/actions/library"
import { BookOpen, Library, Bookmark, TrendingUp } from "lucide-react"

export default function Dashboard() {
  const [data, setData] = useState<LibraryData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const initData = async () => {
      try {
        const loaded = await getLibraryDataAction()
        setData(loaded)
      } catch (error) {
        console.error("Error loading library data:", error)
        setData({ books: [], shelves: [] })
      } finally {
        setLoading(false)
      }
    }

    void initData()
  }, [])

  if (loading || !data) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <LoadingState message="Preparando tu biblioteca..." />
      </div>
    )
  }

  const totalBooks = data.books.length
  const totalShelves = data.shelves.length
  const booksRead = data.books.filter((b) => b.status === "read").length
  const booksReading = data.books.filter((b) => b.status === "reading").length
  const booksToRead = data.books.filter((b) => b.status === "to-read").length

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-7xl mx-auto px-4 py-12">
        <div className="mb-12 text-center">
          <h1 className="text-5xl md:text-6xl font-bold heading-vintage mb-4">Bienvenido a BibLib</h1>
          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto">
            Tu biblioteca digital con estilo vintage para organizar y disfrutar tu colección de libros
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

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-8 flex flex-col gap-4 shadow-xl hover:shadow-2xl hover:shadow-vintage-red/20 transition-all duration-300">
            <div className="p-4 rounded-2xl bg-vintage-red/10 w-fit">
              <BookOpen className="w-8 h-8 text-vintage-red" />
            </div>
            <h2 className="text-2xl font-bold text-foreground">Agregar libro</h2>
            <p className="text-muted-foreground flex-1">Busca y agrega libros a tu biblioteca con su número ISBN</p>
            <Link href="/books/add">
              <Button className="w-full bg-primary text-primary-foreground px-6 py-3 rounded-xl font-semibold hover:scale-105 active:scale-95 transition-all duration-200 shadow-lg shadow-primary/30">
                Agregar libro
              </Button>
            </Link>
          </div>

          <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-8 flex flex-col gap-4 shadow-xl hover:shadow-2xl hover:shadow-vintage-olive/20 transition-all duration-300">
            <div className="p-4 rounded-2xl bg-vintage-olive/10 w-fit">
              <Library className="w-8 h-8 text-vintage-olive" />
            </div>
            <h2 className="text-2xl font-bold text-foreground">Explorar libros</h2>
            <p className="text-muted-foreground flex-1">
              Consulta todos tus libros en tabla o explora la estantería 3D
            </p>
            <Link href="/books">
              <Button className="w-full bg-secondary text-secondary-foreground px-6 py-3 rounded-xl font-semibold hover:scale-105 active:scale-95 transition-all duration-200 shadow-lg shadow-secondary/30">
                Ver biblioteca
              </Button>
            </Link>
          </div>

          <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-8 flex flex-col gap-4 shadow-xl hover:shadow-2xl hover:shadow-vintage-purple/20 transition-all duration-300">
            <div className="p-4 rounded-2xl bg-vintage-purple/10 w-fit">
              <Bookmark className="w-8 h-8 text-vintage-purple" />
            </div>
            <h2 className="text-2xl font-bold text-foreground">Gestionar estanterías</h2>
            <p className="text-muted-foreground flex-1">Crea y organiza tus libros en estanterías personalizadas</p>
            <Link href="/shelves">
              <Button className="w-full bg-transparent border-2 border-border text-foreground px-6 py-3 rounded-xl font-semibold hover:bg-muted hover:scale-105 active:scale-95 transition-all duration-200">
                Gestionar estanterías
              </Button>
            </Link>
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
                    {data.books.filter((b) => b.status === "unread").length}
                  </p>
                </div>
                <p className="text-sm font-medium text-muted-foreground">Sin empezar</p>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

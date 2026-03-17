"use client"

import { Header } from "@/components/header"
import { Button } from "@/components/ui/button"
import { useState, useEffect } from "react"
import type { Book, LibraryData } from "@/lib/types"
import { getLibraryDataAction } from "@/app/actions/library"
import { deleteBookAction, updateBookStatusAction } from "@/app/actions/books"
import { useParams, useRouter } from "next/navigation"
import Image from "next/image"
import { ArrowLeft, Edit2, Trash2 } from "lucide-react"
import { BookStatusForm } from "@/components/book-status-form"
import { LoadingState } from "@/components/loading-state"

export default function BookDetailsPage() {
  const params = useParams()
  const router = useRouter()
  const bookId = params.id as string

  const [data, setData] = useState<LibraryData | null>(null)
  const [book, setBook] = useState<Book | null>(null)
  const [loading, setLoading] = useState(true)
  const [isEditing, setIsEditing] = useState(false)

  useEffect(() => {
    const initData = async () => {
      try {
        const libraryData = await getLibraryDataAction()
        setData(libraryData)

        const foundBook = libraryData.books.find((b) => b.id === bookId)
        setBook(foundBook || null)
      } catch (error) {
        console.error("Error loading book details:", error)
      } finally {
        setLoading(false)
      }
    }

    void initData()
  }, [bookId])

  const handleStatusChange = async (newStatus: Book["status"]) => {
    if (!book || !data) return

    await updateBookStatusAction(book.id, newStatus)
    const updatedData = await getLibraryDataAction()
    const updatedBook = updatedData.books.find((b) => b.id === book.id) ?? null

    setBook(updatedBook)
    setData(updatedData)
    setIsEditing(false)
  }

  const handleDeleteBook = async () => {
    if (!book || !data) return

    if (window.confirm(`¿Eliminar "${book.title}"?`)) {
      await deleteBookAction(book.id)
      router.push("/books")
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <LoadingState message="Cargando detalles del libro..." />
      </div>
    )
  }

  if (!book) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <main className="max-w-4xl mx-auto px-4 py-12">
          <p className="text-foreground-light">Libro no encontrado</p>
          <Button
            onClick={() => router.push("/books")}
            className="mt-4 bg-primary text-primary-foreground px-6 py-3 rounded-xl font-semibold hover:scale-105 transition-all shadow-lg shadow-primary/30"
          >
            Volver a libros
          </Button>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-4xl mx-auto px-4 py-12">
        <Button
          variant="ghost"
          onClick={() => router.push("/books")}
          className="mb-6 bg-transparent border-2 border-border text-foreground px-6 py-3 rounded-xl font-semibold hover:bg-muted transition-all"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Volver a libros
        </Button>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Book Cover */}
          <div className="relative w-full max-w-sm aspect-[2/3]">
            <Image
              src={book.cover.large || "/default-book-cover.webp"}
              alt={book.title}
              fill
              sizes="(max-width: 768px) 60vw, 320px"
              className="object-cover rounded-2xl border-4 border-border shadow-2xl"
              onError={(e) => {
                e.currentTarget.src = "/default-book-cover.webp"
              }}
              priority
            />
          </div>

          {/* Book Details */}
          <div className="md:col-span-2 space-y-6">
            <div>
              <h1 className="text-4xl font-bold heading-vintage mb-2">{book.title}</h1>
              {book.subtitle && <p className="text-lg text-muted-foreground mb-4">{book.subtitle}</p>}
            </div>

            <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-6 shadow-xl space-y-4">
              <div>
              <p className="text-sm font-semibold text-vintage-red uppercase tracking-wide mb-1">Autores</p>
                <p className="text-foreground font-medium">
                  {book.authors && book.authors.length > 0 ? book.authors.map((a) => a.name).join(", ") : "Desconocido"}
                </p>
              </div>

              {book.publishers && book.publishers.length > 0 && (
                <div>
                  <p className="text-sm font-semibold text-vintage-olive uppercase tracking-wide mb-1">Editorial</p>
                  <p className="text-foreground font-medium">{book.publishers.map((p) => p.name).join(", ")}</p>
                </div>
              )}

              {book.publish_date && (
                <div>
                  <p className="text-sm font-semibold text-vintage-purple uppercase tracking-wide mb-1">Publicado</p>
                  <p className="text-foreground font-medium">{book.publish_date}</p>
                </div>
              )}

              {book.number_of_pages > 0 && (
                <div>
                  <p className="text-sm font-semibold text-vintage-brown uppercase tracking-wide mb-1">Páginas</p>
                  <p className="text-foreground font-medium">{book.number_of_pages}</p>
                </div>
              )}

              {book.isbn && (
                <div>
                  <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">ISBN</p>
                  <p className="text-foreground font-mono text-sm">{book.isbn}</p>
                </div>
              )}
            </div>

            {/* Status Section */}
            <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-6 shadow-xl space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-2">Estado de lectura</p>
                  <p className="text-lg font-semibold text-primary">
                    {book.status === "read"
                      ? "Leído"
                      : book.status === "reading"
                        ? "Leyendo"
                        : book.status === "to-read"
                          ? "Por leer"
                          : "Sin empezar"}
                  </p>
                </div>

                <Button variant="outline" onClick={() => setIsEditing(!isEditing)} className="border-border">
                  <Edit2 className="w-4 h-4 mr-2" />
                  Cambiar
                </Button>
              </div>

              {isEditing && <BookStatusForm currentStatus={book.status} onStatusChange={handleStatusChange} />}
            </div>

            {/* Shelf Info */}
            <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-6 shadow-xl">
              <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">Estantería</p>
              <p className="text-foreground font-medium">{book.shelf_name}</p>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1 border-destructive text-destructive hover:bg-destructive/10 bg-transparent px-6 py-3 rounded-xl font-semibold"
                onClick={handleDeleteBook}
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Eliminar libro
              </Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

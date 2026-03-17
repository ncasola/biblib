"use client"

import { Button } from "@/components/ui/button"
import type { Book } from "@/lib/types"
import { useState } from "react"
import Image from "next/image"
import { BookOpen, Plus, CheckCircle } from "lucide-react"
import { addBookAction } from "@/app/actions/books"

interface BookSearchResultProps {
  book: Book
}

export function BookSearchResult({ book }: BookSearchResultProps) {
  const [isAdding, setIsAdding] = useState(false)
  const [isAdded, setIsAdded] = useState(false)

  const handleAddBook = async () => {
    setIsAdding(true)
    try {
      await addBookAction(book)

      setIsAdded(true)

      setTimeout(() => {
        setIsAdded(false)
      }, 3000)
    } catch (error) {
      alert(error instanceof Error ? error.message : "No se pudo agregar el libro")
    } finally {
      setIsAdding(false)
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-6 shadow-xl flex flex-col gap-6">
      <div className="flex gap-6">
        <div className="flex-shrink-0 relative w-32 h-48">
          <Image
            src={book.cover?.medium || "/default-book-cover.webp"}
            alt={book.title}
            fill
            sizes="128px"
            className="object-cover rounded-xl border-4 border-border shadow-lg"
            onError={(e) => {
              e.currentTarget.src = "/default-book-cover.webp"
            }}
            priority
          />
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-xl font-bold text-foreground mb-1 line-clamp-2">{book.title}</h3>
          {book.subtitle && <p className="text-sm text-muted-foreground mb-3 line-clamp-1">{book.subtitle}</p>}

          <div className="space-y-3">
            <div>
              <p className="text-xs font-semibold text-vintage-red uppercase tracking-wide mb-1">Autores</p>
              <p className="text-sm text-foreground font-medium">
                {book.authors && book.authors.length > 0 ? book.authors.map((a) => a.name).join(", ") : "Desconocido"}
              </p>
            </div>

            {book.number_of_pages > 0 && (
              <div>
                <p className="text-xs font-semibold text-vintage-olive uppercase tracking-wide mb-1">Páginas</p>
                <p className="text-sm text-foreground font-medium">{book.number_of_pages}</p>
              </div>
            )}

            {book.publish_date && (
              <div>
                <p className="text-xs font-semibold text-vintage-purple uppercase tracking-wide mb-1">Publicado</p>
                <p className="text-sm text-foreground font-medium">{book.publish_date}</p>
              </div>
            )}

            {book.publishers && book.publishers.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-vintage-brown uppercase tracking-wide mb-1">Editorial</p>
                <p className="text-sm text-foreground font-medium">{book.publishers[0]?.name || "Desconocido"}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <Button
        onClick={handleAddBook}
        disabled={isAdding || isAdded}
        className="w-full bg-primary text-primary-foreground px-6 py-6 rounded-xl font-semibold hover:scale-105 active:scale-95 transition-all duration-200 shadow-lg shadow-primary/30 text-base"
      >
        {isAdded ? (
          <>
            <CheckCircle className="w-5 h-5 mr-2" />
            Agregado a la biblioteca
          </>
        ) : isAdding ? (
          <>
            <BookOpen className="w-5 h-5 mr-2 animate-pulse" />
            Agregando a la biblioteca...
          </>
        ) : (
          <>
            <Plus className="w-5 h-5 mr-2" />
            Agregar a la biblioteca
          </>
        )}
      </Button>
    </div>
  )
}

"use client"

import Link from "next/link"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { BookForm } from "@/components/book-form"
import { BookCover } from "@/components/book-cover"
import { addBookAction } from "@/app/actions/books"
import type { Book, Shelf } from "@/lib/types"
import { CheckCircle } from "lucide-react"
import { unwrapAction } from "@/lib/action-result"

export function BookSearchResult({ book, shelves, existing = false }: { book: Book; shelves: Shelf[]; existing?: boolean }) {
  const [saved, setSaved] = useState<Book | null>(existing ? book : null)
  if (saved) return (
    <section className="rounded-2xl border border-border bg-card/80 p-6 shadow-xl space-y-4">
      <p role="status" className="flex items-center gap-2 font-semibold"><CheckCircle aria-hidden="true" className="h-5 w-5" />{existing ? "Este libro ya está en tu biblioteca" : "Libro agregado a la biblioteca"}</p>
      <BookCover cover={saved.cover} title={saved.title} className="w-28" sizes="112px" />
      <h2 className="text-xl font-bold">{saved.title}</h2>
      <p className="text-sm text-muted-foreground">Guardado en {saved.shelf_name}.</p>
      <Button asChild><Link href={`/book/${saved.id}`}>Ver libro guardado</Link></Button>
    </section>
  )
  return (
    <section className="rounded-2xl border border-border bg-card/80 backdrop-blur-md p-5 sm:p-6 shadow-xl space-y-5">
      <div><h2 className="text-2xl font-bold">Revisar libro encontrado</h2><p className="text-sm text-muted-foreground mt-2">Datos de Open Library. Comprueba que el ISBN y la edición coinciden con tu ejemplar y corrige lo necesario antes de guardar.</p></div>
      <BookForm initialBook={{ ...book, catalogue: book.catalogue ?? { source: "open-library", isbnVerified: false } }} shelves={shelves} onSubmit={async (input) => { setSaved(unwrapAction(await addBookAction(input))) }} />
    </section>
  )
}

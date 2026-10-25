"use client"

import Link from "next/link"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { BookForm } from "@/components/book-form"
import { BookCover } from "@/components/book-cover"
import { addBookAction, getBookByIsbnAction } from "@/app/actions/books"
import { ExistingEditionPanel } from "@/components/edition-copies"
import { DomainError } from "@/lib/domain-errors"
import type { Book, Shelf } from "@/lib/types"
import { CheckCircle } from "lucide-react"
import { unwrapAction } from "@/lib/action-result"
import { provenanceProviderLabel } from "@/lib/catalogue-provenance"
import type { BookEntryDefaults, SaveAndAddAnother } from "@/lib/book-entry"
import type { BookInput } from "@/lib/book-validation"

export function BookSearchResult({ book, shelves, existing = false, entryDefaults, onSavedAnother }: { book: Book; shelves: Shelf[]; existing?: boolean; entryDefaults?: BookEntryDefaults; onSavedAnother?: SaveAndAddAnother }) {
  const [saved, setSaved] = useState<Book | null>(null)
  const [found, setFound] = useState<Book | null>(existing ? book : null)
  // «Ya existe» (U-DAT-06): abrir el ejemplar guardado o añadir otro de la misma edición, a elección.
  if (found) return <ExistingEditionPanel book={found} shelves={shelves} />
  if (saved) return (
    <section className="rounded-2xl border border-border bg-card/80 p-6 shadow-xl space-y-4">
      <p role="status" className="flex items-center gap-2 font-semibold"><CheckCircle aria-hidden="true" className="h-5 w-5" />Libro agregado a la biblioteca</p>
      <BookCover cover={saved.cover} title={saved.title} className="w-28" sizes="112px" />
      <h2 className="text-xl font-bold">{saved.title}</h2>
      <p className="text-sm text-muted-foreground">Guardado en {saved.shelf_name}.</p>
      <Button asChild><Link href={`/book/${saved.id}`}>Ver libro guardado</Link></Button>
    </section>
  )
  // Sin la revisión bibliográfica solo se guarda procedencia v1: otra fuente se avisa, nunca se reclasifica en silencio.
  const legacyCatalogue = book.catalogue && book.catalogue.schemaVersion !== 2 ? book.catalogue : null
  const sourceName = book.catalogue ? provenanceProviderLabel(book.catalogue.source) : "una fuente bibliográfica"
  const save = async (input: BookInput, another = false) => {
    try {
      const result = unwrapAction(await addBookAction(input))
      if (another && onSavedAnother) onSavedAnother(result, input)
      else setSaved(result)
    } catch (caught) {
      const current = caught instanceof DomainError && caught.code === "CONFLICT" && input.isbn ? await getBookByIsbnAction(input.isbn).catch(() => null) : null
      if (!current) throw caught
      setFound(current)
    }
  }
  return (
    <section className="rounded-2xl border border-border bg-card/80 backdrop-blur-md p-5 sm:p-6 shadow-xl space-y-5">
      <div><h2 className="text-2xl font-bold">Revisar libro encontrado</h2><p className="text-sm text-muted-foreground mt-2">Datos de {sourceName}. Comprueba que el ISBN y la edición coinciden con tu ejemplar y corrige lo necesario antes de guardar.</p>
        {!legacyCatalogue && <p role="note" className="mt-2 rounded-xl border border-border bg-muted/40 p-3 text-sm">Esta fuente todavía no se puede registrar como procedencia de la ficha: se guardará como entrada manual con los datos que confirmes.</p>}</div>
      <BookForm initialBook={{ ...book, catalogue: legacyCatalogue ?? { source: "manual", isbnVerified: false } }} shelves={shelves} entryDefaults={entryDefaults} onSubmit={save} onSaveAndAddAnother={onSavedAnother ? (input) => save(input, true) : undefined} />
    </section>
  )
}

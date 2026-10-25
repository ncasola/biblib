"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { getBookByIsbnAction } from "@/app/actions/books"
import { createEditionAction } from "@/app/actions/editions"
import { BookForm } from "@/components/book-form"
import { ExistingEditionPanel } from "@/components/edition-copies"
import type { Book, Shelf } from "@/lib/types"
import { unwrapAction } from "@/lib/action-result"
import { DomainError } from "@/lib/domain-errors"
import type { BookInput } from "@/lib/book-validation"
import type { BookEntryDefaults, SaveAndAddAnother } from "@/lib/book-entry"

/** Alta manual. Si el ISBN ya está en la biblioteca, ofrece abrir su ejemplar o añadir otro (U-DAT-06). */
export function ManualBookForm({ shelves, initialIsbn = "", entryDefaults, onSavedAnother }: { shelves: Shelf[]; initialIsbn?: string; entryDefaults?: BookEntryDefaults; onSavedAnother?: SaveAndAddAnother }) {
  const router = useRouter()
  const [existing, setExisting] = useState<Book | null>(null)
  if (existing) return <ExistingEditionPanel book={existing} shelves={shelves} />
  const save = async (input: BookInput, another = false) => {
    try {
      // Alta = edición nueva (con ISBN-13 o sin él) y su primer ejemplar (U-DAT-06).
      const saved = unwrapAction(await createEditionAction({ ...input, isbn13: input.isbn ?? null, placement: { shelfId: input.shelf_id }, idempotencyKey: input.idempotencyKey }))
      if (another && onSavedAnother) onSavedAnother(saved, input)
      else router.push(`/book/${saved.id}`)
    } catch (caught) {
      const found = caught instanceof DomainError && caught.code === "CONFLICT" && input.isbn ? await getBookByIsbnAction(input.isbn).catch(() => null) : null
      if (!found) throw caught
      setExisting(found)
    }
  }
  return <BookForm shelves={shelves} initialIsbn={initialIsbn} entryDefaults={entryDefaults} onSubmit={save} onSaveAndAddAnother={onSavedAnother ? (input) => save(input, true) : undefined} />
}

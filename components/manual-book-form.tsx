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

/** Alta manual. Si el ISBN ya está en la biblioteca, ofrece abrir su ejemplar o añadir otro (U-DAT-06). */
export function ManualBookForm({ shelves, initialIsbn = "" }: { shelves: Shelf[]; initialIsbn?: string }) {
  const router = useRouter()
  const [existing, setExisting] = useState<Book | null>(null)
  if (existing) return <ExistingEditionPanel book={existing} shelves={shelves} />
  return <BookForm shelves={shelves} initialIsbn={initialIsbn} onSubmit={async (input) => {
    try {
      // Alta = edición nueva (con ISBN-13 o sin él) y su primer ejemplar (U-DAT-06).
      const saved = unwrapAction(await createEditionAction({ ...input, isbn13: input.isbn ?? null, placement: { shelfId: input.shelf_id }, idempotencyKey: input.idempotencyKey }))
      router.push(`/book/${saved.id}`)
    } catch (caught) {
      const found = caught instanceof DomainError && caught.code === "CONFLICT" && input.isbn ? await getBookByIsbnAction(input.isbn).catch(() => null) : null
      if (!found) throw caught
      setExisting(found)
    }
  }} />
}

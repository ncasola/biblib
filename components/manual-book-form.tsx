"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { addBookAction, getBookByIsbnAction } from "@/app/actions/books"
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
      const saved = unwrapAction(await addBookAction(input))
      router.push(`/book/${saved.id}`)
    } catch (caught) {
      const found = caught instanceof DomainError && caught.code === "CONFLICT" && input.isbn ? await getBookByIsbnAction(input.isbn).catch(() => null) : null
      if (!found) throw caught
      setExisting(found)
    }
  }} />
}

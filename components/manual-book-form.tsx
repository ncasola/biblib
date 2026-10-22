"use client"

import { useRouter } from "next/navigation"
import { addBookAction } from "@/app/actions/books"
import { BookForm } from "@/components/book-form"
import type { Shelf } from "@/lib/types"
import { unwrapAction } from "@/lib/action-result"

export function ManualBookForm({ shelves, initialIsbn = "" }: { shelves: Shelf[]; initialIsbn?: string }) {
  const router = useRouter()
  return <BookForm shelves={shelves} initialIsbn={initialIsbn} onSubmit={async (input) => {
    const saved = unwrapAction(await addBookAction(input))
    router.push(`/book/${saved.id}`)
  }} />
}

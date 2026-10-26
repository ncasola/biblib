import type { Metadata } from "next"
import { cache } from "react"
import { notFound } from "next/navigation"
import { getBookDetailAction } from "@/app/actions/books"
import { BookDetailsScreen } from "@/components/book-details-screen"
import { BOOK_RETURN_PARAM, resolveBookReturnPath } from "@/lib/book-search"
import { bookMetadata, classifyBookTitleError, type BookTitleLookup } from "@/lib/route-metadata"
import { uuidSchema } from "@/lib/book-validation"

interface BookPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

// `cache` de React solo deduplica dentro de una misma petición: el título de un libro privado
// nunca se comparte entre peticiones ni entre cuentas.
const readBookTitle = cache(async (bookId: string): Promise<BookTitleLookup> => {
  if (!uuidSchema.safeParse(bookId).success) return { status: "not-found" }
  try {
    const book = await getBookDetailAction(bookId)
    return book ? { status: "found", title: book.title } : { status: "not-found" }
  } catch (error) {
    return classifyBookTitleError(error)
  }
})

export async function generateMetadata({ params }: Pick<BookPageProps, "params">): Promise<Metadata> {
  const { id } = await params
  return bookMetadata(await readBookTitle(id))
}

export default async function BookDetailsPage({ params, searchParams }: BookPageProps) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  if ((await readBookTitle(id)).status === "not-found") notFound()
  return <BookDetailsScreen bookId={id} returnPath={resolveBookReturnPath(query[BOOK_RETURN_PARAM])} />
}

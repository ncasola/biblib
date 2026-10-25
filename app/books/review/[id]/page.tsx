import { notFound } from "next/navigation"
import { ReviewComparisonScreen } from "@/components/review-comparison"
import { BOOK_RETURN_FALLBACK, BOOK_RETURN_PARAM, resolveBookReturnPath } from "@/lib/book-search"
import { uuidSchema } from "@/lib/book-validation"

interface ReviewIssuePageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

// U-DAT-07: comparación de una incidencia. La vuelta conserva los filtros y la página de la bandeja de origen.
export default async function ReviewIssuePage({ params, searchParams }: ReviewIssuePageProps) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  if (!uuidSchema.safeParse(id).success) notFound()
  const resolved = resolveBookReturnPath(query[BOOK_RETURN_PARAM])
  const returnPath = resolved !== BOOK_RETURN_FALLBACK && resolved.startsWith("/books/review") ? resolved : "/books/review"
  return <ReviewComparisonScreen issueId={id} returnPath={returnPath} />
}

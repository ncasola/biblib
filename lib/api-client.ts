import "server-only"
import { bibliographicCatalog } from "./bibliographic-catalog/server"
import { catalogResultError } from "./bibliographic-catalog/action-result"
import { candidateToLegacyBook } from "./bibliographic-catalog/normalize"
import { retainableCandidates, retainableCovers } from "./bibliographic-catalog/retention"
import { normalizeIsbn } from "./isbn"
import { withActionCorrelation } from "./observability/server"

export async function searchBookByISBN(isbn: string) {
  return withActionCorrelation(async () => {
    const normalized = normalizeIsbn(isbn)
    if (!normalized) return null
    const result = await bibliographicCatalog.lookupISBN(normalized)
    if (result.status === "notFound") return null
    const failure = catalogResultError(result)
    if (failure) throw failure
    // La fachada legacy entrega una ficha guardable; Google solo admite preview temporal.
    const candidate = retainableCandidates(result.candidates)[0]
    if (!candidate) return null
    const covers = candidate.coverUrl ? await bibliographicCatalog.getCover(normalized) : undefined
    const cover = covers && retainableCovers(covers.candidates).find((entry) => entry.imageUrl)
    return candidateToLegacyBook(candidate, normalized, cover?.imageUrl)
  })
}

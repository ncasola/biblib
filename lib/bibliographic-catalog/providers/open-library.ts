import { DomainError } from "../../domain-errors"
import { createOpenLibraryClient } from "../../open-library"
import { fromOpenLibrary } from "../normalize"
import { hasProviderRight, providerRightsPolicy } from "../rights"
import type { BibliographicCandidate, CatalogProvider, CoverCandidate, ProviderContext, ProviderResult } from "../types"

export function createOpenLibraryProvider(options: Parameters<typeof createOpenLibraryClient>[0] = {}): CatalogProvider {
  const policy = providerRightsPolicy("open-library")
  const client = createOpenLibraryClient({ ...options, cacheMetadata: hasProviderRight(policy, "cacheMetadata") })
  async function lookupISBN(isbn: string, context: ProviderContext): Promise<ProviderResult<BibliographicCandidate[]>> {
    const base = { provider: "open-library", requestId: context.requestId }
    try {
      const result = await client.searchRecordByISBN(isbn, context.signal)
      if (!result) return { ...base, status: "notFound" }
      const candidate = fromOpenLibrary(result.record, isbn, result.retrievedAt)
      return candidate.evidence.isbnExact ? { ...base, status: "found", value: [candidate] } : { ...base, status: "notFound" }
    } catch (error) {
      return { ...base, status: error instanceof DomainError && error.code === "RATE_LIMITED" ? "rateLimited" : "unavailable" }
    }
  }
  return {
    id: "open-library", capabilities: { lookupISBN: true, searchTitleAuthor: false, resolveEditions: false, getCover: true }, lookupISBN,
    async getCover(isbn, context): Promise<ProviderResult<CoverCandidate[]>> {
      const result = await lookupISBN(isbn, context)
      if (result.status !== "found") return result
      const covers = hasProviderRight(policy, "previewCover") ? result.value.flatMap((candidate) => candidate.coverUrl ? [{ provider: candidate.provider, coverKey: candidate.recordId ?? isbn, sourceUrl: candidate.sourceUrl, imageUrl: candidate.coverUrl, rightsPolicyVersion: policy.version, attribution: policy.attribution }] : []) : []
      return covers.length ? { ...result, value: covers } : { provider: "open-library", requestId: context.requestId, status: "notFound" }
    },
  }
}

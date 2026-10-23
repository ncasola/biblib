"use server"

import { mutationResult } from "@/lib/action-result"
import { toBibliographyActionResult, type BibliographyActionResult } from "@/lib/bibliographic-catalog/action-result"
import { bibliographicCatalog } from "@/lib/bibliographic-catalog/server"
import type { BibliographicCandidate, CoverCandidate } from "@/lib/bibliographic-catalog/types"
import { getRequiredUserId } from "@/lib/server-user"
import { withActionCorrelation } from "@/lib/observability/server"

export async function lookupIsbnAction(isbn: string): Promise<BibliographyActionResult<BibliographicCandidate>> {
  return withActionCorrelation(async () => {
    const result = await mutationResult(async () => {
      const userId = await getRequiredUserId()
      return bibliographicCatalog.lookupISBN(isbn, { userId })
    })
    return result.ok ? toBibliographyActionResult(result.value) : result
  })
}

export async function getCoverAction(isbn: string): Promise<BibliographyActionResult<CoverCandidate>> {
  return withActionCorrelation(async () => {
    const result = await mutationResult(async () => {
      const userId = await getRequiredUserId()
      return bibliographicCatalog.getCover(isbn, { userId })
    })
    return result.ok ? toBibliographyActionResult(result.value) : result
  })
}

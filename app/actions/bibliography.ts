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

// U-DAT-08: acciones añadidas sin cambiar los contratos ISBN existentes.
import { createTitleAuthorActions } from "@/lib/title-author-search"
import { readCatalogConfig } from "@/lib/bibliographic-catalog/config"
import { getBookDetailAction } from "@/app/actions/books"

function titleAuthorActions() {
  return createTitleAuthorActions({
    catalog: bibliographicCatalog,
    authenticate: getRequiredUserId,
    enabled: () => readCatalogConfig().reviewEnabled,
    secret: () => {
      const secret = process.env.BIBLIB_CATALOGUE_CACHE_SECRET
      // Misma clave servidor que la caché privada; no hay fallback público en live.
      if (secret && secret.length >= 32) return secret
      if (readCatalogConfig().mode === "fixture") return "biblib-fixture-title-author-token-2026-10"
      return undefined
    },
    maxPage: Number(process.env.BIBLIB_BIBLIOGRAPHY_MAX_PAGE ?? 20),
    getTarget: getBookDetailAction,
  })
}

export async function searchBibliographyAction(input: { title?: string; author?: string; page: number; limit: 10 | 20; language?: string }) {
  return withActionCorrelation(() => titleAuthorActions().search(input))
}

export async function loadEditionCandidatesAction(input: { queryToken: string; workKey: string; page: number }) {
  return withActionCorrelation(() => titleAuthorActions().editions(input))
}

export async function prepareCandidateLinkAction(input: { candidateKey: string; targetCopyId?: string; expectedVersion?: string }) {
  return withActionCorrelation(() => titleAuthorActions().prepare(input))
}

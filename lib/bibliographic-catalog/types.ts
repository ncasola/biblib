export type ProviderId = "open-library" | "bne" | "google-books"
export type ProviderStatus = "found" | "notFound" | "unavailable" | "rateLimited" | "disabled" | "misconfigured"

export interface ProviderCapability {
  lookupISBN: boolean
  searchTitleAuthor: boolean
  resolveEditions: boolean
  getCover: boolean
}

export interface ProviderRecordRef {
  provider: ProviderId
  recordKind: "work" | "edition"
  recordId: string
}

export interface BibliographicCandidate {
  provider: ProviderId
  level: "work" | "edition"
  recordId?: string
  sourceUrl?: string
  isbns: string[]
  title?: string
  subtitle?: string
  authors: { name: string; sourceUrl?: string }[]
  publishers: { name: string }[]
  language?: string
  format?: string
  publishDate?: string
  numberOfPages?: number
  coverUrl?: string
  evidence: { isbnExact: boolean; languageCompatible?: boolean; formatCompatible?: boolean }
  retrievedAt: string
}

export interface CoverCandidate {
  provider: ProviderId
  coverKey: string
  sourceUrl?: string
  imageUrl?: string
  width?: number
  height?: number
  rightsPolicyVersion: string
  attribution?: string
}

export type ProviderResult<T> =
  | { status: "found"; provider: string; value: T; requestId: string }
  | { status: Exclude<ProviderStatus, "found">; provider: string; retryAfterSeconds?: number; requestId: string }

export interface ProviderOutcome {
  provider: string
  status: ProviderStatus | "notAttempted"
  reason?: "deadline" | "unsupported" | "policy"
  requestId: string
  retryAfterSeconds?: number
}

export interface CatalogLookupResult<T> {
  status: "found" | "notFound" | "incomplete"
  candidates: T[]
  providers: ProviderOutcome[]
  complete: boolean
  deadlineExceeded: boolean
}

export interface LookupOptions {
  signal?: AbortSignal
  /** Permite reducir, nunca ampliar, los límites del servicio. */
  timeoutMs?: number
  providerTimeoutMs?: number
  userId?: string
}

export interface TitleAuthorQuery { title?: string; author?: string }

export interface BibliographicCatalogService {
  capabilities(): Record<string, ProviderCapability>
  lookupISBN(isbn: string, options?: LookupOptions): Promise<CatalogLookupResult<BibliographicCandidate>>
  searchTitleAuthor(query: TitleAuthorQuery, options?: LookupOptions): Promise<CatalogLookupResult<BibliographicCandidate>>
  resolveEditions(work: ProviderRecordRef, options?: LookupOptions): Promise<CatalogLookupResult<BibliographicCandidate>>
  getCover(isbn: string, options?: LookupOptions): Promise<CatalogLookupResult<CoverCandidate>>
}

export interface ProviderContext { signal: AbortSignal; requestId: string }
export interface CatalogProvider {
  id: ProviderId
  capabilities: ProviderCapability
  lookupISBN?(isbn: string, context: ProviderContext): Promise<ProviderResult<BibliographicCandidate[]>>
  searchTitleAuthor?(query: TitleAuthorQuery, context: ProviderContext): Promise<ProviderResult<BibliographicCandidate[]>>
  resolveEditions?(work: ProviderRecordRef, context: ProviderContext): Promise<ProviderResult<BibliographicCandidate[]>>
  getCover?(isbn: string, context: ProviderContext): Promise<ProviderResult<CoverCandidate[]>>
}

export interface ProviderRegistration {
  id: ProviderId
  enabled: boolean
  configured?: boolean
  adapter?: CatalogProvider
}

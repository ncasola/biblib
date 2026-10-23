import { randomUUID } from "node:crypto"
import { DomainError } from "../domain-errors"
import { normalizeIsbn } from "../isbn"
import { emitSafely, noopTelemetry, type TelemetryEmitter } from "../observability/emitter"
import { httpsUrl, normalizeCandidate } from "./normalize"
import { hasProviderRight, providerRightsPolicy } from "./rights"
import type { BibliographicCandidate, BibliographicCatalogService, CatalogLookupResult, CatalogProvider, CoverCandidate, LookupOptions, ProviderCapability, ProviderContext, ProviderId, ProviderOutcome, ProviderRecordRef, ProviderRegistration, ProviderResult, TitleAuthorQuery } from "./types"

export const CATALOG_DEADLINE_MS = 8000
export const PROVIDER_DEADLINE_MS = 3500
export const COVER_DEADLINE_MS = 4000
const noCapabilities: ProviderCapability = { lookupISBN: false, searchTitleAuthor: false, resolveEditions: false, getCover: false }
export const DEFAULT_PROVIDER_ORDER: readonly ProviderId[] = ["open-library", "bne", "google-books"]

interface ServiceOptions {
  providers: ProviderRegistration[]
  order?: readonly ProviderId[]
  telemetry?: TelemetryEmitter
}

function canonicalIsbn(value: string): string {
  const isbn = typeof value === "string" && value.length <= 100 ? normalizeIsbn(value) : null
  if (!isbn) throw new DomainError("INVALID_INPUT", "El ISBN no es válido. Revisa su dígito de control.")
  return isbn
}

function budget(value: number | undefined, maximum: number): number {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new DomainError("INVALID_INPUT", "El plazo de consulta no es válido.")
  return Math.min(value ?? maximum, maximum)
}

export function createBibliographicCatalogService(settings: ServiceOptions): BibliographicCatalogService {
  const registrations = new Map(settings.providers.map((registration) => [registration.id, registration]))
  const order = [...new Set([...(settings.order ?? DEFAULT_PROVIDER_ORDER), ...DEFAULT_PROVIDER_ORDER])].slice(0, 3)
  const telemetry = settings.telemetry ?? noopTelemetry

  async function run<T>(operation: keyof ProviderCapability, options: LookupOptions, call: (adapter: CatalogProvider, context: ProviderContext) => Promise<ProviderResult<T[]>>, onlyProvider?: ProviderId): Promise<CatalogLookupResult<T>> {
    const deadline = performance.now() + budget(options.timeoutMs, operation === "getCover" ? COVER_DEADLINE_MS : CATALOG_DEADLINE_MS)
    const providerBudget = budget(options.providerTimeoutMs, PROVIDER_DEADLINE_MS)
    const candidates: T[] = []
    const providers: ProviderOutcome[] = []
    let deadlineExceeded = false
    let commonDeadlineExceeded = false
    let eligible = 0
    let healthy = 0
    let failed = false
    for (const id of order) {
      const registration = registrations.get(id)
      const requestId = randomUUID()
      const base = { provider: id, requestId }
      let outcome: ProviderOutcome
      const remaining = deadline - performance.now()
      if (!registration?.enabled) outcome = { ...base, status: "disabled", reason: "policy" }
      else if (onlyProvider && onlyProvider !== id) outcome = { ...base, status: "notAttempted", reason: "unsupported" }
      else if (registration.configured === false) { failed = true; outcome = { ...base, status: "misconfigured" } }
      else if (!registration.adapter?.capabilities[operation] || !registration.adapter[operation]) {
        outcome = { ...base, status: "notAttempted", reason: "unsupported" }
        // Una fuente habilitada sin adaptador no puede certificar ausencia.
        if (!registration.adapter) failed = true
      } else if (options.signal?.aborted || remaining <= 0 || commonDeadlineExceeded) {
        failed = true
        deadlineExceeded ||= remaining <= 0
        outcome = { ...base, status: "notAttempted", reason: remaining <= 0 || commonDeadlineExceeded ? "deadline" : "policy" }
      } else {
        eligible++
        const started = performance.now()
        const controller = new AbortController()
        let timedOut = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const onAbort = () => controller.abort()
        options.signal?.addEventListener("abort", onAbort, { once: true })
        try {
          const aborted = new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => reject(new DOMException("Consulta cancelada", "AbortError")), { once: true })
            timer = setTimeout(() => { timedOut = true; controller.abort() }, Math.min(remaining, providerBudget))
          })
          const result = await Promise.race([call(registration.adapter, { signal: controller.signal, requestId }), aborted])
          if (performance.now() >= deadline || performance.now() - started >= providerBudget) {
            timedOut = true
            controller.abort()
          }
          if (controller.signal.aborted) throw new DOMException("Consulta cancelada", "AbortError")
          const status = result.status === "found" && result.value.length === 0 ? "notFound" : result.status
          if (status === "found" || status === "notFound") healthy++
          else failed = true
          if (result.status === "found") candidates.push(...result.value)
          outcome = { ...base, status, ...(result.status !== "found" && result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}) }
        } catch {
          failed = true
          deadlineExceeded ||= timedOut
          commonDeadlineExceeded ||= timedOut && remaining <= providerBudget
          outcome = { ...base, status: "unavailable", ...(timedOut ? { reason: "deadline" as const } : {}) }
        } finally {
          clearTimeout(timer)
          options.signal?.removeEventListener("abort", onAbort)
        }
        emitSafely(telemetry, "provider.request", { operation: `catalog.${operation}`, provider: id, requestId, result: outcome.status, durationMs: Math.max(0, performance.now() - started) })
      }
      providers.push(outcome)
    }
    const complete = eligible > 0 && healthy === eligible && !failed && !options.signal?.aborted
    return { status: candidates.length ? "found" : complete ? "notFound" : "incomplete", candidates, providers, complete, deadlineExceeded }
  }

  function metadataCall(operation: "lookupISBN" | "searchTitleAuthor" | "resolveEditions", input: string | TitleAuthorQuery | ProviderRecordRef, isbn?: string) {
    return async (adapter: CatalogProvider, context: ProviderContext): Promise<ProviderResult<BibliographicCandidate[]>> => {
      const result = operation === "lookupISBN" ? await adapter.lookupISBN!(input as string, context)
        : operation === "searchTitleAuthor" ? await adapter.searchTitleAuthor!(input as TitleAuthorQuery, context)
          : await adapter.resolveEditions!(input as ProviderRecordRef, context)
      if (result.status !== "found") return result
      const candidates = result.value.map((value) => normalizeCandidate(value, isbn))
      if (candidates.some((candidate) => candidate.provider !== adapter.id)) throw new Error("Proveedor incoherente")
      return { ...result, value: isbn ? candidates.filter((candidate) => candidate.evidence.isbnExact) : candidates }
    }
  }

  return {
    capabilities: () => Object.fromEntries(order.map((id) => [id, { ...(registrations.get(id)?.enabled ? registrations.get(id)?.adapter?.capabilities ?? noCapabilities : noCapabilities) }])),
    async lookupISBN(value, options = {}) {
      const isbn = canonicalIsbn(value)
      return run("lookupISBN", options, metadataCall("lookupISBN", isbn, isbn))
    },
    async searchTitleAuthor(query, options = {}) {
      if (!query || [query.title, query.author].some((value) => value !== undefined && (typeof value !== "string" || value.length > 500)) || (!query.title?.trim() && !query.author?.trim())) throw new DomainError("INVALID_INPUT", "Introduce un título o autor para buscar.")
      return run("searchTitleAuthor", options, metadataCall("searchTitleAuthor", { title: query.title?.trim(), author: query.author?.trim() }))
    },
    async resolveEditions(work, options = {}) {
      if (!work || !DEFAULT_PROVIDER_ORDER.includes(work.provider) || !["work", "edition"].includes(work.recordKind) || typeof work.recordId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(work.recordId)) throw new DomainError("INVALID_INPUT", "La referencia bibliográfica no es válida.")
      return run("resolveEditions", options, metadataCall("resolveEditions", work), work.provider)
    },
    async getCover(value, options = {}) {
      const isbn = canonicalIsbn(value)
      return run<CoverCandidate>("getCover", options, async (adapter, context) => {
        const policy = providerRightsPolicy(adapter.id)
        if (!hasProviderRight(policy, "previewCover")) return { provider: adapter.id, requestId: context.requestId, status: "disabled" }
        const result = await adapter.getCover!(isbn, context)
        if (result.status !== "found") return result
        const value = result.value.map((cover) => {
          if (cover.provider !== adapter.id || typeof cover.coverKey !== "string" || !cover.coverKey || cover.rightsPolicyVersion !== policy.version) throw new Error("Portada no válida")
          return { ...cover, sourceUrl: httpsUrl(cover.sourceUrl), imageUrl: httpsUrl(cover.imageUrl) }
        }).filter((cover) => cover.imageUrl)
        return { ...result, value }
      })
    },
  }
}

import { z } from "zod"
import { DomainError } from "../../domain-errors"
import { normalizeIsbn } from "../../isbn"
import { emitSafely, noopTelemetry, type TelemetryEmitter } from "../../observability/emitter"
import { classifyProviderFailure } from "../../observability/events"
import { fromOpenLibrary, normalizeCandidate } from "../normalize"
import { hasProviderRight, providerRightsPolicy } from "../rights"
import type { BibliographicCandidate, CatalogProvider, CoverCandidate, ProviderContext, ProviderResult } from "../types"

const httpUrl = z.url().refine((value) => ["https:", "http:"].includes(new URL(value).protocol))
export const openLibraryRecordSchema = z.object({
  url: httpUrl.optional(), title: z.string().trim().min(1).max(500), subtitle: z.string().max(1000).optional(),
  authors: z.array(z.object({ name: z.string().trim().min(1).max(200), url: httpUrl.optional() })).max(30).optional(),
  number_of_pages: z.number().int().min(0).max(100000).optional(), publish_date: z.string().max(100).optional(),
  publishers: z.array(z.object({ name: z.string().trim().min(1).max(200) })).max(20).optional(),
  cover: z.object({ small: httpUrl.optional(), medium: httpUrl.optional(), large: httpUrl.optional() }).optional(),
  identifiers: z.object({ isbn_10: z.array(z.string()).max(100).optional(), isbn_13: z.array(z.string()).max(100).optional(), openlibrary: z.array(z.string()).optional() }).optional(),
  languages: z.array(z.object({ key: z.string() })).optional(), physical_format: z.string().max(100).optional(),
})
export type OpenLibraryRecord = z.infer<typeof openLibraryRecordSchema>
export interface OpenLibraryOptions {
  fetch?: typeof fetch
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
  contact?: string
  telemetry?: TelemetryEmitter
  cacheMetadata?: boolean
  timeoutMs?: number
}

export function openLibraryHeaders(contact = process.env.OPEN_LIBRARY_CONTACT): HeadersInit {
  const safeContact = contact?.replace(/[\r\n]/g, " ").trim()
  return { "User-Agent": safeContact ? `BibLib (${safeContact})` : "BibLib/1.0", Accept: "application/json" }
}

class ProviderFailure extends DomainError {
  constructor(code: "PROVIDER_UNAVAILABLE" | "RATE_LIMITED", public readonly retryAfterSeconds?: number) {
    super(code, code === "RATE_LIMITED" ? "Open Library ha limitado las consultas. Espera y vuelve a intentarlo." : "Open Library no está disponible ahora. Puedes añadir el libro manualmente.")
  }
}

const searchDocSchema = z.object({
  key: z.string().regex(/^(?:\/works\/)?OL\d+W$/), title: z.string().min(1).max(500).optional(),
  author_name: z.array(z.string().min(1).max(200)).max(30).optional(),
  language: z.array(z.string().max(100)).optional(), first_publish_year: z.number().int().min(0).max(3000).optional(),
})
const editionSchema = z.object({
  key: z.string().regex(/^\/books\/OL\d+M$/), title: z.string().min(1).max(500).optional(), subtitle: z.string().max(1000).optional(),
  isbn_10: z.array(z.string()).max(100).optional(), isbn_13: z.array(z.string()).max(100).optional(),
  publishers: z.array(z.string().min(1).max(200)).max(20).optional(), publish_date: z.string().max(100).optional(),
  number_of_pages: z.number().int().min(0).max(100000).optional(), physical_format: z.string().max(100).optional(),
  languages: z.array(z.object({ key: z.string() })).optional(), covers: z.array(z.number().int()).optional(),
})

/** API JSON documentada, una cola y caché acotadas por instancia hasta U-DAT-05. */
export function createOpenLibraryProvider(options: OpenLibraryOptions = {}) {
  const policy = providerRightsPolicy("open-library")
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const now = options.now ?? Date.now
  const cache = new Map<string, { payload: unknown; retrievedAt: string; expires: number }>()
  const inFlight = new Map<string, Promise<{ payload: unknown; retrievedAt: string }>>()
  let nextRequestAt = 0
  let cooldownUntil = 0

  async function load(url: URL, signal?: AbortSignal, useCache = true): Promise<{ payload: unknown; retrievedAt: string }> {
    signal?.throwIfAborted()
    const cached = useCache ? cache.get(url.href) : undefined
    if (cached && cached.expires > now()) return structuredClone(cached)
    cache.delete(url.href)
    const start = Math.max(now(), nextRequestAt, cooldownUntil)
    if (start - now() > 1000) throw new ProviderFailure("RATE_LIMITED", Math.ceil((start - now()) / 1000))
    nextRequestAt = start + 1000
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => controller.abort(), Math.min(8000, Math.max(1, options.timeoutMs ?? 8000)))
    const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new DOMException("La consulta ha caducado.", "TimeoutError")), { once: true }))
    let httpStatus: number | undefined
    const startedAt = now()
    try {
      const remaining = start - now()
      if (remaining > 0) await Promise.race([options.wait ? options.wait(remaining) : new Promise<void>((resolve) => {
        const waiting = setTimeout(resolve, remaining)
        controller.signal.addEventListener("abort", () => clearTimeout(waiting), { once: true })
      }), aborted])
      controller.signal.throwIfAborted()
      const response = await Promise.race([request(url, { headers: openLibraryHeaders(options.contact), signal: controller.signal, cache: "no-store", redirect: "error" }), aborted])
      httpStatus = response.status
      if (response.status === 429) {
        void response.body?.cancel().catch(() => {})
        const header = response.headers.get("retry-after")
        const seconds = header && /^\d+$/.test(header) ? Number(header) : header ? Math.ceil((Date.parse(header) - now()) / 1000) : 1
        const retry = Number.isFinite(seconds) ? Math.max(1, seconds) : 1
        cooldownUntil = Math.max(cooldownUntil, now() + retry * 1000)
        throw new ProviderFailure("RATE_LIMITED", retry)
      }
      if (!response.ok || Number(response.headers.get("content-length")) > 1048576) { void response.body?.cancel().catch(() => {}); throw new ProviderFailure("PROVIDER_UNAVAILABLE") }
      // Conservar Response.json permite que el cliente legacy y el adaptador
      // compartan el mismo contrato de fetch; el deadline cubre también el cuerpo.
      const payload: unknown = await Promise.race([response.json(), aborted])
      const value = { payload, retrievedAt: new Date(now()).toISOString() }
      emitSafely(options.telemetry ?? noopTelemetry, "provider.request", { operation: "open-library.lookup", provider: "open-library", result: "ok", durationMs: Math.max(0, now() - startedAt), httpStatus })
      return value
    } catch (error) {
      emitSafely(options.telemetry ?? noopTelemetry, "provider.request", { operation: "open-library.lookup", provider: "open-library", result: "error", durationMs: Math.max(0, now() - startedAt), httpStatus, errorCode: classifyProviderFailure(httpStatus && httpStatus >= 400 ? httpStatus : error) })
      if (error instanceof DomainError) throw error
      throw new ProviderFailure("PROVIDER_UNAVAILABLE")
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort) }
  }

  function remember(url: URL, value: { payload: unknown; retrievedAt: string }, empty: boolean) {
    if (options.cacheMetadata === false || !hasProviderRight(policy, "cacheMetadata")) return
    const existing = cache.get(url.href)
    if (existing && existing.expires > now()) return
    if (cache.size >= 500) cache.delete(cache.keys().next().value!)
    cache.set(url.href, { ...structuredClone(value), expires: now() + (empty ? 300000 : policy.metadataTtlSeconds * 1000) })
  }

  async function readIsbnRecord(value: string, signal?: AbortSignal): Promise<{ record: OpenLibraryRecord; retrievedAt: string } | null> {
    signal?.throwIfAborted()
    const isbn = typeof value === "string" && value.length <= 100 ? normalizeIsbn(value) : null
    if (!isbn) throw new DomainError("INVALID_INPUT", "El ISBN no es válido. Introduce un ISBN de 10 o 13 dígitos con su dígito de control correcto.")
    const url = new URL("https://openlibrary.org/api/books")
    url.search = new URLSearchParams({ bibkeys: `ISBN:${isbn}`, format: "json", jscmd: "data" }).toString()
    let pending = !signal ? inFlight.get(url.href) : undefined
    if (!pending) {
      pending = load(url, signal)
      if (!signal) inFlight.set(url.href, pending)
    }
    try {
      const result = await pending
      const parsed = z.record(z.string(), openLibraryRecordSchema).parse(result.payload)
      if (Object.keys(parsed).some((key) => key !== `ISBN:${isbn}`)) throw new ProviderFailure("PROVIDER_UNAVAILABLE")
      const record = parsed[`ISBN:${isbn}`]
      // Si Books API omite el enlace HTML, el endpoint JSON consultado sigue siendo
      // una fuente atribuible; no se fabrica un identificador de edición.
      if (record && !record.url) record.url = url.href
      const exact = record && fromOpenLibrary(record, isbn, result.retrievedAt).evidence.isbnExact
      remember(url, { ...result, payload: exact ? parsed : {} }, !exact)
      return exact ? { record: structuredClone(record), retrievedAt: result.retrievedAt } : null
    } catch (error) {
      if (error instanceof DomainError) throw error
      throw new ProviderFailure("PROVIDER_UNAVAILABLE")
    } finally { if (inFlight.get(url.href) === pending) inFlight.delete(url.href) }
  }

  async function run(context: ProviderContext, call: () => Promise<BibliographicCandidate[]>): Promise<ProviderResult<BibliographicCandidate[]>> {
    const base = { provider: "open-library", requestId: context.requestId }
    try {
      const value = await call()
      return value.length ? { ...base, status: "found", value } : { ...base, status: "notFound" }
    } catch (error) {
      return { ...base, status: error instanceof DomainError && error.code === "RATE_LIMITED" ? "rateLimited" : "unavailable", ...(error instanceof ProviderFailure && error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}) }
    }
  }
  const lookupISBN: NonNullable<CatalogProvider["lookupISBN"]> = (isbn, context) => run(context, async () => {
    const result = await readIsbnRecord(isbn, context.signal)
    return result ? [fromOpenLibrary(result.record, normalizeIsbn(isbn)!, result.retrievedAt)] : []
  })
  const provider: CatalogProvider = {
    id: "open-library", capabilities: { lookupISBN: true, searchTitleAuthor: true, resolveEditions: true, getCover: true }, lookupISBN,
    searchTitleAuthor(query, context) {
      return run(context, async () => {
        if ((!query.title?.trim() && !query.author?.trim()) || (query.title?.length ?? 0) > 500 || (query.author?.length ?? 0) > 500) throw new DomainError("INVALID_INPUT", "Introduce un título o autor válido.")
        const url = new URL("https://openlibrary.org/search.json")
        const limit = query.limit ?? 10
        url.search = new URLSearchParams({ fields: query.page === undefined ? "key,title,author_name" : "key,title,author_name,language,first_publish_year", limit: String(limit), page: String(query.page ?? 1), ...(query.language ? query.language.length === 2 ? { lang: query.language } : { q: `language:${query.language}` } : {}), ...(query.title?.trim() ? { title: query.title.trim() } : {}), ...(query.author?.trim() ? { author: query.author.trim() } : {}) }).toString()
        const result = await load(url, context.signal, query.page === undefined)
        const payload = z.object({ docs: z.array(searchDocSchema).max(limit) }).parse(result.payload)
        const candidates = payload.docs.map((doc) => normalizeCandidate({ provider: "open-library", level: "work", recordId: doc.key.split("/").at(-1), sourceUrl: `https://openlibrary.org/works/${doc.key.split("/").at(-1)}`, title: doc.title, isbns: [], authors: (doc.author_name ?? []).map((name) => ({ name })), publishers: [], language: doc.language?.length === 1 ? doc.language[0] : undefined, publishDate: doc.first_publish_year === undefined ? undefined : String(doc.first_publish_year), evidence: { isbnExact: false }, retrievedAt: result.retrievedAt }))
        // El texto privado solo se cachea por dueño/HMAC en el gateway, nunca por URL en el adaptador.
        if (query.page === undefined) remember(url, { ...result, payload }, !candidates.length)
        return candidates
      })
    },
    resolveEditions(work, context) {
      return run(context, async () => {
        const isWork = work.recordKind === "work"
        if (work.provider !== "open-library" || !new RegExp(isWork ? "^OL[0-9]+W$" : "^OL[0-9]+M$").test(work.recordId)) throw new DomainError("INVALID_INPUT", "La referencia bibliográfica no es válida.")
        const limit = work.limit ?? 10
        const url = new URL(isWork ? `https://openlibrary.org/works/${work.recordId}/editions.json?limit=${limit}${work.page === undefined ? "" : `&offset=${(work.page - 1) * limit}`}` : `https://openlibrary.org/books/${work.recordId}.json`)
        const result = await load(url, context.signal)
        const records = isWork ? z.object({ entries: z.array(editionSchema).max(limit) }).parse(result.payload).entries : [editionSchema.parse(result.payload)]
        if (!isWork && records[0].key !== `/books/${work.recordId}`) throw new ProviderFailure("PROVIDER_UNAVAILABLE")
        const candidates = records.map((record) => normalizeCandidate({
          provider: "open-library", level: "edition", recordId: record.key.split("/").at(-1), sourceUrl: `https://openlibrary.org${record.key}`,
          title: record.title, subtitle: record.subtitle, isbns: [...(record.isbn_10 ?? []), ...(record.isbn_13 ?? [])], authors: [], publishers: (record.publishers ?? []).map((name) => ({ name })),
          language: record.languages?.[0]?.key.split("/").at(-1), format: record.physical_format, publishDate: record.publish_date, numberOfPages: record.number_of_pages,
          coverUrl: record.covers?.find((cover) => cover > 0) ? `https://covers.openlibrary.org/b/id/${record.covers.find((cover) => cover > 0)}-L.jpg` : undefined,
          evidence: { isbnExact: false }, retrievedAt: result.retrievedAt,
        }))
        remember(url, { ...result, payload: isWork ? { entries: records } : records[0] }, !candidates.length)
        return candidates
      })
    },
    async getCover(isbn, context): Promise<ProviderResult<CoverCandidate[]>> {
      const result = await lookupISBN(isbn, context)
      if (result.status !== "found") return result
      const covers = hasProviderRight(policy, "previewCover") ? result.value.flatMap((candidate) => candidate.coverUrl ? [{ provider: candidate.provider, coverKey: candidate.recordId ?? isbn, sourceUrl: candidate.sourceUrl, imageUrl: candidate.coverUrl, rightsPolicyVersion: policy.version, attribution: policy.attribution }] : []) : []
      return covers.length ? { ...result, value: covers } : { provider: "open-library", requestId: context.requestId, status: "notFound" }
    },
  }
  return { ...provider, readIsbnRecord }
}

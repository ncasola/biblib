import { z } from "zod"
import { normalizeIsbn } from "../../isbn"
import { normalizeCandidate } from "../normalize"
import { providerQuotaPolicy, retryAfterMs } from "../quota"
import { hasProviderRight, providerRightsPolicy } from "../rights"
import type { BibliographicCandidate, CatalogProvider, CoverCandidate, ProviderContext, ProviderResult } from "../types"

const ENDPOINT = "https://www.googleapis.com/books/v1/volumes"
const MAX_BYTES = 1_048_576
const volumeSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  volumeInfo: z.object({
    title: z.string().trim().min(1).max(500).optional(), subtitle: z.string().max(1000).optional(),
    authors: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
    publisher: z.string().trim().min(1).max(200).optional(), publishedDate: z.string().max(100).optional(),
    pageCount: z.number().int().min(0).max(100000).optional(), language: z.string().max(100).optional(),
    printType: z.string().max(100).optional(),
    industryIdentifiers: z.array(z.object({ type: z.string().max(100), identifier: z.string().max(100) })).max(100).optional(),
    imageLinks: z.object({ thumbnail: z.string().max(2000).optional(), smallThumbnail: z.string().max(2000).optional() }).optional(),
  }),
})
export const googleBooksResponseSchema = z.object({
  kind: z.literal("books#volumes").optional(), totalItems: z.number().int().min(0),
  items: z.array(volumeSchema).max(10).optional(),
}).refine((value) => value.totalItems === 0 || Boolean(value.items?.length))
type Volume = z.infer<typeof volumeSchema>

export interface GoogleBooksOptions {
  enabled?: boolean
  mode?: "fixture" | "live"
  /** Inyección exclusiva del harness servidor; nunca pertenece al DTO de configuración. */
  apiKey?: string
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

/** Para diagnóstico: omite toda la query (también el ISBN/título), credenciales y fragmento. */
export function redactGoogleBooksUrl(): string { return ENDPOINT }

class GoogleFailure extends Error {
  constructor(readonly status: "unavailable" | "rateLimited", readonly retryAfterSeconds?: number) {
    super("Google Books no está disponible. Puedes seguir con Open Library, BNE o el alta manual.")
  }
}

function identifiers(volume: Volume): string[] {
  return (volume.volumeInfo.industryIdentifiers ?? [])
    .filter((entry) => ["ISBN_10", "ISBN_13"].includes(entry.type) && normalizeIsbn(entry.identifier))
    .map((entry) => entry.identifier)
}

function candidate(volume: Volume, retrievedAt: string, isbn?: string): BibliographicCandidate {
  const info = volume.volumeInfo
  // Sin imageLinks/coverUrl: el DTO de metadatos nunca puede alimentar Book.cover/export.
  return normalizeCandidate({
    provider: "google-books", level: "edition", recordId: volume.id,
    sourceUrl: `https://books.google.com/books?id=${volume.id}`, isbns: identifiers(volume),
    title: info.title, subtitle: info.subtitle, authors: (info.authors ?? []).map((name) => ({ name })),
    publishers: info.publisher ? [{ name: info.publisher }] : [], publishDate: info.publishedDate,
    numberOfPages: info.pageCount, language: info.language, format: info.printType,
    evidence: { isbnExact: false }, retrievedAt,
  }, isbn)
}

function previewUrl(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port ||
      !["books.google.com", "books.googleusercontent.com"].includes(url.hostname)) return undefined
    url.protocol = "https:"
    // Nunca publicar credenciales aportadas por el proveedor, aunque no sean nuestra key.
    for (const name of [...url.searchParams.keys()]) {
      if (/key|token|auth|secret|signature/i.test(name)) url.searchParams.delete(name)
    }
    url.hash = ""
    return url.href
  } catch { return undefined }
}

/** Adaptador sin caché, reintentos, OAuth ni escrituras; usa la cuota compartida del gateway en live. */
export function createGoogleBooksProvider(options: GoogleBooksOptions = {}): CatalogProvider {
  if (typeof window !== "undefined") throw new Error("Google Books solo está disponible en el servidor.")
  const key = (options.apiKey ?? process.env.GOOGLE_BOOKS_API_KEY)?.trim()
  const policy = providerRightsPolicy("google-books")
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const now = options.now ?? Date.now
  let nextRequestAt = 0
  let cooldownUntil = 0

  async function load(query: string, context: ProviderContext): Promise<{ volumes: Volume[]; retrievedAt: string }> {
    context.signal.throwIfAborted()
    const start = Math.max(now(), nextRequestAt, cooldownUntil)
    if (start - now() > 1000) throw new GoogleFailure("rateLimited", Math.ceil((start - now()) / 1000))
    nextRequestAt = start + providerQuotaPolicy("google-books")!.intervalMs
    const controller = new AbortController()
    const abort = () => controller.abort()
    context.signal.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(abort, Math.min(3500, Math.max(1, options.timeoutMs ?? 3500)))
    let waiting: ReturnType<typeof setTimeout> | undefined
    let response: Response | undefined
    const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new GoogleFailure("unavailable")), { once: true }))
    try {
      const delay = start - now()
      if (delay > 0) await Promise.race([new Promise<void>((resolve) => { waiting = setTimeout(resolve, delay) }), aborted])
      controller.signal.throwIfAborted()
      const url = new URL(ENDPOINT)
      url.search = new URLSearchParams({ q: query, maxResults: "10", key: key! }).toString()
      // URL únicamente en fetch. No registrar url, Response, payload ni errores externos.
      response = await Promise.race([request(url, {
        method: "GET", headers: { Accept: "application/json" }, signal: controller.signal,
        cache: "no-store", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
      }), aborted])
      if (response.status === 429) {
        const milliseconds = retryAfterMs(response.headers.get("retry-after"), now())
        cooldownUntil = Math.max(cooldownUntil, now() + milliseconds)
        throw new GoogleFailure("rateLimited", Math.ceil(milliseconds / 1000))
      }
      if (!response.ok || Number(response.headers.get("content-length")) > MAX_BYTES) throw new GoogleFailure("unavailable")
      const reader = response.body?.getReader()
      if (!reader) throw new GoogleFailure("unavailable")
      const decoder = new TextDecoder()
      let size = 0
      let body = ""
      try {
        for (;;) {
          const chunk = await Promise.race([reader.read(), aborted])
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > MAX_BYTES) throw new GoogleFailure("unavailable")
          body += decoder.decode(chunk.value, { stream: true })
        }
        body += decoder.decode()
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
      // Respuesta que refleje la credencial: falla cerrada antes de validar/mapear/publicar.
      if (body.includes(key!) || body.includes(encodeURIComponent(key!))) throw new GoogleFailure("unavailable")
      const parsed = googleBooksResponseSchema.parse(JSON.parse(body))
      if (JSON.stringify(parsed).includes(key!)) throw new GoogleFailure("unavailable")
      return { volumes: parsed.items ?? [], retrievedAt: new Date(now()).toISOString() }
    } finally {
      clearTimeout(timer); clearTimeout(waiting)
      context.signal.removeEventListener("abort", abort)
      void response?.body?.cancel().catch(() => {})
    }
  }

  async function run<T>(context: ProviderContext, call: () => Promise<T[]>): Promise<ProviderResult<T[]>> {
    const base = { provider: "google-books", requestId: context.requestId }
    if (options.enabled !== true || options.mode === "fixture") return { ...base, status: "disabled" }
    if (!key) return { ...base, status: "misconfigured" }
    try {
      const value = await call()
      return value.length ? { ...base, status: "found", value } : { ...base, status: "notFound" }
    } catch (error) {
      return { ...base, status: error instanceof GoogleFailure ? error.status : "unavailable",
        ...(error instanceof GoogleFailure && error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}) }
    }
  }

  async function lookup(isbn: string, context: ProviderContext) {
    const canonical = isbn.length <= 100 ? normalizeIsbn(isbn) : null
    if (!canonical) throw new GoogleFailure("unavailable")
    const result = await load(`isbn:${canonical}`, context)
    return { ...result, canonical, volumes: result.volumes.filter((volume) => identifiers(volume).some((value) => normalizeIsbn(value) === canonical)) }
  }

  return {
    id: "google-books", capabilities: { lookupISBN: true, searchTitleAuthor: true, resolveEditions: false, getCover: true },
    lookupISBN: (isbn, context) => run(context, async () => {
      const result = await lookup(isbn, context)
      return result.volumes.map((volume) => candidate(volume, result.retrievedAt, result.canonical))
    }),
    searchTitleAuthor: (query, context) => run(context, async () => {
      if ((!query.title?.trim() && !query.author?.trim()) || (query.title?.length ?? 0) > 500 || (query.author?.length ?? 0) > 500) throw new GoogleFailure("unavailable")
      const quote = (value: string) => `"${value.replace(/["\\]/g, " ").trim()}"`
      const terms = [query.title?.trim() ? `intitle:${quote(query.title.trim())}` : "", query.author?.trim() ? `inauthor:${quote(query.author.trim())}` : ""].filter(Boolean).join(" ")
      const result = await load(terms, context)
      return result.volumes.map((volume) => candidate(volume, result.retrievedAt))
    }),
    getCover: (isbn, context) => run<CoverCandidate>(context, async () => {
      if (!hasProviderRight(policy, "previewCover")) return []
      const result = await lookup(isbn, context)
      return result.volumes.flatMap((volume) => {
        const imageUrl = previewUrl(volume.volumeInfo.imageLinks?.thumbnail) ?? previewUrl(volume.volumeInfo.imageLinks?.smallThumbnail)
        return imageUrl ? [{ provider: "google-books" as const, coverKey: volume.id,
          sourceUrl: `https://books.google.com/books?id=${volume.id}`, imageUrl,
          rightsPolicyVersion: policy.version, attribution: policy.attribution }] : []
      })
    }),
  }
}

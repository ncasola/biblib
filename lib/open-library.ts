import { z } from "zod"
import { normalizeBookCover } from "./book-covers"
import { DomainError } from "./domain-errors"
import { normalizeIsbn } from "./isbn"
import { classifyProviderFailure } from "./observability/events"
import { emitSafely, noopTelemetry, type TelemetryEmitter } from "./observability/emitter"
import type { Book } from "./types"

const REQUEST_TIMEOUT_MS = 8_000
const REQUEST_INTERVAL_MS = 1_000
const MAX_CACHE_ENTRIES = 500
const CACHE_TTL_MS = 60 * 60 * 1_000
const NOT_FOUND_TTL_MS = 5 * 60 * 1_000
const httpUrl = z.url().refine((value) => ["https:", "http:"].includes(new URL(value).protocol))
const providerBookSchema = z.object({
  url: httpUrl.optional(),
  title: z.string().trim().min(1).max(500),
  subtitle: z.string().max(1_000).optional(),
  authors: z.array(z.object({ name: z.string().trim().min(1).max(200), url: httpUrl.optional() })).max(30).optional(),
  number_of_pages: z.number().int().min(0).max(100_000).optional(),
  publish_date: z.string().max(100).optional(),
  publishers: z.array(z.object({ name: z.string().trim().min(1).max(200) })).max(20).optional(),
  cover: z.object({ small: httpUrl.optional(), medium: httpUrl.optional(), large: httpUrl.optional() }).optional(),
  identifiers: z.object({ isbn_10: z.array(z.string()).optional(), isbn_13: z.array(z.string()).optional(), openlibrary: z.array(z.string()).optional() }).optional(),
  languages: z.array(z.object({ key: z.string() })).optional(),
  physical_format: z.string().optional(),
})

export type OpenLibraryRecord = z.infer<typeof providerBookSchema>
type LookupRecord = { book: Book; record: OpenLibraryRecord; retrievedAt: string }

type ClientOptions = {
  fetch?: typeof fetch
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
  contact?: string
  telemetry?: TelemetryEmitter
  cacheMetadata?: boolean
}

/** Identificación y política de uso: https://openlibrary.org/developers/api */
export function openLibraryHeaders(contact = process.env.OPEN_LIBRARY_CONTACT): HeadersInit {
  const safeContact = contact?.replace(/[\r\n]/g, " ").trim()
  return { "User-Agent": safeContact ? `BibLib/1.0 (${safeContact})` : "BibLib/1.0", Accept: "application/json" }
}

export function createOpenLibraryClient(options: ClientOptions = {}) {
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const now = options.now ?? Date.now
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const telemetry = options.telemetry ?? noopTelemetry
  const cache = new Map<string, { expires: number; value: LookupRecord | null }>()
  const inFlight = new Map<string, Promise<LookupRecord | null>>()
  let nextRequestAt = 0

  async function lookup(isbn: string, signal?: AbortSignal): Promise<LookupRecord | null> {
    signal?.throwIfAborted()
    // Solo se reserva hasta un segundo de espera; el exceso se rechaza sin cola ilimitada.
    const start = Math.max(now(), nextRequestAt)
    if (start - now() > REQUEST_INTERVAL_MS) {
      throw new DomainError("RATE_LIMITED", "Hay varias búsquedas en curso. Espera unos segundos y vuelve a intentarlo.")
    }
    const remaining = start - now()
    nextRequestAt = start + REQUEST_INTERVAL_MS
    if (remaining > 0) {
      if (options.wait) await wait(remaining)
      else await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal?.reason) }
        const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve() }, remaining)
        signal?.addEventListener("abort", onAbort, { once: true })
      })
    }
    signal?.throwIfAborted()

    const url = new URL("https://openlibrary.org/api/books")
    url.searchParams.set("bibkeys", `ISBN:${isbn}`)
    url.searchParams.set("format", "json")
    url.searchParams.set("jscmd", "data")
    const startedAt = now()
    let httpStatus: number | undefined
    try {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const response = await request(url, { headers: openLibraryHeaders(options.contact), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, cache: "no-store" })
      httpStatus = response.status
      if (response.status === 429) throw new DomainError("RATE_LIMITED", "Open Library ha limitado las consultas. Espera unos segundos y vuelve a intentarlo.")
      if (!response.ok) throw new DomainError("PROVIDER_UNAVAILABLE", "Open Library no está disponible ahora. Puedes reintentar o añadir el libro manualmente.")
      const payload: unknown = await response.json()
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new DomainError("PROVIDER_UNAVAILABLE", "Open Library devolvió una respuesta que no se pudo interpretar. Vuelve a intentarlo.")
      }
      if (Object.keys(payload).some((key) => key !== `ISBN:${isbn}`)) {
        throw new DomainError("PROVIDER_UNAVAILABLE", "Open Library devolvió una respuesta inesperada. Vuelve a intentarlo.")
      }
      const raw = (payload as Record<string, unknown>)[`ISBN:${isbn}`]
      let book: Book | null = null
      if (raw !== undefined) {
        const parsed = providerBookSchema.safeParse(raw)
        if (!parsed.success) throw new DomainError("PROVIDER_UNAVAILABLE", "La ficha recibida de Open Library está incompleta o no es válida. Puedes añadir el libro manualmente.")
        const data = parsed.data
        const cover = normalizeBookCover(data.cover)
        for (const size of ["small", "medium", "large"] as const) {
          if (cover[size].startsWith("http://covers.openlibrary.org/")) cover[size] = cover[size].replace("http:", "https:")
        }
        const sourceUrl = data.url?.replace(/^http:\/\/openlibrary\.org\//, "https://openlibrary.org/")
        book = {
          id: `book-${isbn}`, isbn, title: data.title, subtitle: data.subtitle,
          authors: data.authors?.length ? data.authors : [{ name: "Autor desconocido" }],
          number_of_pages: data.number_of_pages ?? 0, publish_date: data.publish_date ?? "",
          publishers: data.publishers?.length ? data.publishers : undefined,
          cover, status: "to-read", shelf_id: "", shelf_name: "Predeterminada",
          catalogue: { source: "open-library", isbnVerified: false, ...(sourceUrl?.startsWith("https://") ? { sourceUrl } : {}) },
        }
      }
      signal?.throwIfAborted()
      const value = book ? { book, record: providerBookSchema.parse(raw), retrievedAt: new Date(now()).toISOString() } : null
      if (options.cacheMetadata !== false) {
        if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
        cache.set(isbn, { value, expires: now() + (book ? CACHE_TTL_MS : NOT_FOUND_TTL_MS) })
      }
      emitSafely(telemetry, "provider.request", { operation: "open-library.lookup", provider: "open-library", result: "ok", durationMs: Math.max(0, now() - startedAt), httpStatus })
      return value
    } catch (error) {
      // Nunca se registra la URL ni el ISBN consultado: solo estado y clasificación.
      emitSafely(telemetry, "provider.request", { operation: "open-library.lookup", provider: "open-library", result: "error", durationMs: Math.max(0, now() - startedAt), httpStatus, errorCode: classifyProviderFailure(httpStatus && (httpStatus >= 400 || error instanceof DomainError) ? httpStatus : error) })
      if (error instanceof DomainError) throw error
      throw new DomainError("PROVIDER_UNAVAILABLE", "No se pudo contactar con Open Library. Comprueba la conexión o vuelve a intentarlo.")
    }
  }

  async function searchRecordByISBN(value: string, signal?: AbortSignal): Promise<LookupRecord | null> {
    signal?.throwIfAborted()
    const isbn = typeof value === "string" && value.length <= 100 ? normalizeIsbn(value) : null
    if (!isbn) throw new DomainError("INVALID_INPUT", "El ISBN no es válido. Introduce un ISBN de 10 o 13 dígitos con su dígito de control correcto.")
    const cached = cache.get(isbn)
    if (cached && cached.expires > now()) return structuredClone(cached.value)
    cache.delete(isbn)
    // Una cancelación no debe cancelar la consulta de otro solicitante.
    if (signal) return structuredClone(await lookup(isbn, signal))
    let pending = inFlight.get(isbn)
    if (!pending) {
      pending = lookup(isbn)
      inFlight.set(isbn, pending)
    }
    try { return structuredClone(await pending) } finally {
      if (inFlight.get(isbn) === pending) inFlight.delete(isbn)
    }
  }

  async function searchBookByISBN(value: string, signal?: AbortSignal): Promise<Book | null> {
    return (await searchRecordByISBN(value, signal))?.book ?? null
  }

  return { searchBookByISBN, searchRecordByISBN }
}

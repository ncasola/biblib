import { normalizeIsbn } from "../../isbn"
import { MAX_BNE_XML_BYTES, parseBneExplain, parseBneSearchRetrieve } from "../marcxml"
import { hasProviderRight, providerRightsPolicy } from "../rights"
import type { BibliographicCandidate, CatalogProvider, ProviderContext, ProviderResult, TitleAuthorQuery } from "../types"

const ENDPOINT = "https://catalogo.bne.es/view/sru/34BNE_INST"
export interface BneSruOptions {
  fetch?: typeof fetch
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
  timeoutMs?: number
  maximumRecords?: number
  maxResponseBytes?: number
  cacheMetadata?: boolean
  /** Inyección de endpoint únicamente con target=test (no se lee una URL del entorno). */
  endpoint?: string
  target?: string
}
class RateLimited extends Error { constructor(public seconds: number) { super("BNE ha limitado las consultas.") } }
function escaped(value: string): string {
  if (!value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Introduce un título o autor válido.")
  return value.trim().replace(/[\\"*?^]/g, "\\$&")
}
export function bneTitleAuthorCql(query: TitleAuthorQuery): string {
  const parts = [query.title?.trim() ? `alma.title="${escaped(query.title)}"` : "", query.author?.trim() ? `alma.creator="${escaped(query.author)}"` : ""].filter(Boolean)
  if (!parts.length) throw new Error("Introduce un título o autor para buscar.")
  return parts.join(" and ")
}

/** SRU 1.2 fijo, sin redirects ni resolución externa de recursos XML. */
export function createBneSruProvider(options: BneSruOptions = {}): CatalogProvider & { explain(context: ProviderContext): Promise<{ indexes: string[] }> } {
  const endpoint = new URL(options.endpoint ?? ENDPOINT)
  if (options.endpoint && (options.target ?? process.env.BIBLIB_TARGET) !== "test") throw new Error("El endpoint BNE solo se puede cambiar en pruebas.")
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.search || (!options.endpoint && endpoint.hostname !== "catalogo.bne.es")) throw new Error("El endpoint BNE no está permitido.")
  const maximumRecords = Math.min(10, Math.max(1, Math.floor(options.maximumRecords ?? 10)))
  const maxBytes = Math.min(MAX_BNE_XML_BYTES, Math.max(1, options.maxResponseBytes ?? MAX_BNE_XML_BYTES))
  const timeoutMs = Math.min(3500, Math.max(1, options.timeoutMs ?? 3500))
  if (![maximumRecords, maxBytes, timeoutMs].every(Number.isFinite)) throw new Error("Los límites BNE no son válidos.")
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const now = options.now ?? Date.now
  const policy = providerRightsPolicy("bne")
  const cache = new Map<string, { expires: number; candidates: BibliographicCandidate[] }>()
  let nextRequestAt = 0
  let cooldownUntil = 0

  async function xmlRequest(params: Record<string, string>, context: ProviderContext): Promise<string> {
    context.signal.throwIfAborted()
    const start = Math.max(now(), nextRequestAt, cooldownUntil)
    if (start - now() > 1000) throw new RateLimited(Math.ceil((start - now()) / 1000))
    nextRequestAt = start + 1000
    const controller = new AbortController()
    const abort = () => controller.abort()
    context.signal.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(abort, timeoutMs)
    const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("La consulta BNE ha caducado.")), { once: true }))
    try {
      const delay = start - now()
      if (delay > 0) await Promise.race([options.wait ? options.wait(delay) : new Promise<void>((resolve) => {
        const waiting = setTimeout(resolve, delay)
        controller.signal.addEventListener("abort", () => clearTimeout(waiting), { once: true })
      }), aborted])
      controller.signal.throwIfAborted()
      const url = new URL(endpoint)
      url.search = new URLSearchParams({ version: "1.2", ...params }).toString()
      const response = await Promise.race([request(url, { headers: { Accept: "application/xml", "User-Agent": "BibLib/1.0" }, cache: "no-store", redirect: "error", signal: controller.signal }), aborted])
      if (response.status === 429) {
        const header = response.headers.get("retry-after")
        const seconds = header && /^\d+$/.test(header) ? Number(header) : header ? Math.ceil((Date.parse(header) - now()) / 1000) : 1
        const retry = Number.isFinite(seconds) ? Math.max(1, seconds) : 1
        cooldownUntil = Math.max(cooldownUntil, now() + retry * 1000)
        void response.body?.cancel().catch(() => {})
        throw new RateLimited(retry)
      }
      if (!response.ok || Number(response.headers.get("content-length")) > maxBytes) { void response.body?.cancel().catch(() => {}); throw new Error("BNE no está disponible.") }
      const reader = response.body?.getReader()
      if (!reader) throw new Error("BNE no devolvió XML.")
      let bytes = 0
      const chunks: Uint8Array[] = []
      const cancel = () => { void reader.cancel().catch(() => {}) }
      controller.signal.addEventListener("abort", cancel, { once: true })
      try {
        while (true) {
          const part = await Promise.race([reader.read(), aborted])
          if (part.done) break
          bytes += part.value.byteLength
          if (bytes > maxBytes) { void reader.cancel().catch(() => {}); throw new Error("La respuesta BNE es demasiado grande.") }
          chunks.push(part.value)
        }
      } finally { controller.signal.removeEventListener("abort", cancel); reader.releaseLock() }
      const all = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength }
      return new TextDecoder("utf-8", { fatal: true }).decode(all)
    } finally { clearTimeout(timer); context.signal.removeEventListener("abort", abort) }
  }

  async function search(query: string, context: ProviderContext, isbn?: string, page = 1, limit = maximumRecords): Promise<ProviderResult<BibliographicCandidate[]>> {
    const base = { provider: "bne", requestId: context.requestId }
    try {
      context.signal.throwIfAborted()
      const cached = isbn ? cache.get(query) : undefined
      let candidates = cached && cached.expires > now() ? structuredClone(cached.candidates) : undefined
      if (!candidates) {
        cache.delete(query)
        candidates = []
        // El parser MARC mantiene su límite de diez registros por respuesta; veinte usa dos páginas SRU.
        for (let offset = 0; offset < limit; offset += 10) {
          const size = Math.min(10, limit - offset)
          const xml = await xmlRequest({ operation: "searchRetrieve", query, recordSchema: "marcxml", recordPacking: "xml", maximumRecords: String(size), startRecord: String((page - 1) * limit + offset + 1) }, context)
          const records = parseBneSearchRetrieve(xml, { retrievedAt: new Date(now()).toISOString(), isbn, maximumRecords: size, maxBytes, startRecord: (page - 1) * limit + offset + 1 })
          candidates.push(...records)
          if (records.length < size) break
        }
        if (isbn) candidates = candidates.filter((candidate) => candidate.evidence.isbnExact)
        if (isbn && options.cacheMetadata !== false && hasProviderRight(policy, "cacheMetadata")) {
          if (cache.size >= 500) cache.delete(cache.keys().next().value!)
          cache.set(query, { candidates: structuredClone(candidates), expires: now() + (candidates.length ? policy.metadataTtlSeconds * 1000 : 300000) })
        }
      }
      return candidates.length ? { ...base, status: "found", value: candidates } : { ...base, status: "notFound" }
    } catch (error) {
      return error instanceof RateLimited ? { ...base, status: "rateLimited", retryAfterSeconds: error.seconds } : { ...base, status: "unavailable" }
    }
  }
  return {
    id: "bne", capabilities: { lookupISBN: true, searchTitleAuthor: true, resolveEditions: false, getCover: false },
    async lookupISBN(value, context) {
      const isbn = typeof value === "string" && value.length <= 100 ? normalizeIsbn(value) : null
      if (!isbn) return { provider: "bne", requestId: context.requestId, status: "unavailable" }
      return search(`alma.isbn="${isbn}"`, context, isbn)
    },
    async searchTitleAuthor(query, context) {
      try { return await search(bneTitleAuthorCql(query), context, undefined, query.page ?? 1, query.limit ?? maximumRecords) }
      catch { return { provider: "bne", requestId: context.requestId, status: "unavailable" } }
    },
    async explain(context) { return parseBneExplain(await xmlRequest({ operation: "explain" }, context)) },
  }
}

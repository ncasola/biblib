import { readCatalogueFixture } from "../../catalogue-fixtures"
import { fromOpenLibrary, normalizeCandidate } from "../normalize"
import type { CatalogProvider, ProviderId } from "../types"
import { bneRecordUrl } from "./endpoints"
import { z } from "zod"
import textFixture from "../../../tests/fixtures/bibliography/title-author.json"
import editionsFixture from "../../../tests/fixtures/bibliography/title-author-editions.json"
import type { BibliographicCandidate } from "../types"

const retrievedAt = "2026-10-23T00:00:00.000Z"
const folded = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

const fixtureSchema = z.object({ title: z.string(), authors: z.array(z.object({ name: z.string() })).optional(), publishers: z.array(z.object({ name: z.string() })).optional(), number_of_pages: z.number().optional(), publish_date: z.string().optional() })
const RETRIEVED_AT = "2026-10-23T00:00:00.000Z"

/*
 * ISBN válidos reservados (con dígito de control) para ensayar cada resultado de un proveedor sin red.
 * Ninguno está en el censo A/B ni en los fixtures de fichas.
 */
/** El proveedor responde «no disponible» (error 5xx simulado). */
export const FIXTURE_UNAVAILABLE_ISBN = "9780000000040"
/** Open Library responde 429 con `Retry-After`; BNE responde sin ficha. */
export const FIXTURE_RATE_LIMITED_ISBN = "9780000000064"
/** Open Library no responde hasta que el orquestador agota su plazo; BNE responde sin ficha. */
export const FIXTURE_TIMEOUT_ISBN = "9780000000071"
/** Todas las fuentes devuelven que la cuota compartida está agotada (espera de una hora). */
export const FIXTURE_BUDGET_EXHAUSTED_ISBN = "9780000000088"
/** Open Library no tiene ficha y BNE sí: un proveedor vacío y otro disponible. */
export const FIXTURE_BNE_ONLY_ISBN = "9780000000095"

const BNE_ONLY_RECORD = { title: "El archivo de las mareas", authors: [{ name: "Autora Ficticia" }], publishers: [{ name: "Editorial Ficticia" }], number_of_pages: 210, publish_date: "2001" }

/** Adaptador sin fetch; los fixtures nunca instancian proveedores live. */
export function createFixtureProvider(id: Extract<ProviderId, "open-library" | "bne"> = "open-library"): CatalogProvider {
  return {
    // Búsqueda por título/autor y ediciones (U-DAT-08) solo en el Open Library ficticio; el BNE ficticio (U-BIB-05) resuelve ISBN.
    id, capabilities: { lookupISBN: true, searchTitleAuthor: id === "open-library", resolveEditions: id === "open-library", getCover: id === "open-library" },
    async searchTitleAuthor(query, context) {
      context.signal.throwIfAborted()
      const base = { provider: id, requestId: context.requestId }
      if (id !== "open-library") return { ...base, status: "disabled" }
      const title = folded(query.title ?? "")
      const author = folded(query.author ?? "")
      const entries = textFixture.docs.filter((doc) => (!title || folded(doc.title ?? "").includes(title)) && (!author || folded(doc.author_name?.join(" ") ?? "").includes(author)))
      const limit = query.limit ?? 10
      const value: BibliographicCandidate[] = entries.slice(((query.page ?? 1) - 1) * limit, (query.page ?? 1) * limit).map((doc) => ({
        provider: "open-library", level: "work", recordId: doc.key.split("/").at(-1), sourceUrl: `https://openlibrary.org${doc.key}`,
        title: doc.title, authors: (doc.author_name ?? []).map((name) => ({ name })), publishers: [], isbns: [], evidence: { isbnExact: false }, retrievedAt,
      }))
      return value.length ? { ...base, status: "found", value } : { ...base, status: "notFound" }
    },
    async resolveEditions(work, context) {
      context.signal.throwIfAborted()
      const base = { provider: id, requestId: context.requestId }
      if (id !== "open-library") return { ...base, status: "disabled" }
      if (work.page === undefined && work.recordId !== "OL100W") return { ...base, status: "unavailable" }
      const limit = work.limit ?? 10
      const value: BibliographicCandidate[] = work.recordId === "OL100W" ? editionsFixture.entries.slice(((work.page ?? 1) - 1) * limit, (work.page ?? 1) * limit).map((entry) => ({
        provider: "open-library", level: "edition", recordId: entry.key.split("/").at(-1), sourceUrl: `https://openlibrary.org${entry.key}`,
        title: entry.title, authors: [], publishers: [], isbns: entry.isbn_13 ?? [], language: entry.languages?.[0]?.key.split("/").at(-1), publishDate: entry.publish_date, evidence: { isbnExact: false }, retrievedAt,
      })) : []
      return value.length ? { ...base, status: "found", value } : { ...base, status: "notFound" }
    },
    async lookupISBN(isbn, context) {
      context.signal.throwIfAborted()
      const base = { provider: id, requestId: context.requestId }
      if (isbn === FIXTURE_UNAVAILABLE_ISBN && id === "open-library") return { ...base, status: "unavailable" }
      if (isbn === FIXTURE_RATE_LIMITED_ISBN && id === "open-library") return { ...base, status: "rateLimited", retryAfterSeconds: 30 }
      if (isbn === FIXTURE_BUDGET_EXHAUSTED_ISBN) return { ...base, status: "rateLimited", retryAfterSeconds: 3600 }
      if (isbn === FIXTURE_TIMEOUT_ISBN && id === "open-library") {
        // Sin respuesta hasta que el orquestador cancela por plazo: el resultado es «no disponible», nunca «sin ficha».
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }))
        return { ...base, status: "unavailable" }
      }
      if (id === "bne") {
        if (isbn !== FIXTURE_BNE_ONLY_ISBN) return { ...base, status: "notFound" }
        return { ...base, status: "found", value: [normalizeCandidate({
          provider: "bne", level: "edition", recordId: "fixture-bne-1", sourceUrl: bneRecordUrl("fixture-bne-1"), isbns: [isbn],
          title: BNE_ONLY_RECORD.title, authors: BNE_ONLY_RECORD.authors, publishers: BNE_ONLY_RECORD.publishers,
          numberOfPages: BNE_ONLY_RECORD.number_of_pages, publishDate: BNE_ONLY_RECORD.publish_date,
          evidence: { isbnExact: false }, retrievedAt: RETRIEVED_AT,
        }, isbn)] }
      }
      if (isbn === FIXTURE_BNE_ONLY_ISBN) return { ...base, status: "notFound" }
      const raw = readCatalogueFixture(isbn)[`ISBN:${isbn}`]
      if (!raw) return { ...base, status: "notFound" }
      return { ...base, status: "found", value: [fromOpenLibrary(fixtureSchema.parse(raw), isbn, RETRIEVED_AT)] }
    },
    async getCover(_isbn, context) {
      context.signal.throwIfAborted()
      // Los fixtures actuales solo contienen fallback local, no una imagen fuente.
      return { provider: id, requestId: context.requestId, status: "notFound" }
    },
  }
}

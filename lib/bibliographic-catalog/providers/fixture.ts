import { readCatalogueFixture } from "../../catalogue-fixtures"
import { fromOpenLibrary } from "../normalize"
import type { CatalogProvider } from "../types"
import { z } from "zod"
import textFixture from "../../../tests/fixtures/bibliography/title-author.json"
import editionsFixture from "../../../tests/fixtures/bibliography/title-author-editions.json"
import type { BibliographicCandidate } from "../types"

const retrievedAt = "2026-10-23T00:00:00.000Z"
const folded = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

const fixtureSchema = z.object({ title: z.string(), authors: z.array(z.object({ name: z.string() })).optional(), publishers: z.array(z.object({ name: z.string() })).optional(), number_of_pages: z.number().optional(), publish_date: z.string().optional() })

/** ISBN válido reservado: el adaptador fixture responde «no disponible» para ensayar el fallo del proveedor. */
export const FIXTURE_UNAVAILABLE_ISBN = "9780000000040"

/** Adaptador sin fetch; los fixtures nunca instancian proveedores live. */
export function createFixtureProvider(): CatalogProvider {
  return {
    id: "open-library", capabilities: { lookupISBN: true, searchTitleAuthor: true, resolveEditions: true, getCover: true },
    async searchTitleAuthor(query, context) {
      context.signal.throwIfAborted()
      const base = { provider: "open-library", requestId: context.requestId }
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
      const base = { provider: "open-library", requestId: context.requestId }
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
      const base = { provider: "open-library", requestId: context.requestId }
      if (isbn === FIXTURE_UNAVAILABLE_ISBN) return { ...base, status: "unavailable" }
      const raw = readCatalogueFixture(isbn)[`ISBN:${isbn}`]
      if (!raw) return { ...base, status: "notFound" }
      return { ...base, status: "found", value: [fromOpenLibrary(fixtureSchema.parse(raw), isbn, "2026-10-23T00:00:00.000Z")] }
    },
    async getCover(_isbn, context) {
      context.signal.throwIfAborted()
      // Los fixtures actuales solo contienen fallback local, no una imagen fuente.
      return { provider: "open-library", requestId: context.requestId, status: "notFound" }
    },
  }
}

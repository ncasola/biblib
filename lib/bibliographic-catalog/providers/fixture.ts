import { readCatalogueFixture } from "../../catalogue-fixtures"
import { fromOpenLibrary } from "../normalize"
import type { CatalogProvider } from "../types"
import { z } from "zod"

const fixtureSchema = z.object({ title: z.string(), authors: z.array(z.object({ name: z.string() })).optional(), publishers: z.array(z.object({ name: z.string() })).optional(), number_of_pages: z.number().optional(), publish_date: z.string().optional() })

/** Adaptador sin fetch; los fixtures nunca instancian proveedores live. */
export function createFixtureProvider(): CatalogProvider {
  return {
    id: "open-library", capabilities: { lookupISBN: true, searchTitleAuthor: false, resolveEditions: false, getCover: true },
    async lookupISBN(isbn, context) {
      context.signal.throwIfAborted()
      const raw = readCatalogueFixture(isbn)[`ISBN:${isbn}`]
      const base = { provider: "open-library", requestId: context.requestId }
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

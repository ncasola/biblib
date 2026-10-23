import { readCatalogueFixture } from "../../catalogue-fixtures"
import { fromOpenLibrary, normalizeCandidate } from "../normalize"
import type { CatalogProvider, ProviderId } from "../types"
import { bneRecordUrl } from "./endpoints"
import { z } from "zod"

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
    id, capabilities: { lookupISBN: true, searchTitleAuthor: false, resolveEditions: false, getCover: id === "open-library" },
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

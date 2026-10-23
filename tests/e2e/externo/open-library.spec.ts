import { expect, test } from "@playwright/test"
import { readCatalogConfig } from "../../../lib/bibliographic-catalog/config"
import { createConfiguredCatalog } from "../../../lib/bibliographic-catalog/registry"

// pnpm test:e2e:external — comprobación opt-in con Open Library y BNE reales (modo live), fuera de la suite
// y de CI de PR, y solo con la autorización de quien opera el despliegue. Usa el mismo servicio de catálogo
// que la app con UN ISBN público de prueba (como mucho dos peticiones: una por fuente); no usa cuentas,
// claves ni datos privados, y Google queda apagado. Sin red falla con un mensaje claro en lugar de
// confundirse con «libro inexistente».
//
// El resultado esperado no es un recuento: cada fuente puede responder con ficha o sin ella (una ausencia
// se registra en la salida y no falla). Lo que se comprueba es que cualquier respuesta válida se interpreta,
// que el ISBN consultado es el que consta en la ficha y que ninguna caída se presenta como «sin ficha».
// Tampoco se comprueba aquí un «no encontrado» live: los ISBN ficticios del censo existen en Open Library.

const PUBLIC_ISBN = "9780140328721" // Fantastic Mr Fox (Puffin), ejemplo habitual de la documentación de Open Library.
const MAX_EXTERNAL_REQUESTS = 3

test.beforeAll(async () => {
  if (process.env.BIBLIB_E2E_EXTERNAL !== "1") throw new Error("Esta comprobación solo se ejecuta con pnpm test:e2e:external.")
  try {
    await fetch("https://openlibrary.org/", { method: "HEAD", signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new Error("Sin acceso a https://openlibrary.org: test:e2e:external necesita red. No es un fallo de BibLib; repítelo con conexión.")
  }
})

test("catálogo live: un ISBN público se interpreta en Open Library y BNE sin confundir caídas con ausencias", async ({}, testInfo) => {
  let requests = 0
  const counting: typeof fetch = (input, init) => {
    requests++
    if (requests > MAX_EXTERNAL_REQUESTS) throw new Error("La comprobación externa supera su máximo de peticiones.")
    return fetch(input, init)
  }
  const config = readCatalogConfig({ BIBLIB_TARGET: "local", BIBLIB_CATALOGUE_MODE: "live", BIBLIB_BNE_ENABLED: "true", BIBLIB_GOOGLE_BOOKS_ENABLED: "false" })
  const result = await createConfiguredCatalog(config, { fetch: counting }).lookupISBN(PUBLIC_ISBN)
  const outcome = (provider: string) => result.providers.find((entry) => entry.provider === provider)?.status

  for (const provider of ["open-library", "bne"]) {
    expect(["found", "notFound"], `${provider} debe responder (una caída o un límite no es una ausencia): ${outcome(provider)}`).toContain(outcome(provider))
  }
  expect(outcome("google-books")).toBe("disabled")
  expect(requests).toBeLessThanOrEqual(MAX_EXTERNAL_REQUESTS)
  for (const candidate of result.candidates) {
    expect(candidate.isbns.map((isbn) => isbn.replace(/-/g, ""))).toContain(PUBLIC_ISBN)
    expect(candidate.evidence.isbnExact).toBe(true)
  }
  const sinFicha = ["open-library", "bne"].filter((provider) => outcome(provider) === "notFound")
  if (sinFicha.length) testInfo.annotations.push({ type: "sin ficha", description: sinFicha.join(", ") })
  console.log(`Catálogo live: ${result.candidates.length} ficha(s); estado por fuente: ${result.providers.map((entry) => `${entry.provider}=${entry.status}`).join(", ")}; peticiones externas: ${requests}`)
})

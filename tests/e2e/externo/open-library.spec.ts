import { expect, test } from "@playwright/test"
import { readCatalogConfig } from "../../../lib/bibliographic-catalog/config"
import { createConfiguredCatalog } from "../../../lib/bibliographic-catalog/registry"

// pnpm test:e2e:external — comprobación opt-in con Open Library real (modo live), fuera de CI de PR.
// Usa el mismo servicio de catálogo que la app con un ISBN público de prueba; no usa cuentas ni datos
// privados. Sin red falla con un mensaje claro en lugar de confundirse con «libro inexistente». No se
// comprueba aquí un «no encontrado» live: los ISBN ficticios del censo existen en Open Library.

const PUBLIC_ISBN = "9780140328721" // Fantastic Mr Fox (Puffin), ejemplo habitual de la documentación de Open Library.

test.beforeAll(async () => {
  if (process.env.BIBLIB_E2E_EXTERNAL !== "1") throw new Error("Esta comprobación solo se ejecuta con pnpm test:e2e:external.")
  try {
    await fetch("https://openlibrary.org/", { method: "HEAD", signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new Error("Sin acceso a https://openlibrary.org: test:e2e:external necesita red. No es un fallo de BibLib; repítelo con conexión.")
  }
})

test("Open Library live: un ISBN público se encuentra con su título", async () => {
  const catalog = createConfiguredCatalog(readCatalogConfig({ BIBLIB_TARGET: "local", BIBLIB_CATALOGUE_MODE: "live" }))
  const result = await catalog.lookupISBN(PUBLIC_ISBN)
  expect(result.providers.find((provider) => provider.provider === "open-library")?.status).toBe("found")
  expect(result.status).toBe("found")
  expect(result.candidates[0]?.title).toMatch(/fantastic mr\.? fox/i)
  expect(result.candidates[0]?.isbns).toContain(PUBLIC_ISBN)
})

import type { Page } from "@playwright/test"
import { alerts, capture, expect, test, titleField } from "../lib/fixtures"

// Proveedores en modo fixture (A): ficha encontrada con revisión antes de guardar, ISBN sin ficha y
// fallo del proveedor simulado en el servidor fixture. En los dos últimos el alta manual sigue
// disponible con el ISBN conservado. Ninguna consulta sale de loopback (lo vigilan guard y runner).

const FOUND_ISBN = "9780000000033" // tests/fixtures/catalogue/9780000000033.json, ficticio y fuera de A/B.
const NOT_FOUND_ISBN = "9780306406157" // ISBN válido sin fixture: «no encontrado».
const FAILING_ISBN = "9780000000040" // Reservado en el proveedor fixture: responde «no disponible».

test("encontrado: la ficha del fixture se revisa y corrige antes de guardarla", async ({ page, stack, data }) => {
  const slug = data.slug("encontrado")
  const title = data.marked(`Revisado ${slug}`)
  await page.goto("/books/add")
  await page.getByLabel("Número ISBN").fill(FOUND_ISBN)
  await page.getByRole("button", { name: "Buscar libro" }).click()
  await expect(page.getByRole("heading", { name: "Revisar libro encontrado" })).toBeVisible()
  await expect(titleField(page)).toHaveValue("El faro de las palabras")
  await expect(page.getByLabel("ISBN", { exact: true })).toHaveValue(FOUND_ISBN)
  expect(await stack.sql`select id from biblib.books where user_id = ${stack.users.a} and isbn = ${FOUND_ISBN}`, "Encontrar no guarda").toHaveLength(0)

  await titleField(page).fill(title)
  await page.getByRole("button", { name: "Agregar a la biblioteca" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Libro agregado a la biblioteca" })).toBeVisible()
  const [row] = await stack.sql`select title, catalogue->>'source' as source, catalogue->>'isbnVerified' as verified from biblib.books where user_id = ${stack.users.a} and isbn = ${FOUND_ISBN}`
  expect(row).toEqual({ title, source: "open-library", verified: "false" })
})

test("no encontrado: el aviso ofrece el alta manual con el ISBN conservado", async ({ page, stack, data, guard }) => {
  guard.allowConsole(/status of 404/)
  const slug = data.slug("sinficha")
  await page.goto("/books/add")
  await page.getByLabel("Número ISBN").fill(NOT_FOUND_ISBN)
  await page.getByRole("button", { name: "Buscar libro" }).click()
  await expect(alerts(page)).toHaveText("Open Library no tiene una ficha para este ISBN.")
  await page.getByRole("button", { name: "Completar ficha manual con este ISBN" }).click()
  await expect(page.getByLabel("ISBN", { exact: true })).toHaveValue(NOT_FOUND_ISBN)
  await titleField(page).fill(data.marked(`Manual sin ficha ${slug}`))
  await page.getByRole("button", { name: "Agregar a la biblioteca" }).click()
  await page.waitForURL(/\/book\/[0-9a-f-]{36}$/)
  expect(await stack.sql`select id from biblib.books where user_id = ${stack.users.a} and isbn = ${NOT_FOUND_ISBN}`).toHaveLength(1)
})

test("fallo del proveedor: no se confunde con «no encontrado» y conserva el alta manual", async ({ page, stack, data, guard }, testInfo) => {
  guard.allowConsole(/status of 5\d\d/)
  const slug = data.slug("fallo")
  await page.goto("/books/add")
  await page.getByLabel("Número ISBN").fill(FAILING_ISBN)
  await page.getByRole("button", { name: "Buscar libro" }).click()
  await expect(alerts(page)).toHaveText("No se pudo consultar Open Library. Puedes volver a intentarlo o añadir el libro manualmente.")
  await expect(page.getByLabel("Número ISBN")).toHaveValue(FAILING_ISBN)
  await capture(page, testInfo, "proveedor-no-disponible")
  await page.getByRole("button", { name: "Completar ficha manual con este ISBN" }).click()
  await expect(page.getByLabel("ISBN", { exact: true })).toHaveValue(FAILING_ISBN)
  await titleField(page).fill(data.marked(`Manual tras fallo ${slug}`))
  await page.getByRole("button", { name: "Agregar a la biblioteca" }).click()
  await page.waitForURL(/\/book\/[0-9a-f-]{36}$/)
  expect(await stack.sql`select id from biblib.books where user_id = ${stack.users.a} and isbn = ${FAILING_ISBN}`).toHaveLength(1)
})

// U-BIB-05 · Un proveedor vacío y otro disponible, 429, plazo agotado, 5xx y cuota global agotada, todos en
// modo fixture (lib/bibliographic-catalog/providers/fixture.ts). Cada uno conserva su significado: ninguno
// se presenta como «no encontrado» y el alta manual sigue disponible con el ISBN conservado.

const BNE_ONLY_ISBN = "9780000000095" // Open Library sin ficha y BNE con ficha.
const RATE_LIMITED_ISBN = "9780000000064" // Open Library responde 429 con Retry-After.
const TIMEOUT_ISBN = "9780000000071" // Open Library no responde hasta agotar su plazo (≈3,5 s).
const BUDGET_EXHAUSTED_ISBN = "9780000000088" // Todas las fuentes: cuota compartida agotada (espera de 1 h).

interface SearchBody { error?: string; code?: string; title?: string; catalogue?: { source?: string; sourceUrl?: string } }

async function searchEndpoint(page: Page, isbn: string): Promise<{ status: number; body: SearchBody }> {
  const response = await page.request.get(`/api/books/search?isbn=${isbn}`)
  return { status: response.status(), body: await response.json() as SearchBody }
}

test("un proveedor vacío y otro disponible: BNE aporta la ficha que Open Library no tiene, y encontrar no guarda", async ({ page, stack }) => {
  const { status, body } = await searchEndpoint(page, BNE_ONLY_ISBN)
  expect(status).toBe(200)
  expect(body.title).toBe("El archivo de las mareas")
  expect(body.catalogue?.source, "La ficha conserva su fuente real").toBe("bne")
  expect(body.catalogue?.sourceUrl?.startsWith("https://")).toBe(true)

  await page.goto("/books/add")
  await page.getByLabel("Número ISBN").fill(BNE_ONLY_ISBN)
  await page.getByRole("button", { name: "Buscar libro" }).click()
  await expect(page.getByRole("heading", { name: "Revisar libro encontrado" })).toBeVisible()
  await expect(titleField(page)).toHaveValue("El archivo de las mareas")
  expect(await stack.sql`select id from biblib.books where user_id = ${stack.users.a} and isbn = ${BNE_ONLY_ISBN}`, "Encontrar no guarda").toHaveLength(0)
})

test("429, plazo agotado, 5xx y ausencia se distinguen entre sí y ninguno impide el alta manual", async ({ page, stack, data, guard }) => {
  guard.allowConsole(/status of (404|429|5\d\d)/)
  const cases = [
    { isbn: NOT_FOUND_ISBN, status: 404, code: undefined },
    { isbn: RATE_LIMITED_ISBN, status: 429, code: "RATE_LIMITED" },
    { isbn: FAILING_ISBN, status: 503, code: "PROVIDER_UNAVAILABLE" },
    { isbn: TIMEOUT_ISBN, status: 503, code: "PROVIDER_UNAVAILABLE" },
  ]
  for (const { isbn, status, code } of cases) {
    const found = await searchEndpoint(page, isbn)
    expect(found.status, `ISBN ${isbn}`).toBe(status)
    expect(found.body.code).toBe(code)
  }

  // Misma distinción en pantalla: solo la ausencia confirmada dice «no tiene una ficha».
  for (const isbn of [RATE_LIMITED_ISBN, TIMEOUT_ISBN]) {
    await page.goto("/books/add")
    await page.getByLabel("Número ISBN").fill(isbn)
    await page.getByRole("button", { name: "Buscar libro" }).click()
    await expect(alerts(page)).toHaveText("No se pudo consultar Open Library. Puedes volver a intentarlo o añadir el libro manualmente.", { timeout: 15_000 })
    await expect(page.getByLabel("Número ISBN")).toHaveValue(isbn)
  }
  const slug = data.slug("limitado")
  await page.getByRole("button", { name: "Completar ficha manual con este ISBN" }).click()
  await expect(page.getByLabel("ISBN", { exact: true })).toHaveValue(TIMEOUT_ISBN)
  await titleField(page).fill(data.marked(`Manual tras plazo ${slug}`))
  await page.getByRole("button", { name: "Agregar a la biblioteca" }).click()
  await page.waitForURL(/\/book\/[0-9a-f-]{36}$/)
  expect(await stack.sql`select id from biblib.books where user_id = ${stack.users.a} and isbn = ${TIMEOUT_ISBN}`).toHaveLength(1)
})

test("presupuesto global agotado: una sola consulta, aviso de límite y alta manual con el ISBN conservado", async ({ page, stack, data, guard }, testInfo) => {
  guard.allowConsole(/status of 429/)
  const requests: string[] = []
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/books/search") requests.push(request.url()) })
  const { status, body } = await searchEndpoint(page, BUDGET_EXHAUSTED_ISBN)
  expect(status).toBe(429)
  expect(body.code).toBe("RATE_LIMITED")
  expect(body.error).toBe("El catálogo ha limitado las consultas. Vuelve a intentarlo más tarde.")

  await page.goto("/books/add")
  await page.getByLabel("Número ISBN").fill(BUDGET_EXHAUSTED_ISBN)
  await page.getByRole("button", { name: "Buscar libro" }).click()
  await expect(alerts(page)).toHaveText("No se pudo consultar Open Library. Puedes volver a intentarlo o añadir el libro manualmente.")
  // La pantalla no reintenta sola: una tormenta de reintentos agravaría el límite.
  await page.waitForTimeout(2_500)
  expect(requests.filter((url) => url.includes(BUDGET_EXHAUSTED_ISBN)), "Una consulta por pulsación").toHaveLength(1)
  await capture(page, testInfo, "proveedor-presupuesto-agotado")
  await page.getByRole("button", { name: "Completar ficha manual con este ISBN" }).click()
  await expect(page.getByLabel("ISBN", { exact: true })).toHaveValue(BUDGET_EXHAUSTED_ISBN)
  await titleField(page).fill(data.marked(`Manual sin presupuesto ${data.slug("presupuesto")}`))
  await page.getByRole("button", { name: "Agregar a la biblioteca" }).click()
  await page.waitForURL(/\/book\/[0-9a-f-]{36}$/)
  expect(await stack.sql`select id from biblib.books where user_id = ${stack.users.a} and isbn = ${BUDGET_EXHAUSTED_ISBN}`).toHaveLength(1)
})

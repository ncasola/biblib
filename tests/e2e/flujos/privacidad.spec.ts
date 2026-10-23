import { readFile } from "node:fs/promises"
import { accountMenu, capture, expect, test } from "../lib/fixtures"

// Privacidad: con la sesión de B, los datos de A no aparecen en listados, búsqueda, filtros por sus
// IDs, ficha directa, título de la pestaña ni exportación.

test.use({ account: "b" })

test("los datos de A son invisibles para B", async ({ page, stack, guard }, testInfo) => {
  // B abriendo la ficha de A recibe un 404 real (U-FIX-01): es el resultado esperado, no un error.
  guard.allowConsole(/status of 404 \(Not Found\) \[\/book\//)
  const aBook = stack.fixtureBookId("a", "cuaderno")
  const [{ shelf_id: aShelf }] = await stack.sql`select shelf_id from biblib.books where id = ${aBook}`

  await page.goto("/books")
  await expect(accountMenu(page, stack, "b")).toBeVisible()
  await expect(page.getByRole("row").filter({ hasText: "Versos para un faro" })).toBeVisible()
  await capture(page, testInfo, "privacidad-coleccion-b")
  for (const title of ["El cuaderno de la bruma", "Mapas de una ciudad inventada"]) {
    await expect(page.getByText(title)).toHaveCount(0)
  }

  await page.getByLabel("Buscar por título, autor o ISBN").fill("cuaderno de la bruma")
  await expect(page.getByText("No hay libros con estos filtros")).toBeVisible()

  await page.goto(`/books?shelf=${aShelf}`)
  await expect(page.getByText(/^0 resultados$/)).toBeVisible()

  await page.goto(`/book/${aBook}`)
  await expect(page).toHaveTitle("Libro no encontrado · BibLib")
  await expect(page.getByRole("heading", { name: "Libro no encontrado" })).toBeVisible()
  await expect(page.getByText("El cuaderno de la bruma")).toHaveCount(0)

  await page.goto("/settings")
  await expect(page.getByRole("button", { name: "Descargar copia de seguridad" })).toBeEnabled()
  const download = page.waitForEvent("download")
  await page.getByRole("button", { name: "Descargar copia de seguridad" }).click()
  const raw = await readFile(String(await (await download).path()), "utf8")
  expect(raw).not.toContain(aBook)
  expect(raw).not.toContain(stack.users.a)
  expect(raw).not.toContain("El cuaderno de la bruma")
  expect(raw).toContain(stack.fixtureBookId("b", "versos"))
})

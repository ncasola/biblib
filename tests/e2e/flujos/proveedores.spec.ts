import { alerts, expect, test, titleField } from "../lib/fixtures"

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

test("fallo del proveedor: no se confunde con «no encontrado» y conserva el alta manual", async ({ page, stack, data, guard }) => {
  guard.allowConsole(/status of 5\d\d/)
  const slug = data.slug("fallo")
  await page.goto("/books/add")
  await page.getByLabel("Número ISBN").fill(FAILING_ISBN)
  await page.getByRole("button", { name: "Buscar libro" }).click()
  await expect(alerts(page)).toHaveText("No se pudo consultar Open Library. Puedes volver a intentarlo o añadir el libro manualmente.")
  await expect(page.getByLabel("Número ISBN")).toHaveValue(FAILING_ISBN)
  await page.getByRole("button", { name: "Completar ficha manual con este ISBN" }).click()
  await expect(page.getByLabel("ISBN", { exact: true })).toHaveValue(FAILING_ISBN)
  await titleField(page).fill(data.marked(`Manual tras fallo ${slug}`))
  await page.getByRole("button", { name: "Agregar a la biblioteca" }).click()
  await page.waitForURL(/\/book\/[0-9a-f-]{36}$/)
  expect(await stack.sql`select id from biblib.books where user_id = ${stack.users.a} and isbn = ${FAILING_ISBN}`).toHaveLength(1)
})

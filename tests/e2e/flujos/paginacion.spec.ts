import { test, expect } from "../lib/fixtures"

// UX-06: conversión permanente del ensayo qa-05/paginacion.mjs. Sesión GoTrue real,
// datos ficticios exclusivos del run y limpieza por la fixture compartida.
test("paginación: bordes 0, 1, 10 y 11 y filtro desde una página posterior", async ({ page, stack, data }) => {
  const slug = data.slug("bordes")
  const shelf = await data.defaultShelf("a")
  const ids = await data.books("a", shelf, Array.from({ length: 11 }, (_, i) => ({
    title: `${slug} ${String(i + 1).padStart(2, "0")}`,
  })))
  const query = `/books?q=${encodeURIComponent(slug)}`
  const range = (text: string) => page.getByText(text, { exact: true })

  await page.goto(query)
  await expect(range("Mostrando 1 a 10 de 11 libros")).toBeVisible()
  await expect(range("Página 1 de 2")).toBeVisible()
  await page.getByRole("button", { name: "Página siguiente" }).click()
  await expect(range("Mostrando 11 a 11 de 11 libros")).toBeVisible()
  await expect(range("Página 2 de 2")).toBeVisible()

  await page.getByLabel("Buscar por título, autor o ISBN").fill(`${slug} 07`)
  await page.getByLabel("Buscar por título, autor o ISBN").press("Enter")
  await expect(range("Mostrando 1 a 1 de 1 libros")).toBeVisible()
  await expect(range("Página 1 de 1")).toBeVisible()
  await expect.poll(() => new URL(page.url()).searchParams.get("page")).toBeNull()

  await stack.sql`delete from biblib.books where user_id = ${stack.users.a} and id = ${ids[10]}`
  await page.goto(query)
  await expect(range("Mostrando 1 a 10 de 10 libros")).toBeVisible()
  await expect(range("Página 1 de 1")).toBeVisible()
  await expect(page.getByRole("button", { name: "Página siguiente" })).toBeDisabled()
  await page.goto(`${query}&page=2`)
  await expect(range("Mostrando 1 a 10 de 10 libros")).toBeVisible()
  await expect(range("Página 1 de 1")).toBeVisible()
  await expect.poll(() => new URL(page.url()).searchParams.get("page")).toBeNull()

  await stack.sql`delete from biblib.books where user_id = ${stack.users.a} and id in ${stack.sql(ids.slice(1, 10))}`
  await page.goto(query)
  await expect(range("Mostrando 1 a 1 de 1 libros")).toBeVisible()
  await expect(range("Página 1 de 1")).toBeVisible()
  await stack.sql`delete from biblib.books where user_id = ${stack.users.a} and id = ${ids[0]}`
  await page.goto(query)
  await expect(range("No hay libros con estos filtros")).toBeVisible()
  await expect(page.getByRole("button", { name: "Limpiar filtros" }).first()).toBeVisible()
  await expect(range("Mostrando 0 a 0 de 0 libros")).toBeVisible()
  await expect(range("Página 0 de 0")).toBeVisible()
  await expect(page.getByRole("button", { name: "Página anterior" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Página siguiente" })).toBeDisabled()
})

import type { Page } from "@playwright/test"
import { alerts, chooseOption, expect, test } from "../lib/fixtures"

// Organización (A): predeterminada protegida, movimiento individual y en lote, recurso borrado en otra
// pestaña y selección conservada tras un error.

function shelfCard(page: Page, title: string) {
  return page.locator("div.rounded-2xl").filter({ has: page.getByRole("heading", { name: title, exact: true }) })
}

test("la estantería predeterminada no se puede renombrar ni eliminar", async ({ page }) => {
  await page.goto("/shelves")
  await expect(page).toHaveTitle("Estanterías · BibLib")
  const card = shelfCard(page, "Sin estantería")
  await expect(card.getByText("Predeterminada")).toBeVisible()
  await expect(card.getByRole("button", { name: "Renombrar estantería predeterminada, acción deshabilitada" })).toBeDisabled()
  await expect(card.getByRole("button", { name: /Eliminar/ })).toHaveCount(0)
})

test("movimiento individual y cambio de estado desde la ficha", async ({ page, stack, data }) => {
  const slug = data.slug("mover")
  const from = await data.shelf("a", `Origen ${slug}`)
  const to = await data.shelf("a", `Destino ${slug}`)
  const [id] = await data.books("a", from, [{ title: `Movimiento ${slug}` }])

  await page.goto(`/book/${id}`)
  await page.getByLabel("Estantería", { exact: true }).selectOption(to)
  await page.getByRole("button", { name: "Mover libro" }).click()
  await expect(page.getByRole("status")).toHaveText("Ubicación actualizada.")
  await page.getByRole("button", { name: "Leyendo" }).click()
  await expect(page.getByRole("status")).toHaveText("Estado de lectura actualizado.")
  await expect(page.getByRole("button", { name: "Leyendo" })).toHaveAttribute("aria-pressed", "true")
  const [row] = await stack.sql`select shelf_id, status from biblib.books where id = ${id}`
  expect(row).toEqual({ shelf_id: to, status: "reading" })
})

test("movimiento en lote de la página seleccionada", async ({ page, stack, data }) => {
  const slug = data.slug("lote")
  const from = await data.shelf("a", `Origen ${slug}`)
  await data.shelf("a", `Destino ${slug}`)
  const ids = await data.books("a", from, [{ title: `Lote ${slug} uno` }, { title: `Lote ${slug} dos` }, { title: `Lote ${slug} tres` }])
  const [{ id: to }] = await stack.sql`select id from biblib.shelves where user_id = ${stack.users.a} and title = ${data.marked(`Destino ${slug}`)}`

  await page.goto(`/books?q=${encodeURIComponent(slug)}`)
  await expect(page.getByText("3 resultados")).toBeVisible()
  await page.getByLabel("Seleccionar todos los libros de esta página").check()
  await chooseOption(page, "Estantería de destino", data.marked(`Destino ${slug}`))
  await page.getByRole("button", { name: "Mover 3 libros" }).click()
  await expect(page.getByText("Seleccionar esta página(0)")).toBeVisible()
  const rows = await stack.sql`select shelf_id from biblib.books where id in ${stack.sql(ids)}`
  expect(rows.map((row) => row.shelf_id)).toEqual([to, to, to])
})

test("una ficha borrada en otra pestaña muestra el error y no rompe la pantalla", async ({ page, context, stack, data }) => {
  const slug = data.slug("pestana")
  const shelfId = await data.shelf("a", `Pestañas ${slug}`)
  const other = await data.shelf("a", `Otra ${slug}`)
  const [id] = await data.books("a", shelfId, [{ title: `Dos pestañas ${slug}` }])

  await page.goto(`/book/${id}`)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(data.marked(`Dos pestañas ${slug}`))
  const second = await context.newPage()
  await second.goto(`/book/${id}`)
  await second.getByRole("button", { name: "Eliminar libro" }).click()
  await second.getByRole("alertdialog").getByRole("button", { name: "Eliminar libro" }).click()
  await second.waitForURL((url) => url.pathname === "/books")
  await second.close()

  await page.getByLabel("Estantería", { exact: true }).selectOption(other)
  await page.getByRole("button", { name: "Mover libro" }).click()
  await expect(alerts(page)).toBeVisible()
  await page.getByRole("button", { name: "Recargar ficha" }).click()
  await expect(page.getByRole("heading", { name: "Libro no encontrado" })).toBeVisible()
  expect(await stack.sql`select id from biblib.books where id = ${id}`).toHaveLength(0)
})

test("una estantería borrada en otra pestaña: renombrarla avisa sin recrearla", async ({ page, context, stack, data }) => {
  const slug = data.slug("estante")
  await data.shelf("a", `Efímera ${slug}`)
  const title = data.marked(`Efímera ${slug}`)

  await page.goto("/shelves")
  await expect(shelfCard(page, title)).toBeVisible()
  const second = await context.newPage()
  await second.goto("/shelves")
  second.once("dialog", (dialog) => void dialog.accept())
  await shelfCard(second, title).getByRole("button", { name: "Eliminar" }).click()
  await expect(shelfCard(second, title)).toHaveCount(0)
  await second.close()

  await shelfCard(page, title).getByRole("button", { name: "Renombrar" }).click()
  await page.getByLabel("Nuevo nombre de estantería").fill(data.marked(`Renombrada ${slug}`))
  await page.getByRole("button", { name: "Guardar" }).click()
  await expect(page.locator("[role=alert]").filter({ hasText: /./ })).toBeVisible()
  expect(await stack.sql`select id from biblib.shelves where user_id = ${stack.users.a} and title like ${`%${slug}%`}`).toHaveLength(0)
})

test("tras un error al mover en lote se conserva la selección", async ({ page, stack, data }) => {
  const slug = data.slug("seleccion")
  const from = await data.shelf("a", `Origen ${slug}`)
  const doomed = await data.shelf("a", `Destino borrado ${slug}`)
  const ids = await data.books("a", from, [{ title: `Selección ${slug} uno` }, { title: `Selección ${slug} dos` }])

  await page.goto(`/books?q=${encodeURIComponent(slug)}`)
  await expect(page.getByText("2 resultados")).toBeVisible()
  await page.getByLabel(`Seleccionar ${data.marked(`Selección ${slug} uno`)}`).check()
  await page.getByLabel(`Seleccionar ${data.marked(`Selección ${slug} dos`)}`).check()
  await chooseOption(page, "Estantería de destino", data.marked(`Destino borrado ${slug}`))
  // Otra pestaña (aquí, otra sesión de A por SQL) elimina el destino antes de confirmar.
  await stack.sql`delete from biblib.shelves where id = ${doomed}`
  await page.getByRole("button", { name: "Mover 2 libros" }).click()
  await expect(alerts(page)).toBeVisible()
  await expect(page.getByText("Seleccionar esta página(2)")).toBeVisible()
  await expect(page.getByLabel(`Seleccionar ${data.marked(`Selección ${slug} uno`)}`)).toBeChecked()
  const rows = await stack.sql`select shelf_id from biblib.books where id in ${stack.sql(ids)}`
  expect(rows.map((row) => row.shelf_id)).toEqual([from, from])
})

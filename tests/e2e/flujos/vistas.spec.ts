import { expect, test } from "../lib/fixtures"

test("vistas guardadas: guardar, aplicar sin selección, renombrar, sobrescribir y borrar", async ({ page, stack, data }) => {
  const slug = data.slug("vistas")
  const shelf = await data.shelf("a", slug)
  await data.books("a", shelf, [{ title: `${slug} Libro` }])
  const name = data.marked(slug).slice(0, 70)
  const renamed = `${name} nueva`
  try {
    await page.goto(`/books?shelf=${shelf}&view=grid`)
    const panel = page.getByRole("region", { name: "Vistas guardadas" })
    await panel.locator("summary").click()
    await panel.getByLabel("Nombre de la vista", { exact: true }).fill(name)
    await panel.getByRole("button", { name: "Guardar vista actual", exact: true }).click()
    await expect(panel.getByRole("status")).toHaveText("Vista guardada.")
    const row = panel.getByRole("listitem").filter({ hasText: name })
    await page.getByRole("checkbox", { name: "Seleccionar todos los libros de esta página" }).check()
    await row.getByRole("button", { name: "Aplicar", exact: true }).click()
    await expect(page.getByRole("checkbox", { name: "Seleccionar todos los libros de esta página" })).not.toBeChecked()
    await row.getByRole("button", { name: "Renombrar", exact: true }).click()
    await row.getByLabel("Nuevo nombre").fill(renamed)
    await row.getByRole("button", { name: "Guardar nombre" }).click()
    await expect(panel.getByRole("status")).toHaveText("Vista renombrada.")
    await page.getByRole("button", { name: "Vista de tabla", exact: true }).click()
    await row.getByRole("button", { name: "Sobrescribir", exact: true }).click()
    await row.getByRole("button", { name: "Confirmar sobrescritura" }).click()
    await expect(panel.getByRole("status")).toHaveText("Vista sobrescrita.")
    const [saved] = await stack.sql`select filters from biblib.saved_book_views where user_id = ${stack.users.a} and name = ${renamed}`
    expect(saved.filters.view).toBe("table")
    await row.getByRole("button", { name: "Borrar", exact: true }).click()
    await row.getByRole("button", { name: "Confirmar borrado" }).click()
    await expect(panel.getByRole("status")).toHaveText("Vista borrada.")
    await expect(row).toHaveCount(0)
  } finally {
    await stack.sql`delete from biblib.saved_book_views where user_id = ${stack.users.a} and name in ${stack.sql([name, renamed])}`
  }
})

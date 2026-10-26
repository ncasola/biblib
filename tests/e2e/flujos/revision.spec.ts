import { expect, test } from "../lib/fixtures"

// U-DAT-07 · bandeja de revisión: filtrar por motivo, abrir una ficha y volver a la misma selección con el foco en la
// incidencia, comparar con tabla accesible, decidir una incidencia y aplicar un lote tras su vista previa.

test("bandeja de revisión: filtro, vuelta desde la ficha, comparación, decisión individual y lote con vista previa", async ({ page, stack, data }) => {
  const slug = data.slug("revision")
  const shelf = await data.shelf("a", slug)
  const [first, second] = await data.books("a", shelf, [{ title: `${slug} Primero`, authors: ["Autoría E2E"] }, { title: `${slug} Segundo`, authors: ["Otra autoría E2E"] }])
  try {
    await page.goto("/books/review?motivo=missing_isbn")
    await expect(page.getByRole("heading", { level: 1, name: "Revisión bibliográfica" })).toBeVisible()
    const list = page.getByRole("list", { name: "Incidencias de revisión" })
    const item = list.getByRole("listitem").filter({ hasText: `${slug} Primero` })
    await expect(item).toBeVisible()
    await expect(item).toContainText("Sin ISBN")
    await expect(page.getByRole("checkbox", { name: /^Sin ISBN/ })).toBeChecked()

    // Abrir la ficha y volver: misma selección y foco en la incidencia de la que se salió.
    await item.getByRole("link", { name: /^Abrir ficha/ }).click()
    await expect(page).toHaveURL(new RegExp(`/book/${first}`))
    await page.getByRole("link", { name: "Volver a libros" }).click()
    await expect(page).toHaveURL(/\/books\/review\?motivo=missing_isbn$/)
    await expect(list.getByRole("listitem").filter({ hasText: `${slug} Primero` })).toBeFocused()

    // Comparación: tabla con cabeceras de fila y columna, la fuente de cada valor y decisión individual.
    await list.getByRole("listitem").filter({ hasText: `${slug} Primero` }).getByRole("link", { name: /^Revisar y comparar/ }).click()
    await expect(page.getByRole("heading", { level: 1 })).toContainText(`${slug} Primero`)
    const table = page.getByRole("table")
    await expect(table.getByRole("columnheader", { name: /Edición 1/ })).toBeVisible()
    await expect(table.getByRole("rowheader", { name: "Título" })).toBeVisible()
    await expect(table.getByRole("cell").filter({ hasText: "Fuente: Entrada manual" }).first()).toBeVisible()
    await page.getByRole("group", { name: "Ignorar" }).getByRole("button", { name: "Aplicar ahora" }).click()
    await expect(page.getByRole("status").filter({ hasText: "Ignorar: aplicada." })).toBeVisible()
    await expect(page.getByRole("heading", { level: 2, name: "Reabrir" })).toBeVisible()
    await page.getByRole("link", { name: "Volver a la bandeja" }).click()
    await expect(page).toHaveURL(/\/books\/review\?motivo=missing_isbn/)
    await expect(list.getByRole("listitem").filter({ hasText: `${slug} Primero` })).toHaveCount(0)

    // Lote: seleccionar, añadir al lote, preparar la vista previa y confirmar.
    const other = list.getByRole("listitem").filter({ hasText: `${slug} Segundo` })
    await other.getByRole("checkbox", { name: /^Seleccionar: Sin ISBN/ }).check()
    await page.getByRole("button", { name: "Añadir «Ignorar» al lote" }).click()
    await expect(page.getByRole("list", { name: "Decisiones del lote" }).getByRole("listitem")).toHaveCount(1)
    await page.getByRole("button", { name: "Preparar vista previa" }).click()
    await expect(page.getByText(/Altas: 0 · Modificaciones: 1 · Fusiones: 0 · En conflicto: 0/)).toBeVisible()
    await page.getByRole("button", { name: "Confirmar y aplicar 1 decisiones" }).click()
    await expect(page.getByRole("region", { name: "Informe del lote" })).toContainText("Aplicadas 1 de 1")
    const states = await stack.sql`select state from biblib.review_issues where user_id = ${stack.users.a} and reason = 'missing_isbn'
      and dedupe_key in ${stack.sql([`missing_isbn:${first}`, `missing_isbn:${second}`])}`
    expect(states.map((row) => row.state)).toEqual(["ignored", "ignored"])
  } finally {
    // Las incidencias y decisiones de estas fichas desaparecen con ellas; las fichas las retira la limpieza del fixture.
    await stack.sql`delete from biblib.review_issues where user_id = ${stack.users.a} and (dedupe_key like ${`%:${first}`} or dedupe_key like ${`%:${second}`})`
  }
})

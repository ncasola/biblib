import type { Page } from "@playwright/test"
import { alerts, capture, expect, test } from "../lib/fixtures"

// Series y orden de volúmenes (A) · U-PRO-05: crear una serie, vincular ediciones desde la ficha con posición decimal,
// ver el orden 1, 1.5, 2 con el orden desconocido al final, mover y quitar volúmenes, borrar la serie sin borrar libros y
// filtrar el catálogo por serie. Las series que crea el recorrido llevan la marca del run y se retiran al terminar.

test.afterEach(async ({ stack, data }) => {
  await stack.sql`delete from biblib.series where user_id in ${stack.sql([stack.users.a, stack.users.b])} and title like ${`${data.marked("")}%`}`
})

function seriesSection(page: Page) {
  return page.locator("section[aria-labelledby=edition-series-title]")
}

function volumes(page: Page) {
  return page.getByRole("list", { name: "Volúmenes de la serie" }).getByRole("listitem")
}

async function addToSeries(page: Page, bookId: string, seriesTitle: string, position: string) {
  await page.goto(`/book/${bookId}`)
  const section = seriesSection(page)
  await expect(section.getByText("Esta edición no pertenece a ninguna serie")).toBeVisible()
  await section.getByRole("button", { name: "Añadir a una serie" }).click()
  await section.getByLabel("Serie", { exact: true }).selectOption({ label: seriesTitle })
  if (position) await section.getByLabel("Posición (opcional)").fill(position)
  await section.getByRole("button", { name: "Añadir a la serie" }).click()
  await expect(section.getByText("Edición añadida a la serie.")).toBeVisible()
}

test("crear una serie, vincular ediciones y ver el orden 1, 1.5, 2 con el orden desconocido al final", async ({ page, stack, data }, testInfo) => {
  const slug = data.slug("serie")
  const shelfId = await data.shelf("a", `Series ${slug}`)
  const titles = [`Dos ${slug}`, `Uno ${slug}`, `Uno y medio ${slug}`, `Sin orden ${slug}`]
  const [two, one, oneAndHalf, unknown] = await data.books("a", shelfId, titles.map((title) => ({ title })))
  const seriesTitle = data.marked(`Crónica ${slug}`)

  await page.goto("/series")
  await expect(page).toHaveTitle("Series · BibLib")
  await page.getByRole("button", { name: "Nueva serie" }).click()
  await page.getByLabel("Título de la serie").fill(seriesTitle)
  await page.getByLabel("Descripción (opcional)").fill("Una serie incompleta: faltan volúmenes.")
  await page.getByRole("button", { name: "Crear serie" }).click()
  await expect(page.getByRole("status").filter({ hasText: "creada" })).toBeVisible()
  const [{ id: seriesId }] = await stack.sql`select id from biblib.series where user_id = ${stack.users.a} and title = ${seriesTitle}`

  await addToSeries(page, two, seriesTitle, "2")
  await addToSeries(page, one, seriesTitle, "1")
  // La coma decimal se admite y la posición se guarda exacta, como «1.5».
  await addToSeries(page, oneAndHalf, seriesTitle, "1,50")
  await addToSeries(page, unknown, seriesTitle, "")
  const stored = await stack.sql`select trim_scale(position)::text as position from biblib.series_editions where series_id = ${seriesId} order by position nulls last`
  expect(stored.map((row) => row.position)).toEqual(["1", "1.5", "2", null])

  await page.goto(`/series/${seriesId}`)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(seriesTitle)
  await expect(page.getByText("4 volúmenes. Una serie puede estar incompleta.")).toBeVisible()
  await expect(volumes(page)).toHaveText([
    new RegExp(`Posición 1(?![.\\d]).*Uno ${slug}`, "s"), new RegExp(`Posición 1\\.5.*Uno y medio ${slug}`, "s"),
    new RegExp(`Posición 2.*Dos ${slug}`, "s"), new RegExp(`Orden desconocido.*Sin orden ${slug}`, "s"),
  ])
  await capture(page, testInfo, "serie-orden")

  // Mover: el volumen de orden desconocido pasa a la posición 3 y sigue al final; quitar: la edición no se borra.
  await page.getByRole("button", { name: `Mover o cambiar el volumen «${data.marked(titles[3])}»` }).click()
  await page.getByLabel("Posición (opcional)").fill("1.25")
  await page.getByLabel("Etiqueta del volumen (opcional)").fill("Extra")
  await page.getByRole("button", { name: "Guardar volumen" }).click()
  await expect(page.getByRole("status")).toHaveText("Volumen actualizado.")
  await expect(volumes(page).nth(1)).toContainText(`Posición 1.25 · Extra`)
  await expect(volumes(page).nth(1)).toContainText(titles[3])
  await page.getByRole("button", { name: `Quitar «${data.marked(titles[1])}» de la serie` }).click()
  await expect(page.getByRole("status")).toContainText("El libro se conserva.")
  await expect(volumes(page)).toHaveCount(3)
  expect((await stack.sql`select count(*)::int as n from biblib.books where id = ${one}`)[0].n).toBe(1)
  expect((await stack.sql`select count(*)::int as n from biblib.series_editions where series_id = ${seriesId}`)[0].n).toBe(3)
})

test("una ficha sin serie no cambia y quitar la serie desde la ficha conserva el libro", async ({ page, stack, data }) => {
  const slug = data.slug("sinserie")
  const shelfId = await data.shelf("a", `Sin serie ${slug}`)
  const [bookId] = await data.books("a", shelfId, [{ title: `Suelto ${slug}` }])
  const [{ edition_id: editionId }] = await stack.sql`select edition_id from biblib.copies where id = ${bookId}`
  const seriesTitle = data.marked(`Existente ${slug}`)
  const [{ id: seriesId }] = await stack.sql`insert into biblib.series (user_id, title) values (${stack.users.a}, ${seriesTitle}) returning id`

  await page.goto(`/book/${bookId}`)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(data.marked(`Suelto ${slug}`))
  await expect(seriesSection(page).getByText("Esta edición no pertenece a ninguna serie")).toBeVisible()
  expect((await stack.sql`select count(*)::int as n from biblib.series_editions where edition_id = ${editionId}`)[0].n).toBe(0)

  // Una posición no válida se explica antes de enviar y no cambia nada.
  await seriesSection(page).getByRole("button", { name: "Añadir a una serie" }).click()
  await seriesSection(page).getByLabel("Serie", { exact: true }).selectOption({ label: seriesTitle })
  await seriesSection(page).getByLabel("Posición (opcional)").fill("01.50")
  await seriesSection(page).getByRole("button", { name: "Añadir a la serie" }).click()
  await expect(alerts(page)).toContainText("Usa un número sin ceros a la izquierda")
  expect((await stack.sql`select count(*)::int as n from biblib.series_editions where edition_id = ${editionId}`)[0].n).toBe(0)
  await seriesSection(page).getByLabel("Posición (opcional)").fill("1")
  await seriesSection(page).getByRole("button", { name: "Añadir a la serie" }).click()
  await expect(seriesSection(page).getByRole("link", { name: seriesTitle })).toHaveAttribute("href", `/series/${seriesId}`)

  await seriesSection(page).getByRole("button", { name: "Quitar de la serie" }).click()
  await expect(seriesSection(page).getByText("Edición quitada de la serie.")).toBeVisible()
  expect((await stack.sql`select count(*)::int as n from biblib.series_editions where edition_id = ${editionId}`)[0].n).toBe(0)
  expect((await stack.sql`select count(*)::int as n from biblib.books where id = ${bookId}`)[0].n).toBe(1)
})

test("borrar una serie retira sus vínculos pero no borra los libros", async ({ page, stack, data }) => {
  const slug = data.slug("borrarserie")
  const shelfId = await data.shelf("a", `Borrar serie ${slug}`)
  const ids = await data.books("a", shelfId, [{ title: `Primero ${slug}` }, { title: `Segundo ${slug}` }])
  const seriesTitle = data.marked(`Para borrar ${slug}`)
  const [{ id: seriesId }] = await stack.sql`insert into biblib.series (user_id, title) values (${stack.users.a}, ${seriesTitle}) returning id`
  for (const [index, id] of ids.entries()) {
    await stack.sql`insert into biblib.series_editions (user_id, edition_id, series_id, position) select ${stack.users.a}, edition_id, ${seriesId}, ${index + 1} from biblib.copies where id = ${id}`
  }

  await page.goto(`/series/${seriesId}`)
  await page.getByRole("button", { name: "Borrar serie" }).click()
  await expect(page.getByRole("alertdialog")).toContainText("Tus libros y ediciones se conservan.")
  await page.getByRole("alertdialog").getByRole("button", { name: "Borrar serie" }).click()
  await page.waitForURL(/\/series$/)
  await expect(page.getByText(seriesTitle)).toHaveCount(0)
  expect((await stack.sql`select count(*)::int as n from biblib.series where id = ${seriesId}`)[0].n).toBe(0)
  expect((await stack.sql`select count(*)::int as n from biblib.series_editions where series_id = ${seriesId}`)[0].n).toBe(0)
  expect((await stack.sql`select count(*)::int as n from biblib.books where id in ${stack.sql(ids)}`)[0].n).toBe(2)
  await page.goto(`/series/${seriesId}`)
  await expect(page.getByRole("heading", { name: "Serie no encontrada" })).toBeVisible()
})

test("la búsqueda avanzada filtra por serie y la URL conserva el filtro", async ({ page, stack, data }) => {
  const slug = data.slug("filtro")
  const shelfId = await data.shelf("a", `Filtro ${slug}`)
  const [inSeries] = await data.books("a", shelfId, [{ title: `En la serie ${slug}` }, { title: `Fuera de la serie ${slug}` }])
  const seriesTitle = data.marked(`Filtrada ${slug}`)
  const [{ id: seriesId }] = await stack.sql`insert into biblib.series (user_id, title) values (${stack.users.a}, ${seriesTitle}) returning id`
  await stack.sql`insert into biblib.series_editions (user_id, edition_id, series_id, position) select ${stack.users.a}, edition_id, ${seriesId}, 1 from biblib.copies where id = ${inSeries}`

  await page.goto(`/books/search?q=${encodeURIComponent(slug)}`)
  await expect(page.getByText("2 resultados")).toBeVisible()
  await page.getByRole("combobox", { name: "Filtrar por serie" }).click()
  await page.getByRole("option", { name: seriesTitle, exact: true }).click()
  await expect(page.getByText("1 resultado", { exact: true })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`series=${seriesId}`))
  await expect(page.getByText(`En la serie ${slug}`)).toBeVisible()
  await expect(page.getByText(`Fuera de la serie ${slug}`)).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole("combobox", { name: "Filtrar por serie" })).toContainText(seriesTitle)
  await expect(page.getByText("1 resultado", { exact: true })).toBeVisible()
})

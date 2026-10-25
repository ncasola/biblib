import { actionRequest, alerts, capture, expect, test, titleField } from "../lib/fixtures"

// Catálogo (A): alta manual sin éxito antes de persistir y con borrador conservado ante un fallo de
// red, ISBN equivalente ya catalogado, edición completa, conflicto de versión y eliminación confirmada.

async function countByTitle(sql: import("postgres").Sql, userId: string, title: string): Promise<number> {
  const [{ count }] = await sql`select count(*)::int as count from biblib.books where user_id = ${userId} and title = ${title}`
  return Number(count)
}

test("alta manual: un fallo de red conserva el borrador y no hay éxito antes de persistir", async ({ page, stack, data, guard }) => {
  const slug = data.slug("alta")
  const shelfId = await data.shelf("a", `Catálogo ${slug}`)
  const title = data.marked(`Alta manual ${slug}`)
  // Desde U-DAT-06 el alta manual crea edición y ejemplar con createEditionAction.
  const isAdd = actionRequest(stack, "createEditionAction")

  await page.goto("/books/add")
  await expect(page).toHaveTitle("Agregar libro · BibLib")
  await page.getByRole("tab", { name: "Entrada manual" }).click()
  await titleField(page).fill(title)
  await page.getByLabel("Autor 1", { exact: true }).fill("Autora, Nombre")
  await page.getByLabel("Editorial 1", { exact: true }).fill("Editorial de prueba")
  await page.getByLabel("Número de páginas").fill("223")
  await page.getByLabel("Estantería", { exact: true }).selectOption(shelfId)

  // 1) La petición de alta se corta: el formulario conserva lo escrito y la base no cambia.
  guard.allowConsole(/Failed to fetch|NetworkError|Load failed|ERR_FAILED|net::/i)
  let cut = true
  await page.route("**/books/add", (route) => cut && isAdd(route.request()) ? route.abort("failed") : route.fallback())
  await page.getByRole("button", { name: "Agregar a la biblioteca" }).click()
  await expect(alerts(page)).toHaveText("No se pudo guardar el libro. Comprueba la conexión y vuelve a intentarlo.")
  await expect(titleField(page)).toHaveValue(title)
  await expect(page.getByLabel("Autor 1", { exact: true })).toHaveValue("Autora, Nombre")
  expect(await countByTitle(stack.sql, stack.users.a, title)).toBe(0)
  cut = false
  await page.unrouteAll({ behavior: "wait" })

  // 2) El servidor ya guardó, pero la respuesta se retiene: la pantalla no anuncia éxito hasta recibirla.
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/books/add", async (route) => {
    if (!isAdd(route.request())) return route.fallback()
    const response = await route.fetch()
    await gate
    await route.fulfill({ response })
  })
  await page.getByRole("button", { name: "Agregar a la biblioteca" }).click()
  await expect(page.getByRole("button", { name: "Guardando..." })).toBeVisible()
  await expect.poll(() => countByTitle(stack.sql, stack.users.a, title)).toBe(1)
  await expect(page).toHaveURL(/\/books\/add$/)
  release()
  await page.waitForURL(/\/book\/[0-9a-f-]{36}$/)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title)
  await expect(page).toHaveTitle(`${title} · BibLib`)
  const [row] = await stack.sql`select shelf_id, number_of_pages, authors->0->>'name' as author from biblib.books where user_id = ${stack.users.a} and title = ${title}`
  expect(row).toEqual({ shelf_id: shelfId, number_of_pages: 223, author: "Autora, Nombre" })
})

test("un ISBN-10 con guiones equivalente detecta la ficha ya catalogada", async ({ page, stack }) => {
  await page.goto("/books/add")
  await page.getByLabel("Número ISBN").fill("0-00-000001-9")
  await page.getByRole("button", { name: "Buscar libro" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Esta edición ya está en tu biblioteca" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Abrir el ejemplar guardado" })).toHaveAttribute("href", `/book/${stack.fixtureBookId("a", "isla")}`)
})

test("edición: el conflicto de versión conserva el borrador y la recarga es explícita", async ({ page, stack, data }, testInfo) => {
  const slug = data.slug("edicion")
  const shelfId = await data.shelf("a", `Origen ${slug}`)
  const otherShelf = await data.shelf("a", `Destino ${slug}`)
  const [id] = await data.books("a", shelfId, [{ title: `Edición ${slug}`, authors: ["Autora inicial"], pages: 100 }])
  const [{ title: original }] = await stack.sql`select title from biblib.books where id = ${id}`

  await page.goto(`/book/${id}`)
  await page.getByRole("button", { name: "Editar ficha" }).click()
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Editar ficha")
  const draft = data.marked(`Borrador conservado ${slug}`)
  await titleField(page).fill(draft)
  // Otra sesión cambia la ficha mientras se edita (rota su versión por el trigger).
  await stack.sql`update biblib.books set subtitle = 'Actualizado desde otra sesión' where id = ${id}`
  await page.getByRole("button", { name: "Guardar cambios" }).click()
  await expect(page.getByRole("button", { name: "Descartar formulario y cargar versión actual" })).toBeVisible()
  await expect(alerts(page)).toBeVisible()
  await expect(titleField(page)).toHaveValue(draft)
  expect((await stack.sql`select title from biblib.books where id = ${id}`)[0].title, "El conflicto no sobrescribe").toBe(original)
  await capture(page, testInfo, "conflicto-version")

  await page.getByRole("button", { name: "Descartar formulario y cargar versión actual" }).click()
  await expect(page.getByLabel("Subtítulo")).toHaveValue("Actualizado desde otra sesión")
  await expect(titleField(page)).toHaveValue(String(original))

  const edited = data.marked(`Ficha editada ${slug}`)
  await titleField(page).fill(edited)
  await page.getByLabel("Número de páginas").fill("321")
  await page.getByLabel("ISBN", { exact: true }).fill("978-0-13-110362-7")
  await page.getByLabel("He comprobado que el ISBN corresponde a mi edición").check()
  await page.getByLabel("Estantería", { exact: true }).selectOption(otherShelf)
  await page.getByRole("button", { name: "Guardar cambios" }).click()
  await expect(page.getByRole("status")).toHaveText("Ficha actualizada correctamente.")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(edited)
  const [row] = await stack.sql`select number_of_pages, shelf_id, isbn, catalogue->>'isbnVerified' as verified from biblib.books where id = ${id}`
  expect(row).toEqual({ number_of_pages: 321, shelf_id: otherShelf, isbn: "9780131103627", verified: "true" })
})

test("eliminar exige confirmación y no afecta a otras fichas", async ({ page, stack, data }) => {
  const slug = data.slug("borrar")
  const shelfId = await data.shelf("a", `Borrado ${slug}`)
  const [target, kept] = await data.books("a", shelfId, [{ title: `Se elimina ${slug}` }, { title: `Se conserva ${slug}` }])
  const before = Number((await stack.sql`select count(*)::int as count from biblib.books where user_id = ${stack.users.a}`)[0].count)

  await page.goto(`/book/${target}`)
  await page.getByRole("button", { name: "Eliminar libro" }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog).toBeVisible()
  expect(Number((await stack.sql`select count(*)::int as count from biblib.books where user_id = ${stack.users.a}`)[0].count), "Abrir la confirmación no borra").toBe(before)
  await dialog.getByRole("button", { name: "Eliminar libro" }).click()
  await page.waitForURL((url) => url.pathname === "/books")
  expect(await stack.sql`select id from biblib.books where id = ${target}`).toHaveLength(0)
  expect(await stack.sql`select id from biblib.books where id = ${kept}`).toHaveLength(1)
})

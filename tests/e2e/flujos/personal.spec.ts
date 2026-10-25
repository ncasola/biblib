import { alerts, expect, test, titleField } from "../lib/fixtures"

test("personal: alta opcional, estrellas por teclado y siguiente alta vacía", async ({ page, stack, data }) => {
  const slug = data.slug("personal"), title = data.marked(`Notas ${slug}`), tag = `Ficción ${slug}`
  try {
    await page.goto("/books/add")
    await page.getByRole("tab", { name: "Entrada manual" }).click()
    await titleField(page).fill(title)
    await page.getByLabel("Notas privadas").fill("Quiero recordar este libro 📚")
    const rating = page.getByRole("radio", { name: "3 de 5 estrellas" })
    await rating.focus(); await rating.press("Space"); await rating.press("ArrowRight")
    await expect(page.getByRole("radio", { name: "4 de 5 estrellas" })).toBeChecked()
    await page.getByLabel("Nueva etiqueta", { exact: true }).fill(tag)
    await page.getByRole("button", { name: "Añadir etiqueta al ejemplar" }).click()
    await page.getByRole("button", { name: "Guardar y añadir otro" }).click()
    await expect(page.getByRole("status").filter({ hasText: title })).toBeVisible()
    await expect(page.getByLabel("Notas privadas")).toHaveValue("")
    await expect(page.getByRole("radio", { name: "Sin valoración", exact: true })).toBeChecked()
    const [row] = await stack.sql`select c.id, a.notes, a.rating from biblib.copies c join biblib.editions e on e.id = c.edition_id join biblib.copy_annotations a on a.copy_id = c.id where c.user_id = ${stack.users.a} and e.title = ${title}`
    expect(row).toMatchObject({ notes: "Quiero recordar este libro 📚", rating: 4 })
    await page.goto(`/book/${row.id}`)
    await expect(page.getByRole("region", { name: "Datos personales", exact: true })).toContainText("Valoración: 4 de 5")
    await expect(page.getByRole("region", { name: "Datos personales", exact: true })).toContainText(tag)
  } finally { await stack.sql`delete from biblib.tags where user_id = ${stack.users.a} and name = ${tag}` }
})

test("personal: conflicto conserva borrador y exige recarga explícita", async ({ page, stack, data }) => {
  const slug = data.slug("conflictonotas"), shelf = await data.shelf("a", slug)
  const [id] = await data.books("a", shelf, [{ title: slug }])
  await page.goto(`/book/${id}`)
  await page.getByRole("button", { name: "Editar datos personales" }).click()
  await page.getByLabel("Notas privadas").fill("Mi borrador")
  await stack.sql`insert into biblib.copy_annotations (user_id, copy_id, notes) values (${stack.users.a}, ${id}, 'Cambio en otra sesión')`
  await page.getByRole("button", { name: "Guardar datos personales" }).click()
  await expect(alerts(page)).toContainText("han cambiado")
  await expect(page.getByLabel("Notas privadas")).toHaveValue("Mi borrador")
  await expect(page.getByRole("button", { name: "Guardar datos personales" })).toBeDisabled()
  await page.getByRole("button", { name: "Descartar borrador y cargar datos personales actuales" }).click()
  await expect(page.getByLabel("Notas privadas")).toHaveValue("Cambio en otra sesión")
  await page.getByLabel("Notas privadas").fill("Versión revisada")
  await page.getByRole("button", { name: "Guardar datos personales" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Datos personales guardados" })).toBeVisible()
  expect((await stack.sql`select notes from biblib.copy_annotations where user_id = ${stack.users.a} and copy_id = ${id}`)[0].notes).toBe("Versión revisada")
})

test("personal: OR/AND funciona en colección y búsqueda avanzada y sobrevive a recarga", async ({ page, stack, data }) => {
  const slug = data.slug("filtroetiquetas"), shelf = await data.shelf("a", slug)
  const ids = await data.books("a", shelf, [{ title: `Rojo ${slug}` }, { title: `Azul ${slug}` }, { title: `Ambas ${slug}` }])
  const tags = await stack.sql`insert into biblib.tags (user_id, name) values (${stack.users.a}, ${`Rojo ${slug}`}), (${stack.users.a}, ${`Azul ${slug}`}) returning id, name`
  try {
    await stack.sql`insert into biblib.copy_tags (user_id, copy_id, tag_id) values (${stack.users.a}, ${ids[0]}, ${tags[0].id}), (${stack.users.a}, ${ids[1]}, ${tags[1].id}), (${stack.users.a}, ${ids[2]}, ${tags[0].id}), (${stack.users.a}, ${ids[2]}, ${tags[1].id})`
    for (const route of ["/books", "/books/search"]) {
      await page.goto(`${route}?shelf=${shelf}`)
      const filters = page.locator("#book-tag-filters")
      // En móvil el mismo panel se abre desde Filtros.
      if (!await filters.isVisible()) await page.getByRole("button", { name: /Filtros/ }).click()
      await filters.getByRole("checkbox", { name: String(tags[0].name), exact: true }).check()
      await filters.getByRole("checkbox", { name: String(tags[1].name), exact: true }).check()
      await expect(page.getByText("3 resultados", { exact: true })).toBeVisible()
      await page.getByLabel("Coincidencia de etiquetas", { exact: true }).selectOption("and")
      await expect(page.getByText("1 resultado", { exact: true })).toBeVisible()
      await expect(page).toHaveURL(/tagMode=and/)
      await page.reload()
      await expect(page.getByText("1 resultado", { exact: true })).toBeVisible()
      expect(new URL(page.url()).searchParams.getAll("tag")).toHaveLength(2)
    }
  } finally { await stack.sql`delete from biblib.tags where user_id = ${stack.users.a} and id in ${stack.sql(tags.map((tag) => tag.id))}` }
})

test("personal: renombrar y borrar etiqueta conserva el libro", async ({ page, stack, data }) => {
  const slug = data.slug("gestiontags"), shelf = await data.shelf("a", slug)
  const [id] = await data.books("a", shelf, [{ title: slug }])
  const name = `Inicial ${slug}`, renamed = `Nueva ${slug}`
  const [tag] = await stack.sql`insert into biblib.tags (user_id, name) values (${stack.users.a}, ${name}) returning id`
  try {
    await stack.sql`insert into biblib.copy_tags (user_id, copy_id, tag_id) values (${stack.users.a}, ${id}, ${tag.id})`
    await page.goto(`/book/${id}`)
    await page.getByText("Gestionar etiquetas de la biblioteca", { exact: true }).click()
    await page.getByLabel(`Nombre de etiqueta ${name}`, { exact: true }).fill(renamed)
    await page.getByRole("button", { name: `Renombrar etiqueta ${name}`, exact: true }).click()
    await expect(page.getByRole("button", { name: `Eliminar etiqueta ${renamed}`, exact: true })).toBeVisible()
    await page.getByRole("button", { name: `Eliminar etiqueta ${renamed}`, exact: true }).click()
    await expect(page.getByText("Etiquetas: Sin etiquetas", { exact: true })).toBeVisible()
    expect(await stack.sql`select id from biblib.copies where user_id = ${stack.users.a} and id = ${id}`).toHaveLength(1)
  } finally { await stack.sql`delete from biblib.tags where user_id = ${stack.users.a} and id = ${tag.id}` }
})

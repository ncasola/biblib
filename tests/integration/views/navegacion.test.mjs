import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, expect } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { viewsContext } from "./lib/context.mjs"

let ctx, browser, page, session
before(async () => {
  ctx = await viewsContext()
  session = await ctx.signIn("a")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const context = await browser.newContext()
  await context.addCookies(session.cookies().filter((cookie) => cookie.value).map(({ name, value }) => ({ name, value, url: ctx.app.url })))
  await context.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort())
  page = await context.newPage()
})
after(async () => { await browser?.close(); if (ctx) { await ctx.cleanup(); await ctx.close() } })

async function panel() {
  const section = page.getByRole("region", { name: "Vistas guardadas" })
  if (!await section.locator("details").getAttribute("open").then((value) => value !== null)) await section.locator("summary").click()
  await expect(section.getByRole("button", { name: "Guardar vista actual" })).toBeVisible()
  return section
}

test("Chrome real: URL, recarga, atrás/adelante, selección, errores de red y estantería borrada", async () => {
  const name = ctx.name("Navegación")
  const [shelf] = await ctx.asUser(ctx.users.a, (tx) => tx`insert into biblib.shelves (user_id,title) values (${ctx.users.a}, ${ctx.name("Estantería")}) returning id`)
  await ctx.asUser(ctx.users.a, async (tx) => {
    for (let index = 0; index < 12; index++) await tx`insert into biblib.books (user_id,isbn,title,shelf_id) values (${ctx.users.a}, ${`manual-exp02-${ctx.prefix}-${index}`}, ${`${ctx.prefix} Libro ${index}`}, ${shelf.id})`
  })
  await page.goto(`${ctx.app.url}/books?shelf=${shelf.id}&sort=-title&page=2`)
  await expect(page.getByText("Página 2 de 2")).toBeVisible()
  const p = await panel()
  await expect(p.getByText(/Aún no tienes vistas guardadas|Actualizar vistas/).first()).toBeVisible()
  await p.getByLabel("Nombre de la vista", { exact: true }).fill(name)
  await p.getByRole("button", { name: "Guardar vista actual", exact: true }).click()
  await expect(p.getByRole("status")).toHaveText("Vista guardada.")
  const row = p.getByRole("listitem").filter({ hasText: name })
  await page.getByRole("checkbox", { name: "Seleccionar todos los libros de esta página" }).check()
  await row.getByRole("button", { name: "Aplicar", exact: true }).click()
  await expect(page.getByText("Página 1 de 2")).toBeVisible()
  await expect(page.getByRole("checkbox", { name: "Seleccionar todos los libros de esta página" })).not.toBeChecked()
  await page.goBack()
  await expect(page.getByText("Página 2 de 2")).toBeVisible()
  await page.goForward()
  await expect(page.getByText("Página 1 de 2")).toBeVisible()
  await page.reload()
  await expect(page.getByText("Página 1 de 2")).toBeVisible()
  await panel()
  await expect(row.getByRole("button", { name: "Aplicar", exact: true })).toBeVisible()

  // Interrumpir guardado conserva URL/filtros y no añade una vista optimista.
  const urlBefore = page.url()
  await p.getByLabel("Nombre de la vista", { exact: true }).fill(ctx.name("Red"))
  const saveId = ctx.app.actions.get("saveCurrentViewAction").id
  const rejectSave = (route) => route.request().headers()["next-action"] === saveId ? route.abort("failed") : route.fallback()
  await page.route("**/*", rejectSave)
  await p.getByRole("button", { name: "Guardar vista actual", exact: true }).click()
  await expect(p.getByRole("alert")).toHaveText("No se pudo completar la operación. Tus filtros se conservan.")
  assert.equal(page.url(), urlBefore)
  assert.equal((await ctx.sql`select count(*)::int n from biblib.saved_book_views where user_id = ${ctx.users.a} and name like ${`${ctx.prefix}%`}`)[0].n, 1)
  await page.unroute("**/*", rejectSave)

  // Un error al mover no borra la selección temporal.
  await page.getByRole("checkbox", { name: "Seleccionar todos los libros de esta página" }).check()
  await page.getByRole("combobox", { name: "Estantería de destino" }).click()
  const [{ id: defaultId, title: defaultTitle }] = await ctx.sql`select id,title from biblib.shelves where user_id = ${ctx.users.a} and is_default`
  assert.notEqual(defaultId, shelf.id)
  await page.getByRole("option", { name: defaultTitle, exact: true }).click()
  const moveId = ctx.app.actions.get("moveBooksShelfAction").id
  const rejectMove = (route) => route.request().headers()["next-action"] === moveId ? route.abort("failed") : route.fallback()
  await page.route("**/*", rejectMove)
  await page.getByRole("button", { name: "Mover 10 libros", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: "Seleccionar todos los libros de esta página" })).toBeChecked()
  await expect(page.getByRole("button", { name: "Mover 10 libros", exact: true })).toBeEnabled()
  await expect(page.getByText("No se pudieron mover los libros seleccionados. Inténtalo de nuevo.")).toBeVisible()
  await page.unroute("**/*", rejectMove)
  await page.getByRole("button", { name: "Página siguiente" }).click()
  await expect(page.getByText("Página 2 de 2")).toBeVisible()
  await expect(page.getByRole("checkbox", { name: "Seleccionar todos los libros de esta página" })).not.toBeChecked()

  // Borrar la estantería mediante la acción real no borra ni invalida la vista.
  const deletion = await ctx.call("deleteShelfAction", [shelf.id], session)
  assert.equal(deletion.value?.ok, true)
  await row.getByRole("button", { name: "Aplicar", exact: true }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get("shelf")).toBeNull()
  await expect.poll(() => new URL(page.url()).searchParams.get("page")).toBeNull()
  await expect(page.getByRole("combobox", { name: "Filtrar por estantería" })).toHaveText("Todas las estanterías")
  const [{ filters }] = await ctx.sql`select filters from biblib.saved_book_views where user_id = ${ctx.users.a} and name = ${name}`
  assert.equal(filters.shelf, shelf.id)

  // Borrado confirmado: mientras el POST está retenido, la fila permanece en pantalla.
  await row.getByRole("button", { name: "Borrar", exact: true }).click()
  const deleteId = ctx.app.actions.get("deleteSavedViewAction").id
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const delayDelete = async (route) => { if (route.request().headers()["next-action"] === deleteId) await gate; await route.fallback() }
  await page.route("**/*", delayDelete)
  try {
    await row.getByRole("button", { name: "Confirmar borrado" }).click()
    await expect(p.getByRole("status")).toHaveText("Procesando vista…")
    await expect(row).toBeVisible()
  } finally { release() }
  await expect(p.getByRole("status")).toHaveText("Vista borrada.")
  await expect(row).toHaveCount(0)
  await page.unroute("**/*", delayDelete)

  // Valores malformados se canonizan en URL y controles sin convertirlos en fallo de listado.
  await page.goto(`${ctx.app.url}/books?status=roto&shelf=sql&page=1x&pageSize=48x&view=roto&sort=sql`)
  await expect(page.getByText(/^Página 1 de \d+$/)).toBeVisible()
  await expect.poll(() => new URL(page.url()).search).toBe("")
  mkdirSync(".biblib/integration", { recursive: true })
  await panel()
  await page.screenshot({ path: ".biblib/integration/views-claro.png", fullPage: true })
  await page.emulateMedia({ colorScheme: "dark" })
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  await page.screenshot({ path: ".biblib/integration/views-oscuro.png", fullPage: true })
})

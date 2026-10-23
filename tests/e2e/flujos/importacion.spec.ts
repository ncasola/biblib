import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { Page } from "@playwright/test"
import { forgetSnapshot, recordSnapshot, restoreLibrary, snapshotLibrary } from "../lib/e2e-manifest.mjs"
import { actionRequest, alerts, type Data, expect, type Stack, test } from "../lib/fixtures"

// Importación (U-DAT-01) en Ajustes como A: exportación, revisión sin escrituras, colección cambiada en
// otra pestaña → conflicto sin borrar y con el archivo conservado, fusión, confirmación repetida tras
// perder la respuesta y reemplazo real (con instantánea y restauración de la biblioteca ficticia de A).

const DEFAULT_COVER = { small: "/default-book-cover.webp", medium: "/default-book-cover.webp", large: "/default-book-cover.webp" }

function libraryFile(data: Data, slug: string, count: number) {
  const shelfId = `e2e-${slug}`
  const shelfTitle = data.marked(`${slug} Importadas`)
  const books = Array.from({ length: count }, (_, index) => {
    const id = randomUUID()
    return { id, isbn: `manual-${id}`, title: data.marked(`${slug} importado ${index + 1}`), authors: [], number_of_pages: 0, publish_date: "", cover: DEFAULT_COVER, status: "unread", shelf_id: shelfId, shelf_name: shelfTitle }
  })
  return { name: `${slug}.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ shelves: [{ id: shelfId, title: shelfTitle, book_count: count }], books })) }
}

async function libraryCount(stack: Stack): Promise<number> {
  return Number((await stack.sql`select count(*)::int as count from biblib.books where user_id = ${stack.users.a}`)[0].count)
}

async function revision(stack: Stack): Promise<string> {
  return String((await stack.sql`select revision from biblib.library_state where user_id = ${stack.users.a}`)[0].revision)
}

async function fixtureBooksPresent(stack: Stack): Promise<number> {
  const ids = ["cuaderno", "isla", "reloj", "mapas"].map((key) => stack.fixtureBookId("a", key))
  return (await stack.sql`select id from biblib.books where id in ${stack.sql(ids)} and user_id = ${stack.users.a}`).length
}

async function openSettings(page: Page) {
  await page.goto("/settings")
  await expect(page).toHaveTitle("Ajustes · BibLib")
  await expect(page.getByRole("button", { name: "Seleccionar archivo JSON" })).toBeEnabled()
}

function planValue(page: Page, label: string) {
  return page.locator("dl > div").filter({ has: page.locator("dt", { hasText: label }) }).locator("dd")
}

test.describe.configure({ mode: "serial" })

test("la exportación descarga un JSON v1 con la colección actual de A", async ({ page, stack }) => {
  await openSettings(page)
  const download = page.waitForEvent("download")
  await page.getByRole("button", { name: "Descargar copia de seguridad" }).click()
  const backup = JSON.parse(await readFile(String(await (await download).path()), "utf8"))
  expect(backup.formatVersion).toBe(1)
  const ids = new Set((backup.books as { id: string }[]).map((book) => book.id))
  expect(ids.has(stack.fixtureBookId("a", "isla"))).toBe(true)
  expect(ids.has(stack.fixtureBookId("b", "versos")), "Sin fichas de B").toBe(false)
  await expect(page.getByRole("status").filter({ hasText: "Copia preparada con" })).toBeVisible()
})

test("la revisión no escribe; si la colección cambia en otra pestaña, confirmar da conflicto sin borrar", async ({ page, context, stack, data }) => {
  const slug = data.slug("conflicto")
  const file = libraryFile(data, slug, 2)
  const before = await libraryCount(stack)
  const revisionBefore = await revision(stack)
  await openSettings(page)

  await page.locator("#import-file").setInputFiles(file)
  await expect(page.getByRole("heading", { name: `Revisión: ${file.name}` })).toBeVisible()
  await expect(planValue(page, "Libros nuevos")).toHaveText("2")
  expect(await libraryCount(stack), "Elegir el archivo no escribe").toBe(before)
  expect(await revision(stack), "La revisión de colección no cambia al preparar").toBe(revisionBefore)

  await page.getByLabel("Reemplazar la biblioteca").check()
  await expect(planValue(page, "Libros que se eliminarán")).toHaveText(String(before))

  const second = await context.newPage()
  await second.goto("/shelves")
  await second.getByRole("button", { name: "Nueva estantería" }).click()
  await second.getByLabel("Nombre de la estantería").fill(data.marked(`${slug} otra pestaña`))
  await second.getByRole("button", { name: "Crear estantería" }).click()
  await expect(second.getByRole("heading", { name: data.marked(`${slug} otra pestaña`) })).toBeVisible()
  await second.close()

  await page.getByRole("button", { name: "Continuar y confirmar" }).click()
  await page.getByLabel("Entiendo que se reemplazará mi colección actual.").check()
  await page.getByRole("button", { name: "Sí, reemplazar biblioteca" }).click()
  const stale = alerts(page).filter({ hasText: "Tu biblioteca ha cambiado" })
  await expect(stale).toBeVisible()
  await expect(stale).toContainText(`Se conservan el archivo «${file.name}» y el modo «Reemplazar»`)
  await expect(stale.getByRole("button", { name: "Volver a revisar con los datos actuales" })).toBeVisible()
  expect(await libraryCount(stack), "El conflicto no borra ni importa nada").toBe(before)
  expect(await fixtureBooksPresent(stack)).toBe(4)
  await stale.getByRole("button", { name: "Cancelar importación" }).click()
})

test("fusionar añade los libros nuevos y conserva los actuales", async ({ page, stack, data }) => {
  const slug = data.slug("fusion")
  const file = libraryFile(data, slug, 2)
  const before = await libraryCount(stack)
  await openSettings(page)
  await page.locator("#import-file").setInputFiles(file)
  await expect(page.getByRole("heading", { name: `Revisión: ${file.name}` })).toBeVisible()
  await page.getByRole("button", { name: "Continuar y confirmar" }).click()
  await page.getByRole("button", { name: "Sí, fusionar biblioteca" }).click()
  const result = page.getByRole("region", { name: "Resultado de la importación" })
  await expect(result).toContainText("Libros importados: 2")
  expect(await libraryCount(stack)).toBe(before + 2)
  expect(await fixtureBooksPresent(stack)).toBe(4)
})

test("confirmar otra vez tras perder la respuesta no duplica la importación", async ({ page, stack, data, guard }) => {
  const slug = data.slug("doble")
  const file = libraryFile(data, slug, 3)
  const before = await libraryCount(stack)
  const isConfirm = actionRequest(stack, "confirmImportAction")
  await openSettings(page)
  await page.locator("#import-file").setInputFiles(file)
  await expect(page.getByRole("heading", { name: `Revisión: ${file.name}` })).toBeVisible()

  // El servidor aplica la primera confirmación, pero el navegador no recibe la respuesta.
  guard.allowConsole(/Failed to fetch|NetworkError|Load failed|ERR_FAILED|net::/i)
  let lose = true
  await page.route("**/settings", async (route) => {
    if (!lose || !isConfirm(route.request())) return route.fallback()
    lose = false
    await route.fetch()
    await route.abort("failed")
  })
  await page.getByRole("button", { name: "Continuar y confirmar" }).click()
  await page.getByRole("button", { name: "Sí, fusionar biblioteca" }).click()
  await expect(alerts(page)).toContainText("No se recibió la respuesta de la importación")
  expect(await libraryCount(stack)).toBe(before + 3)

  await page.getByRole("button", { name: "Continuar y confirmar" }).click()
  await page.getByRole("button", { name: "Sí, fusionar biblioteca" }).click()
  await expect(page.getByRole("region", { name: "Resultado de la importación" })).toContainText("Libros importados: 3")
  expect(await libraryCount(stack), "La segunda confirmación devuelve el mismo resultado sin repetirla").toBe(before + 3)
  const titles = await stack.sql`select count(*)::int as count from biblib.books where user_id = ${stack.users.a} and title like ${`%${slug}%`}`
  expect(Number(titles[0].count)).toBe(3)
})

test("reemplazar sustituye la colección (la biblioteca ficticia de A se restaura después)", async ({ page, stack, data }) => {
  const slug = data.slug("reemplazo")
  const file = libraryFile(data, slug, 2)
  const snapshot = await snapshotLibrary(stack.sql, stack.users.a)
  recordSnapshot(stack.manifest, snapshot)
  try {
    const before = await libraryCount(stack)
    await openSettings(page)
    await page.locator("#import-file").setInputFiles(file)
    await expect(page.getByRole("heading", { name: `Revisión: ${file.name}` })).toBeVisible()
    await page.getByLabel("Reemplazar la biblioteca").check()
    await expect(planValue(page, "Libros que se eliminarán")).toHaveText(String(before))
    await page.getByRole("button", { name: "Continuar y confirmar" }).click()
    const confirm = page.getByRole("button", { name: "Sí, reemplazar biblioteca" })
    await expect(confirm).toBeDisabled()
    await page.getByLabel("Entiendo que se reemplazará mi colección actual.").check()
    await confirm.click()
    const result = page.getByRole("region", { name: "Resultado de la importación" })
    await expect(result).toContainText(`Libros eliminados: ${before}`)
    await expect(result).toContainText("Libros importados: 2")
    const rows = await stack.sql`select title from biblib.books where user_id = ${stack.users.a} order by title`
    expect(rows.map((row) => row.title)).toEqual([data.marked(`${slug} importado 1`), data.marked(`${slug} importado 2`)])
    const defaults = await stack.sql`select id from biblib.shelves where user_id = ${stack.users.a} and is_default`
    expect(defaults.map((row) => row.id), "La predeterminada se conserva").toEqual(snapshot.shelves.filter((shelf) => shelf.is_default).map((shelf) => shelf.id))
  } finally {
    await restoreLibrary(stack.sql, snapshot)
    forgetSnapshot(stack.manifest, stack.users.a)
  }
  expect(await fixtureBooksPresent(stack)).toBe(4)
  expect(await libraryCount(stack)).toBe(snapshot.books.length)
})

import type { Page } from "@playwright/test"
import { capture, expect, test, type Stack } from "../lib/fixtures"

// Ubicación física (U-PRO-03) de A: crear un mueble y su balda en /locations, situar un ejemplar desde su ficha (ruta
// legible, hueco y posición), filtrar el contenido, foto de referencia con vista previa y borrar una ubicación ocupada con
// la elección explícita. La estantería lógica y el estado no cambian. Cada prueba retira sus ubicaciones al terminar.

// PNG 1×1 válido: basta para la vista previa y la reencodificación del servidor.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")

/**
 * Limpieza por la acción real con la sesión de A (retira también la foto y su objeto): ubicaciones de la prueba, de las
 * hojas a la raíz. Si una prueba falla a medias, no deja imágenes ni ubicaciones en la cuenta del censo.
 */
async function removeLocations(page: Page, stack: Stack, slug: string) {
  for (let pass = 0; pass < 8; pass++) {
    const rows = await stack.sql`select l.id, l.version from biblib.locations l where l.user_id = ${stack.users.a} and l.name like ${`%${slug}%`}
      and not exists (select 1 from biblib.locations c where c.user_id = l.user_id and c.parent_id = l.id)`
    if (!rows.length) return
    for (const row of rows) {
      await page.request.post("/locations", {
        headers: { "Next-Action": stack.actionId("deleteLocationAction"), "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component", Origin: stack.appUrl },
        data: JSON.stringify([{ id: row.id, expectedVersion: row.version, contents: "move-to-parent" }]),
      })
    }
  }
}

const createForm = (page: Page) => page.getByRole("form", { name: "Nueva ubicación" })
const tree = (page: Page) => page.getByRole("navigation", { name: "Árbol de ubicaciones" })

async function createLocation(page: Page, name: string, kind: string) {
  const form = createForm(page)
  await form.getByLabel("Nombre").fill(name)
  await form.getByLabel("Tipo").selectOption({ label: kind })
  await form.getByRole("button", { name: "Crear ubicación" }).click()
  await expect(page.getByRole("status")).toHaveText(`Ubicación «${name}» creada.`)
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible()
}

test("ubicaciones: mueble y balda, ejemplar situado desde la ficha, contenido filtrado y borrado con elección explícita", async ({ page, stack, data }, testInfo) => {
  const slug = data.slug("ubic")
  const shelfId = await data.shelf("a", `Lógica ${slug}`)
  const [bookId] = await data.books("a", shelfId, [{ title: `Ubicado ${slug}`, authors: ["Autora ubicada"], status: "reading" }])
  const bookcase = data.marked(`Mueble ${slug}`)
  const board = data.marked(`Balda ${slug}`)
  try {
    await page.goto("/locations")
    await expect(page).toHaveTitle("Ubicaciones · BibLib")
    await createLocation(page, bookcase, "Estantería")
    // Con el mueble elegido, la siguiente se crea dentro de él.
    await expect(createForm(page).getByLabel("Dentro de")).toHaveValue(/[0-9a-f-]{36}/)
    await createLocation(page, board, "Balda")
    await expect(tree(page).getByRole("button", { name: new RegExp(board.replace(/[[\]]/g, "\\$&")) })).toBeVisible()

    await page.goto(`/book/${bookId}`)
    const section = page.getByRole("region", { name: "Ubicación física" })
    await expect(section.getByTestId("copy-location-path")).toHaveText(/Sin ubicación física/)
    const [{ id: boardId }] = await stack.sql`select id from biblib.locations where user_id = ${stack.users.a} and name = ${board}`
    const picker = section.getByLabel("Mueble o balda")
    await expect(picker.locator(`option[value="${boardId}"]`)).toContainText(`└ ${board} (Balda)`)
    await picker.selectOption(String(boardId))
    await section.getByLabel(/Balda o hueco/).fill("Fila de atrás")
    await section.getByLabel(/Posición/).fill("2")
    await section.getByRole("button", { name: "Guardar ubicación" }).click()
    await expect(section.getByRole("status")).toContainText(`${bookcase} › ${board} · hueco «Fila de atrás» · posición 2`)
    await expect(section.getByTestId("copy-location-path")).toContainText(`${bookcase} › ${board}`)
    await capture(page, testInfo, "ficha-ubicacion")
    const [copy] = await stack.sql`select shelf_id, status from biblib.copies where id = ${bookId}`
    expect(copy).toEqual({ shelf_id: shelfId, status: "reading" })

    await section.getByRole("link", { name: "Ver ubicaciones" }).click()
    await expect(page).toHaveURL(/\/locations\?ubicacion=/)
    await expect(page.getByRole("heading", { level: 2, name: board })).toBeVisible()
    await expect(page.getByRole("list", { name: `Ejemplares en ${board}` }).getByRole("link", { name: data.marked(`Ubicado ${slug}`) })).toBeVisible()

    await tree(page).getByRole("button", { name: new RegExp(bookcase.replace(/[[\]]/g, "\\$&")) }).click()
    await expect(page.getByText("No hay ejemplares en esta ubicación.", { exact: false })).toBeVisible()
    await page.getByLabel("Incluir las ubicaciones que contiene").check()
    const contents = page.getByRole("list", { name: `Ejemplares en ${bookcase}` })
    await expect(contents.getByRole("link", { name: data.marked(`Ubicado ${slug}`) })).toBeVisible()
    await expect(contents).toContainText("Hueco «Fila de atrás» · Posición 2")
    const filter = page.getByRole("search", { name: `Filtrar el contenido de ${bookcase}` })
    await filter.getByLabel("Título o autor").fill("nadie con este nombre")
    await filter.getByRole("button", { name: "Filtrar" }).click()
    await expect(page.getByText("Ningún ejemplar de esta ubicación coincide con el filtro.")).toBeVisible()
    await filter.getByLabel("Título o autor").fill("autora ubicada")
    await filter.getByRole("button", { name: "Filtrar" }).click()
    await expect(contents.getByRole("link", { name: data.marked(`Ubicado ${slug}`) })).toBeVisible()

    await page.getByRole("button", { name: "Borrar ubicación" }).click()
    const dialog = page.getByRole("alertdialog")
    await expect(dialog).toContainText("No está vacía: contiene 1 ubicación")
    await capture(page, testInfo, "borrar-ocupada")
    await dialog.getByRole("button", { name: "Pasar contenido y borrar" }).click()
    await expect(page.getByRole("status")).toContainText("1 ubicación pasó al nivel superior")
    await expect(page.getByRole("status")).toContainText("Ningún libro ha cambiado de estantería.")
    const rows = await stack.sql`select l.name, l.parent_id, cl.position from biblib.locations l left join biblib.copy_locations cl on cl.location_id = l.id where l.user_id = ${stack.users.a} and l.name like ${`%${slug}%`}`
    expect(rows.map((row) => ({ ...row }))).toEqual([{ name: board, parent_id: null, position: 2 }])
  } finally {
    await removeLocations(page, stack, slug)
  }
})

test("ubicaciones: foto de referencia con vista previa, guardada sin URL pública y quitada", async ({ page, stack, data }, testInfo) => {
  const slug = data.slug("foto")
  const room = data.marked(`Despacho ${slug}`)
  const assets = async () => (await stack.sql`select count(*)::int as n from biblib.media_assets where user_id = ${stack.users.a} and kind = 'location'`)[0].n
  const before = await assets()
  try {
    await page.goto("/locations")
    await createLocation(page, room, "Habitación")
    await expect(page.getByText("Sin foto.")).toBeVisible()
    await page.getByLabel(`Archivo de imagen para ${room}`).setInputFiles({ name: "mueble.png", mimeType: "image/png", buffer: PIXEL })
    await expect(page.getByRole("img", { name: `Vista previa de la nueva foto de ${room}` })).toBeVisible()
    await expect(page.getByText("Vista previa: aún no se ha guardado.")).toBeVisible()
    await page.getByRole("button", { name: "Guardar foto" }).click()
    await expect(page.getByRole("status").filter({ hasText: "Foto guardada." })).toBeVisible()
    const photo = page.getByRole("img", { name: `Foto de ${room}` })
    await expect(photo).toBeVisible()
    await expect(photo).toHaveAttribute("src", /^\/api\/locations\/[0-9a-f-]{36}\/photo\?v=/)
    // La imagen llega de la ruta autenticada del propio origen y se decodifica (no es un enlace roto).
    await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.complete ? image.naturalWidth : 0)).toBeGreaterThan(0)
    await capture(page, testInfo, "foto-ubicacion")
    await page.getByRole("button", { name: "Quitar foto" }).click()
    await expect(page.getByRole("status").filter({ hasText: "Foto quitada." })).toBeVisible()
    await expect(page.getByText("Sin foto.")).toBeVisible()
    expect(await assets()).toBe(before)
  } finally {
    await removeLocations(page, stack, slug)
  }
})

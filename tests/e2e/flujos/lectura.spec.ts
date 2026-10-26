import type { Page } from "@playwright/test"
import { capture, expect, test } from "../lib/fixtures"

// Lectura (U-PRO-02) de A: empezar, registrar sesiones con progreso real, pausar, terminar sin fecha, releer sin perder
// la primera lectura y verlo en «Seguir leyendo» y en las estadísticas del inicio. Sin total de páginas no hay barra ni
// porcentaje, y un libro «Leído» sin lecturas no recibe fecha. El estado actual del libro no cambia. Las fichas llevan la
// marca del run y su lectura se borra en cascada con ellas.

const panel = (page: Page) => page.getByRole("region", { name: "Lectura", exact: true })
const dialog = (page: Page) => page.getByRole("alertdialog")

async function registerSession(page: Page, { from, to, note }: { from?: string; to?: string; note?: string }) {
  const form = page.getByRole("form", { name: "Registrar una sesión" })
  if (!(await form.isVisible())) await panel(page).getByRole("button", { name: "Registrar sesión" }).click()
  if (from !== undefined) await form.getByLabel(/Desde la página/).fill(from)
  if (to !== undefined) await form.getByLabel("Hasta la página").fill(to)
  if (note !== undefined) await form.getByLabel(/Nota/).fill(note)
  await form.getByRole("button", { name: "Guardar sesión" }).click()
}

test("lectura: empezar, sesiones con progreso, pausa, terminar sin fecha y relectura que conserva la primera", async ({ page, stack, data }, testInfo) => {
  const slug = data.slug("lectura")
  const shelfId = await data.shelf("a", `Lectura ${slug}`)
  const [bookId] = await data.books("a", shelfId, [{ title: `Leído y releído ${slug}`, authors: ["Autora lectora"], pages: 200, status: "to-read" }])
  const title = data.marked(`Leído y releído ${slug}`)

  await page.goto(`/book/${bookId}`)
  await expect(panel(page)).toContainText("Aún no has registrado ninguna lectura de este libro.")
  await panel(page).getByRole("button", { name: "Empezar a leer" }).click()
  await expect(dialog(page).getByRole("radio", { name: "Ahora" })).toBeChecked()
  await dialog(page).getByRole("button", { name: "Empezar a leer" }).click()
  await expect(panel(page).getByRole("status")).toHaveText("Lectura empezada.")
  await expect(panel(page).getByTestId("reading-current")).toContainText("Lectura n.º 1")

  await registerSession(page, { from: "0", to: "50", note: "Primer capítulo" })
  await expect(panel(page).getByRole("status")).toHaveText("Sesión registrada.")
  await expect(panel(page).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25")
  await expect(panel(page).getByTestId("reading-current")).toContainText("Página 50 de 200 (25 %)")

  await registerSession(page, { to: "250" })
  await expect(page.getByRole("form", { name: "Registrar una sesión" }).getByRole("alert")).toHaveText(/supera el total de esta edición \(200\)/)

  await panel(page).getByRole("button", { name: "Pausar" }).click()
  await expect(panel(page).getByRole("status")).toHaveText("Lectura en pausa.")
  await panel(page).getByRole("button", { name: "Reanudar" }).click()
  await expect(panel(page).getByRole("status")).toHaveText("Lectura reanudada.")

  await panel(page).getByRole("button", { name: "Terminar…" }).click()
  await expect(dialog(page)).toContainText("¿Terminar la lectura?")
  await dialog(page).getByRole("radio", { name: "No lo sé (sin fecha)" }).check()
  await dialog(page).getByRole("button", { name: "Terminar", exact: true }).click()
  const history = panel(page).getByRole("list", { name: "Historial de lecturas" })
  await expect(history).toContainText("Terminado")
  await expect(history).toContainText("fin sin fecha registrada")

  await panel(page).getByRole("button", { name: "Empezar una relectura" }).click()
  await expect(dialog(page)).toContainText("Se creará la lectura n.º 2")
  await dialog(page).getByRole("button", { name: "Empezar la relectura" }).click()
  await expect(panel(page).getByTestId("reading-current")).toContainText("Relectura · lectura n.º 2")
  await expect(history).toContainText("Lectura n.º 1")
  await expect(history).toContainText("1 sesión")
  await capture(page, testInfo, "ficha-lectura")

  const cycles = await stack.sql`select cycle_number, status, finished_at from biblib.reading_cycles where copy_id = ${bookId} order by cycle_number`
  expect(cycles.map((row) => [row.cycle_number, row.status, row.finished_at])).toEqual([[1, "finished", null], [2, "reading", null]])
  const [copy] = await stack.sql`select status from biblib.copies where id = ${bookId}`
  expect(copy.status).toBe("to-read")

  await page.goto("/")
  const continuing = page.getByRole("region", { name: "Seguir leyendo" })
  await expect(continuing.getByRole("link", { name: new RegExp(title.replace(/[[\]]/g, "\\$&")) })).toContainText("Relectura · lectura n.º 2")
  const stats = page.getByRole("region", { name: "Tu lectura registrada" })
  await expect(stats).toContainText("Solo cuenta lo que registras")
  await expect(stats).toContainText(/Últimos 30 días: del .+ al .+/)
  await expect(stats.getByText(/^En \d+ de 30 días$/)).toBeVisible()
  await capture(page, testInfo, "inicio-lectura")
})

test("lectura: sin total de páginas no hay barra ni porcentaje y un «Leído» sin lecturas no recibe fecha", async ({ page, data }) => {
  const slug = data.slug("sinpaginas")
  const shelfId = await data.shelf("a", `Sin páginas ${slug}`)
  const [unknownId, legacyId] = await data.books("a", shelfId, [{ title: `Sin total ${slug}`, pages: 0, status: "reading" }, { title: `Leído antiguo ${slug}`, status: "read" }])

  await page.goto(`/book/${legacyId}`)
  await expect(panel(page)).toContainText("marcado como leído, pero no tiene lecturas registradas")
  await expect(panel(page).locator("time")).toHaveCount(0)

  await page.goto(`/book/${unknownId}`)
  await panel(page).getByRole("button", { name: "Empezar a leer" }).click()
  await dialog(page).getByRole("radio", { name: "No lo sé (sin fecha)" }).check()
  await dialog(page).getByRole("button", { name: "Empezar a leer" }).click()
  await expect(panel(page).getByTestId("reading-current")).toContainText("Inicio sin fecha registrada")
  await panel(page).getByRole("button", { name: "Registrar sesión" }).click()
  await expect(page.getByRole("form", { name: "Registrar una sesión" })).toContainText("El total de páginas de esta edición es desconocido")
  await registerSession(page, { to: "120" })
  await expect(panel(page).getByTestId("reading-current")).toContainText("Página 120 · total de páginas desconocido")
  await expect(panel(page).getByRole("progressbar")).toHaveCount(0)
})

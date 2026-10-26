import { randomUUID } from "node:crypto"
import type { Page } from "@playwright/test"
import { capture, type Data, expect, test } from "../lib/fixtures"

// Desde U-FIX-01 una ficha inexistente o ajena responde 404 real; el navegador lo anota en consola como recurso fallido.
const BOOK_404 = /status of 404 \(Not Found\) \[\/book\//

// Consulta (A): tildes, ISBN-10/13, filtros en la URL, atrás/adelante, cero resultados, página que deja
// de existir y retorno contextual de U-EXP-01 (filtros, página, vista y fila al volver de la ficha).

async function seedCatalogue(data: Data, slug: string) {
  const shelfId = await data.shelf("a", `Consulta ${slug}`)
  // 12 fichas → 2 páginas de 10. Los títulos llevan tildes; la mitad está leída.
  const specs = Array.from({ length: 12 }, (_, index) => ({
    title: `${slug} Canción del árbol ${String(index + 1).padStart(2, "0")}`,
    status: index % 2 === 0 ? "read" as const : "unread" as const,
    authors: ["Íñigo Ñandú"],
  }))
  return { shelfId, ids: await data.books("a", shelfId, specs) }
}

function resultCount(page: Page, count: number) {
  return page.getByText(new RegExp(`^${count} resultados?$`))
}

test("búsqueda sin tildes ni mayúsculas, ISBN-10/13 y cero resultados", async ({ page, data }) => {
  const slug = data.slug("tildes")
  await seedCatalogue(data, slug)

  await page.goto(`/books?q=${encodeURIComponent(`${slug} cancion del arbol`)}`)
  await expect(resultCount(page, 12)).toBeVisible()
  await page.getByLabel("Buscar por título, autor o ISBN").fill(`${slug.toUpperCase()} CANCIÓN DEL ÁRBOL 0`)
  await expect(resultCount(page, 9)).toBeVisible()
  await expect(page).toHaveURL(/[?&]q=/)
  await page.getByLabel("Buscar por título, autor o ISBN").fill("inigo nandu")
  await expect(page.getByRole("row").filter({ hasText: slug }).first()).toBeVisible()

  for (const isbn of ["0-00-000001-9", "0000000019", "978-0-00-000001-9", "9780000000019"]) {
    await page.getByLabel("Buscar por título, autor o ISBN").fill(isbn)
    await expect(resultCount(page, 1)).toBeVisible()
    await expect(page.getByRole("row").filter({ hasText: "La isla de papel" })).toBeVisible()
  }

  await page.getByLabel("Buscar por título, autor o ISBN").fill(`${slug} no existe`)
  await expect(page.getByText("No hay libros con estos filtros")).toBeVisible()
  await expect(resultCount(page, 0)).toBeVisible()
})

test("los filtros de la URL se aplican al cargar y la página inexistente se ajusta", async ({ page, stack, data }) => {
  const slug = data.slug("filtros")
  const { ids } = await seedCatalogue(data, slug)

  await page.goto(`/books?q=${encodeURIComponent(slug)}&status=read&sort=-title`)
  await expect(page).toHaveTitle("Colección · BibLib")
  await expect(page.getByRole("combobox", { name: "Filtrar por estado" })).toHaveText("Leído")
  await expect(page.getByRole("combobox", { name: "Ordenar libros" })).toHaveText("Título (Z-A)")
  await expect(resultCount(page, 6)).toBeVisible()
  await expect(page.getByRole("row").nth(1)).toContainText(`${slug} Canción del árbol 11`)

  // Página 2 de 2; luego desaparecen fichas y esa página deja de existir.
  await page.goto(`/books?q=${encodeURIComponent(slug)}&page=2`)
  await expect(page.getByText("Página 2 de 2")).toBeVisible()
  await stack.sql`delete from biblib.books where id in ${stack.sql(ids.slice(0, 3))}`
  await page.reload()
  await expect(page.getByText("Página 1 de 1")).toBeVisible()
  await expect(resultCount(page, 9)).toBeVisible()
  await expect.poll(() => new URL(page.url()).searchParams.get("page")).toBeNull()

  await page.goto(`/books?q=${encodeURIComponent(slug)}&page=9`)
  await expect(page.getByText("Página 1 de 1")).toBeVisible()
})

test("retorno contextual: la ficha vuelve a filtros, página, vista y fila; atrás y adelante", async ({ page, stack, data, guard }, testInfo) => {
  guard.allowConsole(BOOK_404)
  const slug = data.slug("retorno")
  await seedCatalogue(data, slug)
  const listing = `/books?q=${encodeURIComponent(slug)}&sort=-title&page=2&view=grid`

  await page.goto(listing)
  await expect(page.getByText("Página 2 de 2")).toBeVisible()
  const title = data.marked(`${slug} Canción del árbol 01`)
  const [{ id }] = await stack.sql`select id from biblib.books where user_id = ${stack.users.a} and title = ${title}`
  await page.getByRole("heading", { level: 2 }).getByRole("link", { name: title }).click()
  await page.waitForURL(new RegExp(`/book/${id}\\?from=`))
  await expect(page).toHaveTitle(`${title} · BibLib`)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title)

  // Atrás: el listado conserva filtros, página y vista, y recupera la fila abierta.
  await page.goBack()
  await page.waitForURL((url) => url.pathname === "/books" && url.searchParams.get("page") === "2" && url.searchParams.get("view") === "grid")
  const card = page.locator(`#book-row-${id}`)
  await expect(card).toBeInViewport()
  await page.goForward()
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title)

  // «Volver a libros» restaura la consulta y enfoca la fila; el fragmento se retira.
  await page.getByRole("link", { name: "Volver a libros" }).click()
  await page.waitForURL((url) => url.pathname === "/books" && url.searchParams.get("sort") === "-title" && url.searchParams.get("page") === "2")
  await expect(page.getByText("Página 2 de 2")).toBeVisible()
  await expect(card).toBeInViewport()
  await expect(card.locator("a[href]").first()).toBeFocused()
  await expect.poll(() => new URL(page.url()).hash).toBe("")
  await expect(page.getByRole("button", { name: "Vista de cuadrícula" })).toHaveAttribute("aria-pressed", "true")
  await capture(page, testInfo, "retorno-contextual")

  // Ficha abierta sin contexto (otra pestaña o enlace directo) y una ficha que ya no existe.
  await page.goto(`/book/${id}`)
  await expect(page.getByRole("link", { name: "Volver a libros" })).toHaveAttribute("href", "/books")
  await page.goto(`/book/${randomUUID()}`)
  await expect(page).toHaveTitle("Libro no encontrado · BibLib")
  await expect(page.getByRole("heading", { name: "Libro no encontrado" })).toBeVisible()
})

// Hallazgo QA-02 (23-10-2026), corregido por U-FIX-01: un id que no es UUID o un UUID inexistente
// responde 404 con la página «Libro no encontrado» en español, sin error de servidor.
test("un identificador inválido muestra «Libro no encontrado» sin error de servidor", async ({ page, guard }) => {
  guard.allowConsole(BOOK_404)
  const response = await page.goto("/book/no-es-un-uuid")
  expect(response?.status()).toBe(404)
  await expect(page).toHaveTitle("Libro no encontrado · BibLib")
  await expect(page.getByRole("heading", { name: "Libro no encontrado" })).toBeVisible({ timeout: 5_000 })
})

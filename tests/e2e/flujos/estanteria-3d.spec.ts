import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import path from "node:path"
import type { Locator, Page } from "@playwright/test"
import { type Data, expect, test } from "../lib/fixtures"

// Estantería 3D (U-EXP-04, rediseño U-UX-02): cada libro es un botón que lo saca de la balda; la ficha
// se abre desde el panel con retorno contextual. Teclado (flechas, Intro, Escape), movimiento reducido,
// móvil sin scroll horizontal, paginación de 48 con los mismos ids que la tabla y estantería vacía.

async function seedShelf(data: Data, slug: string, count: number) {
  const shelfId = await data.shelf("a", `3D ${slug}`)
  const specs = Array.from({ length: count }, (_, index) => ({
    title: `${slug} Libro ${String(index + 1).padStart(2, "0")}`,
    authors: [`Autora ${index + 1}`],
    status: index % 2 === 0 ? "read" as const : "to-read" as const,
    pages: 120 + index * 37,
  }))
  // `shelf` y `books` añaden la marca del run: los nombres visibles la llevan.
  return { shelfId, ids: await data.books("a", shelfId, specs), titles: specs.map((spec) => data.marked(spec.title)) }
}

function spine(page: Page, title: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, de `) })
}

/**
 * Pulsa la cara visible del lomo, como haría una persona. La caja del botón incluye la
 * profundidad del libro (92 px) proyectada, y con el mueble en ángulo su centro cae sobre
 * el lomo vecino.
 */
async function pull(book: Locator, how: "click" | "tap" = "click") {
  const face = book.locator(".s3-spine")
  await (how === "tap" ? face.tap() : face.click())
}

function panel(page: Page): Locator {
  return page.getByRole("region", { name: "Libro seleccionado" })
}

async function openScene(page: Page, shelfId: string, query = "") {
  await page.goto(`/shelves/3d?shelf=${shelfId}${query}`)
  await expect(page).toHaveTitle("Estantería 3D · BibLib")
  await expect(page.getByRole("group").first()).toBeVisible()
}

function noPageOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)
}

test("estantería 3D: sacar un libro, abrir su ficha y volver con el foco en el lomo", async ({ page, data }) => {
  const slug = data.slug("tresde")
  const { shelfId, ids, titles } = await seedShelf(data, slug, 5)
  await openScene(page, shelfId)

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(data.marked(`3D ${slug}`))
  await expect(page.getByRole("group", { name: /^Balda 1 de \d+, títulos/ })).toBeVisible()
  const book = spine(page, titles[2])
  await expect(book).toHaveAccessibleName(`${titles[2]}, de Autora 3. Leído.`)
  await expect(book).toHaveAttribute("aria-pressed", "false")
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Saca un libro de la balda")
  await expect(page.getByText("arrastr", { exact: false })).toHaveCount(0)

  await pull(book)
  await expect(book).toHaveAttribute("aria-pressed", "true")
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText(titles[2])
  await expect(panel(page)).toContainText("Autora 3")
  await expect(panel(page)).toContainText("Leído")
  const open = panel(page).getByRole("link", { name: "Abrir ficha" })
  await expect(open).toHaveAttribute("href", new RegExp(`^/book/${ids[2]}\\?from=`))

  await open.click()
  await expect(page).toHaveURL(new RegExp(`/book/${ids[2]}\\?from=`))
  await expect(page.getByRole("heading", { level: 1 })).toContainText(titles[2])

  // «Volver a libros» devuelve a la misma estantería y página con el foco en el lomo.
  await page.getByRole("link", { name: "Volver a libros" }).click()
  await expect(page).toHaveURL(new RegExp(`/shelves/3d\\?shelf=${shelfId}$`))
  await expect(spine(page, titles[2])).toBeFocused()

  // Atrás desde la ficha también recupera el lomo (el historial lo recuerda).
  await pull(spine(page, titles[1]))
  await panel(page).getByRole("link", { name: "Abrir ficha" }).click()
  await expect(page).toHaveURL(new RegExp(`/book/${ids[1]}`))
  await page.goBack()
  await expect(spine(page, titles[1])).toBeFocused()
})

test("estantería 3D con teclado: flechas, Intro, Tab a «Abrir ficha» y Escape devuelve el foco al lomo", async ({ page, data }) => {
  const slug = data.slug("teclado")
  const { shelfId, titles } = await seedShelf(data, slug, 6)
  await openScene(page, shelfId)

  // Un único punto de tabulación para todos los lomos: el primero.
  const first = spine(page, titles[0])
  await first.focus()
  await expect(first).toHaveAttribute("tabindex", "0")
  await expect(page.locator(".s3-book[tabindex='0']")).toHaveCount(1)
  await page.keyboard.press("ArrowRight")
  await expect(spine(page, titles[1])).toBeFocused()
  await page.keyboard.press("End")
  await expect(spine(page, titles[5])).toBeFocused()
  await page.keyboard.press("Home")
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("ArrowRight")
  const third = spine(page, titles[2])
  await expect(third).toBeFocused()

  await page.keyboard.press("Enter")
  await expect(third).toHaveAttribute("aria-pressed", "true")
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText(titles[2])
  await page.keyboard.press("Tab")
  await expect(panel(page).getByRole("link", { name: "Abrir ficha" })).toBeFocused()

  await page.keyboard.press("Escape")
  await expect(third).toHaveAttribute("aria-pressed", "false")
  await expect(third).toBeFocused()
  await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("Saca un libro de la balda")

  // «Devolver a la balda» hace lo mismo que Escape; Espacio también selecciona.
  await page.keyboard.press(" ")
  await expect(third).toHaveAttribute("aria-pressed", "true")
  await panel(page).getByRole("button", { name: "Devolver a la balda" }).click()
  await expect(third).toHaveAttribute("aria-pressed", "false")
  await expect(third).toBeFocused()
})

test.describe("movimiento reducido", () => {
  test.use({ reducedMotion: "reduce" })

  test("estantería 3D con movimiento reducido: sin giro del mueble ni trayectorias", async ({ page, data }) => {
    const slug = data.slug("reducido")
    const { shelfId, titles } = await seedShelf(data, slug, 4)
    await openScene(page, shelfId)

    await expect(page.getByRole("button", { name: "Recentrar vista" })).toHaveCount(0)
    const cabinet = page.locator(".s3-cabinet")
    const box = await page.locator(".s3-scene").boundingBox()
    if (box) await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.2)
    expect(await cabinet.evaluate((element) => element.style.getPropertyValue("--s3-dx") || "0")).toMatch(/^0(\.0+)?$/)
    expect(await cabinet.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s")

    const book = spine(page, titles[1])
    await pull(book)
    await expect(book).toHaveAttribute("aria-pressed", "true")
    // El libro aparece ya fuera de la balda: sin transición ni animaciones en curso.
    expect(await book.evaluate((element) => {
      const move = element.querySelector(".s3-move")
      return move ? [getComputedStyle(move).transitionDuration, element.getAnimations({ subtree: true }).length] : null
    })).toEqual(["0s", 0])
  })
})

test.describe("móvil", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })

  test("estantería 3D en móvil: de frente, sin scroll horizontal y el panel debajo del mueble", async ({ page, data }) => {
    const slug = data.slug("movil")
    const { shelfId, titles } = await seedShelf(data, slug, 12)
    await openScene(page, shelfId)

    await expect(page.locator(".s3-scene")).toHaveAttribute("data-vista", "frente")
    await expect(page.getByRole("button", { name: "Recentrar vista" })).toHaveCount(0)
    expect(await noPageOverflow(page)).toBe(true)

    const book = spine(page, titles[4])
    await pull(book, "tap")
    await expect(book).toHaveAttribute("aria-pressed", "true")
    await expect(panel(page).getByRole("link", { name: "Abrir ficha" })).toBeVisible()
    expect(await noPageOverflow(page)).toBe(true)
    const sheet = await panel(page).boundingBox()
    expect(sheet && sheet.x >= 0 && sheet.x + sheet.width <= 376).toBe(true)
    // En flujo, el panel está después del mueble (al pie si queda fijo).
    expect(await page.evaluate(() => {
      const scene = document.querySelector(".s3-scene"), sheet = document.querySelector(".s3-panel")
      return Boolean(scene && sheet && scene.compareDocumentPosition(sheet) & Node.DOCUMENT_POSITION_FOLLOWING)
    })).toBe(true)

    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 812 })
      await expect.poll(() => noPageOverflow(page)).toBe(true)
    }
  })
})

test("más de 48 libros: la página 3D y «Ver como tabla» contienen los mismos ids", async ({ page, data }) => {
  const slug = data.slug("pagina")
  const { shelfId, ids } = await seedShelf(data, slug, 50)
  await openScene(page, shelfId)

  await expect(page.getByText(`Estantería «${data.marked(`3D ${slug}`)}» · 50 libros · página 1 de 2`)).toBeVisible()
  const sceneIds = async () => (await page.locator(".s3-book").evaluateAll((elements) => elements.map((element) => element.id))).sort()
  const firstPage = await sceneIds()
  expect(firstPage).toHaveLength(48)

  const table = page.getByRole("link", { name: "Ver como tabla" })
  await expect(table).toHaveAttribute("href", `/books?shelf=${shelfId}&pageSize=48`)
  await table.click()
  await expect(page).toHaveURL(new RegExp(`/books\\?shelf=${shelfId}&pageSize=48`))
  await expect(page.locator("tbody tr")).toHaveCount(48)
  const tableIds = (await page.locator("tbody tr").evaluateAll((rows) => rows.map((row) => row.id))).sort()
  expect(tableIds).toEqual(firstPage)

  await page.goBack()
  await page.getByRole("button", { name: "Página siguiente" }).click()
  await expect(page).toHaveURL(new RegExp(`/shelves/3d\\?shelf=${shelfId}&page=2`))
  await expect(page.getByText(`Estantería «${data.marked(`3D ${slug}`)}» · 50 libros · página 2 de 2`)).toBeVisible()
  const secondPage = await sceneIds()
  expect(secondPage).toHaveLength(2)
  expect([...firstPage, ...secondPage].sort()).toEqual(ids.map((id) => `book-row-${id}`).sort())
  await expect(page.getByRole("link", { name: "Ver como tabla" })).toHaveAttribute("href", `/books?shelf=${shelfId}&page=2&pageSize=48`)
})

test("estantería 3D vacía: estado propio, sin mueble y con acceso al alta", async ({ page, data }) => {
  const slug = data.slug("vacia")
  const shelfId = await data.shelf("a", `3D ${slug}`)
  await page.goto(`/shelves/3d?shelf=${shelfId}`)
  await expect(page.getByText("Esta estantería todavía no tiene libros.")).toBeVisible()
  await expect(page.getByText(`Estantería «${data.marked(`3D ${slug}`)}» · sin libros`)).toBeVisible()
  await expect(page.locator(".s3-cabinet")).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Agregar un libro" })).toHaveAttribute("href", "/books/add")
  await expect(page.getByRole("link", { name: "Ver como tabla" })).toBeVisible()
})

// Evidencia visual de U-UX-02 (opt-in): `UX02_CAPTURAS=1 pnpm test:e2e:local --grep "capturas U-UX-02"`.
// Siembra en A una estantería «Salón» con títulos de dominio público, sin la marca del run para que
// no ocupe los lomos, y la borra al terminar (también si la prueba falla).
const SALON: Array<[string, string, number, "read" | "reading" | "unread" | "to-read"]> = [
  ["Alicia en el país de las maravillas", "Lewis Carroll", 180, "read"], ["Ana Karénina", "León Tolstói", 1000, "to-read"],
  ["Bodas de sangre", "Federico García Lorca", 150, "read"], ["Campos de Castilla", "Antonio Machado", 230, "reading"],
  ["Crimen y castigo", "Fiódor Dostoievski", 680, "read"], ["Cumbres borrascosas", "Emily Brontë", 420, "reading"],
  ["Don Quijote de la Mancha", "Miguel de Cervantes", 1376, "read"], ["Drácula", "Bram Stoker", 520, "read"],
  ["El conde de Montecristo", "Alexandre Dumas", 1300, "unread"], ["Fausto", "J. W. von Goethe", 500, "to-read"],
  ["Fortunata y Jacinta", "Benito Pérez Galdós", 1100, "reading"], ["Frankenstein", "Mary Shelley", 300, "reading"],
  ["Grandes esperanzas", "Charles Dickens", 600, "read"], ["Hamlet", "William Shakespeare", 260, "read"],
  ["Jane Eyre", "Charlotte Brontë", 560, "read"], ["La Celestina", "Fernando de Rojas", 360, "unread"],
  ["La divina comedia", "Dante Alighieri", 800, "unread"], ["La Odisea", "Homero", 520, "read"],
  ["La Regenta", "Leopoldo Alas «Clarín»", 960, "read"], ["Lazarillo de Tormes", "Anónimo", 140, "read"],
  ["Los miserables", "Victor Hugo", 1450, "to-read"], ["Madame Bovary", "Gustave Flaubert", 470, "unread"],
  ["Moby Dick", "Herman Melville", 720, "to-read"], ["Niebla", "Miguel de Unamuno", 280, "read"],
  ["Orgullo y prejuicio", "Jane Austen", 430, "read"], ["Platero y yo", "Juan Ramón Jiménez", 190, "read"],
  ["Robinson Crusoe", "Daniel Defoe", 380, "read"], ["Ulises", "James Joyce", 980, "unread"],
]

test("capturas U-UX-02: 1440 y 375 px, ambos temas, con un libro sacado de la balda", async ({ page, stack }) => {
  test.skip(process.env.UX02_CAPTURAS !== "1", "Solo bajo demanda: escribe en docs/validacion.")
  const dir = path.resolve("docs/validacion/2026-10-26/UX/ux-02")
  mkdirSync(dir, { recursive: true })
  const shelfId = randomUUID()
  await stack.sql`insert into biblib.shelves (id, user_id, title) values (${shelfId}, ${stack.users.a}, 'Salón')`
  try {
    for (const [title, author, pages, status] of SALON) {
      const id = randomUUID()
      await stack.sql`insert into biblib.books (id, user_id, isbn, title, authors, number_of_pages, publish_date, status, shelf_id, catalogue)
        values (${id}, ${stack.users.a}, ${`manual-${id}`}, ${title}, ${stack.sql.json([{ name: author }])}, ${pages}, '', ${status}, ${shelfId},
          ${stack.sql.json({ source: "manual", isbnVerified: false })})`
    }
    for (const theme of ["light", "dark"] as const) {
      await page.goto("/books")
      await page.evaluate((value) => localStorage.setItem("theme", value), theme)
      for (const [width, height] of [[1440, 1000], [375, 812]] as const) {
        await page.setViewportSize({ width, height })
        await openScene(page, shelfId)
        const book = page.getByRole("button", { name: /^Don Quijote de la Mancha, de / })
        await pull(book)
        await expect(book).toHaveAttribute("aria-pressed", "true")
        await page.waitForTimeout(800)
        // En 375 el panel queda fijo al pie: se captura la pantalla tal como se ve.
        await page.screenshot({ path: path.join(dir, `estanteria-3d-${width}-${theme === "light" ? "claro" : "oscuro"}.png`), fullPage: width !== 375 })
      }
    }
  } finally {
    await stack.sql`delete from biblib.books where shelf_id = ${shelfId} and user_id = ${stack.users.a}`
    await stack.sql`delete from biblib.shelves where id = ${shelfId} and user_id = ${stack.users.a}`
  }
})

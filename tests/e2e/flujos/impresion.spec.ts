import { mkdir } from "node:fs/promises"
import path from "node:path"
import { evidenceDir, expect, test } from "../lib/fixtures"

test.describe("impresión", () => {
  test("colección vacía: recuento cero y acción deshabilitada", async ({ page, data }) => {
    const slug = data.slug("impresionvacia")
    const shelf = await data.shelf("a", slug)
    await page.goto(`/books/print?shelf=${shelf}`)
    await expect(page.locator("[data-print-total]")).toHaveText("0")
    await expect(page.getByText("No hay libros con estos filtros.", { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Imprimir", exact: true })).toBeDisabled()
    await page.emulateMedia({ media: "print" })
    await expect(page.locator(".print-controls")).toBeHidden()
  })

  test("más de una página: IDs iguales a consulta filtrada, A4 y Carta sin controles", async ({ page, data, stack }, testInfo) => {
    test.setTimeout(120_000)
    const slug = data.slug("impresionpaginas")
    const shelf = await data.shelf("a", slug)
    const ids = await data.books("a", shelf, Array.from({ length: 105 }, (_, i) => ({ title: `${slug} ${String(i).padStart(3, "0")} ${i === 0 ? "Un título muy largo sobre bibliotecas, libros y memoria. ".repeat(6) : "Catálogo"}`, authors: ["Inés del Papel"], status: "read" })))
    await data.books("a", shelf, [{ title: `${slug} excluido`, status: "unread" }])
    await data.books("b", await data.defaultShelf("b"), [{ title: `${slug} privado`, status: "read" }])
    const expected = await stack.sql`select id from biblib.books where user_id = ${stack.users.a} and shelf_id = ${shelf} and status = 'read' and title like ${`%${slug}%`} order by title desc, id limit 2000`
    await page.goto(`/books?q=${slug}&shelf=${shelf}&status=read&sort=-title&page=2&view=grid`)
    await expect(page.getByText("105 resultados", { exact: true })).toBeVisible()
    await page.getByRole("link", { name: "Imprimir catálogo", exact: true }).click()
    await expect(page.locator("[data-print-book-id]")).toHaveCount(105)
    expect(await page.locator("[data-print-book-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-print-book-id")))).toEqual(expected.map((row) => row.id))
    expect(new Set(expected.map((row) => row.id))).toEqual(new Set(ids))
    await expect(page.getByRole("checkbox", { name: "Portada", exact: true })).not.toBeChecked()
    await expect(page.getByRole("link", { name: "Volver", exact: true })).toHaveAttribute("href", /page=2/)
    await expect(page.getByRole("link", { name: "Volver", exact: true })).toHaveAttribute("href", /view=grid/)
    await page.emulateMedia({ media: "print" })
    await expect(page.locator(".print-controls")).toBeHidden()
    await expect(page.locator("header")).toBeHidden()
    expect(await page.locator("button, input, nav").evaluateAll((nodes) => nodes.filter((node) => (node as HTMLElement).offsetWidth || (node as HTMLElement).offsetHeight).length)).toBe(0)
    expect(await page.locator(".print-paper").evaluate((node) => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }))).toEqual({ color: "rgb(0, 0, 0)", background: "rgb(255, 255, 255)" })
    expect(await page.locator("thead").evaluate((node) => getComputedStyle(node).display)).toBe("table-header-group")
    expect(await page.locator("tbody tr").first().evaluate((node) => getComputedStyle(node).breakInside)).toBe("avoid")
    if (testInfo.project.name.startsWith("chromium")) {
      const evidence = evidenceDir("2026-10-26/O15/exp-07")
      await mkdir(evidence, { recursive: true })
      await page.evaluate(() => document.fonts.ready)
      for (const format of ["A4", "Letter"] as const) await page.pdf({ path: path.join(evidence, `catalogo-${format}.pdf`), format, printBackground: false, preferCSSPageSize: false })
      await page.screenshot({ path: path.join(evidence, "vista-print.png"), fullPage: true })
    }
  })

  test("estantería: acceso directo, campos opcionales y cancelar conserva filtros", async ({ page, stack, data }) => {
    const slug = data.slug("impresioncampos"), shelf = await data.shelf("a", slug)
    const [id] = await data.books("a", shelf, [{ title: slug }])
    await stack.sql`insert into biblib.copy_annotations (user_id, copy_id, notes) values (${stack.users.a}, ${id}, 'Una nota privada para el catálogo')`
    const [location] = await stack.sql`insert into biblib.locations (user_id, name, kind) values (${stack.users.a}, ${slug}, 'room') returning id`
    try {
      await stack.sql`insert into biblib.copy_locations (user_id, copy_id, location_id, shelf_label, position) values (${stack.users.a}, ${id}, ${location.id}, 'Balda 2', 3)`
      await page.goto("/shelves")
      await page.getByRole("link", { name: `Imprimir catálogo: ${data.marked(slug)}`, exact: true }).click()
      await expect(page.locator("[data-print-book-id]")).toHaveCount(1)
      await page.getByRole("checkbox", { name: "Notas", exact: true }).check()
      await expect(page.getByRole("cell", { name: "Una nota privada para el catálogo", exact: true })).toBeVisible()
      await expect(page.getByRole("cell", { name: `${slug} · hueco «Balda 2» · posición 3`, exact: true })).toBeVisible()
      const before = page.url()
      // El diálogo nativo no se automatiza; el sustituto retorna como al cancelar y comprueba la delegación.
      await page.evaluate(() => { window.print = () => { document.documentElement.dataset.printCalled = "true" } })
      await page.getByRole("button", { name: "Imprimir", exact: true }).click()
      await expect(page.locator("html")).toHaveAttribute("data-print-called", "true")
      expect(page.url()).toBe(before)
      await page.getByRole("link", { name: "Volver", exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`shelf=${shelf}`))
    } finally { await stack.sql`delete from biblib.copy_locations where user_id = ${stack.users.a} and copy_id = ${id}`; await stack.sql`delete from biblib.locations where user_id = ${stack.users.a} and id = ${location.id}` }
  })

  test("serie y etiquetas: la impresión mantiene la intersección de filtros", async ({ page, stack, data }) => {
    const slug = data.slug("impresionfiltros"), shelf = await data.shelf("a", slug)
    const ids = await data.books("a", shelf, [{ title: `${slug} uno`, status: "read" }, { title: `${slug} dos`, status: "read" }])
    const [series] = await stack.sql`insert into biblib.series (user_id, title) values (${stack.users.a}, ${slug}) returning id`
    const [tag] = await stack.sql`insert into biblib.tags (user_id, name) values (${stack.users.a}, ${slug}) returning id`
    try {
      await stack.sql`insert into biblib.series_editions (user_id, series_id, edition_id) select user_id, ${series.id}, edition_id from biblib.copies where user_id = ${stack.users.a} and id in ${stack.sql(ids)}`
      await stack.sql`insert into biblib.copy_tags (user_id, copy_id, tag_id) values (${stack.users.a}, ${ids[0]}, ${tag.id})`
      await page.goto(`/books?q=${slug}&shelf=${shelf}&series=${series.id}&tag=${tag.id}&tagMode=and&status=read`)
      await expect(page.getByText("1 resultado", { exact: true })).toBeVisible()
      await page.getByRole("link", { name: "Imprimir catálogo", exact: true }).click()
      await expect(page.locator("[data-print-book-id]")).toHaveCount(1)
      await expect(page.locator("[data-print-book-id]")).toHaveAttribute("data-print-book-id", ids[0])
      await page.getByRole("link", { name: "Volver", exact: true }).click()
      expect(new URL(page.url()).searchParams.getAll("tag")).toEqual([String(tag.id)])
    } finally { await stack.sql`delete from biblib.tags where user_id = ${stack.users.a} and id = ${tag.id}`; await stack.sql`delete from biblib.series where user_id = ${stack.users.a} and id = ${series.id}` }
  })
})

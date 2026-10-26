import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import AxeBuilder from "@axe-core/playwright"
import type { Page } from "@playwright/test"
import { capture, expect, test } from "../lib/fixtures"

async function noOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    width: innerWidth, scroll: document.documentElement.scrollWidth,
    outside: [...document.querySelectorAll<HTMLElement>("main *")].filter((node) => node.getBoundingClientRect().right > innerWidth + 1).map((node) => ({ tag: node.tagName, text: node.textContent?.slice(0, 80), class: node.className, parent: node.parentElement?.className, right: node.getBoundingClientRect().right })).slice(-12),
  }))
  expect(metrics.scroll, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.width + 1)
}

test("préstamos: prestar, listado vencido, devolución, préstamo sucesivo y confirmaciones", async ({ page, stack, data }, testInfo) => {
  const shelf = await data.shelf("a", `Préstamos ${data.slug("loan")}`)
  const [bookId] = await data.books("a", shelf, [{ title: "Libro para prestar", authors: ["Autora"], status: "reading" }])
  await page.goto(`/book/${bookId}`)
  const panel = page.getByRole("region", { name: "Préstamos", exact: true })
  const form = panel.getByRole("form", { name: "Nuevo préstamo" })
  await form.getByLabel("Alias de la persona").fill("Ana")
  await form.getByLabel("Fecha de salida").fill("2026-03-29")
  await form.getByRole("button", { name: "Prestar ejemplar" }).click()
  await expect(panel.getByRole("status")).toHaveText("Préstamo registrado.")
  await expect(panel.getByText("Sin fecha acordada", { exact: true })).toBeVisible()
  const [copy] = await stack.sql`select status from biblib.copies where id = ${bookId}`
  expect(copy.status).toBe("reading")
  await capture(page, testInfo, "prestamo-activo")
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await noOverflow(page)
  }
  await page.goto("/")
  const [{ n }] = await stack.sql`select count(*)::int as n from biblib.loans where user_id = ${stack.users.a} and returned_on is null`
  await expect(page.getByRole("link", { name: new RegExp(`^${n}\\s*Prestados$`) })).toBeVisible()
  await page.goto(`/book/${bookId}`)

  await panel.getByRole("button", { name: "Editar préstamo", exact: true }).click()
  await panel.getByRole("form", { name: "Editar préstamo" }).getByLabel("Fecha acordada (opcional)").fill("2026-04-01")
  await panel.getByRole("button", { name: "Revisar cambios" }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog).toContainText("¿Guardar los cambios del préstamo?")
  await dialog.getByRole("button", { name: "Confirmar cambios" }).click()
  await expect(panel.getByRole("status")).toHaveText("Préstamo actualizado.")

  await panel.getByRole("link", { name: "Ver prestados" }).click()
  await expect(page).toHaveTitle("Prestados · BibLib")
  const list = page.getByRole("list", { name: "Ejemplares prestados" })
  await expect(list.getByRole("link", { name: data.marked("Libro para prestar"), exact: true })).toBeVisible()
  await page.getByLabel("Solo vencidos").check()
  await expect(list).toContainText("Vencido desde el 01/04/2026")
  await list.locator(`a[href="/book/${bookId}#loans-heading"]`).click()
  const returned = panel.getByRole("form", { name: "Registrar devolución" })
  await returned.getByLabel("Fecha de devolución").fill("2026-04-05")
  await returned.getByRole("button", { name: "Registrar devolución" }).click()
  await expect(panel.getByRole("status")).toHaveText("Devolución registrada.")
  await expect(panel.getByText("Devuelto el", { exact: false })).toContainText("05/04/2026")
  await capture(page, testInfo, "prestamo-devuelto")
  await form.getByLabel("Alias de la persona").fill("Luis")
  await form.getByLabel("Fecha de salida").fill("2026-04-06")
  await form.getByRole("button", { name: "Prestar ejemplar" }).click()
  await expect(panel.getByRole("status")).toHaveText("Préstamo registrado.")
  const rows = await stack.sql`select borrower_label, returned_on::text as returned from biblib.loans where copy_id = ${bookId} order by loaned_on`
  expect(rows.map((row) => ({ ...row }))).toEqual([{ borrower_label: "Ana", returned: "2026-04-05" }, { borrower_label: "Luis", returned: null }])
  await panel.getByRole("button", { name: "Borrar préstamo", exact: true }).first().click()
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click()
  await expect(panel.getByText("Luis", { exact: true })).toBeVisible()
  await panel.getByRole("button", { name: "Borrar préstamo", exact: true }).first().click()
  await dialog.getByRole("button", { name: "Confirmar borrado" }).click()
  await expect(panel.getByRole("status")).toHaveText("Préstamo borrado del historial.")
  await expect(form).toBeVisible()
})

test("préstamos: alias rechazado conserva el borrador y no ofrece campos de contacto", async ({ page, data }) => {
  const shelf = await data.shelf("a", `Alias ${data.slug("alias")}`)
  const [bookId] = await data.books("a", shelf, [{ title: "Alias privado", status: "unread" }])
  await page.goto(`/book/${bookId}`)
  const panel = page.getByRole("region", { name: "Préstamos", exact: true })
  const form = panel.getByRole("form", { name: "Nuevo préstamo" })
  await form.getByLabel("Alias de la persona").fill("ana@example.com")
  await form.getByRole("button", { name: "Prestar ejemplar" }).click()
  await expect(panel.getByRole("alert")).toHaveText(/Escribe un alias corto/)
  await expect(form.getByLabel("Alias de la persona")).toHaveValue("ana@example.com")
  await expect(panel.locator('input[type="email"], input[type="tel"]')).toHaveCount(0)
  await form.getByLabel("Alias de la persona").fill("Ana")
  await form.getByRole("button", { name: "Prestar ejemplar" }).click()
  await expect(panel.getByRole("status")).toHaveText("Préstamo registrado.")
})

test("préstamos: contraste, diálogos y reflujo en claro y oscuro", async ({ page, data }, info) => {
  const directory = path.resolve("docs/validacion/2026-10-26/O14/pro-04")
  mkdirSync(directory, { recursive: true })
  const shelf = await data.shelf("a", `Visual ${data.slug("loans-axe")}`)
  const [bookId] = await data.books("a", shelf, [{ title: "Préstamo de prueba visual", status: "unread" }])
  await page.goto(`/book/${bookId}`)
  const panel = page.getByRole("region", { name: "Préstamos", exact: true })
  const form = panel.getByRole("form", { name: "Nuevo préstamo" })
  await form.getByLabel("Alias de la persona").fill("Vecina 3.º B")
  await form.getByLabel("Fecha de salida").fill("2026-03-29")
  await form.getByLabel("Fecha acordada (opcional)").fill("2026-04-01")
  await form.getByRole("button", { name: "Prestar ejemplar" }).click()
  await expect(panel.getByRole("status")).toHaveText("Préstamo registrado.")
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => localStorage.setItem("theme", value), theme)
    await page.reload()
    await expect(panel.getByRole("button", { name: "Borrar préstamo" })).toBeVisible()
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await noOverflow(page)
    }
    await page.waitForLoadState("networkidle")
    const detail = await new AxeBuilder({ page }).analyze()
    await panel.scrollIntoViewIfNeeded()
    await capture(page, info, `prestamos-${theme}-ficha`)
    await panel.getByRole("button", { name: "Borrar préstamo" }).click()
    const modal = await new AxeBuilder({ page }).include('[role="alertdialog"]').analyze()
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancelar", exact: true }).click()
    await page.goto("/loans")
    await expect(page.getByRole("list", { name: "Ejemplares prestados" })).toBeVisible()
    await page.waitForLoadState("networkidle")
    const list = await new AxeBuilder({ page }).analyze()
    await capture(page, info, `prestamos-${theme}-listado`)
    const report = { theme, widths: [320, 375, 768, 1440], overflow: 0, detail: detail.violations, modal: modal.violations, list: list.violations, incomplete: { detail: detail.incomplete, modal: modal.incomplete, list: list.incomplete } }
    writeFileSync(path.join(directory, `${info.project.name}-prestamos-${theme}-axe.json`), JSON.stringify(report, null, 2) + "\n")
    expect([...detail.violations, ...modal.violations, ...list.violations].filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([])
    await page.goto(`/book/${bookId}`)
  }
})

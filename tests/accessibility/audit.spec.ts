import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import AxeBuilder from "@axe-core/playwright"
import type { Page, TestInfo } from "@playwright/test"
import { alerts, expect, test } from "../e2e/lib/fixtures"

import { tabTo } from "./keyboard-helpers"

const evidence = path.resolve("docs/validacion/2026-10-24/O11/exp-03")
function save(info: TestInfo, name: string, result: unknown) {
  mkdirSync(evidence, { recursive: true })
  writeFileSync(path.join(evidence, `${info.project.name}-${name}.json`), `${JSON.stringify(result, null, 2)}\n`)
}

async function theme(page: Page, value: "light" | "dark") {
  await page.goto("/books")
  await page.evaluate((value) => localStorage.setItem("theme", value), value)
  await page.reload()
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(value === "dark")
}

async function ready(page: Page) {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  await page.waitForLoadState("networkidle")
}

async function audit(page: Page, info: TestInfo, name: string) {
  const result = await new AxeBuilder({ page }).analyze()
  // Se guardan también moderate/minor/incomplete: no se ocultan reglas ni nodos.
  save(info, name, { url: new URL(page.url()).pathname, violations: result.violations, incomplete: result.incomplete, passes: result.passes.map(({ id }) => id), engine: result.testEngine })
  expect(result.violations.filter(({ impact }) => impact === "serious" || impact === "critical").map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) }))).toEqual([])
}

for (const mode of ["light", "dark"] as const) {
  test(`axe: recorridos principales y diálogos, tema ${mode}`, async ({ page, stack }, info) => {
    await theme(page, mode)
    const id = stack.fixtureBookId("a", "isla")
    const routes = [
      ["inicio", "/"], ["tabla", "/books"], ["cuadricula", "/books?view=grid"],
      ["busqueda", "/books/search"], ["alta", "/books/add"], ["ficha", `/book/${id}`],
      ["estanterias", "/shelves"], ["3d", "/shelves/3d"], ["perfil", "/profile"],
    ] as const
    for (const [name, route] of routes) {
      await page.goto(route)
      await ready(page)
      await audit(page, info, `${mode}-${name}`)
      if (name === "alta") {
        await page.getByRole("tab", { name: "Entrada manual" }).click()
        await audit(page, info, `${mode}-alta-manual`)
      }
      if (name === "ficha") {
        await page.getByRole("button", { name: "Eliminar libro", exact: true }).click()
        await audit(page, info, `${mode}-confirmacion`)
        await page.keyboard.press("Escape")
        await page.getByRole("button", { name: "Editar ficha", exact: true }).click()
        await audit(page, info, `${mode}-edicion`)
      }
      if (name === "estanterias") {
        await page.getByRole("button", { name: "Nueva estantería", exact: true }).click()
        await audit(page, info, `${mode}-dialogo-estanteria`)
        await page.keyboard.press("Escape")
      }
    }
  })
}

test.describe("login sin sesión", () => {
  test.use({ account: "anon" })
  for (const mode of ["light", "dark"] as const) {
    test(`axe: acceso y error OAuth en tema ${mode}`, async ({ page }, info) => {
      await page.goto("/login")
      await page.evaluate((value) => localStorage.setItem("theme", value), mode)
      await page.goto("/login?error=oauth")
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
      await expect(alerts(page)).toHaveCount(1)
      await audit(page, info, `${mode}-login`)
      for (const width of [320, 375, 768, 1440, 640]) {
        await page.setViewportSize({ width, height: width === 320 ? 256 : width === 640 ? 512 : 900 })
        await noOverflow(page)
      }
    })
  }
})

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
}

test("reflujo: 320, 375, 768, 1440 y zoom equivalente 200/400 % en ambos temas", async ({ page, stack }, info) => {
  test.setTimeout(300_000)
  const routes = ["/", "/books", "/books?view=grid", "/books/search", "/books/add", `/book/${stack.fixtureBookId("a", "isla")}`, "/shelves", "/shelves/3d", "/profile"]
  for (const mode of ["light", "dark"] as const) {
    await theme(page, mode)
    for (const width of [320, 375, 768, 1440, 640]) {
      await page.setViewportSize({ width, height: width === 320 ? 256 : width === 640 ? 512 : 900 })
      for (const route of routes) {
        await page.goto(route)
        await ready(page)
        await noOverflow(page)
        if (route === "/books") {
          const region = page.getByRole("region", { name: "Tabla de libros, desplazamiento horizontal" })
          await expect(region).toHaveAttribute("tabindex", "0")
          if (width === 320) await page.screenshot({ path: path.join(evidence, `${info.project.name}-${mode}-320-tabla.png`), fullPage: true })
        }
        if (route === "/books/add") {
          await page.getByRole("tab", { name: "Entrada manual" }).click()
          await noOverflow(page)
        }
        if (route.startsWith("/book/")) {
          await page.getByRole("button", { name: "Editar ficha" }).click()
          await noOverflow(page)
        }
        if (route === "/shelves") {
          await page.getByRole("button", { name: "Nueva estantería", exact: true }).click()
          const dialog = page.getByRole("dialog")
          await expect(dialog).toBeVisible()
          await noOverflow(page)
          expect(await dialog.evaluate((element) => { const box = element.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight + 1 && element.scrollHeight >= element.clientHeight })).toBe(true)
          if (width === 320) await page.screenshot({ path: path.join(evidence, `${info.project.name}-${mode}-400-dialogo.png`) })
          if (width === 320) {
            for (let key = 0; key < 6; key++) {
              await page.keyboard.press("Tab")
              expect(await dialog.evaluate((element) => {
                const focused = document.activeElement
                if (!(focused instanceof HTMLElement) || !element.contains(focused)) return false
                const outer = element.getBoundingClientRect(), inner = focused.getBoundingClientRect()
                return inner.top >= outer.top && inner.bottom <= outer.bottom + 1
              })).toBe(true)
            }
          }
          await page.keyboard.press("Escape")
        }
      }
    }
  }
  save(info, "reflujo", { themes: ["light", "dark"], widths: [320, 375, 768, 1440], zoom: [{ percent: 200, reference: "1280×1024", viewport: "640×512" }, { percent: 400, reference: "1280×1024", viewport: "320×256" }], routes, overflow: 0 })
})

test("diálogos: atrapan/devuelven foco, menú móvil, errores únicos y movimiento reducido", async ({ page, stack, data }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/shelves")
  await ready(page)
  const trigger = page.getByRole("button", { name: "Nueva estantería", exact: true })
  await tabTo(page, trigger)
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("textbox", { name: "Nombre de la estantería" })).toBeFocused()
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press(i < 12 ? "Tab" : "Shift+Tab")
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  }
  expect(await dialog.evaluate((element) => element.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running"))).toBe(true)
  await page.keyboard.press("Escape")
  await expect(trigger).toBeFocused()
  const slug = data.slug("errorunico")
  const [id] = await data.books("a", await data.defaultShelf("a"), [{ title: `Error ${slug}` }])
  await page.goto(`/book/${id}`)
  await ready(page)
  await stack.sql`update biblib.books set subtitle = 'Versión concurrente ficticia' where id = ${id}`
  const remove = page.getByRole("button", { name: "Eliminar libro", exact: true })
  await tabTo(page, remove)
  await page.keyboard.press("Enter")
  const confirmation = page.getByRole("alertdialog")
  await expect(confirmation.getByRole("button", { name: "Cancelar", exact: true })).toBeFocused()
  await page.keyboard.press("Tab")
  await page.keyboard.press("Enter")
  await expect(confirmation.getByRole("alert")).toHaveCount(1)
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(remove).toBeFocused()
  await page.setViewportSize({ width: 320, height: 640 })
  const menu = page.locator('button[aria-controls="mobile-navigation"]')
  await tabTo(page, menu)
  await page.keyboard.press("Enter")
  await expect(menu).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("Tab")
  await expect(page.getByRole("navigation", { name: "Navegación móvil" }).getByRole("link", { name: "Inicio", exact: true })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(menu).toBeFocused()
  await page.goto("/books/add")
  await ready(page)
  await tabTo(page, page.getByRole("textbox", { name: "Número ISBN" }))
  await page.keyboard.type("123")
  await page.keyboard.press("Enter")
  await expect(alerts(page)).toHaveCount(1)
  await expect(alerts(page)).toHaveText("El ISBN no es válido. Comprueba sus 10 o 13 dígitos.")
  expect(await alerts(page).evaluate((element) => !element.hasAttribute("aria-live") && !element.parentElement?.closest("[aria-live],[role=alert]"))).toBe(true)
  save(info, "foco-movimiento-errores", { dialog: "atrapa y devuelve foco", mobileMenu: "Escape devuelve al disparador", errors: 1, reducedMotion: "sin animaciones activas" })
})

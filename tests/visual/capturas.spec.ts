import { mkdirSync } from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../e2e/lib/fixtures"

// U-UX-01: capturas de inicio, colección, ficha, estanterías y acceso a 1440 y 375 px en ambos temas.
// Solo datos ficticios del censo (cuenta A); la fase (antes/despues) decide la carpeta de evidencia.
const phase = process.env.UX_CAPTURE_PHASE === "antes" ? "antes" : "despues"
const out = path.resolve("docs/validacion/2026-10-26/UX/ux-01/capturas", phase)
const widths = [1440, 375] as const
const themes = ["light", "dark"] as const

async function setTheme(page: Page, theme: (typeof themes)[number]) {
  await page.evaluate((value) => localStorage.setItem("theme", value), theme)
  await page.reload()
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark")
}

async function shoot(page: Page, name: string) {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  await page.waitForLoadState("networkidle")
  // Espera a fuentes e imágenes para que la captura sea estable.
  await page.evaluate(() => document.fonts.ready)
  mkdirSync(out, { recursive: true })
  for (const theme of themes) {
    await setTheme(page, theme)
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
    await page.waitForLoadState("networkidle")
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: path.join(out, `${name}-${page.viewportSize()?.width}-${theme === "light" ? "claro" : "oscuro"}.jpg`), fullPage: true, type: "jpeg", quality: 82, animations: "disabled" })
  }
}

test("capturas con sesión de A", async ({ page, stack }) => {
  const routes = [["inicio", "/"], ["coleccion", "/books"], ["ficha", `/book/${stack.fixtureBookId("a", "isla")}`], ["estanterias", "/shelves"]] as const
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 })
    for (const [name, route] of routes) {
      await page.goto(route)
      await shoot(page, name)
    }
  }
})

test.describe("sin sesión", () => {
  test.use({ account: "anon" })
  test("capturas del acceso", async ({ page }) => {
    for (const width of widths) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 })
      await page.goto("/login")
      await shoot(page, "acceso")
    }
  })
})

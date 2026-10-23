import { alerts, expect, test } from "../lib/fixtures"

// Presentación heredada del smoke: acceso con tema oscuro y móvil sin desbordamiento, colección móvil y
// ningún botón anidado en enlaces. La revisión visual y de lector completa corresponde a U-EXP-03.

test.describe("anónimo", () => {
  test.use({ account: "anon", viewport: { width: 375, height: 812 } })

  test("acceso en móvil con tema oscuro, sin desbordamiento y con el error OAuth visible", async ({ page }) => {
    await page.goto("/login?error=oauth")
    await expect(alerts(page)).toHaveText("No se pudo completar el acceso con Google. Vuelve a intentarlo.")
    await page.evaluate(() => localStorage.setItem("theme", "dark"))
    await page.goto("/login")
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark") && getComputedStyle(document.documentElement).colorScheme === "dark")).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
})

test.describe("con sesión de A", () => {
  test("inicio y colección sin botones anidados ni desbordamiento en móvil", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByText("El cuaderno de la bruma").first()).toBeVisible()
    expect(await page.locator("a button, button a").count()).toBe(0)
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto("/books")
    await expect(page.getByText(/\d+ resultados?/)).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
})

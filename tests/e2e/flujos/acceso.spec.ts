import { randomUUID } from "node:crypto"
import { accountMenu, alerts, expect, localLoginForm, test } from "../lib/fixtures"

// Acceso: ruta privada directa, destino interno conservado y callback inválido. La renovación, el
// cierre y el cambio de cuenta revocan sesiones y viven en cierre/acceso-sesion.spec.ts.

test.describe("anónimo", () => {
  test.use({ account: "anon" })

  test("una ruta privada directa lleva al acceso conservando el destino interno", async ({ page }) => {
    await page.goto("/books?status=read&page=2")
    await page.waitForURL((url) => url.pathname === "/login")
    expect(new URL(page.url()).searchParams.get("redirect")).toBe("/books?status=read&page=2")
    await expect(localLoginForm(page)).toBeVisible()
    await expect(page.getByRole("button", { name: "Continuar con Google" })).toBeVisible()
    const login = await page.request.get("/login")
    expect(login.headers()["x-content-type-options"]).toBe("nosniff")
    expect(login.headers()["x-frame-options"]).toBe("DENY")

    await page.goto(`/book/${randomUUID()}`)
    await page.waitForURL((url) => url.pathname === "/login")
    expect(new URL(page.url()).searchParams.get("redirect")).toMatch(/^\/book\/[0-9a-f-]{36}$/)
  })

  test("un callback OAuth inválido vuelve al acceso con error y sin destino externo", async ({ page, stack }) => {
    await page.goto("/auth/callback?next=https%3A%2F%2Fexample.invalid%2Frobo")
    await page.waitForURL((url) => url.pathname === "/login")
    const url = new URL(page.url())
    expect(url.origin).toBe(new URL(stack.appUrl).origin)
    expect(url.searchParams.get("error")).toBe("oauth")
    expect(url.searchParams.get("redirect")).toBe("/")
    await expect(alerts(page)).toHaveText("No se pudo completar el acceso con Google. Vuelve a intentarlo.")

    await page.goto("/auth/callback?code=codigo-falso&next=%2Fbooks%3Fstatus%3Dread")
    await page.waitForURL((url) => url.pathname === "/login")
    expect(new URL(page.url()).searchParams.get("error")).toBe("oauth")
    expect(new URL(page.url()).searchParams.get("redirect")).toBe("/books?status=read")
  })
})

test.describe("con sesión de A", () => {
  test("/login con destino interno lleva a él; los destinos externos caen en el inicio", async ({ page, stack }) => {
    await page.goto("/login?redirect=%2Fbooks%3Fstatus%3Dread")
    await page.waitForURL((url) => url.pathname === "/books")
    expect(new URL(page.url()).searchParams.get("status")).toBe("read")
    await expect(page.getByRole("combobox", { name: "Filtrar por estado" })).toHaveText("Leído")
    await expect(accountMenu(page, stack, "a")).toBeVisible()

    for (const external of ["https://example.invalid/robo", "//example.invalid/robo", "/\\example.invalid"]) {
      await page.goto(`/login?redirect=${encodeURIComponent(external)}`)
      await page.waitForURL((url) => url.pathname === "/" && url.origin === new URL(stack.appUrl).origin)
    }
  })
})

import { mkdirSync } from "node:fs"
import path from "node:path"
import { accountMenu, expect, loginWithForm, stateFile, test, type Account } from "./lib/fixtures"

// Primer ensayo real de U-LOC-01 contra GoTrue: A y B entran por el formulario «Acceso local de
// desarrollo» y su sesión (cookies SSR reales) se guarda en .biblib/e2e/state para los recorridos.

test.use({ account: "anon" })

for (const account of ["a", "b"] as const satisfies readonly Account[]) {
  test(`acceso local: ${account.toUpperCase()} entra por el formulario y conserva la sesión`, async ({ page, stack }, testInfo) => {
    await page.goto("/login")
    await expect(page).toHaveTitle("Acceso · BibLib")
    await loginWithForm(page, stack, account)
    await page.waitForURL((url) => url.pathname === "/")
    await expect(accountMenu(page, stack, account)).toBeVisible()
    const cookies = await page.context().cookies()
    expect(cookies.some((cookie) => /^sb-.+-auth-token(\.\d+)?$/.test(cookie.name)), "La sesión vive en cookies SSR de @supabase/ssr").toBe(true)
    const file = stateFile(testInfo, account)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    await page.context().storageState({ path: file })
  })
}

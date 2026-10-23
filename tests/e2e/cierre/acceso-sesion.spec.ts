import { readSession, withExpiredAccess } from "../../integration/lib/sessions.mjs"
import { accountMenu, expect, fillSecret, localLoginForm, loginWithForm, SIGN_OUT_RSC_404, signOut, test } from "../lib/fixtures"

// Cierre de cada navegador (después de los flujos, porque revoca las sesiones guardadas de A y B):
// destino interno tras entrar, renovación real, cierre, cambio de cuenta A→B sin restos, destino externo
// rechazado y, al final, mensajes genéricos y limitador del acceso local (U-LOC-01) contra GoTrue.

test.use({ account: "anon" })
test.describe.configure({ mode: "serial" })

type Cookie = { name: string; value: string }
const sessionCookies = (cookies: Cookie[]) => cookies.filter((cookie) => /^sb-.+-auth-token(\.\d+)?$/.test(cookie.name) && cookie.value !== "")

test("sesión: destino interno, renovación, cierre y cambio de cuenta A→B sin restos", async ({ page, context, stack, guard }) => {
  guard.allowConsole(SIGN_OUT_RSC_404)
  const appOrigin = new URL(stack.appUrl).origin

  await test.step("una ruta privada directa vuelve a su destino tras entrar por el formulario", async () => {
    await page.goto("/books?status=read&view=grid")
    await page.waitForURL((url) => url.pathname === "/login")
    await loginWithForm(page, stack, "a")
    await page.waitForURL((url) => url.pathname === "/books" && url.searchParams.get("status") === "read" && url.searchParams.get("view") === "grid")
    await expect(page.getByRole("link", { name: "La isla de papel", exact: true })).toBeVisible()
  })

  await test.step("una sesión vencida se renueva con GoTrue y conserva la página", async () => {
    const current = sessionCookies(await context.cookies())
    const before = readSession(current)
    expect(before?.user?.id).toBe(stack.users.a)
    const aged = withExpiredAccess(current.map(({ name, value }) => ({ name, value })))
    await context.clearCookies({ name: /^sb-.+-auth-token/ })
    await context.addCookies(aged.map(({ name, value }) => ({ name, value, url: stack.appUrl, sameSite: "Lax" as const })))
    await page.goto("/books?status=read")
    await expect(page).toHaveURL(/\/books\?status=read$/)
    await expect(accountMenu(page, stack, "a")).toBeVisible()
    const after = readSession(sessionCookies(await context.cookies()))
    expect(after?.user?.id).toBe(stack.users.a)
    expect(after?.access_token !== before?.access_token, "La renovación emite un access token nuevo").toBe(true)
    expect(Number(after?.expires_at) > Date.now() / 1000, "El token renovado no está vencido").toBe(true)
  })

  await test.step("cerrar sesión elimina la vista privada y revoca la copia de las cookies", async () => {
    const copy = sessionCookies(await context.cookies())
    await signOut(page, stack, "a")
    expect(sessionCookies(await context.cookies())).toEqual([])
    await page.goto("/books")
    await page.waitForURL((url) => url.pathname === "/login")
    await context.addCookies(copy.map(({ name, value }) => ({ name, value, url: stack.appUrl, sameSite: "Lax" as const })))
    await page.goto("/books")
    await page.waitForURL((url) => url.pathname === "/login")
    await context.clearCookies()
  })

  await test.step("entrar como B en el mismo navegador no deja restos de A", async () => {
    await page.goto("/login")
    await loginWithForm(page, stack, "b")
    await page.waitForURL((url) => url.pathname === "/")
    await expect(accountMenu(page, stack, "b")).toBeVisible()
    expect(readSession(sessionCookies(await context.cookies()))?.user?.id).toBe(stack.users.b)
    await page.goto("/books")
    await expect(page.getByRole("row").filter({ hasText: "Versos para un faro" })).toBeVisible()
    await expect(page.getByText("El cuaderno de la bruma")).toHaveCount(0)
    const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))
    for (const trace of [stack.users.a, stack.email("a"), "El cuaderno de la bruma", stack.displayName("a")]) expect(stored.includes(trace), "Sin restos de A en el almacenamiento del navegador").toBe(false)
    await page.goto(`/book/${stack.fixtureBookId("a", "cuaderno")}`)
    await expect(page.getByRole("heading", { name: "Libro no encontrado" })).toBeVisible()
    await signOut(page, stack, "b")
  })

  await test.step("un destino externo en ?redirect= se sustituye por el inicio", async () => {
    await page.goto(`/login?redirect=${encodeURIComponent("https://example.invalid/robo")}`)
    await loginWithForm(page, stack, "a")
    await page.waitForURL((url) => url.origin === appOrigin && url.pathname === "/")
    await expect(accountMenu(page, stack, "a")).toBeVisible()
    await signOut(page, stack, "a")
  })
})

test("acceso local: errores genéricos y limitador de intentos fallidos", async ({ page, stack, guard }) => {
  test.setTimeout(180_000)
  guard.allowConsole(SIGN_OUT_RSC_404)
  await page.goto("/login")
  const form = localLoginForm(page)
  const email = form.getByLabel("Correo")
  const password = form.getByLabel("Contraseña")
  const alert = form.getByRole("alert")
  const attempt = async (address: string, secret: string) => {
    await email.fill(address)
    await fillSecret(password, secret)
    await form.getByRole("button", { name: "Entrar" }).click()
    await expect(form.getByRole("button", { name: "Entrar" })).toBeEnabled()
  }

  // Un formato inválido se rechaza sin consultar GoTrue ni contar como fallo.
  await attempt("no-es-un-correo", "cualquiera")
  await expect(alert).toHaveText("Introduce un correo con formato válido (máximo 254 caracteres).")

  // Cuenta existente con contraseña errónea y cuenta inexistente: el mismo mensaje.
  const wrong = `incorrecta-${stack.runId}`
  for (const address of [stack.email("a"), "nadie@biblib.test", stack.email("a"), stack.email("b"), stack.email("a")]) {
    await attempt(address, wrong)
    await expect(alert).toHaveText("Correo o contraseña incorrectos.")
    await expect(password).toHaveValue("")
    await expect(page).toHaveURL(/\/login$/)
  }

  // Sexto intento en el minuto: bloqueado incluso con la contraseña correcta (no llega a GoTrue).
  await attempt(stack.email("a"), stack.password("a"))
  await expect(alert).toHaveText("Demasiados intentos fallidos. Espera un minuto antes de volver a probar.")
  await expect(page).toHaveURL(/\/login$/)

  // Pasado el minuto el limitador libera el acceso; así no contamina al navegador siguiente.
  await page.waitForTimeout(61_000)
  await loginWithForm(page, stack, "a")
  await page.waitForURL((url) => url.pathname === "/")
  await expect(accountMenu(page, stack, "a")).toBeVisible()
  await signOut(page, stack, "a")
})

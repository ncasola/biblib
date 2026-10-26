import { readFileSync } from "node:fs"
import type { BrowserContext, Page, TestInfo } from "@playwright/test"
import { alerts, capture, expect, SIGN_OUT_RSC_404, signOut, stateFile, test, type Account, type Guard } from "../lib/fixtures"

// U-EXP-08 · PWA con consulta sin conexión de solo lectura (puerta G15). El worker solo funciona con el build
// de producción que arranca el runner (la bandera BIBLIB_OFFLINE_SNAPSHOT=1 la fija tests/e2e/run.mjs). Cada
// prueba usa su propio contexto: worker, cachés e IndexedDB empiezan vacíos y se descartan al terminar. Nada
// escribe en la base: la copia es de solo lectura. El cierre de sesión simula la respuesta de GoTrue para no
// revocar las sesiones guardadas de los demás recorridos (la revocación real la cubre cierre/acceso-sesion).

const PIN_A = "246810"
const PHRASE_B = "faro del norte"
const BOOKS_A = ["El cuaderno de la bruma", "La isla de papel", "El reloj de las mareas", "Mapas de una ciudad inventada"]
const ONLY_B = "Versos para un faro"
const STATIC_PATHS = new Set(["/offline", "/logo-mark.png", "/logo.png", "/logo-transparent.png", "/logo-dark.png", "/manifest.webmanifest", "/default-book-cover.webp"])
/** Peticiones que fallan a propósito sin red (refresco de sesión, recursos de la página) y su registro en consola. */
const OFFLINE_CONSOLE = /net::ERR_INTERNET_DISCONNECTED|Failed to fetch|AuthRetryableFetchError|ERR_NAME_NOT_RESOLVED/

// WebKit bloquea los workers en todo su proyecto (playwright.config.ts); aquí son el objeto de la prueba.
test.use({ account: "a", serviceWorkers: "allow" })

function allowOffline(guard: Guard) {
  guard.allowConsole(OFFLINE_CONSOLE)
}

async function workerReady(page: Page): Promise<void> {
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
}

const offlineDatabases = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map((entry) => entry.name ?? "").filter((name) => name.startsWith("biblib-offline-")))

const cachedEntries = (page: Page) => page.evaluate(async () => {
  const entries: Record<string, string[]> = {}
  for (const key of await caches.keys()) entries[key] = (await (await caches.open(key)).keys()).map((request) => { const url = new URL(request.url); return `${url.pathname}${url.search}` })
  return entries
})

const workerInfo = (page: Page) => page.evaluate(() => new Promise<{ version: string; cleanup: boolean; cache: string }>((resolve, reject) => {
  const channel = new MessageChannel()
  channel.port1.onmessage = (event) => resolve(event.data)
  const controller = navigator.serviceWorker.controller
  if (!controller) { reject(new Error("Sin worker")); return }
  controller.postMessage({ type: "biblib:version" }, [channel.port2])
}))

function copySection(page: Page) {
  return page.locator("section[data-offline-copy]")
}

async function enableCopy(page: Page, secret: string): Promise<void> {
  await page.goto("/settings")
  const section = copySection(page)
  await expect(section).toHaveAttribute("data-offline-copy", "none")
  await section.getByLabel("PIN o frase", { exact: true }).fill(secret)
  await section.getByLabel("Repite el PIN o la frase").fill(secret)
  await section.getByRole("checkbox").check()
  await section.getByRole("button", { name: "Guardar copia de lectura en este dispositivo" }).click()
  await expect(section.getByRole("status").filter({ hasText: "Copia de lectura guardada" })).toBeVisible()
  await expect(section).toHaveAttribute("data-offline-copy", "locked")
}

async function unlock(page: Page, secret: string): Promise<void> {
  await page.getByLabel("PIN o frase de la copia").fill(secret)
  await page.getByRole("button", { name: "Abrir copia" }).click()
}

/** Retrasa la última validación de la copia de esta página (como si llevara `days` días sin conexión). */
async function ageValidation(page: Page, days: number): Promise<void> {
  await page.evaluate(async (ms) => {
    const [entry] = (await indexedDB.databases()).filter((database) => database.name?.startsWith("biblib-offline-"))
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(entry.name!); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const store = db.transaction("copia", "readwrite").objectStore("copia")
    const meta = await new Promise<{ validatedAt: string }>((resolve) => { const request = store.get("meta"); request.onsuccess = () => resolve(request.result) })
    await new Promise((resolve) => { const request = store.put({ ...meta, validatedAt: new Date(Date.now() - ms).toISOString() }, "meta"); request.onsuccess = resolve })
    db.close()
  }, days * 24 * 60 * 60 * 1000)
}

/** Cambia la sesión del contexto a la otra cuenta sin cerrar sesión (las sesiones guardadas siguen vivas). */
async function useSessionOf(context: BrowserContext, testInfo: TestInfo, account: Account) {
  const state = JSON.parse(readFileSync(stateFile(testInfo, account), "utf8")) as { cookies: Parameters<BrowserContext["addCookies"]>[0] }
  await context.clearCookies()
  await context.addCookies(state.cookies)
}

/**
 * Firefox no puede recorrer estas pruebas: con `context.setOffline` de Playwright (el modo «Trabajar sin conexión»)
 * ninguna navegación llega al worker, ni siquiera la de /offline, y `page.goto` responde NS_ERROR_OFFLINE (G16,
 * comprobado con `location.assign` y con la red cortada por `route`: las peticiones del worker no pasan por ella).
 * Abrir /offline con red no sirve: la validación con conexión renovaría el TTL que se está probando.
 */
const FIREFOX_OFFLINE = "Firefox con Playwright no deja que el worker atienda navegaciones sin red (NS_ERROR_OFFLINE); cubierto en Chromium y WebKit. Ver docs/validacion/2026-10-26/O16/xb/informe.md."

/**
 * Si el motor detecta una clave AES-KW equivocada (RFC 3394). El WebKit 27.2 de Playwright en Windows no lo hace:
 * desenvuelve con cualquier PIN y la copia se ve «dañada» al descifrar (G16). Chrome, Firefox y Safari sí.
 */
async function aesKwRejectsWrongKey(page: Page, testInfo: TestInfo): Promise<boolean> {
  const rejects = await page.evaluate(async () => {
    const subtle = crypto.subtle
    const kek = () => subtle.generateKey({ name: "AES-KW", length: 256 }, false, ["wrapKey", "unwrapKey"])
    const data = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"])
    const wrapped = await subtle.wrapKey("raw", data, await kek(), "AES-KW")
    try { await subtle.unwrapKey("raw", wrapped, await kek(), "AES-KW", "AES-GCM", false, ["encrypt"]); return false } catch { return true }
  })
  if (!rejects) testInfo.annotations.push({ type: "omisión parcial", description: "Este motor no comprueba la integridad de AES-KW: no se prueba el aviso de PIN o frase incorrectos (sí en Chromium)." })
  return rejects
}

function noSaveControls(page: Page) {
  return page.getByRole("main").getByRole("button", { name: /guardar|editar|eliminar|añadir|mover|cambiar|prestar|devolver/i })
}

test("offline: sin consentimiento solo hay shell estático, sin base IndexedDB ni caché privada", async ({ page, stack }) => {
  const worker = await page.request.get("/sw.js")
  expect(worker.ok()).toBe(true)
  expect(worker.headers()["cache-control"], "El worker nunca lleva caché larga").toBe("private, no-store")
  const manifest = await (await page.request.get("/manifest.webmanifest")).json() as { icons: { src: string; purpose: string }[] }
  expect(manifest.icons).toEqual(expect.arrayContaining([expect.objectContaining({ src: "/logo-mark.png", purpose: "any" }), expect.objectContaining({ src: "/logo.png", purpose: "maskable" })]))

  for (const route of ["/", "/books", `/book/${stack.fixtureBookId("a", "cuaderno")}`, "/settings"]) {
    await page.goto(route)
    await page.waitForLoadState("networkidle")
  }
  await workerReady(page)
  await expect(copySection(page)).toHaveAttribute("data-offline-copy", "none")
  expect(await offlineDatabases(page)).toEqual([])
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("biblib-offline")))).toEqual([])

  const entries = await cachedEntries(page)
  const keys = Object.keys(entries)
  expect(keys).toHaveLength(1)
  expect(keys[0]).toMatch(/^biblib-shell-/)
  for (const entry of entries[keys[0]]) {
    expect(entry.startsWith("/_next/static/") || STATIC_PATHS.has(entry), `Solo estáticos: ${entry}`).toBe(true)
  }
  expect(entries[keys[0]]).toContain("/offline")
  // La página guardada se pidió sin cookies: no contiene nada de la cuenta.
  const html = await page.evaluate(async (key) => (await (await caches.open(key)).match("/offline"))?.text() ?? "", keys[0])
  for (const trace of [stack.email("a"), stack.users.a, "El cuaderno de la bruma", stack.displayName("a")]) expect(html.includes(trace)).toBe(false)
})

test("offline: activar con PIN y consultar sin conexión una copia de solo lectura con su antigüedad", async ({ page, context, guard, browserName }, testInfo) => {
  test.skip(browserName === "firefox", FIREFOX_OFFLINE)
  test.setTimeout(120_000)
  allowOffline(guard)
  await page.emulateMedia({ colorScheme: "light" })
  await page.goto("/settings")
  await workerReady(page)
  await expect(copySection(page)).toHaveAttribute("data-offline-copy", "none")
  await copySection(page).getByLabel("PIN o frase", { exact: true }).fill("12345")
  await copySection(page).getByLabel("Repite el PIN o la frase").fill("12345")
  await copySection(page).getByRole("checkbox").check()
  await copySection(page).getByRole("button", { name: "Guardar copia de lectura en este dispositivo" }).click()
  await expect(copySection(page).getByRole("alert")).toHaveText("El PIN debe tener al menos 6 dígitos.")
  expect(await offlineDatabases(page)).toEqual([])

  await enableCopy(page, PIN_A)
  expect(await offlineDatabases(page)).toHaveLength(1)
  await expect(copySection(page).getByText(/^l•••@b•••\.test$/)).toBeVisible()
  await copySection(page).scrollIntoViewIfNeeded()
  await capture(page, testInfo, "offline-ajuste-claro")
  await page.emulateMedia({ colorScheme: "dark" })
  await capture(page, testInfo, "offline-ajuste-oscuro")

  await context.setOffline(true)
  // Sin red, cualquier navegación lleva a la vista sin conexión servida por el worker.
  await page.goto("/books")
  await expect(page).toHaveURL(/\/offline$/)
  await expect(page).toHaveTitle("Sin conexión · BibLib")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Copia del /)
  await expect(page.getByText("l•••@b•••.test")).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "Sin conexión" })).toBeVisible()
  await capture(page, testInfo, "offline-bloqueada-oscuro")

  if (await aesKwRejectsWrongKey(page, testInfo)) {
    await unlock(page, "000000")
    await expect(alerts(page)).toContainText("Te quedan 9 intentos")
  }
  await unlock(page, PIN_A)
  const list = page.getByRole("list", { name: "Libros de la copia" })
  for (const title of BOOKS_A) await expect(list.getByRole("heading", { name: title })).toBeVisible()
  await expect(page.getByText(/4 libros en la copia/)).toBeVisible()
  await expect(page.getByText(ONLY_B)).toHaveCount(0)
  await expect(noSaveControls(page)).toHaveCount(0)
  await capture(page, testInfo, "offline-copia-oscuro")
  await page.emulateMedia({ colorScheme: "light" })
  await capture(page, testInfo, "offline-copia-claro")

  await page.getByLabel("Buscar en la copia").fill("bruma")
  await expect(page.getByText(/^1 libro con estos filtros$/)).toBeVisible()
  await page.getByRole("button", { name: "Bloquear copia" }).click()
  await expect(page.getByLabel("PIN o frase de la copia")).toBeVisible()
  await expect(page.getByText("El cuaderno de la bruma")).toHaveCount(0)
  await page.emulateMedia({ colorScheme: "light" })
  await capture(page, testInfo, "offline-bloqueada-claro")

  // Con red otra vez, la copia se renueva con el mismo PIN y conserva una sola base.
  await context.setOffline(false)
  await page.goto("/settings")
  await copySection(page).getByRole("button", { name: "Renovar copia" }).click()
  await copySection(page).getByLabel("PIN o frase de esta copia").fill(PIN_A)
  await copySection(page).getByRole("button", { name: "Descargar datos actuales" }).click()
  await expect(copySection(page).getByRole("status").filter({ hasText: "Copia renovada: 4 libros" })).toBeVisible()
  expect(await offlineDatabases(page)).toHaveLength(1)
})

test("offline: A y B en el mismo navegador no ven la copia del otro", async ({ page, context, guard, browserName }, testInfo) => {
  test.skip(browserName === "firefox", FIREFOX_OFFLINE)
  test.setTimeout(150_000)
  allowOffline(guard)
  await page.goto("/settings")
  await workerReady(page)
  await enableCopy(page, PIN_A)

  // B entra en el mismo navegador: la vista sin conexión pasa a ser la de B y la de A queda bloqueada.
  await useSessionOf(context, testInfo, "b")
  await page.goto("/settings")
  await expect(copySection(page)).toHaveAttribute("data-offline-copy", "none")
  await context.setOffline(true)
  await page.goto("/offline")
  await expect(page.getByText(/No hay ninguna copia de lectura disponible/)).toBeVisible()
  for (const title of BOOKS_A) await expect(page.getByText(title)).toHaveCount(0)
  await expect(page.getByText("l•••@b•••.test")).toHaveCount(0)

  await context.setOffline(false)
  await enableCopy(page, PHRASE_B)
  expect(await offlineDatabases(page)).toHaveLength(2)
  await context.setOffline(true)
  await page.goto("/offline")
  const wrongSecretRejected = await aesKwRejectsWrongKey(page, testInfo)
  if (wrongSecretRejected) {
    await unlock(page, PIN_A)
    await expect(alerts(page)).toContainText("no son correctos")
  }
  await unlock(page, PHRASE_B)
  await expect(page.getByRole("heading", { name: ONLY_B })).toBeVisible()
  await expect(page.getByText("El cuaderno de la bruma")).toHaveCount(0)

  // Vuelve A con conexión: la vista de B se bloquea y solo el PIN de A abre la de A.
  await context.setOffline(false)
  await useSessionOf(context, testInfo, "a")
  await page.goto("/settings")
  await expect(copySection(page)).toHaveAttribute("data-offline-copy", "locked")
  await context.setOffline(true)
  await page.goto("/offline")
  if (wrongSecretRejected) {
    await unlock(page, PHRASE_B)
    await expect(alerts(page)).toContainText("no son correctos")
  }
  await unlock(page, PIN_A)
  await expect(page.getByRole("heading", { name: "El cuaderno de la bruma" })).toBeVisible()
  await expect(page.getByText(ONLY_B)).toHaveCount(0)
})

test.describe(() => {
  // WebKit no aplica page.route a las peticiones de una página controlada por el worker (la de GoTrue pasa
  // por su evento fetch aunque no la responda): el logout real con scope=global revocaba las sesiones
  // guardadas de A para el resto del proyecto (G16). La purga al cerrar sesión la hace la página, no el
  // worker, así que en WebKit se comprueba sin worker y en Chromium/Firefox con él.
  test.use({ serviceWorkers: async ({ browserName }, provide) => provide(browserName === "webkit" ? "block" : "allow") })

  test("offline: el cierre de sesión con conexión borra la copia y su clave del dispositivo", async ({ page, stack, guard, browserName }) => {
    test.setTimeout(120_000)
    guard.allowConsole(SIGN_OUT_RSC_404)
    // GoTrue responde sin revocar: las sesiones guardadas de A siguen sirviendo a los demás recorridos.
    let logouts = 0
    await page.route(`${stack.apiOrigin}/auth/v1/logout**`, (route) => { logouts++; return route.fulfill({ status: 204, body: "" }) })
    await page.goto("/settings")
    if (browserName !== "webkit") await workerReady(page)
    await enableCopy(page, PIN_A)
    expect(await offlineDatabases(page)).toHaveLength(1)
    expect(await page.evaluate(() => localStorage.getItem("biblib-offline-cuenta"))).toMatch(/^[0-9a-f]{64}$/)

    await signOut(page, stack, "a")
    expect(logouts, "El cierre de sesión se simula: una revocación real dejaría sin sesión al resto del proyecto").toBe(1)
    await expect.poll(() => offlineDatabases(page)).toEqual([])
    expect(await page.evaluate(() => localStorage.getItem("biblib-offline-cuenta"))).toBeNull()
    await page.goto("/offline")
    await expect(page.getByText(/No hay ninguna copia de lectura disponible/)).toBeVisible()
  })
})

test("offline: un TTL vencido bloquea la copia sin borrarla y la validación con conexión la reabre", async ({ page, context, guard, browserName }) => {
  test.skip(browserName === "firefox", FIREFOX_OFFLINE)
  test.setTimeout(120_000)
  allowOffline(guard)
  await page.goto("/settings")
  await workerReady(page)
  await enableCopy(page, PIN_A)

  // Reloj simulado solo sin conexión: 8 días después de la última validación.
  await context.setOffline(true)
  await page.clock.setFixedTime(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000))
  await page.goto("/offline")
  await expect(page.getByText("Copia bloqueada por caducidad")).toBeVisible()
  await expect(page.getByLabel("PIN o frase de la copia")).toHaveCount(0)
  expect(await offlineDatabases(page), "Vencer no borra la copia").toHaveLength(1)

  // De vuelta al reloj real, la copia sigue vencida (su última validación fue hace 8 días) hasta validarla con conexión.
  await page.clock.setFixedTime(new Date())
  await ageValidation(page, 8)
  await page.goto("/offline")
  await expect(page.getByText("Copia bloqueada por caducidad")).toBeVisible()
  await context.setOffline(false)
  await page.goto("/settings")
  await expect(copySection(page)).toHaveAttribute("data-offline-copy", "locked")
  await context.setOffline(true)
  await page.goto("/offline")
  await unlock(page, PIN_A)
  await expect(page.getByRole("heading", { name: "El cuaderno de la bruma" })).toBeVisible()
})

test("offline: una versión nueva del worker borra las cachés anteriores y conserva la copia", async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto("/settings")
  await workerReady(page)
  await enableCopy(page, PIN_A)
  const current = await workerInfo(page)
  expect(current.cleanup).toBe(false)
  expect(Object.keys(await cachedEntries(page))).toEqual([current.cache])

  const changed = page.evaluate(() => new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true })))
  await page.evaluate(async () => { await navigator.serviceWorker.register("/sw.js?v=e2e-actualizacion", { scope: "/", updateViaCache: "none" }) })
  await changed
  await expect.poll(async () => Object.keys(await cachedEntries(page))).toEqual(["biblib-shell-e2e-actualizacion"])
  expect((await workerInfo(page)).version).toBe("e2e-actualizacion")

  // La página vuelve a registrar la versión publicada: se instala y borra la caché de la versión de prueba.
  await page.reload()
  // La instalación descarga /offline y sus estáticos antes de activarse: se espera al worker activo de esa versión.
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.scriptURL ?? ""), { timeout: 30_000 }).toContain(`v=${current.version}`)
  await expect.poll(async () => Object.keys(await cachedEntries(page)), { timeout: 30_000 }).toEqual([current.cache])
  await expect.poll(async () => (await workerInfo(page)).version).toBe(current.version)
  expect(await offlineDatabases(page), "Actualizar el worker no toca la copia").toHaveLength(1)
})

test("offline: borrar los datos del sitio elimina copia, cachés y worker sin afectar al acceso con conexión", async ({ page, context, stack, browserName }) => {
  test.skip(browserName !== "chromium", "El borrado de datos del sitio se simula con CDP (solo Chromium).")
  test.setTimeout(120_000)
  await page.goto("/settings")
  await workerReady(page)
  await enableCopy(page, PIN_A)
  const cdp = await context.newCDPSession(page)
  await cdp.send("Storage.clearDataForOrigin", { origin: new URL(stack.appUrl).origin, storageTypes: "all" })
  await page.goto("/login")
  await expect.poll(() => offlineDatabases(page)).toEqual([])
  // La página de acceso vuelve a registrar el shell estático, sin copia ni datos privados.
  await workerReady(page)
  const entries = await cachedEntries(page)
  for (const list of Object.values(entries)) for (const entry of list) expect(entry.startsWith("/_next/static/") || STATIC_PATHS.has(entry), entry).toBe(true)
  expect(await page.evaluate(() => localStorage.getItem("biblib-offline-cuenta"))).toBeNull()
})


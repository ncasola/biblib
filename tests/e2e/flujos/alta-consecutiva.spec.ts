import { actionRequest, alerts, expect, test, titleField } from "../lib/fixtures"

// U-EXP-05: GoTrue/acciones/DB reales; solo la capacidad física de cámara se simula en el navegador.
// El runner de test debe arrancar la app con BIBLIB_ISBN_CAMERA=1 para los recorridos de cámara.

/**
 * Base de la cámara simulada. El WebKit de Playwright en Windows se compila sin pila multimedia: no tiene
 * `navigator.mediaDevices` ni `MediaStream` y su `srcObject` rechaza un flujo que no lo sea (G16). Solo si
 * faltan se crean y `srcObject` guarda el flujo simulado; en Chromium y Firefox se usan las del navegador.
 */
function cameraShim() {
  if (!navigator.mediaDevices) Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} })
  if (typeof MediaStream !== "undefined") return
  Object.defineProperty(window, "MediaStream", { configurable: true, writable: true, value: class { getTracks(): { stop(): void }[] { return [] } } })
  const sources = new WeakMap<HTMLMediaElement, unknown>()
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
    configurable: true,
    get(this: HTMLMediaElement) { return sources.get(this) ?? null },
    set(this: HTMLMediaElement, value: unknown) { sources.set(this, value) },
  })
}

test("alta consecutiva: informa éxito, limpia ficha y conserva estado y estantería entre altas", async ({ page, stack, data }) => {
  const slug = data.slug("consecutiva")
  const shelf = await data.shelf("a", `Consecutiva ${slug}`)
  const first = data.marked(`Primero ${slug}`), second = data.marked(`Segundo ${slug}`)
  await page.goto("/books/add")
  await page.getByRole("tab", { name: "Entrada manual" }).click()
  await titleField(page).fill(first)
  await page.getByLabel("Autor 1", { exact: true }).fill("Autora anterior")
  await page.getByLabel("Subtítulo").fill("Subtítulo anterior")
  await page.getByLabel("Número de páginas").fill("123")
  await page.getByLabel("Estado de lectura").selectOption("reading")
  await page.getByLabel("Estantería", { exact: true }).selectOption(shelf)
  await page.getByRole("button", { name: "Guardar y añadir otro" }).click()
  await expect(page.getByRole("status").filter({ hasText: first })).toHaveText(`Se ha guardado «${first}». Puedes añadir el siguiente libro.`)
  await expect(page).toHaveURL(/\/books\/add$/)
  await expect(titleField(page)).toHaveValue("")
  await expect(titleField(page)).toBeFocused()
  for (const label of ["Autor 1", "Subtítulo", "Número de páginas", "ISBN"]) await expect(page.getByLabel(label, { exact: true })).toHaveValue("")
  await expect(page.getByLabel("Estado de lectura")).toHaveValue("reading")
  await expect(page.getByLabel("Estantería", { exact: true })).toHaveValue(shelf)
  await titleField(page).fill(second)
  await page.getByRole("button", { name: "Guardar y añadir otro" }).click()
  await expect(page.getByRole("status").filter({ hasText: second })).toBeVisible()
  const rows = await stack.sql`select title, status, shelf_id from biblib.books where user_id = ${stack.users.a} and title in (${first}, ${second}) order by title`
  expect(rows).toHaveLength(2)
  for (const row of rows) expect(row).toMatchObject({ status: "reading", shelf_id: shelf })
  // Las preferencias también se ofrecen al siguiente formulario ISBN, en la misma pantalla.
  await page.getByRole("tab", { name: "Buscar por ISBN" }).click()
  await expect(page.getByLabel("Número ISBN")).toHaveValue("")
  await page.reload()
  await page.getByRole("tab", { name: "Entrada manual" }).click()
  await expect(page.getByLabel("Estado de lectura")).toHaveValue("unread")
})

test("alta consecutiva: error conserva borrador y doble toque no repite el envío", async ({ page, stack, data, guard }) => {
  const title = data.marked(`Doble toque ${data.slug("doble")}`)
  const isCreate = actionRequest(stack, "createEditionAction")
  await page.goto("/books/add")
  await page.getByRole("tab", { name: "Entrada manual" }).click()
  await titleField(page).fill(title)
  guard.allowConsole(/Failed to fetch|NetworkError|Load failed|ERR_FAILED|net::/i)
  await page.route("**/books/add", (route) => isCreate(route.request()) ? route.abort("failed") : route.fallback())
  await page.getByRole("button", { name: "Guardar y añadir otro" }).click()
  await expect(alerts(page)).toContainText("No se pudo guardar el libro")
  await expect(titleField(page)).toHaveValue(title)
  await expect(page.getByRole("status").filter({ hasText: "Se ha guardado" })).toHaveCount(0)
  await page.unrouteAll({ behavior: "wait" })
  let requests = 0, release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/books/add", async (route) => {
    if (!isCreate(route.request())) return route.fallback()
    requests++
    const response = await route.fetch()
    await gate
    await route.fulfill({ response })
  })
  await page.getByRole("button", { name: "Guardar y añadir otro" }).evaluate((element) => {
    const button = element as HTMLButtonElement
    button.click(); button.click()
  })
  await expect.poll(() => requests).toBe(1)
  await expect(page.getByRole("button", { name: "Guardar y añadir otro" })).toBeDisabled()
  await expect.poll(async () => Number((await stack.sql`select count(*)::int as count from biblib.books where user_id = ${stack.users.a} and title = ${title}`)[0].count)).toBe(1)
  release()
  await expect(titleField(page)).toHaveValue("")
  expect(requests).toBe(1)
})

test("alta consecutiva: ISBN duplicado abre la ficha existente y no añade una copia automáticamente", async ({ page, stack, data }) => {
  const isbn = "9780000000019", id = stack.fixtureBookId("a", "isla")
  const before = await stack.sql`select id from biblib.books where user_id = ${stack.users.a} and isbn = ${isbn}`
  await page.goto("/books/add")
  await page.getByRole("tab", { name: "Entrada manual" }).click()
  await titleField(page).fill(data.marked(`Duplicado rechazado ${data.slug("duplicado")}`))
  await page.getByLabel("ISBN", { exact: true }).fill("0-00-000001-9")
  await page.getByRole("button", { name: "Guardar y añadir otro" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Esta edición ya está en tu biblioteca" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Abrir el ejemplar guardado" })).toHaveAttribute("href", `/book/${id}`)
  expect(await stack.sql`select id from biblib.books where user_id = ${stack.users.a} and isbn = ${isbn}`).toHaveLength(before.length)
  await expect(page.getByRole("button", { name: "Añadir otro ejemplar", exact: true })).toBeVisible()
  await page.getByRole("link", { name: "Abrir el ejemplar guardado" }).click()
  await expect(page).toHaveURL(new RegExp(`/book/${id}$`))
})

test("cámara denegada permite completar y guardar un libro manualmente", async ({ page, stack, data }) => {
  await page.addInitScript(cameraShim)
  await page.addInitScript(() => {
    Object.defineProperty(window, "BarcodeDetector", { configurable: true, value: class {
      static async getSupportedFormats() { return ["ean_13"] }
      async detect() { return [] }
    } })
    Object.defineProperty(window, "__cameraRequests", { configurable: true, writable: true, value: 0 })
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      const state = window as unknown as { __cameraRequests: number }
      state.__cameraRequests++
      throw new DOMException("Permiso denegado en prueba", "NotAllowedError")
    } })
  })
  const title = data.marked(`Manual sin cámara ${data.slug("denegada")}`)
  const response = await page.goto("/books/add")
  expect(response?.headers()["permissions-policy"]).toBe("camera=(self), microphone=(), geolocation=(), payment=(), usb=()")
  expect(await page.evaluate(() => (window as unknown as { __cameraRequests: number }).__cameraRequests)).toBe(0)
  await page.getByRole("button", { name: "Escanear ISBN con cámara" }).click()
  await expect(page.getByRole("status").filter({ hasText: "No se ha permitido usar la cámara" })).toBeVisible()
  await expect(page.getByLabel("Número ISBN")).toBeEditable()
  expect(await page.evaluate(() => (window as unknown as { __cameraRequests: number }).__cameraRequests)).toBe(1)
  await page.getByRole("tab", { name: "Entrada manual" }).click()
  await titleField(page).fill(title)
  await page.getByRole("button", { name: "Guardar y añadir otro" }).click()
  await expect(page.getByRole("status").filter({ hasText: title })).toBeVisible()
  expect(await stack.sql`select id from biblib.books where user_id = ${stack.users.a} and title = ${title}`).toHaveLength(1)
})

test("cámara: descarta checksum inválido y requiere confirmar ISBN antes de buscar", async ({ page }) => {
  await page.addInitScript(cameraShim)
  await page.addInitScript(() => {
    const state = window as unknown as { __cameraRequests: number; __cameraStops: number; __detections: number }
    state.__cameraRequests = 0; state.__cameraStops = 0; state.__detections = 0
    Object.defineProperty(window, "BarcodeDetector", { configurable: true, value: class {
      static async getSupportedFormats() { return ["ean_13"] }
      async detect() { state.__detections++; return [{ rawValue: state.__detections < 2 ? "9780000000018" : "978-0-00-000001-9" }] }
    } })
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      state.__cameraRequests++
      const stream = new MediaStream()
      Object.defineProperty(stream, "getTracks", { value: () => [{ stop: () => { state.__cameraStops++ } }] })
      return stream
    } })
    Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: async () => {} })
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 })
  })
  await page.goto("/books/add")
  await page.getByRole("button", { name: "Escanear ISBN con cámara" }).click()
  await expect(page.getByRole("button", { name: "Usar este ISBN" })).toBeVisible()
  await expect(page.getByLabel("Número ISBN")).toHaveValue("")
  await expect(page.getByRole("heading", { name: "Revisa antes de guardar" })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __cameraStops: number }).__cameraStops)).toBe(1)
  await page.getByRole("button", { name: "Usar este ISBN" }).click()
  await expect(page.getByLabel("Número ISBN")).toHaveValue("9780000000019")
  await expect(page.getByRole("heading", { name: "Revisa antes de guardar" })).toBeVisible()
  await page.getByRole("button", { name: "Buscar libro" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Esta edición ya está en tu biblioteca" })).toBeVisible()
})

test("cámara no compatible mantiene visible el formulario ISBN y la entrada manual", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "BarcodeDetector", { configurable: true, value: undefined }) })
  await page.goto("/books/add")
  await page.getByRole("button", { name: "Escanear ISBN con cámara" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Entrada manual" })).toBeVisible()
  await expect(page.getByLabel("Número ISBN")).toBeEditable()
  await page.getByRole("tab", { name: "Entrada manual" }).click()
  await expect(titleField(page)).toBeEditable()
})

test("cámara: detener y cambiar a manual liberan la captura sin buscar un ISBN", async ({ page }) => {
  await page.addInitScript(cameraShim)
  await page.addInitScript(() => {
    const state = window as unknown as { __cameraStops: number }
    state.__cameraStops = 0
    Object.defineProperty(window, "BarcodeDetector", { configurable: true, value: class {
      static async getSupportedFormats() { return ["ean_13"] }
      async detect() { return [] }
    } })
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      const stream = new MediaStream()
      Object.defineProperty(stream, "getTracks", { value: () => [{ stop: () => { state.__cameraStops++ } }] })
      return stream
    } })
    Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: async () => {} })
  })
  await page.goto("/books/add")
  await page.getByRole("button", { name: "Escanear ISBN con cámara" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Apunta al código" })).toBeVisible()
  await page.getByRole("button", { name: "Detener cámara" }).click()
  expect(await page.evaluate(() => (window as unknown as { __cameraStops: number }).__cameraStops)).toBe(1)
  await page.getByRole("button", { name: "Escanear ISBN con cámara" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Apunta al código" })).toBeVisible()
  await page.getByRole("tab", { name: "Entrada manual" }).click()
  expect(await page.evaluate(() => (window as unknown as { __cameraStops: number }).__cameraStops)).toBe(2)
  await expect(titleField(page)).toBeEditable()
})

test("cámara: la navegación cliente desde una ruta que la deniega ofrece un documento nuevo", async ({ page }) => {
  await page.goto("/books")
  await page.getByRole("link", { name: "Agregar libro", exact: true }).click()
  await page.getByRole("button", { name: "Escanear ISBN con cámara" }).click()
  await expect(page.getByRole("link", { name: "Abrir alta con cámara en otra pestaña" })).toBeVisible()
  const popup = page.waitForEvent("popup")
  await page.getByRole("link", { name: "Abrir alta con cámara en otra pestaña" }).click()
  const cameraPage = await popup
  await expect(cameraPage).toHaveURL(/\/books\/add$/)
  await expect(cameraPage.getByLabel("Número ISBN")).toBeVisible()
  await cameraPage.close()
})

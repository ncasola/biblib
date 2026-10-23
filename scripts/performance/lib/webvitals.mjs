import { chromium } from "@playwright/test"
import { median } from "./stats.mjs"

// LCP, INP y CLS por pantalla con Playwright, contra la app compilada del perfil `test`. La sesión es la
// de la cuenta de escala (cookies SSR de una sesión real de GoTrue, reutilizada: no se abre otra). El
// navegador solo puede hablar con loopback: cualquier otra petición se aborta y se anota.

export const PROFILES = {
  escritorio: {
    id: "escritorio-local",
    descripcion: "Chrome estable en modo headless, ventana 1280×800, DPR 1, es-ES. Sin limitación de red (la app y el stack están en loopback) ni de CPU. Caché HTTP vacía en frío; poblada en caliente.",
    context: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }, cpuSlowdown: 1,
  },
  movil: {
    id: "movil-cpu-x4",
    descripcion: "Chrome estable en modo headless emulando un móvil (390×844, DPR 3, táctil) con la CPU 4× más lenta (Emulation.setCPUThrottlingRate) y sin limitación de red. Caché vacía en frío; poblada en caliente.",
    context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, cpuSlowdown: 4,
  },
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])

const INIT = () => {
  const v = { lcp: 0, lcpTag: null, cls: 0, fcp: null, interactions: new Map(), longTasks: 0, longTaskMs: 0 }
  window.__vitals = v
  const observe = (type, callback, extra = {}) => { try { new PerformanceObserver((list) => callback(list.getEntries())).observe({ type, buffered: true, ...extra }) } catch { /* tipo no admitido */ } }
  observe("largest-contentful-paint", (entries) => { for (const e of entries) { v.lcp = e.startTime; v.lcpTag = e.element ? e.element.tagName.toLowerCase() : null } })
  observe("paint", (entries) => { for (const e of entries) if (e.name === "first-contentful-paint") v.fcp = e.startTime })
  let current = 0, first = 0, last = 0, max = 0
  observe("layout-shift", (entries) => {
    for (const e of entries) {
      if (e.hadRecentInput) continue
      if (current && e.startTime - last < 1000 && e.startTime - first < 5000) current += e.value
      else { current = e.value; first = e.startTime }
      last = e.startTime
      if (current > max) max = current
    }
    v.cls = max
  })
  observe("event", (entries) => { for (const e of entries) if (e.interactionId) v.interactions.set(e.interactionId, Math.max(v.interactions.get(e.interactionId) ?? 0, e.duration)) }, { durationThreshold: 16 })
  observe("longtask", (entries) => { for (const e of entries) { v.longTasks++; v.longTaskMs += e.duration } })
}

const READ = () => {
  const v = window.__vitals
  const durations = [...v.interactions.values()].sort((a, b) => b - a)
  const nav = performance.getEntriesByType("navigation")[0]
  return {
    lcp: v.lcp, lcpElemento: v.lcpTag, cls: v.cls, fcp: v.fcp, interacciones: durations.length,
    inp: durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length / 50))] : null,
    ttfb: nav ? nav.responseStart : null, cargaCompleta: nav ? nav.loadEventEnd : null, tareasLargas: v.longTasks, tareasLargasMs: Math.round(v.longTaskMs),
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const attempt = async (log, label, action) => { try { await action(); return true } catch { log.push(label); return false } }

/** Pantallas medidas y los gestos reales de cada una (todos de solo lectura: no se guarda nada). */
export function screens(facts) {
  const typeAndPage = (page, log) => (async () => {
    await attempt(log, "búsqueda", async () => { await page.locator("#book-search").pressSequentially("faro", { delay: 40 }); await page.waitForLoadState("networkidle") })
    await attempt(log, "página siguiente", async () => { await page.getByRole("button", { name: "Página siguiente" }).click({ timeout: 3000 }); await page.waitForLoadState("networkidle") })
    await attempt(log, "vista cuadrícula", async () => { await page.getByRole("button", { name: "Vista de cuadrícula" }).click({ timeout: 3000 }); await sleep(300) })
    await attempt(log, "vista tabla", async () => { await page.getByRole("button", { name: "Vista de tabla" }).click({ timeout: 3000 }); await sleep(300) })
    await attempt(log, "seleccionar página", async () => { await page.getByLabel("Seleccionar todos los libros de esta página").check({ timeout: 3000 }); await sleep(300) })
  })
  const theme = (page, log) => attempt(log, "tema", async () => { await page.getByRole("button", { name: /Activar tema/ }).click({ timeout: 3000 }); await sleep(200); await page.getByRole("button", { name: /Activar tema/ }).click({ timeout: 3000 }) })
  return [
    { id: "inicio", ruta: "/", gestos: async (page, log) => { await theme(page, log) } },
    { id: "coleccion", ruta: "/books", gestos: async (page, log) => { await typeAndPage(page, log)() } },
    { id: "busqueda-avanzada", ruta: "/books/search", gestos: async (page, log) => { await typeAndPage(page, log)() } },
    { id: "ficha", ruta: `/book/${facts.bookIds[0]}`, gestos: async (page, log) => {
      await attempt(log, "editar", async () => { await page.getByRole("button", { name: "Editar ficha" }).first().click({ timeout: 3000 }); await sleep(300) })
      await attempt(log, "cancelar", async () => { await page.getByRole("button", { name: "Cancelar" }).first().click({ timeout: 3000 }); await sleep(300) })
      await theme(page, log)
    } },
    { id: "estanterias", ruta: "/shelves", gestos: async (page, log) => {
      await attempt(log, "nueva estantería", async () => { await page.getByRole("button", { name: "Nueva estantería" }).click({ timeout: 3000 }); await sleep(300); await page.keyboard.press("Escape"); await sleep(200) })
      await theme(page, log)
    } },
    { id: "estanteria-3d", ruta: `/shelves/3d?shelf=${facts.bigShelf}`, gestos: async (page, log) => {
      await attempt(log, "página siguiente", async () => { await page.getByRole("button", { name: "Página siguiente" }).click({ timeout: 3000 }); await page.waitForLoadState("networkidle") })
      await attempt(log, "página anterior", async () => { await page.getByRole("button", { name: "Página anterior" }).click({ timeout: 3000 }); await page.waitForLoadState("networkidle") })
    } },
    { id: "ajustes", ruta: "/settings", gestos: async (page, log) => {
      await attempt(log, "exportar", async () => {
        const started = Date.now()
        const download = page.waitForEvent("download", { timeout: 60_000 }).catch(() => null)
        const parts = page.getByRole("button", { name: /Descargar parte 1 de/ }).waitFor({ timeout: 60_000 }).then(() => true).catch(() => false)
        await page.getByRole("button", { name: "Descargar copia de seguridad" }).click({ timeout: 5000 })
        await Promise.race([download, parts])
        log.exportMs = Date.now() - started
      })
    } },
  ]
}

async function newContext(browser, profile, appUrl, cookies, outbound) {
  const context = await browser.newContext({ ...profile.context, locale: "es-ES", timezoneId: "Europe/Madrid", acceptDownloads: true })
  await context.addCookies(cookies.map(({ name, value }) => ({ name, value, url: appUrl })))
  await context.route("**/*", (route) => {
    const { hostname } = new URL(route.request().url())
    if (LOOPBACK.has(hostname)) return route.continue()
    outbound.add(hostname)
    return route.abort()
  })
  await context.addInitScript(INIT)
  return context
}

async function measure(page, ruta, appUrl, ready = 700) {
  page.actionTimes.length = 0
  const started = Date.now()
  await page.goto(`${appUrl}${ruta}`, { waitUntil: "load", timeout: 90_000 })
  await page.waitForLoadState("networkidle", { timeout: 90_000 })
  const idleMs = Date.now() - started
  // «Datos listos»: instante en que terminó la última Server Action de la carga (las pantallas cargan sus datos en el cliente).
  const datosListosMs = page.actionTimes.length ? Math.max(...page.actionTimes) - started : null
  await sleep(ready)
  return { ...(await page.evaluate(READ)), reposoRedMs: idleMs, datosListosMs }
}

/**
 * Por pantalla: `runs` contextos nuevos; en cada uno, 1.ª navegación (frío), 2.ª (caliente) y 3.ª (caliente,
 * con gestos para medir INP). Devuelve las muestras y la mediana por métrica.
 */
export async function runWebVitals({ appUrl, cookies, facts, profileKey, runs, only }) {
  const profile = PROFILES[profileKey]
  const browser = await chromium.launch({ channel: "chrome", headless: true })
  const outbound = new Set()
  const consoleErrors = []
  const result = { perfil: { id: profile.id, descripcion: profile.descripcion }, navegador: browser.version(), pantallas: {} }
  try {
    for (const screen of screens(facts).filter((s) => !only || only.includes(s.id))) {
      const frio = [], caliente = [], interaccion = []
      const gestosFallidos = []
      for (let run = 0; run < runs; run++) {
        const context = await newContext(browser, profile, appUrl, cookies, outbound)
        const page = await context.newPage()
        page.actionTimes = []
        page.on("requestfinished", (request) => { if (request.method() === "POST" && request.url().startsWith(appUrl)) page.actionTimes.push(Date.now()) })
        page.on("pageerror", (error) => consoleErrors.push(`${screen.id}: ${error.name}`))
        page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) consoleErrors.push(`${screen.id}: ${message.text().slice(0, 80)}`) })
        if (profile.cpuSlowdown > 1) await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: profile.cpuSlowdown })
        try {
          frio.push(await measure(page, screen.ruta, appUrl))
          caliente.push(await measure(page, screen.ruta, appUrl))
          const sample = await measure(page, screen.ruta, appUrl)
          const log = []
          await screen.gestos(page, log)
          await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {})
          await sleep(500)
          const after = await page.evaluate(READ)
          interaccion.push({ ...sample, inp: after.inp, interacciones: after.interacciones, clsConGestos: after.cls, exportMs: log.exportMs ?? null })
          gestosFallidos.push(...log)
        } finally { await context.close() }
      }
      const med = (rows, key) => { const values = rows.map((r) => r[key]).filter((v) => Number.isFinite(v)); return values.length ? Math.round(median(values) * 1000) / 1000 : null }
      result.pantallas[screen.id] = {
        ruta: screen.ruta.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<uuid>"),
        frio: { lcpMs: med(frio, "lcp"), cls: med(frio, "cls"), fcpMs: med(frio, "fcp"), datosListosMs: med(frio, "datosListosMs"), reposoRedMs: med(frio, "reposoRedMs"), lcpElemento: frio[0]?.lcpElemento ?? null, muestras: frio.length },
        caliente: { lcpMs: med(caliente, "lcp"), cls: med(caliente, "cls"), fcpMs: med(caliente, "fcp"), datosListosMs: med(caliente, "datosListosMs"), reposoRedMs: med(caliente, "reposoRedMs"), muestras: caliente.length },
        interaccion: { inpMs: med(interaccion, "inp"), inpPeorMs: Math.max(...interaccion.map((r) => r.inp ?? 0)), interacciones: med(interaccion, "interacciones"), clsConGestos: med(interaccion, "clsConGestos"), exportMs: med(interaccion, "exportMs"), tareasLargas: med(interaccion, "tareasLargas"), tareasLargasMs: med(interaccion, "tareasLargasMs"), muestras: interaccion.length },
        gestosNoDisponibles: [...new Set(gestosFallidos)],
      }
    }
  } finally { await browser.close() }
  result.peticionesExternasAbortadas = [...outbound]
  result.erroresDeConsola = [...new Set(consoleErrors)].slice(0, 20)
  return result
}

export async function browserVersion() {
  const browser = await chromium.launch({ channel: "chrome", headless: true })
  try { return browser.version() } finally { await browser.close() }
}

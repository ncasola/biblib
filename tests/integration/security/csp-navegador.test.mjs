import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium } from "@playwright/test"
import { liveCookies } from "../lib/sessions.mjs"
import { securityContext } from "./lib/context.mjs"

// U-OPS-04 · La CSP en modo informe no rompe nada sin explicar: Chrome (vía Playwright, sin red
// externa) recorre las pantallas con la sesión real de A y recoge los eventos securitypolicyviolation
// que la política Report-Only dispara. Las peticiones fuera del loopback se abortan después de que la
// CSP las evalúe, de modo que un host no previsto aparece como violación y nunca sale a Internet.

let ctx, browser, cookies, bookRoute
before(async () => {
  ctx = await securityContext()
  cookies = liveCookies(await ctx.signIn("a"))
  const [book] = await ctx.sql`select id from biblib.books where user_id = ${ctx.accounts.a.id} order by id limit 1`
  bookRoute = `/book/${book.id}`
  // Mismo navegador que playwright.config.ts (canal chrome instalado), sin descargar binarios.
  browser = await chromium.launch({ channel: "chrome" })
})
after(async () => {
  await browser?.close()
  await ctx?.close()
})

const ROUTES = ["/", "/books", "/books/add", "/books/search", "/shelves", "/shelves/3d", "/settings", "/profile"]

async function visit(route, withSession) {
  const context = await browser.newContext({ baseURL: ctx.appUrl })
  if (withSession) await context.addCookies(cookies.map(({ name, value }) => ({ name, value, url: ctx.appUrl })))
  await context.route("**/*", (request) => {
    const url = new URL(request.request().url())
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? request.continue() : request.abort("blockedbyclient")
  })
  const page = await context.newPage()
  const violations = []
  const errors = []
  await page.exposeFunction("__biblibCspViolation", (violation) => violations.push(violation))
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__biblibCspViolation({ directive: event.effectiveDirective, blocked: event.blockedURI, disposition: event.disposition, source: event.sourceFile, sample: event.sample?.slice(0, 40) ?? "" })
    })
  })
  page.on("pageerror", (error) => errors.push(error.message))
  const response = await page.goto(route, { waitUntil: "networkidle" })
  const header = response?.headers()["content-security-policy-report-only"] ?? ""
  await context.close()
  return { status: response?.status(), header, violations, errors }
}

/**
 * Única violación explicada (docs/seguridad.md): Zod 4 sondea `new Function("")` (util.allowsEval) dentro de un
 * try/catch en las pantallas cuyo bundle incluye validación Zod (alta, ficha, ajustes). Con la CSP en vigor la
 * sonda falla y Zod valida sin JIT: no rompe nada, pero genera un informe. Se acepta solo si el script que la
 * dispara es el chunk propio que contiene esa sonda (texto estable "Cloudflare" junto a la llamada a Function).
 */
const zodChunks = new Map()
async function isZodEvalProbe(violation) {
  if (violation.directive !== "script-src" || violation.blocked !== "eval" || violation.disposition !== "report") return false
  const source = new URL(violation.source ?? "", ctx.appUrl)
  if (source.origin !== ctx.appUrl || !source.pathname.startsWith("/_next/static/chunks/")) return false
  if (!zodChunks.has(source.pathname)) {
    const text = await (await fetch(source, { signal: AbortSignal.timeout(10_000) })).text()
    zodChunks.set(source.pathname, /includes\("Cloudflare"\)\)return!1;try\{return (new \w+|Function)\(""\)/.test(text))
  }
  return zodChunks.get(source.pathname)
}

test("Chrome solo registra las violaciones explicadas de la CSP Report-Only en las pantallas privadas", async () => {
  const explained = new Set()
  for (const route of [...ROUTES, bookRoute]) {
    const result = await visit(route, true)
    assert.equal(result.status, 200, route)
    assert.match(result.header, /'nonce-[^']+'/, `${route} lleva nonce`)
    const unexplained = []
    for (const violation of result.violations) {
      if (await isZodEvalProbe(violation)) explained.add(route)
      else unexplained.push(violation)
    }
    assert.deepEqual(unexplained, [], `${route} sin violaciones no explicadas`)
    assert.deepEqual(result.errors, [], `${route} sin errores de página`)
  }
  console.log(`Sonda eval de Zod (explicada) en: ${[...explained].map((route) => route.startsWith("/book/") ? "/book/[id]" : route).join(", ") || "ninguna"}`)
})

test("el acceso anónimo y la pantalla de login no registran violaciones", async () => {
  const result = await visit("/books?status=read", false)
  assert.equal(result.status, 200, "El navegador sigue la redirección al acceso.")
  assert.deepEqual(result.violations, [])
  assert.deepEqual(result.errors, [])
})

test("una portada externa no prevista se informa como violación de img-src, sin bloquear la página", async () => {
  const context = await browser.newContext({ baseURL: ctx.appUrl })
  await context.route("**/*", (request) => ["127.0.0.1", "localhost"].includes(new URL(request.request().url()).hostname) ? request.continue() : request.abort("blockedbyclient"))
  const page = await context.newPage()
  const violations = []
  await page.exposeFunction("__biblibCspViolation", (violation) => violations.push(violation))
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (event) => window.__biblibCspViolation({ directive: event.effectiveDirective, disposition: event.disposition, blocked: event.blockedURI })))
  await page.goto("/login", { waitUntil: "networkidle" })
  await page.evaluate(() => new Promise((resolve) => {
    const image = new Image()
    image.onload = image.onerror = resolve
    image.src = "https://portadas-no-previstas.invalid/portada.jpg"
  }))
  await context.close()
  assert.deepEqual(violations.map(({ directive, disposition }) => ({ directive, disposition })), [{ directive: "img-src", disposition: "report" }])
})

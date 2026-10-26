// U-QA-05 (O16) · Bordes de paginación de UX-06 en la app real del perfil scratch: 0, 1, 10 y 11 resultados y un
// filtro aplicado desde una página posterior. Crea en la cuenta ficticia A once fichas manuales «[QA05-PAG] nn» y las
// retira al terminar. Requiere la app en 127.0.0.1:3149 (dev:local o start:local). No imprime cookies ni tokens.
// Uso: node docs/validacion/2026-10-26/O16/qa-05/paginacion.mjs
import { chromium } from "@playwright/test"
import { signInFixture } from "../../../../../tests/integration/support/session.mjs"
import { resolveSeedTarget } from "../../../../../scripts/db/seed-local.mjs"
import { closeConnection, connect } from "../../../../../scripts/db/target.mjs"

const BASE = "http://127.0.0.1:3149"
const MARK = "QA05-PAG"
const resolved = await resolveSeedTarget("scratch")
const sql = connect(resolved, { applicationName: "biblib-qa05-paginacion" })
const { user, cookies, client } = await signInFixture("a", { profile: "scratch" })
const browser = await chromium.launch({ channel: "chrome" })
const checks = []

async function setBooks(count) {
  await sql`delete from biblib.books where user_id = ${user.id} and title like ${`[${MARK}]%`}`
  const [shelf] = await sql`select id from biblib.shelves where user_id = ${user.id} and is_default`
  for (let n = 1; n <= count; n += 1) {
    await sql`insert into biblib.books (user_id, isbn, title, shelf_id) values (${user.id}, ${`manual-qa05-pag-${n}`}, ${`[${MARK}] ${String(n).padStart(2, "0")}`}, ${shelf.id})`
  }
}

async function summary(page) {
  const empty = page.getByText("No hay libros con estos filtros")
  const range = page.getByText(/^Mostrando \d+ a \d+ de \d+ libros$/)
  await Promise.race([empty.waitFor({ timeout: 30_000 }), range.waitFor({ timeout: 30_000 })])
  if (await empty.isVisible()) return { range: "vacío", pages: null, clear: await page.getByRole("button", { name: "Limpiar filtros" }).first().isVisible() }
  return { range: await range.innerText(), pages: await page.getByText(/^Página \d+ de \d+$/).innerText() }
}

async function expectCase(name, page, url, expected) {
  if (url) await page.goto(`${BASE}${url}`)
  const actual = await summary(page)
  const ok = Object.entries(expected).every(([key, value]) => actual[key] === value)
  checks.push({ name, url: url ?? page.url().replace(BASE, ""), expected, actual, ok })
}

try {
  const context = await browser.newContext()
  await context.addCookies(cookies().filter((entry) => entry.value).map((entry) => ({ name: entry.name, value: entry.value, domain: "127.0.0.1", path: "/" })))
  const page = await context.newPage()
  const query = `/books?q=${encodeURIComponent(MARK)}`

  await setBooks(11)
  await expectCase("11 resultados, página 1", page, query, { range: "Mostrando 1 a 10 de 11 libros", pages: "Página 1 de 2" })
  await expectCase("11 resultados, página 2", page, `${query}&page=2`, { range: "Mostrando 11 a 11 de 11 libros", pages: "Página 2 de 2" })
  // Filtro aplicado desde la página 2: la búsqueda nueva vuelve a la página 1 con el total filtrado.
  await page.getByLabel("Buscar por título, autor o ISBN").fill(`${MARK}] 07`)
  await page.getByLabel("Buscar por título, autor o ISBN").press("Enter")
  await page.waitForURL((url) => !url.searchParams.has("page"), { timeout: 30_000 })
  await expectCase("filtro desde la página 2 → 1 resultado", page, null, { range: "Mostrando 1 a 1 de 1 libros", pages: "Página 1 de 1" })

  await setBooks(10)
  await expectCase("10 resultados", page, query, { range: "Mostrando 1 a 10 de 10 libros", pages: "Página 1 de 1" })
  await expectCase("página 2 que deja de existir con 10", page, `${query}&page=2`, { range: "Mostrando 1 a 10 de 10 libros", pages: "Página 1 de 1" })

  await setBooks(1)
  await expectCase("1 resultado", page, query, { range: "Mostrando 1 a 1 de 1 libros", pages: "Página 1 de 1" })

  await setBooks(0)
  await expectCase("0 resultados", page, query, { range: "vacío", clear: true })
  await context.close()
} finally {
  await setBooks(0)
  await browser.close()
  await client.auth.signOut()
  await closeConnection(sql)
}
const failures = checks.filter((check) => !check.ok).length
console.log(JSON.stringify({ base: BASE, checks, failures }, null, 2))
process.exitCode = failures ? 1 : 0

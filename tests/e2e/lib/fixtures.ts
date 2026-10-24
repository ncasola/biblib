import { randomUUID } from "node:crypto"
import path from "node:path"
import { test as base, expect, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test"
import type { Sql } from "postgres"
import { adminClient, closeConnection, database, integrationContext } from "../../integration/lib/context.mjs"
import { loadActions } from "../../integration/lib/app.mjs"
import { fixtureId } from "../../../scripts/db/fixture-store.mjs"
import { e2eManifestFile, E2E_MARKER } from "./e2e-manifest.mjs"

// Fixtures compartidos de los recorridos U-QA-02. Las credenciales A/B salen del registro privado del
// perfil test (.biblib/fixtures/test.json) dentro del proceso de pruebas y nunca se imprimen ni se pasan
// por variables de entorno. Cada prueba vigila la red del navegador, las excepciones JS y la consola.

export type Account = "a" | "b"
export type Session = Account | "anon"

export interface Stack {
  appUrl: string
  /** Origen de GoTrue/Storage del perfil: el navegador habla con él para la sesión. */
  apiOrigin: string
  runId: string
  manifest: string
  sql: Sql
  /** Cliente administrativo local (solo en este proceso), para revertir metadatos de A/B. */
  resetDisplayName(account: Account): Promise<void>
  users: Record<Account, string>
  email(account: Account): string
  displayName(account: Account): string
  password(account: Account): string
  fixtureBookId(account: Account, fixtureKey: string): string
  actionId(name: string): string
}

export interface Guard {
  /** Errores de consola esperados en esta prueba (p. ej. un 404 deliberado). */
  allowConsole(pattern: RegExp): void
  /** Aplica la misma vigilancia a otro contexto abierto por la prueba. */
  watch(context: BrowserContext): Promise<void>
  /** Marca en la línea temporal de diagnóstico (se muestra solo si la prueba falla por consola/red). */
  mark(label: string): void
}

export interface BookSpec {
  title: string
  status?: "read" | "reading" | "unread" | "to-read"
  authors?: string[]
  pages?: number
  isbn?: string
  /** Verificación humana del ISBN en el ejemplar (`catalogue.isbnVerified`). */
  verified?: boolean
  publishDate?: string
}

export interface Data {
  /** Título con la marca del run: la limpieza final solo borra lo que la lleva. */
  marked(text: string): string
  /** Fragmento único por prueba para acotar búsquedas y conteos. */
  slug(prefix: string): string
  defaultShelf(account: Account): Promise<string>
  shelf(account: Account, title: string): Promise<string>
  books(account: Account, shelfId: string, specs: BookSpec[]): Promise<string[]>
}

interface CensusAccount { key: Account; email: string; user_metadata: { full_name: string } }
interface Observed { text: string; at: number }

/** Errores con los que la app registra una carga interrumpida (`console.error` en su catch) en Firefox/WebKit. */
const NAVIGATION_ABORT_CONSOLE = /^Error loading [a-z ]+: (TypeError: (Load failed|NetworkError when attempting to fetch resource\.)|JSHandle@object) \[/
/** Rechazo con el que WebKit informa de un fetch cancelado por la navegación. */
const ACCESS_CONTROL_ABORT = /^Excepción JS: .* due to access control checks\.$/

export const e2eDir = process.env.BIBLIB_E2E_DIR ?? path.join(process.cwd(), ".biblib", "e2e")

export function browserOf(testInfo: TestInfo): string {
  return testInfo.project.name.split("-")[0]
}

export function stateFile(testInfo: TestInfo, account: Account): string {
  return path.join(e2eDir, "state", `${browserOf(testInfo)}-${account}.json`)
}

/**
 * Captura de evidencia en .biblib/e2e/capturas/<navegador>-<nombre>.png. Solo se usa en pantallas con
 * datos ficticios (censo A/B o fichas marcadas) y nunca con una contraseña escrita.
 */
export async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: path.join(e2eDir, "capturas", `${browserOf(testInfo)}-${name}.png`) })
}

/** Escribe un secreto sin que aparezca en el título del paso, el informe ni la salida. */
export async function fillSecret(field: Locator, value: string): Promise<void> {
  await field.evaluate((element, secret) => { (element as HTMLInputElement).value = secret }, value)
}

export function localLoginForm(page: Page): Locator {
  return page.locator("section[data-biblib-local-login]")
}

/** Acceso por el formulario local de U-LOC-01 (`/login` → «Acceso local de desarrollo»). */
export async function loginWithForm(page: Page, stack: Stack, account: Account, { password }: { password?: string } = {}): Promise<void> {
  const form = localLoginForm(page)
  await expect(form.getByRole("heading", { name: "Acceso local de desarrollo" })).toBeVisible()
  // WebKit 27.2 puede resolver fill() sobre type=email sin escribir valor.
  // La escritura real de teclas permite el mismo formulario sin un bypass de Auth.
  await form.getByLabel("Correo").fill("")
  await form.getByLabel("Correo").pressSequentially(stack.email(account))
  await fillSecret(form.getByLabel("Contraseña"), password ?? stack.password(account))
  await form.getByRole("button", { name: "Entrar" }).click()
}

/** Avisos de la página, sin el anunciador de rutas de Next (también tiene role="alert"). */
export function alerts(page: Page): Locator {
  return page.locator("[role=alert]:not(#__next-route-announcer__)")
}

/** Campo «Título» del formulario de ficha (su etiqueta lleva un asterisco oculto a lectores). */
export function titleField(page: Page): Locator {
  return page.getByRole("textbox", { name: "Título", exact: true })
}

export function accountMenu(page: Page, stack: Stack, account: Account): Locator {
  return page.getByRole("button", { name: `Abrir menú de cuenta de ${stack.displayName(account)}` })
}

/**
 * Hallazgo QA-02 (23-10-2026): al cerrar sesión, Header hace `router.replace("/login")` y `router.refresh()`;
 * el refresco RSC de la página privada pasa por el proxy, que lo redirige a `/login?redirect=…`, y esa
 * petición RSC responde 404 (la pantalla termina bien en /login). Solo las pruebas que cierran sesión lo admiten.
 */
export const SIGN_OUT_RSC_404 = /status of 404 \(Not Found\) \[\/login\]$/

export async function signOut(page: Page, stack: Stack, account: Account): Promise<void> {
  // Una acción de servidor aún en curso al revocar la sesión llega sin ella y responde 500 (visto una vez
  // en Chromium cerrando sesión desde /books): se espera a que la página quede en reposo antes de cerrar.
  await page.waitForLoadState("networkidle")
  await accountMenu(page, stack, account).click()
  await page.getByRole("menuitem", { name: "Cerrar sesión" }).click()
  await page.waitForURL((url) => url.pathname === "/login")
}

/** Elige una opción de un Select de Radix por su etiqueta accesible. */
export async function chooseOption(page: Page, trigger: string, option: string): Promise<void> {
  await page.getByRole("combobox", { name: trigger }).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

export function actionRequest(stack: Stack, name: string) {
  const id = stack.actionId(name)
  return (request: { method(): string; headers(): Record<string, string> }) => request.method() === "POST" && request.headers()["next-action"] === id
}

export const test = base.extend<{ account: Session; guard: Guard; data: Data }, { stack: Stack }>({
  account: ["a", { option: true }],

  stack: [async ({}, provide) => {
    const runId = process.env.BIBLIB_E2E_RUN_ID
    const appUrl = process.env.BIBLIB_E2E_BASE_URL
    if (!runId || !/^[0-9a-f]{12}$/.test(runId) || !appUrl) throw new Error("Ejecuta los recorridos con pnpm test:e2e:local; los archivos no se lanzan sueltos.")
    const ctx = await integrationContext()
    if (ctx.appUrl !== appUrl) throw new Error("La URL de la app no corresponde al perfil test acreditado.")
    const sql = database(ctx, "biblib-e2e") as unknown as Sql
    const actions = loadActions(ctx.root)
    const census = ctx.census.accounts as CensusAccount[]
    const account = (key: Account) => {
      const found = census.find((entry) => entry.key === key)
      if (!found) throw new Error(`Falta la cuenta ${key.toUpperCase()} en el censo.`)
      return found
    }
    const users = ctx.users as Record<Account, string>
    const admin = adminClient(ctx)
    await provide({
      appUrl,
      apiOrigin: new URL(String(ctx.env.NEXT_PUBLIC_SUPABASE_URL)).origin,
      runId,
      manifest: e2eManifestFile(ctx.root),
      sql,
      async resetDisplayName(key) {
        // GoTrue elimina la clave cuando su valor es null: el nombre vuelve al del censo.
        const { error } = await admin.auth.admin.updateUserById(users[key], { user_metadata: { display_name: null } })
        if (error) throw new Error("No se pudo restaurar el nombre de la cuenta ficticia.")
      },
      users,
      email: (key) => account(key).email,
      displayName: (key) => account(key).user_metadata.full_name,
      password: (key) => String(ctx.store.accounts[key].password),
      fixtureBookId: (key, fixtureKey) => fixtureId(ctx.census.censusId, users[key], "book", fixtureKey),
      actionId: (name) => {
        const action = actions.get(name)
        if (!action) throw new Error(`La acción ${name} no está en el build.`)
        return action.id
      },
    })
    await closeConnection(sql)
  }, { scope: "worker" }],

  storageState: async ({ account }, provide, testInfo) => {
    await provide(account === "anon" ? { cookies: [], origins: [] } : stateFile(testInfo, account))
  },

  guard: [async ({ context, stack }, provide, testInfo) => {
    const appOrigin = new URL(stack.appUrl).origin
    const allowedOrigins = new Set([appOrigin, stack.apiOrigin])
    const blocked: string[] = []
    const problems: Observed[] = []
    const started = Date.now()
    // Línea temporal de diagnóstico: marcas de la prueba, respuestas ≥400 y errores, con su página.
    const timeline: string[] = []
    const note = (text: string) => timeline.push(`+${Date.now() - started} ms ${text}`)
    const consoleErrors: Observed[] = []
    const navigations: number[] = []
    const allowed: RegExp[] = []
    if (testInfo.project.name.startsWith("webkit")) {
      // WebKit clasifica como error de consola este aviso de una CSP solo informativa.
      // No es una excepción JS ni una violación de la política; se documenta en accesibilidad.md.
      allowed.push(/^The Content Security Policy '[^\n]*' was delivered in report-only mode, but does not specify a 'report-to'; the policy will have no effect\. Please either add a 'report-to' directive, or deliver the policy via the 'Content-Security-Policy' header\.$/)
      testInfo.annotations.push({ type: "aviso WebKit conocido", description: "CSP en modo informe sin report-to; pendiente de receptor de informes de U-OPS-04." })
    }
    if (testInfo.project.name.startsWith("firefox")) {
      // Solo el aviso Report-Only del runtime propio de Next; una CSP aplicada,
      // otro origen, otro tipo de rechazo o una excepción real siguen fallando.
      allowed.push(/^\[JavaScript Error: "Content-Security-Policy: \(Report-Only policy\) The page’s settings would block a JavaScript eval \(script-src\).+\(Missing 'unsafe-eval'\)" \{file: "http:\/\/127\.0\.0\.1:3148\/_next\/static\/chunks\/[^"]+" line: \d+\}\] \[\/_next\/static\/chunks\/[^\]]+\]$/)
      testInfo.annotations.push({ type: "aviso Firefox conocido", description: "CSP solo en informe: eval del runtime Next, pendiente de revisión de U-OPS-04 antes de aplicar la política." })
    }
    const watchPage = (page: Page) => {
      const where = () => new URL(page.url()).pathname
      page.on("pageerror", (error) => { problems.push({ text: `Excepción JS: ${error.message}`, at: Date.now() }); note(`excepción en ${where()}: ${error.stack?.split("\n").slice(0, 4).join(" ") ?? error.message}`) })
      page.on("response", (response) => { if (response.status() >= 400) note(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname} (página ${where()})`) })
      page.on("request", (request) => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations.push(Date.now()) })
      page.on("console", (message) => {
        if (message.type() !== "error") return
        // Se añade la ruta del recurso (sin consulta) para poder diagnosticar sin volcar datos.
        const where = message.location().url ? new URL(message.location().url).pathname : ""
        consoleErrors.push({ text: `${message.text()}${where ? ` [${where}]` : ""}`, at: Date.now() })
        note(`consola: ${message.text().slice(0, 120)}`)
      })
    }
    // Firefox y WebKit informan de las peticiones de la app que una navegación cancela (prefetch RSC,
    // acciones en curso) como error de consola o, en WebKit, como rechazo «access control checks» (sin
    // `requestfailed` para la acción). Solo se toleran esas firmas, sobre la propia app y en los 3 s
    // posteriores al inicio de una navegación del marco principal; quedan anotadas en el informe.
    const appHost = new URL(stack.appUrl).host
    const navigationAbort = (entry: Observed) => {
      const signature = ACCESS_CONTROL_ABORT.test(entry.text) ? entry.text.includes(`/${appHost}/`) : NAVIGATION_ABORT_CONSOLE.test(entry.text)
      return signature && navigations.some((at) => entry.at >= at - 100 && entry.at - at < 3_000)
    }
    const watch = async (target: BrowserContext) => {
      await target.route("**/*", async (route) => {
        const url = new URL(route.request().url())
        if (allowedOrigins.has(url.origin)) return route.fallback()
        blocked.push(url.origin)
        return route.abort("blockedbyclient")
      })
      target.pages().forEach(watchPage)
      target.on("page", watchPage)
    }
    await watch(context)
    await provide({ allowConsole: (pattern) => { allowed.push(pattern) }, watch, mark: (label) => note(`— ${label}`) })
    const observed = [...problems, ...consoleErrors.filter((entry) => !allowed.some((pattern) => pattern.test(entry.text)))]
    const tolerated = observed.filter(navigationAbort)
    for (const entry of tolerated) testInfo.annotations.push({ type: "cancelación al navegar", description: entry.text })
    expect(blocked, "Sin tráfico externo desde el navegador").toEqual([])
    const diagnosis = `Sin excepciones JS, errores de hidratación ni errores de consola. Línea temporal:\n${timeline.join("\n") || "(vacía)"}\n`
    expect(observed.filter((entry) => !tolerated.includes(entry)).map((entry) => entry.text), diagnosis).toEqual([])
  }, { auto: true }],

  // Al terminar cada prueba se borra lo marcado con sus fragmentos: así un ISBN real dado de alta en
  // Chromium no choca con el mismo recorrido en Firefox dentro de la misma ejecución.
  data: async ({ stack }, provide) => {
    const owner = (account: Account) => stack.users[account]
    const slugs: string[] = []
    const prefix = `[${E2E_MARKER} ${stack.runId}] `
    await provide({
      marked: (text) => `${prefix}${text}`,
      slug: (name) => {
        const slug = `${name}${randomUUID().slice(0, 6)}`
        slugs.push(slug)
        return slug
      },
      async defaultShelf(account) {
        const [row] = await stack.sql`select id from biblib.shelves where user_id = ${owner(account)} and is_default`
        return String(row.id)
      },
      async shelf(account, title) {
        const [row] = await stack.sql`insert into biblib.shelves (user_id, title) values (${owner(account)}, ${`[${E2E_MARKER} ${stack.runId}] ${title}`}) returning id`
        return String(row.id)
      },
      async books(account, shelfId, specs) {
        const ids: string[] = []
        for (const spec of specs) {
          const id = randomUUID()
          await stack.sql`insert into biblib.books (id, user_id, isbn, title, authors, number_of_pages, publish_date, status, shelf_id, catalogue)
            values (${id}, ${owner(account)}, ${spec.isbn ?? `manual-${id}`}, ${`[${E2E_MARKER} ${stack.runId}] ${spec.title}`},
              ${stack.sql.json((spec.authors ?? []).map((name) => ({ name })))}, ${spec.pages ?? 0}, ${spec.publishDate ?? ""},
              ${spec.status ?? "unread"}, ${shelfId}, ${stack.sql.json({ source: "manual", isbnVerified: spec.verified ?? false })})`
          ids.push(id)
        }
        return ids
      },
    })
    const owners = [stack.users.a, stack.users.b]
    for (const slug of slugs) {
      const pattern = `${prefix.replace(/[\\%_]/g, "\\$&")}%${slug}%`
      await stack.sql`delete from biblib.books where user_id in ${stack.sql(owners)} and title like ${pattern}`
      await stack.sql`delete from biblib.shelves s where s.user_id in ${stack.sql(owners)} and not s.is_default and s.title like ${pattern}
        and not exists (select 1 from biblib.books b where b.user_id = s.user_id and b.shelf_id = s.id)`
    }
  },
})

export { expect }

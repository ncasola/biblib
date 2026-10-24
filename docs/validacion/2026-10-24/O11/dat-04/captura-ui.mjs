// Captura de «Restaurar una copia por partes» en la app compilada de scratch (3149) con la sesión
// GoTrue real de A. Escritorio: selecciona las dos partes y el manifiesto de una copia sintética de
// 2001 libros, la valida, revisa, confirma y publica desde la UI; después abre el diálogo de la
// exportación por partes. Móvil: una parte v1 suelta (fixture sintético de 111 fichas) llega al paso
// de confirmación del asistente sin desbordar la pantalla. Al final devuelve la biblioteca de A y
// retira solo lo creado desde su inicio. Uso: node captura-ui.mjs <repo> <carpeta de salida>
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const [repo, out] = process.argv.slice(2)
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href)
const require = createRequire(path.join(repo, "package.json"))
const { signInFixture } = await load("tests/integration/support/session.mjs")
const { resolveSeedTarget, loadCensus } = await load("scripts/db/seed-local.mjs")
const { readFixtureStore } = await load("scripts/db/fixture-store.mjs")
const { connect, closeConnection } = await load("scripts/db/target.mjs")
const { stopTree } = await load("tests/integration/lib/process.mjs")
const { chromium } = await import(pathToFileURL(path.join(repo, "node_modules/@playwright/test/index.mjs")).href)
const exporter = require(path.join(repo, ".next", "tests", "lib", "library-export.js"))
const sha256 = (data) => createHash("sha256").update(data).digest("hex")

const resolved = await resolveSeedTarget("scratch")
const a = readFixtureStore(resolved, loadCensus()).accounts.a.id
const sql = connect(resolved, { applicationName: "biblib-dat04-ui" })
const url = "http://127.0.0.1:3149"
const [{ started }] = await sql`select clock_timestamp() as started`
const saved = {
  shelves: (await sql`select to_jsonb(s) as row from biblib.shelves s where s.user_id = ${a} and not s.is_default`).map((r) => r.row),
  books: (await sql`select to_jsonb(b) as row from biblib.books b where b.user_id = ${a}`).map((r) => r.row),
}
const before = await sql`select id, title, shelf_id from biblib.books where user_id = ${a} order by id`
const report = { pasos: [] }
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|DATABASE_URL$|PG|POSTGRES_|BIBLIB_)/i.test(key))), BIBLIB_TARGET: "local", BIBLIB_PROFILE: "scratch", NODE_ENV: "test" }
const app = spawn(process.execPath, ["scripts/next-target.mjs", "start", "local", "--profile", "scratch"], { cwd: repo, env, windowsHide: true, stdio: "ignore" })
const files = mkdtempSync(path.join(tmpdir(), "biblib-dat04-ui-"))
let browser, session
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${url}/login`, { signal: AbortSignal.timeout(2000) })).status === 200) break } catch { /* Arrancando. */ } await new Promise((r) => setTimeout(r, 500)) }
  session = await signInFixture("a", { profile: "scratch" })
  const cookies = session.cookies().filter((c) => c.value !== "").map(({ name, value }) => ({ name, value }))
  browser = await chromium.launch({ channel: "chrome" })

  // Copia sintética de 2001 libros en dos partes con su manifiesto, como la descarga de Ajustes.
  const shelves = [{ id: randomUUID(), title: "[DAT-04 ui] Predeterminada", book_count: 0, isDefault: true }, { id: randomUUID(), title: "[DAT-04 ui] Novela", book_count: 0 }]
  const books = Array.from({ length: 2001 }, (_, i) => ({ id: randomUUID(), isbn: `manual-dat04-ui-${i}`, title: `[DAT-04 ui] Libro ${String(i).padStart(4, "0")}`, authors: [], number_of_pages: 1, publish_date: "",
    cover: { small: "/default-book-cover.webp", medium: "/default-book-cover.webp", large: "/default-book-cover.webp" }, status: "unread", shelf_id: shelves[i % 2].id, shelf_name: "" }))
  const set = exporter.buildBackupSet({ shelves, books }, { exportedAt: new Date(), exportSetId: randomUUID(), sha256 })
  const paths = [...set.files.map((file) => { const p = path.join(files, file.fileName); writeFileSync(p, file.text); return p }), path.join(files, set.manifestFileName)]
  writeFileSync(paths.at(-1), set.manifestText)

  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark", acceptDownloads: true })
  await desktop.addCookies(cookies.map((c) => ({ ...c, url })))
  const page = await desktop.newPage()
  await page.goto(`${url}/settings`)
  const panel = page.getByRole("region", { name: "Restaurar una copia por partes" })
  await panel.getByRole("button", { name: "Seleccionar las partes de la copia" }).waitFor()
  await panel.scrollIntoViewIfNeeded()
  await panel.screenshot({ path: path.join(out, "ui-restaurar-inicio.png") })
  await page.locator("#restore-set-files").setInputFiles(paths)
  await panel.getByText("Conjunto completo y verificado").waitFor({ timeout: 60_000 })
  await panel.screenshot({ path: path.join(out, "ui-restaurar-verificado.png") })
  await panel.getByRole("button", { name: "Revisar qué cambiará" }).click()
  await panel.getByRole("heading", { name: "Restaurar la copia completa" }).waitFor()
  await panel.screenshot({ path: path.join(out, "ui-restaurar-revision.png") })
  await panel.getByRole("button", { name: "Restaurar la copia" }).click()
  const dialog = page.getByRole("alertdialog")
  await dialog.getByLabel("Entiendo que se sustituirá mi colección actual por esta copia.").check()
  await page.screenshot({ path: path.join(out, "ui-restaurar-confirmacion.png") })
  await dialog.getByRole("button", { name: "Sí, restaurar la copia" }).click()
  await panel.getByText("Copia restaurada", { exact: true }).waitFor({ timeout: 60_000 })
  await page.screenshot({ path: path.join(out, "ui-restaurar-publicada.png") })
  const [{ n }] = await sql`select count(*)::int as n from biblib.books where user_id = ${a}`
  report.pasos.push({ escritorio: { libros: n, desbordamiento: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) } })

  // Con 2001 libros, la exportación se divide en dos partes más el manifiesto.
  await page.getByRole("button", { name: "Descargar copia de seguridad" }).click()
  await page.getByRole("dialog").getByText("Descargar el manifiesto del conjunto").waitFor({ timeout: 60_000 })
  await page.screenshot({ path: path.join(out, "ui-exportacion-partes-manifiesto.png") })
  const download = page.waitForEvent("download")
  await page.getByRole("dialog").getByRole("button", { name: /^Descargar parte 2 de 2/ }).click()
  const part = await (await download).path()
  const { readFileSync } = await import("node:fs")
  report.pasos.push({ exportacion: { parteDescargadaBytes: readFileSync(part).byteLength, libros: JSON.parse(readFileSync(part, "utf8")).books.length } })
  await desktop.close()

  // Móvil: una parte v1 suelta llega a la confirmación del asistente.
  const mobile = await browser.newContext({ viewport: { width: 375, height: 812 }, colorScheme: "light" })
  await mobile.addCookies(cookies.map((c) => ({ ...c, url })))
  const phone = await mobile.newPage()
  await phone.goto(`${url}/settings`)
  const mobilePanel = phone.getByRole("region", { name: "Restaurar una copia por partes" })
  await mobilePanel.getByRole("button", { name: "Seleccionar las partes de la copia" }).waitFor()
  await phone.locator("#restore-set-files").setInputFiles([path.join(repo, "tests/fixtures/import/sintetico-111.json")])
  await mobilePanel.getByText("no traen manifiesto").waitFor()
  await mobilePanel.scrollIntoViewIfNeeded()
  await mobilePanel.screenshot({ path: path.join(out, "ui-restaurar-sueltas-movil.png") })
  report.pasos.push({ movil: { desbordamiento: await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth) } })
  await mobile.close()
} catch (error) {
  report.error = String(error?.message ?? error).slice(0, 300)
} finally {
  await browser?.close()
  stopTree(app)
  rmSync(files, { recursive: true, force: true })
  await sql.begin(async (tx) => {
    await tx`delete from biblib.books where user_id = ${a}`
    await tx`delete from biblib.shelves where user_id = ${a} and not is_default`
    if (saved.shelves.length) await tx`insert into biblib.shelves select * from jsonb_populate_recordset(null::biblib.shelves, ${tx.json(saved.shelves)})`
    if (saved.books.length) await tx`insert into biblib.books select * from jsonb_populate_recordset(null::biblib.books, ${tx.json(saved.books)})`
  })
  const ops = sql`select id from biblib.library_operations where user_id = ${a} and created_at >= ${started}`
  await sql`delete from biblib.library_snapshots where user_id = ${a} and source_operation_id in (${ops})`
  await sql`delete from biblib.library_operations where user_id = ${a} and created_at >= ${started}`
  await sql`delete from biblib.import_sessions where user_id = ${a} and created_at >= ${started}`
  await sql`delete from biblib.import_previews where user_id = ${a} and created_at >= ${started}`
  const after = await sql`select id, title, shelf_id from biblib.books where user_id = ${a} order by id`
  report.bibliotecaDevuelta = JSON.stringify(after) === JSON.stringify(before)
  await session?.client.auth.signOut({ scope: "local" }).catch(() => {})
  await closeConnection(sql)
  writeFileSync(path.join(out, "ui-informe.json"), JSON.stringify(report, null, 1))
  console.log(JSON.stringify(report))
}

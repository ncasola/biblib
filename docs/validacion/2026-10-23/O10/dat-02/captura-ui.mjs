// Captura de la sección «Versiones anteriores» en la app scratch (3149) con la sesión GoTrue real de A:
// reemplaza la biblioteca con un archivo marcado, abre el historial, compara, restaura desde la UI y
// comprueba que A vuelve a sus IDs. Si algo falla, devuelve la biblioteca guardada de A. Al final
// retira solo lo creado desde su inicio (versiones, operaciones, trabajos y vistas previas de A).
import { pathToFileURL } from "node:url"
import { writeFileSync } from "node:fs"
const [repo, out] = process.argv.slice(2)
const load = (rel) => import(pathToFileURL(`${repo}/${rel}`).href)
const { signInFixture } = await load("tests/integration/support/session.mjs")
const { callAction, loadActions } = await load("tests/integration/lib/app.mjs")
const { resolveSeedTarget, loadCensus } = await load("scripts/db/seed-local.mjs")
const { readFixtureStore } = await load("scripts/db/fixture-store.mjs")
const { connect, closeConnection } = await load("scripts/db/target.mjs")
const { chromium } = await import(pathToFileURL(`${repo}/node_modules/@playwright/test/index.mjs`).href)

const resolved = await resolveSeedTarget("scratch")
const a = readFixtureStore(resolved, loadCensus()).accounts.a.id
const sql = connect(resolved, { applicationName: "biblib-dat02-ui" })
const app = { url: "http://127.0.0.1:3149", actions: loadActions(resolved.stack.root) }
const [{ started }] = await sql`select clock_timestamp() as started`
const saved = {
  shelves: (await sql`select to_jsonb(s) as row from biblib.shelves s where s.user_id = ${a} and not s.is_default`).map((r) => r.row),
  books: (await sql`select to_jsonb(b) as row from biblib.books b where b.user_id = ${a}`).map((r) => r.row),
}
const before = await sql`select id, title, shelf_id from biblib.books where user_id = ${a} order by id`
const report = { pasos: [] }
const browser = await chromium.launch({ channel: "chrome" })
const session = await signInFixture("a", { profile: "scratch" })
const cookies = session.cookies().filter((c) => c.value !== "").map(({ name, value }) => ({ name, value }))
try {
  const cover = "/default-book-cover.webp"
  const file = { shelves: [{ id: "s-ui", title: "[DAT-02 ui] Importación", book_count: 2 }], books: [0, 1].map((i) => ({ id: `b-ui-${i}`, isbn: `manual-dat02-ui-${i}`, title: `[DAT-02 ui] Importado ${i}`, authors: [], number_of_pages: 10, publish_date: "", cover: { small: cover, medium: cover, large: cover }, status: "unread", shelf_id: "s-ui", shelf_name: "[DAT-02 ui] Importación" })) }
  const prepared = (await callAction(app, "prepareImportAction", [file, "replace"], { cookies })).value.value
  const confirmed = (await callAction(app, "confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey: `dat02-ui-${Date.now()}-reemplazo` }], { cookies })).value
  report.pasos.push({ reemplazo: confirmed.ok, libros: confirmed.value?.result?.imported })
  for (const [name, viewport] of [["escritorio", { width: 1280, height: 900 }], ["movil", { width: 375, height: 812 }]]) {
    const context = await browser.newContext({ viewport, colorScheme: name === "movil" ? "light" : "dark" })
    await context.addCookies(cookies.map((c) => ({ ...c, url: app.url })))
    const page = await context.newPage()
    await page.goto(`${app.url}/settings`)
    const history = page.getByRole("region", { name: "Versiones anteriores" })
    await history.getByText("Antes de reemplazar la biblioteca con una importación").first().waitFor()
    await history.scrollIntoViewIfNeeded()
    await history.screenshot({ path: `${out}/ui-historial-${name}.png` })
    report.pasos.push({ [name]: { desbordamiento: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) } })
    if (name === "escritorio") {
      await history.getByRole("button", { name: /^Revisar la restauración de la versión/ }).first().click()
      await history.getByRole("heading", { name: /^Restaurar la versión del/ }).waitFor()
      await history.screenshot({ path: `${out}/ui-comparacion.png` })
      await history.getByRole("button", { name: "Restaurar esta versión" }).click()
      const dialog = page.getByRole("alertdialog")
      await dialog.getByLabel("Entiendo que se sustituirá mi colección actual por esta versión.").check()
      await page.screenshot({ path: `${out}/ui-confirmacion.png` })
      await dialog.getByRole("button", { name: "Sí, restaurar versión" }).click()
      await page.getByRole("status").filter({ hasText: "Versión restaurada" }).waitFor()
      await page.screenshot({ path: `${out}/ui-restaurada.png` })
    }
    await context.close()
  }
  const after = await sql`select id, title, shelf_id from biblib.books where user_id = ${a} order by id`
  report.pasos.push({ deshacerDevuelveIds: JSON.stringify(after) === JSON.stringify(before), libros: after.length })
} catch (error) {
  report.error = String(error?.message ?? error).slice(0, 300)
} finally {
  await browser.close()
  const current = await sql`select id, title, shelf_id from biblib.books where user_id = ${a} order by id`
  if (JSON.stringify(current) !== JSON.stringify(before)) {
    // Devuelve exactamente la biblioteca guardada de A (la predeterminada no cambia).
    await sql.begin(async (tx) => {
      await tx`delete from biblib.books where user_id = ${a}`
      await tx`delete from biblib.shelves where user_id = ${a} and not is_default`
      if (saved.shelves.length) await tx`insert into biblib.shelves select * from jsonb_populate_recordset(null::biblib.shelves, ${tx.json(saved.shelves)})`
      if (saved.books.length) await tx`insert into biblib.books select * from jsonb_populate_recordset(null::biblib.books, ${tx.json(saved.books)})`
    })
    report.restauradaPorElScript = true
  }
  const ops = sql`select id from biblib.library_operations where user_id = ${a} and created_at >= ${started}`
  await sql`delete from biblib.library_snapshots where user_id = ${a} and source_operation_id in (${ops})`
  await sql`delete from biblib.library_jobs where user_id = ${a} and created_at >= ${started}`
  await sql`delete from biblib.library_operations where user_id = ${a} and created_at >= ${started}`
  await sql`delete from biblib.import_previews where user_id = ${a} and created_at >= ${started}`
  await session.client.auth.signOut({ scope: "local" }).catch(() => {})
  await closeConnection(sql)
  writeFileSync(`${out}/ui-informe.json`, JSON.stringify(report, null, 1))
  console.log(JSON.stringify(report))
}

import { readFile } from "node:fs/promises"
import { expect, test } from "../lib/fixtures"

// Escenarios heredados de scripts/smoke-app.mjs que no encajan en otro grupo: recuperación de portadas
// sin red externa, exportación dividida en partes y nombre de perfil guardado en GoTrue (como A).

// Recuperación de portadas (U-DAT-03 + U-BIB-05): el trabajo consulta el orquestador en modo fixture, sin
// salir de loopback (lo vigilan el guard del servidor y el runner). Los fixtures no aportan imágenes: todo
// libro con ISBN válido y portada genérica termina «sin resultado» y ninguno se modifica.
test("la recuperación de portadas termina en modo fixture sin salir a la red ni modificar fichas", async ({ page, stack }) => {
  const [{ started }] = await stack.sql`select clock_timestamp() as started`
  const coversBefore = await stack.sql`select id, version, cover_large from biblib.books where user_id = ${stack.users.a} order by id`
  try {
    await page.goto("/settings")
    await page.getByRole("button", { name: /^(Recuperar portadas pendientes|Buscar portadas de nuevo)$/ }).click()
    const panel = page.locator("[aria-labelledby=covers-title]")
    await expect(panel.getByText("Búsqueda terminada. Las portadas encontradas ya están guardadas.")).toBeVisible({ timeout: 30_000 })
    await expect(panel.locator("dl > div").filter({ has: page.locator("dt", { hasText: "Portadas recuperadas" }) }).locator("dd")).toHaveText("0")
    const [job] = await stack.sql`select id, state, counts from biblib.library_jobs where user_id = ${stack.users.a} and kind = 'covers' and created_at >= ${started}`
    expect(job.state).toBe("succeeded")
    const states = await stack.sql`select state, count(*)::int as n from biblib.library_job_items where job_id = ${job.id} group by state`
    expect(states.every((row) => ["not_found", "skipped"].includes(String(row.state))), "Sin fuente de imágenes en fixture: sin portadas recuperadas ni fallos").toBe(true)
    expect(await stack.sql`select id, version, cover_large from biblib.books where user_id = ${stack.users.a} order by id`, "Ninguna ficha cambia").toEqual(coversBefore)
  } finally {
    // Los trabajos del ensayo no son datos del censo: se retiran para no acumularlos entre ejecuciones.
    await stack.sql`delete from biblib.library_jobs where user_id = ${stack.users.a} and created_at >= ${started}`
  }
})

test("una colección de más de 2000 fichas se exporta en dos partes importables", async ({ page, stack, data }) => {
  const slug = data.slug("partes")
  const shelfId = await data.shelf("a", `Partes ${slug}`)
  const prefix = data.marked(`${slug} lote `)
  const [{ count: existing }] = await stack.sql`select count(*)::int as count from biblib.books where user_id = ${stack.users.a}`
  const extra = 2001 - Number(existing)
  await stack.sql`insert into biblib.books (user_id, isbn, title, status, shelf_id)
    select ${stack.users.a}, 'manual-' || gen_random_uuid(), ${prefix} || n, 'unread', ${shelfId} from generate_series(1, ${extra}) as n`

  await page.goto("/settings")
  await page.getByRole("button", { name: "Descargar copia de seguridad" }).click()
  await expect(page.getByText("Copia dividida en 2 archivos importables")).toBeVisible({ timeout: 30_000 })
  const parts = []
  for (const label of [/^Descargar parte 1 de 2 · 2000 libros/, /^Descargar parte 2 de 2 · 1 libros/]) {
    const download = page.waitForEvent("download")
    await page.getByRole("button", { name: label }).click()
    const raw = await readFile(String(await (await download).path()))
    expect(raw.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024)
    parts.push(JSON.parse(raw.toString("utf8")) as { formatVersion: number; exportedAt: string; books: { id: string; shelf_id: string }[]; shelves: { id: string; book_count: number }[] })
  }
  expect(new Set(parts.map((part) => part.exportedAt)).size, "Las partes comparten fecha").toBe(1)
  for (const part of parts) {
    expect(part.formatVersion).toBe(1)
    const shelves = new Set(part.shelves.map((shelf) => shelf.id))
    expect(part.books.every((book) => shelves.has(book.shelf_id)), "Cada ficha lleva su estantería en la parte").toBe(true)
  }
  const ids = parts.flatMap((part) => part.books.map((book) => book.id))
  expect(ids).toHaveLength(2001)
  expect(new Set(ids).size, "Sin duplicados").toBe(2001)
  expect(ids).toContain(stack.fixtureBookId("a", "isla"))
})

test("el perfil guarda el nombre en GoTrue y muestra la confirmación real", async ({ page, stack }) => {
  const name = `Lectora E2E ${stack.runId.slice(0, 4)}`
  try {
    await page.goto("/profile")
    await expect(page).toHaveTitle("Perfil · BibLib")
    await page.getByLabel("Nombre").fill(name)
    await page.getByRole("button", { name: "Guardar cambios" }).click()
    await expect(page.getByText("Perfil actualizado correctamente.")).toBeVisible()
    const [row] = await stack.sql`select raw_user_meta_data->>'display_name' as name from auth.users where id = ${stack.users.a}`
    expect(row.name).toBe(name)
  } finally {
    // El nombre de la cuenta ficticia vuelve a su valor del censo.
    await stack.resetDisplayName("a")
  }
})

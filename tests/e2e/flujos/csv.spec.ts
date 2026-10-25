import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { Page } from "@playwright/test"
import { capture, expect, test, type Stack } from "../lib/fixtures"

const hash = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex")
const file = (slug: string, text: string) => ({ name: `${slug}.csv`, mimeType: "text/csv", buffer: Buffer.from(text, "utf8") })
const csvPanel = (page: Page) => page.getByRole("region", { name: "Importar CSV", exact: true })
const count = async (stack: Stack) => Number((await stack.sql`select count(*)::int as n from biblib.copies where user_id=${stack.users.a}`)[0].n)

async function cleanCsv(stack: Stack, inputHash: string) {
  const sessions = await stack.sql`select id from biblib.import_sessions where user_id=${stack.users.a} and source='csv' and input_sha256=${inputHash}`
  for (const session of sessions) {
    const previews = await stack.sql`select id from biblib.import_previews where user_id=${stack.users.a} and plan#>>'{csv,sessionId}'=${String(session.id)}`
    if (previews.length) await stack.sql`delete from biblib.library_jobs where user_id=${stack.users.a} and preview_id in ${stack.sql(previews.map((row) => String(row.id)))}`
    await stack.sql`delete from biblib.import_sessions where id=${session.id} and user_id=${stack.users.a}`
  }
}
async function openCsv(page: Page, input: ReturnType<typeof file>, targets: Record<string, string>) {
  await page.goto("/settings")
  await expect(page.getByRole("button", { name: "Seleccionar archivo CSV", exact: true })).toBeEnabled()
  await page.locator("#csv-file").setInputFiles(input)
  const panel = csvPanel(page)
  await expect(panel.getByRole("heading", { name: `Mapeo: ${input.name}` })).toBeVisible()
  for (const [header, target] of Object.entries(targets)) await panel.getByLabel(`Destino de ${header}`, { exact: true }).selectOption(target)
  await panel.getByRole("button", { name: "Guardar mapeo CSV", exact: true }).click()
  await expect(panel.getByRole("status")).toContainText("Mapeo guardado")
  return panel
}

test.describe.configure({ mode: "serial" })

test("CSV: mapeo, estado desconocido y fórmulas, omisión explícita e informe; seleccionar no publica", async ({ page, stack, data }, testInfo) => {
  const slug = data.slug("csv-errores")
  const validTitle = data.marked(`${slug} válido`)
  const input = file(slug, `\uFEFFTítulo,Autor,Estado\n"${validTitle}","Apellido, Nombre",Sin leer\n${data.marked(`${slug} inválido`)},Ana,=1+1`)
  const before = await count(stack)
  try {
    const panel = await openCsv(page, input, { Título: "title", Autor: "authors", Estado: "status" })
    expect(await count(stack)).toBe(before)
    await expect(panel.getByRole("region", { name: "Incidencias CSV" })).toContainText("UNKNOWN_STATUS")
    await panel.getByRole("button", { name: "Preparar revisión CSV", exact: true }).click()
    await expect(panel.getByRole("alert")).toContainText("contiene filas con errores")
    const download = page.waitForEvent("download")
    await panel.getByRole("button", { name: "Descargar informe CSV", exact: true }).click()
    const report = await readFile(String(await (await download).path()), "utf8")
    expect(report).toContain("UNKNOWN_STATUS"); expect(report).toContain('"\'=1+1"')
    await panel.getByLabel("Importar solo las filas válidas y omitir las filas con errores").check()
    await panel.getByRole("button", { name: "Preparar revisión CSV", exact: true }).click()
    await expect(panel.getByRole("region", { name: "Revisión CSV", exact: true })).toContainText("Registro 2: UNKNOWN_STATUS")
    expect(await count(stack)).toBe(before)
    await capture(page, testInfo, "csv-mapeo-incidencias")
    await panel.getByRole("button", { name: "Continuar y confirmar CSV" }).click()
    await page.getByRole("button", { name: "Sí, importar CSV", exact: true }).click()
    await expect(panel.getByRole("status")).toContainText("CSV importado: 1 ejemplar")
    const [book] = await stack.sql`select authors from biblib.books where user_id=${stack.users.a} and title=${validTitle}`
    expect(book.authors).toEqual([{ name: "Apellido, Nombre" }])
    expect(await count(stack)).toBe(before + 1)
  } finally { await cleanCsv(stack, hash(input.buffer)) }
})

test("CSV: cambio en otra pestaña da CAS y remap exige una revisión nueva", async ({ page, context, stack, data }) => {
  const slug = data.slug("csv-cas")
  const input = file(slug, `Título,Autor\n${data.marked(slug)},Ana`)
  const before = await count(stack)
  try {
    const panel = await openCsv(page, input, { Título: "title", Autor: "authors" })
    await panel.getByRole("button", { name: "Preparar revisión CSV", exact: true }).click()
    await expect(panel.getByRole("region", { name: "Revisión CSV", exact: true })).toBeVisible()
    const second = await context.newPage()
    await second.goto("/shelves")
    await second.getByRole("button", { name: "Nueva estantería" }).click()
    await second.getByLabel("Nombre de la estantería").fill(data.marked(`${slug} otra pestaña`))
    await second.getByRole("button", { name: "Crear estantería" }).click()
    await expect(second.getByRole("heading", { name: data.marked(`${slug} otra pestaña`) })).toBeVisible()
    await second.close()
    await panel.getByRole("button", { name: "Continuar y confirmar CSV" }).click()
    await page.getByRole("button", { name: "Sí, importar CSV", exact: true }).click()
    await expect(panel.getByRole("alert")).toContainText("Tu biblioteca ha cambiado")
    expect(await count(stack)).toBe(before)
    await panel.getByLabel("Destino de Autor", { exact: true }).selectOption("ignore")
    await expect(panel.getByRole("button", { name: "Continuar y confirmar CSV" })).toHaveCount(0)
    await panel.getByRole("button", { name: "Guardar mapeo CSV", exact: true }).click()
    await expect(panel.getByRole("status")).toContainText("Mapeo guardado")
    await panel.getByRole("button", { name: "Preparar revisión CSV", exact: true }).click()
    await panel.getByRole("button", { name: "Continuar y confirmar CSV" }).click()
    await page.getByRole("button", { name: "Sí, importar CSV", exact: true }).click()
    await expect(panel.getByRole("status")).toContainText("CSV importado: 1 ejemplar")
    expect(await count(stack)).toBe(before + 1)
  } finally { await cleanCsv(stack, hash(input.buffer)) }
})

test("CSV: otra copia se elige expresamente y conserva la verificación de la copia anterior", async ({ page, stack, data }) => {
  const slug = data.slug("csv-copia")
  const [existing] = await data.books("a", await data.defaultShelf("a"), [{ title: `Edición ${slug}`, isbn: "9780201633610", verified: true }])
  const [edition] = await stack.sql`select edition_id from biblib.copies where id=${existing}`
  const input = file(slug, `Título,ISBN\n${data.marked(`${slug} candidato`)},9780201633610`)
  try {
    const panel = await openCsv(page, input, { Título: "title", ISBN: "isbn" })
    await expect(panel.getByLabel("Libros ya existentes")).toHaveValue("skip-existing")
    await panel.getByLabel("Libros ya existentes").selectOption("another-copy")
    await panel.getByRole("button", { name: "Preparar revisión CSV", exact: true }).click()
    await panel.getByRole("button", { name: "Continuar y confirmar CSV" }).click()
    await page.getByRole("button", { name: "Sí, importar CSV", exact: true }).click()
    await expect(panel.getByRole("status")).toContainText("CSV importado: 1 ejemplar")
    const copies = await stack.sql`select id,edition_verification from biblib.copies where edition_id=${edition.edition_id}`
    expect(copies).toHaveLength(2)
    expect(copies.find((row) => row.id === existing)?.edition_verification.isbnVerified).toBe(true)
    expect(copies.find((row) => row.id !== existing)?.edition_verification.isbnVerified).toBe(false)
  } finally {
    await cleanCsv(stack, hash(input.buffer))
    await stack.sql`delete from biblib.copies where edition_id=${edition.edition_id} and id<>${existing} and user_id=${stack.users.a}`
  }
})

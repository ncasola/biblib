import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { productContext, value } from "../product/lib/context.mjs"

let ctx, a, b, sa, sb, library, other
before(async () => {
  ctx = await productContext()
  a = await ctx.account("personal-a"); b = await ctx.account("personal-b")
  sa = await ctx.signIn(a); sb = await ctx.signIn(b)
  library = await ctx.library(a.id); other = await ctx.library(b.id)
})
after(async () => { await ctx?.cleanup(); await ctx?.close() })

const fail = (result, code) => { assert.equal(result.status, 200); assert.equal(result.value?.ok, false); assert.equal(result.value.error.code, code) }
const book = async (id, session = sa) => (await ctx.call("getBookDetailAction", [id], session)).value
const save = async (id, personal, session = sa, expectedVersion) => ctx.call("saveCopyPersonalAction", [{ copyId: id, expectedVersion: expectedVersion === undefined ? (await book(id, session))?.personalVersion ?? null : expectedVersion, personal }], session)
const createTag = async (name, session = sa) => value(await ctx.call("createTagAction", [name], session))

test("personal: alta atómica, reintento idempotente y otra copia empieza vacía", async () => {
  const input = { isbn13: null, title: ctx.label("alta personal"), authors: [], number_of_pages: 0, publish_date: "", status: "unread", placement: { shelfId: library.shelf }, idempotencyKey: ctx.key("alta"), personal: { notes: "Nota privada 📚", rating: 4, tagNames: ["Ficción"] } }
  const created = value(await ctx.call("createEditionAction", [input], sa))
  assert.equal(created.personal.notes, input.personal.notes)
  assert.equal(created.personal.rating, 4)
  assert.equal(created.personal.tagIds.length, 1)
  assert.ok(created.personalVersion)
  assert.equal(value(await ctx.call("createEditionAction", [input], sa)).id, created.id)
  fail(await ctx.call("createEditionAction", [{ ...input, personal: { notes: "Otra" } }], sa), "IDEMPOTENCY_CONFLICT")
  const second = value(await ctx.call("createCopyAction", [{ editionId: created.edition.id, placement: { shelfId: library.shelf }, status: "unread", idempotencyKey: ctx.key("copia") }], sa))
  assert.equal((await book(second.id)).personal, undefined)
  assert.equal((await book(second.id)).personalVersion, null)
})

test("personal: CRUD, notas de 4000 puntos de código y ausencia explícita", async () => {
  const id = library.books[0].id
  const changed = value(await save(id, { notes: "📚".repeat(4000), rating: 5, tagNames: ["Lectura"] }))
  assert.equal([...changed.personal.notes].length, 4000)
  const cleared = value(await save(id, { notes: "", rating: null, tagIds: [] }))
  assert.equal(cleared.personal, undefined)
  assert.notEqual(cleared.personalVersion, changed.personalVersion)
  fail(await save(id, { notes: "x".repeat(4001) }), "INVALID_INPUT")
  for (const rating of [0, 6, 2.5, "5"]) fail(await save(id, { rating }), "INVALID_INPUT")
  fail(await createInvalidTag("a".repeat(41)), "INVALID_INPUT")
  fail(await createInvalidTag("a\nb"), "INVALID_INPUT")
  fail(await save(id, { tagNames: Array.from({ length: 21 }, (_, n) => `Límite ${n}`) }), "INVALID_INPUT")
  const full = value(await save(id, { tagNames: Array.from({ length: 20 }, (_, n) => `Límite ${n}`) }))
  assert.equal(full.personal.tagIds.length, 20)
})
const createInvalidTag = (name) => ctx.call("createTagAction", [name], sa)

test("personal: duplicados simultáneos Unicode reutilizan un ID; ñ se distingue de n", async () => {
  const results = await Promise.all(["NÓVELA", "Nóvela", "No\u0301vela", "novela"].map((name) => createTag(name)))
  assert.equal(new Set(results.map((tag) => tag.id)).size, 1)
  assert.equal((await createTag("AÑO")).id, (await createTag("an\u0303o")).id)
  assert.notEqual((await createTag("ano")).id, (await createTag("año")).id)
})

test("personal: aislamiento A/B en notas, vínculos, etiquetas y mutaciones", async () => {
  const foreign = await createTag("Privada B", sb)
  value(await save(other.books[0].id, { notes: "Solo B", rating: 2, tagIds: [foreign.id] }, sb))
  assert.equal((await book(other.books[0].id)), null)
  assert.ok(!(await ctx.call("getTagsAction", [], sa)).value.some((tag) => tag.id === foreign.id))
  fail(await save(other.books[0].id, { notes: "Inválida" }, sa, null), "NOT_FOUND")
  fail(await save(library.books[1].id, { tagIds: [foreign.id] }), "NOT_FOUND")
  for (const action of ["renameTagAction", "deleteTagAction"]) fail(await ctx.call(action, [{ tagId: foreign.id, expectedVersion: foreign.version, ...(action === "renameTagAction" ? { name: "Cambiada" } : {}) }], sa), "NOT_FOUND")
  assert.equal((await book(other.books[0].id, sb)).personal.notes, "Solo B")
})

test("personal: dos ediciones concurrentes, incluso creación inicial y solo tags, producen un conflicto", async () => {
  for (const id of [library.books[1].id, library.books[2].id]) {
    const version = (await book(id)).personalVersion
    const results = await Promise.all([save(id, { notes: "Primera" }, sa, version), save(id, { tagNames: ["Concurrente"] }, sa, version)])
    assert.equal(results.filter((result) => result.value?.ok).length, 1)
    fail(results.find((result) => !result.value?.ok), "CONFLICT")
    const current = await book(id)
    const next = value(await save(id, { tagNames: ["Solo etiquetas"] }, sa, current.personalVersion))
    fail(await save(id, { notes: "Borrador antiguo" }, sa, current.personalVersion), "CONFLICT")
    assert.notEqual(current.personalVersion, next.personalVersion)
  }
})

test("personal: renombrar y borrar etiqueta conserva ejemplares y detecta borradores antiguos", async () => {
  const tag = await createTag("Renombrable")
  const saved = value(await save(library.books[1].id, { notes: "Se conserva", tagIds: [tag.id] }))
  const renamed = value(await ctx.call("renameTagAction", [{ tagId: tag.id, expectedVersion: tag.version, name: "Renombrada" }], sa))
  fail(await ctx.call("deleteTagAction", [{ tagId: tag.id, expectedVersion: tag.version }], sa), "CONFLICT")
  fail(await save(saved.id, { notes: "Antigua" }, sa, saved.personalVersion), "CONFLICT")
  value(await ctx.call("deleteTagAction", [{ tagId: tag.id, expectedVersion: renamed.version }], sa))
  const current = await book(saved.id)
  assert.equal(current.personal.notes, "Se conserva")
  assert.equal(current.personal.tagIds, undefined)
})

test("personal: borrar una etiqueta importada sin anotación invalida también el token null", async () => {
  const tag = await createTag("Solo vínculo importado")
  const created = value(await ctx.call("createEditionAction", [{ isbn13: null, title: ctx.label("sin anotación"), authors: [], number_of_pages: 0, publish_date: "", status: "unread", placement: { shelfId: library.shelf }, idempotencyKey: ctx.key("sinnota") }], sa))
  await ctx.asUser(a.id, (tx) => tx`insert into biblib.copy_tags (user_id, copy_id, tag_id) values (${a.id}, ${created.id}, ${tag.id})`)
  assert.equal((await book(created.id)).personalVersion, null)
  value(await ctx.call("deleteTagAction", [{ tagId: tag.id, expectedVersion: tag.version }], sa))
  fail(await save(created.id, { notes: "Borrador previo" }, sa, null), "CONFLICT")
  assert.ok((await book(created.id)).personalVersion)
})

test("personal: filtros OR/AND antes de paginar y en combinación con estantería", async () => {
  const red = await createTag("Filtro rojo"), blue = await createTag("Filtro azul")
  value(await save(library.books[0].id, { tagIds: [red.id] }))
  value(await save(library.books[1].id, { tagIds: [blue.id] }))
  value(await save(library.books[2].id, { tagIds: [red.id, blue.id] }))
  const list = async (filter) => (await ctx.call("listBooksAction", [filter], sa)).value
  const filter = { tagIds: [red.id, blue.id], shelf: library.shelf }
  const any = await list(filter)
  assert.equal(any.total, 3)
  assert.ok(any.books.every((row) => row.personal.tagIds.length))
  assert.equal((await list({ ...filter, tagMode: "and" })).total, 1)
  assert.equal((await list({ ...filter, tagMode: "and", tagIds: [red.id, red.id, blue.id] })).total, 1)
  const page = await list({ ...filter, pageSize: 1, page: 2 })
  assert.equal(page.total, 3); assert.equal(page.books.length, 1); assert.equal(page.page, 2)
  const [shelf] = await ctx.sql`insert into biblib.shelves (user_id, title) values (${a.id}, ${ctx.label("otra")}) returning id`
  assert.equal((await list({ ...filter, shelf: shelf.id })).total, 0)
  const foreign = await createTag("Filtro privado", sb)
  assert.equal((await list({ tagIds: [foreign.id] })).total, 0)
})

test("personal: ida y vuelta v2 y reemplazo por importación antigua vacía personales", async () => {
  const id = library.books[0].id
  value(await save(id, { notes: "Viaja 📚", rating: 4, tagNames: ["Exportable"] }))
  const prepared = value(await ctx.call("prepareLibraryExportAction", [], sa))
  assert.equal(prepared.formatVersion, 2)
  const response = await ctx.get(prepared.parts[0].href, sa)
  const exported = JSON.parse(response.body.toString("utf8"))
  assert.equal(exported.copies.find((copy) => copy.id === id).personal.notes, "Viaja 📚")
  const importFile = async (file, mode, session) => {
    const preview = value(await ctx.call("prepareImportAction", [file, mode], session))
    return value(await ctx.call("confirmImportAction", [{ previewId: preview.previewId, expectedRevision: preview.revision, idempotencyKey: ctx.key("import") }], session))
  }
  await importFile(exported, "merge", sb)
  const [copy] = await ctx.sql`select notes, rating from biblib.copy_annotations where user_id = ${b.id} and notes = 'Viaja 📚'`
  assert.deepEqual({ ...copy }, { notes: "Viaja 📚", rating: 4 })
  const legacy = { formatVersion: 1, exportedAt: new Date().toISOString(), shelves: [{ id: "s1", title: "Principal", book_count: 1, isDefault: true }], books: [{ id: "l1", isbn: `manual-personal-${ctx.run}`, title: ctx.label("antiguo"), authors: [], number_of_pages: 0, publish_date: "", status: "unread", shelf_id: "s1", shelf_name: "Principal" }] }
  await importFile(legacy, "replace", sb)
  for (const table of ["tags", "copy_tags", "copy_annotations"]) assert.equal(Number((await ctx.sql.unsafe(`select count(*) as n from biblib.${table} where user_id = $1`, [b.id]))[0].n), 0)
})

test("personal: al llegar a 1000 etiquetas se reutilizan las existentes y se rechazan las nuevas", async () => {
  const existing = await createTag("Reutilizable con cuota llena")
  await ctx.asUser(a.id, (tx) => tx`insert into biblib.tags (user_id, name)
    select ${a.id}, 'Cuota personal ' || n from generate_series(1, 1000 - (select count(*)::int from biblib.tags where user_id = ${a.id})) n`)
  assert.equal((await createTag("REUTILIZABLE CON CUOTA LLENA")).id, existing.id)
  fail(await ctx.call("createTagAction", ["Una etiqueta de más"], sa), "LIMIT_EXCEEDED")
})

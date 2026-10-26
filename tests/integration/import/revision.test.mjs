import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { after, before, test } from "node:test"
import { REPO_ROOT } from "../../../scripts/lib/profiles.mjs"
import { fixtureLibrary, runId, runTitle, RUN_MARKER } from "../lib/context.mjs"
import { callAction } from "../lib/app.mjs"
import { liveCookies, signIn } from "../lib/sessions.mjs"
import { expectFailure, setupSuite } from "../lib/suite.mjs"

// U-DAT-01 contra la app real del perfil test: dos sesiones GoTrue de A, una de B, Server Actions por
// HTTP y Postgres para observar. Ningún reemplazo se confirma sobre los fixtures A/B: los escenarios
// destructivos solo llegan al conflicto y comprueban que no se borró nada.

let s, lib, a1, a2, b, fixturesBefore
const DEFAULT_COVER = { small: "/default-book-cover.webp", medium: "/default-book-cover.webp", large: "/default-book-cover.webp" }
const ok = (result) => result.status === 200 && result.value?.ok === true
const marker = () => `[${RUN_MARKER} ${runId()}]%`
let sequence = 0
const key = (label) => `qa01-${runId()}-${label}-${++sequence}`
const bookInput = (title, extra = {}) => ({ title, isbn: "", authors: [{ name: "Autoría QA" }], number_of_pages: 12, publish_date: "2026", status: "unread", shelf_id: "", cover: {}, ...extra })

/** Archivo legacy pequeño, con títulos marcados por el run y libros sin ISBN (sin red). */
function file(tag, count = 2) {
  const shelfId = `estante-${tag}`, shelfTitle = runTitle(`Importación ${tag}`)
  return {
    shelves: [{ id: shelfId, title: shelfTitle, book_count: count }],
    books: Array.from({ length: count }, (_, index) => ({
      id: `libro-${tag}-${index}`, isbn: `manual-qa01-${runId()}-${tag}-${index}`, title: runTitle(`Libro importado ${tag} ${index}`), authors: [],
      number_of_pages: 10, publish_date: "", cover: DEFAULT_COVER, status: "unread", shelf_id: shelfId, shelf_name: shelfTitle,
    })),
  }
}

async function prepare(cookies, input, mode, userId) {
  const result = await callAction(s.app, "prepareImportAction", [input, mode], { cookies })
  assert.ok(ok(result), `La preparación debía funcionar (${result.value?.error?.code ?? result.status}).`)
  s.record("previews", { id: result.value.value.previewId, userId })
  return result.value.value
}

async function confirm(cookies, prepared, idempotencyKey, userId, overrides = {}) {
  const result = await callAction(s.app, "confirmImportAction", [{ previewId: prepared.previewId, expectedRevision: prepared.revision, idempotencyKey, ...overrides }], { cookies })
  if (ok(result)) s.record("operations", { id: result.value.value.operationId, userId })
  return result
}

/** Registra para la limpieza todo lo que una importación confirmada creó con la marca del run. */
async function recordImported(userId) {
  for (const row of await s.sql`select id from biblib.books where user_id = ${userId} and title like ${marker()}`) s.record("books", { id: row.id, userId })
  for (const row of await s.sql`select id from biblib.shelves where user_id = ${userId} and title like ${marker()} and not is_default`) s.record("shelves", { id: row.id, userId })
}

const revisionOf = async (userId) => (await s.sql`select revision from biblib.library_state where user_id = ${userId}`)[0]?.revision
const collection = (userId) => s.sql`select b.id, b.version, b.shelf_id, b.status, b.cover_large, b.title from biblib.books b where b.user_id = ${userId} order by b.id`
const shelvesOf = (userId) => s.sql`select id, title, is_default from biblib.shelves where user_id = ${userId} order by id`
const operationsFor = async (userId, idempotencyKey) => (await s.sql`select count(*)::int as n from biblib.library_operations where user_id = ${userId} and idempotency_key = ${idempotencyKey}`)[0].n
const markedCount = async (userId, label) => (await s.sql`select count(*)::int as n from biblib.books where user_id = ${userId} and title like ${`${runTitle(label)}%`}`)[0].n

before(async () => {
  s = await setupSuite()
  lib = await fixtureLibrary(s.ctx, s.sql)
  a1 = liveCookies(await signIn("a"))
  a2 = liveCookies(await signIn("a"))
  b = liveCookies(await signIn("b"))
  fixturesBefore = await s.sql`select id, version from biblib.books where id = any(${lib.a.fixtureBooks}) order by id`
})
after(async () => {
  await s?.cleanupOwn()
  await s?.close()
})

test("reemplazo preparado y cambio posterior en otra sesión de A: conflicto, nada se borra y el reintento no lo fuerza", async () => {
  const shelf = await callAction(s.app, "createShelfAction", [runTitle("Estante conflicto")], { cookies: a1 })
  assert.ok(ok(shelf))
  const [shelfRow] = await s.sql`select id from biblib.shelves where user_id = ${lib.a.userId} and title = ${runTitle("Estante conflicto")}`
  s.record("shelves", { id: shelfRow.id, userId: lib.a.userId })
  const created = await callAction(s.app, "addBookAction", [bookInput(runTitle("Libro vigilado"))], { cookies: a1 })
  assert.ok(ok(created))
  const watched = created.value.value
  s.record("books", { id: watched.id, userId: lib.a.userId })
  const current = async () => (await s.sql`select version from biblib.books where id = ${watched.id}`)[0].version

  const mutations = {
    "alta de libro": async () => {
      const added = await callAction(s.app, "addBookAction", [bookInput(runTitle("Alta concurrente"))], { cookies: a2 })
      assert.ok(ok(added))
      s.record("books", { id: added.value.value.id, userId: lib.a.userId })
    },
    "cambio de estantería": async () => assert.ok(ok(await callAction(s.app, "moveBookShelfAction", [watched.id, shelfRow.id, await current()], { cookies: a2 }))),
    "cambio de estado": async () => assert.ok(ok(await callAction(s.app, "updateBookStatusAction", [watched.id, "reading", await current()], { cookies: a2 }))),
    "cambio de portada": async () => assert.ok(ok(await callAction(s.app, "updateBookAction", [watched.id, bookInput(runTitle("Libro vigilado"), {
      shelf_id: shelfRow.id, status: "reading", version: await current(), cover: { small: "https://covers.biblib.invalid/qa.jpg", medium: "https://covers.biblib.invalid/qa.jpg", large: "https://covers.biblib.invalid/qa.jpg" },
    })], { cookies: a2 }))),
    "renombrar estantería": async () => assert.ok(ok(await callAction(s.app, "renameShelfAction", [shelfRow.id, runTitle("Estante conflicto renombrado")], { cookies: a2 }))),
    // Escritura directa autorizada por RLS (rol authenticated con claims de A), fuera de la app.
    "SQL directo de A": async () => s.sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: lib.a.userId, role: "authenticated" })}, true)`
      await tx.unsafe("set local role authenticated")
      const updated = await tx`update biblib.books set status = 'to-read' where id = ${watched.id} returning id`
      assert.equal(updated.length, 1)
    }),
  }

  for (const [name, mutate] of Object.entries(mutations)) {
    const prepared = await prepare(a1, file(`conflicto-${sequence}`), "replace", lib.a.userId)
    assert.equal(prepared.revision, await revisionOf(lib.a.userId))
    assert.ok(prepared.plan.counts.deleted >= lib.a.fixtureBooks.length, "El plan de reemplazo anuncia la eliminación de la colección actual.")
    await mutate()
    const afterMutation = await revisionOf(lib.a.userId)
    assert.notEqual(afterMutation, prepared.revision, `${name}: la escritura debe rotar la revisión.`)
    const books = await collection(lib.a.userId), shelves = await shelvesOf(lib.a.userId)
    const idempotencyKey = key("conflicto")
    const result = await confirm(a1, prepared, idempotencyKey, lib.a.userId)
    assert.ok(expectFailure(result, "REVISION_CONFLICT"), `${name}: la confirmación antigua debía dar REVISION_CONFLICT.`)
    assert.equal(result.value.error.retryable, false)
    assert.match(result.value.error.correlationId ?? "", /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/)
    assert.match(result.value.error.message, /ha cambiado/)
    assert.ok(expectFailure(await confirm(a1, prepared, idempotencyKey, lib.a.userId), "REVISION_CONFLICT"), `${name}: reintentar la misma confirmación no la aplica.`)
    assert.deepEqual(await collection(lib.a.userId), books, `${name}: no se borra ni cambia ningún libro.`)
    assert.deepEqual(await shelvesOf(lib.a.userId), shelves, `${name}: no cambia ninguna estantería.`)
    assert.equal(await revisionOf(lib.a.userId), afterMutation, `${name}: el conflicto no rota la revisión.`)
    assert.equal(await operationsFor(lib.a.userId, idempotencyKey), 0)
  }

  // Volver a revisar con los datos actuales produce una revisión nueva y válida (no se confirma: reemplazaría fixtures).
  const again = await prepare(a1, file("revisar"), "replace", lib.a.userId)
  assert.equal(again.revision, await revisionOf(lib.a.userId))
})

test("una mutación de B no invalida la revisión de A; la confirmación aplica el plan una sola vez", async () => {
  const prepared = await prepare(a1, file("fusion", 3), "merge", lib.a.userId)
  assert.equal(prepared.plan.counts.added, 3)
  assert.equal(prepared.plan.counts.deleted, 0)
  const before = await revisionOf(lib.a.userId), beforeB = await revisionOf(lib.b.userId)
  const added = await callAction(s.app, "addBookAction", [bookInput(runTitle("Libro de B"))], { cookies: b })
  assert.ok(ok(added))
  s.record("books", { id: added.value.value.id, userId: lib.b.userId })
  assert.notEqual(await revisionOf(lib.b.userId), beforeB)
  assert.equal(await revisionOf(lib.a.userId), before, "La escritura de B no toca la revisión de A.")

  const idempotencyKey = key("fusion")
  const first = await confirm(a1, prepared, idempotencyKey, lib.a.userId)
  assert.ok(ok(first), `La confirmación debía aplicarse (${first.value?.error?.code}).`)
  await recordImported(lib.a.userId)
  assert.equal(first.value.value.status, "committed")
  assert.equal(first.value.value.replayed, false)
  assert.equal(first.value.value.result.imported, 3)
  assert.equal(await markedCount(lib.a.userId, "Libro importado fusion"), 3)
  assert.notEqual(await revisionOf(lib.a.userId), before, "Confirmar rota la revisión.")

  // Respuesta perdida: repetir con la misma clave devuelve el mismo resultado sin duplicar.
  const replay = await confirm(a1, prepared, idempotencyKey, lib.a.userId)
  assert.ok(ok(replay))
  assert.equal(replay.value.value.operationId, first.value.value.operationId)
  assert.equal(replay.value.value.replayed, true)
  assert.deepEqual(replay.value.value.result, first.value.value.result)
  assert.equal(await markedCount(lib.a.userId, "Libro importado fusion"), 3)
  assert.equal(await operationsFor(lib.a.userId, idempotencyKey), 1)

  // La misma clave con el mismo archivo en otro modo, o con otro archivo: IDEMPOTENCY_CONFLICT sin ejecutar nada.
  const books = await collection(lib.a.userId)
  const otherMode = await prepare(a1, file("fusion", 3), "replace", lib.a.userId)
  assert.equal(otherMode.digest, prepared.digest, "Mismo archivo, mismo hash de entrada.")
  assert.ok(expectFailure(await confirm(a1, otherMode, idempotencyKey, lib.a.userId), "IDEMPOTENCY_CONFLICT"))
  const otherFile = await prepare(a1, file("otro", 1), "merge", lib.a.userId)
  assert.ok(expectFailure(await confirm(a1, otherFile, idempotencyKey, lib.a.userId), "IDEMPOTENCY_CONFLICT"))
  assert.deepEqual(await collection(lib.a.userId), books, "Ningún conflicto de clave borra ni añade libros.")
  assert.equal(await operationsFor(lib.a.userId, idempotencyKey), 1)

  // Una vista previa ya confirmada no se reutiliza con otra clave.
  assert.ok(expectFailure(await confirm(a1, prepared, key("reuso"), lib.a.userId), "CONFLICT"))
})

test("doble confirmación simultánea con la misma clave produce una única operación", async () => {
  const prepared = await prepare(a1, file("doble", 2), "merge", lib.a.userId)
  const idempotencyKey = key("doble")
  const results = await Promise.all([confirm(a1, prepared, idempotencyKey, lib.a.userId), confirm(a2, prepared, idempotencyKey, lib.a.userId)])
  await recordImported(lib.a.userId)
  assert.ok(results.every(ok), "Ambas respuestas deben ser correctas.")
  assert.equal(new Set(results.map((result) => result.value.value.operationId)).size, 1)
  assert.deepEqual(results.map((result) => result.value.value.replayed).sort(), [false, true])
  assert.equal(await markedCount(lib.a.userId, "Libro importado doble"), 2)
  assert.equal(await operationsFor(lib.a.userId, idempotencyKey), 1)
})

test("una vista previa caducada exige volver a revisar y no aplica nada", async () => {
  const prepared = await prepare(a1, file("caduca", 1), "merge", lib.a.userId)
  assert.ok(Date.parse(prepared.expiresAt) - Date.now() > 25 * 60 * 1000, "Caducidad inicial de 30 minutos.")
  await s.sql`update biblib.import_previews set expires_at = now() - interval '1 second' where id = ${prepared.previewId} and user_id = ${lib.a.userId}`
  const result = await confirm(a1, prepared, key("caduca"), lib.a.userId)
  assert.ok(expectFailure(result, "PREVIEW_EXPIRED"))
  assert.equal(result.value.error.retryable, false)
  assert.equal(await markedCount(lib.a.userId, "Libro importado caduca"), 0)
})

test("B no puede confirmar ni descubrir una vista previa de A", async () => {
  const prepared = await prepare(a1, file("ajena", 1), "merge", lib.a.userId)
  const revisionA = await revisionOf(lib.a.userId), booksB = await collection(lib.b.userId)
  const result = await confirm(b, prepared, key("ajena"), lib.b.userId)
  assert.ok(expectFailure(result, "NOT_FOUND"), "Para B la vista previa de A no existe.")
  assert.doesNotMatch(JSON.stringify(result.value), new RegExp(prepared.previewId))
  assert.equal(await revisionOf(lib.a.userId), revisionA)
  assert.deepEqual(await collection(lib.b.userId), booksB)
  assert.equal(await markedCount(lib.a.userId, "Libro importado ajena"), 0)
  assert.equal(await markedCount(lib.b.userId, "Libro importado ajena"), 0)
  const [{ n }] = await s.sql`select count(*)::int as n from biblib.library_operations where user_id = ${lib.b.userId} and preview_id = ${prepared.previewId}`
  assert.equal(n, 0)
})

test("los 111 registros sintéticos legacy se revisan y se importan completos", async () => {
  const synthetic = JSON.parse(readFileSync(path.join(REPO_ROOT, "tests/fixtures/import/sintetico-111.json"), "utf8"))
  const label = (text) => runTitle(`111 ${text}`)
  const input = {
    shelves: synthetic.shelves.map((shelf) => shelf.isDefault ? shelf : { ...shelf, title: label(shelf.title) }),
    books: synthetic.books.map((book) => {
      const shelf = synthetic.shelves.find((item) => item.id === book.shelf_id)
      return { ...book, title: label(book.title), shelf_name: shelf.isDefault ? shelf.title : label(shelf.title) }
    }),
  }
  const prepared = await prepare(a1, input, "merge", lib.a.userId)
  assert.equal(prepared.plan.counts.added, 111)
  assert.equal(prepared.plan.counts.shelvesCreated, 4)
  assert.equal(prepared.plan.counts.coversPending, 9, "Solo los 9 manuales quedan con portada genérica, sin consultas externas.")
  const result = await confirm(a1, prepared, key("sintetico"), lib.a.userId)
  assert.ok(ok(result), `La importación de 111 debía aplicarse (${result.value?.error?.code}).`)
  await recordImported(lib.a.userId)
  assert.equal(result.value.value.result.imported, 111)
  const rows = await s.sql`select isbn, status, shelf_id from biblib.books where user_id = ${lib.a.userId} and title like ${`${label("")}%`}`
  assert.equal(rows.length, 111)
  assert.equal(rows.filter((row) => row.isbn.startsWith("manual-")).length, 9, "Los identificadores manuales se conservan sin convertirse en ISBN.")
  assert.equal(rows.filter((row) => row.shelf_id === lib.a.defaultShelf).length, 22, "La predeterminada del archivo se asigna a la de A.")
  assert.deepEqual([...new Set(rows.map((row) => row.status))].sort(), ["read", "reading", "to-read", "unread"])
})

test("los fixtures de A siguen intactos tras todos los escenarios", async () => {
  assert.deepEqual(await s.sql`select id, version from biblib.books where id = any(${lib.a.fixtureBooks}) order by id`, fixturesBefore)
})

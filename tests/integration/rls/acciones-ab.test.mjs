import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fixtureLibrary, runTitle } from "../lib/context.mjs"
import { callAction, postJson } from "../lib/app.mjs"
import { liveCookies, signIn } from "../lib/sessions.mjs"
import { expectFailure, setupSuite } from "../lib/suite.mjs"

// Server Actions reales de la app (build del perfil test en 127.0.0.1:3148) como A y B, con las
// cookies SSR emitidas por GoTrue. La app usa una sola conexión Postgres compartida (max: 1), así
// que cada llamada reutiliza la misma conexión que la anterior, sea de A, de B o fallida.

let s, lib, a, b

before(async () => {
  s = await setupSuite()
  lib = await fixtureLibrary(s.ctx, s.sql)
  a = liveCookies(await signIn("a"))
  b = liveCookies(await signIn("b"))
})
after(() => s?.close())

const ok = (result) => result.status === 200 && result.value?.ok === true
const bookInput = (title, extra = {}) => ({ title, isbn: "", authors: [{ name: "Autoría QA" }], number_of_pages: 12, publish_date: "2026", status: "unread", shelf_id: "", cover: {}, ...extra })

async function snapshotB() {
  return s.sql`select id, title, status, shelf_id, version, user_id from biblib.books where user_id = ${lib.b.userId} order by id`
}

/** Biblioteca de la sesión con acciones acotadas (U-DAT-04 retiró la lectura completa): una página de 100 y sus estanterías. */
async function ownLibrary(cookies) {
  const page = await callAction(s.app, "listBooksAction", [{ pageSize: 100 }], { cookies })
  const shelves = await callAction(s.app, "getShelvesAction", [], { cookies })
  assert.equal(page.status, 200)
  assert.equal(shelves.status, 200)
  assert.ok(page.value.total <= page.value.pageSize, "La biblioteca ficticia cabe en una página: la comprobación ve todas sus fichas.")
  return { books: page.value.books, shelves: shelves.value }
}

test("cada cuenta solo recibe su biblioteca desde las acciones", async () => {
  for (const [key, cookies] of [["a", a], ["b", b]]) {
    const other = key === "a" ? "b" : "a"
    const data = await ownLibrary(cookies)
    const ids = data.books.map((book) => book.id)
    assert.ok(lib[key].fixtureBooks.every((id) => ids.includes(id)), `Faltan libros propios de ${key.toUpperCase()}.`)
    assert.ok(!ids.some((id) => lib[other].books.some((row) => row.id === id)), `${key.toUpperCase()} recibió libros ajenos.`)
    assert.ok(!data.shelves.some((shelf) => lib[other].shelves.some((row) => row.id === shelf.id)))
  }
})

test("A no lee, modifica, mueve ni borra recursos de B manipulando IDs", async () => {
  const before = await snapshotB()
  const bBook = lib.b.book("versos"), bShelf = lib.b.customShelves[0], aBook = lib.a.book("cuaderno")
  assert.equal((await callAction(s.app, "getBookDetailAction", [bBook.id], { cookies: a })).value, null)
  const filtered = await callAction(s.app, "listBooksAction", [{ shelf: bShelf }], { cookies: a })
  assert.equal(filtered.value.total, 0)
  const searched = await callAction(s.app, "listBooksAction", [{ q: "Versos para un faro" }], { cookies: a })
  assert.equal(searched.value.total, 0)

  const attempts = {
    updateStatus: await callAction(s.app, "updateBookStatusAction", [bBook.id, "read", bBook.version], { cookies: a }),
    update: await callAction(s.app, "updateBookAction", [bBook.id, bookInput("Ataque", { version: bBook.version })], { cookies: a }),
    remove: await callAction(s.app, "deleteBookAction", [bBook.id, bBook.version], { cookies: a }),
    moveTheirs: await callAction(s.app, "moveBookShelfAction", [bBook.id, lib.a.defaultShelf, bBook.version], { cookies: a }),
    moveMany: await callAction(s.app, "moveBooksShelfAction", [[bBook.id], lib.a.defaultShelf], { cookies: a }),
    moveMineToTheirs: await callAction(s.app, "moveBookShelfAction", [aBook.id, bShelf, aBook.version], { cookies: a }),
    addInTheirs: await callAction(s.app, "addBookAction", [bookInput(runTitle("Intruso"), { shelf_id: bShelf })], { cookies: a }),
    renameTheirs: await callAction(s.app, "renameShelfAction", [bShelf, "Ataque"], { cookies: a }),
    deleteTheirs: await callAction(s.app, "deleteShelfAction", [bShelf], { cookies: a }),
  }
  for (const [name, result] of Object.entries(attempts)) {
    assert.ok(expectFailure(result, "NOT_FOUND"), `El intento ${name} debía rechazarse como no disponible.`)
  }
  const api = await postJson(s.app, "/api/books/add", bookInput(runTitle("Intruso API"), { shelf_id: bShelf }), { cookies: a })
  assert.equal(api.status, 404)
  assert.deepEqual(await snapshotB(), before, "Los libros de B no cambian.")
  const [{ n }] = await s.sql`select count(*)::int as n from biblib.books where title like ${runTitle("Intruso") + "%"}`
  assert.equal(n, 0)
})

test("anónimo no obtiene datos: el proxy redirige las acciones y la API responde 401", async () => {
  const action = await callAction(s.app, "listBooksAction", [{ pageSize: 100 }])
  assert.equal(action.status, 307)
  assert.match(action.location, /^\/login\?redirect=/)
  assert.equal(action.value, undefined)
  const api = await postJson(s.app, "/api/books/add", bookInput(runTitle("Anónimo")))
  assert.equal(api.status, 401)
  assert.equal(api.json.code, "UNAUTHORIZED")
})

test("CRUD propio como A: versión rotada por el trigger, conflicto con versión antigua y portada por defecto", async () => {
  const shelfTitle = runTitle("Estantería A")
  assert.ok(ok(await callAction(s.app, "createShelfAction", [shelfTitle], { cookies: a })))
  const [shelf] = await s.sql`select id from biblib.shelves where user_id = ${lib.a.userId} and title = ${shelfTitle}`
  s.record("shelves", { id: shelf.id, userId: lib.a.userId })

  const created = await callAction(s.app, "addBookAction", [bookInput(runTitle("Libro A"), { shelf_id: shelf.id })], { cookies: a })
  assert.ok(ok(created))
  const book = created.value.value
  s.record("books", { id: book.id, userId: lib.a.userId })
  assert.equal(book.shelf_id, shelf.id)
  assert.deepEqual(book.cover, { small: "/default-book-cover.webp", medium: "/default-book-cover.webp", large: "/default-book-cover.webp" }, "Sin portada se guarda el fallback local, sin consultar la red.")

  const updated = await callAction(s.app, "updateBookStatusAction", [book.id, "reading", book.version], { cookies: a })
  assert.ok(ok(updated))
  assert.notEqual(updated.value.value.version, book.version, "books_rotate_version debe rotar la versión.")
  assert.ok(expectFailure(await callAction(s.app, "updateBookStatusAction", [book.id, "read", book.version], { cookies: a }), "CONFLICT"), "Una versión antigua produce conflicto.")
  assert.ok(expectFailure(await callAction(s.app, "deleteBookAction", [book.id, book.version], { cookies: a }), "CONFLICT"))

  const moved = await callAction(s.app, "moveBookShelfAction", [book.id, lib.a.defaultShelf, updated.value.value.version], { cookies: a })
  assert.ok(ok(moved))
  assert.ok(ok(await callAction(s.app, "renameShelfAction", [shelf.id, runTitle("Estantería A renombrada")], { cookies: a })))
  assert.ok(ok(await callAction(s.app, "deleteShelfAction", [shelf.id], { cookies: a })))
  s.forget("shelves", { id: shelf.id, userId: lib.a.userId })
  assert.ok(ok(await callAction(s.app, "deleteBookAction", [book.id, moved.value.value.version], { cookies: a })))
  s.forget("books", { id: book.id, userId: lib.a.userId })
  const [{ n }] = await s.sql`select count(*)::int as n from biblib.books where id = ${book.id}`
  assert.equal(n, 0)
})

test("la estantería predeterminada no se borra ni se renombra desde la app", async () => {
  assert.ok(expectFailure(await callAction(s.app, "deleteShelfAction", [lib.a.defaultShelf], { cookies: a }), "CONFLICT"))
  assert.ok(expectFailure(await callAction(s.app, "renameShelfAction", [lib.a.defaultShelf, runTitle("Renombrada")], { cookies: a }), "NOT_FOUND"))
  const [shelf] = await s.sql`select title, is_default from biblib.shelves where id = ${lib.a.defaultShelf}`
  assert.deepEqual(shelf, { title: lib.a.shelves.find((row) => row.is_default).title, is_default: true })
})

test("la conexión de la app no arrastra claims: A, B, fallo de A y B otra vez", async () => {
  const owners = async (cookies) => {
    const data = await ownLibrary(cookies)
    return [...new Set(data.books.map((book) => lib.a.books.some((row) => row.id === book.id) ? "a" : lib.b.books.some((row) => row.id === book.id) ? "b" : "?"))]
  }
  assert.deepEqual(await owners(a), ["a"])
  assert.deepEqual(await owners(b), ["b"])
  // ISBN ya presente en A: la acción lanza dentro de withRlsContext y la transacción se revierte.
  const duplicate = await callAction(s.app, "addBookAction", [bookInput(runTitle("Duplicado"), { isbn: "9780000000019" })], { cookies: a })
  assert.ok(expectFailure(duplicate, "CONFLICT"))
  assert.deepEqual(await owners(b), ["b"], "B no hereda claims tras la transacción fallida de A.")
  assert.deepEqual(await owners(a), ["a"])
})

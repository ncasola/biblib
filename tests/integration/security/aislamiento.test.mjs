import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { liveCookies } from "../lib/sessions.mjs"
import { securityContext } from "./lib/context.mjs"

// U-OPS-04 · Ninguna respuesta de A aparece en otra sesión: se repite exactamente la misma URL (HTML
// y acciones) como A, B y anónimo, intercalando el orden, y se buscan en cada cuerpo los datos únicos
// de A (IDs, títulos, correo). Todas las respuestas deben ser no almacenables (no-store).

let ctx, a, b, dataA, dataB
before(async () => {
  ctx = await securityContext()
  a = liveCookies(await ctx.signIn("a"))
  b = liveCookies(await ctx.signIn("b"))
  const load = async (userId) => ({
    userId,
    books: await ctx.sql`select id, title from biblib.books where user_id = ${userId} order by id`,
    shelves: await ctx.sql`select id, title from biblib.shelves where user_id = ${userId} order by id`,
  })
  dataA = await load(ctx.accounts.a.id)
  dataB = await load(ctx.accounts.b.id)
  assert.ok(dataA.books.length > 0 && dataB.books.length > 0, "Los fixtures A y B tienen libros.")
})
after(() => ctx?.close())

/** Marcadores privados de A que no comparte con B (los títulos repetidos entre cuentas no cuentan). */
function markersOf(owner, other) {
  const otherTitles = new Set([...other.books, ...other.shelves].map((row) => row.title))
  return [
    owner.userId, ctx.accounts[owner === dataA ? "a" : "b"].email,
    ...owner.books.map((row) => row.id), ...owner.shelves.map((row) => row.id),
    ...[...owner.books, ...owner.shelves].map((row) => row.title).filter((title) => title.length >= 6 && !otherTitles.has(title)),
  ]
}

function leaked(text, markers) {
  return markers.filter((marker) => text.includes(marker))
}

const PAGES = ["/", "/books", "/books/search?q=a", "/shelves", "/shelves/3d", "/settings", "/profile"]

test("misma URL de HTML como A, B y anónimo: sin datos de A fuera de A y sin caché compartida", async () => {
  const markersA = markersOf(dataA, dataB)
  for (const route of PAGES) {
    for (const [who, cookies] of [["a", a], ["b", b], ["anon", []], ["b", b], ["a", a], ["anon", []]]) {
      const response = await ctx.request(route, { cookies })
      if (who === "anon") {
        assert.equal(response.status, 307, `${route} anónimo vuelve al acceso`)
        assert.equal(new URL(response.location, ctx.appUrl).pathname, "/login")
      } else assert.equal(response.status, 200, `${route} como ${who}`)
      assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/, `${route} como ${who}`)
      assert.doesNotMatch(response.headers.get("cache-control") ?? "", /public|s-maxage/)
      if (who !== "a") assert.deepEqual(leaked(response.text, markersA), [], `${route} como ${who} no contiene datos de A`)
    }
  }
})

test("misma acción en la misma ruta como A, B y anónimo: cada sesión recibe solo lo suyo", async () => {
  const markersA = markersOf(dataA, dataB)
  const markersB = markersOf(dataB, dataA)
  for (const name of ["getLibraryCountsAction", "getLibrarySummaryAction", "getShelvesAction", "listBooksAction"]) {
    const responses = []
    for (const [who, cookies] of [["a", a], ["b", b], ["anon", []], ["a", a], ["b", b]]) responses.push([who, await ctx.action(name, [], { cookies, route: "/books" })])
    for (const [who, response] of responses) {
      if (who === "anon") {
        assert.equal(response.status, 307, `${name} anónimo no se ejecuta`)
        assert.equal(response.value, undefined)
        continue
      }
      assert.equal(response.status, 200, `${name} como ${who}`)
      assert.equal(response.thrown, false, `${name} como ${who}`)
      assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/)
      const foreign = who === "a" ? markersB : markersA
      assert.deepEqual(leaked(response.text, foreign), [], `${name} como ${who} no contiene datos de la otra cuenta`)
    }
    const own = responses.find(([who]) => who === "a")[1]
    if (name !== "getLibrarySummaryAction" && name !== "getLibraryCountsAction") assert.ok(leaked(own.text, markersA).length > 0, `${name} como A devuelve datos de A (la prueba no es vacía)`)
  }
})

test("ficha de un libro de A: B y anónimo no la obtienen ni por HTML ni por acción", async () => {
  const book = dataA.books[0]
  const route = `/book/${book.id}`
  const asA = await ctx.request(route, { cookies: a })
  assert.equal(asA.status, 200)
  const detailA = await ctx.action("getBookDetailAction", [book.id], { cookies: a, route })
  assert.equal(detailA.value?.id, book.id)
  const asB = await ctx.request(route, { cookies: b })
  assert.equal(asB.status, 404, "La ficha de otra cuenta responde como inexistente (U-FIX-01).")
  assert.match(asB.headers.get("cache-control") ?? "", /\bno-store\b/)
  assert.deepEqual(leaked(asB.text, [book.title, ctx.accounts.a.id]), [])
  const detailB = await ctx.action("getBookDetailAction", [book.id], { cookies: b, route })
  assert.equal(detailB.status, 200)
  assert.equal(detailB.value ?? null, null, "B no obtiene la ficha de A")
  assert.deepEqual(leaked(detailB.text, [book.title]), [])
  const anon = await ctx.request(route)
  assert.equal(anon.status, 307)
})

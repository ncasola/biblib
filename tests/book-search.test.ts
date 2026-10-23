import assert from "node:assert/strict"
import { test } from "node:test"
import {
  BOOK_RETURN_FALLBACK,
  BOOK_RETURN_PARAM,
  bookRowAnchor,
  buildBookDetailHref,
  buildCollectionPath,
  defaultBookSearchFilters,
  normalizeBookSearchQuery,
  parseBookRowAnchor,
  parseBookSearchFilters,
  resolveBookReturnPath,
  serializeBookSearchFilters,
} from "../lib/book-search"

const BOOK_ID = "44444444-4444-4444-8444-444444444444"

test("lee filtros válidos desde la URL y normaliza valores inválidos", () => {
  const filters = parseBookSearchFilters(new URLSearchParams(
    "q=Quijote&status=reading&shelf=shelf-1&sort=-author&page=3&view=grid",
  ))
  assert.deepEqual(filters, {
    q: "Quijote",
    status: "reading",
    shelf: "shelf-1",
    sort: "-author",
    page: 3,
    view: "grid",
  })

  assert.deepEqual(parseBookSearchFilters(new URLSearchParams(
    "status=finished&sort=random&page=-2&view=compact",
  ), "grid"), {
    ...defaultBookSearchFilters("grid"),
  })
})

test("serializa filtros conservando otros parámetros y omitiendo valores predeterminados", () => {
  const filters = {
    ...defaultBookSearchFilters("grid"),
    q: "  Cien años  ",
    status: "unread" as const,
    shelf: "shelf-2",
    sort: "-title" as const,
    page: 4,
  }

  assert.equal(
    serializeBookSearchFilters(filters, new URLSearchParams("campaign=home&status=read")),
    "campaign=home&q=++Cien+a%C3%B1os++&status=unread&shelf=shelf-2&sort=-title&page=4&view=grid",
  )
  assert.equal(serializeBookSearchFilters(defaultBookSearchFilters(), new URLSearchParams()), "")
  const explicitTable = serializeBookSearchFilters(defaultBookSearchFilters(), new URLSearchParams(), "grid")
  assert.equal(parseBookSearchFilters(new URLSearchParams(explicitTable), "grid").view, "table")
})

test("normaliza ISBN con separadores sin alterar consultas de texto", () => {
  assert.equal(normalizeBookSearchQuery("  978-0-306-40615-7  "), "9780306406157")
  assert.equal(normalizeBookSearchQuery("0-306-40615-2"), "0306406152")
  assert.equal(normalizeBookSearchQuery("0-306-40615-x"), "030640615X")
  assert.equal(normalizeBookSearchQuery("  ÁRBOL y canción "), "arbol y cancion")
  assert.equal(normalizeBookSearchQuery("978-0-306-40615"), "978-0-306-40615")
})

test("construye la ruta del listado con sus filtros y sin parámetros ajenos ni valores por defecto", () => {
  assert.equal(buildCollectionPath("/books", defaultBookSearchFilters()), "/books")
  assert.equal(buildCollectionPath("/books/search", defaultBookSearchFilters("grid"), "grid"), "/books/search")
  assert.equal(
    buildCollectionPath("/books", { ...defaultBookSearchFilters(), q: "Cien años", status: "reading", shelf: "s1", sort: "-date", page: 3, view: "grid" }),
    "/books?q=Cien+a%C3%B1os&status=reading&shelf=s1&sort=-date&page=3&view=grid",
  )
})

test("el fragmento de fila solo acepta ids de libro con formato UUID", () => {
  assert.equal(bookRowAnchor(BOOK_ID), `book-row-${BOOK_ID}`)
  assert.equal(parseBookRowAnchor(`#${bookRowAnchor(BOOK_ID)}`), BOOK_ID)
  for (const hash of ["", "#", "#main-content", "#book-row-", "#book-row-1", `#book-row-${BOOK_ID}x`, `book-row-${BOOK_ID}`, "#book-row-<script>"]) {
    assert.equal(parseBookRowAnchor(hash), null, hash)
  }
})

test("acepta como retorno solo rutas internas de la aplicación", () => {
  assert.equal(resolveBookReturnPath("/books"), "/books")
  assert.equal(resolveBookReturnPath("/books?q=Quijote&status=read&page=2&view=grid"), "/books?q=Quijote&status=read&page=2&view=grid")
  assert.equal(resolveBookReturnPath("/books/search?view=grid&shelf=abc"), "/books/search?view=grid&shelf=abc")
  assert.equal(resolveBookReturnPath("/shelves/3d?shelf=abc&page=2"), "/shelves/3d?shelf=abc&page=2")
  assert.equal(resolveBookReturnPath("/"), "/")
  assert.equal(resolveBookReturnPath(`/books?page=2#${bookRowAnchor(BOOK_ID)}`), `/books?page=2#${bookRowAnchor(BOOK_ID)}`)
  assert.equal(resolveBookReturnPath("/books?next=https://example.com"), "/books?next=https://example.com")
})

test("rechaza destinos externos, protocolos, barras dobles, controles y valores ausentes", () => {
  for (const value of [
    undefined, null, "", ["/books"], "https://example.com", "http://example.com/books", "//example.com", "///example.com/books",
    "javascript:alert(1)", "data:text/html,hola", "\\example.com", "/\\example.com", "/\n/example.com", "/\t/example.com", "/\u0000books",
    " /books", "books", "example.com/books",
  ]) {
    assert.equal(resolveBookReturnPath(value), BOOK_RETURN_FALLBACK, String(value))
  }
})

test("rechaza destinos codificados y rutas que no son del listado", () => {
  for (const value of [
    "%2F%2Fexample.com", "%2Fbooks", "%252F%252Fexample.com", "/%2F%2Fexample.com", "/%5Cexample.com",
    "/login", "/login?redirect=/books", "/auth/callback", "/api/books/search", "/books/../login", "/logo.png", "/bookshelf",
    "/book/123", `/book/${BOOK_ID}?from=/books`, "/book",
  ]) {
    assert.equal(resolveBookReturnPath(value), BOOK_RETURN_FALLBACK, value)
  }
  assert.equal(resolveBookReturnPath(`/books?q=${"a".repeat(2100)}`), BOOK_RETURN_FALLBACK)
})

test("normaliza el retorno y descarta fragmentos que no son una fila de libro", () => {
  assert.equal(resolveBookReturnPath("/books/./search?view=grid"), "/books/search?view=grid")
  assert.equal(resolveBookReturnPath("/books?page=2#resultados"), "/books?page=2")
  assert.equal(resolveBookReturnPath("/books#book-row-no-es-uuid"), "/books")
})

test("el enlace al detalle conserva la consulta del listado y se recupera íntegro", () => {
  const filters = { ...defaultBookSearchFilters(), q: "Cien años & más", status: "unread" as const, shelf: "s 1", sort: "-title" as const, page: 4, view: "grid" as const }
  const returnPath = `${buildCollectionPath("/books", filters)}#${bookRowAnchor(BOOK_ID)}`
  const href = buildBookDetailHref(BOOK_ID, returnPath)
  assert.ok(href.startsWith(`/book/${BOOK_ID}?from=`))

  const url = new URL(href, "https://biblib.invalid")
  assert.equal(url.pathname, `/book/${BOOK_ID}`)
  const recovered = resolveBookReturnPath(url.searchParams.get(BOOK_RETURN_PARAM))
  assert.equal(recovered, returnPath)
  const [recoveredPath, recoveredHash] = recovered.split("#")
  const recoveredQuery = new URL(recoveredPath, "https://biblib.invalid").searchParams
  assert.deepEqual(parseBookSearchFilters(recoveredQuery), filters)
  assert.equal(recoveredHash, bookRowAnchor(BOOK_ID))
})

test("el enlace al detalle no añade retorno cuando no hay uno válido o es el predeterminado", () => {
  assert.equal(buildBookDetailHref(BOOK_ID, "/books"), `/book/${BOOK_ID}`)
  assert.equal(buildBookDetailHref(BOOK_ID, "https://example.com"), `/book/${BOOK_ID}`)
  assert.equal(buildBookDetailHref(BOOK_ID, "//example.com"), `/book/${BOOK_ID}`)
  assert.equal(buildBookDetailHref("a/b?c", "/books/search"), "/book/a%2Fb%3Fc?from=%2Fbooks%2Fsearch")
})

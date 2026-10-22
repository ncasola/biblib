import assert from "node:assert/strict"
import { test } from "node:test"
import {
  defaultBookSearchFilters,
  normalizeBookSearchQuery,
  parseBookSearchFilters,
  serializeBookSearchFilters,
} from "../lib/book-search"

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

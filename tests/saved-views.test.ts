import assert from "node:assert/strict"
import { test } from "node:test"
import { defaultBookSearchFilters, parseBookSearchFilters, serializeBookSearchFilters } from "../lib/book-search"
import { applySavedView, currentViewFilters, parseSavedViewFilters, savedViewNameSchema } from "../lib/saved-views"

const shelf = "55555555-5555-4555-8555-555555555555"

test("vista reproducible: serialización URL, tamaño 48 y aplicación desde página 1", () => {
  const original = { ...defaultBookSearchFilters(), q: "Cien años & más", shelf, sort: "-author" as const, status: "read" as const, view: "grid" as const, page: 7, pageSize: 48 }
  const saved = currentViewFilters(original)
  assert.equal("page" in saved, false)
  assert.equal("selectedIds" in saved, false)
  const applied = applySavedView(saved, [shelf])
  assert.deepEqual(applied, { ...original, page: 1 })
  const query = serializeBookSearchFilters(applied, new URLSearchParams("page=99&pageSize=12"))
  assert.deepEqual(parseBookSearchFilters(new URLSearchParams(query)), applied)
})

test("estantería eliminada se omite al aplicar sin modificar la vista persistida", () => {
  const saved = currentViewFilters({ ...defaultBookSearchFilters(), shelf, page: 3 })
  const applied = applySavedView(saved, [])
  assert.equal(applied.shelf, "all")
  assert.equal(applied.page, 1)
  assert.equal(saved.shelf, shelf)
})

test("solo se admiten criterios conocidos, nunca SQL, página ni selección", () => {
  const safe = currentViewFilters(defaultBookSearchFilters())
  for (const field of ["sql", "query", "page", "selectedIds", "books", "userId"]) {
    assert.throws(() => parseSavedViewFilters({ ...safe, [field]: "arbitrario" }), { code: "INVALID_INPUT" })
  }
  for (const invalid of [null, [], {}, { ...safe, shelf: "ajena" }, { ...safe, q: "x".repeat(501) }, { ...safe, q: null }, { ...safe, pageSize: 9 }, { ...safe, pageSize: 101 }, { ...safe, pageSize: 10.5 }, { ...safe, status: "finished" }, { ...safe, sort: "random()" }, { ...safe, view: "sql" }]) {
    assert.throws(() => parseSavedViewFilters(invalid), { code: "INVALID_INPUT" })
  }
  assert.deepEqual(parseSavedViewFilters({ status: "all", shelf: "all", sort: "title", view: "table", pageSize: 10 }), { status: "all", shelf: "all", sort: "title", view: "table", pageSize: 10 })
})

test("URL malformada cae a filtros seguros y se canoniza", () => {
  for (const page of ["1x", "1.5", "Infinity", "100001", "-1", "0"]) {
    const parsed = parseBookSearchFilters(new URLSearchParams(`page=${page}&status=roto&shelf=sql&sort=sql&view=sql&pageSize=48x`))
    assert.deepEqual(parsed, defaultBookSearchFilters())
    assert.equal(serializeBookSearchFilters(parsed, new URLSearchParams()), "")
  }
  assert.equal(parseBookSearchFilters(new URLSearchParams(`q=${"x".repeat(501)}`)).q.length, 500)
  for (const size of ["9", "101", "10.5", "Infinity", ""]) assert.equal(parseBookSearchFilters(new URLSearchParams(`pageSize=${size}`)).pageSize, undefined)
})

test("los nombres se recortan y están limitados a 80 caracteres", () => {
  assert.equal(savedViewNameSchema.parse("  Para el otoño  "), "Para el otoño")
  assert.equal(savedViewNameSchema.safeParse(" ").success, false)
  assert.equal(savedViewNameSchema.safeParse("x".repeat(81)).success, false)
  assert.equal(savedViewNameSchema.safeParse("x".repeat(80)).success, true)
})

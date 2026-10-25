import assert from "node:assert/strict"
import { test } from "node:test"
import { parsePersonalInput } from "../lib/personal-validation"
import { normalizeTagName } from "../lib/product/contracts"
import { parseBookSearchFilters, serializeBookSearchFilters } from "../lib/book-search"
import { currentViewFilters } from "../lib/saved-views"

test("personal: campos omitidos y null no bloquean altas anteriores", () => {
  assert.deepEqual(parsePersonalInput({}), {})
  assert.deepEqual(parsePersonalInput({ notes: null, rating: null, tagIds: [] }), { notes: null, rating: null, tagIds: [] })
})
test("personal: notas por puntos de código, sin recorte, y rating entero 1–5", () => {
  assert.equal(parsePersonalInput({ notes: "📚".repeat(4000) }).notes?.length, 8000)
  assert.throws(() => parsePersonalInput({ notes: "📚".repeat(4001) }))
  assert.throws(() => parsePersonalInput({ notes: "nota\0" }))
  for (const rating of [0, 6, 1.5, "5", false]) assert.throws(() => parsePersonalInput({ rating }))
  for (const rating of [1, 2, 3, 4, 5]) assert.equal(parsePersonalInput({ rating }).rating, rating)
})
test("personal: etiquetas NFC, hasta 40 caracteres y 20 vínculos", () => {
  assert.deepEqual(parsePersonalInput({ tagNames: ["  Ficcio\u0301n  "] }).tagNames, ["Ficción"])
  assert.ok(parsePersonalInput({ tagNames: ["📚".repeat(40)] }))
  for (const name of ["", " ", "a".repeat(41), "a\nb", "a\tb", "a\u007fb"]) assert.throws(() => parsePersonalInput({ tagNames: [name] }))
  assert.ok(parsePersonalInput({ tagNames: Array.from({ length: 20 }, (_, n) => `Tema ${n}`) }))
  assert.throws(() => parsePersonalInput({ tagNames: Array.from({ length: 21 }, (_, n) => `Tema ${n}`) }))
  assert.throws(() => parsePersonalInput({ tagIds: ["no-es-un-id"] }))
})
test("personal: normalización Unicode coincide en acentos y conserva ñ", () => {
  for (const name of ["Novela", "NÓVELA", "No\u0301vela", "  Nóvela  "]) assert.equal(normalizeTagName(name), "novela")
  assert.equal(normalizeTagName(" CIENCIA   FICCIÓN "), "ciencia ficcion")
  assert.equal(normalizeTagName("AÑO"), "año")
  assert.equal(normalizeTagName("AN\u0303O"), "año")
  assert.notEqual(normalizeTagName("año"), normalizeTagName("ano"))
  assert.equal(normalizeTagName("漢字 📚"), "漢字 📚")
})
test("personal: filtros repetidos OR por defecto, AND explícito y URL reproducible", () => {
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]
  const query = new URLSearchParams(`tag=${ids[0]}&tag=${ids[1]}&tag=${ids[0]}&tag=incorrecto`)
  const filters = parseBookSearchFilters(query)
  assert.deepEqual(filters.tagIds, ids)
  assert.equal(filters.tagMode ?? "or", "or")
  const serialized = serializeBookSearchFilters({ ...filters, tagMode: "and" }, query)
  assert.equal(parseBookSearchFilters(new URLSearchParams(serialized)).tagMode, "and")
  assert.deepEqual(new URLSearchParams(serialized).getAll("tag"), ids)
  assert.equal(serializeBookSearchFilters({ ...filters, tagIds: [] }, query), "")
})

test("personal: una vista guardada no omite silenciosamente los filtros de etiquetas", () => {
  const filters = parseBookSearchFilters(new URLSearchParams("tag=00000000-0000-4000-8000-000000000001"))
  assert.throws(() => currentViewFilters(filters), /todavía no admiten etiquetas/)
  assert.doesNotThrow(() => currentViewFilters({ ...filters, tagIds: [] }))
})

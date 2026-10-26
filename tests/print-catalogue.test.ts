import assert from "node:assert/strict"
import { test } from "node:test"
import { defaultBookSearchFilters } from "../lib/book-search"
import { collectPrintPages, DEFAULT_PRINT_FIELDS, PRINT_LIMIT, PRINT_PAGE_SIZE, printHref, printQuery, selectPrintFields, type PrintBook } from "../lib/print-catalogue"

const shelf = "55555555-5555-4555-8555-555555555551"
const series = "55555555-5555-4555-8555-555555555552"
const tag = "55555555-5555-4555-8555-555555555553"
const book = (id: string): PrintBook => ({ id, title: id, authors: [], isbn: null, status: "unread", cover: { small: "", medium: "", large: "" } })

test("impresión: consulta compartida conserva texto, estado, estantería, serie, etiquetas y orden", () => {
  const query = printQuery(new URLSearchParams(`q=ÁRBOL&status=reading&shelf=${shelf}&series=${series}&tag=${tag}&tag=${tag}&tagMode=and&sort=-author&page=8&pageSize=10&view=grid`), 2)
  assert.deepEqual(query, { q: "arbol", status: "reading", shelf, series, tagIds: [tag], tagMode: "and", sort: "-author", page: 2, pageSize: 100 })
  assert.equal(printQuery(new URLSearchParams("status=invalid&shelf=bad&page=-1")).status, "all")
})

test("impresión: enlace conserva el contexto de retorno y selección de campos sin portada por defecto", () => {
  const href = printHref({ ...defaultBookSearchFilters(), q: "Canción & árbol", shelf, page: 3, view: "grid", tagIds: [tag] })
  const params = new URL(href, "https://biblib.invalid").searchParams
  assert.equal(params.get("q"), "Canción & árbol")
  assert.equal(params.get("page"), "3")
  assert.equal(params.get("view"), "grid")
  assert.deepEqual(params.getAll("tag"), [tag])
  assert.ok(!DEFAULT_PRINT_FIELDS.includes("cover"))
  assert.deepEqual(selectPrintFields(["notes", "title", "notes", "injected"]), ["title", "notes"])
  assert.deepEqual(selectPrintFields([]), [])
})

test("impresión: carga páginas acotadas, conserva orden e incluye el último resultado", async () => {
  const calls: number[] = []
  const books = Array.from({ length: 205 }, (_, i) => book(String(i)))
  const result = await collectPrintPages(async (page) => {
    calls.push(page)
    return { books: books.slice((page - 1) * PRINT_PAGE_SIZE, page * PRINT_PAGE_SIZE), total: books.length, page }
  })
  assert.deepEqual(calls, [1, 2, 3])
  assert.deepEqual(result, { kind: "ready", books, total: 205 })
})

test("impresión: vacío y límite excedido no consultan páginas adicionales ni imprimen un subconjunto", async () => {
  assert.deepEqual(await collectPrintPages(async () => ({ books: [], total: 0, page: 1 })), { kind: "ready", books: [], total: 0 })
  let calls = 0
  assert.deepEqual(await collectPrintPages(async () => { calls++; return { books: [book("1")], total: PRINT_LIMIT + 1, page: 1 } }), { kind: "too-large", total: PRINT_LIMIT + 1 })
  assert.equal(calls, 1)
})

test("impresión: admite exactamente 2000 y rechaza cambios de recuento, duplicados o páginas incompletas", async () => {
  const exact = await collectPrintPages(async (page) => ({ books: Array.from({ length: 100 }, (_, i) => book(String((page - 1) * 100 + i))), total: PRINT_LIMIT, page }))
  assert.equal(exact.kind, "ready")
  await assert.rejects(() => collectPrintPages(async (page) => ({ books: [book("same")], total: 101, page })), /colección ha cambiado/)
  await assert.rejects(() => collectPrintPages(async (page) => ({ books: [], total: page === 1 ? 101 : 100, page })), /colección ha cambiado/)
  await assert.rejects(() => collectPrintPages(async () => ({ books: [], total: 1, page: 1 })), /colección ha cambiado/)
})

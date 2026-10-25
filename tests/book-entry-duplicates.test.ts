import assert from "node:assert/strict"
import { register } from "node:module"
import path from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"
import { createElement, type FunctionComponent } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { Book, Shelf } from "../lib/types"

let Result: FunctionComponent<{ book: Book; shelves: Shelf[]; existing: boolean }>
before(async () => {
  register(pathToFileURL(path.resolve("tests/support/tsx-loader.mjs")).href)
  const source = `const prefix="biblib-entry-action:";
export async function resolve(specifier,context,next){if(specifier.startsWith("@/app/actions/"))return{url:prefix+specifier,shortCircuit:true};return next(specifier,context)}
export async function load(url,context,next){if(url.startsWith(prefix))return{format:"module",shortCircuit:true,source:'const fail=async()=>{throw new Error("No se permite escribir al renderizar un duplicado")};export const addBookAction=fail,getBookByIsbnAction=fail,createCopyAction=fail,getEditionConflictAction=fail,getEditionCopiesAction=fail,mergeEditionsAction=fail;'};return next(url,context)}`
  register(`data:text/javascript,${encodeURIComponent(source)}`)
  Result = (await import(pathToFileURL(path.resolve("components/book-search-result.tsx")).href)).BookSearchResult
})

test("duplicado: enlaza el ejemplar existente y solo ofrece crear otra copia mediante botón explícito", () => {
  const book: Book = { id: "existente", isbn: "9780747532699", title: "Libro existente", authors: [], number_of_pages: 0, publish_date: "", cover: { small: "", medium: "", large: "" }, status: "read", shelf_id: "s1", shelf_name: "Lecturas", edition: { id: "edition", workId: "work", version: "version", copies: 1 } }
  const html = renderToStaticMarkup(createElement(Result, { book, existing: true, shelves: [{ id: "s1", title: "Lecturas", book_count: 1 }] }))
  assert.match(html, /Esta edición ya está en tu biblioteca/)
  assert.match(html, /href="\/book\/existente"[^>]*>Abrir el ejemplar guardado/)
  assert.match(html, /<button[^>]*type="button"[^>]*>.*Añadir otro ejemplar<\/button>/)
  assert.doesNotMatch(html, /Libro agregado a la biblioteca/)
})

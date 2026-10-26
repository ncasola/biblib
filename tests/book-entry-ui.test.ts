import assert from "node:assert/strict"
import { register } from "node:module"
import path from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"
import { createElement, type FunctionComponent } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { BookInput } from "../lib/book-validation"
import type { BookEntryDefaults } from "../lib/book-entry"
import type { Shelf } from "../lib/types"

let Search: FunctionComponent<{ cameraEnabled?: boolean; onSearch: () => Promise<void> }>
let Form: FunctionComponent<{ shelves: Shelf[]; onSubmit: (input: BookInput) => Promise<void>; onSaveAndAddAnother?: (input: BookInput) => Promise<void>; entryDefaults?: BookEntryDefaults }>
before(async () => {
  register(pathToFileURL(path.resolve("tests/support/tsx-loader.mjs")).href)
  Search = (await import(pathToFileURL(path.resolve("components/search-book-form.tsx")).href)).SearchBookForm
  Form = (await import(pathToFileURL(path.resolve("components/book-form.tsx")).href)).BookForm
})

test("bandera apagada conserva ISBN completo; encendida muestra cámara opcional sin pedir permiso al render", () => {
  const off = renderToStaticMarkup(createElement(Search, { onSearch: async () => {} }))
  assert.match(off, /Número ISBN/)
  assert.match(off, /Buscar libro/)
  assert.doesNotMatch(off, /<video|Escanear ISBN/)
  const on = renderToStaticMarkup(createElement(Search, { cameraEnabled: true, onSearch: async () => {} }))
  assert.match(on, /Número ISBN/)
  assert.match(on, /Escanear ISBN con cámara/)
  assert.match(on, /<video[^>]*hidden=""/)
  assert.doesNotMatch(on, /Usar este ISBN/)
  assert.match(on, /no se guardan ni se envían/)
})

test("formulario nuevo vacío con estado y estantería de sesión y acción consecutiva explícita", () => {
  const html = renderToStaticMarkup(createElement(Form, {
    shelves: [{ id: "default", title: "Predeterminada", isDefault: true, book_count: 0 }, { id: "novela", title: "Novela", book_count: 0 }],
    entryDefaults: { status: "reading", shelf_id: "novela" }, onSubmit: async () => {}, onSaveAndAddAnother: async () => {},
  }))
  assert.match(html, /value="reading" selected=""/)
  assert.match(html, /value="novela" selected=""/)
  assert.match(html, /<button(?=[^>]*type="submit")(?=[^>]*name="intent")(?=[^>]*value="another")[^>]*>Guardar y añadir otro/)
  assert.doesNotMatch(html, /<input(?=[^>]*type="checkbox")[^>]*checked=""/)
  assert.match(html, /<input(?=[^>]*type="radio")(?=[^>]*value="0")[^>]*checked=""/)
  assert.match(html, /Notas privadas/)
  assert.match(html, /5 de 5 estrellas/)
  assert.match(html, /name="intent"/)
  assert.match(html, /Déjalo vacío si el ejemplar no tiene ISBN/)
})

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import { test } from "node:test"
import { createElement, type ComponentType } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { transpileModule, ModuleKind, JsxEmit, ScriptTarget } from "typescript"
import { readCatalogConfig } from "../lib/bibliographic-catalog/config"

type NoticeProps = { enabled: boolean; onDisable: () => void }
function loadNotice(): ComponentType<NoticeProps> {
  const file = path.resolve("components/google-books-notice.tsx")
  const code = transpileModule(readFileSync(file, "utf8"), { compilerOptions: {
    module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, target: ScriptTarget.ES2022,
  } }).outputText
  const exports: { GoogleBooksNotice?: ComponentType<NoticeProps> } = {}
  runInNewContext(code, { exports, require: createRequire(file) })
  assert.ok(exports.GoogleBooksNotice)
  return exports.GoogleBooksNotice
}

test("Google: aviso apagado ausente y habilitado con región etiquetada, privacidad y desactivación accesible", () => {
  const Notice = loadNotice()
  assert.equal(renderToStaticMarkup(createElement(Notice, { enabled: false, onDisable() {} })), "")
  const html = renderToStaticMarkup(createElement(Notice, { enabled: true, onDisable() {} }))
  const labelId = html.match(/aria-labelledby="([^"]+)"/)?.[1]
  assert.ok(labelId)
  assert.ok(html.includes(`<h2 id="${labelId}"`))
  for (const text of ["ISBN", "título y autor", "podría hacerse público", "Open Library, BNE", "manualmente", "Desactivar Google Books"]) assert.ok(html.includes(text))
  for (const link of ["https://developers.google.com/books/terms", "https://books.google.com/googlebooks/privacy.html", "https://policies.google.com/privacy"]) assert.ok(html.includes(`href="${link}"`))
  assert.match(html, /<button type="button"/)
  assert.ok(html.includes("focus-visible:outline"))
  assert.ok(!html.includes("API_KEY"))
})

test("Google: configuración predeterminada y desactivación retiran el aviso", () => {
  const Notice = loadNotice()
  const enabled = readCatalogConfig({ BIBLIB_TARGET: "test" }).enabled["google-books"]
  assert.equal(renderToStaticMarkup(createElement(Notice, { enabled, onDisable() {} })), "")
  assert.ok(renderToStaticMarkup(createElement(Notice, { enabled: true, onDisable() {} })).includes("Desactivar Google Books"))
  assert.equal(renderToStaticMarkup(createElement(Notice, { enabled: false, onDisable() {} })), "")
})

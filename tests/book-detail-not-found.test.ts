import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { test } from "node:test"
import { runInNewContext } from "node:vm"
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript"
import type { Metadata } from "next"
import { createElement, type ComponentType } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { Book } from "../lib/types"

function loadSource<T>(file: string, dependencies: Record<string, unknown>): T {
  const compiledRequire = createRequire(path.resolve(".next/tests", file.replace(/\.tsx?$/, ".js")))
  const code = transpileModule(readFileSync(file, "utf8"), { compilerOptions: {
    module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, target: ScriptTarget.ES2022,
  } }).outputText
  const exports = {}
  runInNewContext(code, { exports, require: (id: string) => id in dependencies ? dependencies[id]
    : compiledRequire(id.startsWith("@/") ? path.resolve(".next/tests", id.slice(2)) : id) })
  return exports as T
}

test("ficha: ID inválido e inexistente activan 404 y título español; un fallo real conserva su clasificación", async () => {
  let reads = 0
  let book: Pick<Book, "title"> | null = null
  let unavailable = false
  const notFound = new Error("NEXT_HTTP_ERROR_FALLBACK;404")
  type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }
  const page = loadSource<{ default: (props: Props) => Promise<unknown>; generateMetadata: (props: Props) => Promise<Metadata> }>("app/book/[id]/page.tsx", {
    react: { cache: (reader: unknown) => reader },
    "next/navigation": { notFound: () => { throw notFound } },
    "@/app/actions/books": { getBookDetailAction: async () => { reads++; if (unavailable) throw new Error("Conexión fallida"); return book } },
    "@/components/book-details-screen": { BookDetailsScreen: () => null },
  })
  const props = (id: string): Props => ({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })
  const invalid = props("no-es-un-uuid")
  assert.deepEqual((await page.generateMetadata(invalid)).title, { absolute: "Libro no encontrado · BibLib" })
  await assert.rejects(page.default(invalid), (error) => error === notFound)
  assert.equal(reads, 0, "El ID se valida antes de llamar al lector")
  const missing = props("11111111-1111-4111-8111-111111111111")
  assert.deepEqual((await page.generateMetadata(missing)).title, { absolute: "Libro no encontrado · BibLib" })
  await assert.rejects(page.default(missing), (error) => error === notFound)
  assert.equal(reads, 2)
  book = { title: "Libro de prueba" }
  assert.deepEqual((await page.generateMetadata(missing)).title, { absolute: "Libro de prueba · BibLib" })
  assert.ok(await page.default(missing))
  unavailable = true
  assert.deepEqual((await page.generateMetadata(missing)).title, { absolute: "Ficha del libro · BibLib" })
  assert.ok(await page.default(missing), "Una caída real no se convierte en ausencia de libro")
})

test("lector de ficha: un ID inválido devuelve ausencia antes de Auth o de la base", async () => {
  const actions = loadSource<{ getBookDetailAction: (id: string) => Promise<Book | null> }>("app/actions/books.ts", {
    "@/lib/db/client": { withRlsContext: () => assert.fail("No debe consultar la base") },
    "@/lib/db/library": {},
    "@/lib/db/schema": {},
    "@/lib/server-user": { getRequiredUserId: () => assert.fail("No debe consultar Auth") },
    "@/lib/server-action": {},
    "@/lib/observability/server": {},
  })
  assert.equal(await actions.getBookDetailAction("no-es-un-uuid"), null)
})

test("el límite 404 muestra contenido español, retorno a la colección y metadata privada", () => {
  const boundary = loadSource<{ default: ComponentType; metadata: Metadata }>("app/book/[id]/not-found.tsx", {})
  const html = renderToStaticMarkup(createElement(boundary.default))
  assert.match(html, /Libro no encontrado/)
  assert.match(html, /Volver a la colección/)
  assert.match(html, /href="\/books"/)
  assert.deepEqual(boundary.metadata, {
    title: { absolute: "Libro no encontrado · BibLib" }, robots: { index: false, follow: false },
  })
})

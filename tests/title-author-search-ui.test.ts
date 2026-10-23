import assert from "node:assert/strict"
import { register } from "node:module"
import path from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"
import { createElement, type FunctionComponent } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { CandidatePage, SearchCandidate } from "../lib/title-author-search"

let Search: FunctionComponent
let Results: FunctionComponent<{ data: CandidatePage; busy: boolean; onPage: () => void; onChoose: () => void; onWork: () => void }>
before(async () => {
  register(pathToFileURL(path.resolve("tests/support/tsx-loader.mjs")).href)
  // Las acciones no se ejecutan en SSR: el stub falla si una búsqueda se lanza al renderizar.
  const source = `const prefix="biblib-search-action:";
export async function resolve(specifier,context,next){if(specifier.startsWith("@/app/actions/"))return{url:prefix+specifier,shortCircuit:true};return next(specifier,context)}
export async function load(url,context,next){if(url.startsWith(prefix))return{format:"module",shortCircuit:true,source:'const fail=async()=>{throw new Error("No debe consultarse al renderizar")};export const searchBibliographyAction=fail,loadEditionCandidatesAction=fail,prepareCandidateLinkAction=fail,addBookAction=fail,getShelvesAction=fail;'};return next(url,context)}`
  register(`data:text/javascript,${encodeURIComponent(source)}`)
  Search = (await import(pathToFileURL(path.resolve("components/title-author-search.tsx")).href)).TitleAuthorSearch
  Results = (await import(pathToFileURL(path.resolve("components/edition-candidates.tsx")).href)).EditionCandidates
})

test("formulario accesible en español por envío explícito, sin consultas durante el render", () => {
  const html = renderToStaticMarkup(createElement(Search))
  assert.match(html, /Buscar por título y autor/)
  assert.match(html, /Solo se consulta al pulsar Buscar/)
  assert.match(html, /<button[^>]*type="submit"[^>]*>Buscar<\/button>/)
  assert.match(html, /Completar manualmente con este texto/)
  for (const control of html.matchAll(/<(input|select)\b([^>]*)>/g)) {
    const id = control[2].match(/\bid="([^"]+)"/)?.[1]
    assert.ok(id && html.includes(`for="${id}"`), `control sin etiqueta: ${control[0]}`)
  }
})

test("obra, edición y estados de proveedores tienen controles separados sin selección automática", () => {
  const entry: SearchCandidate = { candidateKey: "work-key", provider: "open-library", level: "work", title: "Árbol", recordId: "OL100W", isbns: [], authors: [], publishers: [], evidence: { isbnExact: false }, retrievedAt: "2026-10-23T00:00:00.000Z" }
  const data: CandidatePage = { queryToken: "query", page: 1, nextPage: 2, status: "found", results: [entry, { ...entry, candidateKey: "edition-key", level: "edition" }], providers: [{ provider: "bne", status: "misconfigured", requestId: "r1" }, { provider: "open-library", status: "rateLimited", retryAfterSeconds: 12, requestId: "r2" }] }
  const html = renderToStaticMarkup(createElement(Results, { data, busy: false, onPage: () => {}, onChoose: () => {}, onWork: () => {} }))
  for (const text of ["Consultar ediciones", "No sé la edición", "Revisar esta edición", "Fuente sin configurar", "Límite de consultas alcanzado", "Idioma no indicado", "Fecha no indicada", "no confirma tu edición física"]) assert.ok(html.includes(text), text)
  assert.match(html, /aria-label="Páginas de resultados"/)
  assert.match(html, /role="status" aria-live="polite"/)
  assert.ok(!html.includes("checked"))
  assert.match(html, /<button[^>]*disabled=""[^>]*>Anterior/)
})

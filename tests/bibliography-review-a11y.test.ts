import assert from "node:assert/strict"
import { register } from "node:module"
import path from "node:path"
import { before, test } from "node:test"
import { pathToFileURL } from "node:url"
import { createElement, type FunctionComponent } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { BibliographicCandidate, CatalogLookupResult, CoverCandidate } from "../lib/bibliographic-catalog/types"
import type { Book, Shelf } from "../lib/types"

// Prueba de componente sin DOM: renderiza el HTML inicial y comprueba roles, nombres y etiquetas.
// Las interacciones (combinar, elegir, escribir) se prueban en bibliography-review.test.ts.

interface ReviewProps {
  isbn: string
  result: CatalogLookupResult<BibliographicCandidate> | null
  covers: CoverCandidate[]
  failure?: string
  shelves: Shelf[]
  onSave: () => Promise<Book>
  onRetry?: () => void
}
let Review: FunctionComponent<ReviewProps>
let Details: FunctionComponent<{ book: Pick<Book, "isbn" | "catalogue"> }>

before(async () => {
  register(pathToFileURL(path.resolve("tests/support/tsx-loader.mjs")).href)
  const load = (file: string) => import(pathToFileURL(path.resolve(file)).href)
  Review = (await load("components/bibliography-review.tsx")).BibliographyReview
  Details = (await load("components/catalogue-provenance-details.tsx")).CatalogueProvenanceDetails
})

const ISBN = "9788401337208"
const shelves: Shelf[] = [{ id: "s1", title: "Predeterminada", book_count: 0, isDefault: true }, { id: "s2", title: "Novela", book_count: 0 }]
const candidate = (overrides: Partial<BibliographicCandidate> = {}): BibliographicCandidate => ({
  provider: "open-library", level: "edition", recordId: "OL1M", sourceUrl: "https://openlibrary.org/books/OL1M", isbns: [ISBN],
  title: "El nombre del viento", authors: [{ name: "Patrick Rothfuss" }], publishers: [{ name: "Plaza & Janés" }],
  language: "spa", format: "Tapa blanda", publishDate: "2009", numberOfPages: 872, evidence: { isbnExact: true }, retrievedAt: "2026-10-23T09:00:00.000Z",
  ...overrides,
})
const result = (candidates: BibliographicCandidate[], status: CatalogLookupResult<BibliographicCandidate>["status"] = "found"): CatalogLookupResult<BibliographicCandidate> => ({
  status, candidates, complete: true, deadlineExceeded: false,
  providers: [{ provider: "open-library", status: candidates.length ? "found" : "notFound", requestId: "r1" }, { provider: "bne", status: "unavailable", requestId: "r2" }],
})
const covers: CoverCandidate[] = [
  { provider: "open-library", coverKey: "ol", imageUrl: "https://covers.openlibrary.org/b/id/1-L.jpg", rightsPolicyVersion: "2026-10-23.1", attribution: "Open Library" },
  { provider: "google-books", coverKey: "gb", imageUrl: "https://books.google.test/p.jpg", rightsPolicyVersion: "2026-10-23.1" },
]
const render = (props: Partial<ReviewProps> = {}) => renderToStaticMarkup(createElement(Review, {
  isbn: ISBN, result: result([candidate(), candidate({ provider: "bne", recordId: "991", sourceUrl: "https://catalogo.bne.es/permalink/991", publishDate: "2011" })]),
  covers, shelves, onSave: async () => { throw new Error("no se llama al renderizar") }, ...props,
}))

const ids = (html: string, pattern: RegExp) => [...html.matchAll(pattern)].map((match) => match[1])

function assertLabelled(html: string) {
  for (const control of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const id = control[2].match(/\bid="([^"]+)"/)?.[1]
    assert.ok(id, `control sin id: ${control[0]}`)
    assert.ok(html.includes(`for="${id}"`), `control sin etiqueta asociada: ${control[0]}`)
  }
}

test("tarjetas, evidencia, combinación y resumen con roles y etiquetas accesibles", () => {
  const html = render()
  const heading = html.match(/<section aria-labelledby="([^"]+)"/)?.[1]
  assert.ok(heading && html.includes(`id="${heading}"`) && html.includes("Revisar fuentes bibliográficas"))
  assert.match(html, /<ul aria-label="Estado de las fuentes consultadas"/)
  assert.match(html, /BNE:<\/span> no disponible ahora; puedes reintentar/)
  const cards = ids(html, /<article aria-labelledby="([^"]+)"/g)
  assert.equal(cards.length, 2)
  for (const card of cards) assert.match(html, new RegExp(`<h4 id="${card}"`))
  assert.match(html, /<ul aria-label="Evidencia de la ficha 2"/)
  for (const evidence of ["ISBN coincide", "año distinto"]) assert.ok(html.includes(evidence), evidence)
  assert.ok(!/\d+ ?%/.test(html.replace(/(width|height):\s*\d+%/g, "")), "sin porcentajes de confianza")
  assert.match(html, /<button[^>]*>Combinar campos compatibles<\/button>/)
  assert.match(html, /Diferencias que decidirás tú: fecha editorial/)
  assert.match(html, /<legend[^>]*>Fecha editorial \(según la fuente\)<\/legend>/)
  assert.match(html, /role="status" aria-live="polite"/)
  assert.match(html, /<form[^>]*aria-labelledby="[^"]+"/)
  assert.match(html, /<button[^>]*>Completar manualmente<\/button>/)
  assert.match(html, /<button[^>]*type="submit"[^>]*>Guardar en la biblioteca<\/button>/)
  assert.match(html, /<a[^>]*target="_blank"[^>]*>Ver registro OL1M en la fuente.*?se abre en otra pestaña/)
  assertLabelled(html)
})

test("portada en control aparte con fallback; Google solo como vista previa no seleccionable", () => {
  const html = render()
  assert.match(html, /<legend[^>]*>Portada<\/legend>/)
  assert.match(html, /Portada predeterminada/)
  assert.ok(html.includes("/default-book-cover.webp"))
  assert.equal(ids(html, /<input type="radio" id="[^"]*cover-([^"]+)"/g).sort().join(","), "default,ol")
  // U-BIB-03 concede a Google solo previewCover: puede verse como vista previa, pero nunca como opción guardable.
  assert.ok(!/<input[^>]*type="radio"[^>]*google/i.test(html), "Google no es una opción de portada seleccionable")
  if (html.includes("books.google.test")) assert.match(html, /vista previa/i)
})

test("sin compatibilidad no se ofrece combinar y se explica por qué", () => {
  const html = render({ result: result([candidate(), candidate({ provider: "bne", recordId: "991", language: "eng" })]) })
  assert.ok(!html.includes(">Combinar campos compatibles<"))
  assert.match(html, /Las fuentes indican idiomas distintos\./)
  assert.match(html, /idioma distinto/)
})

test("sin candidatos el resumen manual conserva el ISBN y ofrece reintentar", () => {
  const notFound = render({ result: result([], "notFound"), covers: [] })
  assert.match(notFound, /role="status"[^>]*>Ninguna fuente tiene una ficha/)
  assert.ok(!notFound.includes("<article"))
  assert.match(notFound, new RegExp(`value="${ISBN}"`))
  const failed = render({ result: result([], "incomplete"), covers: [], failure: "No se pudo completar la consulta.", onRetry: () => undefined })
  assert.match(failed, /role="alert"[^>]*>No se pudo completar la consulta\./)
  assert.match(failed, />Reintentar consulta<\/button>/)
  assertLabelled(failed)
})

test("el detalle expone la procedencia por campo como lista de definiciones etiquetada", () => {
  const html = renderToStaticMarkup(createElement(Details, { book: { isbn: ISBN, catalogue: {
    schemaVersion: 2, source: "bne", isbnVerified: false,
    fields: { title: { provider: "bne", recordId: "991", sourceUrl: "https://catalogo.bne.es/permalink/991", selection: "user-selected" }, cover: { provider: "open-library", selection: "user-selected" } },
  } } }))
  assert.match(html, /Fuente principal: Biblioteca Nacional de España \(BNE\)/)
  assert.match(html, /<dl aria-label="Procedencia por campo"/)
  assert.match(html, /<dt[^>]*>Título<\/dt><dd[^>]*><a[^>]*>Biblioteca Nacional de España \(BNE\) · registro 991 · elegido por ti/)
  assert.match(html, /<dt[^>]*>Portada<\/dt><dd[^>]*>Open Library · elegido por ti/)
  assert.match(html, /dígito de control válido, pero eso no confirma tu ejemplar/)
  const google = renderToStaticMarkup(createElement(Details, { book: { isbn: ISBN, catalogue: { source: "google-books" as "manual", isbnVerified: true } } }))
  assert.match(google, /Fuente no reconocida \(«google-books»\)/)
  assert.ok(!google.includes("Entrada manual"))
})

import assert from "node:assert/strict"
import { test } from "node:test"
import { candidateProvenance, coverProvenance } from "../lib/bibliographic-catalog/normalize"
import type { BibliographicCandidate, CoverCandidate } from "../lib/bibliographic-catalog/types"
import {
  buildReviewedCatalogue, candidateEvidence, combinability, combineCompatibleFields, fieldOptions, isSelectableCandidate, missingCandidateFields,
  type ReviewField,
} from "../lib/bibliography-review"
import { parseBookInput } from "../lib/book-validation"

const ISBN = "978-84-01-33720-8"

function candidate(overrides: Partial<BibliographicCandidate> = {}): BibliographicCandidate {
  return {
    provider: "open-library", level: "edition", recordId: "OL1M", sourceUrl: "https://openlibrary.org/books/OL1M",
    isbns: ["9788401337208"], title: "El nombre del viento", authors: [{ name: "Patrick Rothfuss" }],
    publishers: [{ name: "Plaza & Janés" }], language: "spa", format: "Tapa blanda", publishDate: "2009",
    numberOfPages: 872, evidence: { isbnExact: true }, retrievedAt: "2026-10-23T09:00:00.000Z",
    ...overrides,
  }
}

const bne = (overrides: Partial<BibliographicCandidate> = {}) => candidate({
  provider: "bne", recordId: "991", sourceUrl: "https://catalogo.bne.es/permalink/34BNE_INST/991", ...overrides,
})

test("conflictos por título, autoría, fecha, idioma, formato e ISBN se describen con evidencia literal", () => {
  const ol = candidate()
  const other = bne({ title: "Nombre del viento", authors: [{ name: "Rothfuss, Patrick" }], publishDate: "2011", language: "eng", format: "Tapa dura", isbns: ["9780756404741"] })
  const evidence = candidateEvidence(other, ISBN, [ol, other])
  for (const expected of ["ISBN distinto del buscado", "idioma distinto", "formato no compatible", "año distinto", "título distinto", "autoría distinta"]) {
    assert.ok(evidence.includes(expected), expected)
  }
  assert.ok(candidateEvidence(ol, ISBN, [ol, other]).includes("ISBN coincide"))
  assert.ok(evidence.every((entry) => !/%|\d+ ?por ciento/.test(entry)), "nunca un porcentaje")
  const sparse = bne({ language: undefined, format: undefined, publishDate: undefined, isbns: [] })
  assert.deepEqual(candidateEvidence(sparse, ISBN, [sparse]), ["la fuente no incluye ISBN", "la fuente no incluye idioma", "la fuente no incluye formato", "la fuente no incluye fecha"])
  assert.deepEqual(missingCandidateFields(sparse), ["subtítulo", "fecha editorial", "idioma", "formato"])
})

test("combinar solo con ISBN exacto e idioma/formato compatibles; el año distinto queda como conflicto", () => {
  const ol = candidate()
  assert.deepEqual(combinability([ol, bne({ publishDate: "2011" })], ISBN), { canCombine: true, reasons: [] })
  assert.equal(combinability([ol, bne({ format: undefined })], ISBN).canCombine, true, "sin formato no hay incompatibilidad declarada")
  assert.deepEqual(combinability([ol, bne({ language: "eng" })], ISBN).reasons, ["Las fuentes indican idiomas distintos."])
  assert.deepEqual(combinability([ol, bne({ format: "Tapa dura" })], ISBN).reasons, ["Las fuentes indican formatos no compatibles."])
  assert.deepEqual(combinability([ol, bne({ isbns: ["9780756404741"] })], ISBN).reasons, ["Alguna ficha no incluye exactamente el ISBN buscado."])
  // Título parecido sin ISBN exacto: candidatos independientes, nunca fusionados.
  assert.equal(combinability([bne({ isbns: [] })], ISBN).canCombine, false)
})

test("la combinación toma valores coincidentes, deja conflictos y no pisa campos manuales", () => {
  const ol = candidate({ subtitle: "Crónica del asesino de reyes" })
  const other = bne({ publishDate: "2011", numberOfPages: undefined, subtitle: undefined })
  const protectedFields = new Set<ReviewField>(["title"])
  const result = combineCompatibleFields([ol, other], protectedFields)
  assert.deepEqual(result.conflicts, ["publish_date"])
  assert.deepEqual(result.protectedFields, ["title"])
  assert.equal(result.values.title, undefined, "el título escrito a mano se conserva")
  assert.deepEqual(result.values.authors, [{ name: "Patrick Rothfuss" }])
  assert.equal(result.values.number_of_pages, 872)
  assert.equal(result.provenance.number_of_pages?.provider, "open-library")
  assert.equal(result.provenance.subtitle?.provider, "open-library")
  assert.equal(result.values.publish_date, undefined)
})

test("selección por campo: cada valor conserva qué fuentes lo aportan", () => {
  const ol = candidate()
  const other = bne({ publishDate: "2011" })
  const dates = fieldOptions([ol, other], "publish_date")
  assert.deepEqual(dates.map((option) => [option.display, option.candidates]), [["2009", [0]], ["2011", [1]]])
  const titles = fieldOptions([ol, bne({ title: "  el nombre   del viento " })], "title")
  assert.equal(titles.length, 1, "diferencias de mayúsculas y espacios no son conflicto")
  assert.deepEqual(titles[0].candidates, [0, 1])
})

test("selección de portada: fuente propia, sin Google y con fallback", () => {
  const cover: CoverCandidate = { provider: "open-library", coverKey: "ol-1", imageUrl: "https://covers.openlibrary.org/b/id/1-L.jpg", sourceUrl: "https://openlibrary.org/books/OL1M", rightsPolicyVersion: "2026-10-23.1" }
  assert.deepEqual(coverProvenance(cover, "2026-10-23T09:00:00.000Z"), { provider: "open-library", sourceUrl: "https://openlibrary.org/books/OL1M", retrievedAt: "2026-10-23T09:00:00.000Z", selection: "user-selected" })
  assert.equal(coverProvenance({ ...cover, provider: "google-books" }), null)
  assert.equal(coverProvenance({ ...cover, imageUrl: "http://inseguro.test/p.jpg" }), null)
  // La portada puede proceder de un proveedor distinto del resto de campos.
  const catalogue = buildReviewedCatalogue({ title: candidateProvenance(bne())!, cover: coverProvenance(cover)! }, false)
  assert.equal(catalogue.source, "bne")
  assert.equal(catalogue.fields?.cover?.provider, "open-library")
  assert.deepEqual(parseBookInput({ title: "x", authors: [], number_of_pages: 0, publish_date: "", status: "unread", isbn: ISBN, catalogue }).catalogue, catalogue)
})

test("Google Books no es seleccionable ni clasificado por defecto; ninguna fuente marca isbnVerified", () => {
  const google = candidate({ provider: "google-books" })
  assert.equal(isSelectableCandidate(google), false)
  assert.equal(candidateProvenance(google), null)
  assert.deepEqual(combineCompatibleFields([google], new Set()).values, {})
  assert.equal(buildReviewedCatalogue({ title: candidateProvenance(candidate())! }, false).isbnVerified, false)
  assert.equal(buildReviewedCatalogue({}, false).source, "manual")
})

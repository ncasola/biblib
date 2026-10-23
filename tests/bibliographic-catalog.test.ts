import assert from "node:assert/strict"
import { test } from "node:test"
import { DomainError } from "../lib/domain-errors"
import { normalizeIsbn } from "../lib/isbn"
import { createBibliographicCatalogService, CATALOG_DEADLINE_MS, COVER_DEADLINE_MS, PROVIDER_DEADLINE_MS } from "../lib/bibliographic-catalog/orchestrator"
import { compareCandidates } from "../lib/bibliographic-catalog/normalize"
import { toBibliographyActionResult } from "../lib/bibliographic-catalog/action-result"
import { hasProviderRight, providerRightsPolicy } from "../lib/bibliographic-catalog/rights"
import { createLogger, type TelemetryRecord } from "../lib/observability/logger"
import type { BibliographicCandidate, CatalogProvider, ProviderId, ProviderRegistration, ProviderStatus } from "../lib/bibliographic-catalog/types"

const isbn = "9780804429573"
function candidate(provider: ProviderId = "open-library", extra: Partial<BibliographicCandidate> = {}): BibliographicCandidate {
  return { provider, level: "edition", isbns: ["0-8044-2957-X"], title: "Ficha de prueba", authors: [{ name: "Autor ficticio" }], publishers: [], evidence: { isbnExact: false }, retrievedAt: "2026-10-23T00:00:00.000Z", ...extra }
}
function source(id: ProviderId, status: ProviderStatus = "notFound", values = [candidate(id)]): ProviderRegistration {
  const adapter: CatalogProvider = {
    id, capabilities: { lookupISBN: true, searchTitleAuthor: false, resolveEditions: false, getCover: false },
    async lookupISBN(_isbn, context) { return status === "found" ? { provider: id, requestId: context.requestId, status, value: values } : { provider: id, requestId: context.requestId, status, ...(status === "rateLimited" ? { retryAfterSeconds: 12 } : {}) } },
  }
  return { id, enabled: true, adapter }
}

test("canonicaliza ISBN-10 con X, ISBN-13, guiones y espacios; rechaza checksum inválido sin consulta", async () => {
  assert.equal(normalizeIsbn("0-8044-2957-x"), isbn)
  assert.equal(normalizeIsbn("978-0-8044-2957-3"), isbn)
  assert.equal(normalizeIsbn(" 978 0 8044 2957 3 "), isbn)
  let calls = 0
  const registration = source("open-library")
  registration.adapter!.lookupISBN = async () => { calls++; throw new Error("No debe consultar") }
  const service = createBibliographicCatalogService({ providers: [registration] })
  for (const invalid of ["", "0804429570", "9780804429574", "ISBN:9780804429573", "9780804429573<script>"]) {
    await assert.rejects(service.lookupISBN(invalid), (error) => error instanceof DomainError && error.code === "INVALID_INPUT")
    await assert.rejects(service.getCover(invalid), (error) => error instanceof DomainError && error.code === "INVALID_INPUT")
  }
  assert.equal(calls, 0)
})

test("found conserva ISBN original y vuelve a comprobar la coincidencia canónica", async () => {
  const result = await createBibliographicCatalogService({ providers: [source("open-library", "found")] }).lookupISBN("0-8044-2957-X")
  assert.equal(result.status, "found")
  assert.equal(result.complete, true)
  assert.deepEqual(result.candidates[0].isbns, ["0-8044-2957-X"])
  assert.equal(result.candidates[0].evidence.isbnExact, true)
  const mismatch = await createBibliographicCatalogService({ providers: [source("open-library", "found", [candidate("open-library", { isbns: ["9788401337208"], evidence: { isbnExact: true } })])] }).lookupISBN(isbn)
  assert.equal(mismatch.status, "notFound")
  assert.deepEqual(mismatch.candidates, [])
})

for (const status of ["notFound", "unavailable", "rateLimited", "disabled", "misconfigured"] as const) {
  test(`estado por fuente ${status} conserva diagnóstico y solo notFound certifica ausencia`, async () => {
    const result = await createBibliographicCatalogService({ providers: [source("open-library", status)] }).lookupISBN(isbn)
    assert.equal(result.providers[0].status, status)
    assert.equal(result.status, status === "notFound" ? "notFound" : "incomplete")
    assert.equal(result.complete, status === "notFound")
    if (status === "rateLimited") assert.equal(result.providers[0].retryAfterSeconds, 12)
  })
}

test("notFound requiere todas las fuentes elegibles sanas; todo fallido siempre incomplete", async () => {
  const healthy = await createBibliographicCatalogService({ providers: [source("open-library"), source("bne")] }).lookupISBN(isbn)
  assert.equal(healthy.status, "notFound")
  assert.equal(healthy.complete, true)
  const failed = await createBibliographicCatalogService({ providers: [source("open-library", "unavailable"), source("bne", "rateLimited")] }).lookupISBN(isbn)
  assert.equal(failed.status, "incomplete")
  assert.equal(failed.complete, false)
})

test("sin fuentes habilitadas o sin capacidad devuelve incomplete con diagnóstico", async () => {
  const service = createBibliographicCatalogService({ providers: [{ id: "open-library", enabled: false }, { id: "bne", enabled: true }] })
  const result = await service.lookupISBN(isbn)
  assert.equal(result.status, "incomplete")
  assert.equal(result.complete, false)
  assert.deepEqual(result.providers.map((provider) => provider.status), ["disabled", "notAttempted", "disabled"])
  assert.equal(result.providers[1].reason, "unsupported")
  assert.equal((await service.searchTitleAuthor({ title: "Prueba" })).status, "incomplete")
})

test("OL encontrado y otra fuente timeout conserva found, complete:false y cancela el adaptador", async () => {
  const slow = source("bne")
  let aborted = false
  slow.adapter!.lookupISBN = async (_isbn, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason) }, { once: true }))
  const result = await createBibliographicCatalogService({ providers: [source("open-library", "found"), slow] }).lookupISBN(isbn, { providerTimeoutMs: 10 })
  assert.equal(result.status, "found")
  assert.equal(result.complete, false)
  assert.equal(result.providers[1].status, "unavailable")
  assert.equal(result.providers[1].reason, "deadline")
  assert.equal(aborted, true)
  assert.equal(result.candidates.length, 1)
})

test("deadline común deja la siguiente fuente notAttempted y nunca devuelve notFound", async () => {
  const slow = source("open-library")
  slow.adapter!.lookupISBN = async (_isbn, context) => new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }))
  const result = await createBibliographicCatalogService({ providers: [slow, source("bne")] }).lookupISBN(isbn, { timeoutMs: 10 })
  assert.equal(result.status, "incomplete")
  assert.equal(result.deadlineExceeded, true)
  assert.equal(result.providers[1].status, "notAttempted")
  assert.equal(result.providers[1].reason, "deadline")
})

test("cancelación entrante interrumpe la fuente activa y evita las siguientes", async () => {
  const controller = new AbortController()
  const slow = source("open-library")
  let aborted = false
  slow.adapter!.lookupISBN = async (_isbn, context) => new Promise((_resolve, reject) => {
    context.signal.addEventListener("abort", () => { aborted = true; reject(context.signal.reason) }, { once: true })
    controller.abort()
  })
  const result = await createBibliographicCatalogService({ providers: [slow, source("bne")] }).lookupISBN(isbn, { signal: controller.signal })
  assert.equal(result.status, "incomplete")
  assert.equal(result.complete, false)
  assert.equal(result.deadlineExceeded, false)
  assert.equal(aborted, true)
  assert.equal(result.providers[1].status, "notAttempted")
})

test("cancelación previa y presupuesto cero no invocan fuentes", async () => {
  let calls = 0
  const registration = source("open-library")
  registration.adapter!.lookupISBN = async () => { calls++; throw new Error("No consultar") }
  const service = createBibliographicCatalogService({ providers: [registration] })
  for (const options of [{ timeoutMs: 0 }, { signal: AbortSignal.abort() }]) {
    const result = await service.lookupISBN(isbn, options)
    assert.equal(result.status, "incomplete")
    assert.equal(result.providers[0].status, "notAttempted")
  }
  assert.equal(calls, 0)
  assert.equal(CATALOG_DEADLINE_MS, 8000)
  assert.equal(PROVIDER_DEADLINE_MS, 3500)
  assert.equal(COVER_DEADLINE_MS, 4000)
})

test("ordena secuencialmente como máximo tres fuentes y elimina duplicados", async () => {
  const calls: ProviderId[] = []
  let active = 0
  const providers = (["open-library", "bne", "google-books"] as const).map((id) => {
    const registration = source(id)
    registration.adapter!.lookupISBN = async (_isbn, context) => {
      assert.equal(active++, 0)
      await Promise.resolve()
      calls.push(id); active--
      return { provider: id, requestId: context.requestId, status: "notFound" }
    }
    return registration
  })
  await createBibliographicCatalogService({ providers, order: ["bne", "bne", "open-library", "google-books"] }).lookupISBN(isbn)
  assert.deepEqual(calls, ["bne", "open-library", "google-books"])
})

test("conflicto de fecha conserva valores y no decide la compatibilidad de edición", () => {
  const first = candidate("open-library", { publishDate: "1990", language: "spa", format: "paperback" })
  const second = candidate("bne", { isbns: [isbn], publishDate: "1991", language: "spa", format: "paperback" })
  const comparison = compareCandidates(first, second)
  assert.equal(comparison.canCombine, true)
  assert.deepEqual(comparison.conflicts.find((conflict) => conflict.field === "publishDate")?.values, ["1990", "1991"])
  assert.equal(compareCandidates(first, { ...second, language: "eng" }).canCombine, false)
  assert.equal(compareCandidates(first, { ...second, format: "ebook" }).canCombine, false)
  assert.equal(compareCandidates(first, { ...second, isbns: [] }).canCombine, false)
  assert.equal(compareCandidates(first, { ...second, language: undefined }).evidence.languageCompatible, undefined)
})

test("título/autor no inventa ISBN ni afirma coincidencia; referencias no aceptan URLs", async () => {
  const registration = source("open-library")
  registration.adapter!.capabilities.searchTitleAuthor = true
  registration.adapter!.searchTitleAuthor = async (_query, context) => ({ status: "found", provider: "open-library", requestId: context.requestId, value: [candidate("open-library", { isbns: [], evidence: { isbnExact: true } })] })
  const service = createBibliographicCatalogService({ providers: [registration] })
  const result = await service.searchTitleAuthor({ title: "Prueba" })
  assert.deepEqual(result.candidates[0].isbns, [])
  assert.equal(result.candidates[0].evidence.isbnExact, false)
  await assert.rejects(service.searchTitleAuthor({}), DomainError)
  await assert.rejects(service.resolveEditions({ provider: "open-library", recordKind: "work", recordId: "https://privado.test/registro" }), DomainError)
  assert.equal((await service.resolveEditions({ provider: "open-library", recordKind: "work", recordId: "OL1W" })).status, "incomplete")
})

test("DTO inválido y excepción privada son unavailable y no filtran contenido en telemetría", async () => {
  const records: TelemetryRecord[] = []
  const registration = source("open-library", "found", [candidate("open-library", { numberOfPages: -1 })])
  const service = createBibliographicCatalogService({ providers: [registration], telemetry: createLogger({ sink: (record) => records.push(record) }) })
  assert.equal((await service.lookupISBN(isbn)).status, "incomplete")
  registration.adapter!.lookupISBN = async () => { throw new Error(`api_key=privada ${isbn}`) }
  const result = await service.lookupISBN(isbn)
  assert.equal(result.providers[0].status, "unavailable")
  assert.equal(records.length, 2)
  assert.equal(records[1].fields.requestId, result.providers[0].requestId)
  assert.equal(records[1].fields.result, "unavailable")
  for (const excluded of [isbn, "api_key", "privada", "Ficha de prueba"]) assert.ok(!JSON.stringify(records).includes(excluded))
})

test("acciones mapean códigos existentes y conservan diagnóstico por fuente en value", async () => {
  for (const [status, code] of [["notFound", "NOT_FOUND"], ["unavailable", "PROVIDER_UNAVAILABLE"], ["rateLimited", "RATE_LIMITED"]] as const) {
    const value = await createBibliographicCatalogService({ providers: [source("open-library", status)] }).lookupISBN(isbn)
    const result = toBibliographyActionResult(value)
    assert.equal(result.ok, false)
    if (result.ok) assert.fail("Se esperaba error")
    assert.equal(result.error.code, code)
    assert.equal(result.value, value)
  }
  const found = await createBibliographicCatalogService({ providers: [source("open-library", "found"), source("bne", "unavailable")] }).lookupISBN(isbn)
  assert.equal(toBibliographyActionResult(found).ok, true)
})

test("política versionada: desconocido denegado; metadatos y derechos de imagen separados", () => {
  const policy = providerRightsPolicy("open-library")
  assert.equal(hasProviderRight(policy, "cacheMetadata"), true)
  assert.equal(hasProviderRight(policy, "previewCover"), true)
  for (const capability of ["rehostCover", "backupAsset", "offlineUse"] as const) assert.equal(hasProviderRight(policy, capability), false)
  assert.equal(hasProviderRight(undefined, "exportMetadata"), false)
  assert.equal(hasProviderRight({ ...policy, version: "desconocida" }, "persistMetadata"), false)
  assert.equal(hasProviderRight({ ...policy, previewCover: undefined }, "previewCover"), false)
  assert.equal(hasProviderRight(providerRightsPolicy("google-books"), "persistMetadata"), false)
  assert.ok(!policy.attribution.includes("CC0"))
  assert.equal(policy.metadataTtlSeconds, 3600)
})

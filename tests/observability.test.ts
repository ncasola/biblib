import assert from "node:assert/strict"
import { setTimeout } from "node:timers/promises"
import { test, type TestContext } from "node:test"
import { normalizeBookCover } from "../lib/book-covers"
import { recordCoverRecovery } from "../lib/cover-recovery"
import { DomainError } from "../lib/domain-errors"
import { enrichImportedBookCovers, parseLibraryImport } from "../lib/library-import"
import { createOpenLibraryClient } from "../lib/open-library"
import { CORRELATION_HEADER, correlationHeaders, getCorrelationId, isValidCorrelationId, parseCorrelationIdHeader, withCorrelation } from "../lib/observability/correlation"
import { classifyProviderFailure, TELEMETRY_EVENTS, type TelemetryEvent } from "../lib/observability/events"
import { createLogger, sanitizeFieldValue, type TelemetryRecord } from "../lib/observability/logger"
import { observeOperation } from "../lib/observability/operations"
import { accountRef } from "../lib/observability/pseudonym"
import type { Book } from "../lib/types"

function environment(t: TestContext, name: string, value?: string) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  t.after(() => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  })
}

function capture(t: TestContext) {
  environment(t, "BIBLIB_TELEMETRY", "on")
  const records: TelemetryRecord[] = []
  return { records, logger: createLogger({ sink: (record) => records.push(record) }) }
}

const isbn = "9788401337208" // Dato de prueba; nunca aparece en los eventos.
const book: Book = {
  id: "ficha-ficticia", isbn, title: "Título privado de prueba", authors: [{ name: "Autora privada" }],
  number_of_pages: 0, publish_date: "", cover: normalizeBookCover(), status: "unread", shelf_id: "shelf-1", shelf_name: "Privada",
}

test("catálogo cerrado y lista blanca: descarta y cuenta campos privados sin conservar sus nombres", (t) => {
  const { logger, records } = capture(t)
  logger.emit("import.preview", {
    operation: "import.validate", result: "ok", durationMs: 1,
    title: book.title, authors: book.authors, isbn, notes: "nota privada", file: "contenido privado", userId: "id-en-claro", extra: undefined,
  })
  assert.equal(logger.droppedFields, 7)
  assert.deepEqual(Object.keys(records[0].fields).sort(), ["correlationId", "durationMs", "operation", "result"])
  const output = JSON.stringify(records)
  for (const excluded of [book.title, "Autora privada", isbn, "nota privada", "contenido privado", "id-en-claro"]) assert.ok(!output.includes(excluded))
  logger.emit("evento.desconocido" as TelemetryEvent, { result: "error" })
  assert.equal(records.length, 1)
  assert.equal(logger.droppedFields, 8)
  assert.equal(TELEMETRY_EVENTS.length, 14)
})

test("sanea URLs de cualquier esquema, JWT, Bearer, pares de credenciales y claves", (t) => {
  const { logger, records } = capture(t)
  const dangerous = [
    "https://persona:password-ficticio@proveedor.test/ruta?api_key=secreto#fragmento",
    "postgres://persona:password-ficticio@db.test/biblioteca?token=secreto",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YWRvIn0.firma-ficticia",
    "Bearer credencial-ficticia", "api_key=credencial-ficticia", '"password":"credencial-ficticia"',
    "sk_test_claveficticia", "sb_secret_claveficticia", "-----BEGIN PRIVATE KEY-----\nclaveficticia\n-----END PRIVATE KEY-----",
  ]
  for (const value of dangerous) {
    assert.notEqual(sanitizeFieldValue(value), value)
    logger.emit("provider.request", { operation: value, errorCode: value, provider: value, accountRef: value, correlationId: value })
  }
  const serialized = JSON.stringify(records)
  for (const value of dangerous) assert.ok(!serialized.includes(value))
  assert.ok(!serialized.includes("credencial-ficticia"))
  assert.ok(!serialized.includes("password-ficticio"))
  assert.equal(logger.droppedFields, dangerous.length * 5)
})

test("rechaza valores no escalares, números inválidos, cuenta en claro y etiquetas con texto libre", (t) => {
  const { logger, records } = capture(t)
  logger.emit("db.operation", { operation: "mensaje con datos privados", durationMs: NaN, batch: -1, attempt: 1.5, httpStatus: 999, accountRef: "usuario-real", extra: { token: "privado" } })
  assert.equal(logger.droppedFields, 7)
  assert.deepEqual(Object.keys(records[0].fields), ["correlationId"])
  const circular: Record<string, unknown> = {}; circular.self = circular
  assert.doesNotThrow(() => logger.emit("db.operation", { operation: circular as unknown as string }))
})

test("enabled=false y BIBLIB_TELEMETRY=off son no-op, incluso con enabled=true y tras crear el logger", (t) => {
  const { logger, records } = capture(t)
  const disabled = createLogger({ enabled: false, sink: () => { throw new Error("No debe entrar") } })
  disabled.emit("auth.failure", { title: "privado" })
  assert.equal(disabled.droppedFields, 0)
  assert.equal(disabled.enabled, false)
  process.env.BIBLIB_TELEMETRY = "off"
  logger.emit("auth.failure", { result: "error" })
  const forced = createLogger({ enabled: true, sink: () => { throw new Error("No debe entrar") } })
  assert.equal(forced.enabled, false)
  forced.emit("auth.failure")
  assert.equal(records.length, 0)
})

test("un sink que falla no cambia ni un resultado ni una excepción de dominio", async (t) => {
  environment(t, "BIBLIB_TELEMETRY", "on")
  const logger = createLogger({ sink() { throw new Error("Sink roto") } })
  assert.equal(await observeOperation("import.commit", "import.commit", async () => 42, logger), 42)
  const failure = new DomainError("CONFLICT", "Mensaje privado")
  await assert.rejects(observeOperation("import.commit", "import.commit", async () => { throw failure }, logger), (error) => error === failure)
  const client = createOpenLibraryClient({ fetch: async () => Response.json({}), telemetry: { emit() { throw new Error("Adaptador roto") } } })
  assert.equal(await client.searchBookByISBN(isbn), null)
})

test("la salida por defecto es una línea JSON en stdout o stderr según el resultado", (t) => {
  environment(t, "BIBLIB_TELEMETRY", "on")
  const stdout: string[] = [], stderr: string[] = []
  const out = t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true })
  const err = t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true })
  try {
    const logger = createLogger()
    logger.emit("provider.request", { result: "ok" })
    logger.emit("provider.request", { result: "error", errorCode: "rate_limited" })
  } finally { out.mock.restore(); err.mock.restore() }
  assert.equal(stdout.length, 1)
  assert.equal(stderr.length, 1)
  assert.equal(JSON.parse(stdout[0]).level, "info")
  assert.equal(JSON.parse(stderr[0]).fields.errorCode, "rate_limited")
  assert.ok(stdout[0].endsWith("\n"))
})

test("correlación anidada: hereda, permite ID explícito y restaura también tras un fallo", async () => {
  assert.equal(getCorrelationId(), undefined)
  await withCorrelation(async () => {
    assert.equal(getCorrelationId(), "exterior-123")
    await withCorrelation(async () => { assert.equal(getCorrelationId(), "exterior-123") })
    await assert.rejects(withCorrelation(async () => {
      assert.equal(getCorrelationId(), "interior-123")
      throw new Error("Fallo ficticio")
    }, "interior-123"))
    assert.equal(getCorrelationId(), "exterior-123")
  }, "exterior-123")
  assert.equal(getCorrelationId(), undefined)
})

test("correlaciones concurrentes permanecen aisladas en los eventos tras esperas", async (t) => {
  const { logger, records } = capture(t)
  await Promise.all(Array.from({ length: 8 }, (_, index) => withCorrelation(async () => {
    await setTimeout(8 - index)
    logger.emit("provider.request", { operation: `test.${index}`, correlationId: "id-falso-123" })
    await withCorrelation(async () => { assert.equal(getCorrelationId(), `peticion-${index}`) })
  }, `peticion-${index}`)))
  for (const record of records) assert.equal(record.fields.correlationId, `peticion-${String(record.fields.operation).split(".")[1]}`)
  assert.equal(getCorrelationId(), undefined)
})

test("valida formato/longitud de cabecera y propaga sobre una copia de Headers", async () => {
  for (const value of [null, undefined, "", "corto", "x".repeat(65), "con espacios", "primero-123,segundo-123", "<script>123</script>", "valor\r\nprivado", "sk_test_claveficticia"]) assert.equal(parseCorrelationIdHeader(value), undefined)
  assert.equal(parseCorrelationIdHeader("peticion-valida-123"), "peticion-valida-123")
  const original = new Headers({ Accept: "application/json", [CORRELATION_HEADER]: "anterior-123" })
  await withCorrelation(async () => {
    const outgoing = correlationHeaders(original)
    assert.equal(outgoing.get(CORRELATION_HEADER), "peticion-valida-123")
    assert.equal(outgoing.get("Accept"), "application/json")
    assert.equal(original.get(CORRELATION_HEADER), "anterior-123")
  }, parseCorrelationIdHeader("peticion-valida-123"))
  await withCorrelation(async () => { assert.ok(isValidCorrelationId(getCorrelationId())) }, "inválido")
  assert.ok(isValidCorrelationId(correlationHeaders().get(CORRELATION_HEADER)))
})

test("accountRef es HMAC estable, cambia con la sal y omite el ID cuando falta", (t) => {
  const { logger, records } = capture(t)
  environment(t, "BIBLIB_TELEMETRY_SALT", "sal-sintetica-exclusiva-de-pruebas")
  const userId = "usuario-ficticio-privado"
  const first = accountRef(userId)
  assert.match(first!, /^acct_[a-f0-9]{64}$/)
  assert.equal(first, accountRef(userId))
  assert.notEqual(first, accountRef("otra-cuenta"))
  process.env.BIBLIB_TELEMETRY_SALT = "otra-sal-sintetica"
  assert.notEqual(first, accountRef(userId))
  delete process.env.BIBLIB_TELEMETRY_SALT
  assert.equal(accountRef(userId), undefined)
  logger.emit("account.deletion", { accountRef: accountRef(userId) })
  logger.emit("account.deletion", { accountRef: first })
  assert.equal("accountRef" in records[0].fields, false)
  assert.equal(records[1].fields.accountRef, first)
  assert.ok(!JSON.stringify(records).includes(userId))
})

test("clasifica 429, 404, 5xx, timeout y red sin colapsar categorías", () => {
  assert.equal(classifyProviderFailure(429), "rate_limited")
  assert.equal(classifyProviderFailure({ status: 404 }), "not_found")
  for (const status of [500, 502, 503, 504]) assert.equal(classifyProviderFailure(status), "upstream_error")
  assert.equal(classifyProviderFailure(new DOMException("privado", "TimeoutError")), "timeout")
  assert.equal(classifyProviderFailure(new DOMException("privado", "AbortError")), "timeout")
  assert.equal(classifyProviderFailure(new TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } })), "timeout")
  assert.equal(classifyProviderFailure(new TypeError("red privada")), "network")
  assert.equal(classifyProviderFailure(new SyntaxError("JSON privado")), "upstream_error")
  const circular: { cause?: unknown } = {}; circular.cause = circular
  assert.equal(classifyProviderFailure(circular), "network")
})

test("Open Library 429/404/503 produce un evento correlacionado sin ISBN ni título", async (t) => {
  const { logger, records } = capture(t)
  for (const [status, errorCode, domainCode] of [[429, "rate_limited", "RATE_LIMITED"], [404, "not_found", "PROVIDER_UNAVAILABLE"], [503, "upstream_error", "PROVIDER_UNAVAILABLE"]] as const) {
    const client = createOpenLibraryClient({ telemetry: logger, fetch: async () => new Response(book.title, { status }) })
    await withCorrelation(async () => {
      await assert.rejects(client.searchBookByISBN(isbn), (error) => error instanceof DomainError && error.code === domainCode)
    }, parseCorrelationIdHeader(`prueba-http-${status}`))
    assert.equal(records.at(-1)?.fields.correlationId, `prueba-http-${status}`)
    assert.equal(records.at(-1)?.fields.errorCode, errorCode)
    assert.equal(records.at(-1)?.fields.httpStatus, status)
  }
  assert.equal(records.length, 3)
  const serialized = JSON.stringify(records)
  for (const excluded of [isbn, book.title, book.authors[0].name, "openlibrary.org/api/books", "ISBN:"]) assert.ok(!serialized.includes(excluded))
})

test("timeout al leer un cuerpo HTTP 200 conserva timeout, y JSON inválido upstream_error", async (t) => {
  const { logger, records } = capture(t)
  const response = Response.json({})
  t.mock.method(response, "json", async () => { throw new DOMException("Contenido privado", "TimeoutError") })
  await assert.rejects(createOpenLibraryClient({ telemetry: logger, fetch: async () => response }).searchBookByISBN(isbn))
  assert.equal(records[0].fields.errorCode, "timeout")
  await assert.rejects(createOpenLibraryClient({ telemetry: logger, fetch: async () => new Response("privado") }).searchBookByISBN(isbn))
  assert.equal(records[1].fields.errorCode, "upstream_error")
})

test("preview válido/inválido y conflicto de commit no registran el mensaje privado", async (t) => {
  const { logger, records } = capture(t)
  const input = { books: [book], shelves: [{ id: "shelf-1", title: "Privada", book_count: 1 }] }
  assert.equal(parseLibraryImport(input, logger).books[0].title, book.title)
  assert.throws(() => parseLibraryImport({ ...input, books: [{ ...book, shelf_id: "ausente" }] }, logger))
  const error = new DomainError("CONFLICT", book.title)
  await withCorrelation(async () => {
    await assert.rejects(observeOperation("import.commit", "import.commit", async () => { throw error }, logger), (caught) => caught === error)
  }, "importacion-123")
  assert.deepEqual(records.map((record) => record.event), ["import.preview", "import.preview", "import.commit", "import.conflict"])
  assert.equal(records[1].fields.errorCode, "INVALID_INPUT")
  assert.equal(records[3].fields.errorCode, "CONFLICT")
  assert.equal(records[3].fields.correlationId, "importacion-123")
  assert.ok(!JSON.stringify(records).includes(book.title))
})

test("portadas 429 conservan el fallback y los contadores excluyen cursor y fichas", async (t) => {
  const { logger, records } = capture(t)
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 429 }))
  await withCorrelation(async () => {
    assert.deepEqual(await enrichImportedBookCovers([book], logger), [book])
    recordCoverRecovery({ nextCursor: "cursor-privado", scanned: 3, recovered: 1, unavailable: 2, skipped: 0 }, logger)
  }, "portadas-123")
  assert.equal(records[0].fields.errorCode, "rate_limited")
  assert.deepEqual(records.slice(1).map((record) => [record.fields.result, record.fields.batch]), [["recovered", 1], ["unavailable", 2]])
  assert.ok(records.every((record) => record.fields.correlationId === "portadas-123"))
  assert.ok(!JSON.stringify(records).includes("cursor-privado"))
  assert.ok(!JSON.stringify(records).includes(isbn))
})

test("telemetría apagada conserva ficha, ausencia, error de cuota e importación", async (t) => {
  environment(t, "BIBLIB_TELEMETRY", "off")
  const logger = createLogger({ sink() { assert.fail("No debe emitir") } })
  const full = createOpenLibraryClient({ telemetry: logger, fetch: async () => Response.json({ [`ISBN:${isbn}`]: { title: book.title } }) })
  assert.equal((await full.searchBookByISBN(isbn))?.title, book.title)
  assert.equal(await createOpenLibraryClient({ telemetry: logger, fetch: async () => Response.json({}) }).searchBookByISBN(isbn), null)
  await assert.rejects(createOpenLibraryClient({ telemetry: logger, fetch: async () => new Response(null, { status: 429 }) }).searchBookByISBN(isbn), (error) => error instanceof DomainError && error.code === "RATE_LIMITED")
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 429 }))
  assert.deepEqual(await enrichImportedBookCovers([book], logger), [book])
  assert.deepEqual(parseLibraryImport({ books: [], shelves: [] }, logger), { books: [], shelves: [] })
})

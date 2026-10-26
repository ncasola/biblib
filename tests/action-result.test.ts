import assert from "node:assert/strict"
import { test } from "node:test"
import { mutationResult, unwrapAction } from "../lib/action-result"
import { DomainError, httpStatusForDomainError, idempotencyConflict, isRetryable, previewExpired, revisionConflict, type DomainErrorCode } from "../lib/domain-errors"

test("los errores de dominio viajan en español sin depender de excepciones de Next", async () => {
  const result = await mutationResult(async () => { throw new DomainError("CONFLICT", "El libro ya está en la biblioteca.") })
  assert.deepEqual(result, { ok: false, error: { code: "CONFLICT", message: "El libro ya está en la biblioteca.", retryable: false } })
  assert.throws(() => unwrapAction(result), (error: unknown) => error instanceof DomainError && error.code === "CONFLICT")
  assert.equal(unwrapAction(await mutationResult(async () => "guardado")), "guardado")
})

test("los errores internos no filtran detalles al cliente ni al registro", async (context) => {
  const logged: string[] = []
  context.mock.method(console, "error", (value: unknown) => logged.push(String(value)))
  const result = await mutationResult(async () => { throw new Error("detalle interno reservado de la conexión") })
  assert.equal(result.ok, false)
  assert.doesNotMatch(JSON.stringify(result), /reservado/)
  assert.equal(logged.length, 1)
  assert.doesNotMatch(logged[0], /reservado/)
})

test("los conflictos de colección llevan mensaje en español, no son reintentables y conservan el correlationId", async () => {
  for (const [error, code, status] of [[revisionConflict(), "REVISION_CONFLICT", 409], [previewExpired(), "PREVIEW_EXPIRED", 410], [idempotencyConflict(), "IDEMPOTENCY_CONFLICT", 409]] as const) {
    const result = await mutationResult(async () => { throw error }, { correlation: () => "corr-12345678" })
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.error.code, code)
    assert.equal(result.error.retryable, false, `${code} nunca se reintenta automáticamente.`)
    assert.equal(result.error.correlationId, "corr-12345678")
    assert.match(result.error.message, /[áéíóúñ]|revis/i)
    assert.equal(httpStatusForDomainError(code), status)
  }
})

test("solo los fallos transitorios son reintentables y todos los códigos tienen estado HTTP", () => {
  const codes: DomainErrorCode[] = ["INVALID_INPUT", "UNAUTHORIZED", "NOT_FOUND", "CONFLICT", "PROVIDER_UNAVAILABLE", "RATE_LIMITED", "REVISION_CONFLICT", "PREVIEW_EXPIRED", "IDEMPOTENCY_CONFLICT"]
  assert.deepEqual(codes.filter(isRetryable), ["PROVIDER_UNAVAILABLE", "RATE_LIMITED"])
  for (const code of codes) assert.ok([400, 401, 404, 409, 410, 429, 503].includes(httpStatusForDomainError(code)))
})

test("un fallo inesperado conserva el correlationId para soporte sin detalles internos", async (context) => {
  context.mock.method(console, "error", () => {})
  const result = await mutationResult(async () => { throw new Error("interno") }, { correlation: () => "corr-abcdefgh" })
  assert.deepEqual(result, { ok: false, error: { code: "PROVIDER_UNAVAILABLE", message: "No se pudo guardar el cambio. Inténtalo de nuevo.", retryable: true, correlationId: "corr-abcdefgh" } })
})

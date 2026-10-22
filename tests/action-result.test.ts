import assert from "node:assert/strict"
import { test } from "node:test"
import { mutationResult, unwrapAction } from "../lib/action-result"
import { DomainError } from "../lib/domain-errors"

test("los errores de dominio viajan en español sin depender de excepciones de Next", async () => {
  const result = await mutationResult(async () => { throw new DomainError("CONFLICT", "El libro ya está en la biblioteca.") })
  assert.deepEqual(result, { ok: false, error: { code: "CONFLICT", message: "El libro ya está en la biblioteca." } })
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

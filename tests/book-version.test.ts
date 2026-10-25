import assert from "node:assert/strict"
import { test } from "node:test"
import { assertBookVersion } from "../lib/book-version"
import { DomainError } from "../lib/domain-errors"

test("rechaza un formulario antiguo o sin versión sin permitir sobrescrituras", () => {
  const current = { version: "10000000-0000-4000-8000-000000000001" }
  assert.doesNotThrow(() => assertBookVersion(current, current.version))
  for (const stale of [undefined, null, "", "otra", "20000000-0000-4000-8000-000000000001"]) {
    assert.throws(() => assertBookVersion(current, stale), (error) => error instanceof DomainError && error.code === "CONFLICT")
  }
})

test("acepta el token plano de la vista books aunque no sea un UUID RFC (md5 de ejemplar y edición, U-DAT-06)", () => {
  // md5(...)::uuid de Postgres: forma de UUID sin versión ni variante.
  const current = { version: "0cc175b9-c0f1-b6a8-31c3-99e269772661" }
  assert.doesNotThrow(() => assertBookVersion(current, current.version))
  assert.throws(() => assertBookVersion(current, "0cc175b9-c0f1-b6a8-31c3-99e26977266"), (error) => error instanceof DomainError && error.code === "CONFLICT")
})

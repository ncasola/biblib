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

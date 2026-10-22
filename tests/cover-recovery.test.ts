import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeBookCover } from "../lib/book-covers"
import { decideCoverRecovery, isCoverRecoveryCandidate, type CoverRecoverySnapshot } from "../lib/cover-recovery"

function snapshot(overrides: Partial<CoverRecoverySnapshot> = {}): CoverRecoverySnapshot {
  return { id: "123e4567-e89b-42d3-a456-426614174000", isbn: "9788401337208", version: "123e4567-e89b-42d3-a456-426614174001", cover: normalizeBookCover(), ...overrides }
}

const found = normalizeBookCover({ large: "https://covers.openlibrary.org/b/id/1-L.jpg" })

test("recupera una portada pendiente y completa sus tamaños sin cambiar el snapshot", () => {
  const original = snapshot()
  const saved = structuredClone(original)
  assert.deepEqual(decideCoverRecovery(original, snapshot(), { ...found, small: "" }), { outcome: "recovered", cover: found })
  assert.deepEqual(original, saved)
})

test("una corrección manual, cambio de ISBN, eliminación o versión nueva impiden sobrescribir la ficha", () => {
  const original = snapshot()
  const changed = [
    undefined,
    snapshot({ id: "otro" }),
    snapshot({ version: "otra-version" }),
    snapshot({ isbn: "9788401339639" }),
    snapshot({ cover: found }),
    snapshot({ cover: { ...original.cover, small: found.small } }),
  ]
  for (const current of changed) assert.deepEqual(decideCoverRecovery(original, current, found), { outcome: "skipped" })
  // Aunque una ficha vuelva a los mismos valores visibles, la nueva versión evita el problema ABA.
  assert.deepEqual(decideCoverRecovery(original, snapshot({ version: "version-tras-restaurar" }), found), { outcome: "skipped" })
})

test("sin ISBN válido se omite la consulta y sin resultado se informa de portada no disponible", () => {
  for (const isbn of ["manual-ejemplar", "9788401337201", ""]) {
    const original = snapshot({ isbn })
    assert.deepEqual(decideCoverRecovery(original, original, found), { outcome: "skipped" })
  }
  assert.deepEqual(decideCoverRecovery(snapshot(), snapshot(), undefined), { outcome: "unavailable" })
  assert.deepEqual(decideCoverRecovery(snapshot(), snapshot(), normalizeBookCover()), { outcome: "unavailable" })
})

test("solo considera pendientes los tamaños vacíos, genéricos o el placeholder antiguo", () => {
  assert.equal(isCoverRecoveryCandidate({ small: "", medium: " /default-book-cover.webp ", large: "/placeholder.svg?height=300" }), true)
  assert.equal(isCoverRecoveryCandidate(found), false)
  assert.equal(isCoverRecoveryCandidate({ ...normalizeBookCover(), small: "https://example.com/portada.jpg" }), false)
  const existing = snapshot({ cover: found })
  assert.deepEqual(decideCoverRecovery(existing, existing, found), { outcome: "skipped" })
})

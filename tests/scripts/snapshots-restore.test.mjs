import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { classifyDestination, classifySnapshots, DERIVED_TABLES, SNAPSHOT_TABLES } from "../../scripts/db/restore-local.mjs"
import { loadCensus } from "../../scripts/db/seed-local.mjs"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"

// U-DAT-02 · Trato explícito de las versiones anteriores en el restore administrativo (sin Docker).
// La consulta real de integridad se ejerce contra Postgres en tests/integration/snapshots.

const repo = fileURLToPath(new URL("../../", import.meta.url))
const ready = (extra = {}) => ({ state: "ready", expired: false, chunks: 2, chunksOk: true, digestOk: true, ...extra })

test("restore: las versiones anteriores son datos de la cuenta, no tablas derivadas", () => {
  for (const table of SNAPSHOT_TABLES) assert.ok(!DERIVED_TABLES.includes(table), `${table} no se regenera: se restaura`)
  const census = loadCensus(repo)
  const empty = { users: [], books: [], shelves: [], buckets: [], objects: [] }
  assert.equal(classifyDestination({ ...empty, otherRows: [{ table: "library_snapshots", rows: 0 }, { table: "library_snapshot_chunks", rows: 0 }] }, census).fresh, true)
  const withHistory = classifyDestination({ ...empty, otherRows: [{ table: "library_snapshots", rows: 1 }, { table: "library_snapshot_chunks", rows: 1 }] }, census)
  assert.equal(withHistory.fresh, false, "un destino con versiones anteriores no está vacío")
  assert.deepEqual(withHistory.foreign, ["filas en otras tablas de biblib"])
})

test("restore: versiones íntegras se cuentan; vencidas o sin completar se señalan para revisión", () => {
  assert.deepEqual(classifySnapshots([]), { restored: 0, chunks: 0, expired: 0, capturing: 0, review: [] })
  const result = classifySnapshots([ready(), ready({ expired: true, chunks: 1 }), { state: "capturing", expired: false, chunks: 0, chunksOk: true, digestOk: false }])
  assert.deepEqual([result.restored, result.chunks, result.expired, result.capturing], [2, 3, 1, 1])
  assert.equal(result.review.length, 2)
  assert.ok(result.review.every((item) => item.table === "biblib.library_snapshots" && !/[0-9a-f]{8}-[0-9a-f]{4}/.test(item.message)), "sin IDs en el recibo")
})

test("restore: un trozo o un hash final que no cuadra es un respaldo dañado (11)", () => {
  for (const damaged of [ready({ chunksOk: false }), ready({ digestOk: false }), ready({ chunks: 0 })]) {
    assert.throws(() => classifySnapshots([ready(), damaged]), (error) => error.code === EXIT.VERIFICATION_FAILED && error.phase === "rotate")
  }
})

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

// U-BIB-05 · El benchmark con red simulada se ejecuta en la suite de scripts: sin red, sin Docker y con sus
// invariantes (límite del proveedor, deduplicación, plazos y ausencia falsa) como comprobación.
const repo = fileURLToPath(new URL("../../", import.meta.url))

test("catalogue-bench mide 1, 10 y 100 consultas concurrentes y respeta los invariantes", { timeout: 180_000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "biblib-bench-"))
  try {
    const out = path.join(dir, "bench.json")
    const run = spawnSync(process.execPath, [path.join(repo, "scripts/performance/catalogue-bench.mjs"), "--check", "--out", out], { cwd: repo, encoding: "utf8" })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    const report = JSON.parse(readFileSync(out, "utf8"))
    assert.equal(report.simulated, true)
    assert.deepEqual([...new Set(report.rows.map((row) => row.consultasConcurrentes))], [1, 10, 100])
    for (const phase of ["fría", "caliente", "con fallos", "sin respuesta"]) assert.ok(report.rows.some((row) => row.fase === phase), phase)
    for (const row of report.rows) assert.ok(row.p50Ms !== null && row.p95Ms >= row.p50Ms)
    assert.deepEqual(report.violations, [])
    const silent = report.rows.filter((row) => row.fase === "sin respuesta")
    assert.ok(silent.every((row) => row.plazosAgotados > 0 && row.ausencias === 0), "un proveedor mudo es plazo agotado, nunca «no encontrado»")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("catalogue-bench rechaza argumentos desconocidos", () => {
  const run = spawnSync(process.execPath, [path.join(repo, "scripts/performance/catalogue-bench.mjs"), "--otro"], { cwd: repo, encoding: "utf8" })
  assert.equal(run.status, 2)
})

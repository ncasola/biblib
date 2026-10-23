import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { summarizeCatalogueTelemetry } from "../../scripts/catalogue-telemetry.mjs"

// U-BIB-05 · Resumen de operador por proveedor. Las líneas reproducen la forma real de los eventos que
// escriben el orquestador, el gateway, los adaptadores y el trabajo de portadas.
const record = (event, fields) => JSON.stringify({ event, level: fields.result === "error" ? "error" : "info", timestamp: "2026-10-23T10:00:00.000Z", fields })
const lines = [
  record("provider.request", { operation: "catalog.lookupISBN", provider: "open-library", result: "found", durationMs: 120 }),
  record("provider.request", { operation: "catalog.lookupISBN", provider: "open-library", result: "found", durationMs: 300 }),
  record("provider.request", { operation: "catalog.lookupISBN", provider: "open-library", result: "rateLimited", durationMs: 40 }),
  record("provider.request", { operation: "catalog.lookupISBN", provider: "bne", result: "notFound", durationMs: 800 }),
  record("provider.request", { operation: "catalog.lookupISBN", provider: "google-books", result: "disabled" }),
  record("provider.request", { operation: "open-library.lookup", provider: "open-library", result: "error", errorCode: "rate_limited", httpStatus: 429 }),
  record("provider.request", { operation: "catalogue.cache", provider: "open-library", result: "ok" }),
  record("provider.request", { operation: "catalogue.quota", provider: "bne", result: "skipped", errorCode: "rate_limited" }),
  record("provider.request", { operation: "catalogue.coordination", provider: "open-library", result: "unavailable" }),
  record("cover.recovery", { operation: "cover.source", provider: "open-library", result: "recovered", batch: 7 }),
  record("job.retried", { operation: "job.covers.covers", result: "error", errorCode: "RATE_LIMITED", batch: 3 }),
  record("job.failed", { operation: "job.covers.covers", result: "error", errorCode: "LEASE_LOST" }),
  "esto no es JSON",
  JSON.stringify({ evento: "ajeno" }),
  "",
]

test("agrega contadores y percentiles por proveedor sin reproducir ninguna línea", () => {
  const summary = summarizeCatalogueTelemetry(lines)
  assert.equal(summary.registrosLeidos, 12)
  assert.equal(summary.lineasDescartadas, 2)
  const openLibrary = summary.proveedores["open-library"]
  assert.equal(openLibrary.consultas, 3)
  assert.deepEqual([openLibrary.resultados.found, openLibrary.resultados.rateLimited], [2, 1])
  assert.deepEqual(openLibrary.latenciaMs, { p50: 120, p95: 300, muestras: 3 })
  assert.deepEqual(openLibrary.errores, { rate_limited: 1 })
  assert.equal(openLibrary.aciertosDeCache, 1)
  assert.equal(openLibrary.coordinacionNoDisponible, 1)
  assert.equal(openLibrary.portadasRecuperadas, 7)
  assert.equal(summary.proveedores.bne.resultados.notFound, 1)
  assert.equal(summary.proveedores.bne.esperasDeCuotaOmitidas, 1)
  assert.equal(summary.proveedores["google-books"].resultados.disabled, 1)
  assert.deepEqual(summary.trabajos, { reintentos: 3, fallos: 1, porCodigo: { RATE_LIMITED: 1, LEASE_LOST: 1 } })
  assert.ok(!JSON.stringify(summary).includes("esto no es JSON"))
})

test("un proveedor o resultado inesperado no altera contadores ajenos", () => {
  const summary = summarizeCatalogueTelemetry([
    record("provider.request", { operation: "catalog.lookupISBN", provider: "constructor", result: "found" }),
    record("provider.request", { operation: "catalog.lookupISBN", provider: "bne", result: "toString" }),
  ])
  assert.equal(summary.proveedores.bne.consultas, 1)
  assert.equal(Object.values(summary.proveedores.bne.resultados).reduce((total, value) => total + value, 0), 0)
  assert.deepEqual(Object.keys(summary.proveedores), ["open-library", "bne", "google-books"])
})

test("la CLI lee un archivo, valida argumentos y su salida JSON solo contiene cantidades", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "biblib-telemetria-"))
  try {
    const file = path.join(dir, "registros.jsonl")
    writeFileSync(file, `${lines.join("\n")}\n`)
    const script = fileURLToPath(new URL("../../scripts/catalogue-telemetry.mjs", import.meta.url))
    const ok = spawnSync(process.execPath, [script, "--file", file, "--json"], { encoding: "utf8" })
    assert.equal(ok.status, 0)
    assert.equal(JSON.parse(ok.stdout).proveedores["open-library"].consultas, 3)
    assert.equal(spawnSync(process.execPath, [script, "--otra"], { encoding: "utf8" }).status, 2)
    assert.equal(spawnSync(process.execPath, [script, "--file"], { encoding: "utf8" }).status, 2)
    assert.equal(spawnSync(process.execPath, [script, "--file", path.join(dir, "no-existe.jsonl")], { encoding: "utf8" }).status, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

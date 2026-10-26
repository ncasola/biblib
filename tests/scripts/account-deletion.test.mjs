import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { parseArgs, summarize } from "../../scripts/account/deletions-local.mjs"
import { compareRestored, parseVerifyArgs } from "../../scripts/db/restore-verify.mjs"
import { parseRestoreArgs } from "../../scripts/db/restore-local.mjs"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"
import { mergeSuppressions, readSuppressions, readSuppressionsFile } from "../../scripts/lib/suppressions.mjs"

// U-OPS-03 · Worker administrativo, registro privado de supresiones y su aplicación al verificar un restore. Sin
// Docker: las pruebas con stack real están en tests/integration/account.

const temporary = []
after(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }) })
const tempDir = () => { const dir = mkdtempSync(path.join(tmpdir(), "biblib supresiones ")); temporary.push(dir); return dir }
const A = "ad000000-0000-4000-8000-0000000000e1"
const B = "ad000000-0000-4000-8000-0000000000e2"

/** Contexto mínimo que aceptan readState/writeState para el perfil scratch. */
function stack(root = tempDir()) {
  return { root, profile: { name: "scratch", projectId: "biblib-scratch" }, identity: { root, hash: "raiz" }, fingerprint: "huella" }
}

test("argumentos del worker: perfil, ciclo único, intervalo, reintento y purga de marcas; nunca IDs ni URLs", () => {
  assert.deepEqual(parseArgs(["--profile", "scratch", "--once", "--retry-failed", "--purge-marks", "--json"]), { profile: "scratch", once: true, intervalMs: 10_000, retryFailed: true, purgeMarks: true, json: true })
  assert.equal(parseArgs(["--interval-ms", "5000"]).intervalMs, 5000)
  for (const argv of [["--profile", "prod"], ["--user", A], ["--interval-ms", "10"], ["--once", "--once"], ["--db-url", "postgres://x"]]) {
    assert.throws(() => parseArgs(argv), (error) => error.code === EXIT.INVALID_ARGS, argv.join(" "))
  }
})

test("el resumen del worker cuenta resultados y códigos, sin IDs de cuenta", () => {
  const summary = summarize([
    { outcome: "completed", step: "done", counts: { copies: 3 } },
    { outcome: "waiting_retry", step: "storage", errorCode: "STORAGE_UNAVAILABLE", counts: {} },
    { outcome: "waiting_retry", step: "storage", errorCode: "STORAGE_UNAVAILABLE", counts: {} },
    { outcome: "lease_lost", step: "copies", counts: {} },
  ])
  assert.deepEqual(summary, { processed: 4, completed: 1, waiting_retry: 2, failed: 0, lease_lost: 1, errors: { STORAGE_UNAVAILABLE: 2 } })
  assert.ok(!JSON.stringify(summary).includes("-4000-"))
})

test("registro de supresiones: une marcas sin perder cuentas, conserva el plazo mayor y retira las vencidas", () => {
  const ctx = stack()
  const now = Date.parse("2026-10-25T08:00:00Z")
  mergeSuppressions(ctx, [{ userId: A, requestedAt: "2026-10-25T07:00:00.000Z", completedAt: null, purgeAfter: null }], { now })
  mergeSuppressions(ctx, [{ userId: B, requestedAt: "2026-10-01T07:00:00.000Z", completedAt: "2026-10-01T08:00:00.000Z", purgeAfter: "2026-10-20T00:00:00.000Z" }], { now })
  // B ya venció: no entra. A sigue aunque la base ya no la tenga (p. ej., tras reconstruirla).
  assert.deepEqual(readSuppressions(ctx, { now }).map((entry) => entry.userId), [A])
  mergeSuppressions(ctx, [{ userId: A, requestedAt: "2026-10-25T07:30:00.000Z", completedAt: "2026-10-25T07:45:00.000Z", purgeAfter: "2027-01-23T07:45:00.000Z" }], { now })
  assert.deepEqual(readSuppressions(ctx, { now }), [{ userId: A, requestedAt: "2026-10-25T07:00:00.000Z", completedAt: "2026-10-25T07:45:00.000Z", purgeAfter: "2027-01-23T07:45:00.000Z" }])
  assert.deepEqual(readSuppressions(ctx, { now: Date.parse("2027-02-01T00:00:00Z") }), [], "tras el plazo de la marca, la entrada se retira")
})

test("un registro exportado de otro entorno se valida antes de tocar el destino", () => {
  const dir = tempDir()
  const good = path.join(dir, "bueno.json")
  writeFileSync(good, JSON.stringify({ entries: [{ userId: A, requestedAt: "2026-10-25T07:00:00Z" }] }))
  assert.deepEqual(readSuppressionsFile(good).map((entry) => entry.userId), [A])
  const bad = path.join(dir, "malo.json")
  writeFileSync(bad, JSON.stringify({ entries: [{ userId: "persona@example.com" }] }))
  assert.throws(() => readSuppressionsFile(bad), (error) => error.code === EXIT.INVALID_ARGS)
  assert.throws(() => readSuppressionsFile(path.join(dir, "no-existe.json")), (error) => error.code === EXIT.INVALID_ARGS)
  assert.equal(parseRestoreArgs(["--backup", "b", "--profile", "scratch", "--expect-project", "biblib-scratch", "--suppressions", good]).suppressions, good)
  assert.throws(() => parseVerifyArgs(["--backup", "b", "--profile", "scratch", "--suppressions", good]), (error) => error.code === EXIT.INVALID_ARGS, "verify lee las supresiones del destino, no de un argumento")
})

test("verify con supresiones: tablas afectadas contra el estado tras suprimir y ningún resto de la cuenta", () => {
  const manifest = {
    migrations: { head: "0013_account_deletion", applied: [{ tag: "0013_account_deletion", hash: "h", created_at: 1 }] },
    objects: { hash: "facts", facts: { tables: [1] } },
    digests: [{ schema: "biblib", table: "copies", count: 3, keys: "k3", content: "c3" }, { schema: "biblib", table: "shelves", count: 2, keys: "ks", content: "cs" }],
    tokens: { "biblib.books.version": ["t1", "t2", "t3"] }, sample: [{ id: "b1", digest: "d1" }, { id: "b3", digest: "d3" }],
  }
  const phase = { adjusted: [{ schema: "biblib", table: "copies", count: 2, keys: "k2", content: "c2" }], tokensRemoved: { "biblib.books.version": 1 }, sampleRemoved: ["b3"] }
  const current = {
    ledger: [{ hash: "h", created_at: 1 }], inspection: { code: 0, state: "up-to-date", manifest: [{ id: "rls.copies", status: "ok" }] }, objects: { hash: "facts", facts: { tables: [1] } },
    digests: [{ schema: "biblib", table: "copies", count: 2, keys: "k2", content: "c2" }, { schema: "biblib", table: "shelves", count: 2, keys: "ks", content: "cs" }],
    tokens: { "biblib.books.version": ["n1", "n2"] }, sample: [{ id: "b1", digest: "d1" }],
    suppression: { phase, ids: [A], residue: [{ rows: 0, objects: 0, account: false }] },
  }
  const checks = compareRestored(manifest, current)
  assert.deepEqual(checks.filter((c) => c.status === "fail").map((c) => c.id), [])
  assert.ok(checks.some((c) => c.id === "suppressions.applied" && c.status === "ok"))
  const failing = (patch) => compareRestored(manifest, { ...current, ...patch }).filter((c) => c.status === "fail").map((c) => c.id)
  // Sin la fase suppress, una fila menos es una discrepancia: la supresión se acredita, no se supone.
  assert.deepEqual(failing({ suppression: { phase: null, ids: [], residue: [] } }).sort(), ["sample.books", "table.biblib.copies", "tokens.biblib.books.version"])
  assert.deepEqual(failing({ digests: [{ ...current.digests[0], content: "otro" }, current.digests[1]] }), ["table.biblib.copies"])
  assert.deepEqual(failing({ suppression: { ...current.suppression, residue: [{ rows: 4, objects: 0, account: true }] } }), ["suppressions.applied"])
  assert.deepEqual(failing({ digests: [current.digests[0], { ...current.digests[1], count: 1 }] }), ["table.biblib.shelves"], "las tablas que la supresión no cambió siguen comparándose con el recibo")
})

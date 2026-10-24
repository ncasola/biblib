import assert from "node:assert/strict"
import { test } from "node:test"
import { classifyDestination, classifyRestoreSessions, DERIVED_TABLES, RESTORE_SESSION_TABLES } from "../../scripts/db/restore-local.mjs"
import { parseArgs } from "../integration/restore/run.mjs"
import { suiteBatches } from "../integration/run.mjs"

// U-DAT-04 · Sin Docker: el restore administrativo trata las sesiones de restauración y el grupo
// de integración restore solo admite scratch o test.

test("restore: scratch y test explícitos, rechazo de perfiles o argumentos ajenos", () => {
  for (const profile of ["scratch", "test"]) assert.equal(parseArgs(["--profile", profile]).profile, profile)
  assert.equal(parseArgs([]).profile, "test")
  assert.equal(parseArgs(["--reuse-build"]).reuseBuild, true)
  for (const args of [["--profile", "main"], ["--profile", "prod"], ["--db-url", "remoto"], ["--profile", "scratch", "--profile", "test"]]) assert.throws(() => parseArgs(args), { code: 2 })
})

test("el grupo restore forma parte de test:integration:local", () => {
  assert.ok(suiteBatches().flat().some((file) => file.replaceAll("\\", "/").startsWith("tests/integration/restore/")))
})

test("el staging de restauración se restaura como datos de la cuenta: un destino con sesiones no está vacío", () => {
  assert.deepEqual(RESTORE_SESSION_TABLES, ["import_sessions", "import_session_parts", "import_session_chunks", "import_session_rows"])
  for (const table of RESTORE_SESSION_TABLES) {
    assert.equal(DERIVED_TABLES.includes(table), false, `${table} no es derivada`)
    const state = { users: [], books: [], shelves: [], otherRows: [{ table, rows: 1 }], buckets: [], objects: [] }
    assert.equal(classifyDestination(state, { accounts: [] }).fresh, false, table)
  }
})

test("trozos dañados abortan el restore; sesiones sin publicar quedan para revisión", () => {
  assert.deepEqual(classifyRestoreSessions({ sessions: 2, open: 0, chunks: 4, damaged: 0 }), { sessions: 2, open: 0, chunks: 4, review: [] })
  const open = classifyRestoreSessions({ sessions: 2, open: 1, chunks: 4, damaged: 0 })
  assert.equal(open.review.length, 1)
  assert.equal(open.review[0].table, "biblib.import_sessions")
  assert.throws(() => classifyRestoreSessions({ sessions: 1, open: 1, chunks: 3, damaged: 1 }), { code: 11 })
})

test("perf:restore: perfiles scratch o test, escalas 100/1000/10000 y repeticiones acotadas", async () => {
  const { parseArgs: benchArgs } = await import("../../scripts/performance/restore-bench.mjs")
  assert.deepEqual(benchArgs([]).scales, [100, 1000, 10000])
  assert.deepEqual(benchArgs(["--scale", "10000", "--scale", "100"]).scales, [100, 10000])
  assert.equal(benchArgs(["--profile", "test", "--repeat", "5"]).repeat, 5)
  for (const args of [["--profile", "main"], ["--scale", "500"], ["--repeat", "9"], ["--db-url", "x"]]) assert.throws(() => benchArgs(args), { code: 2 })
})

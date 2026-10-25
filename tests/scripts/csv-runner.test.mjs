import assert from "node:assert/strict"
import { test } from "node:test"
import { parseArgs } from "../integration/csv/run.mjs"
import { suiteBatches } from "../integration/run.mjs"

test("CSV: runner solo admite scratch/test y argumentos acotados", () => {
  assert.equal(parseArgs([]).profile, "test")
  assert.equal(parseArgs(["--profile", "scratch", "--reuse-build"]).reuseBuild, true)
  for (const args of [["--profile", "main"], ["--profile", "prod"], ["--db-url", "remoto"], ["--profile", "test", "--profile", "test"]]) assert.throws(() => parseArgs(args), { code: 2 })
})
test("CSV: grupo incluido en integración local real", () => {
  assert.ok(suiteBatches().flat().some((file) => file.replaceAll("\\", "/").startsWith("tests/integration/csv/")))
})

import assert from "node:assert/strict"
import { test } from "node:test"
import { parseArgs } from "../integration/personal/run.mjs"
import { suiteBatches } from "../integration/run.mjs"

test("personal: runner aislado acepta solo scratch|test y se registra en SUITES", () => {
  assert.deepEqual(parseArgs([]), { profile: "test", reuseBuild: false })
  assert.deepEqual(parseArgs(["--profile", "scratch", "--reuse-build"]), { profile: "scratch", reuseBuild: true })
  for (const args of [["--profile", "prod"], ["--profile", "main"], ["--url", "https://example.test"], ["--reuse-build", "--reuse-build"]]) assert.throws(() => parseArgs(args))
  assert.ok(suiteBatches().flat().some((file) => /personal[\\/]personal.test.mjs$/.test(file)))
})

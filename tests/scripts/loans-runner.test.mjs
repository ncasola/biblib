import assert from "node:assert/strict"
import test from "node:test"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"
import { parseArgs } from "../integration/loans/run.mjs"
import { suiteBatches } from "../integration/run.mjs"

test("loans: perfiles scratch o test y --reuse-build, rechaza cualquier otro destino", () => {
  assert.deepEqual(parseArgs([]), { profile: "test", reuseBuild: false })
  assert.deepEqual(parseArgs(["--profile", "scratch", "--reuse-build"]), { profile: "scratch", reuseBuild: true })
  for (const argv of [["--profile", "main"], ["--profile"], ["--url", "postgres://x"], ["--reuse-build", "--reuse-build"]]) assert.throws(() => parseArgs(argv), { code: EXIT.INVALID_ARGS })
})
test("loans: está registrado en el lote principal de la integración local", () => {
  const [main] = suiteBatches()
  assert.ok(main.some((file) => file.replaceAll("\\", "/") === "tests/integration/loans/acciones.test.mjs"))
})

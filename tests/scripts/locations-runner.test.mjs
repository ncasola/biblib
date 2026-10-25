import assert from "node:assert/strict"
import test from "node:test"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"
import { parseArgs } from "../integration/locations/run.mjs"
import { suiteBatches } from "../integration/run.mjs"

// Runner del grupo locations (U-PRO-03) sin Docker ni stack: argumentos y registro en test:integration:local.

test("locations: perfiles scratch o test y --reuse-build; nada más", () => {
  assert.deepEqual(parseArgs([]), { profile: "test", reuseBuild: false })
  assert.deepEqual(parseArgs(["--profile", "scratch", "--reuse-build"]), { profile: "scratch", reuseBuild: true })
  for (const argv of [["--profile", "main"], ["--profile"], ["--url", "postgres://x"], ["--reuse-build", "--reuse-build"]]) {
    assert.throws(() => parseArgs(argv), { code: EXIT.INVALID_ARGS })
  }
})

test("locations: el grupo forma parte de test:integration:local, en el lote principal", () => {
  const [main, ...rest] = suiteBatches()
  const files = main.map((file) => file.replaceAll("\\", "/")).filter((file) => file.startsWith("tests/integration/locations/"))
  assert.deepEqual(files.map((file) => file.split("/").at(-1)), ["aislamiento.test.mjs", "arbol.test.mjs", "ejemplar.test.mjs", "fotos.test.mjs", "ida-vuelta.test.mjs"])
  assert.ok(!rest.flat().some((file) => file.replaceAll("\\", "/").startsWith("tests/integration/locations/")))
})

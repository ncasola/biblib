import assert from "node:assert/strict"
import { test } from "node:test"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"
import { parseArgs } from "../integration/catalogue/run.mjs"
import { catalogueProfile, fakeIsbn } from "../integration/catalogue/lib/context.mjs"

test("catalogue: solo perfiles scratch o test, sin otros argumentos", () => {
  assert.deepEqual(parseArgs([]), { profile: "test" })
  assert.deepEqual(parseArgs(["--profile", "scratch"]), { profile: "scratch" })
  assert.deepEqual(parseArgs(["--profile", "test"]), { profile: "test" })
  for (const argv of [["--profile", "main"], ["--profile"], ["--profile", "scratch", "--reuse-build"], ["scratch"]]) {
    assert.throws(() => parseArgs(argv), { code: EXIT.INVALID_ARGS })
  }
})

test("catalogue: el perfil sale del entorno y rechaza main u objetivos remotos", (t) => {
  t.after(() => { delete process.env.BIBLIB_PROFILE; delete process.env.BIBLIB_TARGET })
  delete process.env.BIBLIB_PROFILE
  assert.equal(catalogueProfile(), "test")
  process.env.BIBLIB_PROFILE = "scratch"
  assert.equal(catalogueProfile(), "scratch")
  process.env.BIBLIB_PROFILE = "main"
  assert.throws(() => catalogueProfile(), { code: EXIT.IDENTITY_MISMATCH })
  process.env.BIBLIB_PROFILE = "test"
  process.env.BIBLIB_TARGET = "prod"
  assert.throws(() => catalogueProfile(), { code: EXIT.IDENTITY_MISMATCH })
})

test("catalogue: los ISBN de prueba son sintéticos y tienen dígito de control válido", () => {
  const seen = new Set()
  for (let n = 0; n < 200; n++) {
    const isbn = fakeIsbn(n)
    assert.match(isbn, /^97900009\d{5}$/)
    const sum = [...isbn].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0)
    assert.equal(sum % 10, 0)
    seen.add(isbn)
  }
  assert.equal(seen.size, 200)
})

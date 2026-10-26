import assert from "node:assert/strict"
import { test } from "node:test"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"
import { parseArgs, runnerToken, runOnce } from "../../scripts/jobs/run-local.mjs"
import { parseArgs as parseJobsSuite } from "../integration/jobs/run.mjs"

// U-DAT-03 · Ejecutor local de trabajos y runner del grupo jobs, sin Docker ni app.

test("argumentos del ejecutor local", () => {
  assert.deepEqual(parseArgs([]), { profile: "main", once: false, intervalMs: 5000 })
  assert.deepEqual(parseArgs(["--profile", "scratch", "--once"]), { profile: "scratch", once: true, intervalMs: 5000 })
  assert.equal(parseArgs(["--interval-ms", "1000"]).intervalMs, 1000)
  for (const bad of [["--profile", "prod"], ["--interval-ms", "10"], ["--url", "http://x"], ["--once", "--once"], ["--owner", "a"]]) {
    assert.throws(() => parseArgs(bad), (error) => error.code === EXIT.INVALID_ARGS, bad.join(" "))
  }
})

test("el token coincide con el de la app y no acepta secretos débiles", () => {
  const env = { SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55342/postgres" }
  assert.equal(runnerToken(env), "rq32VLQEo4VVLW__cEk63UWpMO21z9JeXSdFJZxaZWc", "mismo vector que tests/library-jobs.test.ts")
  assert.equal(runnerToken({ ...env, BIBLIB_JOBS_RUNNER_SECRET: "corto" }), null)
  assert.equal(runnerToken({ BIBLIB_JOBS_RUNNER_SECRET: "s".repeat(40) }), "s".repeat(40))
  assert.equal(runnerToken({}), null)
})

test("un disparo envía solo el token y traduce las respuestas", async () => {
  const seen = []
  const reply = (status, body) => async (url, init) => { seen.push({ url, init }); return new Response(body ? JSON.stringify(body) : null, { status }) }
  assert.deepEqual(await runOnce({ url: "http://127.0.0.1:3149/api/internal/jobs/run", token: "t".repeat(43), fetchImpl: reply(200, { steps: 2, leaseLost: 1, failed: 0 }) }), { steps: 2, leaseLost: 1, failed: 0 })
  assert.equal(seen[0].init.method, "POST")
  assert.equal(seen[0].init.body, undefined, "no envía dueño ni ningún cuerpo")
  assert.equal(seen[0].init.headers.authorization, `Bearer ${"t".repeat(43)}`)
  await assert.rejects(runOnce({ url: "http://127.0.0.1:3149/x", token: "t", fetchImpl: reply(401) }), (error) => error.code === EXIT.IDENTITY_MISMATCH)
  await assert.rejects(runOnce({ url: "http://127.0.0.1:3149/x", token: "t", fetchImpl: reply(503) }), (error) => error.code === EXIT.SERVICE_UNAVAILABLE)
  await assert.rejects(runOnce({ url: "http://127.0.0.1:3149/x", token: "t", fetchImpl: async () => { throw new TypeError("fetch failed") } }), (error) => error.code === EXIT.SERVICE_UNAVAILABLE && /pnpm dev:local/.test(error.message))
})

test("argumentos del grupo de integración jobs", () => {
  assert.deepEqual(parseJobsSuite([]), { profile: "test", reuseBuild: false })
  assert.deepEqual(parseJobsSuite(["--profile", "scratch", "--reuse-build"]), { profile: "scratch", reuseBuild: true })
  for (const bad of [["--profile", "main"], ["--profile"], ["--url", "x"]]) assert.throws(() => parseJobsSuite(bad), (error) => error.code === EXIT.INVALID_ARGS)
})

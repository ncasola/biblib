import assert from "node:assert/strict"
import { test } from "node:test"
import { parseArgs, purgeBatch } from "../../scripts/jobs/purge-media-assets.mjs"
import { nextEnv } from "../../scripts/next-target.mjs"
import { parseArgs as parseGroup } from "../integration/media/run.mjs"

test("media: solo el valor 1 habilita la capacidad en Next; runner acotado a scratch/test", () => {
  const previous = process.env.BIBLIB_PRIVATE_MEDIA_UPLOADS
  try {
    for (const value of [undefined, "", "0", "true", "1"]) {
      if (value === undefined) delete process.env.BIBLIB_PRIVATE_MEDIA_UPLOADS
      else process.env.BIBLIB_PRIVATE_MEDIA_UPLOADS = value
      assert.equal(nextEnv({ target: "local", env: () => ({ BIBLIB_TARGET: "local" }) }, "start").BIBLIB_PRIVATE_MEDIA_UPLOADS, value === "1" ? "1" : "")
    }
  } finally {
    if (previous === undefined) delete process.env.BIBLIB_PRIVATE_MEDIA_UPLOADS
    else process.env.BIBLIB_PRIVATE_MEDIA_UPLOADS = previous
  }
  assert.equal(parseGroup(["--profile", "scratch"]).profile, "scratch")
  assert.throws(() => parseGroup(["--profile", "main"]))
})

test("media: argumentos acotados y perfil explícito", () => {
  assert.deepEqual(parseArgs(["--profile", "test", "--limit", "2", "--grace-seconds", "0", "--json"]), { profile: "test", limit: 2, graceSeconds: 0, json: true })
  for (const args of [["--profile", "prod"], ["--limit", "0"], ["--limit", "1001"], ["--grace-seconds", "-1"], ["--json", "--json"]]) assert.throws(() => parseArgs(args))
})

test("media: solo retira confirmados y huérfanos; una referencia nueva impide el borrado", async () => {
  let count = 0
  const removed = []
  const sql = async () => [{ result: ++count === 1 ? { assets: [{ id: "citada", reason: "unreferenced" }, { id: "vencida", reason: "quarantine" }], objects: [{ key: "huerfana" }] } : ["vencida"] }]
  const storage = { remove: async (keys) => { removed.push(...keys); return { data: keys, error: null } } }
  const report = await purgeBatch({ sql, storage, limit: 10, graceSeconds: 0 })
  assert.deepEqual(removed, ["vencida", "huerfana"])
  assert.equal(report.assets, 1); assert.equal(report.failedObjects, 0)
})

test("media: fallo de Storage queda pendiente y el siguiente lote puede recoger el huérfano", async () => {
  const sql = async () => [{ result: { assets: [], objects: [{ key: "pendiente" }] } }]
  const report = await purgeBatch({ sql, storage: { remove: async () => ({ error: new Error("red") }) }, limit: 10, graceSeconds: 0 })
  assert.equal(report.failedObjects, 1); assert.equal(report.objects, 0)
})

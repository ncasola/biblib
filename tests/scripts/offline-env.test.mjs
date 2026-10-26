import assert from "node:assert/strict"
import { test } from "node:test"
import { nextEnv } from "../../scripts/next-target.mjs"

// U-EXP-08: las banderas de servidor de la copia sin conexión pasan al proceso de Next como excepción
// explícita al filtrado de BIBLIB_* heredadas, solo con sus valores admitidos.
test("nextEnv pasa BIBLIB_OFFLINE_SNAPSHOT y BIBLIB_SERVICE_WORKER solo con sus valores admitidos", () => {
  const ctx = { target: "local", env: () => ({ BIBLIB_TARGET: "local" }) }
  const keys = ["BIBLIB_OFFLINE_SNAPSHOT", "BIBLIB_SERVICE_WORKER"]
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const set = (values) => { for (const key of keys) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key] } }
  try {
    set({})
    assert.equal(nextEnv(ctx, "start").BIBLIB_OFFLINE_SNAPSHOT, "")
    assert.equal(nextEnv(ctx, "start").BIBLIB_SERVICE_WORKER, "")
    set({ BIBLIB_OFFLINE_SNAPSHOT: "1", BIBLIB_SERVICE_WORKER: "limpieza" })
    assert.equal(nextEnv(ctx, "start").BIBLIB_OFFLINE_SNAPSHOT, "1")
    assert.equal(nextEnv(ctx, "start").BIBLIB_SERVICE_WORKER, "limpieza")
    set({ BIBLIB_OFFLINE_SNAPSHOT: "true", BIBLIB_SERVICE_WORKER: "otro" })
    assert.equal(nextEnv(ctx, "start").BIBLIB_OFFLINE_SNAPSHOT, "")
    assert.equal(nextEnv(ctx, "start").BIBLIB_SERVICE_WORKER, "")
  } finally { set(previous) }
})

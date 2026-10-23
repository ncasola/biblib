import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"
import { applyVariant, VARIANT_NAMES, VARIANTS } from "../../scripts/performance/lib/t4-variants.mjs"
import { parseT4Args, t4Table } from "../../scripts/performance/experiment-t4.mjs"

// U-FIX-02 · Experimento T4: argumentos, variantes de un solo factor y restauración del árbol. Sin Docker ni red.

const ROOT = path.resolve("raiz-ficticia")
const SOURCES = {
  "lib/db/client.ts": "  const queryClient = postgres(dbUrl, {\n    max: 1,\n    prepare: false,\n",
  "lib/server-user.ts": "      const { data: { user }, error } = await supabase.auth.getUser()\n",
}
const memoryFs = (files) => {
  const disk = new Map(Object.entries(files).map(([file, text]) => [path.join(ROOT, file), text]))
  return { disk, read: (file) => { if (!disk.has(file)) throw new Error(`no existe ${file}`); return disk.get(file) }, write: (file, text) => disk.set(file, text) }
}

test("perf:t4 mide 10000 ejemplares, todas las variantes y 1/5/10 sesiones por defecto, y rechaza lo desconocido", () => {
  const parsed = parseT4Args([])
  assert.equal(parsed.profile, "test")
  assert.equal(parsed.scale, 10000)
  assert.deepEqual(parsed.variants, VARIANT_NAMES)
  assert.deepEqual(parsed.concurrency, [1, 5, 10])
  assert.deepEqual(parseT4Args(["--variants", "base,pool-4", "--concurrency", "10,1", "--scale", "1000"]).concurrency, [1, 10])
  for (const argv of [["--profile", "main"], ["--variants", "pool-8"], ["--scale", "500"], ["--scenarios", "inventado"], ["--concurrency", "3"], ["--label", "../fuera"]]) {
    assert.throws(() => parseT4Args(argv), (error) => error.code === EXIT.INVALID_ARGS, argv.join(" "))
  }
})

test("cada variante cambia una sola cosa y se restaura exactamente, también con CRLF", () => {
  for (const eol of ["\n", "\r\n"]) {
    const fs = memoryFs(Object.fromEntries(Object.entries(SOURCES).map(([file, text]) => [file, text.replace(/\n/g, eol)])))
    const before = new Map(fs.disk)
    const restore = applyVariant(ROOT, "pool-4", fs)
    assert.match(fs.disk.get(path.join(ROOT, "lib/db/client.ts")), /max: 4,/)
    assert.equal(fs.disk.get(path.join(ROOT, "lib/server-user.ts")), before.get(path.join(ROOT, "lib/server-user.ts")), "Solo cambia el pool.")
    restore()
    assert.deepEqual(fs.disk, before)
    const restoreAuth = applyVariant(ROOT, "sin-getuser-accion", fs)
    const changed = fs.disk.get(path.join(ROOT, "lib/server-user.ts"))
    assert.match(changed, /getSession\(\)/)
    assert.ok(!changed.includes("getUser()"))
    assert.equal(changed.includes("\r\n"), eol === "\r\n", "Se conserva el fin de línea del archivo.")
    restoreAuth()
    assert.deepEqual(fs.disk, before)
  }
})

test("una variante cuya ancla ya no existe falla antes de compilar y no deja nada cambiado", () => {
  const fs = memoryFs({ "lib/db/client.ts": "  max: 4,\n", "lib/server-user.ts": "otro código\n", "proxy.ts": "const { data: { user }, error } = await supabase.auth.getUser()\n" })
  const before = new Map(fs.disk)
  assert.throws(() => applyVariant(ROOT, "sin-getuser", fs), /no encuentra su ancla en lib\/server-user\.ts/)
  assert.deepEqual(fs.disk, before)
  assert.throws(() => applyVariant(ROOT, "pool-9", fs), /Variante desconocida/)
  assert.equal(applyVariant(ROOT, "base", fs).call(), undefined, "base no toca ningún archivo.")
  assert.ok(Object.values(VARIANTS).every((variant) => typeof variant.factor === "string" && variant.factor.length > 0))
})

test("la tabla del experimento solo lleva cifras y nombres de escenario", () => {
  const pass = { escenario: "dashboard", concurrencia: 10, accionMs: { n: 15, p50: 500, p95: 600 }, authServidorMs: { n: 30, p50: 50, p95: 70 }, llamadasAuthPorPeticion: 2.04, sqlMs: null, pool: { maxTotal: 1 }, peticionesPorSegundo: 18, errores: 0 }
  const text = t4Table({ concurrencia: [1, 5, 10], variantes: [{ nombre: "base", acciones: [pass], paginaPublica: { 1: { n: 60, p50: 20, p95: 30 } } }], authInicio: { 1: { n: 30, p50: 40, p95: 50 } } })
  assert.match(text, /\| base \| dashboard \| 10 \| 500 \/ 600 \|/)
  assert.match(text, /GET \/login/)
  assert.ok(!/eyJ|password|access_token|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text))
})

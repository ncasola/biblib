import assert from "node:assert/strict"
import { test } from "node:test"
import { BACKUP_ASSET_PROVIDERS, classifyCoverAssets, COVERS_BUCKET, excludedCoverKeys, KEY_ONLY_TABLES, verifyCoverObjects } from "../../scripts/lib/backup-db.mjs"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"
import { classifyDestination } from "../../scripts/db/restore-local.mjs"
import { compareRestored } from "../../scripts/db/restore-verify.mjs"
import { parseArgs, purgeBatch } from "../../scripts/jobs/purge-cover-assets.mjs"
import { parseArgs as parseAssetsGroupArgs } from "../integration/assets/run.mjs"

// U-DAT-10 · Sin Docker: el respaldo administrativo separa el manifiesto de portadas con sus hashes,
// excluye lo que la política no permite respaldar, el restore admite el bucket vacío de 0009 y la
// verificación compara las portadas por su manifiesto. La purga administrativa solo devuelve cantidades.

const owner = "11111111-1111-4111-8111-111111111111"
const asset = (id, extra = {}) => ({ id, owner, key: `${owner}/${id}/7.webp`, sha256: "a".repeat(64), bytes: 10, state: "ready", sourceKind: "upload", provider: "upload", ...extra })
const A1 = "22222222-2222-4222-8222-222222222221"
const A2 = "22222222-2222-4222-8222-222222222222"
const A3 = "22222222-2222-4222-8222-222222222223"

test("respaldo: entran las subidas propias; las copias de proveedores sin backupAsset y Google no", () => {
  assert.deepEqual(BACKUP_ASSET_PROVIDERS, [], "ninguna política publicada permite respaldar copias de proveedores")
  const assets = classifyCoverAssets([asset(A1), asset(A2, { sourceKind: "provider", provider: "open-library" }), asset(A3, { sourceKind: "provider", provider: "google-books" })])
  assert.equal(assets.bucket, COVERS_BUCKET)
  assert.deepEqual(assets.items.map((item) => [item.id, item.included, item.reason]), [[A1, true, undefined], [A2, false, "policy"], [A3, false, "google"]])
  assert.deepEqual(assets.excluded, [A2, A3])
  assert.deepEqual([...excludedCoverKeys(assets)], [`${owner}/${A2}/7.webp`, `${owner}/${A3}/7.webp`])
  // Una política futura que lo permita para Open Library nunca incluye a Google.
  const allowed = classifyCoverAssets([asset(A2, { sourceKind: "provider", provider: "open-library" }), asset(A3, { sourceKind: "provider", provider: "google-books" })], { providers: ["open-library", "google-books"] })
  assert.deepEqual(allowed.items.map((item) => item.included), [true, false])
  assert.equal(classifyCoverAssets(null), null, "heads anteriores a 0009 no tienen manifiesto de portadas")
})

test("respaldo: cada objeto copiado coincide en sha256 y tamaño con su asset", () => {
  const assets = classifyCoverAssets([asset(A1), asset(A2, { state: "quarantine", key: null, sha256: null, bytes: null })])
  const object = { bucket: COVERS_BUCKET, name: `${owner}/${A1}/7.webp`, sha256: "a".repeat(64), size: 10 }
  assert.deepEqual(verifyCoverObjects(assets, [object]), [])
  assert.equal(verifyCoverObjects(assets, []).length, 1, "falta el objeto")
  assert.equal(verifyCoverObjects(assets, [{ ...object, sha256: "b".repeat(64) }]).length, 1, "otro hash")
  assert.equal(verifyCoverObjects(assets, [{ ...object, size: 11 }]).length, 1, "otro tamaño")
  assert.deepEqual(KEY_ONLY_TABLES, ["biblib.cover_assets"])
})

test("restore: el bucket de portadas vacío de 0009 no es un dato ajeno; un objeto en él sí", () => {
  const census = { censusId: "censo", accounts: [] }
  const base = { users: [], books: [], shelves: [], otherRows: [], buckets: [{ id: "biblib-test-assets" }, { id: COVERS_BUCKET }], objects: [] }
  assert.equal(classifyDestination(base, census).fresh, true)
  assert.equal(classifyDestination({ ...base, objects: [{ bucket: COVERS_BUCKET, name: `${owner}/${A1}/7.webp` }] }, census).fresh, false)
  assert.equal(classifyDestination({ ...base, buckets: [...base.buckets, { id: "otro" }] }, census).fresh, false)
})

test("verificación: portadas por su manifiesto (claves, hash, tamaño, dueño y estado en revisión) y exclusiones", () => {
  const facts = { tables: [] }
  const digest = (schema, table, count, keys = "k", content = "c") => ({ schema, table, count, keys, content })
  const items = [{ ...asset(A1), included: true }, { ...asset(A2, { sourceKind: "provider", provider: "open-library" }), included: false, reason: "policy" }]
  const manifest = {
    migrations: { head: "0009_cover_assets", applied: [] }, objects: { hash: "h", facts }, tokens: {}, sample: [],
    digests: [digest("biblib", "cover_assets", 2, "k1", "c1"), digest("storage", "objects", 3, "k2")],
    assets: { bucket: COVERS_BUCKET, providers: [], items, excluded: [A2] },
  }
  const current = (assets, digests = [digest("biblib", "cover_assets", 1, "otra", "otro"), digest("storage", "objects", 2, "otra")]) => ({
    ledger: [], inspection: { code: EXIT.OK, manifest: [{ status: "ok" }] }, objects: { hash: "h", facts }, tokens: {}, sample: [], digests, assets,
  })
  const failing = (checks) => checks.filter((check) => check.status !== "ok").map((check) => check.id)
  assert.deepEqual(failing(compareRestored(manifest, current([{ ...asset(A1), state: "restored" }]))), [], "en revisión, sin el excluido y con un objeto menos")
  assert.deepEqual(failing(compareRestored(manifest, current([{ ...asset(A1), state: "restored", sha256: "b".repeat(64) }]))), ["assets.manifest"])
  assert.deepEqual(failing(compareRestored(manifest, current([{ ...asset(A1), state: "restored" }, { ...asset(A2), state: "restored" }]))), ["assets.manifest"], "un excluido no puede volver")
  assert.deepEqual(failing(compareRestored(manifest, current([]))), ["assets.manifest"])
  // Sin exclusiones, las claves deben ser idénticas aunque el contenido (estado) cambie.
  const plain = { ...manifest, assets: { ...manifest.assets, items: [items[0]], excluded: [] }, digests: [digest("biblib", "cover_assets", 1, "k1", "c1")] }
  assert.deepEqual(failing(compareRestored(plain, current([{ ...asset(A1), state: "restored" }], [digest("biblib", "cover_assets", 1, "k1", "distinto")]))), [])
  assert.deepEqual(failing(compareRestored(plain, current([{ ...asset(A1), state: "restored" }], [digest("biblib", "cover_assets", 1, "otra", "distinto")]))), ["table.biblib.cover_assets"])
})

test("purga administrativa: argumentos acotados, filas antes que objetos y solo cantidades", async () => {
  assert.deepEqual(parseArgs([]), { profile: "main", limit: 200, graceSeconds: 86_400, json: false })
  assert.deepEqual(parseArgs(["--profile", "scratch", "--limit", "10", "--grace-seconds", "0", "--json"]), { profile: "scratch", limit: 10, graceSeconds: 0, json: true })
  for (const argv of [["--profile", "prod"], ["--limit", "0"], ["--limit", "1001"], ["--grace-seconds", "-1"], ["--url", "x"], ["--json", "--json"]]) assert.throws(() => parseArgs(argv), (error) => error.code === EXIT.INVALID_ARGS, argv.join(" "))
  const calls = []
  const sql = async (strings, ...values) => {
    const text = strings.join("?")
    calls.push(text.includes("candidates") ? "candidates" : "confirm")
    if (text.includes("candidates")) return [{ result: { assets: [{ id: A1, owner, key: `${owner}/${A1}/7.webp`, reason: "unreferenced" }, { id: A2, owner, key: null, reason: "quarantine" }], objects: [{ owner, key: `${owner}/${A3}/1.webp` }] } }]
    assert.deepEqual(values[0], [A1, A2])
    return [{ result: [`${owner}/${A1}/7.webp`] }]
  }
  const removed = []
  const report = await purgeBatch({ sql, storage: { remove: async (keys) => { calls.push("remove"); removed.push(...keys); return { data: keys, error: null } } }, limit: 10, graceSeconds: 0 })
  assert.deepEqual(calls, ["candidates", "confirm", "remove"])
  assert.deepEqual(removed, [`${owner}/${A1}/7.webp`, `${owner}/${A3}/1.webp`])
  assert.deepEqual(report, { candidates: 2, assets: 1, orphans: 1, objects: 2, failedObjects: 0, reasons: { quarantine: 1, license: 0, unreferenced: 1 } })
})

test("grupo assets: scratch o test explícitos", () => {
  assert.deepEqual(parseAssetsGroupArgs(["--profile", "scratch", "--reuse-build"]), { profile: "scratch", reuseBuild: true })
  assert.deepEqual(parseAssetsGroupArgs([]), { profile: "test", reuseBuild: false })
  for (const argv of [["--profile", "main"], ["--profile", "prod"], ["--otro"]]) assert.throws(() => parseAssetsGroupArgs(argv), (error) => error.code === EXIT.INVALID_ARGS)
})

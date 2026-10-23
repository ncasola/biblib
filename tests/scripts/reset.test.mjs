import assert from "node:assert/strict"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { createContext, runLocalStack } from "../../scripts/local-stack.mjs"
import { assertResetIdentity, buildResetPlan, mailpitInventory, parseResetArgs, runReset, validateResetBackup, validateResetPlan } from "../../scripts/db/reset-local.mjs"
import { sha256 } from "../../scripts/db/journal-guard.mjs"
import { computePlanHash, writePlan } from "../../scripts/db/plan.mjs"
import { resourceRecord } from "../../scripts/lib/docker.mjs"
import { localPath, removeLocalPath } from "../../scripts/lib/local-path.mjs"
import { readState, writeState } from "../../scripts/lib/state.mjs"

const repo = fileURLToPath(new URL("../../", import.meta.url))
const roots = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const clone = (value) => structuredClone(value)

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "biblib reset con espacios ")); roots.push(root)
  mkdirSync(path.join(root, "supabase"))
  for (const file of ["config.toml", "profiles.json"]) copyFileSync(path.join(repo, "supabase", file), path.join(root, "supabase", file))
  const calls = [], project = "biblib-scratch", network = `${project}-network`
  let afterMutation = () => {}, bootstrapCalls = 0
  const ctx = createContext("scratch", { root })
  const labels = { "com.supabase.cli.project": project }
  const resources = {
    containers: ["db", "kong", "auth", "storage", "inbucket"].map((name) => ({ id: `id-${name}`, name: `supabase_${name}_${project}`, status: "running", health: "healthy", labels, networks: { [network]: { NetworkID: "id-network" } }, mounts: [], ports: name === "db" ? { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55342" }] } : {} })),
    networks: [{ id: "id-network", name: network, labels: { "biblib.root": ctx.identity.label, "biblib.profile": "scratch" } }],
    volumes: ["db", "storage"].map((name) => ({ id: `supabase_${name}_${project}`, name: `supabase_${name}_${project}`, createdAt: "2026-10-23T10:00:00Z", labels })),
  }
  const foreign = { id: "holaerp-id", name: "supabase_db_holaerp", labels: { "com.supabase.cli.project": "holaerp" }, networks: { "holaerp-network": {} }, ports: {}, status: "running" }
  const all = () => ({ ...clone(resources), containers: [...clone(resources.containers), clone(foreign)] })
  const target = { target: "local", profile: "scratch", fingerprint: ctx.fingerprint, env: () => ({ SUPABASE_URL: "http://127.0.0.1:55341", SUPABASE_DB_URL: "postgres://postgres:postgres@127.0.0.1:55342/postgres" }) }
  const state = writeState(ctx, { resources: resourceRecord(resources) })
  const discarded = { counts: { domain: { books: 8, shelves: 6 }, auth: { users: 2, sessions: 0 }, storage: { objects: 1 }, mailpit: { messages: 1 } }, hash: "discarded-hash" }
  const deps = { root, skipDatabaseLock: true, createContext: () => ({ ...ctx, ...deps.context, loadTarget: () => target, run: async (_command, args) => {
    calls.push(args)
    const kind = args[0] === "container" ? "containers" : "volumes"
    if (args[1] === "stop") for (const c of resources.containers.filter((c) => args.includes(c.id))) c.status = "exited"
    else if (args[1] === "rm") resources[kind] = resources[kind].filter((r) => !args.includes(r.id))
    else throw new Error("Mutación inesperada")
    afterMutation(args)
    return { code: 0, stdout: "", stderr: "" }
  } }), context: {}, inventory: async () => all(), discardedState: async () => discarded,
  diagnose: async () => ({ code: 0, resources: clone(resources), state, all: all() }),
  bootstrap: async () => { bootstrapCalls++; return { code: 0, result: { checks: [], bootstrap: { status: "passed", phases: { verify: { verification: { manifest: true } } } } } } } }
  const plan = buildResetPlan(ctx, clone(resources), discarded)
  const file = writePlan(plan, "reset.json", root)
  const apply = { apply: true, plan: file, expectProject: project, expectPlan: plan.planHash, discardLocalData: true }
  return { root, ctx, resources, state, target, plan, file, apply, deps, calls, all, discarded, setAfterMutation: (fn) => { afterMutation = fn }, bootstrapCalls: () => bootstrapCalls }
}

test("reset solo admite plan, identidad y una autorización explícita; no reenvía flags", () => {
  assert.equal(parseResetArgs(["--dry-run", "--profile", "scratch", "--out", "reset.json"]).dryRun, true)
  for (const flag of ["--linked", "--all", "--db-url", "--force", "--no-seed"]) assert.throws(() => parseResetArgs(["--dry-run", "--profile", "scratch", "--out", "reset.json", flag]), { code: 2 })
  for (const args of [[], ["--apply"], ["--dry-run", "--apply"], ["--dry-run", "--out", "reset.json"], ["--apply", "--plan", "x", "--expect-project", "biblib-local", "--expect-plan", "a".repeat(64)]]) assert.throws(() => parseResetArgs(args), { code: 2 })
})

test("rechaza 5432, remoto y túnel antes de consultar datos o mutar Docker", async () => {
  for (const url of ["postgres://postgres:postgres@127.0.0.1:5432/postgres", "postgres://postgres:postgres@remote.example:55342/postgres"]) {
    const f = fixture(); f.target.env = () => ({ SUPABASE_URL: "http://127.0.0.1:55341", SUPABASE_DB_URL: url })
    let queried = false; f.deps.discardedState = async () => { queried = true }
    await assert.rejects(runReset(f.apply, f.deps), { code: 3 }); assert.equal(queried, false); assert.deepEqual(f.calls, [])
  }
  const f = fixture(); f.resources.containers[0].ports = {}
  await assert.rejects(runReset(f.apply, f.deps), { code: 3 }); assert.deepEqual(f.calls, [])
})

test("rechaza holaerp, raíz ajena, red ajena, marcador aislado y contenedor no registrado", () => {
  for (const alter of [
    (f) => { f.state.projectId = "holaerp" },
    (f) => { f.state.root = path.join(f.root, "otra") },
    (f) => { f.resources.networks[0].labels["biblib.root"] = "otra" },
    (f) => { f.resources.containers[0].labels = { "com.supabase.cli.project": "holaerp" } },
    (f) => { f.state.resources.containers = [] },
    (f) => { f.resources.containers.push({ ...clone(f.resources.containers[0]), id: "no-registrado" }) },
    (f) => { f.resources.containers[0].networks["red-ajena"] = {} },
    (f) => { f.resources.volumes[0].createdAt = "otro-volumen" },
  ]) {
    const f = fixture(); alter(f)
    assert.throws(() => assertResetIdentity(f.ctx, f.state, f.all(), f.target), { code: 3 })
    assert.deepEqual(f.calls, [])
  }
  const f = fixture()
  assert.throws(() => assertResetIdentity(f.ctx, null, f.all(), f.target), { code: 3 })
  const all = f.all(); all.containers.find((c) => c.id === "holaerp-id").mounts = [{ Name: f.resources.volumes[0].id }]
  assert.throws(() => assertResetIdentity(f.ctx, f.state, all, f.target), { code: 3 })
})

test("confirmación incorrecta, plan alterado, caducado o de otra raíz se rechazan", () => {
  const f = fixture()
  assert.throws(() => validateResetPlan(f.plan, f.ctx, { ...f.apply, expectProject: "holaerp" }), { code: 3 })
  const changed = { ...f.plan, scope: [] }
  assert.throws(() => validateResetPlan(changed, f.ctx, f.apply), { code: 6 })
  const expired = buildResetPlan(f.ctx, f.resources, f.discarded, new Date(Date.now() - 31 * 60 * 1000))
  assert.throws(() => validateResetPlan(expired, f.ctx, { ...f.apply, expectPlan: expired.planHash }), { code: 6 })
  const foreign = { ...f.plan, root: "C:/otro-root" }; foreign.planHash = computePlanHash(foreign)
  assert.throws(() => validateResetPlan(foreign, f.ctx, { ...f.apply, expectPlan: foreign.planHash }), { code: 3 })
  const main = createContext("main", { root: f.root })
  const mainPlan = buildResetPlan(main, f.resources, f.discarded)
  assert.throws(() => validateResetPlan(mainPlan, main, { expectProject: "biblib-scratch", expectPlan: mainPlan.planHash }), { code: 3 })
})

test("cambio de datos sin cambio de cantidades invalida el plan antes de parar", async () => {
  const f = fixture(); f.discarded.hash = "changed"
  // El plan en disco conserva la huella aprobada.
  await assert.rejects(runReset(f.apply, f.deps), { code: 6 })
  assert.deepEqual(f.calls, [])
})

test("huella Mailpit incluye mensajes fuera de la primera página y detecta inventario inestable", async () => {
  const f = fixture(), messages = [{ ID: "a", Subject: "ficticio" }, { ID: "b", Subject: "ficticio" }]
  f.ctx.fetch = async (url) => new Response(JSON.stringify({ total: 2, messages: [messages[Number(new URL(url).searchParams.get("start"))]] }))
  const first = await mailpitInventory(f.ctx)
  messages[1].Subject = "cambio en otra página"
  const second = await mailpitInventory(f.ctx)
  assert.equal(first.total, second.total); assert.notDeepEqual(first.hashes, second.hashes)
  assert.doesNotMatch(JSON.stringify(second), /ficticio|cambio/)
  f.ctx.fetch = async () => new Response(JSON.stringify({ total: 2, messages: [] }))
  await assert.rejects(mailpitInventory(f.ctx), { code: 8 })
})

test("rutas fuera de .biblib y junctions se rechazan sin eliminar el destino", () => {
  const f = fixture(); const outside = mkdtempSync(path.join(tmpdir(), "biblib fuera ")); roots.push(outside)
  const important = path.join(outside, "conservar.txt"); writeFileSync(important, "conservar")
  assert.throws(() => removeLocalPath(f.root, outside), { code: 3 })
  assert.throws(() => localPath(f.root, path.join(f.root, ".biblib")), { code: 3 })
  const link = path.join(f.root, ".biblib", "enlace")
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir")
  try { assert.throws(() => removeLocalPath(f.root, path.join(link, "conservar.txt")), { code: 3 }); assert.equal(readFileSync(important, "utf8"), "conservar") }
  finally { unlinkSync(link) }
  const own = path.join(f.root, ".biblib", "propio"); mkdirSync(own); writeFileSync(path.join(own, "x"), "x")
  removeLocalPath(f.root, own); assert.equal(existsSync(own), false)
})

test("recibo de respaldo acredita inventario completo, estado revisado y restauración", () => {
  const f = fixture()
  const artifact = path.join(f.root, ".biblib", "backup.dat"); writeFileSync(artifact, "datos ficticios")
  const file = path.join(f.root, ".biblib", "backup.json")
  const receipt = { schemaVersion: 1, backupId: "local-backup-1", fingerprint: f.ctx.fingerprint, discardedStateHash: f.plan.discarded.hash, createdAt: new Date().toISOString(), restoreVerification: { passed: true }, scope: ["domain", "auth", "storage", "mailpit", "ledger"], files: [{ path: artifact, sha256: sha256(readFileSync(artifact)) }] }
  writeFileSync(file, JSON.stringify(receipt))
  assert.equal(validateResetBackup(file, f.ctx, f.plan).backupId, receipt.backupId)
  for (const changed of [{ ...receipt, fingerprint: "other" }, { ...receipt, scope: ["domain"] }, { ...receipt, restoreVerification: { passed: false } }, { ...receipt, discardedStateHash: "old-state" }]) {
    writeFileSync(file, JSON.stringify(changed)); assert.throws(() => validateResetBackup(file, f.ctx, f.plan), { code: 6 })
  }
  writeFileSync(file, JSON.stringify(receipt)); writeFileSync(artifact, "archivo cambiado")
  assert.throws(() => validateResetBackup(file, f.ctx, f.plan), { code: 6 })
})

test("las rutas de limpieza se acreditan antes de cualquier operación destructiva", async () => {
  const f = fixture(), outside = mkdtempSync(path.join(tmpdir(), "biblib fixtures ajenos ")); roots.push(outside)
  const link = path.join(f.root, ".biblib", "fixtures")
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir")
  try { await assert.rejects(runReset(f.apply, f.deps), { code: 3 }); assert.deepEqual(f.calls, []) }
  finally { unlinkSync(link) }
})

test("reset interrumpido conserva fase, continúa por IDs restantes y verifica antes de éxito", async () => {
  const f = fixture(), controller = new AbortController()
  f.deps.context.signal = controller.signal
  f.setAfterMutation((args) => { if (args[1] === "rm") controller.abort() })
  await assert.rejects(runReset(f.apply, f.deps), { code: 130 })
  const receipt = readState(f.ctx, "-reset")
  assert.equal(receipt.status, "interrupted"); assert.equal(receipt.phases.destroy.status, "interrupted"); assert.equal(f.bootstrapCalls(), 0)
  f.deps.context.signal = undefined; f.setAfterMutation(() => {})
  const result = await runReset(f.apply, f.deps)
  assert.equal(result.code, 0); assert.equal(result.result.reset.status, "passed"); assert.equal(f.bootstrapCalls(), 1)
  assert.equal(readState(f.ctx, "-reset").status, "passed")
  assert.equal(f.resources.volumes.length, 0); assert.equal(f.resources.containers.length, 0); assert.equal(f.resources.networks.length, 1)
  assert.ok(f.calls.every((args) => !args.includes("holaerp-id") && !args.includes("--all") && !args.includes("--force")))
  await assert.rejects(runReset(f.apply, f.deps), { code: 6 })
})

test("un reemplazo de volumen entre interrupción y continuación se rechaza", async () => {
  const f = fixture(), controller = new AbortController(); f.deps.context.signal = controller.signal
  f.setAfterMutation((args) => { if (args[1] === "stop") controller.abort() })
  await assert.rejects(runReset(f.apply, f.deps), { code: 130 })
  f.deps.context.signal = undefined; f.resources.volumes[0].createdAt = "nueva-identidad"
  const before = f.calls.length
  await assert.rejects(runReset(f.apply, f.deps), { code: 3 })
  assert.equal(f.calls.length, before)
})

test("fallo de bootstrap nunca produce recibo de reset pasado", async () => {
  const f = fixture(); f.deps.bootstrap = async () => ({ code: 11, result: { bootstrap: { status: "failed" } } })
  await assert.rejects(runReset(f.apply, f.deps), { code: 11 })
  assert.equal(readState(f.ctx, "-reset").status, "failed")
  assert.equal(readState(f.ctx, "-reset").phase, "bootstrap")
})

test("[stack] plan scratch real acredita cantidades y no destruye", { skip: process.env.BIBLIB_SKIP_STACK_TESTS === "1" }, async (t) => {
  const ctx = createContext("scratch")
  const state = readState(ctx)
  if (!state || !state.resources.containers.length) return t.skip("scratch no está arrancado y acreditado")
  const result = await runLocalStack(["reset", "--dry-run", "--profile", "scratch", "--out", "test-reset-plan.json", "--json"])
  assert.equal(result.code, 0); assert.equal(result.result.plan.kind, "reset-local")
  assert.ok(result.result.plan.discarded.counts.auth.users >= 2)
  assert.equal(result.result.plan.postgres.port, 55342)
})

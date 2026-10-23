// Ensayo destructivo explícito: ejecutar solo con scratch reservado para esta unidad.
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createContext, runLocalStack } from "../../../../scripts/local-stack.mjs"
import { discardedState } from "../../../../scripts/db/reset-local.mjs"
import { docker, inventory, selectResources } from "../../../../scripts/lib/docker.mjs"
import { readState } from "../../../../scripts/lib/state.mjs"
import { canonical } from "../../../../scripts/db/plan.mjs"
import { sha256 } from "../../../../scripts/db/journal-guard.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const ctx = createContext("scratch")
const save = (name, value) => writeFileSync(path.join(here, name), `${JSON.stringify(value, null, 2)}\n`)
const command = async (args) => {
  const result = await runLocalStack(args)
  assert.equal(result.code, 0)
  return result
}
const makePlan = async (name) => {
  const result = await command(["reset", "--dry-run", "--profile", "scratch", "--out", name, "--json"])
  save(`${name}`, result.result.plan)
  return result.result.plan
}
const applyArgs = (name, plan) => ["reset", "--apply", "--plan", name, "--expect-project", "biblib-scratch", "--expect-plan", plan.planHash, "--discard-local-data", "--json"]
const snapshot = async () => {
  const target = ctx.loadTarget("local", { profile: "scratch", cwd: ctx.root })
  const discarded = await discardedState(ctx, target)
  const resources = selectResources(ctx, await inventory(ctx), readState(ctx))
  return { domain: discarded.tables.filter((t) => ["biblib", "drizzle", "storage"].includes(t.schema)), resources, counts: discarded.counts }
}

// Lista blanca sin variables, comandos ni logs del stack ajeno.
const holaerpSnapshot = async () => {
  const all = await inventory(ctx)
  const containers = all.containers.filter((c) => c.name.endsWith("_holaerp"))
  assert.ok(containers.some((c) => c.name === "supabase_db_holaerp" && c.status === "running"), "HolaERP debe estar en marcha antes del ensayo")
  const identities = await docker(ctx, ["container", "inspect", ...containers.map((c) => c.id), "--format", '{"id":{{json .Id}},"name":{{json .Name}},"status":{{json .State.Status}},"startedAt":{{json .State.StartedAt}},"restarts":{{json .RestartCount}},"ports":{{json .NetworkSettings.Ports}},"networks":{{json .NetworkSettings.Networks}},"mounts":{{json .Mounts}}}'])
  const sorted = (records) => records.sort((a, b) => a.id.localeCompare(b.id))
  return { containers: sorted(identities.trim().split(/\r?\n/).map((line) => JSON.parse(line))), networks: sorted(all.networks.filter((n) => n.name.includes("holaerp"))), volumes: sorted(all.volumes.filter((v) => v.name.endsWith("_holaerp"))) }
}
const baseline = await holaerpSnapshot()
save("holaerp-reset-before.json", baseline)

try {
  await command(["up", "--profile", "scratch", "--json"])
  const first = await makePlan("o06-reset-first.json")
  const oldIds = first.resources.containers.map((c) => c.id)
  const applied = await command(applyArgs("o06-reset-first.json", first))
  save("reset-first-result.json", applied)
  save("reset-first-receipt.json", readState(ctx, "-reset"))
  const after = await snapshot()
  assert.equal(after.counts.ledger, 3)
  assert.equal(after.counts.auth.users, 2)
  assert.equal(after.counts.domain.books, 8)
  assert.equal(after.counts.storage.objects, 1)
  assert.ok(after.resources.containers.every((c) => !oldIds.includes(c.id)))
  assert.deepEqual(after.resources.networks.map((n) => n.id), first.resources.networks.map((n) => n.id))
  for (const volume of after.resources.volumes) assert.notEqual(volume.createdAt, first.resources.volumes.find((v) => v.id === volume.id).createdAt)
  save("physical-rebuild-proof.json", { counts: after.counts, allContainerIdsReplaced: true, allVolumeCreatedAtReplaced: true, networkIdPreserved: true })

  const second = await makePlan("o06-reset-interrupted.json")
  const args = applyArgs("o06-reset-interrupted.json", second)
  // Emite el evento SIGINT al handler real del CLI mientras Docker está en destroy.
  // Evita taskkill/SIGKILL (Windows no entrega señales POSIX a hijos sin consola).
  const moduleUrl = pathToFileURL(path.join(ctx.root, "scripts/local-stack.mjs")).href
  const receiptFile = path.join(ctx.root, ".biblib/state/scratch-reset.json")
  const source = `import { readFileSync } from 'node:fs'; import { main } from ${JSON.stringify(moduleUrl)};
    let sent = false; const timer = setInterval(() => { try { const r = JSON.parse(readFileSync(${JSON.stringify(receiptFile)}, 'utf8')); if (!sent && r.planHash === ${JSON.stringify(second.planHash)} && r.phase === 'destroy' && r.status === 'running') { sent = true; process.emit('SIGINT'); } } catch {} }, 10);
    try { process.exitCode = await main(${JSON.stringify(args)}); } finally { clearInterval(timer); }`
  const interrupted = await ctx.run(process.execPath, ["--input-type=module", "-e", source], { ...ctx.processOptions, timeoutMs: 180000 })
  assert.equal(interrupted.code, 130)
  const receipt = readState(ctx, "-reset")
  assert.equal(receipt.status, "interrupted")
  assert.equal(receipt.phase, "destroy")
  save("reset-interrupted-receipt.json", receipt)
  save("sigint-proof.json", { method: "process.emit(SIGINT) al handler real en proceso hijo Windows", exitCode: interrupted.code, result: JSON.parse(interrupted.stdout.trim()), phase: receipt.phase, noSuccess: receipt.status !== "passed" })
  const resumed = await command(args)
  assert.equal(resumed.result.reset.resumed, true)
  save("reset-resumed-result.json", resumed)
  save("reset-resumed-receipt.json", readState(ctx, "-reset"))

  const beforeBootstrap = await snapshot()
  const bootstrap1 = await command(["bootstrap", "--profile", "scratch", "--json"])
  const middleBootstrap = await snapshot()
  const bootstrap2 = await command(["bootstrap", "--profile", "scratch", "--json"])
  const afterBootstrap = await snapshot()
  assert.equal(bootstrap1.result.bootstrap.phases.seed.unchanged, true)
  assert.equal(bootstrap2.result.bootstrap.phases.seed.unchanged, true)
  assert.deepEqual(beforeBootstrap.domain, middleBootstrap.domain)
  assert.deepEqual(middleBootstrap.domain, afterBootstrap.domain)
  assert.deepEqual(beforeBootstrap.resources, afterBootstrap.resources)
  save("bootstrap-first-result.json", bootstrap1)
  save("bootstrap-second-result.json", bootstrap2)
  save("bootstrap-idempotence.json", { ledgerRows: afterBootstrap.counts.ledger, seedSkippedAfterVerification: true, domainLedgerStorageHashBefore: sha256(canonical(beforeBootstrap.domain)), domainLedgerStorageHashAfter: sha256(canonical(afterBootstrap.domain)), sameResources: true, includesBookVersions: true, authVerificationCreatesNormalSessionActivity: true })
  console.log("Ensayo scratch: reset completo, SIGINT/continuación y bootstrap repetido correctos.")
} finally {
  const down = await command(["down", "--profile", "scratch", "--json"])
  save("down-result.json", down)
  save("resources-left.json", readState(ctx).resources)
  const final = await holaerpSnapshot()
  save("holaerp-reset-after.json", final)
  assert.deepEqual(final, baseline)
  save("holaerp-comparison.json", { containers: baseline.containers.length, sameIdsStartedAtRestartsStatusBindingsNetworksMounts: true, sameNetworks: true, sameVolumes: true, destructiveResetExecuted: true })
}

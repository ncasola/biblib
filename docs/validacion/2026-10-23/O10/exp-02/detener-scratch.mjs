// Recuperación local: solo para el worktree de U-EXP-02, después de terminar el intento Supabase.
// Sin --apply comprueba propiedad y registra el estado; no detiene contenedores.
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { getProfile, rootFingerprint } from "../../../../../scripts/lib/profiles.mjs"
import { inventory, selectResources, assertOwnership, docker } from "../../../../../scripts/lib/docker.mjs"
import { readState, acquireLock } from "../../../../../scripts/lib/state.mjs"
import { BiblibError, EXIT } from "../../../../../scripts/lib/exit-codes.mjs"

const execute = promisify(execFile)
const root = path.resolve("C:/Users/ncaso/orca/workspaces/biblib/u-inf-03")
const expectedFingerprint = "ea260283d87954c1c405cb5ee4875867dd8b103c86084460f3a74244e06b13fa"
const file = path.join(root, "docs/validacion/2026-10-23/O10/exp-02/parada-acreditada.json")
const report = { profile: "scratch", apply: process.argv.includes("--apply"), stopped: false }
let release
try {
  if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new BiblibError(EXIT.INVALID_ARGS, "argumentos", "Solo se admite --apply.")
  if (path.resolve(process.cwd()).toLowerCase() !== root.toLowerCase()) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "identidad", "Este ensayo solo corresponde al worktree asignado.")
  const ctx = {
    root, profile: { ...getProfile("scratch", { root }), name: "scratch" }, identity: rootFingerprint({ root }), fingerprint: expectedFingerprint,
    processOptions: { cwd: root },
    async run(command, args, options = {}) {
      try {
        const result = await execute(command, args, { cwd: root, windowsHide: true, encoding: "utf8", timeout: options.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 })
        return { code: 0, stdout: result.stdout, stderr: "" }
      } catch (error) { return { code: typeof error.code === "number" ? error.code : EXIT.SERVICE_UNAVAILABLE, stdout: "", stderr: "" } }
    },
  }
  if (ctx.profile.projectId !== "biblib-scratch" || ctx.profile.network !== "biblib-scratch-network") throw new BiblibError(EXIT.IDENTITY_MISMATCH, "identidad", "El perfil ya no corresponde al proyecto registrado.")
  if (!readState(ctx)) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "identidad", "No existe registro de propiedad de scratch.")
  release = acquireLock(ctx)
  const state = readState(ctx)
  const before = selectResources(ctx, await inventory(ctx), state)
  assertOwnership(ctx, before, state)
  report.ownershipVerified = true
  report.before = before.containers.map(({ id, name, status, health }) => ({ id, name, status, health }))
  const alive = new Set(["running", "restarting", "paused"])
  const ids = before.containers.filter((container) => alive.has(container.status)).map((container) => container.id)
  if (report.apply && ids.length) await docker(ctx, ["stop", "-t", "10", ...ids], { timeoutMs: 180_000 })
  const after = selectResources(ctx, await inventory(ctx), state)
  assertOwnership(ctx, after, state)
  report.after = after.containers.map(({ id, name, status, health }) => ({ id, name, status, health }))
  report.volumes = after.volumes.map(({ id, name, createdAt }) => ({ id, name, createdAt }))
  report.networks = after.networks.map(({ id, name }) => ({ id, name }))
  report.stopped = !after.containers.some((container) => alive.has(container.status))
  report.code = report.apply && !report.stopped ? EXIT.VERIFICATION_FAILED : EXIT.OK
} catch (error) {
  report.code = error instanceof BiblibError ? error.code : EXIT.SERVICE_UNAVAILABLE
  report.message = error instanceof BiblibError ? error.message : "No se pudo acreditar la operación local."
} finally {
  release?.()
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report))
  process.exitCode = report.code
}

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, writeFile } from "node:fs/promises"

const run = promisify(execFile)
const base = new URL("./", import.meta.url)
const before = JSON.parse((await readFile(new URL("holaerp-antes.json", base), "utf8")).replace(/^\uFEFF/, ""))
const template = '{{json .Id}}|{{json .Name}}|{{json .State.StartedAt}}|{{json .RestartCount}}|{{json .HostConfig.PortBindings}}|{{json .Mounts}}|{{json .NetworkSettings.Networks}}'
const report = { observedAt: new Date().toISOString(), holaerp: null, scratch: null }
try {
  const { stdout } = await run("docker", ["inspect", "--format", template, ...before.map((entry) => entry.id)], { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 })
  const after = stdout.trim().split(/\r?\n/).map((line) => {
    const [id, name, started, restarts, ports, mounts, networks] = line.split("|").map((part) => JSON.parse(part))
    return { id, name, started, restarts, ports, mounts, networks }
  })
  const same = before.length === after.length && before.every((entry) => JSON.stringify(entry) === JSON.stringify(after.find((other) => other.id === entry.id)))
  report.holaerp = { verified: true, identical: same, after }
} catch {
  report.holaerp = { verified: false, reason: "Docker no pudo completar la consulta de metadatos en 60 segundos; no se acredita identidad final." }
}
try {
  const { stdout } = await run("docker", ["ps", "-a", "--filter", "name=biblib-scratch", "--format", "{{json .ID}}|{{json .Names}}|{{json .Status}}|{{json .Networks}}|{{json .Mounts}}"], { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 })
  report.scratch = { verified: true, containers: stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, name, status, networks, mounts] = line.split("|").map((part) => JSON.parse(part))
    return { id, name, status, networks, mounts }
  }) }
} catch {
  report.scratch = { verified: false, reason: "Docker no pudo completar el inventario del perfil; la parada no está acreditada." }
}
await writeFile(new URL("inventario-final.json", base), `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ holaerpVerified: report.holaerp.verified, holaerpIdentical: report.holaerp.identical ?? null, scratchVerified: report.scratch.verified })}\n`)

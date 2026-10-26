import { createConnection } from "node:net"
import { BiblibError, EXIT } from "./exit-codes.mjs"

const lines = (text) => text.trim().split(/\r?\n/).filter(Boolean)
const records = (text) => lines(text).map((line) => JSON.parse(line))
const projectLabel = (labels, project) => labels?.["com.supabase.cli.project"] === project || labels?.["com.docker.compose.project"] === project
const biblibLabel = (labels, ctx) => labels?.["biblib.profile"] === ctx.profile.name
const named = (name, ctx) => name?.startsWith("supabase_") && name.endsWith(`_${ctx.profile.projectId}`)

export async function docker(ctx, args, options = {}) {
  const result = await ctx.run("docker", args, { ...ctx.processOptions, privateCapture: true, ...options })
  if (result.code !== 0) throw new BiblibError(EXIT.SERVICE_UNAVAILABLE, "docker", "Docker no pudo completar la consulta u operación del perfil.")
  return result.stdout
}

// Windows limita la línea de comandos (~32 KiB): con cientos de volúmenes un solo `inspect` falla con
// «Argument list too long». Se inspecciona por lotes; los lotes son secuenciales para no saturar el motor.
const INSPECT_BATCH = 64
async function inspectAll(ctx, kind, names, format) {
  const result = []
  for (let i = 0; i < names.length; i += INSPECT_BATCH) {
    result.push(...records(await docker(ctx, [kind, "inspect", ...names.slice(i, i + INSPECT_BATCH), "--format", format])))
  }
  return result
}

// Lista blanca de campos: nunca se inspeccionan Config.Env, comandos ni logs.
export async function inventory(ctx) {
  const [containerIds, networkNames, volumeNames] = await Promise.all([
    docker(ctx, ["container", "ls", "-aq", "--no-trunc"]),
    docker(ctx, ["network", "ls", "--format", "{{.Name}}"]),
    docker(ctx, ["volume", "ls", "--format", "{{.Name}}"]),
  ])
  const [containers, networks, volumes] = await Promise.all([
    inspectAll(ctx, "container", lines(containerIds), '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Config.Labels}},"status":{{json .State.Status}},"health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}},"ports":{{json .NetworkSettings.Ports}},"networks":{{json .NetworkSettings.Networks}},"mounts":{{json .Mounts}}}'),
    inspectAll(ctx, "network", lines(networkNames), '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Labels}}}'),
    inspectAll(ctx, "volume", lines(volumeNames), '{"id":{{json .Name}},"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"labels":{{json .Labels}}}'),
  ])
  return { containers: containers.map((c) => ({ ...c, name: c.name.replace(/^\//, "") })), networks, volumes }
}

export function selectResources(ctx, all, state) {
  return {
    containers: all.containers.filter((r) => named(r.name, ctx) || projectLabel(r.labels, ctx.profile.projectId) || biblibLabel(r.labels, ctx) || state?.resources.containers.some((s) => s.id === r.id)),
    networks: all.networks.filter((r) => r.name === ctx.profile.network || projectLabel(r.labels, ctx.profile.projectId) || biblibLabel(r.labels, ctx) || state?.resources.network?.id === r.id),
    volumes: all.volumes.filter((r) => named(r.name, ctx) || projectLabel(r.labels, ctx.profile.projectId) || biblibLabel(r.labels, ctx) || state?.resources.volumes.some((s) => s.id === r.id)),
  }
}

export function assertOwnership(ctx, resources, state) {
  const mismatch = (r) => { throw new BiblibError(EXIT.IDENTITY_MISMATCH, "identidad", `Recurso ${r.name} con identidad ajena o sin registro de este checkout; no se ha modificado.`) }
  for (const network of resources.networks) {
    if (network.name !== ctx.profile.network || network.labels?.["biblib.profile"] !== ctx.profile.name || network.labels?.["biblib.root"] !== ctx.identity.label || (state?.resources.network && state.resources.network.id !== network.id)) mismatch(network)
  }
  for (const type of ["containers", "volumes"]) for (const r of resources[type]) {
    const record = state?.resources[type].find((s) => s.id === r.id)
    const labels = r.labels ?? {}
    if (!record || !projectLabel(labels, ctx.profile.projectId) || (labels["biblib.root"] && labels["biblib.root"] !== ctx.identity.label) || (labels["biblib.profile"] && labels["biblib.profile"] !== ctx.profile.name)) mismatch(r)
    if (type === "volumes" && record.createdAt !== r.createdAt) mismatch(r)
    if (type === "containers" && !r.networks?.[ctx.profile.network]) mismatch(r)
  }
}

export function resourceRecord(resources) {
  const reference = ({ id, name, createdAt }) => ({ id, name, ...(createdAt ? { createdAt } : {}) })
  return { network: resources.networks[0] ? reference(resources.networks[0]) : null, containers: resources.containers.map(reference), volumes: resources.volumes.map(reference) }
}

export function serviceStates(resources) {
  const names = { postgres: "db", auth: "auth", rest: "rest", storage: "storage", studio: "studio", mailpit: "inbucket" }
  return Object.entries(names).map(([name, prefix]) => {
    const container = resources.containers.find((c) => c.name.startsWith(`supabase_${prefix}_`))
    return { name, status: !container ? "stopped" : container.status !== "running" ? container.status : container.health ?? "running" }
  })
}

export async function portListening(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const finish = (value) => { socket.destroy(); resolve(value) }
    socket.setTimeout(400)
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.once("timeout", () => finish(false))
  })
}

export async function probePorts(ctx, resources) {
  const own = new Set(resources.containers.flatMap((c) => Object.values(c.ports ?? {}).flatMap((bindings) => (bindings ?? []).map((b) => Number(b.HostPort)))))
  const result = []
  const tool = ctx.platform === "win32" ? ["netstat", ["-ano", "-p", "tcp"]] : ["ss", ["-ltnp"]]
  let owners = ""
  try { owners = (await ctx.run(tool[0], tool[1], ctx.processOptions)).stdout } catch { /* El diagnóstico de ocupación sigue siendo útil sin PID. */ }
  for (const [name, port] of Object.entries({ ...ctx.profile.ports, app: ctx.profile.app.port })) {
    if (own.has(port)) continue
    if (await ctx.portListening(port, "127.0.0.1") || await ctx.portListening(port, "::1")) {
      const line = lines(owners).find((l) => new RegExp(`[:.]${port}\\s`).test(l) && /LISTEN|ESCUCHANDO/i.test(l))
      const pid = ctx.platform === "win32" ? line?.trim().split(/\s+/).at(-1) : /pid=(\d+)/.exec(line ?? "")?.[1]
      result.push({ id: `port.${name}`, status: "fail", code: EXIT.SERVICE_UNAVAILABLE, message: `Puerto ${port} ocupado por un proceso ajeno${pid && /^\d+$/.test(pid) ? ` (PID ${pid})` : " (PID no detectable)"}; no se ha detenido.` })
    }
  }
  return result
}

export async function excludedPorts(ctx) {
  if (ctx.platform !== "win32") return { id: "windows.excluded", status: "ok", message: "Rangos excluidos de Windows: no aplicable." }
  try {
    const result = await ctx.run("netsh", ["interface", "ipv4", "show", "excludedportrange", "protocol=tcp"], ctx.processOptions)
    if (result.code !== 0) throw new Error()
    const ranges = lines(result.stdout).map((l) => /^\s*(\d+)\s+(\d+)/.exec(l)).filter(Boolean).map((m) => [Number(m[1]), Number(m[2])])
    const collisions = Object.values({ ...ctx.profile.ports, app: ctx.profile.app.port }).filter((p) => ranges.some(([a, b]) => p >= a && p <= b))
    return { id: "windows.excluded", status: collisions.length ? "fail" : "ok", code: EXIT.MISSING_REQUIREMENT, message: collisions.length ? `Puertos excluidos por Windows: ${collisions.join(", ")}.` : "El perfil no coincide con rangos TCP excluidos de Windows." }
  } catch { return { id: "windows.excluded", status: "fail", code: EXIT.MISSING_REQUIREMENT, message: "No se pudieron consultar los rangos TCP excluidos de Windows." } }
}

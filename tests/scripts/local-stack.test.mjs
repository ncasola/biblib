import assert from "node:assert/strict"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { createContext, health, parseArgs, runLocalStack } from "../../scripts/local-stack.mjs"
import { BiblibError, EXIT } from "../../scripts/lib/exit-codes.mjs"
import { execute, pnpmCommand, sanitize, supabaseCommand } from "../../scripts/lib/process.mjs"
import { rootFingerprint } from "../../scripts/lib/profiles.mjs"
import { readState, writeState } from "../../scripts/lib/state.mjs"

const repo = fileURLToPath(new URL("../../", import.meta.url))
const roots = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

function fixture(platform = "linux", profile = "scratch") {
  const root = mkdtempSync(path.join(tmpdir(), "biblib lifecycle con espacios "))
  roots.push(root)
  mkdirSync(path.join(root, "supabase"))
  for (const file of ["config.toml", "profiles.json"]) copyFileSync(path.join(repo, "supabase", file), path.join(root, "supabase", file))
  copyFileSync(path.join(repo, "package.json"), path.join(root, "package.json"))
  const project = profile === "main" ? "biblib-local" : "biblib-scratch"
  const network = `${project}-network`
  const labels = { "com.supabase.cli.project": project }
  const data = { containers: [], networks: [], volumes: [] }
  const calls = []
  let starts = 0, healthy = true, failStart = false, onStart = () => {}, dockerMissing = false, excluded = "", occupied = false
  const clone = (value) => JSON.parse(JSON.stringify(value))
  const result = (stdout = "", code = 0) => ({ code, stdout, stderr: "" })
  const container = (prefix) => ({ id: `${prefix}-id-${starts}`, name: `supabase_${prefix}_${project}`, labels: { ...labels }, status: "running", health: "healthy", ports: prefix === "kong" ? { "8000/tcp": [{ HostIp: "0.0.0.0", HostPort: profile === "main" ? "55321" : "55341" }] } : {}, networks: { [network]: {} }, mounts: [] })
  const run = async (command, args, options) => {
    calls.push({ command, args, options })
    if (command === "netstat" || command === "ss") return result("TCP 127.0.0.1:55349 0.0.0.0:0 LISTENING 99999")
    if (command === "netsh") return result(excluded)
    if (command !== "docker") {
      if (args.includes("--version")) return result(args[0]?.includes("supabase") ? "2.117.0" : "10.32.1")
      if (args.includes("start")) {
        starts++
        if (!data.containers.length) data.containers = ["db", "auth", "rest", "storage", "studio", "inbucket", "kong"].map(container)
        if (!data.volumes.length) data.volumes = ["db", "storage"].map((name) => ({ id: `supabase_${name}_${project}`, name: `supabase_${name}_${project}`, createdAt: "2026-10-23T10:00:00Z", labels: { ...labels } }))
        onStart()
        return result('service_role=never-print postgres://user:pass@remote/db eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature', failStart ? 1 : 0)
      }
      if (args.includes("stop")) { data.containers = []; return result() }
      throw new Error("Invocación CLI no prevista")
    }
    if (args[0] === "version") return result("29.4.3", dockerMissing ? 1 : 0)
    const kind = args[0] === "container" ? "containers" : args[0] === "network" ? "networks" : "volumes"
    if (args[1] === "ls") return result(data[kind].map((r) => kind === "containers" ? r.id : r.name).join("\n"))
    if (args[1] === "inspect") return result(data[kind].filter((r) => args.includes(r.id) || args.includes(r.name)).map((r) => JSON.stringify(r)).join("\n"))
    if (args[1] === "create") {
      data.networks.push({ id: "network-id", name: network, labels: { "biblib.profile": profile, "biblib.root": rootFingerprint({ root }).label } })
      return result("network-id")
    }
    if (args[1] === "rm") { data[kind] = data[kind].filter((r) => !args.includes(r.id)); return result() }
    throw new Error("Invocación Docker no prevista")
  }
  return {
    root, data, calls, clone, container,
    options: { root, run, platform, nodeVersion: "24.11.1", portListening: async () => occupied, health: async (_ctx, resources) => healthy && resources.containers.length >= 7, healthTimeoutMs: 0,
      // Runner U-INF-04 simulado: estas pruebas no abren conexiones Postgres.
      readHead: async () => null, migrateLocal: async () => ({ head: { tag: "0002_book_versions", applied: 3, expected: 3, state: "up-to-date" }, result: "aplicado: 0000_biblib_init → 0001_library_integrity → 0002_book_versions" }), seedLocal: async () => ({ censusId: "biblib-local-v1" }), verifyLocal: async (_ctx, opts) => { if (opts?.sessions === false) throw new BiblibError(EXIT.VERIFICATION_FAILED, "verify", "Sin seed."); return { manifest: true } } },
    setHealthy: (value) => { healthy = value }, setFailStart: () => { failStart = true }, setOnStart: (fn) => { onStart = fn }, setDockerMissing: (value = true) => { dockerMissing = value }, setExcluded: (value) => { excluded = value }, setOccupied: () => { occupied = true }, starts: () => starts,
  }
}

test("argumentos cerrados y perfiles explícitos", () => {
  assert.deepEqual(parseArgs(["doctor", "--profile", "scratch", "--json"]), { command: "doctor", profile: "scratch", json: true })
  for (const args of [["reset"], ["up", "--all"], ["up", "--profile", "other"], ["up", "--json", "--json"], ["up", "--db-url", "remote"]]) assert.throws(() => parseArgs(args), { code: EXIT.INVALID_ARGS })
})

test("doctor es de solo lectura sin generar estado ni ejecutar start/status", async () => {
  const f = fixture()
  const before = readdirSync(f.root)
  const response = await runLocalStack(["doctor", "--profile", "scratch"], f.options)
  assert.equal(response.code, 0)
  assert.deepEqual(readdirSync(f.root), before)
  assert.equal(existsSync(path.join(f.root, ".biblib")), false)
  assert.ok(f.calls.every((c) => !c.args.some((a) => ["start", "stop", "create", "rm", "status"].includes(a))))
  f.setDockerMissing()
  assert.equal((await runLocalStack(["doctor", "--profile", "scratch"], f.options)).code, EXIT.MISSING_REQUIREMENT)
})

test("status proyecta contrato estable sin claves ni URLs con credenciales", async () => {
  const f = fixture()
  await runLocalStack(["up", "--profile", "scratch"], f.options)
  const stateBefore = readFileSync(path.join(f.root, ".biblib/state/scratch.json"), "utf8")
  const { result, code } = await runLocalStack(["status", "--profile", "scratch", "--json"], f.options)
  assert.equal(code, 0)
  assert.deepEqual(Object.keys(result), ["schemaVersion", "target", "profile", "fingerprint", "endpoints", "services", "head", "checks"])
  assert.equal(result.head, null)
  assert.equal(result.services.length, 6)
  const text = JSON.stringify(result)
  assert.doesNotMatch(text, /eyJ[\w-]+\.[\w-]+\.[\w-]+|postgres(?:ql)?:\/\/[^:]+:[^@]+@|service_role|never-print/i)
  assert.equal(readFileSync(path.join(f.root, ".biblib/state/scratch.json"), "utf8"), stateBefore)
  assert.ok(result.checks.some((c) => c.id === "bindings.loopback" && c.status === "warn" && /A\/B/.test(c.message)))
})

for (const platform of ["linux", "win32"]) test(`up idempotente y down conserva volúmenes (${platform}, rutas con espacios)`, async () => {
  const f = fixture(platform)
  await runLocalStack(["up", "--profile", "scratch"], f.options)
  const before = f.clone(f.data)
  await runLocalStack(["up", "--profile", "scratch"], f.options)
  assert.equal(f.starts(), 1)
  assert.deepEqual(f.data, before)
  await runLocalStack(["down", "--profile", "scratch"], f.options)
  assert.deepEqual(f.data.volumes, before.volumes)
  await runLocalStack(["up", "--profile", "scratch"], f.options)
  assert.deepEqual(f.data.volumes, before.volumes)
  const calls = f.calls.filter((c) => c.args[0]?.includes("supabase.js"))
  assert.ok(calls.every((c) => c.command === process.execPath && c.args.includes(path.join(f.root, ".biblib/stacks/scratch")) && c.args.includes("biblib-scratch-network")))
  assert.ok(f.calls.every((c) => !c.args.some((a) => ["--all", "--no-backup", "--ignore-health-check", "prune"].includes(a))))
})

test("rechaza identidad ajena en red, contenedor, volumen y registro", async () => {
  for (const kind of ["network", "container", "volume", "state"]) {
    const f = fixture()
    if (kind === "network") f.data.networks.push({ id: "foreign", name: "biblib-scratch-network", labels: { "biblib.profile": "scratch", "biblib.root": "other-root" } })
    if (kind === "container") f.data.containers.push(f.container("db"))
    if (kind === "volume") f.data.volumes.push({ id: "supabase_db_biblib-scratch", name: "supabase_db_biblib-scratch", labels: { "com.supabase.cli.project": "biblib-scratch" } })
    if (kind === "state") {
      const ctx = createContext("scratch", f.options)
      writeState(ctx, { resources: { containers: [], volumes: [] } })
      const file = path.join(f.root, ".biblib/state/scratch.json")
      const state = JSON.parse(readFileSync(file, "utf8")); state.rootHash = "foreign"; writeFileSync(file, JSON.stringify(state))
    }
    await assert.rejects(runLocalStack(["up", "--profile", "scratch"], f.options), { code: EXIT.IDENTITY_MISMATCH })
    assert.equal(f.starts(), 0)
    assert.ok(!f.calls.some((c) => c.args.includes("rm")))
  }
})

test("puerto ajeno y rango excluido bloquean antes de crear y nunca matan al ocupante", async () => {
  const f = fixture("win32")
  f.setOccupied()
  const doctor = await runLocalStack(["doctor", "--profile", "scratch"], f.options)
  assert.equal(doctor.code, EXIT.SERVICE_UNAVAILABLE)
  assert.ok(doctor.result.checks.some((c) => /55349.*PID 99999/.test(c.message)))
  await assert.rejects(runLocalStack(["up", "--profile", "scratch"], f.options), { code: EXIT.SERVICE_UNAVAILABLE })
  assert.equal(f.starts(), 0)
  assert.ok(!f.calls.some((c) => c.args.includes("create") || c.command.includes("kill")))
  const g = fixture("win32"); g.setExcluded(" 55340 55349 *")
  await assert.rejects(runLocalStack(["up", "--profile", "scratch"], g.options), { code: EXIT.MISSING_REQUIREMENT })
})

test("fallo de salud conserva diagnóstico y no anuncia éxito", async () => {
  for (const failCli of [false, true]) {
    const f = fixture()
    f.setHealthy(false)
    if (failCli) f.setFailStart()
    await assert.rejects(runLocalStack(["up", "--profile", "scratch"], f.options), { code: EXIT.SERVICE_UNAVAILABLE })
    const state = readState(createContext("scratch", f.options))
    assert.equal(state.phase, "stack"); assert.equal(state.status, "failed")
    assert.ok(state.resources.containers.length > 0)
  }
})

test("SIGINT registra fase, elimina solo contenedores/red creados y conserva volúmenes", async () => {
  const f = fixture()
  const controller = new AbortController()
  f.options.signal = controller.signal
  f.data.containers.push({ id: "holaerp-id", name: "supabase_db_holaerp", labels: { "com.supabase.cli.project": "holaerp" }, ports: {}, networks: {}, status: "running" })
  const foreign = f.clone(f.data.containers[0])
  f.setOnStart(() => {
    // El CLI simulado crea recursos antes de recibir la interrupción.
    if (f.data.containers.length === 1) for (const prefix of ["db", "auth", "rest", "storage", "studio", "inbucket", "kong"]) f.data.containers.push(f.container(prefix))
    controller.abort()
    throw new BiblibError(EXIT.INTERRUPTED, "proceso", "Interrupción solicitada.")
  })
  await assert.rejects(runLocalStack(["up", "--profile", "scratch"], f.options), { code: EXIT.INTERRUPTED })
  assert.deepEqual(f.data.containers, [foreign])
  assert.equal(f.data.volumes.length, 2)
  assert.equal(f.data.networks.length, 0)
  const state = readState(createContext("scratch", f.options))
  assert.equal(state.status, "interrupted"); assert.equal(state.phase, "stack"); assert.equal(state.cleanup, "completed")
  assert.ok(f.calls.filter((c) => c.args.includes("rm")).every((c) => !c.args.includes("holaerp-id")))
})

test("bootstrap migra, siembra y verifica por completo y solo main escribe entorno", async () => {
  const f = fixture()
  let wrote = false, migrations = 0
  f.options.writeLocalEnvFile = () => { wrote = true }
  const migrateLocal = f.options.migrateLocal
  f.options.migrateLocal = async (ctx, options) => { migrations++; assert.equal(ctx.profile.name, "scratch"); assert.match(options.runId, /^[0-9a-f-]{36}$/); return migrateLocal(ctx, options) }
  const response = await runLocalStack(["bootstrap", "--profile", "scratch"], f.options)
  assert.equal(response.code, 0)
  assert.equal(migrations, 1)
  assert.equal(response.result.bootstrap.status, "passed")
  assert.equal(response.result.bootstrap.phase, "verify")
  assert.equal(response.result.head.tag, "0002_book_versions")
  assert.equal(wrote, false)
  const receipt = readState(createContext("scratch", f.options), "-bootstrap")
  assert.equal(receipt.phase, "verify")
  assert.match(receipt.phases.env.message, /Sin archivo/)
  for (const name of ["preflight", "env", "migrate"]) assert.equal(receipt.phases[name].status, "passed")
  assert.equal(receipt.phases.migrate.head.tag, "0002_book_versions")
  assert.equal(receipt.phases.stack.status, "healthy")
  assert.equal(receipt.phases.seed.status, "passed")
  assert.equal(receipt.phases.verify.status, "passed")
})

test("bootstrap propaga el código del runner y marca migrate como fallida", async () => {
  const f = fixture()
  f.options.migrateLocal = async () => { throw new BiblibError(EXIT.HISTORY_DIVERGED, "historial", "Adopción de historial necesaria.") }
  await assert.rejects(runLocalStack(["bootstrap", "--profile", "scratch"], f.options), { code: EXIT.HISTORY_DIVERGED })
  const receipt = readState(createContext("scratch", f.options), "-bootstrap")
  assert.equal(receipt.status, "failed")
  assert.equal(receipt.phases.migrate.status, "failed")
  assert.equal(receipt.phases.env.status, "passed")
  for (const name of ["seed", "verify"]) assert.equal(receipt.phases[name].status, "pending")
})

test("bootstrap repetido verifica los fixtures antes de omitir seed y propaga fallo verify", async () => {
  const f = fixture()
  let seeded = false, seeds = 0, failVerify = false
  f.options.seedLocal = async () => { seeded = true; seeds++; return { censusId: "biblib-local-v1" } }
  f.options.verifyLocal = async (_ctx, options) => {
    if (!seeded || failVerify && options.sessions !== false) throw new BiblibError(EXIT.VERIFICATION_FAILED, "verify", "Servicio de verificación fallido.")
    return { censusId: "biblib-local-v1", manifest: true }
  }
  await runLocalStack(["bootstrap", "--profile", "scratch"], f.options)
  await runLocalStack(["bootstrap", "--profile", "scratch"], f.options)
  assert.equal(seeds, 1)
  assert.equal(readState(createContext("scratch", f.options), "-bootstrap").phases.seed.unchanged, true)
  failVerify = true
  await assert.rejects(runLocalStack(["bootstrap", "--profile", "scratch"], f.options), { code: 11 })
  const receipt = readState(createContext("scratch", f.options), "-bootstrap")
  assert.equal(receipt.status, "failed"); assert.equal(receipt.phase, "verify"); assert.equal(receipt.phases.verify.status, "failed")
})

test("bootstrap propaga el fallo del seed y deja verify pendiente", async () => {
  const f = fixture()
  f.options.seedLocal = async () => { throw new BiblibError(EXIT.SEED_FAILED, "storage", "Fallo de fixture Storage.") }
  await assert.rejects(runLocalStack(["bootstrap", "--profile", "scratch"], f.options), { code: EXIT.SEED_FAILED })
  const receipt = readState(createContext("scratch", f.options), "-bootstrap")
  assert.equal(receipt.phase, "seed")
  assert.equal(receipt.phases.seed.status, "failed")
  assert.equal(receipt.phases.migrate.status, "passed")
  assert.equal(receipt.phases.verify.status, "pending")
})

test("status publica el head aplicado solo con Postgres propio en marcha", async () => {
  const f = fixture()
  let reads = 0
  f.options.readHead = async () => { reads++; return { tag: "0001_library_integrity", applied: 2, expected: 3, state: "pending" } }
  assert.equal((await runLocalStack(["status", "--profile", "scratch", "--json"], f.options)).result.head, null)
  assert.equal(reads, 0)
  await runLocalStack(["up", "--profile", "scratch"], f.options)
  const { result } = await runLocalStack(["status", "--profile", "scratch", "--json"], f.options)
  assert.deepEqual(result.head, { tag: "0001_library_integrity", applied: 2, expected: 3, state: "pending" })
  f.options.readHead = async () => { throw new Error("conexión rechazada") }
  const degraded = (await runLocalStack(["status", "--profile", "scratch", "--json"], f.options)).result
  assert.equal(degraded.head, null)
  assert.ok(degraded.checks.some((c) => c.id === "head" && c.status === "warn"))
  assert.equal((await runLocalStack(["doctor", "--profile", "scratch", "--json"], f.options)).result.head, null)
})

test("worktree rechaza main/test y bloqueo concurrente devuelve 7", async () => {
  const f = fixture()
  writeFileSync(path.join(f.root, ".git"), "gitdir: /example")
  for (const profile of ["main", "test"]) await assert.rejects(runLocalStack(["up", "--profile", profile], f.options), { code: EXIT.IDENTITY_MISMATCH })
  const dir = path.join(f.root, ".biblib/state"); mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "scratch-lock.json"), "{}")
  await assert.rejects(runLocalStack(["up", "--profile", "scratch"], f.options), { code: EXIT.LOCK_BUSY })
})

test("ejecutor sanea captura, usa argv con espacios y devuelve timeout/interrupción", async () => {
  assert.equal(supabaseCommand("/ruta con espacios").prefix[0], path.join("/ruta con espacios", "node_modules/supabase/dist/supabase.js"))
  assert.equal(pnpmCommand({ npm_execpath: "/pnpm con espacios/pnpm.cjs" }, "win32").args[0], "/pnpm con espacios/pnpm.cjs")
  const response = await execute(process.execPath, ["-e", "console.log(process.argv[1])", "un argumento con espacios"])
  assert.equal(response.stdout.trim(), "un argumento con espacios")
  assert.doesNotMatch(sanitize("postgres://user:pass@host/db service_role=secret eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature"), /user:pass|service_role|eyJ/)
  await assert.rejects(execute(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 50 }), { code: EXIT.SERVICE_UNAVAILABLE })
  const controller = new AbortController()
  const pending = execute(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(pending, { code: EXIT.INTERRUPTED })
})

test("salud exige Docker y endpoints locales, incluido Studio sin redirección", async () => {
  const f = fixture()
  await runLocalStack(["up", "--profile", "scratch"], f.options)
  const urls = []
  const ctx = createContext("scratch", { ...f.options, fetch: async (url, options) => { urls.push(url); assert.equal(options.redirect, "error"); return new Response("ok") } })
  assert.equal(await health(ctx, f.data), true)
  assert.ok(urls.includes("http://127.0.0.1:55343/project/default"))
  ctx.fetch = async () => new Response("fallo", { status: 503 })
  assert.equal(await health(ctx, f.data), false)
  f.data.containers[0].health = "unhealthy"
  assert.equal(await health(ctx, f.data), false)
})

test("SIGINT en preflight y fallo bootstrap se registran sin anunciar fases pasadas", async () => {
  const f = fixture()
  const controller = new AbortController()
  const run = f.options.run
  f.options.signal = controller.signal
  f.options.run = async (...args) => {
    if (args[1].includes("--version")) { controller.abort(); throw new BiblibError(EXIT.INTERRUPTED, "proceso", "Interrupción solicitada.") }
    return run(...args)
  }
  await assert.rejects(runLocalStack(["up", "--profile", "scratch"], f.options), { code: EXIT.INTERRUPTED })
  assert.equal(readState(createContext("scratch", f.options)).status, "interrupted")
  const g = fixture(); g.setOccupied()
  await assert.rejects(runLocalStack(["bootstrap", "--profile", "scratch"], g.options), { code: EXIT.SERVICE_UNAVAILABLE })
  const receipt = readState(createContext("scratch", g.options), "-bootstrap")
  assert.equal(receipt.status, "failed")
  assert.equal(receipt.phases.preflight.status, "failed")
  assert.equal(receipt.phases.stack.status, "pending")
})

test("bootstrap main delega la generación en los helpers existentes", async () => {
  const f = fixture("linux", "main")
  const target = { target: "local", profile: "main", cwd: f.root }
  let writes = 0
  f.options.loadTarget = (name, options) => { assert.equal(name, "local"); assert.deepEqual(options, { profile: "main", cwd: f.root }); return target }
  f.options.writeLocalEnvFile = (ctx) => { assert.equal(ctx, target); writes++ }
  assert.equal((await runLocalStack(["bootstrap", "--profile", "main"], f.options)).code, 0)
  assert.equal(writes, 1)
})

test("interrupción de un segundo intento conserva los recursos de la ejecución anterior", async () => {
  const f = fixture()
  await runLocalStack(["up", "--profile", "scratch"], f.options)
  const before = f.clone(f.data)
  const controller = new AbortController()
  f.options.signal = controller.signal
  f.setHealthy(false)
  f.setOnStart(() => {
    f.data.containers.push(f.container("aux"))
    controller.abort()
    throw new BiblibError(EXIT.INTERRUPTED, "proceso", "Interrupción solicitada.")
  })
  await assert.rejects(runLocalStack(["up", "--profile", "scratch"], f.options), { code: EXIT.INTERRUPTED })
  assert.deepEqual(f.data, before)
})

test("configuración generada alterada se rechaza antes de regenerarla", async () => {
  const f = fixture()
  await runLocalStack(["up", "--profile", "scratch"], f.options)
  const config = path.join(f.root, ".biblib/stacks/scratch/supabase/config.toml")
  const modified = readFileSync(config, "utf8").replace('project_id = "biblib-scratch"', 'project_id = "holaerp"')
  writeFileSync(config, modified)
  await assert.rejects(runLocalStack(["up", "--profile", "scratch"], f.options), { code: EXIT.IDENTITY_MISMATCH })
  assert.equal(readFileSync(config, "utf8"), modified)
  assert.equal(f.starts(), 1)
})

test("un cambio de identidad durante start nunca se acredita en el registro", async () => {
  const f = fixture()
  await runLocalStack(["up", "--profile", "scratch"], f.options)
  const before = readState(createContext("scratch", f.options))
  f.setHealthy(false)
  f.setOnStart(() => { f.data.volumes[0].createdAt = "2026-10-24T00:00:00Z" })
  await assert.rejects(runLocalStack(["up", "--profile", "scratch"], f.options), { code: EXIT.IDENTITY_MISMATCH })
  const after = readState(createContext("scratch", f.options))
  assert.deepEqual(after.resources, before.resources)
  assert.equal(after.status, "failed")
  assert.equal((await runLocalStack(["doctor", "--profile", "scratch"], f.options)).code, EXIT.IDENTITY_MISMATCH)
})

test("un binding nuevo fuera del bloque impide acreditar el arranque", async () => {
  const f = fixture()
  f.setOnStart(() => { f.data.containers.find((c) => c.name.startsWith("supabase_kong_")).ports["8000/tcp"][0].HostPort = "54321" })
  await assert.rejects(runLocalStack(["up", "--profile", "scratch"], f.options), { code: EXIT.IDENTITY_MISMATCH })
  assert.equal(readState(createContext("scratch", f.options)).resources.containers.length, 0)
})

test("Docker inaccesible no borra la identidad previamente registrada", async () => {
  const f = fixture()
  await runLocalStack(["up", "--profile", "scratch"], f.options)
  const before = readState(createContext("scratch", f.options))
  f.setDockerMissing()
  await assert.rejects(runLocalStack(["up", "--profile", "scratch"], f.options), { code: EXIT.MISSING_REQUIREMENT })
  assert.deepEqual(readState(createContext("scratch", f.options)).resources, before.resources)
  f.setDockerMissing(false)
  assert.equal((await runLocalStack(["doctor", "--profile", "scratch"], f.options)).code, 0)
})

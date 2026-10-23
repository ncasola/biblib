import { createHash, randomUUID } from "node:crypto"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { assertNoForeignEnvFiles, childEnv, loadTarget, writeLocalEnvFile } from "./db/environment.mjs"
import { BiblibError, EXIT } from "./lib/exit-codes.mjs"
import { checkPublishedBindings, generateProfileWorkdir, getProfile, loadProfiles, profileNetwork, profileWorkdir, renderProfileConfig, REPO_ROOT, rootFingerprint } from "./lib/profiles.mjs"
import { execute, pnpmCommand, sanitize, supabaseCommand } from "./lib/process.mjs"
import { assertOwnership, docker, excludedPorts, inventory, portListening, probePorts, resourceRecord, selectResources, serviceStates } from "./lib/docker.mjs"
import { acquireLock, readState, writeState } from "./lib/state.mjs"
import { parseResetArgs, runReset } from "./db/reset-local.mjs"

const PHASES = ["preflight", "stack", "env", "migrate", "seed", "verify"]
const emptyResources = () => ({ containers: [], networks: [], volumes: [] })
const sha = (value) => createHash("sha256").update(value).digest("hex")
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }

export function parseArgs(argv) {
  const [command, ...args] = argv
  if (command === "reset") return { command, ...parseResetArgs(args) }
  if (!["doctor", "status", "up", "down", "bootstrap"].includes(command)) fail(EXIT.INVALID_ARGS, "argumentos", "Uso: local-stack.mjs doctor|status|up|down|bootstrap [--profile main|test|scratch] [--json].")
  let profile = "main", json = false, selected = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json" && !json) json = true
    else if (args[i] === "--profile" && !selected && ["main", "test", "scratch"].includes(args[i + 1])) { profile = args[++i]; selected = true }
    else fail(EXIT.INVALID_ARGS, "argumentos", "Argumento no admitido; usa --profile main|test|scratch y --json, sin flags reenviados.")
  }
  return { command, profile, json }
}

export function createContext(profile, options = {}) {
  const root = path.resolve(options.root ?? REPO_ROOT)
  const definition = getProfile(profile, { root })
  const identity = rootFingerprint({ root })
  const fingerprint = sha(JSON.stringify({ target: "local", project: definition.projectId, host: "127.0.0.1", port: definition.ports.db, database: "postgres", profileRoot: `${identity.hash}/${profile}` }))
  const env = childEnv({ env: () => ({ BIBLIB_TARGET: "local", BIBLIB_PROFILE: profile, BIBLIB_CATALOGUE_MODE: "fixture" }) })
  return {
    root, profile: definition, identity, fingerprint, workdir: profileWorkdir(profile, { root }),
    run: options.run ?? execute, platform: options.platform ?? process.platform, nodeVersion: options.nodeVersion ?? process.versions.node,
    portListening: options.portListening ?? portListening, signal: options.signal,
    health: options.health ?? health, fetch: options.fetch ?? fetch, loadTarget: options.loadTarget ?? loadTarget, writeLocalEnvFile: options.writeLocalEnvFile ?? writeLocalEnvFile,
    processOptions: { cwd: root, env, signal: options.signal },
    healthTimeoutMs: options.healthTimeoutMs ?? 60000,
    // Runner U-INF-04 cargado bajo demanda: doctor/up/down no lo necesitan.
    readHead: options.readHead ?? (async (stack) => (await import("./db/migrate.mjs")).readAppliedHead(stack)),
    migrateLocal: options.migrateLocal ?? (async (stack, opts) => (await import("./db/migrate.mjs")).runLocalMigration(stack, opts)),
    seedLocal: options.seedLocal ?? (async (stack, opts) => (await import("./db/seed-local.mjs")).runSeed({ profile: stack.profile.name, root: stack.root, stack, lockHeld: true, ...opts })),
    verifyLocal: options.verifyLocal ?? (async (stack, opts) => (await import("./db/verify-local.mjs")).verifyLocal(stack, opts)),
  }
}

export async function cli(ctx, args, options = {}) {
  const bin = supabaseCommand(ctx.root)
  return ctx.run(bin.command, [...bin.prefix, ...args, "--workdir", ctx.workdir, "--network-id", ctx.profile.network], { ...ctx.processOptions, timeoutMs: 180000, ...options })
}

function assertLayout(ctx) {
  for (const file of [path.join(ctx.root, ".biblib"), path.join(ctx.root, ".biblib/stacks"), ctx.workdir, path.join(ctx.workdir, "supabase")]) {
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) fail(EXIT.IDENTITY_MISMATCH, "perfil", "El workdir no puede atravesar enlaces a otra raíz.")
  }
  const manifest = loadProfiles({ root: ctx.root })
  const rendered = renderProfileConfig(readFileSync(path.join(ctx.root, manifest.baseConfig), "utf8"), getProfile(manifest.baseProfile, { root: ctx.root }), ctx.profile)
  const configPath = path.join(ctx.workdir, "supabase/config.toml")
  if (existsSync(configPath)) {
    const metadataPath = path.join(ctx.workdir, "profile.json")
    if (lstatSync(configPath).isSymbolicLink() || !existsSync(metadataPath) || lstatSync(metadataPath).isSymbolicLink()) fail(EXIT.IDENTITY_MISMATCH, "perfil", "El workdir carece de metadatos propios válidos.")
    let metadata
    try { metadata = JSON.parse(readFileSync(metadataPath, "utf8")) } catch { fail(EXIT.IDENTITY_MISMATCH, "perfil", "Metadatos del workdir dañados.") }
    const contents = readFileSync(configPath, "utf8")
    const body = contents.split(/\r?\n/).slice(2).join(contents.includes("\r\n") ? "\r\n" : "\n")
    if (metadata.rootHash !== ctx.identity.hash || metadata.projectId !== ctx.profile.projectId || metadata.configSha256 !== sha(contents) || body !== rendered) fail(EXIT.IDENTITY_MISMATCH, "perfil", "La configuración generada no corresponde a esta raíz/perfil o al manifiesto vigente.")
  }
}

async function versions(ctx) {
  const pkg = JSON.parse(readFileSync(path.join(ctx.root, "package.json"), "utf8"))
  const node = ctx.nodeVersion.split(".").map(Number)
  const checks = [{ id: "version.node", status: node[0] === 24 && (node[1] > 11 || node[1] === 11 && node[2] >= 1) ? "ok" : "fail", code: EXIT.MISSING_REQUIREMENT, message: `Node esperado ${pkg.engines.node}; instalado ${ctx.nodeVersion}.` }]
  const pnpm = pnpmCommand(ctx.processOptions.env, ctx.platform)
  for (const [id, expected, invoke] of [
    ["pnpm", pkg.packageManager.replace("pnpm@", ""), () => ctx.run(pnpm.command, pnpm.args, ctx.processOptions)],
    ["supabase", pkg.devDependencies.supabase, () => cli(ctx, ["--version"], { timeoutMs: 15000 })],
  ]) {
    try {
      const response = await invoke()
      const installed = /^\d+\.\d+\.\d+$/.test(response.stdout.trim()) ? response.stdout.trim() : "no detectable"
      checks.push({ id: `version.${id}`, status: response.code === 0 && installed === expected ? "ok" : "fail", code: EXIT.MISSING_REQUIREMENT, message: `${id} esperado ${expected}; instalado ${installed}.` })
    } catch (error) {
      if (error.code === EXIT.INTERRUPTED) throw error
      checks.push({ id: `version.${id}`, status: "fail", code: EXIT.MISSING_REQUIREMENT, message: `No se pudo consultar la versión fijada de ${id}.` })
    }
  }
  return checks
}

function publicResult(ctx, resources, checks, head = null) {
  return {
    schemaVersion: 1, target: "local", profile: ctx.profile.name, fingerprint: ctx.fingerprint,
    endpoints: { api: `http://127.0.0.1:${ctx.profile.ports.api}`, postgres: { host: "127.0.0.1", port: ctx.profile.ports.db, database: "postgres" }, studio: `http://127.0.0.1:${ctx.profile.ports.studio}`, mailpit: `http://127.0.0.1:${ctx.profile.ports.mailpit}` },
    services: serviceStates(resources), head,
    checks: checks.map(({ id, status, message }) => ({ id, status, message })),
  }
}

export async function diagnose(ctx) {
  const checks = []
  let state = null, resources = emptyResources(), all = emptyResources()
  const check = (id, fn, message) => {
    try { fn(); checks.push({ id, status: "ok", message }) }
    catch (error) { checks.push({ id, status: "fail", code: error.code ?? EXIT.INVALID_ARGS, message: error instanceof BiblibError ? error.message : "Configuración local inválida." }) }
  }
  check("manifest", () => assertLayout(ctx), "Manifiesto y configuración coherentes.")
  check("env", () => {
    for (const mode of ["development", "production", "test"]) assertNoForeignEnvFiles({ target: "local", profile: ctx.profile.name, cwd: ctx.root }, { mode })
  }, "Archivos de entorno acreditados o ausentes.")
  check("state", () => { state = readState(ctx) }, "Registro de recursos coherente o todavía ausente.")
  checks.push(...await versions(ctx))
  try {
    await docker(ctx, ["version", "--format", "{{.Server.Version}}"])
    all = await inventory(ctx)
    resources = selectResources(ctx, all, state)
    checks.push({ id: "docker", status: "ok", message: "Motor Docker disponible." })
    check("ownership", () => assertOwnership(ctx, resources, state), "Recursos del perfil con propiedad acreditada.")
  } catch (error) {
    if (error.code === EXIT.INTERRUPTED) throw error
    checks.push({ id: "docker", status: "fail", code: EXIT.MISSING_REQUIREMENT, message: "Docker no está disponible; abre el motor manualmente y repite el diagnóstico." })
  }
  checks.push(...await probePorts(ctx, resources), await excludedPorts(ctx))
  const bindings = checkPublishedBindings(ctx.profile.name, resources.containers, { root: ctx.root })
  if (bindings.outOfBlock.length) checks.push({ id: "bindings.block", status: "fail", code: EXIT.IDENTITY_MISMATCH, message: "Hay bindings fuera del bloque de puertos del perfil." })
  checks.push({ id: "bindings.loopback", status: bindings.exposed.length ? "warn" : "ok", message: bindings.exposed.length ? `Hay ${bindings.exposed.length} bindings publicados fuera de loopback; consulta las alternativas A/B en docs/operacion.md (Limitación conocida).` : "No hay bindings publicados fuera de loopback." })
  const failure = checks.find((c) => c.status === "fail" && c.code === EXIT.IDENTITY_MISMATCH) ?? checks.find((c) => c.status === "fail")
  return { result: publicResult(ctx, resources, checks), code: failure?.code ?? EXIT.OK, resources, state, all }
}

export async function health(ctx, resources) {
  if (serviceStates(resources).some((s) => !["healthy", "running"].includes(s.status))) return false
  // Algunos servicios no declaran HEALTHCHECK Docker: verificamos sus endpoints.
  for (const [port, endpoint] of [[ctx.profile.ports.api, "/auth/v1/health"], [ctx.profile.ports.api, "/storage/v1/status"], [ctx.profile.ports.studio, "/project/default"], [ctx.profile.ports.mailpit, "/"]]) {
    try {
      const response = await ctx.fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: AbortSignal.any([AbortSignal.timeout(2000), ...(ctx.signal ? [ctx.signal] : [])]), redirect: "error" })
      await response.body?.cancel()
      if (!response.ok) return false
    } catch { return false }
  }
  return resources.containers.every((c) => c.status === "running" && (!c.health || c.health === "healthy"))
}

function interrupted(ctx) {
  if (ctx.signal?.aborted) fail(EXIT.INTERRUPTED, "stack", "Interrupción solicitada.")
}

function validateCreated(ctx, resources, before) {
  // Solo acredita IDs nuevos del proyecto y de nuestra red; los anteriores siguen registrados.
  const old = new Set(before.containers.map((r) => r.id))
  for (const c of resources.containers) if (!old.has(c.id) && (!c.networks?.[ctx.profile.network] || c.labels?.["com.supabase.cli.project"] !== ctx.profile.projectId)) fail(EXIT.IDENTITY_MISMATCH, "stack", "El CLI devolvió un contenedor fuera del proyecto/red esperado.")
  for (const v of resources.volumes) if (!before.volumes.some((r) => r.id === v.id) && v.labels?.["com.supabase.cli.project"] !== ctx.profile.projectId) fail(EXIT.IDENTITY_MISMATCH, "stack", "El CLI devolvió un volumen fuera del proyecto esperado.")
  for (const network of resources.networks) {
    const previous = before.networks.find((n) => n.name === network.name)
    if (previous && previous.id !== network.id) fail(EXIT.IDENTITY_MISMATCH, "stack", "La red cambió de identidad durante el arranque.")
  }
  for (const volume of resources.volumes) {
    const previous = before.volumes.find((v) => v.name === volume.name)
    if (previous && previous.createdAt !== volume.createdAt) fail(EXIT.IDENTITY_MISMATCH, "stack", "Un volumen cambió de identidad durante el arranque.")
  }
  assertOwnership(ctx, resources, { resources: resourceRecord(resources) })
  if (checkPublishedBindings(ctx.profile.name, resources.containers, { root: ctx.root }).outOfBlock.length) fail(EXIT.IDENTITY_MISMATCH, "stack", "El stack publicó un puerto fuera del bloque de su perfil.")
}

async function cleanupCreated(ctx, before) {
  // Se inspecciona de nuevo, nunca se usan patrones de borrado ni stop global.
  const clean = { ...ctx, signal: undefined, processOptions: { ...ctx.processOptions, signal: undefined } }
  const all = await inventory(clean)
  const candidates = selectResources(ctx, all, null)
  const ownNetwork = candidates.networks.find((n) => n.labels?.["biblib.root"] === ctx.identity.label && n.labels?.["biblib.profile"] === ctx.profile.name)
  const created = candidates.containers.filter((r) => !before.containers.some((b) => b.id === r.id) && r.labels?.["com.supabase.cli.project"] === ctx.profile.projectId && (!r.labels["biblib.root"] || r.labels["biblib.root"] === ctx.identity.label) && (!r.labels["biblib.profile"] || r.labels["biblib.profile"] === ctx.profile.name) && ownNetwork && r.networks?.[ctx.profile.network])
  for (const r of created) await docker(clean, ["container", "rm", "--force", r.id])
  // Conservamos siempre los volúmenes: una interrupción nunca destruye datos.
  if (ownNetwork && !before.networks.some((n) => n.id === ownNetwork.id)) await docker(clean, ["network", "rm", ownNetwork.id])
  return selectResources(ctx, await inventory(clean), null)
}

async function start(ctx, diagnostic, savePhase) {
  interrupted(ctx)
  const before = diagnostic.all
  let resources = diagnostic.resources
  const refreshResources = async (queryContext = ctx) => {
    const candidate = selectResources(ctx, await inventory(queryContext), diagnostic.state)
    validateCreated(ctx, candidate, before)
    resources = candidate
  }
  if (await ctx.health(ctx, resources)) { savePhase("stack", "healthy", resources); return resources }
  generateProfileWorkdir(ctx.profile.name, { root: ctx.root })
  try {
    savePhase("stack", "starting", resources)
    if (!resources.networks.length) {
      const network = profileNetwork(ctx.profile.name, { root: ctx.root })
      await docker(ctx, ["network", "create", "--driver", "bridge", "--opt", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", "--label", `biblib.profile=${ctx.profile.name}`, "--label", `biblib.root=${ctx.identity.label}`, network.name])
    }
    const response = await cli(ctx, ["start"])
    await refreshResources()
    savePhase("stack", "checking", resources)
    if (response.code !== 0) fail(EXIT.SERVICE_UNAVAILABLE, "stack", "Supabase no pudo arrancar o superar sus comprobaciones de salud; consulta doctor.")
    const deadline = Date.now() + ctx.healthTimeoutMs
    while (!(await ctx.health(ctx, resources))) {
      interrupted(ctx)
      if (Date.now() >= deadline) fail(EXIT.SERVICE_UNAVAILABLE, "stack", "El stack no alcanzó salud real dentro del tiempo de espera.")
      await new Promise((resolve) => setTimeout(resolve, 500))
      await refreshResources()
      savePhase("stack", "checking", resources)
    }
    interrupted(ctx)
    savePhase("stack", "healthy", resources)
    return resources
  } catch (error) {
    let cleanup = "pending"
    try {
      if (ctx.signal?.aborted || error.code === EXIT.INTERRUPTED) {
        const candidate = await cleanupCreated(ctx, before)
        validateCreated(ctx, candidate, before)
        resources = candidate
        cleanup = "completed"
      } else {
        const clean = { ...ctx, processOptions: { ...ctx.processOptions, signal: undefined } }
        await refreshResources(clean)
      }
    } catch { cleanup = "pending" }
    savePhase("stack", ctx.signal?.aborted || error.code === EXIT.INTERRUPTED ? "interrupted" : "failed", resources, { cleanup })
    throw error
  }
}

export async function runLocalStack(argv, options = {}) {
  const parsed = parseArgs(argv)
  if (parsed.command === "reset") return runReset(parsed, { ...options, createContext, diagnose, validateLayout: assertLayout, bootstrap: (profile) => runLocalStack(["bootstrap", "--profile", profile, "--json"], { ...options, lockHeld: true }) })
  const ctx = createContext(parsed.profile, options)
  if (["doctor", "status"].includes(parsed.command)) {
    const diagnostic = await diagnose(ctx)
    // status consulta el head aplicado (solo lectura) si Postgres propio está en marcha y acreditado.
    const postgresUp = diagnostic.result.services.some((s) => s.name === "postgres" && ["healthy", "running"].includes(s.status))
    if (parsed.command === "status" && postgresUp && diagnostic.code === EXIT.OK) {
      try { diagnostic.result.head = await ctx.readHead(ctx) } catch (error) {
        if (error?.code === EXIT.INTERRUPTED) throw error
        diagnostic.result.checks.push({ id: "head", status: "warn", message: "No se pudo leer el head aplicado; consulta pnpm db:status:local." })
      }
    }
    return { code: diagnostic.code, result: diagnostic.result }
  }
  // Un checkout hijo nunca puede iniciar main/test por accidente.
  if (["up", "bootstrap"].includes(parsed.command) && existsSync(path.join(ctx.root, ".git")) && !lstatSync(path.join(ctx.root, ".git")).isDirectory() && ctx.profile.name !== "scratch") fail(EXIT.IDENTITY_MISMATCH, "preflight", "Desde un worktree solo se permite arrancar el perfil scratch.")
  if (["up", "bootstrap"].includes(parsed.command) && !options.lockHeld) {
    const reset = readState(ctx, "-reset")
    if (reset && reset.status !== "passed") fail(EXIT.PLAN_REJECTED, "preflight", "Hay un reset incompleto; continúa con su plan antes de arrancar o hacer bootstrap.")
  }
  const previous = parsed.command === "bootstrap" ? readState(ctx, "-bootstrap") : null
  const release = options.lockHeld ? () => {} : acquireLock(ctx)
  let receipt = parsed.command === "bootstrap" ? { runId: previous && previous.status !== "passed" ? previous.runId : randomUUID(), resumedFrom: previous?.status === "passed" ? null : previous?.phase ?? null, status: "pending", phase: "preflight", phases: Object.fromEntries(PHASES.map((name) => [name, { status: "pending" }])) } : null
  let resources = emptyResources(), phase = "preflight", recorded = false, lastStatus
  const savePhase = (next, status, current = resources, extra = {}) => {
    phase = next; resources = current
    writeState(ctx, { phase, status, resources: resourceRecord(resources), ...extra })
    recorded = true; lastStatus = status
    if (receipt) {
      receipt.phases[next] = { status, ...extra }
      receipt.phase = phase
      receipt.status = status === "failed" || status === "interrupted" ? status : "pending"
      writeState(ctx, receipt, "-bootstrap")
    }
  }
  try {
    const diagnostic = await diagnose(ctx)
    resources = diagnostic.resources
    if (diagnostic.code !== EXIT.OK) {
      const check = diagnostic.result.checks.find((c) => c.status === "fail")
      // No se sobrescribe un registro ajeno/dañado en un preflight fallido.
      if (diagnostic.code !== EXIT.IDENTITY_MISMATCH) {
        // Un motor inaccesible no prueba que hayan desaparecido los IDs registrados.
        if (diagnostic.state && diagnostic.result.checks.some((c) => c.id === "docker" && c.status === "fail")) {
          const previous = diagnostic.state.resources
          resources = { containers: previous.containers, volumes: previous.volumes, networks: previous.network ? [previous.network] : [] }
        }
        savePhase("preflight", "failed")
      }
      fail(diagnostic.code, "preflight", check?.message ?? "El diagnóstico previo no permite continuar.")
    }
    interrupted(ctx)
    savePhase("preflight", "passed")
    if (parsed.command === "down") {
      savePhase("stack", "stopping")
      if (resources.containers.length) {
        // Workdir íntegro y recursos acreditados antes de invocar stop de este proyecto.
        if (!existsSync(path.join(ctx.workdir, "supabase/config.toml"))) fail(EXIT.IDENTITY_MISMATCH, "stack", "Falta la configuración acreditada necesaria para parar este proyecto.")
        const response = await cli(ctx, ["stop", "--project-id", ctx.profile.projectId])
        if (response.code !== 0) fail(EXIT.SERVICE_UNAVAILABLE, "stack", "No se pudo parar el perfil; los volúmenes se conservan.")
      }
      const stopped = selectResources(ctx, await inventory(ctx), diagnostic.state)
      assertOwnership(ctx, stopped, diagnostic.state)
      if (stopped.containers.some((c) => c.status === "running")) fail(EXIT.SERVICE_UNAVAILABLE, "stack", "Quedan servicios propios activos tras la parada.")
      resources = stopped
      savePhase("stack", "stopped", resources)
    } else {
      resources = await start(ctx, diagnostic, savePhase)
      if (receipt) {
        interrupted(ctx)
        savePhase("env", "running", resources)
        let message
        if (ctx.profile.name === "main") {
          const target = ctx.loadTarget("local", { profile: ctx.profile.name, cwd: ctx.root })
          ctx.writeLocalEnvFile(target)
          message = "Configuración local generada."
        } else message = "Sin archivo: scratch/test consumen contexto explícito; solo main genera .env.local."
        interrupted(ctx)
        savePhase("env", "passed", resources, { message })
        interrupted(ctx)
        savePhase("migrate", "running", resources)
        const migrated = await ctx.migrateLocal(ctx, { runId: receipt.runId, signal: ctx.signal })
        interrupted(ctx)
        savePhase("migrate", "passed", resources, { head: migrated.head, message: `Plan + migrate locales (U-INF-04): ${migrated.result}.` })
        savePhase("seed", "running", resources)
        let seeded, unchanged = false
        try { seeded = await ctx.verifyLocal(ctx, { sessions: false, signal: ctx.signal }); unchanged = true }
        catch (error) { if (error.code === EXIT.INTERRUPTED || error.code === EXIT.IDENTITY_MISMATCH) throw error }
        if (!unchanged) seeded = await ctx.seedLocal(ctx, { signal: ctx.signal })
        interrupted(ctx)
        savePhase("seed", "passed", resources, { censusId: seeded.censusId, unchanged })
        savePhase("verify", "running", resources)
        const verified = await ctx.verifyLocal(ctx, { signal: ctx.signal })
        interrupted(ctx)
        savePhase("verify", "passed", resources, { verification: verified })
        receipt.status = "passed"
        writeState(ctx, receipt, "-bootstrap")
      }
    }
    const checks = [{ id: parsed.command, status: "ok", message: parsed.command === "down" ? "Perfil parado; volúmenes conservados." : "Stack propio sano." }]
    const bindings = checkPublishedBindings(ctx.profile.name, resources.containers, { root: ctx.root })
    if (bindings.exposed.length) checks.push({ id: "bindings.loopback", status: "warn", message: "Bindings fuera de loopback; consulta alternativas A/B en docs/operacion.md." })
    if (receipt) checks.push({ id: "bootstrap", status: "ok", message: "preflight, stack, env, migrate, seed y verify completados y verificados." })
    return { code: EXIT.OK, result: { ...publicResult(ctx, resources, checks, receipt ? receipt.phases.migrate.head ?? null : null), ...(receipt ? { bootstrap: { status: receipt.status, phase: "verify", phases: receipt.phases } } : {}) } }
  } catch (error) {
    if (!recorded && ctx.signal?.aborted) {
      // También registra una interrupción temprana, siempre que la identidad sea válida.
      try {
        const clean = { ...ctx, processOptions: { ...ctx.processOptions, signal: undefined } }
        const state = readState(ctx)
        resources = selectResources(ctx, await inventory(clean), state)
        assertOwnership(ctx, resources, state)
        savePhase(phase, "interrupted")
      } catch { /* No se reemplaza un registro ajeno para anotar la interrupción. */ }
    }
    if (recorded && !["failed", "interrupted"].includes(lastStatus)) savePhase(phase, ctx.signal?.aborted || error.code === EXIT.INTERRUPTED ? "interrupted" : "failed")
    if (recorded && receipt && !["failed", "interrupted"].includes(receipt.status)) {
      receipt.status = ctx.signal?.aborted ? "interrupted" : "failed"
      receipt.phase = phase
      receipt.phases[phase] = { status: receipt.status }
      writeState(ctx, receipt, "-bootstrap")
    }
    if (ctx.signal?.aborted) fail(EXIT.INTERRUPTED, phase, "Interrupción solicitada; consulta el registro de fase y recursos propios.")
    throw error
  } finally { release() }
}

export async function main(argv = process.argv.slice(2)) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.on("SIGINT", abort)
  try {
    const { code, result } = await runLocalStack(argv, { signal: controller.signal })
    if (argv.includes("--json")) console.log(JSON.stringify(result))
    else {
      console.log(`BibLib local · ${result.profile} · ${result.fingerprint}`)
      for (const check of result.checks) console.log(`[${check.status}] ${check.id}: ${check.message}`)
      for (const service of result.services) console.log(`${service.name}: ${service.status}`)
    }
    return code
  } catch (error) {
    const code = controller.signal.aborted ? EXIT.INTERRUPTED : error instanceof BiblibError ? error.code : EXIT.SERVICE_UNAVAILABLE
    const result = { schemaVersion: 1, target: "local", code, phase: error instanceof BiblibError ? error.phase : "lifecycle", correlation: randomUUID(), message: error instanceof BiblibError ? sanitize(error.message) : "No se pudo completar el lifecycle local; consulta doctor." }
    if (argv.includes("--json")) console.log(JSON.stringify(result))
    else console.error(`Error [${result.phase}] (${code}): ${result.message}`)
    return code
  } finally { process.removeListener("SIGINT", abort) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

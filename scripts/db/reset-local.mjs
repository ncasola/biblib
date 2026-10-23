import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import path from "node:path"
import { assertOwnership, docker, inventory, resourceRecord, selectResources } from "../lib/docker.mjs"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { localPath, removeLocalPath } from "../lib/local-path.mjs"
import { checkPublishedBindings, REPO_ROOT } from "../lib/profiles.mjs"
import { acquireLock, readState, writeState } from "../lib/state.mjs"
import { canonical, computePlanHash, PLAN_TTL_MS, readPlan, resolvePlanPath, writePlan } from "./plan.mjs"
import { sha256 } from "./journal-guard.mjs"
import { closeConnection, connect, connectionError } from "./target.mjs"
import { acquireMigrationLock, releaseMigrationLock } from "./migrate.mjs"
import { assertNoForeignEnvFiles } from "./environment.mjs"

const fail = (code, message) => { throw new BiblibError(code, "reset", message) }
const checkSignal = (ctx) => { if (ctx.signal?.aborted) fail(EXIT.INTERRUPTED, "Reset interrumpido; repite la misma orden para continuar desde el recibo.") }
const phases = ["preflight", "stop", "destroy", "local-state", "bootstrap", "verify"]

export function parseResetArgs(argv) {
  const parsed = { json: false }
  const values = { "--profile": "profile", "--out": "out", "--plan": "plan", "--expect-project": "expectProject", "--expect-plan": "expectPlan", "--backup-receipt": "backupReceipt" }
  const booleans = { "--dry-run": "dryRun", "--apply": "apply", "--discard-local-data": "discardLocalData", "--json": "json", "--yes": "yes" }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (seen.has(flag)) fail(EXIT.INVALID_ARGS, "Argumento repetido.")
    seen.add(flag)
    if (booleans[flag]) parsed[booleans[flag]] = true
    else if (values[flag] && argv[i + 1] && !argv[i + 1].startsWith("--")) parsed[values[flag]] = argv[++i]
    else fail(EXIT.INVALID_ARGS, "Reset no admite URLs, opciones remotas ni flags reenviados.")
  }
  if (parsed.dryRun === parsed.apply || (!parsed.dryRun && !parsed.apply)) fail(EXIT.INVALID_ARGS, "Indica --dry-run o --apply, exclusivamente.")
  if (parsed.dryRun) {
    if (!["main", "test", "scratch"].includes(parsed.profile) || !parsed.out || parsed.plan || parsed.expectProject || parsed.expectPlan || parsed.backupReceipt || parsed.discardLocalData || parsed.yes) fail(EXIT.INVALID_ARGS, "Uso: db:reset:local --dry-run --profile <perfil> --out <ruta.json>.")
  } else {
    if (parsed.profile || parsed.out || !parsed.plan || !parsed.expectProject || !/^[0-9a-f]{64}$/.test(parsed.expectPlan ?? "") || Boolean(parsed.backupReceipt) === Boolean(parsed.discardLocalData)) fail(EXIT.INVALID_ARGS, "Uso: db:reset:local --apply --plan <ruta> --expect-project <id> --expect-plan <sha256> (--backup-receipt <ruta> | --discard-local-data).")
  }
  return parsed
}

/** La identidad de un marcador aislado nunca acredita un puerto o un contenedor. */
export function assertResetIdentity(ctx, state, all, target, { allowMissing = false } = {}) {
  if (!state || state.root !== ctx.identity.root || state.rootHash !== ctx.identity.hash || state.projectId !== ctx.profile.projectId || state.profile !== ctx.profile.name || state.fingerprint !== ctx.fingerprint || /holaerp/i.test(state.projectId)) fail(EXIT.IDENTITY_MISMATCH, "El registro no pertenece a la raíz real y al proyecto/perfil esperados.")
  const resources = selectResources(ctx, all, state)
  assertOwnership(ctx, resources, state)
  const network = resources.networks[0]
  if (resources.networks.length !== 1 || !network || network.id !== state.resources.network?.id) fail(EXIT.IDENTITY_MISMATCH, "La red registrada falta o es ajena.")
  for (const c of all.containers) {
    if (c.networks?.[ctx.profile.network] && !state.resources.containers.some((r) => r.id === c.id)) fail(EXIT.IDENTITY_MISMATCH, "Hay un contenedor no registrado conectado a la red propia.")
    if (c.mounts?.some((m) => state.resources.volumes.some((v) => v.id === m.Name)) && !state.resources.containers.some((r) => r.id === c.id)) fail(EXIT.IDENTITY_MISMATCH, "Un contenedor ajeno utiliza un volumen del perfil.")
  }
  const bindings = checkPublishedBindings(ctx.profile.name, resources.containers, { root: ctx.root })
  if (bindings.outOfBlock.length) fail(EXIT.IDENTITY_MISMATCH, "Hay bindings fuera de los puertos exactos del perfil.")
  for (const c of resources.containers) {
    if (Object.keys(c.networks ?? {}).some((n) => n !== ctx.profile.network)) fail(EXIT.IDENTITY_MISMATCH, "Un contenedor propio está conectado también a una red ajena.")
    if (c.mounts?.some((m) => m.Type === "volume" && !state.resources.volumes.some((v) => v.id === m.Name))) fail(EXIT.IDENTITY_MISMATCH, "Un contenedor propio monta un volumen no registrado.")
  }
  if (!allowMissing) {
    if (state.resources.containers.length !== resources.containers.length || state.resources.volumes.length !== resources.volumes.length) fail(EXIT.IDENTITY_MISMATCH, "El inventario no coincide con todos los IDs registrados.")
    const db = resources.containers.find((c) => c.name === `supabase_db_${ctx.profile.projectId}`)
    if (db?.status !== "running" || !db.ports?.["5432/tcp"]?.some((b) => Number(b.HostPort) === ctx.profile.ports.db && ["127.0.0.1", "0.0.0.0", ""].includes(b.HostIp ?? ""))) fail(EXIT.IDENTITY_MISMATCH, "El puerto Postgres no está servido por el contenedor registrado; túnel o destino no acreditado.")
    if (!resources.volumes.some((v) => v.name === `supabase_db_${ctx.profile.projectId}`)) fail(EXIT.IDENTITY_MISMATCH, "Falta el volumen Postgres registrado.")
  }
  if (target) {
    let api, db
    try { const values = target.env(); api = new URL(values.SUPABASE_URL); db = new URL(values.SUPABASE_DB_URL) } catch { fail(EXIT.IDENTITY_MISMATCH, "El objetivo local no contiene endpoints acreditados.") }
    if (target.target !== "local" || target.profile !== ctx.profile.name || target.fingerprint !== ctx.fingerprint || api.origin !== `http://127.0.0.1:${ctx.profile.ports.api}` || !["postgres:", "postgresql:"].includes(db.protocol) || db.hostname !== "127.0.0.1" || Number(db.port) !== ctx.profile.ports.db || Number(db.port) === 5432 || db.pathname !== "/postgres" || db.username !== "postgres") fail(EXIT.IDENTITY_MISMATCH, "URL remota, puerto ajeno o identidad local incorrecta; no se ha modificado nada.")
  }
  return resources
}

/** Recorre todo el buzón, también mensajes fuera de la primera página. */
export async function mailpitInventory(ctx) {
  const hashes = new Map()
  let total
  do {
    const response = await ctx.fetch(`http://127.0.0.1:${ctx.profile.ports.mailpit}/api/v1/messages?limit=500&start=${hashes.size}`, { signal: AbortSignal.any([AbortSignal.timeout(5000), ...(ctx.signal ? [ctx.signal] : [])]), redirect: "error" })
    if (!response.ok) fail(EXIT.SERVICE_UNAVAILABLE, "Mailpit no responde; no se puede revisar la pérdida de correo.")
    const page = await response.json()
    if (!Number.isSafeInteger(page.total) || page.total < 0 || !Array.isArray(page.messages) || total !== undefined && total !== page.total) fail(EXIT.SERVICE_UNAVAILABLE, "El inventario de Mailpit cambió durante la lectura o no tiene un recuento verificable.")
    total = page.total
    const before = hashes.size
    for (const message of page.messages) {
      if (typeof message.ID !== "string" || hashes.has(message.ID)) fail(EXIT.SERVICE_UNAVAILABLE, "El inventario de Mailpit no es estable; repite el dry-run sin escrituras concurrentes.")
      hashes.set(message.ID, sha256(canonical(message)))
    }
    if (hashes.size > total || hashes.size === before && hashes.size !== total) fail(EXIT.SERVICE_UNAVAILABLE, "Mailpit no devolvió todo su inventario.")
  } while (hashes.size < total)
  return { total, hashes: [...hashes].sort(([a], [b]) => a.localeCompare(b)) }
}

/** Solo hashes y cantidades salen de Postgres; nunca filas, correos ni objetos. */
export async function discardedState(ctx, target, { sql: provided } = {}) {
  const sql = provided ?? connect({ target }, { applicationName: "biblib-reset-plan" })
  try {
    const readTables = async (tx) => {
      const names = await tx`select schemaname, tablename from pg_tables where schemaname in ('biblib', 'auth', 'storage', 'drizzle') order by schemaname, tablename`
      const result = []
      for (const table of names) {
        const [row] = await tx`select count(*)::integer as count, md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' order by md5(to_jsonb(t)::text)), '')) as hash from ${tx(table.schemaname)}.${tx(table.tablename)} t`
        result.push({ schema: table.schemaname, table: table.tablename, count: row.count, hash: row.hash })
      }
      return result
    }
    const tables = provided ? await readTables(sql) : await sql.begin("isolation level repeatable read read only", readTables)
    const mailbox = await mailpitInventory(ctx)
    const count = (schema, table) => tables.find((t) => t.schema === schema && t.table === table)?.count ?? 0
    return { counts: { domain: { books: count("biblib", "books"), shelves: count("biblib", "shelves") }, auth: { users: count("auth", "users"), sessions: count("auth", "sessions"), refreshTokens: count("auth", "refresh_tokens") }, storage: { buckets: count("storage", "buckets"), objects: count("storage", "objects") }, mailpit: { messages: mailbox.total }, ledger: count("drizzle", "__drizzle_migrations") }, tables, mailpitHash: sha256(canonical(mailbox)), hash: sha256(canonical({ tables, mailbox })) }
  } finally { if (!provided) await closeConnection(sql) }
}

export function buildResetPlan(ctx, resources, discarded, now = new Date()) {
  const plan = { schemaVersion: 1, kind: "reset-local", target: { target: "local", profile: ctx.profile.name, project: ctx.profile.projectId }, root: ctx.identity.root, rootHash: ctx.identity.hash, fingerprint: ctx.fingerprint,
    identityMarker: { projectId: ctx.profile.projectId, rootLabel: ctx.identity.label }, resources,
    bindings: checkPublishedBindings(ctx.profile.name, resources.containers, { root: ctx.root }).bindings,
    postgres: { host: "127.0.0.1", port: ctx.profile.ports.db, database: "postgres" },
    mechanism: "registered-physical-rebuild", scope: ["dominio", "usuarios y sesiones locales", "metadatos y bytes Storage", "mensajes Mailpit", "ledger Drizzle", "credenciales fixture locales"], preserved: ["red registrada del perfil", "imágenes Docker", "otros perfiles y proyectos", "planes y recibos"], discarded,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString() }
  return { ...plan, planHash: computePlanHash(plan) }
}

export function validateResetPlan(plan, ctx, options, now = new Date()) {
  if (plan?.schemaVersion !== 1 || plan.kind !== "reset-local" || plan.mechanism !== "registered-physical-rebuild" || computePlanHash(plan) !== plan.planHash || plan.planHash !== options.expectPlan) fail(EXIT.PLAN_REJECTED, "Tipo o huella de plan incorrectos; genera y revisa otro plan.")
  if (plan.target?.target !== "local" || plan.target.profile !== ctx.profile.name || plan.target.project !== options.expectProject || plan.target.project !== ctx.profile.projectId || plan.root !== ctx.identity.root || plan.rootHash !== ctx.identity.hash || plan.fingerprint !== ctx.fingerprint || plan.identityMarker?.rootLabel !== ctx.identity.label || plan.identityMarker.projectId !== ctx.profile.projectId || plan.postgres?.host !== "127.0.0.1" || plan.postgres.port !== ctx.profile.ports.db || plan.postgres.port === 5432) fail(EXIT.IDENTITY_MISMATCH, "El plan, la confirmación del proyecto o la raíz real son ajenos.")
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(Date.parse(plan.createdAt)) || Date.parse(plan.createdAt) > now.getTime() || Date.parse(plan.expiresAt) !== Date.parse(plan.createdAt) + PLAN_TTL_MS || Date.parse(plan.expiresAt) <= now.getTime()) fail(EXIT.PLAN_REJECTED, "El plan ha caducado (30 minutos) o tiene fechas incorrectas.")
}

export function validateResetBackup(file, ctx, plan) {
  const absolute = localPath(ctx.root, file)
  let receipt
  try { receipt = JSON.parse(readFileSync(absolute, "utf8")) } catch { fail(EXIT.PLAN_REJECTED, "El recibo de respaldo no es válido.") }
  if (receipt.schemaVersion !== 1 || !receipt.backupId || receipt.fingerprint !== ctx.fingerprint || receipt.discardedStateHash !== plan.discarded.hash || !receipt.restoreVerification?.passed || !["domain", "auth", "storage", "mailpit", "ledger"].every((scope) => receipt.scope?.includes(scope)) || !receipt.files?.length || Date.parse(receipt.createdAt) < Date.parse(plan.createdAt)) fail(EXIT.PLAN_REJECTED, "El respaldo no acredita este estado, todos los scopes y su restauración; usa U-OPS-02 o la renuncia local explícita.")
  for (const item of receipt.files) {
    const artifact = localPath(ctx.root, item.path)
    if (!/^[0-9a-f]{64}$/.test(item.sha256 ?? "") || sha256(readFileSync(artifact)) !== item.sha256) fail(EXIT.PLAN_REJECTED, "Un archivo del respaldo no coincide con su inventario.")
  }
  return { backupId: receipt.backupId, receiptHash: sha256(canonical(receipt)) }
}

/** Inyecta lifecycle en vez de importarlo: evita ciclos con su entrypoint ESM. */
export async function runReset(options, deps) {
  const root = deps.root ?? REPO_ROOT
  const planFile = resolvePlanPath(options.dryRun ? options.out : options.plan, root)
  let plan = options.apply ? readPlan(planFile, root).plan : null
  if (plan && (plan.kind !== "reset-local" || plan.schemaVersion !== 1 || computePlanHash(plan) !== plan.planHash || plan.planHash !== options.expectPlan)) fail(EXIT.PLAN_REJECTED, "Tipo o huella del plan incorrectos.")
  const ctx = deps.createContext(options.dryRun ? options.profile : plan?.target?.profile, deps)
  deps.validateLayout?.(ctx)
  for (const mode of ["development", "production", "test"]) assertNoForeignEnvFiles({ target: "local", profile: ctx.profile.name, cwd: ctx.root }, { mode })
  localPath(ctx.root, planFile)
  for (const file of [`fixtures/${ctx.profile.name}.json`, `state/${ctx.profile.name}-bootstrap.json`]) localPath(ctx.root, path.join(ctx.root, ".biblib", file))
  if (existsSync(path.join(ctx.root, ".git")) && !lstatSync(path.join(ctx.root, ".git")).isDirectory() && ctx.profile.name !== "scratch") fail(EXIT.IDENTITY_MISMATCH, "Desde este worktree solo se puede reconstruir scratch.")
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") fail(EXIT.IDENTITY_MISMATCH, "El reset exige objetivo local.")
  const release = acquireLock(ctx)
  let receipt, recorded = false, lockSql
  const save = (phase, status, extra = {}) => {
    receipt.phase = phase; receipt.status = status === "passed" ? "pending" : status
    receipt.phases[phase] = { ...receipt.phases[phase], status, ...extra }
    writeState(ctx, receipt, "-reset"); recorded = true
  }
  const stateFromPlan = () => ({ root: plan.root, rootHash: plan.rootHash, fingerprint: plan.fingerprint, profile: plan.target.profile, projectId: plan.target.project, resources: resourceRecord(plan.resources) })
  const inspect = deps.inventory ?? inventory
  const snapshot = deps.discardedState ?? discardedState
  try {
    const previous = readState(ctx, "-reset")
    const continuing = Boolean(plan && previous?.planHash === plan.planHash && previous.status !== "passed")
    // La caducidad limita la autorización inicial. Una operación destructiva ya
    // autorizada puede terminar tras 30 min, pero no puede cambiar de plan/target.
    const authorizedAt = continuing && previous.destructionStarted ? new Date(previous.authorizedAt) : null
    if (plan) validateResetPlan(plan, ctx, options, authorizedAt ?? deps.now?.())
    if (previous && previous.status !== "passed" && !continuing && !options.dryRun) fail(EXIT.PLAN_REJECTED, "Hay un reset incompleto; continúa primero con su plan y autorización originales.")
    if (previous?.planHash === plan?.planHash && previous?.status === "passed") fail(EXIT.PLAN_REJECTED, "Este plan ya se completó; genera otro para un nuevo reset.")
    if (!continuing || !previous.destructionStarted) {
      const diagnostic = await deps.diagnose(ctx)
      if (diagnostic.code !== EXIT.OK) fail(diagnostic.code, "Preflight fallido; consulta db:local:doctor antes de reset.")
      const target = ctx.loadTarget("local", { profile: ctx.profile.name, cwd: ctx.root })
      const resources = assertResetIdentity(ctx, diagnostic.state, diagnostic.all, target)
      if (options.apply && !deps.skipDatabaseLock) {
        lockSql = connect({ target }, { applicationName: "biblib-reset-lock" })
        await acquireMigrationLock(lockSql, { signal: ctx.signal })
        // Bloquea DML del dominio mientras se coteja la huella y se para el stack.
        // Postgres local no permite LOCK en tablas auth/storage de la plataforma.
        // max:1 permite esta transacción explícita en la conexión dedicada.
        await lockSql.unsafe("begin")
        const tables = await lockSql`select schemaname, tablename from pg_tables where schemaname in ('biblib', 'drizzle') order by schemaname, tablename`
        for (const table of tables) await lockSql`lock table ${lockSql(table.schemaname)}.${lockSql(table.tablename)} in share mode`
      }
      const discarded = await snapshot(ctx, target, { sql: lockSql })
      checkSignal(ctx)
      if (options.dryRun) {
        plan = buildResetPlan(ctx, resources, discarded, deps.now?.())
        writePlan(plan, planFile, ctx.root)
        return { code: EXIT.OK, result: { profile: ctx.profile.name, fingerprint: ctx.fingerprint, checks: [{ id: "reset.plan", status: "ok", message: `Plan guardado: ${path.relative(ctx.root, planFile)} · proyecto ${ctx.profile.projectId} · sha256 ${plan.planHash}` }], services: [], plan } }
      }
      if (canonical(resources) !== canonical(plan.resources) || discarded.hash !== plan.discarded.hash) fail(EXIT.PLAN_REJECTED, "El inventario, bindings o estado descartable cambiaron desde el plan; genera otro.")
    }
    const authorization = options.discardLocalData ? { discardLocalData: true, projectId: options.expectProject } : validateResetBackup(options.backupReceipt, ctx, plan)
    if (continuing && canonical(previous.authorization) !== canonical(authorization)) fail(EXIT.PLAN_REJECTED, "La autorización de recuperación difiere de la original.")
    receipt = continuing ? previous : { runId: randomUUID(), planHash: plan.planHash, plan: path.relative(ctx.root, planFile), authorization, authorizedAt: (deps.now?.() ?? new Date()).toISOString(), destructionStarted: false, phases: Object.fromEntries(phases.map((p) => [p, { status: "pending" }])) }
    save("preflight", "passed", { resumed: continuing })
    const original = stateFromPlan()
    const refresh = async () => assertResetIdentity(ctx, original, await inspect(ctx), null, { allowMissing: true })
    const mutate = async (args) => { checkSignal(ctx); await refresh(); await docker(ctx, args, { timeoutMs: 180000 }); checkSignal(ctx) }
    if (receipt.phases.destroy.status !== "passed") {
      let resources = await refresh()
      receipt.destructionStarted = true
      save("stop", "running")
      const running = resources.containers.filter((c) => c.status === "running")
      if (running.length) await mutate(["container", "stop", ...running.map((c) => c.id)])
      await closeConnection(lockSql); lockSql = undefined
      save("stop", "passed")
      save("destroy", "running")
      resources = await refresh()
      for (const c of resources.containers) { await mutate(["container", "rm", c.id]); save("destroy", "running", { lastRemoved: c.id }) }
      resources = await refresh()
      for (const v of resources.volumes) { await mutate(["volume", "rm", v.id]); save("destroy", "running", { lastRemoved: v.id }) }
      resources = await refresh()
      if (resources.containers.length || resources.volumes.length) fail(EXIT.VERIFICATION_FAILED, "Quedan recursos descartables del perfil.")
      writeState(ctx, { phase: "reset", status: "empty", resources: resourceRecord(resources) })
      save("destroy", "passed")
    }
    if (receipt.phases["local-state"].status !== "passed") {
      save("local-state", "running")
      for (const file of [`fixtures/${ctx.profile.name}.json`, `state/${ctx.profile.name}-bootstrap.json`]) removeLocalPath(ctx.root, path.join(ctx.root, ".biblib", file))
      save("local-state", "passed")
    }
    checkSignal(ctx)
    save("bootstrap", "running")
    const boot = await deps.bootstrap(ctx.profile.name)
    if (boot.code !== EXIT.OK || boot.result.bootstrap?.status !== "passed") fail(boot.code || EXIT.VERIFICATION_FAILED, "La reconstrucción no terminó bootstrap/verify; continúa el mismo reset.")
    checkSignal(ctx)
    save("bootstrap", "passed", { phases: boot.result.bootstrap.phases })
    save("verify", "passed", { verification: boot.result.bootstrap.phases.verify.verification })
    receipt.status = "passed"
    writeState(ctx, receipt, "-reset")
    return { code: EXIT.OK, result: { ...boot.result, reset: { status: "passed", planHash: plan.planHash, resumed: continuing }, checks: [...boot.result.checks, { id: "reset", status: "ok", message: "Reset del perfil completado con migración, seed y verificación real." }] } }
  } catch (error) {
    if (recorded) save(receipt.phase, ctx.signal?.aborted || error.code === EXIT.INTERRUPTED ? "interrupted" : "failed")
    if (ctx.signal?.aborted) fail(EXIT.INTERRUPTED, "Reset interrumpido; repite la misma orden con su plan para continuar.")
    throw error instanceof BiblibError ? error : connectionError(error, "reset")
  } finally { if (lockSql) { await releaseMigrationLock(lockSql); await closeConnection(lockSql) }; release() }
}

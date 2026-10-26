import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { sanitize } from "../lib/process.mjs"
import { compareLedger, LEDGER, MIGRATIONS_DIR, sha256 } from "./journal-guard.mjs"
import { inspectObjects, MANIFEST, verifyManifest } from "./objects-manifest.mjs"
import { canonical } from "./plan.mjs"
import { withRemoteEnvFile } from "./remote-env.mjs"
import { acquireMigrationLock, LOCK_WAIT_MS, parseArgs, printPromotion, releaseMigrationLock, runPromotion } from "./migrate.mjs"
import { classify, inspectDatabase, readLedger } from "./target.mjs"

// Adopción excepcional del historial (U-INF-07): un esquema biblib aplicado a mano, sin ledger,
// solo se adopta si sus metadatos son equivalentes, objeto a objeto, a un prefijo exacto del
// journal. Entonces se escriben únicamente las filas del ledger (tags, hashes y orden exactos),
// bajo el bloqueo común y con respaldo. Nunca ejecuta el DDL ya presente ni acepta --force.

const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }
const TYPE_ALIASES = { timestamptz: "timestamp with time zone" }

/** Columnas esperadas tras `tag`: snapshot de Drizzle si existe; para 0000, su propio SQL. */
export function expectedColumns(tag, migrationsDir = MIGRATIONS_DIR) {
  const snapshot = path.join(migrationsDir, "meta", `${tag.slice(0, 4)}_snapshot.json`)
  const tables = {}
  if (existsSync(snapshot)) {
    for (const [name, table] of Object.entries(JSON.parse(readFileSync(snapshot, "utf8")).tables ?? {})) {
      if (!name.startsWith("biblib.")) continue
      tables[name.slice(7)] = Object.values(table.columns).map((c) => ({ name: c.name, type: c.type, notNull: c.notNull === true || c.primaryKey === true })).sort((a, b) => a.name.localeCompare(b.name))
    }
    return tables
  }
  const source = readFileSync(path.join(migrationsDir, `${tag}.sql`), "utf8")
  for (const [, table, body] of source.matchAll(/CREATE TABLE IF NOT EXISTS biblib\.(\w+) \(([\s\S]*?)\n\);/g)) {
    tables[table] = body.split("\n").map((line) => /^\s+([a-z_]+)\s+(uuid|text|boolean|timestamptz|jsonb|integer|bigint)\b(.*)$/.exec(line)).filter(Boolean)
      .map(([, name, type, rest]) => ({ name, type: TYPE_ALIASES[type] ?? type, notNull: /NOT NULL|PRIMARY KEY/.test(rest) })).sort((a, b) => a.name.localeCompare(b.name))
  }
  return tables
}

// Asocia cada comprobación del manifest a la migración que introduce su objeto.
function sinceIndex(applied) {
  const index = new Map([["grant.authenticated.schema", MANIFEST.tables[0].since], ["grant.anon.schema", MANIFEST.tables[0].since]])
  for (const t of MANIFEST.tables) for (const id of [`rls.${t.name}`, `grant.authenticated.${t.name}`, `grant.anon.${t.name}`]) index.set(id, t.since)
  for (const p of MANIFEST.policies) index.set(`policy.${p.name}`, p.since)
  for (const c of MANIFEST.constraints) index.set(`constraint.${c.name}`, c.until && applied.has(c.until) ? c.until : c.since)
  for (const i of MANIFEST.indexes) index.set(`index.${i.name}`, i.since)
  for (const c of MANIFEST.columns) index.set(`column.${c.table}.${c.name}`, c.since)
  for (const f of MANIFEST.functions) index.set(`function.${f.name}`, f.since)
  for (const t of MANIFEST.triggers) index.set(`trigger.${t.name}`, t.since)
  return index
}

/**
 * Compara los metadatos con el estado esperado tras un prefijo del journal: manifest de objetos
 * deliberados (RLS, políticas, grants, FK, checks, índices, función y trigger), tablas y columnas
 * exactas, y ausencia de objetos de migraciones posteriores. Pura: no consulta la base.
 */
export function compareToPrefix(facts, tags, migrationsDir = MIGRATIONS_DIR) {
  const applied = new Set(tags)
  const active = (item) => applied.has(item.since) && !(item.until && applied.has(item.until))
  const checks = verifyManifest(facts, tags).map(({ id, status, message }) => ({ id, status, message }))
  const columns = expectedColumns(tags.at(-1), migrationsDir)
  const present = new Set(facts.tables.map((t) => t.name))
  for (const table of new Set([...Object.keys(columns), ...present])) {
    const expected = columns[table]
    const found = facts.columns.filter((c) => c.table === table).map((c) => ({ name: c.name, type: c.type, notNull: c.not_null })).sort((a, b) => a.name.localeCompare(b.name))
    const ok = expected && present.has(table) && canonical(found) === canonical(expected)
    checks.push({ id: `table.${table}`, status: ok ? "ok" : "fail", message: ok ? `Tabla biblib.${table}: ${expected.length} columnas con tipo y nulabilidad de ${tags.at(-1)}.` : !expected ? `La tabla biblib.${table} no existe tras ${tags.at(-1)}.` : !present.has(table) ? `Falta la tabla biblib.${table}.` : `Las columnas de biblib.${table} (nombre, tipo o nulabilidad) no son las de ${tags.at(-1)}.` })
  }
  const later = (list, name, kind, extra = () => false) => {
    for (const item of list) {
      const declared = [...MANIFEST.constraints, ...MANIFEST.indexes, ...MANIFEST.functions, ...MANIFEST.triggers].filter((m) => m.name === item.name)
      if (declared.some(active) || extra(item)) continue
      checks.push({ id: `absent.${kind}.${item.name}`, status: "fail", message: declared.length ? `${name} ${item.name} pertenece a una migración posterior a ${tags.at(-1)} (o retirada): el esquema no es ese prefijo.` : `${name} ${item.name} no está declarado en ninguna migración.` })
    }
  }
  const activeConstraint = (item) => MANIFEST.constraints.some((c) => c.name === item.name && active(c))
  later(facts.functions, "La función", "function")
  later(facts.triggers, "El trigger", "trigger")
  later(facts.constraints, "La restricción", "constraint")
  later(facts.indexes, "El índice", "index", activeConstraint)
  return checks
}

// Las consultas de catálogo no fijan orden: la huella se calcula sobre listas ordenadas.
function sortedFacts(facts) {
  return Object.fromEntries(Object.entries(facts).map(([key, value]) => [key, Array.isArray(value) ? [...value].sort((a, b) => canonical(a).localeCompare(canonical(b))) : value]))
}

/**
 * Determina si el esquema manual equivale a un prefijo exacto del journal. Devuelve la
 * evidencia por migración y las filas del ledger a escribir, o la conciliación propuesta.
 */
export function analyzeAdoption(facts, journal, { migrationsDir = MIGRATIONS_DIR } = {}) {
  const tags = journal.entries.map((e) => e.tag)
  const candidates = tags.map((_, i) => {
    const prefix = tags.slice(0, i + 1)
    const checks = compareToPrefix(facts, prefix, migrationsDir)
    return { prefix, checks, failures: checks.filter((c) => c.status !== "ok") }
  })
  const proven = candidates.filter((c) => c.failures.length === 0)
  const factsHash = sha256(canonical(sortedFacts(facts)))
  if (proven.length !== 1) {
    const closest = [...candidates].sort((a, b) => a.failures.length - b.failures.length || b.prefix.length - a.prefix.length)[0]
    return {
      proven: false, factsHash, closestHead: closest.prefix.at(-1),
      reconciliation: {
        closestHead: closest.prefix.at(-1),
        differences: closest.failures.map(({ id, message }) => ({ id, message })),
        proposal: [
          `No se adopta: el esquema no es equivalente a ningún prefijo del journal; el más cercano es ${closest.prefix.at(-1)} con ${closest.failures.length} diferencia(s).`,
          "Opción A: corrección hacia delante revisada en una copia aislada que deje los objetos listados idénticos a ese prefijo (por ejemplo, recrear un trigger o una política con el SQL exacto de su migración), y repetir db:plan:<target>.",
          "Opción B: restaurar el respaldo ensayado y repetir el diagnóstico.",
          "Nunca se marcan migraciones como aplicadas sin equivalencia ni se importan excepciones de otro proyecto.",
        ],
      },
    }
  }
  const [match] = proven
  const index = sinceIndex(new Set(match.prefix))
  const evidence = journal.entries.slice(0, match.prefix.length).map((entry) => ({
    tag: entry.tag, hash: entry.hash, created_at: entry.when,
    checks: match.checks.filter((c) => index.get(c.id) === entry.tag || (c.id.startsWith("table.") && entry.tag === match.prefix.at(-1))).map((c) => c.id).sort(),
  }))
  const head = journal.entries[match.prefix.length - 1]
  return {
    proven: true, factsHash, head: { tag: head.tag, when: head.when, hash: head.hash },
    rows: journal.entries.slice(0, match.prefix.length).map((e) => ({ tag: e.tag, hash: e.hash, created_at: e.when })),
    evidence, evidenceHash: sha256(canonical(evidence)), checks: match.checks.length,
    pendingAfter: tags.slice(match.prefix.length),
  }
}

/**
 * Escribe solo el ledger bajo el bloqueo común: relee el destino, exige que siga sin historial y
 * con los mismos hechos que el plan, y verifica dentro de la misma transacción que el resultado
 * es un historial coherente (ledger = prefijo adoptado y manifest sin drift).
 */
export async function applyAdoption(sql, { plan, journal, migrationsDir = MIGRATIONS_DIR, waitMs = LOCK_WAIT_MS, signal, beforeApply }) {
  const report = { previousHead: null, attempted: plan.adoption.rows.map((r) => r.tag), failedChange: null, result: "pending", head: null }
  const lock = await acquireMigrationLock(sql, { waitMs, signal })
  report.waitedForLock = lock.waited
  try {
    const before = await inspectDatabase(sql, journal)
    if (before.state !== "adoption-required") fail(EXIT.PLAN_REJECTED, "adopción", `El destino ya no requiere adopción (estado ${before.state}); ¿otro runner? No se ha escrito nada. Genera un plan nuevo.`)
    const analysis = analyzeAdoption(before.facts, journal, { migrationsDir })
    if (!analysis.proven) throw Object.assign(new BiblibError(EXIT.HISTORY_DIVERGED, "adopción", "El esquema ya no es equivalente al prefijo planificado; no se adopta."), { report: { ...report, result: "rechazado: sin equivalencia", reconciliation: analysis.reconciliation } })
    if (analysis.factsHash !== plan.adoption.factsHash || analysis.head.tag !== plan.adoption.head.tag || analysis.evidenceHash !== plan.adoption.evidenceHash) fail(EXIT.PLAN_REJECTED, "adopción", "Los metadatos del destino cambiaron desde el plan de adopción; genera y revisa uno nuevo.")
    await beforeApply?.(sql, before)
    const head = await sql.begin(async (tx) => {
      await tx`create schema if not exists ${tx(LEDGER.schema)}`
      await tx`create table if not exists ${tx(LEDGER.schema)}.${tx(LEDGER.table)} (id serial primary key, hash text not null, created_at bigint)`
      const [{ count }] = await tx`select count(*)::integer as count from ${tx(LEDGER.schema)}.${tx(LEDGER.table)}`
      if (count !== 0) fail(EXIT.PLAN_REJECTED, "adopción", "El ledger ya tiene filas; no se adopta encima de un historial.")
      for (const row of plan.adoption.rows) await tx`insert into ${tx(LEDGER.schema)}.${tx(LEDGER.table)} (hash, created_at) values (${row.hash}, ${row.created_at})`
      const ledger = await readLedger(tx)
      const comparison = compareLedger(journal.entries, ledger.rows)
      const after = classify(journal, ledger, await inspectObjects(tx))
      if (comparison.problems.length || comparison.appliedHead?.tag !== plan.adoption.head.tag || !["pending", "up-to-date"].includes(after.state)) {
        fail(EXIT.VERIFICATION_FAILED, "verificación", "El ledger adoptado no produce un historial coherente con el manifest; se revierte sin escribir nada.")
      }
      return { head: comparison.appliedHead, pending: comparison.pending, checks: after.manifest }
    })
    return { ...report, head: head.head, pendingAfter: head.pending, checks: head.checks, result: `ledger adoptado hasta ${head.head.tag}: ${plan.adoption.rows.length} fila(s), sin DDL de negocio` }
  } finally { await releaseMigrationLock(sql) }
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json")
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.on("SIGINT", abort)
  try {
    const options = parseArgs(["adopt", ...argv])
    const { code, result } = await runPromotion({ ...options, env: withRemoteEnvFile(options.target), signal: controller.signal }, { kind: "adopt-ledger", apply: applyAdoption })
    printPromotion(json, "adopt", code, result)
    return code
  } catch (error) {
    const code = controller.signal.aborted ? EXIT.INTERRUPTED : error instanceof BiblibError ? error.code : EXIT.SERVICE_UNAVAILABLE
    const result = { schemaVersion: 1, code, phase: error instanceof BiblibError ? error.phase : "adopción", correlation: randomUUID(), message: error instanceof BiblibError ? sanitize(error.message) : "No se pudo completar la adopción.", ...(error?.report?.reconciliation ? { reconciliation: error.report.reconciliation } : {}), ...(error?.record ? { record: error.record } : {}) }
    if (json) console.log(JSON.stringify(result))
    else {
      console.error(`Error [${result.phase}] (${code}): ${result.message}`)
      for (const line of result.reconciliation?.proposal ?? []) console.error(`  ${line}`)
      for (const item of result.reconciliation?.differences ?? []) console.error(`  - ${item.id}: ${item.message}`)
    }
    return code
  } finally { process.removeListener("SIGINT", abort) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

import path from "node:path"
import { pathToFileURL } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { createDeletionDatabase, createSupabaseDeletionServices, drainDeletions } from "../../lib/account-deletion/worker.ts"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { sanitize } from "../lib/process.mjs"
import { mergeSuppressions, readMarks } from "../lib/suppressions.mjs"
import { resolveSeedTarget } from "../db/seed-local.mjs"
import { closeConnection, connect, connectionError } from "../db/target.mjs"

// pnpm account:deletions:local [--profile main|scratch|test] [--once] [--interval-ms N] [--retry-failed] [--purge-marks] [--json] — U-OPS-03.
// Worker administrativo de eliminación de cuentas, fuera del proceso Next (que no tiene service_role): reclama las
// solicitudes vencidas y ejecuta sus pasos (sesiones, Storage, filas, identidad) con lease y fencing. Tras cada ciclo
// copia las marcas al registro privado de supresiones del perfil, que aplica db:restore:local. `--retry-failed`
// reanuda las que agotaron sus intentos; `--purge-marks` retira las marcas vencidas. No imprime IDs ni rutas.

const usage = "Uso: account:deletions:local [--profile main|scratch|test] [--once] [--interval-ms 1000-600000] [--retry-failed] [--purge-marks] [--json]."
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }

export function parseArgs(argv) {
  const options = { profile: "main", once: false, intervalMs: 10_000, retryFailed: false, purgeMarks: false, json: false }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (seen.has(flag)) fail(EXIT.INVALID_ARGS, "argumentos", usage)
    seen.add(flag)
    const next = argv[i + 1] ?? ""
    if (flag === "--profile" && ["main", "scratch", "test"].includes(next)) options.profile = argv[++i]
    else if (flag === "--once") options.once = true
    else if (flag === "--interval-ms" && /^\d+$/.test(next) && Number(next) >= 1_000 && Number(next) <= 600_000) options.intervalMs = Number(argv[++i])
    else if (flag === "--retry-failed") options.retryFailed = true
    else if (flag === "--purge-marks") options.purgeMarks = true
    else if (flag === "--json") options.json = true
    else fail(EXIT.INVALID_ARGS, "argumentos", usage)
  }
  return options
}

/** Resumen sin IDs: cuántas eliminaciones terminaron, esperan reintento, fallaron o perdieron su lease, y por qué. */
export function summarize(reports) {
  const outcomes = Object.fromEntries(["completed", "waiting_retry", "failed", "lease_lost"].map((outcome) => [outcome, reports.filter((report) => report.outcome === outcome).length]))
  const errors = {}
  for (const report of reports) if (report.errorCode) errors[report.errorCode] = (errors[report.errorCode] ?? 0) + 1
  return { processed: reports.length, ...outcomes, errors }
}

/** Un ciclo: reanudar fallidas si se pide, procesar las vencidas, retirar marcas vencidas y copiar las vigentes al registro. */
export async function runCycle({ sql, deps, stack, options, budgetMs = 60_000 }) {
  const retried = options.retryFailed ? Number((await sql`select biblib.account_deletion_retry(null) as n`)[0].n) : 0
  const reports = await drainDeletions(deps, { budgetMs })
  const purgedMarks = options.purgeMarks ? Number((await sql`select biblib.account_deletion_purge_marks(500) as n`)[0].n) : 0
  const ledger = mergeSuppressions(stack, await readMarks(sql))
  return { ...summarize(reports), retried, purgedMarks, ledgerEntries: ledger.length }
}

export async function main(argv = process.argv.slice(2), { out = process.stdout, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let sql
  const json = argv.includes("--json")
  try {
    const options = parseArgs(argv)
    if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") fail(EXIT.IDENTITY_MISMATCH, "objetivo", "El worker local de eliminación solo admite BIBLIB_TARGET=local.")
    const resolved = await resolveSeedTarget(options.profile)
    const values = resolved.target.env()
    if (!values.SUPABASE_SERVICE_ROLE_KEY) fail(EXIT.SERVICE_UNAVAILABLE, "credencial", "Falta la credencial administrativa local del perfil; no se imprime ni se guarda.")
    sql = connect(resolved, { applicationName: "biblib-account-deletion" })
    const [present] = await sql`select to_regprocedure('biblib.account_deletion_claim(uuid, integer)') is not null as found`
    if (!present.found) fail(EXIT.PLAN_REJECTED, "ledger", `El perfil no tiene la migración 0013; aplica db:plan:local y db:migrate:local con --profile ${options.profile}.`)
    const admin = createClient(values.SUPABASE_URL, values.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    const deps = { db: createDeletionDatabase(sql), ...createSupabaseDeletionServices(admin) }
    if (!options.once && !json) out.write(`Worker de eliminación de cuentas · perfil ${options.profile} · cada ${options.intervalMs} ms (Ctrl+C para parar)\n`)
    for (let first = true; ; first = false) {
      const summary = await runCycle({ sql, deps, stack: resolved.stack, options: { ...options, retryFailed: options.retryFailed && first, purgeMarks: options.purgeMarks && first } })
      const code = summary.failed || summary.waiting_retry ? EXIT.SERVICE_UNAVAILABLE : EXIT.OK
      if (json) out.write(`${JSON.stringify({ schemaVersion: 1, code, profile: options.profile, ...summary })}\n`)
      else {
        const errors = Object.entries(summary.errors).map(([name, count]) => `${name} ${count}`).join(", ")
        out.write(`${new Date().toISOString()} · eliminaciones ${summary.processed}: ${summary.completed} terminadas, ${summary.waiting_retry} a la espera de reintento, ${summary.failed} con revisión pendiente, ${summary.lease_lost} con lease perdido${errors ? ` (${errors})` : ""} · marcas en el registro ${summary.ledgerEntries}\n`)
      }
      if (options.once) return code
      await sleep(options.intervalMs)
    }
  } catch (error) {
    const known = error instanceof BiblibError ? error : connectionError(error, "eliminación")
    const result = { code: known.code, phase: known.phase, message: sanitize(known.message) }
    if (json) out.write(`${JSON.stringify(result)}\n`)
    else console.error(`Error [${result.phase}] (${result.code}): ${result.message}`)
    return result.code
  } finally {
    await closeConnection(sql)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.once("SIGINT", () => process.exit(EXIT.INTERRUPTED))
  process.exitCode = await main()
}

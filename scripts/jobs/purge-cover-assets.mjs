import path from "node:path"
import { pathToFileURL } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { COVERS_BUCKET } from "../lib/backup-db.mjs"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { sanitize } from "../lib/process.mjs"
import { resolveSeedTarget } from "../db/seed-local.mjs"
import { closeConnection, connect, connectionError } from "../db/target.mjs"

// pnpm assets:purge:local [--profile main|scratch|test] [--limit 1-1000] [--grace-seconds N] [--json] — U-DAT-10.
// Purga administrativa de portadas privadas de todas las cuentas, fuera del proceso Next (la app no
// tiene service_role): cuarentenas vencidas, licencias vencidas, assets sin fichas ni versiones
// anteriores que los citen tras el periodo de gracia y objetos sin asset registrado. Primero retira las
// filas que siguen siendo candidatas bajo bloqueo (biblib.cover_asset_purge_confirm) y después sus
// objetos, ya huérfanos. Sustituye en local al scheduler de F4; no imprime IDs ni rutas.

const usage = "Uso: assets:purge:local [--profile main|scratch|test] [--limit 1-1000] [--grace-seconds 0-2592000] [--json]."
const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }

export function parseArgs(argv) {
  const options = { profile: "main", limit: 200, graceSeconds: 86_400, json: false }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (seen.has(flag)) fail(EXIT.INVALID_ARGS, "argumentos", usage)
    seen.add(flag)
    const next = argv[i + 1] ?? ""
    if (flag === "--profile" && ["main", "scratch", "test"].includes(next)) options.profile = argv[++i]
    else if (flag === "--limit" && /^\d+$/.test(next) && Number(next) >= 1 && Number(next) <= 1000) options.limit = Number(argv[++i])
    else if (flag === "--grace-seconds" && /^\d+$/.test(next) && Number(next) <= 2_592_000) options.graceSeconds = Number(argv[++i])
    else if (flag === "--json") options.json = true
    else fail(EXIT.INVALID_ARGS, "argumentos", usage)
  }
  return options
}

/** Un lote: candidatos, confirmación bajo bloqueo y retirada de objetos. Devuelve solo cantidades. */
export async function purgeBatch({ sql, storage, limit, graceSeconds }) {
  const [{ result: candidates }] = await sql`select biblib.cover_asset_purge_candidates(null, ${limit}::integer, ${graceSeconds}::integer) as result`
  const ids = candidates.assets.map((asset) => asset.id)
  const [{ result: released }] = ids.length ? await sql`select biblib.cover_asset_purge_confirm(null, ${ids}::uuid[], ${graceSeconds}::integer) as result` : [{ result: [] }]
  const keys = [...new Set([...released, ...candidates.objects.map((object) => object.key)])]
  let removed = 0, failed = 0
  for (let offset = 0; offset < keys.length; offset += 100) {
    const { data, error } = await storage.remove(keys.slice(offset, offset + 100))
    if (error) failed += Math.min(100, keys.length - offset)
    else removed += data?.length ?? 0
  }
  const reasons = Object.fromEntries(["quarantine", "license", "unreferenced"].map((reason) => [reason, candidates.assets.filter((asset) => asset.reason === reason).length]))
  return { candidates: ids.length, assets: released.length, orphans: candidates.objects.length, objects: removed, failedObjects: failed, reasons }
}

export async function main(argv = process.argv.slice(2), { out = process.stdout } = {}) {
  let sql
  const json = argv.includes("--json")
  try {
    const options = parseArgs(argv)
    if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") fail(EXIT.IDENTITY_MISMATCH, "objetivo", "La purga local solo admite BIBLIB_TARGET=local.")
    const resolved = await resolveSeedTarget(options.profile)
    const values = resolved.target.env()
    if (!values.SUPABASE_SERVICE_ROLE_KEY) fail(EXIT.SERVICE_UNAVAILABLE, "storage", "Falta la credencial administrativa local del perfil; no se imprime ni se guarda.")
    const admin = createClient(values.SUPABASE_URL, values.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    sql = connect(resolved, { applicationName: "biblib-assets-purge" })
    const [present] = await sql`select to_regprocedure('biblib.cover_asset_purge_candidates(uuid, integer, integer)') is not null as found`
    if (!present.found) fail(EXIT.PLAN_REJECTED, "ledger", `El perfil no tiene la migración 0009; aplica db:plan:local y db:migrate:local con --profile ${options.profile}.`)
    const report = await purgeBatch({ sql, storage: admin.storage.from(COVERS_BUCKET), limit: options.limit, graceSeconds: options.graceSeconds })
    const summary = { schemaVersion: 1, code: report.failedObjects ? EXIT.SERVICE_UNAVAILABLE : EXIT.OK, profile: options.profile, ...report }
    if (json) out.write(`${JSON.stringify(summary)}\n`)
    else out.write(`Purga de portadas · ${options.profile} · ${report.assets} asset(s) retirados (${report.reasons.quarantine} en cuarentena vencida, ${report.reasons.license} con licencia vencida, ${report.reasons.unreferenced} sin referencias) · ${report.objects} objeto(s) retirados · ${report.failedObjects} pendiente(s)\n`)
    return summary.code
  } catch (error) {
    const known = error instanceof BiblibError ? error : connectionError(error, "purga")
    const result = { code: known.code, phase: known.phase, message: sanitize(known.message) }
    if (json) out.write(`${JSON.stringify(result)}\n`)
    else console.error(`Error [${result.phase}] (${result.code}): ${result.message}`)
    return result.code
  } finally {
    await closeConnection(sql)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

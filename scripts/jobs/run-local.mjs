import { createHmac } from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { getProfile } from "../lib/profiles.mjs"
import { loadTarget } from "../db/environment.mjs"

// pnpm jobs:run:local [--profile main|scratch|test] [--once] [--interval-ms N] — U-DAT-03.
// Ejecutor local de trabajos: llama a la entrada interna de la app del perfil (arrancada con
// dev:local o start:local) para que reclame y ejecute los pasos vencidos. Sustituye en local al
// scheduler de F4. No acepta URLs ni dueños: la app decide qué trabajo reclamar.

const LABEL = "biblib.jobs.runner.v1"
const usage = "Uso: jobs:run:local [--profile main|scratch|test] [--once] [--interval-ms 1000-600000]."

export function parseArgs(argv) {
  const options = { profile: "main", once: false, intervalMs: 5_000 }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (seen.has(flag)) throw new BiblibError(EXIT.INVALID_ARGS, "argumentos", usage)
    seen.add(flag)
    if (flag === "--profile" && ["main", "scratch", "test"].includes(argv[i + 1])) options.profile = argv[++i]
    else if (flag === "--once") options.once = true
    else if (flag === "--interval-ms" && /^\d+$/.test(argv[i + 1] ?? "") && Number(argv[i + 1]) >= 1_000 && Number(argv[i + 1]) <= 600_000) options.intervalMs = Number(argv[++i])
    else throw new BiblibError(EXIT.INVALID_ARGS, "argumentos", usage)
  }
  return options
}

/** Misma derivación que lib/jobs/runner-auth.ts: secreto explícito o HMAC de la URL de la base. */
export function runnerToken(env) {
  const explicit = env.BIBLIB_JOBS_RUNNER_SECRET
  if (explicit) return explicit.length >= 32 ? explicit : null
  return env.SUPABASE_DB_URL ? createHmac("sha256", env.SUPABASE_DB_URL).update(LABEL).digest("base64url") : null
}

/** Un disparo: devuelve el resumen de la app o lanza con el código de salida adecuado. */
export async function runOnce({ url, token, fetchImpl = fetch }) {
  let response
  try {
    response = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) })
  } catch {
    throw new BiblibError(EXIT.SERVICE_UNAVAILABLE, "app", `La app no responde en ${new URL(url).origin}; arráncala con pnpm dev:local o start:local para este perfil.`)
  }
  if (response.status === 401) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "token", "La app rechazó el token del ejecutor: no corresponde a este perfil o usa otro BIBLIB_JOBS_RUNNER_SECRET.")
  if (!response.ok) throw new BiblibError(EXIT.SERVICE_UNAVAILABLE, "app", `El ejecutor respondió ${response.status}; se reintentará en el siguiente ciclo.`)
  const body = await response.json()
  return { steps: Number(body.steps) || 0, leaseLost: Number(body.leaseLost) || 0, failed: Number(body.failed) || 0 }
}

export async function main(argv = process.argv.slice(2), { env = process.env, out = process.stdout, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  try {
    const options = parseArgs(argv)
    if (env.BIBLIB_TARGET && env.BIBLIB_TARGET !== "local") throw new BiblibError(EXIT.IDENTITY_MISMATCH, "objetivo", "El ejecutor local solo admite BIBLIB_TARGET=local.")
    const target = loadTarget("local", { profile: options.profile })
    const token = runnerToken({ ...target.env(), BIBLIB_JOBS_RUNNER_SECRET: env.BIBLIB_JOBS_RUNNER_SECRET })
    if (!token) throw new BiblibError(EXIT.MISSING_REQUIREMENT, "token", "No se pudo derivar el token del ejecutor (falta la conexión del perfil o el secreto es demasiado corto).")
    const app = getProfile(options.profile).app
    const url = `http://${app.host}:${app.port}/api/internal/jobs/run`
    out.write(`Ejecutor local de trabajos · perfil ${options.profile} · ${app.host}:${app.port}${options.once ? "" : ` · cada ${options.intervalMs} ms (Ctrl+C para parar)`}\n`)
    for (;;) {
      try {
        const summary = await runOnce({ url, token, fetchImpl })
        out.write(`${new Date().toISOString()} · pasos ${summary.steps} · leases perdidos ${summary.leaseLost} · fallidos ${summary.failed}\n`)
      } catch (error) {
        if (options.once || !(error instanceof BiblibError) || error.code !== EXIT.SERVICE_UNAVAILABLE) throw error
        out.write(`${new Date().toISOString()} · ${error.message}\n`)
      }
      if (options.once) return EXIT.OK
      await sleep(options.intervalMs)
    }
  } catch (error) {
    console.error(`Error [${error instanceof BiblibError ? error.phase : "ejecutor"}]: ${error instanceof BiblibError ? error.message : "Fallo inesperado del ejecutor local."}`)
    return error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.once("SIGINT", () => process.exit(EXIT.INTERRUPTED))
  process.exitCode = await main()
}

import { execFileSync, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, readdirSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { BiblibError, EXIT } from "../../../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../../../scripts/lib/profiles.mjs"
import { loadCensus, resolveSeedTarget } from "../../../../scripts/db/seed-local.mjs"
import { readFixtureStore } from "../../../../scripts/db/fixture-store.mjs"
import { closeConnection, connect } from "../../../../scripts/db/target.mjs"

// Contexto del grupo catalogue (U-DAT-05): Postgres real del perfil scratch o test, cuentas A/B del
// seed y procesos Node independientes que ejecutan el gateway compilado. Sin red externa: cada
// proceso usa un fetch simulado que solo registra claves ficticias.

export const PROFILES = ["scratch", "test"]
const WORKER = fileURLToPath(new URL("./worker.mjs", import.meta.url))
const SOURCES = path.join(REPO_ROOT, "lib", "bibliographic-catalog")
const BUILD = path.join(REPO_ROOT, ".next", "tests", "lib", "bibliographic-catalog")

export function catalogueProfile() {
  const profile = process.env.BIBLIB_PROFILE || "test"
  if (!PROFILES.includes(profile)) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo catalogue solo usa los perfiles scratch o test.")
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") throw new BiblibError(EXIT.IDENTITY_MISMATCH, "suite", "El grupo catalogue solo admite BIBLIB_TARGET=local.")
  return profile
}

function newest(dir) {
  let latest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    latest = Math.max(latest, entry.isDirectory() ? newest(file) : entry.name.endsWith(".ts") ? statSync(file).mtimeMs : 0)
  }
  return latest
}

/** Compila las pruebas TS (incluye el gateway) si el build falta o es anterior a las fuentes. */
export function ensureCompiled() {
  const built = path.join(BUILD, "gateway.js")
  if (existsSync(built) && statSync(built).mtimeMs >= newest(SOURCES)) return
  execFileSync(process.execPath, [path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.tests.json"], { cwd: REPO_ROOT, stdio: "ignore", windowsHide: true })
}

export async function catalogueContext() {
  const profile = catalogueProfile()
  ensureCompiled()
  const resolved = await resolveSeedTarget(profile)
  const store = readFixtureStore(resolved, loadCensus())
  if (!store?.accounts?.a?.id || !store?.accounts?.b?.id || store.phase !== "completado") throw new BiblibError(EXIT.SEED_FAILED, "suite", `Faltan fixtures A/B completos; ejecuta pnpm db:seed:local --profile ${profile}.`)
  const sql = connect(resolved, { applicationName: "biblib-catalogue-tests" })
  // Ámbito de credencial propio del run: cubos, reservas y caché no se mezclan con nada más.
  const scope = `qa-${randomBytes(6).toString("hex")}`
  return {
    profile, resolved, sql, scope,
    env: resolved.target.env(),
    users: { a: store.accounts.a.id, b: store.accounts.b.id },
    async cleanup() {
      await sql`delete from biblib.catalogue_cache where credential_scope = ${scope}`
      await sql`delete from biblib.catalogue_inflight where credential_scope = ${scope}`
      await sql`delete from biblib.catalogue_private_cache where credential_scope = ${scope}`
      await sql`delete from biblib.catalogue_quota_buckets where credential_scope = ${scope}`
    },
    async close() { await closeConnection(sql) },
  }
}

/** Versión publicada de la política de derechos, leída del módulo compilado (no se duplica aquí). */
export function policyVersion(provider) {
  return createRequire(import.meta.url)(path.join(BUILD, "rights.js")).providerRightsPolicy(provider).version
}

/** ISBN-13 sintético válido (prefijo 979-0-0000, sin correspondencia con libros reales). */
export function fakeIsbn(n) {
  const body = `97900009${String(n).padStart(4, "0")}`
  const sum = [...body].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0)
  return `${body}${(10 - (sum % 10)) % 10}`
}

/**
 * Lanza un proceso Node distinto con el gateway compilado. La URL de la base local viaja por
 * variable de entorno al hijo y nunca se imprime; el hijo responde con una línea JSON.
 */
export function runWorker(ctx, task, { dbUrl } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, BIBLIB_CATALOGUE_TEST_DB_URL: dbUrl ?? ctx.env.SUPABASE_DB_URL }
    const child = spawn(process.execPath, [WORKER, JSON.stringify({ scope: ctx.scope, ...task })], { cwd: REPO_ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { err += chunk })
    const timer = setTimeout(() => child.kill(), 60_000)
    child.once("error", reject)
    child.once("close", (code) => {
      clearTimeout(timer)
      const line = out.trim().split("\n").at(-1)
      try { resolve({ code, ...JSON.parse(line) }) } catch { reject(new Error(`El proceso de prueba no devolvió JSON (código ${code}): ${err.split("\n").slice(0, 3).join(" ").slice(0, 300)}`)) }
    })
  })
}

/** Instante común de arranque para que varios procesos compitan de verdad. */
export const startAt = (delayMs = 1500) => Date.now() + delayMs

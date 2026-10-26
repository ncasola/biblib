import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { closeSync, existsSync, lstatSync, openSync, readSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { getProfile, profilePorts, profileWorkdir, REPO_ROOT, rootFingerprint } from "../lib/profiles.mjs"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"

const TARGETS = new Set(["local", "test", "preprod", "prod"])
const INPUT_KEYS = [
  "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL",
  "BIBLIB_EXPECT_PROJECT_REF", "BIBLIB_PROJECT_ID", "BIBLIB_CATALOGUE_MODE",
  "NEXT_PUBLIC_ENABLE_ANALYTICS", "GOOGLE_BOOKS_API_KEY", "OPEN_LIBRARY_CONTACT",
]
const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const fail = (message, code = EXIT.IDENTITY_MISMATCH) => { throw new BiblibError(code, "objetivo", message) }

export function validateTarget(target) {
  if (!TARGETS.has(target)) fail("Indica un objetivo explícito: local, test, preprod o prod.", EXIT.INVALID_ARGS)
  return target
}

// Lista cerrada para que un harness pueda construir un objeto propio desde entradas inyectadas.
export function targetInputs(env) {
  return Object.fromEntries(INPUT_KEYS.filter((key) => typeof env[key] === "string").map((key) => [key, env[key]]))
}

function cleanInheritedEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|DATABASE_URL$|PG|POSTGRES_|BIBLIB_|GOOGLE_BOOKS_API_KEY$|OPEN_LIBRARY_CONTACT$|NEXT_PUBLIC_ENABLE_ANALYTICS$|NEXT_PUBLIC_BIBLIB_)/i.test(key)))
}

function url(value, protocols) {
  try {
    const parsed = new URL(value)
    if (!protocols.includes(parsed.protocol) || parsed.search || parsed.hash) throw new Error()
    return parsed
  } catch {
    fail("La configuración requiere URLs válidas de Supabase y Postgres.", EXIT.INVALID_ARGS)
  }
}

function marker(ctx) {
  return `# biblib:generated target=local profile=${ctx.profile} root=${rootFingerprint({ root: ctx.cwd }).hash}`
}

// Solo se inspecciona la cabecera antes de acreditar un archivo; nunca se muestra su contenido.
function hasMarker(file, ctx) {
  if (lstatSync(file).isSymbolicLink()) return false
  const fd = openSync(file, "r")
  try {
    const buffer = Buffer.alloc(256)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, length).toString("utf8").split(/\r?\n/, 1)[0] === marker(ctx)
  } finally { closeSync(fd) }
}

function transition() {
  fail("Hay un archivo de entorno sin acreditar para este objetivo. Consérvalo fuera del camino de carga (por ejemplo, .biblib/remote/preprod.env) y genera la configuración local de BibLib; no se ha movido ni sobrescrito ningún archivo.")
}

function parseLocalFile(file, ctx) {
  if (!hasMarker(file, ctx)) transition()
  const values = {}
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue
    const entry = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!entry || !INPUT_KEYS.includes(entry[1])) transition()
    let value = entry[2]
    if (value.startsWith('"')) {
      try { value = JSON.parse(value) } catch { transition() }
    }
    if (typeof value !== "string" || /[\r\n$`]/.test(value) || Object.hasOwn(values, entry[1])) transition()
    values[entry[1]] = value
  }
  return values
}

function envFiles(ctx, mode) {
  const nodeMode = ({ dev: "development", build: "production", start: "production", cli: "development" })[mode] ?? mode
  if (!["development", "production", "test"].includes(nodeMode)) fail("Modo de carga de entorno desconocido.", EXIT.INVALID_ARGS)
  const nextFiles = [`.env.${nodeMode}.local`, ...(nodeMode === "test" ? [] : [".env.local"]), `.env.${nodeMode}`, ".env"]
  const workdir = profileWorkdir(ctx.profile, { root: ctx.cwd })
  return [...new Set([
    ...nextFiles.map((file) => path.join(ctx.cwd, file)),
    path.join(ctx.cwd, "supabase/.env"), path.join(workdir, ".env"), path.join(workdir, "supabase/.env"),
  ])]
}

export function assertNoForeignEnvFiles(ctx, { mode = "development" } = {}) {
  for (const file of envFiles(ctx, mode)) {
    if (!existsSync(file)) continue
    if (ctx.target !== "local") transition()
    const values = parseLocalFile(file, ctx)
    const selected = ctx.env?.()
    if (selected && Object.entries(values).some(([key, value]) => selected[key] !== value)) transition()
  }
}

function localStatus(ctx) {
  assertNoForeignEnvFiles(ctx, { mode: "cli" })
  const workdir = profileWorkdir(ctx.profile, { root: ctx.cwd })
  if (!existsSync(path.join(workdir, "supabase/config.toml"))) {
    fail("Falta el workdir del perfil. Prepara el stack propio y su configuración antes de usar el objetivo local.", EXIT.MISSING_REQUIREMENT)
  }
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "node_modules/supabase/dist/supabase.js"), "status", "--workdir", workdir, "--output", "json"], {
    cwd: workdir, env: cleanInheritedEnv(process.env), encoding: "utf8", windowsHide: true, timeout: 15000,
  })
  if (result.error || result.status !== 0) fail("No se puede consultar el estado del perfil local; comprueba su stack con el diagnóstico local.", EXIT.SERVICE_UNAVAILABLE)
  try {
    const status = JSON.parse(result.stdout)
    return {
      NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
      SUPABASE_DB_URL: status.DB_URL,
      ...(status.SERVICE_ROLE_KEY ? { SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY } : {}),
    }
  } catch { fail("El estado del perfil local no tiene el formato esperado.", EXIT.SERVICE_UNAVAILABLE) }
}

/** Resuelve y valida la identidad antes de crear clientes o abrir conexiones. */
export function loadTarget(target, { profile, env = process.env, cwd = REPO_ROOT } = {}) {
  validateTarget(target)
  if (!env || typeof env !== "object" || Array.isArray(env)) fail("El entorno debe ser un objeto de variables explícitas.", EXIT.INVALID_ARGS)
  if (target === "test" && env === process.env) fail("El objetivo test exige un objeto env construido explícitamente por el harness.", EXIT.INVALID_ARGS)
  profile ??= target === "test" ? "test" : "main"
  const definition = getProfile(profile, { root: cwd })
  const base = { target, profile, cwd: path.resolve(cwd) }
  let selected
  if (target === "local") {
    const file = path.join(base.cwd, ".env.local")
    selected = existsSync(file) ? parseLocalFile(file, base) : localStatus(base)
  } else selected = targetInputs(env)

  const api = url(selected.NEXT_PUBLIC_SUPABASE_URL || selected.SUPABASE_URL, ["http:", "https:"])
  const db = url(selected.SUPABASE_DB_URL, ["postgres:", "postgresql:"])
  const anonKey = selected.NEXT_PUBLIC_SUPABASE_ANON_KEY || selected.SUPABASE_ANON_KEY
  if (!anonKey || /[\r\n$`]/.test(anonKey)) fail("Falta una clave pública válida de Supabase.", EXIT.INVALID_ARGS)
  if (api.username || api.password || api.pathname !== "/") fail("La URL pública debe identificar únicamente el origen de Supabase.")
  if (!db.hostname || !db.username || !db.pathname.slice(1)) fail("La URL de Postgres está incompleta.", EXIT.INVALID_ARGS)
  if (selected.SUPABASE_URL && selected.SUPABASE_URL !== api.origin) fail("Las URLs públicas de Supabase no coinciden.")

  let project = selected.BIBLIB_PROJECT_ID || definition.projectId
  if (!/^[a-z][a-z0-9-]{1,80}$/.test(project)) fail("El identificador del proyecto no es válido.", EXIT.INVALID_ARGS)
  if (target === "local") {
    const ports = profilePorts(profile, { root: cwd })
    if (api.origin !== `http://127.0.0.1:${ports.api}` || db.hostname !== "127.0.0.1" || Number(db.port) !== ports.db || db.pathname !== "/postgres" || db.username !== "postgres" || db.password !== "postgres") {
      fail("Los endpoints locales no corresponden exactamente al perfil seleccionado; localhost por sí solo no acredita un stack.")
    }
    project = definition.projectId
  } else if (target === "preprod" || target === "prod") {
    const ref = selected.BIBLIB_EXPECT_PROJECT_REF
    if (!ref || !/^[a-z0-9-]+$/.test(ref)) fail("Falta BIBLIB_EXPECT_PROJECT_REF válido para el objetivo remoto.", EXIT.INVALID_ARGS)
    if (api.origin !== `https://${ref}.supabase.co` || !(db.hostname === `db.${ref}.supabase.co` || (db.hostname.endsWith(".pooler.supabase.com") && db.username === `postgres.${ref}`))) {
      fail("La identidad inyectada no corresponde a la referencia de proyecto esperada.")
    }
    project = ref
  }
  const catalogueMode = selected.BIBLIB_CATALOGUE_MODE || (["local", "test"].includes(target) ? "fixture" : "live")
  if (!["fixture", "live"].includes(catalogueMode)) fail("BIBLIB_CATALOGUE_MODE debe ser fixture o live.", EXIT.INVALID_ARGS)
  const values = {
    ...selected,
    SUPABASE_URL: api.origin, NEXT_PUBLIC_SUPABASE_URL: api.origin,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey, SUPABASE_ANON_KEY: anonKey,
    SUPABASE_DB_URL: selected.SUPABASE_DB_URL,
    BIBLIB_TARGET: target, BIBLIB_PROFILE: profile, BIBLIB_CATALOGUE_MODE: catalogueMode,
    NEXT_PUBLIC_ENABLE_ANALYTICS: selected.NEXT_PUBLIC_ENABLE_ANALYTICS === "true" ? "true" : "false",
    GOOGLE_BOOKS_API_KEY: catalogueMode === "live" ? selected.GOOGLE_BOOKS_API_KEY || "" : "",
    OPEN_LIBRARY_CONTACT: catalogueMode === "live" ? selected.OPEN_LIBRARY_CONTACT || "" : "",
  }
  const identity = {
    target, project, host: db.hostname, port: Number(db.port || 5432), database: decodeURIComponent(db.pathname.slice(1)),
    profileRoot: `${rootFingerprint({ root: cwd }).hash}/${profile}`,
  }
  const fingerprint = sha(identity)
  // La clave pública también queda vinculada al artefacto, pero solo se persiste su hash.
  const publicFingerprint = sha({ fingerprint, api: api.origin, anonKey, analytics: values.NEXT_PUBLIC_ENABLE_ANALYTICS })
  return Object.freeze({
    ...base, fingerprint, publicFingerprint,
    env: () => ({ ...values }),
    redacted: () => ({ target, profile, project, fingerprint, publicFingerprint, root: identity.profileRoot }),
  })
}

// Primera puerta del formulario local: solo se compila en local/test; en cualquier otro objetivo queda vacía.
export const LOCAL_LOGIN_BUILD_VARIABLE = "NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN"

export function childEnv(ctx) {
  return {
    ...cleanInheritedEnv(process.env), ...ctx.env(),
    [LOCAL_LOGIN_BUILD_VARIABLE]: ["local", "test"].includes(ctx.target) ? "1" : "",
  }
}

// U-OPS-04: credenciales que el proceso de la app no recibe nunca. Solo las usan seed, fixtures,
// copias y verificaciones, que las obtienen de su propio loadTarget fuera de Next.
export const APP_EXCLUDED_KEYS = Object.freeze(["SUPABASE_SERVICE_ROLE_KEY"])

/**
 * Entorno del proceso de Next (dev/build/start). Las claves excluidas se fijan vacías: además de no
 * heredarse, impiden que Next las cargue después desde un .env.local de main generado con ellas.
 */
export function appEnv(ctx) {
  const env = childEnv(ctx)
  for (const key of APP_EXCLUDED_KEYS) env[key] = ""
  return env
}

export function writeLocalEnvFile(ctx) {
  if (ctx.target !== "local") fail("Solo se puede generar .env.local para el objetivo local.")
  const file = path.join(ctx.cwd, ".env.local")
  if (existsSync(file) && !hasMarker(file, ctx)) transition()
  const values = ctx.env()
  // Next también carga .env.local en un `pnpm build` sin objetivo, donde el catálogo ficticio se rechaza.
  // «fixture» es lo que los wrappers ya deducen para local, así que solo se escribe un modo elegido a mano.
  const written = INPUT_KEYS.filter((key) => Object.hasOwn(values, key) && !(key === "BIBLIB_CATALOGUE_MODE" && values[key] === "fixture"))
  const content = [marker(ctx), ...written.map((key) => `${key}=${JSON.stringify(values[key])}`), ""].join("\n")
  writeFileSync(file, content, { encoding: "utf8", mode: 0o600, flag: existsSync(file) ? "w" : "wx" })
  return file
}

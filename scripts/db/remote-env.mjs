import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"

// Configuración privada del destino remoto para los comandos de promoción (`db:*:preprod|prod`).
// `.biblib/remote/<objetivo>.env` está fuera de Git y fuera del camino de carga de Next. Solo admite
// las claves que necesita la promoción; nunca se imprime su contenido.

export const REMOTE_ENV_KEYS = Object.freeze([
  "BIBLIB_EXPECT_PROJECT_REF", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_DB_URL", "SUPABASE_DB_SSLMODE", "SUPABASE_DB_SSLROOTCERT",
])
const VERCEL_ENVIRONMENT = Object.freeze({ preprod: "preview", prod: "production" })
const POOLER_HOST = /^[a-z0-9-]+\.pooler\.supabase\.com$/
const fail = (code, message) => { throw new BiblibError(code, "configuración remota", message) }
const relative = (root, file) => path.relative(root, file).split(path.sep).join("/")

export function remoteEnvFile(target, root = REPO_ROOT) {
  return path.join(root, ".biblib", "remote", `${target}.env`)
}

/** CA del proveedor junto al archivo (`<objetivo>-ca.crt`), descargada del panel de Supabase. */
export function remoteCaFile(target, root = REPO_ROOT) {
  return path.join(root, ".biblib", "remote", `${target}-ca.crt`)
}

export function parseRemoteEnv(text, label) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const entry = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!entry) fail(EXIT.INVALID_ARGS, `${label} tiene una línea que no es CLAVE=valor.`)
    if (!REMOTE_ENV_KEYS.includes(entry[1])) fail(EXIT.INVALID_ARGS, `${label} contiene ${entry[1]}, que no es una clave de promoción (${REMOTE_ENV_KEYS.join(", ")}).`)
    let value = entry[2]
    if (value.startsWith('"')) {
      try { value = JSON.parse(value) } catch { fail(EXIT.INVALID_ARGS, `${label}: el valor de ${entry[1]} no es una cadena entre comillas válida.`) }
    }
    if (typeof value !== "string" || /[\r\n$`]/.test(value)) fail(EXIT.INVALID_ARGS, `${label}: el valor de ${entry[1]} no es válido.`)
    if (Object.hasOwn(values, entry[1])) fail(EXIT.INVALID_ARGS, `${label} repite ${entry[1]}.`)
    values[entry[1]] = value
  }
  return values
}

/**
 * Devuelve el entorno para un comando de promoción. Sin archivo, el de la sesión tal cual. Con archivo,
 * el de la sesión sin claves de destino más las del archivo; si la sesión ya inyecta alguna, se rechaza
 * para no mezclar dos fuentes.
 */
export function withRemoteEnvFile(target, { env = process.env, root = REPO_ROOT } = {}) {
  const file = remoteEnvFile(target, root)
  if (!existsSync(file)) return env
  const label = relative(root, file)
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(EXIT.IDENTITY_MISMATCH, `${label} debe ser un archivo regular, no un enlace.`)
  if (process.platform !== "win32" && (stat.mode & 0o077)) fail(EXIT.IDENTITY_MISMATCH, `${label} es legible por otros usuarios: aplica chmod 600.`)
  const injected = REMOTE_ENV_KEYS.filter((key) => typeof env[key] === "string" && env[key] !== "")
  if (injected.length) fail(EXIT.INVALID_ARGS, `Hay variables del destino en la sesión (${injected.join(", ")}) y también ${label}: usa una sola fuente.`)
  const values = parseRemoteEnv(readFileSync(file, "utf8"), label)
  const cert = values.SUPABASE_DB_SSLROOTCERT
  if (cert && !path.isAbsolute(cert)) values.SUPABASE_DB_SSLROOTCERT = path.resolve(path.dirname(file), cert)
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => !REMOTE_ENV_KEYS.includes(key))), ...values }
}

/**
 * Construye el archivo a partir de las variables del proyecto en Vercel. La conexión de la aplicación
 * suele ser el pooler en modo transacción (6543); la promoción exige el modo sesión del mismo pooler
 * (5432) con la misma credencial, así que solo se cambia el puerto.
 */
export function remoteEnvFromVercel(target, pulled, { root = REPO_ROOT } = {}) {
  const publicUrl = pulled.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = pulled.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const dbUrl = pulled.SUPABASE_DB_URL
  const missing = [["NEXT_PUBLIC_SUPABASE_URL", publicUrl], ["NEXT_PUBLIC_SUPABASE_ANON_KEY", anonKey], ["SUPABASE_DB_URL", dbUrl]].filter(([, value]) => !value).map(([key]) => key)
  if (missing.length) fail(EXIT.INVALID_ARGS,`Vercel no devolvió ${missing.join(", ")} para ${VERCEL_ENVIRONMENT[target]}. Si están marcadas como sensibles no se pueden descargar: escríbelas a mano en ${relative(root, remoteEnvFile(target, root))}.`)
  let ref, db
  try {
    ref = /^([a-z0-9]{6,40})\.supabase\.co$/.exec(new URL(publicUrl).hostname)?.[1]
    db = new URL(dbUrl)
  } catch { fail(EXIT.INVALID_ARGS, "Las URL de Supabase descargadas de Vercel no son válidas.") }
  if (!ref) fail(EXIT.INVALID_ARGS, "NEXT_PUBLIC_SUPABASE_URL no tiene la forma https://<ref>.supabase.co.")
  const notes = []
  if (POOLER_HOST.test(db.hostname) && db.port === "6543") {
    db.port = "5432"
    notes.push("SUPABASE_DB_URL usa el pooler en modo sesión (5432) en lugar del de transacción (6543) de la aplicación.")
  }
  db.search = ""
  const values = {
    BIBLIB_EXPECT_PROJECT_REF: ref,
    NEXT_PUBLIC_SUPABASE_URL: publicUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
    SUPABASE_DB_URL: db.toString(),
    SUPABASE_DB_SSLMODE: "verify-full",
  }
  const ca = remoteCaFile(target, root)
  if (existsSync(ca)) values.SUPABASE_DB_SSLROOTCERT = path.basename(ca)
  else notes.push(`Sin ${relative(root, ca)}: se usarán las CA del sistema. Si la verificación TLS falla, descarga el certificado del panel de Supabase (Database → SSL) a esa ruta y repite.`)
  return { ref, values, notes }
}

export function writeRemoteEnv(target, values, { root = REPO_ROOT } = {}) {
  const file = remoteEnvFile(target, root)
  mkdirSync(path.dirname(file), { recursive: true })
  const body = [
    `# biblib:remote target=${target}. Privado: fuera de Git y de Next. Generado por pnpm db:remote-env:${target}.`,
    ...REMOTE_ENV_KEYS.filter((key) => values[key] !== undefined).map((key) => `${key}=${JSON.stringify(values[key])}`),
    "",
  ].join("\n")
  writeFileSync(file, body, { mode: 0o600 })
  if (process.platform !== "win32") chmodSync(file, 0o600)
  return file
}

function pullFromVercel(target, root) {
  const folder = mkdtempSync(path.join(os.tmpdir(), "biblib-vercel-"))
  const pulled = path.join(folder, "pulled.env")
  try {
    // En Windows `vercel` es un .cmd y necesita shell; la orden va entera para no pasar argumentos sin escapar.
    const args = ["env", "pull", pulled, "--environment", VERCEL_ENVIRONMENT[target], "--yes"]
    const result = process.platform === "win32"
      ? spawnSync(`vercel ${args.map((arg) => `"${arg}"`).join(" ")}`, { cwd: root, stdio: ["ignore", "ignore", "inherit"], shell: true, windowsHide: true })
      : spawnSync("vercel", args, { cwd: root, stdio: ["ignore", "ignore", "inherit"] })
    if (result.status !== 0 || !existsSync(pulled)) fail(EXIT.SERVICE_UNAVAILABLE, "vercel env pull falló. Comprueba `vercel whoami` y que el repo esté enlazado (`vercel link`).")
    const values = {}
    for (const line of readFileSync(pulled, "utf8").split(/\r?\n/)) {
      const entry = /^(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_DB_URL)=(.*)$/.exec(line)
      if (!entry) continue
      try { values[entry[1]] = entry[2].startsWith('"') ? JSON.parse(entry[2]) : entry[2] } catch { /* se trata como ausente */ }
    }
    return values
  } finally { rmSync(folder, { recursive: true, force: true }) }
}

export async function main(argv = process.argv.slice(2), { root = REPO_ROOT } = {}) {
  const target = argv[0]
  try {
    if (!Object.hasOwn(VERCEL_ENVIRONMENT, target)) fail(EXIT.INVALID_ARGS, "Uso: node scripts/db/remote-env.mjs <preprod|prod>")
    const { ref, values, notes } = remoteEnvFromVercel(target, pullFromVercel(target, root), { root })
    const file = writeRemoteEnv(target, values, { root })
    console.log(`Escrito ${relative(root, file)} (proyecto ${ref}), sin mostrar valores.`)
    for (const note of notes) console.log(`- ${note}`)
    console.log(`Siguiente: pnpm db:status:${target} --expect-project ${ref}`)
    return EXIT.OK
  } catch (error) {
    const code = error instanceof BiblibError ? error.code : EXIT.SERVICE_UNAVAILABLE
    console.error(`Error (${code}): ${error instanceof BiblibError ? error.message : "No se pudo preparar la configuración remota."}`)
    return code
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

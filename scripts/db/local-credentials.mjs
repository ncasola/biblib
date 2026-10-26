import path from "node:path"
import { pathToFileURL } from "node:url"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { loadCensus, resolveSeedTarget } from "./seed-local.mjs"
import { readFixtureStore } from "./fixture-store.mjs"

const USAGE = "Uso: db:local:credentials --as a|b [--profile main|test|scratch]."

export function parseCredentialArgs(argv) {
  let as, profile = process.env.BIBLIB_PROFILE || "main"
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = argv[++i]
    if (seen.has(flag)) throw new BiblibError(EXIT.INVALID_ARGS, "argumentos", "Argumento repetido.")
    seen.add(flag)
    if (flag === "--as" && ["a", "b"].includes(value)) as = value
    else if (flag === "--profile" && ["main", "test", "scratch"].includes(value)) profile = value
    else throw new BiblibError(EXIT.INVALID_ARGS, "argumentos", USAGE)
  }
  if (!as) throw new BiblibError(EXIT.INVALID_ARGS, "argumentos", USAGE)
  return { as, profile }
}

/**
 * Muestra el correo y la contraseña de una cuenta ficticia A/B solo en una terminal interactiva.
 * Sin salida JSON y sin escribir en ningún archivo: si stdout está redirigido, se rechaza.
 */
export async function showCredentials(argv = process.argv.slice(2), deps = {}) {
  const { as, profile } = parseCredentialArgs(argv)
  const out = deps.out ?? process.stdout
  const err = deps.err ?? process.stderr
  if (!out.isTTY) throw new BiblibError(EXIT.INVALID_ARGS, "salida", "Las credenciales solo se muestran en una terminal interactiva; no redirijas la salida a un archivo ni a un registro.")
  if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") throw new BiblibError(EXIT.IDENTITY_MISMATCH, "sesión", "Las credenciales solo existen para las cuentas A/B del perfil local.")
  const resolved = await (deps.resolve ?? resolveSeedTarget)(profile, {})
  const store = (deps.read ?? readFixtureStore)(resolved, (deps.census ?? loadCensus)())
  const account = store?.accounts?.[as]
  if (!account?.email || !account.password) throw new BiblibError(EXIT.SEED_FAILED, "sesión", "Faltan fixtures registrados; ejecuta db:seed:local para este perfil.")
  err.write(`Aviso: credencial de la cuenta ficticia ${as.toUpperCase()} (${profile}) para el formulario «Acceso local de desarrollo». No la copies a informes, capturas ni registros.\n`)
  out.write(`Correo: ${account.email}\nContraseña: ${account.password}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await showCredentials() } catch (error) {
    console.error(error instanceof BiblibError ? error.message : "No se pudieron mostrar las credenciales locales.")
    process.exitCode = error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
  }
}

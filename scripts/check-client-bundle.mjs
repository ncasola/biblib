import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { REPO_ROOT } from "./lib/profiles.mjs"
import { BiblibError, EXIT } from "./lib/exit-codes.mjs"
import { distDir } from "./next-target.mjs"

const patterns = [
  /postgres(?:ql)?:\/\/[^\s"'<>]+/i,
  /service_role/i,
  /GOOGLE_BOOKS_API_KEY/,
  /SUPABASE_DB_URL/,
]

// Literales únicos del formulario de acceso local (app/(auth)/login/local-password-form.tsx).
// Con --forbid-local-login ninguno puede aparecer en un build remoto o sin objetivo.
const localLoginLiterals = ["biblib-local-password-form", "Acceso local de desarrollo", "signInWithLocalPasswordAction"]

export function checkClientBundle(directory, { forbidLocalLogin = false } = {}) {
  const root = path.join(directory, "static")
  if (!existsSync(root)) throw new BiblibError(EXIT.INVALID_ARGS, "bundle", "No existe el directorio static del build indicado.")
  const findings = []
  const localLoginFindings = []
  let count = 0
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) {
        count++
        const content = readFileSync(file, "utf8")
        if (forbidLocalLogin && localLoginLiterals.some((literal) => content.includes(literal))) localLoginFindings.push(path.relative(root, file))
        if (patterns.some((pattern) => pattern.test(content))) findings.push(path.relative(root, file))
        // También se detecta el rol dentro de un JWT administrativo, sin mostrar el token.
        else if ([...content.matchAll(/eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)].some((match) => {
          try { return JSON.parse(Buffer.from(match[1], "base64url").toString()).role === "service_role" } catch { return false }
        })) findings.push(path.relative(root, file))
      }
    }
  }
  visit(root)
  if (findings.length) throw new BiblibError(EXIT.VERIFICATION_FAILED, "bundle", `Se detectaron referencias privadas en ${findings.length} archivos del bundle cliente; revisa los imports de servidor sin publicar su contenido.`)
  if (localLoginFindings.length) throw new BiblibError(EXIT.VERIFICATION_FAILED, "bundle", `El formulario de acceso local está presente en ${localLoginFindings.length} archivos del bundle cliente; este build no debe incluirlo.`)
  return { files: count, clean: true }
}

export function parseBundleArgs(args) {
  const usage = "Uso: check-client-bundle.mjs [--dist-dir directorio] [--forbid-local-login]."
  const options = { distDir: undefined, forbidLocalLogin: false }
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (seen.has(flag)) throw new BiblibError(EXIT.INVALID_ARGS, "argumentos", usage)
    seen.add(flag)
    if (flag === "--forbid-local-login") options.forbidLocalLogin = true
    else if (flag === "--dist-dir" && args[i + 1] && !args[i + 1].startsWith("--")) options.distDir = args[++i]
    else throw new BiblibError(EXIT.INVALID_ARGS, "argumentos", usage)
  }
  return options
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseBundleArgs(process.argv.slice(2))
    const directory = options.distDir || (process.env.BIBLIB_TARGET ? distDir(process.env.BIBLIB_TARGET) : ".next")
    const result = checkClientBundle(path.resolve(REPO_ROOT, directory), { forbidLocalLogin: options.forbidLocalLogin })
    console.log(`Bundle cliente limpio (${result.files} archivos revisados${options.forbidLocalLogin ? "; sin formulario de acceso local" : ""}).`)
  } catch (error) {
    console.error(error instanceof BiblibError ? error.message : "No se pudo revisar el bundle cliente.")
    process.exitCode = error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
  }
}

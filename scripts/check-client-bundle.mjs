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

export function checkClientBundle(directory) {
  const root = path.join(directory, "static")
  if (!existsSync(root)) throw new BiblibError(EXIT.INVALID_ARGS, "bundle", "No existe el directorio static del build indicado.")
  const findings = []
  let count = 0
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) {
        count++
        const content = readFileSync(file, "utf8")
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
  return { files: count, clean: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length && !(args.length === 2 && args[0] === "--dist-dir")) throw new BiblibError(EXIT.INVALID_ARGS, "argumentos", "Uso: check-client-bundle.mjs [--dist-dir directorio].")
    const directory = args[1] || (process.env.BIBLIB_TARGET ? distDir(process.env.BIBLIB_TARGET) : ".next")
    const result = checkClientBundle(path.resolve(REPO_ROOT, directory))
    console.log(`Bundle cliente limpio (${result.files} archivos revisados).`)
  } catch (error) {
    console.error(error instanceof BiblibError ? error.message : "No se pudo revisar el bundle cliente.")
    process.exitCode = error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
  }
}

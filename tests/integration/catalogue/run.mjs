import { spawn } from "node:child_process"
import { readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { BiblibError, EXIT } from "../../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../../scripts/lib/profiles.mjs"
import { ensureCompiled, PROFILES } from "./lib/context.mjs"

// pnpm test:integration:catalogue [--profile scratch|test] — U-DAT-05. Ejecuta solo el grupo
// tests/integration/catalogue contra el Postgres/GoTrue real del perfil (sin compilar ni arrancar la
// app). En el perfil test el grupo también corre dentro de pnpm test:integration:local.

export function parseArgs(argv) {
  if (argv.length === 0) return { profile: "test" }
  if (argv.length === 2 && argv[0] === "--profile" && PROFILES.includes(argv[1])) return { profile: argv[1] }
  throw new BiblibError(EXIT.INVALID_ARGS, "argumentos", "Uso: test:integration:catalogue [--profile scratch|test].")
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { profile } = parseArgs(argv)
    if (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local") throw new BiblibError(EXIT.IDENTITY_MISMATCH, "objetivo", "El grupo catalogue solo admite BIBLIB_TARGET=local.")
    ensureCompiled()
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const files = readdirSync(dir).filter((file) => file.endsWith(".test.mjs")).sort().map((file) => path.join(dir, file))
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|DATABASE_URL$|PG|POSTGRES_|BIBLIB_)/i.test(key)))
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", ...files], { cwd: REPO_ROOT, env: { ...base, BIBLIB_TARGET: "local", BIBLIB_PROFILE: profile, NODE_ENV: "test" }, stdio: "inherit", windowsHide: true })
    return await new Promise((resolve) => child.once("close", (code) => resolve(code === 0 ? EXIT.OK : EXIT.VERIFICATION_FAILED)))
  } catch (error) {
    console.error(`Error [${error instanceof BiblibError ? error.phase : "suite"}]: ${error instanceof BiblibError ? error.message : "Fallo inesperado del grupo catalogue."}`)
    return error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()

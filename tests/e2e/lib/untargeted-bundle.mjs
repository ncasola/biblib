import { spawn } from "node:child_process"
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BiblibError, EXIT } from "../../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../../scripts/lib/profiles.mjs"
import { checkClientBundle } from "../../../scripts/check-client-bundle.mjs"

// Comprueba que un `next build` sin BIBLIB_TARGET (el equivalente a `pnpm build`) no contiene el formulario
// de acceso local. Se compila en una carpeta temporal, como scripts/smoke-app.mjs, para no leer ni
// arrastrar archivos .env del checkout ni pisar `.next`. Se hereda a propósito
// NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN=1: next.config.mjs debe ignorarla sin objetivo. Se compila con webpack,
// como el smoke: Turbopack no resuelve el node_modules enlazado fuera de la raíz temporal.

const LINKED = ["app", "components", "hooks", "lib", "public", "scripts", "tests/fixtures", "node_modules"]
const COPIED = ["package.json", "next.config.mjs", "postcss.config.mjs", "tsconfig.json", "next-env.d.ts", "proxy.ts", "supabase/profiles.json"]

export async function checkUntargetedBuild({ logFile }) {
  const workspace = await mkdtemp(path.join(tmpdir(), "biblib-e2e-sin-objetivo-"))
  const links = []
  try {
    for (const directory of LINKED) {
      const target = path.join(workspace, directory)
      await mkdir(path.dirname(target), { recursive: true })
      await symlink(path.join(REPO_ROOT, directory), target, process.platform === "win32" ? "junction" : "dir")
      links.push(target)
    }
    for (const file of COPIED) {
      await mkdir(path.dirname(path.join(workspace, file)), { recursive: true })
      await copyFile(path.join(REPO_ROOT, file), path.join(workspace, file))
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BIBLIB_|NEXT_PUBLIC_|SUPABASE_|DATABASE_URL$|PG|POSTGRES_|NODE_OPTIONS$)/i.test(key)))
    Object.assign(env, {
      NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN: "1",
      NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-build-placeholder",
      SUPABASE_DB_URL: "postgresql://postgres:placeholder@db.placeholder.supabase.co:5432/postgres",
      NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "production",
    })
    const output = []
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(REPO_ROOT, "node_modules/next/dist/bin/next"), "build", workspace, "--webpack"], { cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => output.push(chunk))
      child.once("error", reject)
      child.once("close", resolve)
    })
    await writeFile(logFile, Buffer.concat(output))
    if (code !== 0) throw new BiblibError(EXIT.VERIFICATION_FAILED, "build", "Falló el build sin objetivo en la carpeta temporal; revisa .biblib/e2e/build-sin-objetivo.log.")
    return checkClientBundle(path.join(workspace, ".next"), { forbidLocalLogin: true })
  } finally {
    // Sin todos los enlaces retirados no se borra nada: un borrado recursivo nunca debe alcanzar el checkout.
    let unlinked = true
    for (const link of links) await unlink(link).catch(() => { unlinked = false })
    const resolved = await realpath(workspace)
    if (unlinked && path.basename(resolved).startsWith("biblib-e2e-sin-objetivo-")) await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  }
}

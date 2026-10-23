import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const project = fileURLToPath(new URL("../", import.meta.url))
const containerName = `biblib-test-${process.pid}-${randomUUID().slice(0, 8)}`
let containerId

function docker(args, input) {
  return execFileSync("docker", args, { cwd: project, encoding: "utf8", input, maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }).trim()
}

function cleanup() {
  if (!containerId) return
  const ownedId = containerId
  containerId = undefined
  spawnSync("docker", ["rm", "--force", ownedId], { stdio: "ignore" })
}

process.once("SIGINT", () => { cleanup(); process.exit(130) })
process.once("SIGTERM", () => { cleanup(); process.exit(143) })

async function run() {
  try {
    const id = docker(["run", "--rm", "--detach", "--name", containerName, "--publish", "127.0.0.1::5432", "--env", "POSTGRES_DB=biblib_test", "--env", `POSTGRES_PASSWORD=${randomUUID()}`, "postgres:17-alpine"])
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Docker no devolvió un identificador de contenedor válido.")
    containerId = id
    let ready = false
    for (let attempt = 0; attempt < 80; attempt++) {
      const check = spawnSync("docker", ["exec", containerId, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "biblib_test"], { stdio: "ignore" })
      if (check.status === 0) { ready = true; break }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!ready) throw new Error("Postgres de pruebas no respondió en el tiempo previsto.")
    const files = ["tests/db/bootstrap.sql", "drizzle/0000_biblib_init.sql", "tests/db/legacy.sql", "drizzle/0001_library_integrity.sql", "drizzle/0002_book_versions.sql", "drizzle/0003_library_revision.sql", "tests/db/versions.sql", "tests/db/rls.sql", "tests/db/revision.sql", "drizzle/0004_catalogue_coordination.sql", "tests/db/catalogue.sql"]
    for (const relativePath of files) {
      const sql = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8")
      const output = docker(["exec", "-i", containerId, "psql", "--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "-U", "postgres", "-d", "biblib_test", "-v", "ON_ERROR_STOP=1"], sql)
      console.log(`Correcto: ${relativePath}`)
      if ((relativePath.endsWith("rls.sql") || relativePath.endsWith("revision.sql") || relativePath.endsWith("catalogue.sql")) && output) console.log(output.split(/\r?\n/).filter((line) => line.startsWith("Correcto:")).join("\n"))
    }
    console.log("Pruebas de base de datos completadas en un contenedor aislado.")
  } catch (error) {
    const details = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : ""
    console.error(error instanceof Error ? error.message : "No se pudieron ejecutar las pruebas de base de datos.")
    if (details) console.error(details.trim())
    process.exitCode = 1
  } finally {
    cleanup()
  }
}

await run()

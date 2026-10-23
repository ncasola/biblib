import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadTarget, targetInputs } from "../db/environment.mjs"
import { inspectJournal } from "../db/journal-guard.mjs"
import { assertBuildTarget } from "../next-target.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"

const sha = (value) => createHash("sha256").update(value).digest("hex")
const fail = (code, message) => { throw new BiblibError(code, "release", message) }
export const RELEASE_FILE = ".biblib/ci/release.json"

export function fileHashes(root, directory, prefix = directory) {
  const result = {}
  const folder = path.join(root, directory)
  if (lstatSync(folder).isSymbolicLink()) fail(EXIT.IDENTITY_MISMATCH, "Un artefacto no puede atravesar enlaces.")
  for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    // Caché de compilación: no es un recurso de ejecución ni se distribuye.
    if (directory === prefix && prefix.startsWith(".next") && entry.name === "cache") continue
    const relative = `${directory}/${entry.name}`
    if (entry.isSymbolicLink()) fail(EXIT.IDENTITY_MISMATCH, "Un artefacto no puede contener enlaces.")
    if (entry.isDirectory()) Object.assign(result, fileHashes(root, relative, prefix))
    else if (entry.isFile()) result[relative] = sha(readFileSync(path.join(root, relative)))
    else fail(EXIT.IDENTITY_MISMATCH, "El artefacto contiene un archivo especial.")
  }
  return result
}

export function describeRelease(target, { root = REPO_ROOT, env = process.env } = {}) {
  if (!["untargeted", "preprod", "prod"].includes(target)) fail(EXIT.INVALID_ARGS, "Objetivo de release no admitido.")
  const journal = inspectJournal(path.join(root, "drizzle"))
  if (journal.problems.length) fail(EXIT.HISTORY_DIVERGED, "El historial de migraciones no es válido.")
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true })
  if (commit.status !== 0 || !/^[0-9a-f]{40}$/.test(commit.stdout.trim())) fail(EXIT.MISSING_REQUIREMENT, "No se pudo identificar el commit.")
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8", windowsHide: true })
  if (status.status !== 0 || status.stdout.trim()) fail(EXIT.PLAN_REJECTED, "El checkout tiene cambios: no se puede atribuir el build a ese commit.")
  const directory = target === "untargeted" ? ".next" : `.next-${target}`
  let publicFingerprint = null
  if (target !== "untargeted") {
    const ctx = loadTarget(target, { cwd: root, env: targetInputs(env) })
    assertBuildTarget(ctx)
    publicFingerprint = ctx.publicFingerprint
  }
  const buildId = readFileSync(path.join(root, directory, "BUILD_ID"), "utf8").trim()
  if (!buildId) fail(EXIT.IDENTITY_MISMATCH, "Falta el identificador de build.")
  return {
    schemaVersion: 1, target, commit: commit.stdout.trim(), lockfileSha256: sha(readFileSync(path.join(root, "pnpm-lock.yaml"))),
    journalSha256: journal.journalHash,
    migrations: journal.entries.map(({ tag, when, hash }) => ({ tag, when, sha256: hash })),
    buildId, publicFingerprint,
    files: { ...fileHashes(root, directory), ...fileHashes(root, "public") },
  }
}

export function verifyRelease(expected, actual) {
  if (expected?.target !== actual.target || expected?.publicFingerprint !== actual.publicFingerprint) fail(EXIT.IDENTITY_MISMATCH, "El artefacto corresponde a otro destino o huella pública.")
  if (JSON.stringify(expected) !== JSON.stringify(actual)) fail(EXIT.PLAN_REJECTED, "El commit, lockfile, historial o los bytes del artefacto cambiaron.")
}

export function main(args = process.argv.slice(2)) {
  try {
    const [operation, target, ...rest] = args
    if (!["create", "verify"].includes(operation) || rest.length) fail(EXIT.INVALID_ARGS, "Uso: release.mjs create|verify untargeted|preprod|prod.")
    const actual = describeRelease(target)
    const file = path.join(REPO_ROOT, RELEASE_FILE)
    if (operation === "create") {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`)
    } else verifyRelease(JSON.parse(readFileSync(file, "utf8")), actual)
    console.log(`Artefacto ${target} identificado y ${operation === "create" ? "sellado" : "verificado"}.`)
    return EXIT.OK
  } catch (error) {
    console.error(error instanceof BiblibError ? error.message : "No se pudo identificar o verificar el artefacto.")
    return error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main()

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { appEnv, assertNoForeignEnvFiles, loadTarget, targetInputs, validateTarget } from "./db/environment.mjs"
import { BiblibError, EXIT } from "./lib/exit-codes.mjs"
import { getProfile, REPO_ROOT } from "./lib/profiles.mjs"

export function distDir(target) {
  return `.next-${validateTarget(target)}`
}

export function assertBuildTarget(ctx) {
  let artifact
  let buildId
  const directory = path.join(ctx.cwd, distDir(ctx.target))
  try {
    artifact = JSON.parse(readFileSync(path.join(directory, "biblib-target.json"), "utf8"))
    buildId = readFileSync(path.join(directory, "BUILD_ID"), "utf8").trim()
  } catch {
    throw new BiblibError(EXIT.IDENTITY_MISMATCH, "artefacto", "Falta una huella válida del build; construye primero para este objetivo.")
  }
  if (!artifact || artifact.schemaVersion !== 1 || artifact.target !== ctx.target || artifact.publicFingerprint !== ctx.publicFingerprint || !buildId || artifact.buildId !== buildId) {
    throw new BiblibError(EXIT.IDENTITY_MISMATCH, "artefacto", "El build pertenece a otro objetivo o proyecto; vuelve a construir para el contexto seleccionado.")
  }
}

/** Entorno del proceso de Next: sin service_role (U-OPS-04), ni siquiera desde .env.local. */
export function nextEnv(ctx, command) {
  return { ...appEnv(ctx), NODE_ENV: command === "dev" ? "development" : "production",
    // Capacidad de UI, sin credenciales: excepción explícita al filtrado de BIBLIB heredadas.
    BIBLIB_ISBN_CAMERA: process.env.BIBLIB_ISBN_CAMERA === "1" ? "1" : "",
    BIBLIB_PRIVATE_MEDIA_UPLOADS: process.env.BIBLIB_PRIVATE_MEDIA_UPLOADS === "1" ? "1" : "",
  }
}

export async function runNextTarget(args, { cwd = REPO_ROOT, env = process.env } = {}) {
  const [command, target, ...options] = args
  validateTarget(target)
  if (!["dev", "build", "start"].includes(command) || (options.length !== 0 && !(options.length === 2 && options[0] === "--profile" && options[1]))) {
    throw new BiblibError(EXIT.INVALID_ARGS, "argumentos", "Uso: next-target.mjs dev|build|start local|test|preprod|prod [--profile nombre].")
  }
  const ctx = loadTarget(target, { profile: options[1] || env.BIBLIB_PROFILE, env: targetInputs(env), cwd })
  assertNoForeignEnvFiles(ctx, { mode: command })
  if (command === "start") assertBuildTarget(ctx)
  const directory = path.join(cwd, distDir(target))
  // Nunca conservar una huella de un build anterior si la compilación falla.
  if (command === "build" && existsSync(path.join(directory, "biblib-target.json"))) {
    writeFileSync(path.join(directory, "biblib-target.json"), "{}\n")
  }
  const app = getProfile(ctx.profile, { root: cwd }).app
  const nextArgs = [path.join(REPO_ROOT, "node_modules/next/dist/bin/next"), command]
  if (command !== "build") nextArgs.push("--hostname", app.host, "--port", String(app.port))
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nextArgs, { cwd, env: nextEnv(ctx, command), stdio: "inherit", windowsHide: true })
    child.once("error", () => reject(new BiblibError(EXIT.MISSING_REQUIREMENT, "next", "No se puede ejecutar el Next del repositorio.")))
    child.once("exit", (status) => resolve(status ?? EXIT.INTERRUPTED))
  })
  if (code === 0 && command === "build") {
    mkdirSync(directory, { recursive: true })
    const buildId = readFileSync(path.join(directory, "BUILD_ID"), "utf8").trim()
    writeFileSync(path.join(directory, "biblib-target.json"), `${JSON.stringify({ schemaVersion: 1, target, publicFingerprint: ctx.publicFingerprint, buildId }, null, 2)}\n`)
  }
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runNextTarget(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((error) => {
    console.error(error instanceof BiblibError ? error.message : "No se pudo ejecutar Next para el objetivo seleccionado.")
    process.exitCode = error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
  })
}

import { execFileSync, spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { createConnection } from "node:net"
import path from "node:path"
import { BiblibError, EXIT } from "../../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../../scripts/lib/profiles.mjs"
import { PROFILE } from "./context.mjs"

// Procesos que comparten los runners con stack real (integración U-QA-01 y E2E U-QA-02): lanzar
// comandos con salida enmascarada, arrancar la app del perfil test y parar solo lo que se arrancó.

const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }

/** Enmascara JWT, valores de cookie SSR y secretos conocidos antes de escribir en consola. */
export function redactor(secrets = []) {
  const known = secrets.filter((s) => typeof s === "string" && s.length >= 8)
  return (text) => {
    let out = text
    for (const secret of known) out = out.split(secret).join("[oculto]")
    return out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt oculto]")
      .replace(/base64-[A-Za-z0-9_-]{16,}/g, "[cookie oculta]")
      .replace(/(refresh_token|access_token|password)("?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1$2[oculto]")
  }
}

export function pipeRedacted(stream, target, redact) {
  let pending = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk) => {
    pending += chunk
    const lines = pending.split("\n")
    pending = lines.pop()
    for (const line of lines) target.write(`${redact(line)}\n`)
  })
  stream.on("end", () => { if (pending) target.write(redact(pending)) })
}

export function run(command, args, { env, logFile, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    const log = logFile ? createWriteStream(logFile) : null
    for (const stream of [child.stdout, child.stderr]) {
      if (log) stream.pipe(log, { end: false })
      if (onOutput) onOutput(stream)
    }
    child.once("error", () => reject(new BiblibError(EXIT.MISSING_REQUIREMENT, "proceso", `No se pudo ejecutar ${path.basename(command)}.`)))
    child.once("close", (code) => { log?.end(); resolve(code ?? EXIT.INTERRUPTED) })
  })
}

export function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    socket.setTimeout(1000)
    socket.once("connect", () => { socket.destroy(); resolve(true) })
    socket.once("timeout", () => { socket.destroy(); resolve(false) })
    socket.once("error", () => resolve(false))
  })
}

/** Termina solo el árbol del proceso que arrancó este runner. */
export function stopTree(child) {
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    else process.kill(-child.pid, "SIGTERM")
  } catch { /* Ya había terminado. */ }
}

/** Arranca `next-target start local --profile test` y espera a que /login responda; nunca termina a un ocupante del puerto. */
export async function startApp(ctx, env, { logFile, logHint }) {
  if (await portInUse(Number(new URL(ctx.appUrl).port))) fail(EXIT.SERVICE_UNAVAILABLE, "app", `El puerto de la app del perfil test (${ctx.appUrl}) está ocupado; no se termina al ocupante. Libéralo y repite.`)
  const child = spawn(process.execPath, ["scripts/next-target.mjs", "start", "local", "--profile", PROFILE], {
    cwd: REPO_ROOT, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  })
  const log = createWriteStream(logFile)
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(child.exitCode === EXIT.IDENTITY_MISMATCH ? EXIT.IDENTITY_MISMATCH : EXIT.SERVICE_UNAVAILABLE, "app", `La app no arrancó con el build del perfil test; revisa ${logHint}.`)
    try {
      const response = await fetch(`${ctx.appUrl}/login`, { redirect: "manual", signal: AbortSignal.timeout(2000) })
      if (response.status === 200) return child
    } catch { /* Todavía arrancando. */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  stopTree(child)
  fail(EXIT.SERVICE_UNAVAILABLE, "app", "La app del perfil test no respondió en 60 s.")
}

export async function listUsers(admin) {
  const users = []
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) fail(EXIT.SERVICE_UNAVAILABLE, "usuarios", "GoTrue no permitió listar las cuentas locales.")
    users.push(...data.users.map((u) => ({ id: u.id, email: u.email })))
    if (data.users.length < 1000) break
  }
  return users.sort((x, y) => x.id.localeCompare(y.id))
}

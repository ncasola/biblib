import { spawn } from "node:child_process"
import path from "node:path"
import { BiblibError, EXIT } from "./exit-codes.mjs"

// La captura privada solo sirve para parsear respuestas estructuradas en memoria.
// Nunca se incluye stdout/stderr nativo en errores del wrapper.
export function sanitize(value) {
  return String(value)
    .replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@[^\s"']*/gi, "[URL privada]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[token privado]")
    .replace(/(?:service_role|anon_key|secret_key|password|access_token|refresh_token)["']?\s*[:=]\s*["']?[^\s,"'}]+/gi, "[credencial privada]")
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[clave privada]")
}

export function supabaseCommand(root) {
  // Es el entrypoint del binario fijado node_modules/.bin/supabase; evita .cmd/shell.
  return { command: process.execPath, prefix: [path.join(root, "node_modules", "supabase", "dist", "supabase.js")] }
}

export function pnpmCommand(env = process.env, platform = process.platform) {
  if (env.npm_execpath?.endsWith(".js") || env.npm_execpath?.endsWith(".cjs")) {
    return { command: process.execPath, args: [env.npm_execpath, "--version"] }
  }
  // Corepack se distribuye como JS en las instalaciones Windows de Node.
  if (platform === "win32") return { command: process.execPath, args: [path.join(path.dirname(process.execPath), "node_modules/corepack/dist/pnpm.js"), "--version"] }
  return { command: "pnpm", args: ["--version"] }
}

export function execute(command, args, { cwd, env, timeoutMs = 20000, signal, privateCapture = false } = {}) {
  if (signal?.aborted) return Promise.reject(new BiblibError(EXIT.INTERRUPTED, "proceso", "Interrupción solicitada."))
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = "", interrupted = false, timedOut = false, overflow = false, killTimer
    const capture = (key, chunk) => {
      if (stdout.length + stderr.length + chunk.length > 1024 * 1024) { overflow = true; stop(); return }
      if (key === "stdout") stdout += chunk.toString("utf8")
      else stderr += chunk.toString("utf8")
    }
    // Solo termina el árbol del proceso que acaba de crear este ejecutor.
    const stop = () => {
      if (!child.pid || child.exitCode !== null) return
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" })
        killer.on("error", () => child.kill())
      } else child.kill("SIGINT")
      killTimer ??= setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL") }, 5000)
    }
    const abort = () => { interrupted = true; stop() }
    signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    child.stdout.on("data", (chunk) => capture("stdout", chunk))
    child.stderr.on("data", (chunk) => capture("stderr", chunk))
    const clear = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", abort) }
    child.on("error", () => { clear(); reject(new BiblibError(EXIT.MISSING_REQUIREMENT, "proceso", "No se pudo ejecutar una herramienta local requerida.")) })
    child.on("close", (code) => {
      clear()
      if (interrupted) reject(new BiblibError(EXIT.INTERRUPTED, "proceso", "Interrupción solicitada."))
      else if (timedOut || overflow) reject(new BiblibError(EXIT.SERVICE_UNAVAILABLE, "proceso", timedOut ? "La herramienta local excedió el tiempo de espera." : "La respuesta de la herramienta excedió el límite de captura."))
      else resolve({ code: code ?? 1, stdout: privateCapture ? stdout : sanitize(stdout), stderr: sanitize(stderr) })
    })
  })
}

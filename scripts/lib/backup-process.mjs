import { spawn } from "node:child_process"
import { BiblibError, EXIT } from "./exit-codes.mjs"

const MAX_BYTES = 512 * 1024 * 1024

/**
 * Ejecuta una herramienta sin shell y captura stdout como bytes (volcados y binarios).
 * stderr se descarta: puede contener rutas o parámetros nativos y nunca se publica.
 * `input` se escribe por stdin, de modo que ningún dato ni credencial viaja en argv.
 */
export function streamCommand(command, args, { input, cwd, env, timeoutMs = 300000, maxBytes = MAX_BYTES, signal, phase = "proceso" } = {}) {
  if (signal?.aborted) return Promise.reject(new BiblibError(EXIT.INTERRUPTED, phase, "Interrupción solicitada."))
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] })
    const chunks = []
    let size = 0, interrupted = false, timedOut = false, overflow = false, killTimer
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
    child.stdout.on("data", (chunk) => {
      size += chunk.length
      if (size > maxBytes) { overflow = true; stop(); return }
      chunks.push(chunk)
    })
    child.stderr.resume()
    if (input) {
      child.stdin.on("error", () => {})
      child.stdin.end(input)
    }
    const clear = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", abort) }
    child.on("error", () => { clear(); reject(new BiblibError(EXIT.MISSING_REQUIREMENT, phase, "No se pudo ejecutar una herramienta local requerida.")) })
    child.on("close", (code) => {
      clear()
      if (interrupted) reject(new BiblibError(EXIT.INTERRUPTED, phase, "Interrupción solicitada."))
      else if (timedOut || overflow) reject(new BiblibError(EXIT.SERVICE_UNAVAILABLE, phase, timedOut ? "La herramienta local excedió el tiempo de espera." : "La salida de la herramienta excedió el límite del respaldo local."))
      else resolve({ code: code ?? 1, stdout: Buffer.concat(chunks) })
    })
  })
}

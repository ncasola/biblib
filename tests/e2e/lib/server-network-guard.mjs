import { appendFileSync } from "node:fs"

// Precarga (--import) del proceso de la app durante el E2E. En modo fixture el servidor no debe salir
// de loopback: cualquier fetch a otro host se rechaza y se anota solo el host en E2E_OUTBOUND_LOG,
// que el runner revisa al terminar. No sustituye al modo fixture; deja constancia si algo lo esquiva.
// La variable no empieza por BIBLIB_ porque childEnv (next-target) descarta ese prefijo heredado.

const log = process.env.E2E_OUTBOUND_LOG
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])
const original = globalThis.fetch

export function externalHost(input) {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url
  try {
    const { hostname, protocol } = new URL(href)
    return ["http:", "https:"].includes(protocol) && !LOOPBACK.has(hostname) ? hostname : null
  } catch {
    return null
  }
}

if (log && typeof original === "function") {
  // Cada proceso que carga el guard lo anota: el runner exige verlo para dar por vigilado el servidor.
  appendFileSync(log, `${JSON.stringify({ guard: "activo", pid: process.pid })}\n`)
  globalThis.fetch = async function guardedFetch(input, init) {
    const host = externalHost(input)
    if (host) {
      try { appendFileSync(log, `${JSON.stringify({ host, at: new Date().toISOString() })}\n`) } catch { /* El runner detectará el fallo por otra vía. */ }
      throw new TypeError("E2E: salida de red externa bloqueada en modo fixture.")
    }
    return original(input, init)
  }
}

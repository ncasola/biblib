import path from "node:path"
import { pathToFileURL } from "node:url"

/** Solo operador: no lee archivos, no abre red y nunca devuelve variables o credenciales. */
export function googleBooksStatus(env = process.env) {
  const enabled = env.BIBLIB_GOOGLE_BOOKS_ENABLED === "true"
  const configured = Boolean(env.GOOGLE_BOOKS_API_KEY?.trim())
  const target = env.BIBLIB_TARGET ?? (env.NODE_ENV === "production" ? "prod" : "local")
  const mode = env.BIBLIB_CATALOGUE_MODE || (["local", "test"].includes(target) ? "fixture" : "live")
  if (!["local", "test", "preprod", "prod"].includes(target) || !["fixture", "live"].includes(mode) ||
    (mode === "fixture" && !["local", "test"].includes(target)) ||
    ![undefined, "", "true", "false"].includes(env.BIBLIB_GOOGLE_BOOKS_ENABLED)) {
    throw new Error("La configuración del catálogo no es válida.")
  }
  return {
    provider: "google-books", mode,
    status: !enabled ? "disabled" : !configured && mode === "live" ? "misconfigured" : mode === "fixture" ? "fixture" : "ready",
    externalRequests: enabled && configured && mode === "live" ? "permitidas tras revisión manual de consola, cuota, coste y términos" : "bloqueadas",
    metadataRetention: false, coverRetention: false,
    notice: "Antes de activar Google, integrar el aviso y selector de desactivación en el flujo de revisión bibliográfica.",
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 2) throw new Error("Uso: node scripts/catalogue-status.mjs (sin argumentos).")
    console.log(JSON.stringify(googleBooksStatus(), null, 2))
  } catch {
    console.error("No se pudo diagnosticar el catálogo. Revisa la configuración canónica; no se hizo ninguna consulta.")
    process.exitCode = 2
  }
}

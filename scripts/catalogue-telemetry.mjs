// Resumen operativo del catálogo por proveedor (U-BIB-05). Solo operador: lee los registros JSON de la
// telemetría de BibLib (uno por línea, los que escribe lib/observability) desde un archivo o la entrada
// estándar y devuelve contadores agregados por proveedor. No abre red, no lee archivos de configuración ni
// variables, y los registros ya llegan sin ISBN, títulos, consultas, claves ni datos de cuentas: aquí solo
// se suman cantidades, estados y percentiles.
//
//   docker logs <app> 2>&1 | node scripts/catalogue-telemetry.mjs [--json]
//   node scripts/catalogue-telemetry.mjs --file registros.jsonl [--json]
import { createReadStream } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"

const PROVIDERS = ["open-library", "bne", "google-books"]
const RESULTS = ["found", "notFound", "unavailable", "rateLimited", "disabled", "misconfigured", "notAttempted"]

function percentile(sorted, fraction) {
  if (!sorted.length) return null
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))])
}

const text = (value) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(value) ? value : undefined

/**
 * Agrega líneas de registro. Una línea que no es JSON o no es un evento de telemetría se cuenta como
 * descartada y nunca se reproduce en la salida.
 */
export function summarizeCatalogueTelemetry(lines) {
  const providers = Object.fromEntries(PROVIDERS.map((provider) => [provider, {
    consultas: 0, resultados: Object.fromEntries(RESULTS.map((result) => [result, 0])), latenciasMs: [],
    errores: Object.create(null), aciertosDeCache: 0, esperasDeCuotaOmitidas: 0, coordinacionNoDisponible: 0, portadasRecuperadas: 0,
  }]))
  const jobs = { reintentos: 0, fallos: 0, porCodigo: Object.create(null) }
  let leidas = 0
  let descartadas = 0
  for (const line of lines) {
    const raw = typeof line === "string" ? line.trim() : ""
    if (!raw) continue
    let record
    try { record = JSON.parse(raw) } catch { descartadas++; continue }
    const fields = record && typeof record === "object" && record.fields && typeof record.fields === "object" ? record.fields : null
    if (!fields || typeof record.event !== "string") { descartadas++; continue }
    leidas++
    const provider = text(fields.provider)
    const operation = text(fields.operation) ?? ""
    const result = text(fields.result)
    const code = text(fields.errorCode)
    if (record.event === "provider.request" && provider && Object.hasOwn(providers, provider)) {
      const entry = providers[provider]
      if (operation.startsWith("catalog.")) {
        // Un registro del orquestador por consulta y fuente: su `result` es el estado de la fuente.
        entry.consultas++
        if (result && Object.hasOwn(entry.resultados, result)) entry.resultados[result]++
        if (typeof fields.durationMs === "number" && Number.isFinite(fields.durationMs)) entry.latenciasMs.push(fields.durationMs)
      } else if (operation === "catalogue.cache") entry.aciertosDeCache++
      else if (operation === "catalogue.quota") entry.esperasDeCuotaOmitidas++
      else if (operation === "catalogue.coordination") entry.coordinacionNoDisponible++
      else if (result === "error" && code) entry.errores[code] = (entry.errores[code] ?? 0) + 1
    } else if (record.event === "cover.recovery" && operation === "cover.source" && provider && Object.hasOwn(providers, provider) && typeof fields.batch === "number") {
      providers[provider].portadasRecuperadas += fields.batch
    } else if (record.event === "job.retried") {
      jobs.reintentos += typeof fields.batch === "number" ? fields.batch : 1
      if (code) jobs.porCodigo[code] = (jobs.porCodigo[code] ?? 0) + 1
    } else if (record.event === "job.failed") {
      jobs.fallos++
      if (code) jobs.porCodigo[code] = (jobs.porCodigo[code] ?? 0) + 1
    }
  }
  return {
    registrosLeidos: leidas, lineasDescartadas: descartadas,
    proveedores: Object.fromEntries(Object.entries(providers).map(([provider, entry]) => {
      const { latenciasMs, errores, ...counters } = entry
      const sorted = [...latenciasMs].sort((a, b) => a - b)
      return [provider, { ...counters, errores: { ...errores }, latenciaMs: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), muestras: sorted.length } }]
    })),
    trabajos: { ...jobs, porCodigo: { ...jobs.porCodigo } },
  }
}

export async function readLines(source) {
  const input = source ? createReadStream(source, { encoding: "utf8" }) : process.stdin
  const lines = []
  for await (const line of createInterface({ input, crlfDelay: Infinity })) lines.push(line)
  return lines
}

function render(summary) {
  const rows = Object.entries(summary.proveedores).map(([provider, entry]) => ({
    proveedor: provider, consultas: entry.consultas, encontradas: entry.resultados.found, sinFicha: entry.resultados.notFound,
    noDisponible: entry.resultados.unavailable, limitadas: entry.resultados.rateLimited, desactivadas: entry.resultados.disabled,
    aciertosCache: entry.aciertosDeCache, p50Ms: entry.latenciaMs.p50, p95Ms: entry.latenciaMs.p95, portadas: entry.portadasRecuperadas,
  }))
  console.table(rows)
  console.log(`Registros leídos: ${summary.registrosLeidos} · líneas descartadas: ${summary.lineasDescartadas} · reintentos de trabajos: ${summary.trabajos.reintentos} · fallos: ${summary.trabajos.fallos}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const fileIndex = args.indexOf("--file")
  const known = args.every((arg, index) => arg === "--json" || arg === "--file" || (index > 0 && args[index - 1] === "--file"))
  if (!known || (fileIndex >= 0 && !args[fileIndex + 1])) {
    console.error("Uso: node scripts/catalogue-telemetry.mjs [--file registros.jsonl] [--json] (sin --file lee la entrada estándar).")
    process.exitCode = 2
  } else {
    try {
      const summary = summarizeCatalogueTelemetry(await readLines(fileIndex >= 0 ? args[fileIndex + 1] : undefined))
      if (args.includes("--json")) console.log(JSON.stringify(summary, null, 2))
      else render(summary)
    } catch {
      console.error("No se pudieron leer los registros.")
      process.exitCode = 1
    }
  }
}

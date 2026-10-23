import { generateCorrelationId, getCorrelationId, isValidCorrelationId } from "./correlation"
import { isTelemetryEvent, isTelemetryField, type TelemetryEvent, type TelemetryField } from "./events"
import type { TelemetryEmitter, TelemetryFieldValue } from "./emitter"

export type { TelemetryEmitter, TelemetryFields } from "./emitter"

export interface TelemetryRecord {
  event: TelemetryEvent
  level: "info" | "error"
  timestamp: string
  fields: Partial<Record<TelemetryField, TelemetryFieldValue>>
}

export type TelemetrySink = (record: TelemetryRecord) => void
export interface LoggerOptions {
  sink?: TelemetrySink
  enabled?: boolean
}
export interface Logger extends TelemetryEmitter {
  /** Contador local; no conserva nombres ni valores de los campos descartados. */
  readonly droppedFields: number
  readonly enabled: boolean
}

const JWT_PATTERN = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi
const SECRET_PAIR_PATTERN = /\b(password|passwd|secret|secreto|clave|token|api[-_]?key|access[-_]?key|authorization|cookie|anon[-_]?key|service[-_]?role[-_]?key|private[-_]?key)["']?\s*[:=]\s*["']?[^\s;"',}]+/gi
const KEY_PATTERN = /\b(?:sk[-_]|sb_secret_|sb_publishable_|AKIA)[A-Za-z0-9_-]+/gi

/** Defensa adicional: nunca escribir URLs, credenciales, JWT ni texto libre largo. */
export function sanitizeFieldValue(value: string): string {
  return value
    .replace(/-----BEGIN[\s\S]*?-----END[^\r\n]*-----/g, "[clave-omitida]")
    .replace(URL_PATTERN, "[url-omitida]")
    .replace(JWT_PATTERN, "[jwt-omitido]")
    .replace(/\bBearer\s+[^\s]+/gi, "[credencial-omitida]")
    .replace(SECRET_PAIR_PATTERN, "[credencial-omitida]")
    .replace(KEY_PATTERN, "[clave-omitida]")
    .slice(0, 120)
}

function sanitizeRawValue(field: TelemetryField, value: unknown): TelemetryFieldValue | undefined {
  if (["durationMs", "batch", "attempt", "httpStatus"].includes(field)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
    if (field !== "durationMs" && !Number.isSafeInteger(value)) return undefined
    if (field === "httpStatus" && (value < 100 || value > 599)) return undefined
    return value
  }
  if (typeof value !== "string") return undefined
  if (field === "accountRef") return /^acct_[a-f0-9]{64}$/.test(value) ? value : undefined
  if (field === "correlationId") return sanitizeFieldValue(value) === value && isValidCorrelationId(value) ? value : undefined
  const clean = sanitizeFieldValue(value)
  // Operación/proveedor/resultado/código son etiquetas técnicas, nunca mensajes o payloads.
  return clean === value && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(clean) ? clean : undefined
}

function envTelemetryEnabled(): boolean {
  return process.env.BIBLIB_TELEMETRY?.trim().toLowerCase() !== "off"
}

function defaultSink(record: TelemetryRecord): void {
  const stream = record.level === "error" ? process.stderr : process.stdout
  stream.write(`${JSON.stringify(record)}\n`)
}

/** Núcleo Node comprobable sin React; la aplicación lo importa a través de server.ts. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? defaultSink
  let droppedFields = 0
  const enabled = () => options.enabled !== false && envTelemetryEnabled()
  return {
    get droppedFields() { return droppedFields },
    get enabled() { return enabled() },
    emit(event, fields = {}) {
      if (!enabled()) return
      try {
        if (!isTelemetryEvent(event)) { droppedFields++; return }
        const clean: TelemetryRecord["fields"] = {}
        for (const [key, raw] of Object.entries(fields)) {
          if (!isTelemetryField(key)) { droppedFields++; continue }
          if (raw === undefined || raw === null) continue
          const value = sanitizeRawValue(key, raw)
          if (value === undefined) { droppedFields++; continue }
          clean[key] = value
        }
        // Un contexto activo manda sobre un valor explícito para evitar partir una operación.
        clean.correlationId = getCorrelationId() ?? clean.correlationId ?? generateCorrelationId()
        sink({ event, level: clean.result === "error" ? "error" : "info", timestamp: new Date().toISOString(), fields: clean })
      } catch { /* Un sink o un dato defectuoso no interrumpen al dominio. */ }
    },
  }
}

const logger = createLogger()
export const emit: TelemetryEmitter["emit"] = (event, fields) => logger.emit(event, fields)

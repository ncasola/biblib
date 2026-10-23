/**
 * Catálogo cerrado de eventos operativos y lista blanca de campos (U-OPS-01).
 *
 * Ningún evento admite títulos, autores, ISBN de búsquedas, notas, contenido de
 * archivos, JWT, cookies, claves ni URL con credenciales. Los jobs y proveedores
 * nuevos de F1 reutilizan este mismo catálogo: añadir un evento exige ampliar
 * esta lista a propósito.
 */
export const TELEMETRY_EVENTS = [
  "auth.failure",
  "db.operation",
  "import.preview",
  "import.commit",
  "import.conflict",
  "job.started",
  "job.retried",
  "job.failed",
  "provider.request",
  "cover.recovery",
  "storage.upload",
  "storage.delete",
  "account.deletion",
  "migration.completed",
] as const

export type TelemetryEvent = (typeof TELEMETRY_EVENTS)[number]

export function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  return typeof value === "string" && (TELEMETRY_EVENTS as readonly string[]).includes(value)
}

/** Únicos campos que pueden viajar en un registro. El resto se descarta y se cuenta. */
export const TELEMETRY_FIELDS = [
  "operation",
  "durationMs",
  "result",
  "errorCode",
  "provider",
  "batch",
  "attempt",
  "correlationId",
  "httpStatus",
  "accountRef",
] as const

export type TelemetryField = (typeof TELEMETRY_FIELDS)[number]

export function isTelemetryField(value: string): value is TelemetryField {
  return (TELEMETRY_FIELDS as readonly string[]).includes(value)
}

/** Valores admitidos para el campo `result`. */
export type TelemetryResult = "ok" | "error" | "recovered" | "unavailable" | "skipped"

/**
 * Clasificación cerrada de fallos de proveedor. Un 429 jamás se registra como
 * 404 ni como 5xx: la cuota conserva su significado (decisión A03 de la spec).
 */
export type ProviderFailureKind = "rate_limited" | "not_found" | "upstream_error" | "timeout" | "network"

const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED", "UND_ERR_SOCKET"])

function errorCodeOf(error: object, depth = 0): string | undefined {
  if (depth > 5) return undefined
  if ("code" in error && typeof error.code === "string") return error.code
  return "cause" in error && error.cause && typeof error.cause === "object" ? errorCodeOf(error.cause, depth + 1) : undefined
}

function errorNameOf(error: object): string | undefined {
  return "name" in error && typeof error.name === "string" ? error.name : undefined
}

/**
 * Clasifica un fallo de proveedor a partir del estado HTTP o del error lanzado.
 * Otros estados HTTP (incluidos 2xx con cuerpo inválido y 4xx no catalogados)
 * se agrupan como `upstream_error`: la respuesta del proveedor no cumplió el
 * contrato esperado y no se inventan categorías nuevas.
 */
export function classifyProviderFailure(failure: unknown): ProviderFailureKind {
  const status = typeof failure === "number" && Number.isInteger(failure)
    ? failure
    : failure && typeof failure === "object" && "status" in failure && typeof failure.status === "number" && Number.isInteger(failure.status)
      ? failure.status
      : undefined
  if (status !== undefined) {
    if (status === 429) return "rate_limited"
    if (status === 404) return "not_found"
    return "upstream_error"
  }
  if (failure && typeof failure === "object") {
    const code = errorCodeOf(failure)
    if (code && TIMEOUT_CODES.has(code)) return "timeout"
    if (code && NETWORK_CODES.has(code)) return "network"
    const name = errorNameOf(failure) ?? ""
    if (name === "TimeoutError" || name === "AbortError") return "timeout"
    if (failure instanceof TypeError) return "network"
    if (failure instanceof SyntaxError) return "upstream_error" // cuerpo JSON ilegible
  }
  return "network"
}

import { DomainError } from "../domain-errors"
import { emitSafely, type TelemetryEmitter } from "./emitter"

/** No lee mensajes de error, parámetros ni resultados de dominio. */
export async function observeOperation<T>(
  event: "import.commit" | "cover.recovery",
  operation: string,
  run: () => Promise<T>,
  telemetry: TelemetryEmitter,
): Promise<T> {
  const started = Date.now()
  try {
    const value = await run()
    emitSafely(telemetry, event, { operation, result: "ok", durationMs: Math.max(0, Date.now() - started) })
    return value
  } catch (error) {
    const fields = { operation, result: "error", errorCode: error instanceof DomainError ? error.code : "UNEXPECTED_ERROR", durationMs: Math.max(0, Date.now() - started) }
    emitSafely(telemetry, event, fields)
    if (event === "import.commit" && error instanceof DomainError && error.code === "CONFLICT") {
      emitSafely(telemetry, "import.conflict", fields)
    }
    throw error
  }
}

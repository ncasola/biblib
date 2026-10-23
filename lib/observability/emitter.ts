import type { TelemetryEvent, TelemetryField } from "./events"

/** Contrato compartido con módulos de dominio que también se usan en el cliente. */
export type TelemetryFieldValue = string | number | boolean
export type TelemetryFields = Partial<Record<TelemetryField, TelemetryFieldValue | null | undefined>> & Record<string, unknown>
export interface TelemetryEmitter {
  emit(event: TelemetryEvent, fields?: TelemetryFields): void
}

export const noopTelemetry: TelemetryEmitter = { emit() {} }

/** Incluso un adaptador inyectado defectuoso debe ser inocuo para el dominio. */
export function emitSafely(emitter: TelemetryEmitter, event: TelemetryEvent, fields: TelemetryFields): void {
  try { emitter.emit(event, fields) } catch { /* La telemetría es opcional. */ }
}

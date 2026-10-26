import "server-only"
import { headers } from "next/headers"
import { CORRELATION_HEADER, correlationHeaders, getCorrelationId, parseCorrelationIdHeader, withCorrelation } from "./correlation"
import { createLogger } from "./logger"

export { accountRef } from "./pseudonym"

const logger = createLogger()

/**
 * Emisor compartido del servidor: adjunta el `correlationId` activo (si lo hay)
 * y escribe JSON estructurado por stdout/stderr. Los puntos de dominio reciben
 * este objeto por inyección para no importar módulos de Node desde código
 * compartido con el navegador.
 */
export const telemetry = logger

/** Contador de campos descartados por la lista blanca (diagnóstico y pruebas). */
export function telemetryDroppedFields(): number {
  return logger.droppedFields
}

/**
 * Ejecuta una Server Action con contexto de correlación: lee y valida la
 * cabecera `x-correlation-id` entrante y genera un identificador nuevo cuando
 * falta o no es válido. Fuera de una petición en curso, empieza un contexto
 * nuevo sin lanzar.
 */
export async function withActionCorrelation<T>(operation: () => Promise<T>): Promise<T> {
  if (getCorrelationId()) return operation()
  let incoming: string | null = null
  try { incoming = (await headers()).get(CORRELATION_HEADER) } catch { incoming = null }
  return withCorrelation(operation, parseCorrelationIdHeader(incoming))
}

/** Permite seguir una petición con la misma cabecera en la respuesta HTTP. */
export async function withRequestCorrelation<T extends Response>(request: { headers: Headers }, operation: () => Promise<T>): Promise<T> {
  return withCorrelation(async () => {
    const response = await operation()
    response.headers.set(CORRELATION_HEADER, correlationHeaders().get(CORRELATION_HEADER)!)
    return response
  }, parseCorrelationIdHeader(request.headers.get(CORRELATION_HEADER)))
}

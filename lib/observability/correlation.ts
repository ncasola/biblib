/**
 * Correlación de operaciones con `AsyncLocalStorage` (U-OPS-01).
 *
 * No lleva `import "server-only"` a propósito: las pruebas unitarias lo
 * ejercitan con `node --test` y ese marcador lanza una excepción fuera del
 * compilador de React. Es un núcleo Node; la aplicación accede mediante
 * `server.ts`, que sí declara el límite `server-only`.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"

export const CORRELATION_HEADER = "x-correlation-id"

/** Token opaco de 8 a 64 caracteres; admite UUID con guiones y los propios. */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/

const storage = new AsyncLocalStorage<{ id: string }>()

export function generateCorrelationId(): string {
  return randomUUID()
}

export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === "string" && CORRELATION_ID_PATTERN.test(value) && !/^(?:sk[-_]|sb_(?:secret|publishable)_|AKIA)/i.test(value)
}

/**
 * Lee la cabecera `x-correlation-id` con validación de formato y longitud.
 * Una cabecera repetida o con espacios se rechaza. Cualquier contenido inválido se descarta (sin lanzar) y la
 * operación sigue con un identificador generado.
 */
export function parseCorrelationIdHeader(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  return isValidCorrelationId(value) ? value : undefined
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.id
}

/**
 * Ejecuta `fn` con un contexto de correlación. Si `id` falta o no supera la
 * validación, se reutiliza el contexto activo o se genera uno nuevo. Las anidaciones restauran el contexto
 * exterior al terminar y las ejecuciones concurrentes no comparten contexto.
 */
export async function withCorrelation<T>(fn: () => T | Promise<T>, id?: string): Promise<T> {
  const correlationId = isValidCorrelationId(id) ? id : getCorrelationId() ?? generateCorrelationId()
  return storage.run({ id: correlationId }, fn)
}

/** Copia cabeceras antes de propagar; nunca modifica las recibidas. */
export function correlationHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init)
  headers.set(CORRELATION_HEADER, getCorrelationId() ?? generateCorrelationId())
  return headers
}

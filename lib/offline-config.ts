import "server-only"

// U-EXP-08 · Banderas de servidor de la copia sin conexión (contrato: docs/spec-pendientes/contratos-o15.md).
// Se leen en tiempo de ejecución y se pasan al cliente como props: no hay variables NEXT_PUBLIC_.

/** Versión del service worker de shell estático. Cambiarla publica un worker nuevo que borra las cachés anteriores. */
export const SERVICE_WORKER_VERSION = "2026-10-26.1"

/** `BIBLIB_OFFLINE_SNAPSHOT=1` habilita «Guardar copia de lectura en este dispositivo». Apagada por defecto. */
export function offlineSnapshotEnabled(): boolean {
  return process.env.BIBLIB_OFFLINE_SNAPSHOT === "1"
}

export type ServiceWorkerMode = "activo" | "limpieza"

/**
 * `BIBLIB_SERVICE_WORKER=limpieza` publica el worker de limpieza: borra cachés y copias de este origen y se
 * da de baja. Cualquier otro valor deja el worker de shell estático (activo por defecto).
 */
export function serviceWorkerMode(): ServiceWorkerMode {
  return process.env.BIBLIB_SERVICE_WORKER === "limpieza" ? "limpieza" : "activo"
}

/** URL del script registrado: la versión y el modo forman parte de la URL, así que cambiarlos actualiza el worker. */
export function serviceWorkerUrl(mode: ServiceWorkerMode = serviceWorkerMode()): string {
  const params = new URLSearchParams({ v: SERVICE_WORKER_VERSION })
  if (mode === "limpieza") params.set("modo", "limpieza")
  return `/sw.js?${params.toString()}`
}

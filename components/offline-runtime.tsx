"use client"

import { createContext, useContext, useEffect, type ReactNode } from "react"
import { useAuth } from "@/lib/auth-context"
import { confirmOfflineSessionAction } from "@/app/actions/offline-library"
import { browserOfflineLibrary, offlineAccountId, OFFLINE_DB_PREFIX, readOfflineAccountPointer, writeOfflineAccountPointer } from "@/lib/offline-library"

// U-EXP-08 · Registro del service worker de shell estático y validación con conexión de la copia de
// lectura (contrato: docs/spec-pendientes/contratos-o15.md). Las banderas llegan del servidor como props.

interface OfflineConfig {
  snapshotEnabled: boolean
}

const OfflineConfigContext = createContext<OfflineConfig>({ snapshotEnabled: false })

export function useOfflineConfig(): OfflineConfig {
  return useContext(OfflineConfigContext)
}

/** Una validación por cuenta como mucho cada 10 minutos: no hace falta preguntar al servidor en cada página. */
const VALIDATION_INTERVAL_MS = 10 * 60 * 1000

/**
 * Validación con conexión: el servidor confirma la sesión de la cuenta y se reinicia el TTL de su copia en
 * este dispositivo (sin tocar sus datos ni su secreto). Devuelve si la copia quedó validada.
 */
export async function revalidateOfflineCopy(userId: string, { force = false }: { force?: boolean } = {}): Promise<boolean> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return false
  const accountId = await offlineAccountId(userId)
  const library = browserOfflineLibrary()
  const status = await library.status(accountId)
  if (status.state !== "locked" && status.state !== "expired") return false
  if (!force && status.state === "locked" && Date.now() - Date.parse(status.validatedAt) < VALIDATION_INTERVAL_MS) return true
  const confirmed = await confirmOfflineSessionAction()
  if (!confirmed.ok || confirmed.value.userId !== userId) return false
  return library.touchValidation(accountId)
}

/** Worker de limpieza sin worker instalado: borra directamente las cachés y las copias que queden. */
async function cleanLocally(): Promise<void> {
  if (typeof caches !== "undefined") await Promise.all((await caches.keys()).filter((key) => key.startsWith("biblib-")).map((key) => caches.delete(key)))
  if (typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function") {
    for (const { name } of await indexedDB.databases()) if (name?.startsWith(OFFLINE_DB_PREFIX)) indexedDB.deleteDatabase(name)
  }
}

export function OfflineRuntime({ snapshotEnabled, serviceWorkerUrl, registerWorker, cleanup, children }: {
  snapshotEnabled: boolean
  serviceWorkerUrl: string
  /** Falso en `next dev`: el worker solo se registra con un build de producción. */
  registerWorker: boolean
  cleanup: boolean
  children: ReactNode
}) {
  const { user, loading } = useAuth()
  const userId = user?.id

  useEffect(() => {
    if (!registerWorker || !("serviceWorker" in navigator) || !window.isSecureContext) return
    const run = async () => {
      if (cleanup) {
        // Solo se instala el worker de limpieza si hay un worker que sustituir; si no, se limpia aquí mismo.
        if (await navigator.serviceWorker.getRegistration()) await navigator.serviceWorker.register(serviceWorkerUrl, { scope: "/", updateViaCache: "none" })
        else await cleanLocally()
        return
      }
      await navigator.serviceWorker.register(serviceWorkerUrl, { scope: "/", updateViaCache: "none" })
    }
    void run().catch(() => undefined)
  }, [registerWorker, serviceWorkerUrl, cleanup])

  useEffect(() => {
    if (!snapshotEnabled || loading || !userId) return
    let active = true
    const sync = async () => {
      if (!navigator.onLine) return
      try {
        const accountId = await offlineAccountId(userId)
        const status = await browserOfflineLibrary().status(accountId)
        if (!active) return
        // La cuenta con sesión pasa a ser la de la vista sin conexión y la de otra cuenta queda bloqueada.
        // Sin copia de esta cuenta (sin consentimiento) no se guarda nada en el dispositivo.
        if (status.state !== "none") writeOfflineAccountPointer(accountId)
        else if (readOfflineAccountPointer() !== null) writeOfflineAccountPointer(null)
        await revalidateOfflineCopy(userId)
      } catch { /* Sin IndexedDB o sin red: la copia sigue como estaba y vence con su TTL. */ }
    }
    void sync()
    window.addEventListener("online", sync)
    return () => {
      active = false
      window.removeEventListener("online", sync)
    }
  }, [snapshotEnabled, loading, userId])

  return <OfflineConfigContext.Provider value={{ snapshotEnabled }}>{children}</OfflineConfigContext.Provider>
}

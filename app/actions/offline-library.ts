"use server"

import { withRlsContext } from "@/lib/db/client"
import { getRequiredUserId } from "@/lib/server-user"
import { DomainError, translateDatabaseError } from "@/lib/domain-errors"
import type { ActionResult } from "@/lib/action-result"
import { domainMutation } from "@/lib/server-action"
import { readExportLibrary } from "@/lib/library-export-server"
import { offlineSnapshotEnabled } from "@/lib/offline-config"
import { buildOfflineSnapshot, type OfflineSnapshot } from "@/lib/offline-library"

// U-EXP-08 · Lecturas para la copia de lectura sin conexión. Solo lectura: no hay ninguna acción que
// acepte cambios hechos sin conexión. La copia la cifra el navegador; el servidor solo entrega la
// proyección con lista blanca de campos (contrato en docs/spec-pendientes/contratos-o15.md).

const disabled = () => new DomainError("NOT_FOUND", "La copia de lectura sin conexión no está habilitada en este servidor.")

/** Proyección de la colección de la sesión para guardarla cifrada en este dispositivo. */
export async function getOfflineSnapshotAction(): Promise<ActionResult<OfflineSnapshot>> {
  return domainMutation(async () => {
    if (!offlineSnapshotEnabled()) throw disabled()
    const userId = await getRequiredUserId()
    let read: Awaited<ReturnType<typeof readExportLibrary>>
    try { read = await withRlsContext(userId, (tx) => readExportLibrary(tx, userId)) } catch (error) { translateDatabaseError(error) }
    if (!read) throw new DomainError("PROVIDER_UNAVAILABLE", "Tu biblioteca estaba cambiando mientras se preparaba la copia. No se ha guardado nada; vuelve a intentarlo.")
    return buildOfflineSnapshot(read.data, new Date())
  })
}

/** Validación con conexión: el servidor confirma qué cuenta tiene la sesión. Reinicia el TTL de su copia. */
export async function confirmOfflineSessionAction(): Promise<ActionResult<{ userId: string }>> {
  return domainMutation(async () => {
    if (!offlineSnapshotEnabled()) throw disabled()
    return { userId: await getRequiredUserId() }
  })
}

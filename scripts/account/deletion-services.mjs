// U-OPS-03 · Storage y GoTrue del worker administrativo de eliminación, con la credencial de servicio del entorno local
// o del despliegue del worker. Vive en scripts/ porque solo lo usan procesos fuera de Next (el worker, sus pruebas y el
// ensayo de restore): la app no contiene código con esa credencial. Implementa DeletionStorage y DeletionAuth de
// lib/account-deletion/worker.ts.

/** Un usuario que GoTrue ya no tiene: el paso se da por hecho (reintento tras borrar la identidad). */
const missingUser = (error) => error?.status === 404

/** La duración del bloqueo supera cualquier plazo de la eliminación: la identidad se borra antes de que venza. */
export function createSupabaseDeletionServices(admin) {
  return {
    storage: {
      async remove(bucket, names) {
        const { error } = await admin.storage.from(bucket).remove(names)
        if (error) throw error
      },
    },
    auth: {
      async revokeSessions(owner) {
        const { error } = await admin.auth.admin.updateUserById(owner, { ban_duration: "876000h" })
        if (error && !missingUser(error)) throw error
      },
      async deleteIdentity(owner) {
        const { error } = await admin.auth.admin.deleteUser(owner)
        if (error && !missingUser(error)) throw error
      },
    },
  }
}

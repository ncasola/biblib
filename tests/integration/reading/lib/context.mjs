import { randomUUID } from "node:crypto"
import { readingContext } from "../../reading-loans/lib/context.mjs"

export { PROFILES, value } from "../../product/lib/context.mjs"

// Contexto del grupo reading (U-PRO-02). Reutiliza el harness de reading-loans (cuentas desechables con GoTrue real,
// biblioteca mínima, segunda conexión) y añade lo propio: las operaciones de lectura pasan siempre por las Server Actions
// reales con sesiones GoTrue (dos sesiones de la misma cuenta son dos dispositivos); las consultas directas del proceso de
// pruebas solo comprueban el resultado.

/** Código de una respuesta de acción: OK, el código de dominio, THROWN o el estado HTTP. */
export function errorCode(result) {
  if (result.status !== 200) return `HTTP ${result.status}`
  return result.value?.ok === false ? result.value.error.code : result.thrown ? "THROWN" : "OK"
}

export async function readingActionsContext() {
  const ctx = await readingContext()
  return Object.assign(ctx, {
    label: (text) => `[PRO-02 ${ctx.run}] ${text}`,
    entryId: () => randomUUID(),
    /** Ciclos del ejemplar tal como están en la base, por número; instantes en UTC. */
    async cycles(copyId) {
      return [...await ctx.sql`select id, cycle_number, status, to_char(started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as started_at, to_char(finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as finished_at, version
        from biblib.reading_cycles where copy_id = ${copyId} order by cycle_number`].map((row) => ({ ...row }))
    },
    /** Entradas del ejemplar (de todos sus ciclos), por instante. */
    async entries(copyId) {
      return [...await ctx.sql`select e.id, r.cycle_number, to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at, e.page_from, e.page_to, e.note
        from biblib.reading_entries e join biblib.reading_cycles r on r.id = e.cycle_id where r.copy_id = ${copyId} order by e.occurred_at, e.id`].map((row) => ({ ...row }))
    },
    /** Estado actual y versión del ejemplar: la lectura nunca los cambia. */
    async copy(copyId) {
      const [row] = await ctx.sql`select status, version from biblib.copies where id = ${copyId}`
      return { ...row }
    },
    /** Solicitud de eliminación confirmada como el dueño: a partir de aquí sus escrituras dan BD001. */
    async requestDeletion(userId) {
      await ctx.asUser(userId, (tx) => tx`select biblib.account_deletion_request(${ctx.key("eliminar")})`)
    },
  })
}

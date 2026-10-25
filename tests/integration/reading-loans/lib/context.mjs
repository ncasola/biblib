import { closeConnection, connect } from "../../../../scripts/db/target.mjs"
import { productContext } from "../../product/lib/context.mjs"

export { PROFILES, value } from "../../product/lib/context.mjs"

// Contexto del grupo reading-loans (O14, lote D de 0015). Reutiliza el harness del grupo product (cuentas desechables con
// GoTrue real, claims del dueño con el rol `authenticated`, acciones y exportación por la app compilada, worker real de
// eliminación) y añade una segunda conexión para simular dos dispositivos que escriben a la vez.
const ROLLBACK = Symbol("rollback")

export async function readingContext() {
  const ctx = await productContext()
  const second = connect(ctx.resolved, { applicationName: "biblib-reading-loans-second" })
  const claims = async (tx, userId) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${userId}, true)`
    await tx`set local role authenticated`
  }
  const close = ctx.close
  return Object.assign(ctx, {
    label: (text) => `[O14-D ${ctx.run}] ${text}`,
    /** Transacción confirmada del dueño en la segunda conexión (otro dispositivo). */
    asUserElsewhere(userId, work) { return second.begin(async (tx) => { await claims(tx, userId); return work(tx) }) },
    /** Transacción revertida con un huso horario de sesión distinto: las fechas civiles no deben moverse. */
    async inTimeZone(userId, timeZone, work) {
      let result
      try {
        await second.begin(async (tx) => {
          await tx`select set_config('TimeZone', ${timeZone}, true)`
          await claims(tx, userId)
          result = await work(tx)
          throw ROLLBACK
        })
      } catch (error) { if (error !== ROLLBACK) throw error }
      return result
    },
    /** Ejemplar con un total de páginas conocido (0 = desconocido) y su estado actual. */
    async setPages(copyId, pages) {
      await ctx.sql`update biblib.editions set number_of_pages = ${pages} where id = (select edition_id from biblib.copies where id = ${copyId})`
    },
    async close() { await closeConnection(second); await close() },
  })
}

/** Lectura y préstamos comparables de una cuenta: con IDs, sin versiones ni fechas técnicas; instantes en UTC. */
export async function readingState(sql, owner) {
  const rows = async (query) => [...await query].map((row) => ({ ...row }))
  return {
    cycles: await rows(sql`select id, copy_id, cycle_number, status, to_char(started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as started_at,
      to_char(finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as finished_at from biblib.reading_cycles where user_id = ${owner} order by id`),
    entries: await rows(sql`select id, cycle_id, to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at, page_from, page_to, note
      from biblib.reading_entries where user_id = ${owner} order by id`),
    loans: await rows(sql`select id, copy_id, borrower_label, loaned_on::text as loaned_on, due_on::text as due_on, returned_on::text as returned_on, note
      from biblib.loans where user_id = ${owner} order by id`),
  }
}

/** Resultado jsonb de una función de 0015 ejecutada como el dueño. */
export async function call(tx, statement) {
  const [row] = await statement(tx)
  return row.result
}

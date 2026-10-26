// Contexto del grupo series (U-PRO-05): el mismo harness del grupo product (cuentas desechables con sesión GoTrue real,
// Server Actions por HTTP y transacciones con los claims del dueño). Solo añade ayudas propias de las series.
import { productContext, productState, value, PROFILES } from "../../product/lib/context.mjs"

export { PROFILES, productState, value }

export async function seriesContext() {
  const ctx = await productContext()
  return Object.assign(ctx, {
    /** Resultado crudo de una acción (para comprobar el código de error sin lanzar). */
    async attempt(name, args, session) {
      const result = await ctx.call(name, args, session)
      return result.value?.ok === false ? { ok: false, code: result.value.error.code, message: result.value.error.message } : { ok: true, value: result.value?.value, status: result.status }
    },
    /** Volúmenes de una serie por SQL, en orden exacto y con la posición como texto. */
    seriesRows(owner, seriesId) {
      return ctx.sql`select edition_id, trim_scale(position)::text as position, volume_label, order_note from biblib.series_editions
        where user_id = ${owner} and series_id = ${seriesId} order by position nulls last, edition_id`
    },
  })
}

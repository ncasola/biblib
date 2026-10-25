import { readState, writeState } from "./state.mjs"

// U-OPS-03 · Registro privado de supresiones del perfil (`.biblib/state/<perfil>-suppressions.json`, fuera de Git).
// Copia, fuera de la base, de las marcas de `biblib.account_deletions`: el worker administrativo y db:backup:local lo
// actualizan, y db:restore:local lo aplica antes de abrir el destino, aunque el respaldo sea anterior a la supresión
// y la base del perfil se haya reconstruido. Solo IDs de cuenta, fechas y estado; nunca correos ni datos de la
// biblioteca. Una entrada se retira cuando vence su marca (`purgeAfter`).
const SUFFIX = "-suppressions"

/** Entradas vigentes del registro, por ID de cuenta. */
export function readSuppressions(stack, { now = Date.now() } = {}) {
  const state = readState(stack, SUFFIX)
  const entries = Array.isArray(state?.entries) ? state.entries : []
  return entries.filter((entry) => typeof entry.userId === "string" && /^[0-9a-f-]{36}$/i.test(entry.userId) && !(entry.purgeAfter && Date.parse(entry.purgeAfter) <= now))
}

/** Une las marcas leídas de la base con el registro: una cuenta nunca sale del registro antes de que venza su marca. */
export function mergeSuppressions(stack, marks, { now = Date.now() } = {}) {
  const byUser = new Map(readSuppressions(stack, { now }).map((entry) => [entry.userId, entry]))
  for (const mark of marks) {
    const previous = byUser.get(mark.userId)
    byUser.set(mark.userId, {
      userId: mark.userId,
      requestedAt: previous?.requestedAt ?? mark.requestedAt,
      completedAt: mark.completedAt ?? previous?.completedAt ?? null,
      purgeAfter: [mark.purgeAfter, previous?.purgeAfter].filter(Boolean).sort().at(-1) ?? null,
    })
  }
  const entries = [...byUser.values()].sort((a, b) => a.userId.localeCompare(b.userId))
  writeState(stack, { entries }, SUFFIX)
  return entries
}

/** Marcas de la base (solicitudes en curso y terminadas) en el formato del registro. */
export async function readMarks(sql) {
  const [present] = await sql`select to_regclass('biblib.account_deletions') is not null as found`
  if (!present.found) return []
  const rows = await sql`select user_id::text as user_id, requested_at, completed_at, purge_after from biblib.account_deletions order by user_id`
  return rows.map((row) => ({ userId: row.user_id, requestedAt: row.requested_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null, purgeAfter: row.purge_after?.toISOString() ?? null }))
}

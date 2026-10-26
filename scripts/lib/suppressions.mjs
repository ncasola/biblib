import { existsSync, readFileSync } from "node:fs"
import { LEDGER } from "../db/journal-guard.mjs"
import { contentDigests, tokenHashes } from "./backup-db.mjs"
import { BiblibError, EXIT } from "./exit-codes.mjs"
import { readState, writeState } from "./state.mjs"

// U-OPS-03 · Registro privado de supresiones del perfil (`.biblib/state/<perfil>-suppressions.json`, fuera de Git).
// Copia, fuera de la base, de las marcas de `biblib.account_deletions`: el worker administrativo y db:backup:local lo
// actualizan, y db:restore:local lo aplica antes de abrir el destino, aunque el respaldo sea anterior a la supresión
// y la base del perfil se haya reconstruido. Solo IDs de cuenta, fechas y estado; nunca correos ni datos de la
// biblioteca. Una entrada se retira cuando vence su marca (`purgeAfter`).
const SUFFIX = "-suppressions"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Plazo de la marca: el mismo que MARK_RETENTION_DAYS de lib/account-deletion/worker.ts. */
export const MARK_DAYS = 90

const valid = (entry, now) => entry && typeof entry.userId === "string" && UUID.test(entry.userId) && !(entry.purgeAfter && Date.parse(entry.purgeAfter) <= now)

/** Entradas vigentes del registro del perfil. */
export function readSuppressions(stack, { now = Date.now() } = {}) {
  const state = readState(stack, SUFFIX)
  return (Array.isArray(state?.entries) ? state.entries : []).filter((entry) => valid(entry, now))
}

/** Registro exportado de otro perfil o entorno (`--suppressions`): el mismo formato, validado entrada a entrada. */
export function readSuppressionsFile(file, { now = Date.now() } = {}) {
  if (!existsSync(file)) throw new BiblibError(EXIT.INVALID_ARGS, "supresiones", "No existe el registro de supresiones indicado.")
  let parsed
  try { parsed = JSON.parse(readFileSync(file, "utf8")) } catch { throw new BiblibError(EXIT.INVALID_ARGS, "supresiones", "El registro de supresiones no es JSON válido.") }
  if (!Array.isArray(parsed?.entries) || parsed.entries.some((entry) => !entry || !UUID.test(String(entry.userId)))) throw new BiblibError(EXIT.INVALID_ARGS, "supresiones", "El registro de supresiones tiene entradas sin un ID de cuenta válido.")
  return parsed.entries.filter((entry) => valid(entry, now))
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
  const entries = [...byUser.values()].filter((entry) => valid(entry, now)).sort((a, b) => a.userId.localeCompare(b.userId))
  writeState(stack, { entries }, SUFFIX)
  return entries
}

/** Marcas de la base (solicitudes en curso y terminadas) en el formato del registro. Vacío antes de 0013. */
export async function readMarks(sql) {
  const [present] = await sql`select to_regclass('biblib.account_deletions') is not null as found`
  if (!present.found) return []
  const rows = await sql`select user_id::text as user_id, requested_at, completed_at, purge_after from biblib.account_deletions order by user_id`
  return rows.map((row) => ({ userId: row.user_id, requestedAt: row.requested_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null, purgeAfter: row.purge_after?.toISOString() ?? null }))
}

/** IDs suprimidos que conoce un destino: sus marcas y el registro del perfil. */
export async function suppressedIds(sql, entries = []) {
  return [...new Set([...(await readMarks(sql)).map((mark) => mark.userId), ...entries.map((entry) => entry.userId)])].sort()
}

/** Restos de una cuenta en el destino: con 0013, `account_residue`; antes, solo su identidad y sus objetos. */
export async function residueOf(sql, userId) {
  const [present] = await sql`select to_regprocedure('biblib.account_residue(uuid)') is not null as found`
  if (present.found) {
    const [{ residue }] = await sql`select biblib.account_residue(${userId}::uuid) as residue`
    return { rows: residue.rows, objects: residue.objects, account: residue.account }
  }
  const [row] = await sql`select (select count(*)::integer from storage.objects where name like ${`${userId}/%`} or owner = ${userId}::uuid) as objects,
    exists(select 1 from auth.users where id = ${userId}::uuid) as account`
  return { rows: 0, objects: row.objects, account: row.account }
}

async function removeObjects(sql, admin, userId) {
  let removed = 0, previous = ""
  for (;;) {
    const rows = await sql`select bucket_id as bucket, name from storage.objects where name like ${`${userId}/%`} or owner = ${userId}::uuid order by bucket_id, name limit 100`
    if (!rows.length) return removed
    const batch = rows.map((row) => `${row.bucket}/${row.name}`).join("\n")
    if (batch === previous) throw new BiblibError(EXIT.SERVICE_UNAVAILABLE, "suppress", "Storage conserva objetos de una cuenta suprimida; el destino no se abre.")
    previous = batch
    for (const bucket of new Set(rows.map((row) => row.bucket))) {
      const { error } = await admin.storage.from(bucket).remove(rows.filter((row) => row.bucket === bucket).map((row) => row.name))
      if (error) throw new BiblibError(EXIT.SERVICE_UNAVAILABLE, "suppress", "Storage no retiró un objeto de una cuenta suprimida; el destino no se abre.")
    }
    removed += rows.length
  }
}

/**
 * Fase `suppress` de db:restore:local, antes de abrir el destino: toda cuenta suprimida (marcas restauradas con el
 * respaldo, registro del perfil y `--suppressions`) que el respaldo devolvió pierde sus objetos de Storage y su
 * identidad (GoTrue; la cascada de auth.users retira sus filas), y queda su marca `completed`. Devuelve solo
 * cantidades y los hechos de las tablas que cambian, para que db:restore:verify las compare con ese estado.
 */
export async function applySuppressions({ sql, admin, entries = [], manifest, markDays = MARK_DAYS }) {
  const restored = await readMarks(sql)
  const wanted = new Map()
  for (const entry of [...entries, ...restored]) if (!wanted.has(entry.userId)) wanted.set(entry.userId, entry)
  const empty = { accounts: 0, marks: 0, objects: 0, adjusted: [], tokensRemoved: {}, sampleRemoved: [], review: [] }
  if (!wanted.size) return empty
  const ids = [...wanted.keys()]
  const present = (await sql`select id::text as id from auth.users where id = any(${ids}::uuid[]) order by id`).map((row) => row.id)
  const existing = await sql`select schemaname as schema, tablename as table from pg_tables where schemaname in ('biblib', ${LEDGER.schema}, 'auth', 'storage')`
  const tables = (manifest.digests ?? []).map(({ schema, table }) => ({ schema, table })).filter((t) => existing.some((e) => e.schema === t.schema && e.table === t.table))
  const before = await contentDigests(sql, tables)
  const tokensBefore = await tokenHashes(sql)
  let objects = 0
  for (const userId of present) {
    objects += await removeObjects(sql, admin, userId)
    const { error } = await admin.auth.admin.deleteUser(userId)
    if (error && error.status !== 404) throw new BiblibError(EXIT.SERVICE_UNAVAILABLE, "suppress", "GoTrue no eliminó una cuenta suprimida restaurada; el destino no se abre.")
  }
  const [marksFunction] = await sql`select to_regprocedure('biblib.account_deletion_suppress(uuid, timestamptz, integer)') is not null as found`
  if (marksFunction.found) for (const entry of wanted.values()) await sql`select biblib.account_deletion_suppress(${entry.userId}::uuid, ${entry.requestedAt ?? null}::timestamptz, ${markDays}::integer)`
  for (const userId of ids) {
    const residue = await residueOf(sql, userId)
    if (residue.rows || residue.objects || residue.account) throw new BiblibError(EXIT.VERIFICATION_FAILED, "suppress", "Una cuenta suprimida conserva filas, objetos o identidad tras aplicar la supresión; el destino no se abre.")
  }
  const after = await contentDigests(sql, tables)
  const tokensAfter = await tokenHashes(sql)
  const adjusted = after.filter((a) => { const b = before.find((d) => d.schema === a.schema && d.table === a.table); return !b || b.count !== a.count || b.keys !== a.keys || b.content !== a.content })
  const tokensRemoved = Object.fromEntries(Object.entries(tokensBefore).map(([token, hashes]) => [token, hashes.length - (tokensAfter[token]?.length ?? 0)]).filter(([, removed]) => removed > 0))
  const sampleIds = (manifest.sample ?? []).map((item) => item.id)
  const stillThere = new Set(sampleIds.length ? (await sql`select id::text as id from biblib.books where id = any(${sampleIds}::uuid[])`).map((row) => row.id) : [])
  const review = marksFunction.found ? [] : [{ table: "biblib.account_deletions", message: `${wanted.size} supresión(es) aplicadas sin marca: el respaldo es anterior a 0013. Tras migrar, el registro del perfil las conserva.` }]
  return { accounts: present.length, marks: marksFunction.found ? wanted.size : 0, objects, adjusted, tokensRemoved, sampleRemoved: sampleIds.filter((id) => !stillThere.has(id)), review }
}

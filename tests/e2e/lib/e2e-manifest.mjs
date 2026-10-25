import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { BiblibError, EXIT } from "../../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../../scripts/lib/profiles.mjs"

// Manifiesto privado del E2E (.biblib/e2e/, ignorado por Git). Guarda el inicio del run (hora de
// Postgres) y las instantáneas de biblioteca que un recorrido destructivo (reemplazo) debe restaurar.
// Solo contiene datos ficticios de A/B, nunca sesiones ni contraseñas. La limpieza borra:
//   - fichas y estanterías con la marca `[QA-02 ` de las cuentas A/B (exclusiva de este E2E);
//   - vistas previas y operaciones de importación de A/B creadas desde el inicio del run;
// y restaura las instantáneas pendientes. Si algo falla, el manifiesto se conserva y sale con 10.

export const E2E_MARKER = "QA-02"

export function e2eManifestFile(root = REPO_ROOT) {
  const dir = path.join(root, ".biblib", "e2e")
  for (const entry of [path.join(root, ".biblib"), dir]) {
    if (existsSync(entry) && lstatSync(entry).isSymbolicLink()) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "manifiesto", "El manifiesto del E2E no puede atravesar enlaces.")
  }
  return path.join(dir, "test-run.json")
}

export function readE2EManifest(file) {
  if (!existsSync(file)) return null
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    if (manifest.schemaVersion !== 1 || !/^[0-9a-f]{12}$/.test(manifest.runId) || Number.isNaN(Date.parse(manifest.startedAt)) || !Array.isArray(manifest.snapshots)) throw new Error()
    return manifest
  } catch { throw new BiblibError(EXIT.IDENTITY_MISMATCH, "manifiesto", "Manifiesto del E2E dañado; revísalo antes de borrar nada a mano.") }
}

function writeE2EManifest(file, manifest) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
}

export async function startE2EManifest(file, { runId, sql }) {
  const [{ now }] = await sql`select now() as now`
  writeE2EManifest(file, { schemaVersion: 1, runId, startedAt: new Date(now).toISOString(), snapshots: [] })
}

/**
 * Copia literal de las estanterías y fichas de una cuenta, para devolverla a su estado tras un reemplazo.
 * @returns {Promise<{ userId: string, shelves: Array<{ id: string, is_default: boolean }>, books: Array<{ id: string }> }>}
 */
export async function snapshotLibrary(sql, userId) {
  const shelves = await sql`select to_jsonb(s) as row from biblib.shelves s where s.user_id = ${userId} order by s.id`
  const books = await sql`select to_jsonb(b) as row from biblib.books b where b.user_id = ${userId} order by b.id`
  return { userId, shelves: shelves.map((r) => r.row), books: books.map((r) => r.row) }
}

/** Se anota antes de la operación destructiva, para que un fallo intermedio deje la restauración pendiente. */
export function recordSnapshot(file, snapshot) {
  const manifest = readE2EManifest(file)
  if (!manifest) throw new BiblibError(EXIT.VERIFICATION_FAILED, "manifiesto", "Falta el manifiesto del E2E en curso; ejecuta los recorridos con pnpm test:e2e:local.")
  manifest.snapshots = [...manifest.snapshots.filter((item) => item.userId !== snapshot.userId), snapshot]
  writeE2EManifest(file, manifest)
}

export function forgetSnapshot(file, userId) {
  const manifest = readE2EManifest(file)
  if (!manifest) return
  manifest.snapshots = manifest.snapshots.filter((item) => item.userId !== userId)
  writeE2EManifest(file, manifest)
}

/** Devuelve la biblioteca de la cuenta exactamente a la instantánea (IDs, fichas, catálogo y fechas). */
export async function restoreLibrary(sql, snapshot) {
  await sql.begin(async (tx) => {
    const defaults = snapshot.shelves.filter((shelf) => shelf.is_default)
    await tx`delete from biblib.books where user_id = ${snapshot.userId}`
    await tx`delete from biblib.shelves where user_id = ${snapshot.userId} and not is_default`
    const [current] = await tx`select id from biblib.shelves where user_id = ${snapshot.userId} and is_default`
    if (defaults[0] && current?.id !== defaults[0].id) {
      await tx`delete from biblib.shelves where user_id = ${snapshot.userId} and is_default`
      await tx`insert into biblib.shelves select * from jsonb_populate_recordset(null::biblib.shelves, ${tx.json(defaults)})`
    }
    const custom = snapshot.shelves.filter((shelf) => !shelf.is_default)
    if (custom.length) await tx`insert into biblib.shelves select * from jsonb_populate_recordset(null::biblib.shelves, ${tx.json(custom)})`
    if (snapshot.books.length) await tx`insert into biblib.books select * from jsonb_populate_recordset(null::biblib.books, ${tx.json(snapshot.books)})`
  })
}

/** Limpieza acotada a las cuentas A/B y a la marca del E2E. Lanza 10 si queda algo pendiente. */
export async function cleanupE2E({ sql, users, file }) {
  const manifest = readE2EManifest(file)
  if (!manifest) return
  const owners = [users.a, users.b]
  const pending = []
  for (const snapshot of manifest.snapshots) {
    if (!owners.includes(snapshot.userId)) { pending.push(snapshot); continue }
    try { await restoreLibrary(sql, snapshot) } catch { pending.push(snapshot) }
  }
  let leftovers = 0
  try {
    await sql`delete from biblib.library_operations where user_id in ${sql(owners)} and created_at >= ${manifest.startedAt}`
    await sql`delete from biblib.import_previews where user_id in ${sql(owners)} and created_at >= ${manifest.startedAt}`
    await sql`delete from biblib.books where user_id in ${sql(owners)} and title like ${`[${E2E_MARKER} %`}`
    await sql`delete from biblib.series where user_id in ${sql(owners)} and title like ${`[${E2E_MARKER} %`}`
    await sql`delete from biblib.shelves s where s.user_id in ${sql(owners)} and not s.is_default and s.title like ${`[${E2E_MARKER} %`}
      and not exists (select 1 from biblib.books b where b.user_id = s.user_id and b.shelf_id = s.id)`
    const [{ count }] = await sql`select (select count(*) from biblib.books where user_id in ${sql(owners)} and title like ${`[${E2E_MARKER} %`})
      + (select count(*) from biblib.shelves where user_id in ${sql(owners)} and title like ${`[${E2E_MARKER} %`}) as count`
    leftovers = Number(count)
  } catch { leftovers = -1 }
  if (!pending.length && leftovers === 0) { rmSync(file, { force: true }); return }
  writeE2EManifest(file, { ...manifest, snapshots: pending })
  throw new BiblibError(EXIT.SEED_FAILED, "limpieza", `Limpieza del E2E incompleta (${pending.length} restauración(es) pendiente(s), ${leftovers < 0 ? "error al borrar" : `${leftovers} resto(s) marcados`}); se conserva ${path.relative(REPO_ROOT, file)}.`)
}

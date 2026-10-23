import { rmSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { REPO_ROOT } from "../lib/profiles.mjs"
import { acquireLock } from "../lib/state.mjs"
import { fixtureId, fixtureFile, readFixtureStore, writeFixtureStore } from "../db/fixture-store.mjs"
import { loadJournal } from "../db/journal-guard.mjs"
import { acquireMigrationLock, releaseMigrationLock } from "../db/migrate.mjs"
import { closeConnection, connect, inspectDatabase } from "../db/target.mjs"
import { DATASET_ID, isScale, SCALE_EMAIL, scaleDataset, datasetHash, summarize, SCALES } from "./lib/dataset.mjs"

// Seed de escala (U-QA-03): `db:seed:local --scale 100|1000|10000`. Cuenta fixture propia
// `escala@biblib.test`, separada del censo A/B (que no se toca). Solo perfiles `test` y `scratch`.
// Cada ejecución deja exactamente N libros ficticios en esa cuenta; repetirla es idempotente.

const fail = (code, phase, message) => { throw new BiblibError(code, phase, message) }
const CHUNK = 500
const SCALE_PROFILES = ["test", "scratch"]

/** Censo sintético de una sola cuenta: reutiliza el registro privado de fixtures sin tocar el censo A/B. */
export function scaleCensus(base) {
  return {
    censusVersion: base.censusVersion, censusId: base.censusId,
    accounts: [{ key: "escala", email: SCALE_EMAIL, user_metadata: { biblib_fixture: base.censusId, biblib_scale: DATASET_ID, full_name: "Cuenta de escala" } }],
  }
}

/** El registro vive en `.biblib/fixtures/<perfil>-escala.json`, con las mismas guardas que el de A/B. */
export function scaleResolved(resolved) {
  return { ...resolved, profile: `${resolved.profile}-escala` }
}

export function parseScale(value) {
  const scale = /^\d+$/.test(String(value)) ? Number(value) : Number.NaN
  if (!isScale(scale)) fail(EXIT.INVALID_ARGS, "argumentos", `--scale admite ${SCALES.join(", ")}.`)
  return scale
}

/** Solo dominio, en una transacción y acotado a un propietario: sustituye su biblioteca por el dataset. */
export async function seedScaleDomain(sql, userId, dataset, census) {
  await sql.begin(async (tx) => {
    const idOf = (kind, key) => fixtureId(DATASET_ID, userId, kind, key)
    await tx`delete from biblib.books where user_id = ${userId}`
    await tx`delete from biblib.shelves where user_id = ${userId} and not is_default`
    const shelfIds = new Map()
    for (const shelf of dataset.shelves) {
      if (shelf.isDefault) {
        const [row] = await tx`insert into biblib.shelves (user_id, title, is_default) values (${userId}, ${shelf.title}, true)
          on conflict (user_id, is_default) where is_default = true do update set title = excluded.title, updated_at = now() returning id`
        shelfIds.set(shelf.fixtureKey, row.id)
      } else {
        const id = idOf("shelf", shelf.fixtureKey)
        await tx`insert into biblib.shelves (id, user_id, title, is_default) values (${id}, ${userId}, ${shelf.title}, false)`
        shelfIds.set(shelf.fixtureKey, id)
      }
    }
    for (let from = 0; from < dataset.books.length; from += CHUNK) {
      const rows = dataset.books.slice(from, from + CHUNK).map((book) => ({
        id: idOf("book", book.fixtureKey), user_id: userId, isbn: book.isbn, title: book.title, subtitle: book.subtitle,
        authors: tx.json(book.authors), publishers: tx.json(book.publishers),
        catalogue: tx.json({ source: book.source, isbnVerified: false, fixtureKey: book.fixtureKey, censusId: census.censusId, datasetId: DATASET_ID }),
        number_of_pages: book.number_of_pages, publish_date: book.publish_date, status: book.status,
        shelf_id: shelfIds.get(book.shelfKey), created_at: book.createdAt, updated_at: book.updatedAt,
      }))
      await tx`insert into biblib.books ${tx(rows, "id", "user_id", "isbn", "title", "subtitle", "authors", "publishers", "catalogue", "number_of_pages", "publish_date", "status", "shelf_id", "created_at", "updated_at")}`
    }
    const [{ n }] = await tx`select count(*)::int as n from biblib.books where user_id = ${userId}`
    if (n !== dataset.books.length) fail(EXIT.SEED_FAILED, "dominio", "El recuento de libros de escala no coincide con el dataset; la transacción se revierte.")
  })
  // Estadísticas frescas: las medidas y los EXPLAIN no deben depender del momento del autovacuum.
  await sql`analyze biblib.books`
  await sql`analyze biblib.shelves`
}

/**
 * `deps` trae las primitivas de seed-local.mjs (resolveSeedTarget, seedAccounts, loadCensus): así este módulo
 * no importa el seed y evita un ciclo de módulos. Los tests inyectan además connect/createClient.
 */
export async function runScaleSeed({ profile, scale, root = REPO_ROOT, signal, lockHeld = false }, deps) {
  if (!SCALE_PROFILES.includes(profile)) fail(EXIT.IDENTITY_MISMATCH, "perfil", "El seed de escala solo admite los perfiles test y scratch, nunca main.")
  parseScale(scale)
  const resolved = await deps.resolveSeedTarget(profile, { root })
  const release = lockHeld ? () => {} : acquireLock(resolved.stack)
  let sql, locked = false, phase = "ledger"
  const checkSignal = () => { if (signal?.aborted) fail(EXIT.INTERRUPTED, phase, "Seed de escala interrumpido; repite el comando.") }
  try {
    sql = (deps.connect ?? connect)(resolved, { applicationName: "biblib-seed-escala" })
    await (deps.acquireMigrationLock ?? acquireMigrationLock)(sql, { signal })
    locked = true
    const inspection = await sql.begin("read only", (tx) => (deps.inspectDatabase ?? inspectDatabase)(tx, loadJournal()))
    if (inspection.code !== EXIT.OK) fail(inspection.code, "ledger", "Historial u objetos divergentes; consulta db:status:local antes del seed.")
    if (inspection.state !== "up-to-date") fail(EXIT.PLAN_REJECTED, "ledger", "Hay migraciones pendientes: ejecuta db:plan:local y db:migrate:local para este perfil antes del seed.")
    phase = "registro"
    const values = resolved.target.env()
    if (!values.SUPABASE_SERVICE_ROLE_KEY) fail(EXIT.SEED_FAILED, phase, "Falta la credencial administrativa local; consulta el estado privado del perfil sin imprimirlo.")
    const census = scaleCensus(deps.loadCensus(root))
    const own = scaleResolved(resolved)
    const store = readFixtureStore(own, census) ?? { schemaVersion: 1, censusVersion: census.censusVersion, censusId: census.censusId, fingerprint: resolved.fingerprint, accounts: {} }
    const save = () => { store.phase = phase; writeFixtureStore(own, store) }
    const admin = (deps.createClient ?? createClient)(values.SUPABASE_URL, values.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    phase = "auth"
    await deps.seedAccounts(admin, census, store, save)
    checkSignal()
    phase = "dominio"; save()
    const dataset = scaleDataset(scale)
    await seedScaleDomain(sql, store.accounts.escala.id, dataset, deps.loadCensus(root))
    checkSignal()
    phase = "completado"; save()
    return { schemaVersion: 1, target: "local", profile, fingerprint: resolved.fingerprint, datasetId: DATASET_ID, datasetHash: datasetHash(dataset), email: SCALE_EMAIL, accountId: store.accounts.escala.id, ...summarize(dataset) }
  } catch (error) {
    if (error instanceof BiblibError) throw error
    fail(EXIT.SEED_FAILED, phase, `Falló el seed de escala en ${phase}; repite el comando, es idempotente.`)
  } finally {
    if (locked) await (deps.releaseMigrationLock ?? releaseMigrationLock)(sql)
    await closeConnection(sql)
    release()
  }
}

/** Retira la cuenta de escala y su biblioteca (solo ese propietario) y borra su registro privado. */
export async function removeScaleAccount({ profile, root = REPO_ROOT, lockHeld = false }, deps) {
  if (!SCALE_PROFILES.includes(profile)) fail(EXIT.IDENTITY_MISMATCH, "perfil", "La limpieza de escala solo admite los perfiles test y scratch.")
  const resolved = await deps.resolveSeedTarget(profile, { root })
  const release = lockHeld ? () => {} : acquireLock(resolved.stack)
  const own = scaleResolved(resolved)
  const sql = (deps.connect ?? connect)(resolved, { applicationName: "biblib-limpieza-escala" })
  try {
    const store = readFixtureStore(own, scaleCensus(deps.loadCensus(root)))
    const id = store?.accounts?.escala?.id
    if (!id) return { removed: false, reason: "sin registro de la cuenta de escala" }
    const values = resolved.target.env()
    const admin = (deps.createClient ?? createClient)(values.SUPABASE_URL, values.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    const { data } = await admin.auth.admin.getUserById(id)
    if (data?.user && (data.user.email !== SCALE_EMAIL || data.user.user_metadata?.biblib_scale !== DATASET_ID)) fail(EXIT.IDENTITY_MISMATCH, "auth", "El ID registrado no es la cuenta de escala; no se elimina nada.")
    // Primero las fichas y después las estanterías (la FK compuesta es RESTRICT); la cuenta cae al final.
    await sql.begin(async (tx) => {
      await tx`delete from biblib.books where user_id = ${id}`
      await tx`delete from biblib.shelves where user_id = ${id}`
    })
    if (data?.user) {
      const { error } = await admin.auth.admin.deleteUser(id)
      if (error) fail(EXIT.SEED_FAILED, "auth", "GoTrue no eliminó la cuenta de escala; repite la limpieza.")
    }
    rmSync(fixtureFile(own), { force: true })
    return { removed: true }
  } finally {
    await closeConnection(sql)
    release()
  }
}

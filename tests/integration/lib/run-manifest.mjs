import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { BiblibError, EXIT } from "../../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../../scripts/lib/profiles.mjs"
import { BUCKET, RUN_MARKER } from "./context.mjs"

// Manifiesto privado (.biblib/, ignorado por Git) de lo que crea cada ejecución: solo IDs, rutas y
// claves de metadatos, nunca sesiones. La limpieza borra exclusivamente esas entradas y, si falla,
// el archivo se conserva como evidencia mínima para el siguiente intento.

const BASE_KINDS = ["books", "shelves", "objects", "metadata"]
// U-DAT-01: vistas previas y operaciones de importación. Opcionales para leer manifiestos anteriores.
const KINDS = [...BASE_KINDS, "previews", "operations"]

export function manifestFile(profile, root = REPO_ROOT) {
  const dir = path.join(root, ".biblib", "integration")
  for (const entry of [path.join(root, ".biblib"), dir]) {
    if (existsSync(entry) && lstatSync(entry).isSymbolicLink()) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "manifiesto", "El manifiesto de la suite no puede atravesar enlaces.")
  }
  return path.join(dir, `${profile}-run.json`)
}

export function readManifest(file) {
  if (!existsSync(file)) return null
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    if (manifest.schemaVersion !== 1 || !/^[0-9a-f]{12}$/.test(manifest.runId) || BASE_KINDS.some((kind) => !Array.isArray(manifest.created?.[kind]))) throw new Error()
    if (KINDS.some((kind) => manifest.created[kind] !== undefined && !Array.isArray(manifest.created[kind]))) throw new Error()
    return manifest
  } catch { throw new BiblibError(EXIT.IDENTITY_MISMATCH, "manifiesto", "Manifiesto de ejecución dañado; revísalo antes de borrar nada a mano.") }
}

export function writeManifest(file, manifest) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
}

export function startManifest(file, { runId, fingerprint }) {
  writeManifest(file, { schemaVersion: 1, runId, fingerprint, startedAt: new Date().toISOString(), created: Object.fromEntries(KINDS.map((kind) => [kind, []])) })
}

function update(file, change) {
  const manifest = readManifest(file)
  if (!manifest) throw new BiblibError(EXIT.VERIFICATION_FAILED, "manifiesto", "Falta el manifiesto de la ejecución en curso.")
  change(manifest)
  writeManifest(file, manifest)
}

const same = (a, b) => Object.keys(a).every((key) => a[key] === b[key])

/** Se registra antes o justo después de crear, para que un fallo intermedio no deje restos sin rastro. */
export function recordCreated(file, kind, entry) {
  update(file, (manifest) => {
    manifest.created[kind] ??= []
    if (!manifest.created[kind].some((item) => same(item, entry))) manifest.created[kind].push(entry)
  })
}

export function forgetCreated(file, kind, entry) {
  update(file, (manifest) => { manifest.created[kind] = (manifest.created[kind] ?? []).filter((item) => !same(item, entry)) })
}

export function isEmpty(manifest) {
  return KINDS.every((kind) => (manifest.created[kind] ?? []).length === 0)
}

/**
 * Borra lo registrado y nada más: libros/estanterías por ID + propietario + marca del run,
 * objetos bajo el prefijo del run y claves de metadatos añadidas por la suite.
 * Devuelve las entradas que no se pudieron limpiar.
 */
export async function cleanupManifest({ sql, admin, manifest }) {
  const marker = `[${RUN_MARKER} ${manifest.runId}]%`
  const pending = { books: [], shelves: [], objects: [], metadata: [] }
  // Operaciones primero (claves marcadas con el run) y después sus vistas previas, siempre por ID + propietario.
  if (manifest.created.operations) {
    pending.operations = []
    for (const operation of manifest.created.operations) {
      try { await sql`delete from biblib.library_operations where id = ${operation.id} and user_id = ${operation.userId} and idempotency_key like ${`qa01-${manifest.runId}-%`}` } catch { pending.operations.push(operation) }
    }
  }
  if (manifest.created.previews) {
    pending.previews = []
    for (const preview of manifest.created.previews) {
      try { await sql`delete from biblib.import_previews where id = ${preview.id} and user_id = ${preview.userId}` } catch { pending.previews.push(preview) }
    }
  }
  for (const book of manifest.created.books) {
    try { await sql`delete from biblib.books where id = ${book.id} and user_id = ${book.userId} and title like ${marker}` } catch { pending.books.push(book) }
  }
  for (const shelf of manifest.created.shelves) {
    try {
      const [{ books }] = await sql`select count(*)::int as books from biblib.books where shelf_id = ${shelf.id} and user_id = ${shelf.userId}`
      if (books) { pending.shelves.push(shelf); continue } // Nunca se arrastran libros ajenos al run.
      await sql`delete from biblib.shelves where id = ${shelf.id} and user_id = ${shelf.userId} and is_default = false and title like ${marker}`
    } catch { pending.shelves.push(shelf) }
  }
  const prefix = `qa-01/${manifest.runId}/`
  for (const object of manifest.created.objects) {
    if (object.bucket !== BUCKET || !object.path.startsWith(prefix)) { pending.objects.push(object); continue }
    const { error } = await admin.storage.from(BUCKET).remove([object.path])
    if (error) pending.objects.push(object)
  }
  for (const item of manifest.created.metadata) {
    if (!/^qa01_[a-z_]+$/.test(item.key)) { pending.metadata.push(item); continue }
    const { error } = await admin.auth.admin.updateUserById(item.userId, { user_metadata: { [item.key]: null } })
    const [row] = error ? [] : await sql`select coalesce(raw_user_meta_data ? ${item.key}, false) as present from auth.users where id = ${item.userId}`
    if (error || row?.present) pending.metadata.push(item)
  }
  return pending
}

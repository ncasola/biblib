import { canonical } from "../db/plan.mjs"
import { inspectObjects } from "../db/objects-manifest.mjs"
import { BiblibError, EXIT } from "./exit-codes.mjs"
import { AUTH_TABLES, sha256 } from "./backup-files.mjs"

// Consultas del respaldo administrativo. Solo devuelven cantidades, hashes, IDs y metadatos;
// las filas completas viajan únicamente dentro de los volcados.

// Columnas que cambian sin cambiar el estado respaldado (accesos, inicios de sesión).
const MARK_EXCLUDED = Object.freeze({ "auth.users": ["last_sign_in_at", "updated_at"], "storage.objects": ["last_accessed_at"] })
// Tokens que restore rota deliberadamente: se excluyen al comparar contenido. Rotar books.version
// dispara el trigger de 0003, que también renueva rotated_xact y updated_at de library_state.
// Desde 0011 (U-DAT-06) los tokens viven en obras, ediciones y ejemplares; books_legacy está congelada y no se rota.
export const ROTATING_COLUMNS = Object.freeze({ "biblib.books": ["version"], "biblib.works": ["version"], "biblib.editions": ["version"], "biblib.copies": ["version"], "biblib.library_state": ["revision", "rotated_xact", "updated_at"] })
// Clave natural de cada tabla para comparar presencia cuando el contenido cambia legítimamente.
export const TABLE_KEYS = Object.freeze({ "storage.objects": ["bucket_id", "name"], "drizzle.__drizzle_migrations": ["hash", "created_at"], "biblib.library_state": ["user_id"] })
// Auth y Storage se comparan por cantidad y claves: restore reasigna credenciales de fixtures
// y Storage recrea sus filas al subir los bytes por API.
export const CONTENT_SCHEMAS = Object.freeze(["biblib", "drizzle"])

const key = (t) => `${t.schema}.${t.table}`

/** Tablas incluidas en el alcance: dominio, ledger, identidades Auth y Storage. */
export async function scopeTables(tx) {
  const rows = await tx`select schemaname as schema, tablename as table from pg_tables
    where schemaname in ('biblib', 'drizzle') or (schemaname = 'auth' and tablename = any(${AUTH_TABLES}::text[]))
      or (schemaname = 'storage' and tablename in ('buckets', 'objects'))
    order by schemaname, tablename`
  const auth = await tx`select tablename as table from pg_tables where schemaname = 'auth' order by tablename`
  return { tables: rows.map((r) => ({ schema: r.schema, table: r.table })), authTables: auth.map((r) => r.table) }
}

/** Cantidad, hash de claves y hash de contenido (sin las columnas excluidas) de cada tabla. */
export async function tableDigests(tx, tables, { exclude = {} } = {}) {
  const result = []
  for (const t of tables) {
    const columns = (await tx`select column_name from information_schema.columns where table_schema = ${t.schema} and table_name = ${t.table}`).map((c) => c.column_name)
    const keys = TABLE_KEYS[key(t)] ?? (columns.includes("id") ? ["id"] : columns.sort())
    const [row] = await tx`select count(*)::integer as count,
        md5(coalesce(string_agg(k, '' order by k), '')) as keys,
        md5(coalesce(string_agg(c, '' order by c), '')) as content
      from (select md5((select jsonb_agg(to_jsonb(t) -> name order by ord) from unnest(${keys}::text[]) with ordinality u(name, ord))::text) as k,
          md5((to_jsonb(t) - ${exclude[key(t)] ?? []}::text[])::text) as c
        from ${tx(t.schema)}.${tx(t.table)} t) s`
    result.push({ schema: t.schema, table: t.table, count: row.count, keys: row.keys, content: row.content })
  }
  return result
}

/** Marca del estado respaldado: se compara antes y después de los volcados y la copia Storage. */
export async function stateMark(tx, tables) {
  const digests = await tableDigests(tx, tables, { exclude: MARK_EXCLUDED })
  return sha256(canonical(digests))
}

export async function contentDigests(tx, tables) {
  return tableDigests(tx, tables, { exclude: ROTATING_COLUMNS })
}

/** Hechos de esquema ordenados (tablas, RLS, políticas, grants, FK, índices, función y trigger). */
export async function objectFacts(tx) {
  const facts = await inspectObjects(tx)
  // PostgreSQL aplana este AND al restaurarlo desde pg_dump. Solo se normaliza
  // la agrupación redundante observada de este check, sin omitir hechos ni
  // aceptar otras definiciones. Evidencia: O11/exp-03/informe.md.
  const normalize = (name, value) => {
    if (typeof value !== "object" || value === null) return value
    const copy = { ...value }
    if (name === "constraints" && copy.table === "saved_book_views" && copy.name === "saved_book_views_name_check"
      && copy.definition === "CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 80) AND (name = btrim(name))))") {
      copy.definition = "CHECK ((((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 80)) AND (name = btrim(name))))"
    }
    return copy
  }
  const sorted = Object.fromEntries(Object.entries(facts).map(([name, value]) => [name, Array.isArray(value) ? [...value].map((v) => normalize(name, v)).sort((a, b) => canonical(a).localeCompare(canonical(b))) : value]))
  return { hash: sha256(canonical(sorted)), facts: sorted }
}

/** Huellas sha256(id:token) de los tokens de concurrencia; nunca los tokens. */
export async function tokenHashes(tx) {
  const tokens = {}
  if (await relationExists(tx, "biblib", "books")) {
    tokens["biblib.books.version"] = (await tx`select encode(sha256(convert_to(id::text || ':' || version::text, 'UTF8')), 'hex') as h from biblib.books order by 1`).map((r) => r.h)
  }
  if (await columnExists(tx, "biblib", "library_state", "revision")) {
    tokens["biblib.library_state.revision"] = (await tx`select encode(sha256(convert_to(user_id::text || ':' || revision::text, 'UTF8')), 'hex') as h from biblib.library_state order by 1`).map((r) => r.h)
  }
  return tokens
}

/** Muestra estable de fichas: ID y hash de contenido sin el token rotado. */
export async function bookSample(tx, limit = 5) {
  if (!(await relationExists(tx, "biblib", "books"))) return []
  // La vista plana (0011) expone también los tokens de ejemplar y edición: se excluyen igual que el plano.
  return (await tx`select id::text as id, md5((to_jsonb(b) - array['version', 'copy_version', 'edition_version'])::text) as digest from biblib.books b order by id limit ${limit}`).map((r) => ({ id: r.id, digest: r.digest }))
}

export async function fixtureAccounts(tx, census) {
  const accounts = {}
  for (const account of census.accounts) {
    const [user] = await tx`select id::text as id from auth.users where email = ${account.email} and raw_user_meta_data->>'biblib_fixture' = ${census.censusId}`
    if (!user) continue
    const [books] = await tx`select count(*)::integer as n from biblib.books where user_id = ${user.id}`
    const [shelves] = await tx`select count(*)::integer as n from biblib.shelves where user_id = ${user.id}`
    accounts[account.key] = { id: user.id, books: books.n, shelves: shelves.n }
  }
  return accounts
}

export async function storageInventory(tx) {
  const buckets = await tx`select id, name, public, file_size_limit, allowed_mime_types from storage.buckets order by id`
  const objects = await tx`select bucket_id, name, (metadata->>'size')::bigint as size, metadata->>'mimetype' as mimetype from storage.objects order by bucket_id, name`
  return {
    buckets: buckets.map((b) => ({ id: b.id, name: b.name, public: b.public, fileSizeLimit: b.file_size_limit === null ? null : Number(b.file_size_limit), allowedMimeTypes: b.allowed_mime_types ?? null })),
    objects: objects.map((o) => ({ bucket: o.bucket_id, name: o.name, size: o.size === null ? null : Number(o.size), contentType: o.mimetype ?? "application/octet-stream" })),
  }
}

async function relationExists(tx, schema, table) {
  const [row] = await tx`select to_regclass(${`${schema}.${table}`}) is not null as found`
  return row.found
}

async function columnExists(tx, schema, table, column) {
  const [row] = await tx`select exists(select 1 from information_schema.columns where table_schema = ${schema} and table_name = ${table} and column_name = ${column}) as found`
  return row.found
}

/**
 * Rotación posterior al restore, dentro de la transacción del llamador. Un dump puede
 * conservar tokens antiguos y no se supone que haya ejecutado triggers: se rota explícitamente.
 * Las tablas futuras de previews, leases o idempotencia se detectan por nombre/columnas.
 */
export async function rotateRestoredTokens(tx) {
  const result = { rotated: [], invalidated: [], review: [], staleWriteRejected: null }
  const columns = await tx`select table_name as table, column_name as column, data_type as type, is_nullable = 'YES' as nullable from information_schema.columns where table_schema = 'biblib'`
  const find = (table, column) => columns.find((c) => c.table === table && c.column === column)
  const tables = [...new Set(columns.map((c) => c.table))].sort()

  if (tables.includes("books")) {
    const [stale] = await tx`select id, version from biblib.books order by id limit 1`
    // Desde 0011 books es la vista plana: su token sale de los de ejemplar y edición, que son los que se rotan.
    const model = tables.includes("copies")
    const rows = model ? (await tx`update biblib.copies set version = gen_random_uuid()`).count : (await tx`update biblib.books set version = gen_random_uuid()`).count
    if (model) {
      result.rotated.push({ token: "biblib.copies.version", rows })
      result.rotated.push({ token: "biblib.editions.version", rows: (await tx`update biblib.editions set version = gen_random_uuid()`).count })
      result.rotated.push({ token: "biblib.works.version", rows: (await tx`update biblib.works set version = gen_random_uuid()`).count })
    } else result.rotated.push({ token: "biblib.books.version", rows })
    // Una pestaña anterior al respaldo conserva la versión restaurada: su escritura condicional no debe aplicar.
    if (stale) result.staleWriteRejected = (await tx`update biblib.books set status = status where id = ${stale.id} and version = ${stale.version}`).count === 0
  }
  const revision = find("library_state", "revision")
  if (revision) {
    if (!["uuid", "text", "character varying"].includes(revision.type)) throw new BiblibError(EXIT.VERIFICATION_FAILED, "rotación", "library_state.revision tiene un tipo sin rotación definida; amplía rotateRestoredTokens antes de restaurar.")
    const rows = revision.type === "uuid" ? (await tx`update biblib.library_state set revision = gen_random_uuid()`).count : (await tx`update biblib.library_state set revision = gen_random_uuid()::text`).count
    result.rotated.push({ token: "biblib.library_state.revision", rows })
  }
  // Trabajos (U-DAT-03) y eliminaciones de cuenta (U-OPS-03) en ejecución en el respaldo: se reanudan como reintento,
  // sin lease, para que un trabajador los reclame de nuevo con fencing nuevo (sus CHECK exigen lease mientras corren).
  const RESUMABLE = ["library_jobs", "account_deletions"]
  for (const table of tables) {
    if (RESUMABLE.includes(table) && find(table, "state") && find(table, "lease_token") && find(table, "next_attempt_at")) {
      const rows = (await tx`update ${tx("biblib")}.${tx(table)} set state = 'waiting_retry', lease_token = null, lease_until = null, next_attempt_at = now() where state = 'running'`).count
      if (rows) result.invalidated.push({ table: `biblib.${table}`, action: "resume-as-retry", rows })
    }
    if (/previews?$/.test(table)) {
      result.invalidated.push({ table: `biblib.${table}`, action: "delete", rows: (await tx`delete from ${tx("biblib")}.${tx(table)}`).count })
      continue
    }
    const lease = find(table, "lease_until")
    if (lease) {
      const rows = lease.nullable
        ? (await tx`update ${tx("biblib")}.${tx(table)} set lease_until = null where lease_until is not null`).count
        : (await tx`update ${tx("biblib")}.${tx(table)} set lease_until = least(lease_until, now())`).count
      if (find(table, "lease_token")?.type === "uuid") await tx`update ${tx("biblib")}.${tx(table)} set lease_token = gen_random_uuid() where lease_token is not null`
      if (find(table, "fencing_number")) await tx`update ${tx("biblib")}.${tx(table)} set fencing_number = fencing_number + 1`
      result.invalidated.push({ table: `biblib.${table}`, action: "lease-expired", rows })
    }
    if (/idempot/.test(table)) result.review.push({ table: `biblib.${table}`, message: "Tabla de idempotencia sin contrato de invalidación: decide qué operaciones no publicadas se descartan antes de abrir tráfico." })
  }
  return result
}

// Portadas privadas (U-DAT-10). El bucket `biblib-covers` se copia objeto a objeto como el resto de
// Storage, pero con su propio manifiesto: cada asset con su clave, sha256 y tamaño, comprobados contra
// los bytes copiados. Nunca se guarda una URL firmada. Solo entran las subidas propias y las copias de
// proveedores cuya política publicada permite rehostCover y backupAsset: hoy ninguna (rights.ts de
// U-BIB-04; Google ni siquiera puede guardarse, lo impide un CHECK de 0009). Mantener esta lista
// alineada con rights.ts (la prueba unitaria tests/cover-assets.test.ts lo comprueba).
export const COVERS_BUCKET = "biblib-covers"
export const BACKUP_ASSET_PROVIDERS = Object.freeze([])
// Restore deja los assets en revisión (`state`, `updated_at`) y caduca las subidas a medias: la tabla
// se compara por claves y el contenido por el manifiesto de assets.
export const KEY_ONLY_TABLES = Object.freeze(["biblib.cover_assets"])

/** Assets con objeto registrado (o en cuarentena con intento), sin títulos ni datos de la ficha. */
export async function coverAssetInventory(tx) {
  if (!(await relationExists(tx, "biblib", "cover_assets"))) return null
  const rows = await tx`select id::text as id, user_id::text as owner, storage_key as key, sha256, bytes, state, source_kind as "sourceKind", split_part(source_ref, ':', 1) as provider
    from biblib.cover_assets order by id`
  return rows.map((row) => ({ ...row }))
}

/**
 * Decide qué assets entran en el respaldo. Un asset de proveedor sin `backupAsset` en su política no
 * entra (ni su objeto ni su fila restaurada); la ficha volverá a su URL original al restaurar.
 */
export function classifyCoverAssets(rows, { providers = BACKUP_ASSET_PROVIDERS } = {}) {
  if (!rows) return null
  const items = rows.map((row) => {
    const included = row.sourceKind === "upload" || (row.provider !== "google-books" && providers.includes(row.provider))
    return { ...row, included, ...(included ? {} : { reason: row.provider === "google-books" ? "google" : "policy" }) }
  })
  return { bucket: COVERS_BUCKET, providers: [...providers], items, excluded: items.filter((item) => !item.included).map((item) => item.id) }
}

/** Claves de objeto de los assets excluidos: no se descargan ni se restauran. */
export function excludedCoverKeys(assets) {
  return new Set((assets?.items ?? []).filter((item) => !item.included && item.key).map((item) => item.key))
}

/** Cada objeto registrado copiado debe coincidir en bytes y hash con su asset; si no, el respaldo no vale. */
export function verifyCoverObjects(assets, objects) {
  const byKey = new Map(objects.filter((object) => object.bucket === COVERS_BUCKET).map((object) => [object.name, object]))
  const problems = []
  for (const item of assets?.items ?? []) {
    if (!item.included || item.state === "quarantine" || !item.key) continue
    const object = byKey.get(item.key)
    if (!object) problems.push(`falta el objeto del asset ${item.id}`)
    else if (object.sha256 !== item.sha256 || object.size !== item.bytes) problems.push(`el objeto del asset ${item.id} no coincide con su sha256 o tamaño`)
  }
  return problems
}

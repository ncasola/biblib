import { readFileSync } from "node:fs"
import { EXIT } from "../lib/exit-codes.mjs"

// Manifest de objetos deliberados de BibLib. Se comprueba con metadatos de pg_catalog e
// information_schema y con expresiones normalizadas, nunca comparando el pretty-print.
// `since`/`until` indican la migración que introduce o retira cada objeto.
const M0 = "0000_biblib_init", M1 = "0001_library_integrity", M2 = "0002_book_versions", M3 = "0003_library_revision", M4 = "0004_catalogue_coordination", M5 = "0005_library_jobs", M6 = "0006_library_snapshots", M7 = "0007_saved_views", M8 = "0008_restore_sessions", M9 = "0009_cover_assets", M10 = "0010_works_editions_copies"
export const MANIFEST_MIGRATIONS = [M0, M1, M2, M3, M4, M5, M6, M7, M8, M9, M10]

const own = "user_id=auth.uid"
const ownNotDefault = "user_id=auth.uidandnotis_default"
// Políticas generadas por Drizzle (0003): `(select auth.uid() = tabla.user_id)` normalizado.
const ownSelect = (table) => `selectauth.uid=${table}.user_id`
const policy = (table, name, cmd, using, check, since = M0) => ({ table, name, cmd, roles: ["authenticated"], using, check, since })

// Cuerpos de 0003 tal como se declaran en la migración; se comparan normalizados.
const ROTATE_LIBRARY_REVISION = `
DECLARE
  owners uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    owners := ARRAY[NEW.user_id];
  ELSIF TG_OP = 'DELETE' THEN
    owners := ARRAY[OLD.user_id];
  ELSE
    owners := ARRAY[NEW.user_id, OLD.user_id];
  END IF;
  INSERT INTO biblib.library_state AS state (user_id, rotated_xact)
  SELECT DISTINCT owner_id, pg_current_xact_id() FROM unnest(owners) AS owner_id
  WHERE EXISTS (SELECT 1 FROM auth.users AS account WHERE account.id = owner_id)
  ON CONFLICT (user_id) DO UPDATE
    SET revision = gen_random_uuid(), rotated_xact = excluded.rotated_xact, updated_at = now()
    WHERE state.rotated_xact IS DISTINCT FROM excluded.rotated_xact;
  RETURN NULL;
END;
`
const LOCK_LIBRARY = `
DECLARE
  owner_id uuid := auth.uid();
  current_revision uuid;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'lock_library requiere una sesión' USING ERRCODE = '42501';
  END IF;
  INSERT INTO biblib.library_state (user_id) VALUES (owner_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT state.revision INTO current_revision FROM biblib.library_state AS state WHERE state.user_id = owner_id FOR UPDATE;
  RETURN current_revision;
END;
`

// Cuerpos de 0004 leídos de la propia migración versionada (su hash lo protege el journal), para no
// duplicar ~150 líneas de plpgsql; se comparan normalizados igual que los de 0003.
function migrationBodies(tag) {
  const source = readFileSync(new URL(`../../drizzle/${tag}.sql`, import.meta.url), "utf8")
  return Object.fromEntries([...source.matchAll(/CREATE (?:OR REPLACE )?FUNCTION "biblib"\."(\w+)"\([^)]*\) RETURNS [\s\S]*?AS \$\$([\s\S]*?)\$\$;/g)].map(([, name, body]) => [name, normalizeBody(body)]))
}
const CATALOGUE = migrationBodies(M4)
const JOBS = migrationBodies(M5)
const catalogueKey = ["provider", "policy_version", "credential_scope", "schema_version", "operation", "canonical_key"]
const providerTokens = ["'open-library'", "'bne'", "'google-books'"]
const catalogueTables = ["catalogue_cache", "catalogue_inflight", "catalogue_quota_buckets", "catalogue_quota_reservations", "catalogue_private_cache"]
// Coordinación del catálogo: sin EXECUTE para anon/authenticated; solo la conexión del servidor.
const catalogueFunction = (name, returns, args) => ({ name, language: "plpgsql", returns, args, searchPath: "search_path=pg_catalog", securityDefiner: true, body: CATALOGUE[name], execute: { authenticated: false, anon: false }, since: M4 })
// Trabajos (0005): crear y controlar con auth.uid(); reclamar, renovar, cercar y el ciclo de vida solo desde el servidor.
const jobTables = ["library_jobs", "library_job_items", "account_lifecycle"]
const jobFunction = (name, returns, args, authenticated = false) => ({ name, language: "plpgsql", returns, args, searchPath: "search_path=pg_catalog", securityDefiner: true, body: JOBS[name], execute: { authenticated, anon: false }, since: M5 })
// Versiones anteriores (0006): authenticated captura, consulta IDs ocupados y borra con auth.uid(); la purga solo desde el servidor.
const SNAPSHOTS = migrationBodies(M6)
const VIEWS = migrationBodies(M7)
const snapshotTables = ["library_snapshots", "library_snapshot_chunks"]
const snapshotFunction = (name, returns, args, authenticated = true) => ({ name, language: "plpgsql", returns, args, searchPath: "search_path=pg_catalog", securityDefiner: true, body: SNAPSHOTS[name], execute: { authenticated, anon: false }, since: M6 })
// Sesiones de restauración (0008): el dueño escribe con RLS; la guarda ata trozos y filas a una sesión que recibe.
const RESTORE = migrationBodies(M8)
const restoreTables = ["import_sessions", "import_session_parts", "import_session_chunks", "import_session_rows"]
const restoreFullTables = ["import_sessions", "import_session_parts"]
const restoreImmutableTables = ["import_session_chunks", "import_session_rows"]
// Portadas privadas (0009): el dueño solo lee sus assets; toda transición pasa por funciones definer.
// 0009 sustituye library_job_claim (sin adquisiciones para el ejecutor sin sesión) y library_snapshot_capture (retiene cover_asset_id).
const ASSETS = migrationBodies(M9)
const assetFunction = (name, returns, args, authenticated = true, securityDefiner = true) => ({ name, language: "plpgsql", returns, args, searchPath: "search_path=pg_catalog", securityDefiner, body: ASSETS[name], execute: { authenticated, anon: false }, since: M9 })
const COVERS_BUCKET = "biblib-covers"
const coversCondition = (action) => normalizeExpression(`bucket_id = '${COVERS_BUCKET}' and biblib.cover_object_access(name, '${action}')`)
const storagePolicy = (name, cmd, action) => ({ name, cmd, roles: ["authenticated"], using: cmd === "INSERT" ? null : coversCondition(action), check: cmd === "INSERT" ? coversCondition(action) : null, since: M9 })
// Obra, edición y ejemplar (0010, U-DAT-06): el dueño escribe con RLS; el informe del backfill solo se lee.
// La sincronización desde books y la comparación solo las ejecuta la migración o el servidor.
const MODEL = migrationBodies(M10)
const modelTables = ["works", "editions", "copies"]
const modelFunction = (name, returns, args, { authenticated = false, securityDefiner = false, since = M10 } = {}) => ({ name, language: "plpgsql", returns, args, searchPath: "search_path=pg_catalog", securityDefiner, body: MODEL[name], execute: { authenticated, anon: false }, since })
const modelTrigger = (table, name, fn, timing, events, level, tgtype) => ({ table, name, function: `biblib.${fn}`, timing, events, level, tgtype, since: M10 })
const jobStateTokens = ["'queued'", "'running'", "'waiting_retry'", "'needs_review'", "'paused'", "'succeeded'", "'partially_succeeded'", "'failed'", "'cancelled'", "'expired'"]

export const MANIFEST = Object.freeze({
  tables: [{ name: "shelves", since: M0 }, { name: "books", since: M0 }, { name: "library_state", since: M3 }, { name: "import_previews", since: M3 }, { name: "library_operations", since: M3 }, ...catalogueTables.map((name) => ({ name, since: M4 })), ...jobTables.map((name) => ({ name, since: M5 })), ...snapshotTables.map((name) => ({ name, since: M6 })), { name: "saved_book_views", since: M7 }, ...restoreTables.map((name) => ({ name, since: M8 })), { name: "cover_assets", since: M9 }, ...[...modelTables, "model_migration_report"].map((name) => ({ name, since: M10 }))],
  policies: [
    policy("shelves", "shelves_select_own", "SELECT", own, null),
    policy("shelves", "shelves_insert_own", "INSERT", null, own),
    { ...policy("shelves", "shelves_update_own", "UPDATE", own, own), variants: [{ since: M1, using: ownNotDefault, check: ownNotDefault }] },
    { ...policy("shelves", "shelves_delete_own", "DELETE", own, null), variants: [{ since: M1, using: ownNotDefault, check: null }] },
    policy("books", "books_select_own", "SELECT", own, null),
    policy("books", "books_insert_own", "INSERT", null, own),
    policy("books", "books_update_own", "UPDATE", own, own),
    policy("books", "books_delete_own", "DELETE", own, null),
    policy("library_state", "library_state_select_own", "SELECT", ownSelect("library_state"), null, M3),
    policy("import_previews", "import_previews_select_own", "SELECT", ownSelect("import_previews"), null, M3),
    policy("import_previews", "import_previews_insert_own", "INSERT", null, ownSelect("import_previews"), M3),
    policy("import_previews", "import_previews_delete_own", "DELETE", ownSelect("import_previews"), null, M3),
    policy("library_operations", "library_operations_select_own", "SELECT", ownSelect("library_operations"), null, M3),
    policy("library_operations", "library_operations_insert_own", "INSERT", null, ownSelect("library_operations"), M3),
    policy("catalogue_private_cache", "catalogue_private_cache_select_own", "SELECT", "selectauth.uid=catalogue_private_cache.owner_id", null, M4),
    policy("catalogue_private_cache", "catalogue_private_cache_delete_own", "DELETE", "selectauth.uid=catalogue_private_cache.owner_id", null, M4),
    ...jobTables.map((table) => policy(table, `${table}_select_own`, "SELECT", ownSelect(table), null, M5)),
    ...snapshotTables.map((table) => policy(table, `${table}_select_own`, "SELECT", ownSelect(table), null, M6)),
    policy("saved_book_views", "saved_book_views_select_own", "SELECT", ownSelect("saved_book_views"), null, M7),
    policy("saved_book_views", "saved_book_views_insert_own", "INSERT", null, ownSelect("saved_book_views"), M7),
    policy("saved_book_views", "saved_book_views_update_own", "UPDATE", ownSelect("saved_book_views"), ownSelect("saved_book_views"), M7),
    policy("saved_book_views", "saved_book_views_delete_own", "DELETE", ownSelect("saved_book_views"), null, M7),
    ...restoreTables.flatMap((table) => [
      policy(table, `${table}_select_own`, "SELECT", ownSelect(table), null, M8),
      policy(table, `${table}_insert_own`, "INSERT", null, ownSelect(table), M8),
      ...(restoreFullTables.includes(table) ? [policy(table, `${table}_update_own`, "UPDATE", ownSelect(table), ownSelect(table), M8)] : []),
      policy(table, `${table}_delete_own`, "DELETE", ownSelect(table), null, M8),
    ]),
    policy("cover_assets", "cover_assets_select_own", "SELECT", ownSelect("cover_assets"), null, M9),
    ...modelTables.flatMap((table) => [
      policy(table, `${table}_select_own`, "SELECT", ownSelect(table), null, M10),
      policy(table, `${table}_insert_own`, "INSERT", null, ownSelect(table), M10),
      policy(table, `${table}_update_own`, "UPDATE", ownSelect(table), ownSelect(table), M10),
      policy(table, `${table}_delete_own`, "DELETE", ownSelect(table), null, M10),
    ]),
    policy("model_migration_report", "model_migration_report_select_own", "SELECT", ownSelect("model_migration_report"), null, M10),
  ],
  // library_state solo se lee: la revisión cambia por lock_library()/triggers, nunca por escritura directa.
  // La caché compartida, las consultas en vuelo y las cuotas no tienen ningún privilegio de cliente.
  grants: {
    authenticated: { shelves: ["DELETE", "INSERT", "SELECT", "UPDATE"], books: ["DELETE", "INSERT", "SELECT", "UPDATE"], library_state: ["SELECT"], import_previews: ["DELETE", "INSERT", "SELECT"], library_operations: ["INSERT", "SELECT"], catalogue_cache: [], catalogue_inflight: [], catalogue_quota_buckets: [], catalogue_quota_reservations: [], catalogue_private_cache: ["DELETE", "SELECT"], library_jobs: ["SELECT"], library_job_items: ["SELECT"], account_lifecycle: ["SELECT"], library_snapshots: ["SELECT"], library_snapshot_chunks: ["SELECT"], saved_book_views: ["DELETE", "INSERT", "SELECT", "UPDATE"],
      ...Object.fromEntries(restoreFullTables.map((name) => [name, ["DELETE", "INSERT", "SELECT", "UPDATE"]])), ...Object.fromEntries(restoreImmutableTables.map((name) => [name, ["DELETE", "INSERT", "SELECT"]])), cover_assets: ["SELECT"],
      ...Object.fromEntries(modelTables.map((name) => [name, ["DELETE", "INSERT", "SELECT", "UPDATE"]])), model_migration_report: ["SELECT"] },
    anon: { shelves: [], books: [], library_state: [], import_previews: [], library_operations: [], ...Object.fromEntries([...catalogueTables, ...jobTables, ...snapshotTables, "saved_book_views", ...restoreTables, "cover_assets", ...modelTables, "model_migration_report"].map((name) => [name, []])) },
  },
  constraints: [
    // Obra, edición y ejemplar (0010): FK con propietario, ISBN-13 canónico opcional y la comprobación física fuera de la edición.
    ...[...modelTables, "model_migration_report"].flatMap((table) => [
      { table, name: `${table}_pkey`, type: "p", columns: ["id"], since: M10 },
      { table, name: `${table}_user_id_users_id_fk`, type: "f", columns: ["user_id"], references: "auth.users", refColumns: ["id"], onDelete: "c", since: M10 },
    ]),
    // Borrar una obra deja sus ediciones sin obra (ON DELETE SET NULL ("work_id")): el dueño y la edición permanecen.
    { table: "editions", name: "editions_owner_work_fk", type: "f", columns: ["user_id", "work_id"], references: "biblib.works", refColumns: ["user_id", "id"], onDelete: "n", since: M10 },
    { table: "editions", name: "editions_owner_cover_asset_fk", type: "f", columns: ["user_id", "cover_asset_id"], references: "biblib.cover_assets", refColumns: ["user_id", "id"], onDelete: "a", since: M10 },
    { table: "copies", name: "copies_owner_edition_fk", type: "f", columns: ["user_id", "edition_id"], references: "biblib.editions", refColumns: ["user_id", "id"], onDelete: "r", since: M10 },
    { table: "copies", name: "copies_owner_shelf_fk", type: "f", columns: ["user_id", "shelf_id"], references: "biblib.shelves", refColumns: ["user_id", "id"], onDelete: "r", since: M10 },
    { table: "works", name: "works_title_check", type: "c", columns: ["title"], tokens: ["length(btrim(title))", ">=1", "<=500"], since: M10 },
    { table: "editions", name: "editions_isbn13_check", type: "c", columns: ["isbn13"], tokens: ["isbn13 is null", "biblib.isbn13_normalize(isbn13)isnotdistinctfromisbn13"], since: M10 },
    { table: "editions", name: "editions_title_check", type: "c", columns: ["title"], tokens: ["length(btrim(title))", ">=1", "<=500"], since: M10 },
    { table: "editions", name: "editions_pages_check", type: "c", columns: ["number_of_pages"], tokens: [">=0", "<=100000"], since: M10 },
    { table: "editions", name: "editions_language_check", type: "c", columns: ["language"], tokens: ["language is null"], since: M10 },
    { table: "editions", name: "editions_identifiers_check", type: "c", columns: ["identifiers"], tokens: ["jsonb_typeof(identifiers)='object'"], since: M10 },
    { table: "editions", name: "editions_catalogue_check", type: "c", columns: ["catalogue"], tokens: ["jsonb_typeof(catalogue)='object'", "catalogue?'isbnVerified'"], since: M10 },
    { table: "copies", name: "copies_status_check", type: "c", columns: ["status"], tokens: ["'read'", "'reading'", "'unread'", "'to-read'"], since: M10 },
    { table: "copies", name: "copies_verification_check", type: "c", columns: ["edition_verification"], tokens: ["'boolean'"], since: M10 },
    { table: "copies", name: "copies_legacy_identifier_check", type: "c", columns: ["legacy_identifier"], tokens: ["legacy_identifier is null", ">=1", "<=100"], since: M10 },
    { table: "model_migration_report", name: "model_migration_report_kind_check", type: "c", columns: ["kind"], tokens: ["'summary'", "'normalized'", "'invalid'", "'conflict'", "'grouped'"], since: M10 },
    { table: "model_migration_report", name: "model_migration_report_details_check", type: "c", columns: ["details"], tokens: ["jsonb_typeof(details)='object'"], since: M10 },
    // Portadas privadas (0009): FK con propietario, Google excluido por Postgres, asset utilizable completo.
    { table: "cover_assets", name: "cover_assets_pkey", type: "p", columns: ["id"], since: M9 },
    { table: "cover_assets", name: "cover_assets_user_id_users_id_fk", type: "f", columns: ["user_id"], references: "auth.users", refColumns: ["id"], onDelete: "c", since: M9 },
    // Al purgar el resumen del trabajo solo se anula job_id (ON DELETE SET NULL ("job_id")): el asset y su dueño permanecen.
    { table: "cover_assets", name: "cover_assets_owner_job_fk", type: "f", columns: ["user_id", "job_id"], references: "biblib.library_jobs", refColumns: ["user_id", "id"], onDelete: "n", since: M9 },
    { table: "cover_assets", name: "cover_assets_state_check", type: "c", columns: ["state"], tokens: ["'quarantine'", "'ready'", "'restored'"], since: M9 },
    { table: "cover_assets", name: "cover_assets_source_kind_check", type: "c", columns: ["source_kind"], tokens: ["'provider'", "'upload'"], since: M9 },
    { table: "cover_assets", name: "cover_assets_source_ref_check", type: "c", columns: ["source_kind", "source_ref"], tokens: ["source_ref='upload'", "'^(open-library|bne):[a-z]{2,8}:[A-Za-z0-9-]{1,40}$'"], since: M9 },
    { table: "cover_assets", name: "cover_assets_sha_check", type: "c", columns: ["sha256"], tokens: ["'^[0-9a-f]{64}$'"], since: M9 },
    { table: "cover_assets", name: "cover_assets_key_check", type: "c", columns: ["storage_key"], tokens: ["[.]webp$'"], since: M9 },
    { table: "cover_assets", name: "cover_assets_token_check", type: "c", columns: ["upload_token"], tokens: ["'^[A-Za-z0-9_-]{1,64}$'"], since: M9 },
    { table: "cover_assets", name: "cover_assets_size_check", type: "c", columns: ["bytes", "width", "height"], tokens: ["bytes<=5242880", "width<=10000", "height<=10000"], since: M9 },
    { table: "cover_assets", name: "cover_assets_ready_check", type: "c", columns: ["state", "storage_key", "sha256", "mime", "width", "height", "bytes"], tokens: ["state='quarantine'", "storage_key is not null", "sha256 is not null", "mime='image/webp'"], since: M9 },
    { table: "cover_assets", name: "cover_assets_quarantine_check", type: "c", columns: ["state", "expires_at"], tokens: ["state<>'quarantine'", "expires_at is not null"], since: M9 },
    { table: "cover_assets", name: "cover_assets_attach_check", type: "c", columns: ["attach_book_id", "attach_book_version"], tokens: ["attach_book_id is null", "attach_book_version is null"], since: M9 },
    { table: "books", name: "books_owner_cover_asset_fk", type: "f", columns: ["user_id", "cover_asset_id"], references: "biblib.cover_assets", refColumns: ["user_id", "id"], onDelete: "a", since: M9 },
    // Sesiones de restauración (0008): FK con propietario, hashes y tamaños exactos y estados coherentes.
    { table: "import_sessions", name: "import_sessions_pkey", type: "p", columns: ["id"], since: M8 },
    { table: "import_sessions", name: "import_sessions_user_id_users_id_fk", type: "f", columns: ["user_id"], references: "auth.users", refColumns: ["id"], onDelete: "c", since: M8 },
    { table: "import_sessions", name: "import_sessions_state_check", type: "c", columns: ["state"], tokens: ["'receiving'", "'validated'", "'prepared'", "'committed'", "'rejected'"], since: M8 },
    { table: "import_sessions", name: "import_sessions_source_check", type: "c", columns: ["source"], tokens: ["'manifest'", "'loose'"], since: M8 },
    { table: "import_sessions", name: "import_sessions_digest_check", type: "c", columns: ["manifest_digest"], tokens: ["'^[0-9a-f]{64}$'"], since: M8 },
    { table: "import_sessions", name: "import_sessions_parts_check", type: "c", columns: ["part_count", "validated_parts"], tokens: ["part_count>=1", "part_count<=50", "validated_parts<=part_count"], since: M8 },
    { table: "import_sessions", name: "import_sessions_bytes_check", type: "c", columns: ["total_bytes", "received_bytes"], tokens: ["total_bytes<=83886080", "received_bytes<=total_bytes"], since: M8 },
    { table: "import_sessions", name: "import_sessions_committed_check", type: "c", columns: ["state", "operation_id"], tokens: ["state='committed'", "operation_id is not null"], since: M8 },
    { table: "import_session_parts", name: "import_session_parts_pkey", type: "p", columns: ["session_id", "part_id"], since: M8 },
    { table: "import_session_parts", name: "import_session_parts_owner_session_fk", type: "f", columns: ["user_id", "session_id"], references: "biblib.import_sessions", refColumns: ["user_id", "id"], onDelete: "c", since: M8 },
    { table: "import_session_parts", name: "import_session_parts_size_check", type: "c", columns: ["byte_length", "total_chunks"], tokens: ["byte_length<=8388608", "total_chunks=byte_length+262143/262144"], since: M8 },
    { table: "import_session_parts", name: "import_session_parts_sha_check", type: "c", columns: ["sha256"], tokens: ["'^[0-9a-f]{64}$'"], since: M8 },
    { table: "import_session_chunks", name: "import_session_chunks_pkey", type: "p", columns: ["session_id", "part_id", "ordinal"], since: M8 },
    { table: "import_session_chunks", name: "import_session_chunks_owner_part_fk", type: "f", columns: ["user_id", "session_id", "part_id"], references: "biblib.import_session_parts", refColumns: ["user_id", "session_id", "part_id"], onDelete: "c", since: M8 },
    { table: "import_session_chunks", name: "import_session_chunks_size_check", type: "c", columns: ["byte_length", "bytes"], tokens: ["byte_length<=262144", "octet_length(bytes)=byte_length"], since: M8 },
    // El hash de cada trozo lo comprueba Postgres sobre los bytes guardados.
    { table: "import_session_chunks", name: "import_session_chunks_sha_check", type: "c", columns: ["sha256", "bytes"], tokens: ["sha256=encode(sha256(bytes),'hex')"], since: M8 },
    { table: "import_session_rows", name: "import_session_rows_pkey", type: "p", columns: ["session_id", "kind", "row_key"], since: M8 },
    { table: "import_session_rows", name: "import_session_rows_owner_session_fk", type: "f", columns: ["user_id", "session_id"], references: "biblib.import_sessions", refColumns: ["user_id", "id"], onDelete: "c", since: M8 },
    { table: "import_session_rows", name: "import_session_rows_kind_check", type: "c", columns: ["kind"], tokens: ["'book'", "'shelf'"], since: M8 },
    { table: "saved_book_views", name: "saved_book_views_pkey", type: "p", columns: ["id"], since: M7 },
    { table: "saved_book_views", name: "saved_book_views_user_id_users_id_fk", type: "f", columns: ["user_id"], references: "auth.users", refColumns: ["id"], onDelete: "c", since: M7 },
    { table: "saved_book_views", name: "saved_book_views_name_check", type: "c", columns: ["name"], tokens: ["length(btrim(name))", ">=1", "<=80", "name=btrim(name)"], since: M7 },
    { table: "saved_book_views", name: "saved_book_views_filters_check", type: "c", columns: ["filters"], tokens: ["biblib.saved_view_filters_valid(filters)"], since: M7 },
    { table: "shelves", name: "shelves_pkey", type: "p", columns: ["id"], since: M0 },
    { table: "books", name: "books_pkey", type: "p", columns: ["id"], since: M0 },
    { table: "shelves", name: "shelves_user_fk", type: "f", columns: ["user_id"], references: "auth.users", refColumns: ["id"], onDelete: "c", since: M0 },
    { table: "books", name: "books_user_fk", type: "f", columns: ["user_id"], references: "auth.users", refColumns: ["id"], onDelete: "c", since: M0 },
    { table: "books", name: "books_shelf_fk", type: "f", columns: ["shelf_id"], references: "biblib.shelves", refColumns: ["id"], onDelete: "r", since: M0, until: M1 },
    { table: "books", name: "books_owner_shelf_fk", type: "f", columns: ["user_id", "shelf_id"], references: "biblib.shelves", refColumns: ["user_id", "id"], onDelete: "r", since: M1 },
    { table: "books", name: "books_status_check", type: "c", columns: ["status"], tokens: ["'read'", "'reading'", "'unread'", "'to-read'"], since: M0 },
    { table: "books", name: "books_pages_check", type: "c", columns: ["number_of_pages"], tokens: [">=0", "<=100000"], since: M1 },
    { table: "books", name: "books_title_check", type: "c", columns: ["title"], tokens: ["length(btrim(title))", ">=1", "<=500"], since: M1 },
    { table: "shelves", name: "shelves_title_check", type: "c", columns: ["title"], tokens: ["length(btrim(title))", ">=1", "<=120"], since: M1 },
    { table: "library_state", name: "library_state_pkey", type: "p", columns: ["user_id"], since: M3 },
    { table: "library_state", name: "library_state_user_id_users_id_fk", type: "f", columns: ["user_id"], references: "auth.users", refColumns: ["id"], onDelete: "c", since: M3 },
    { table: "import_previews", name: "import_previews_pkey", type: "p", columns: ["id"], since: M3 },
    { table: "import_previews", name: "import_previews_user_id_users_id_fk", type: "f", columns: ["user_id"], references: "auth.users", refColumns: ["id"], onDelete: "c", since: M3 },
    { table: "import_previews", name: "import_previews_mode_check", type: "c", columns: ["mode"], tokens: ["'merge'", "'replace'"], since: M3 },
    { table: "import_previews", name: "import_previews_digest_check", type: "c", columns: ["input_digest"], tokens: ["'^[0-9a-f]{64}$'"], since: M3 },
    { table: "library_operations", name: "library_operations_pkey", type: "p", columns: ["id"], since: M3 },
    { table: "library_operations", name: "library_operations_user_id_users_id_fk", type: "f", columns: ["user_id"], references: "auth.users", refColumns: ["id"], onDelete: "c", since: M3 },
    { table: "library_operations", name: "library_operations_operation_check", type: "c", columns: ["operation"], tokens: ["'import.confirm'"], since: M3 },
    { table: "library_operations", name: "library_operations_status_check", type: "c", columns: ["status"], tokens: ["'committed'"], since: M3 },
    { table: "library_operations", name: "library_operations_key_check", type: "c", columns: ["idempotency_key"], tokens: ["length(idempotency_key)", ">=16", "<=128"], since: M3 },
    { table: "library_operations", name: "library_operations_digest_check", type: "c", columns: ["input_digest"], tokens: ["'^[0-9a-f]{64}$'"], since: M3 },
    { table: "catalogue_cache", name: "catalogue_cache_pkey", type: "p", columns: catalogueKey, since: M4 },
    { table: "catalogue_cache", name: "catalogue_cache_provider_check", type: "c", columns: ["provider"], tokens: providerTokens, since: M4 },
    { table: "catalogue_cache", name: "catalogue_cache_operation_check", type: "c", columns: ["operation"], tokens: ["'lookupISBN'", "'resolveEditions'", "'getCover'"], since: M4 },
    { table: "catalogue_cache", name: "catalogue_cache_status_check", type: "c", columns: ["status"], tokens: ["'found'", "'notFound'"], since: M4 },
    { table: "catalogue_cache", name: "catalogue_cache_key_check", type: "c", columns: ["canonical_key"], tokens: ["length(canonical_key)", ">=1", "<=200"], since: M4 },
    { table: "catalogue_cache", name: "catalogue_cache_payload_check", type: "c", columns: ["payload"], tokens: ["jsonb_typeof(payload)", "'array'"], since: M4 },
    { table: "catalogue_cache", name: "catalogue_cache_expiry_check", type: "c", columns: ["expires_at", "fetched_at"], tokens: ["expires_at>fetched_at"], since: M4 },
    { table: "catalogue_inflight", name: "catalogue_inflight_pkey", type: "p", columns: catalogueKey, since: M4 },
    { table: "catalogue_inflight", name: "catalogue_inflight_provider_check", type: "c", columns: ["provider"], tokens: providerTokens, since: M4 },
    { table: "catalogue_quota_buckets", name: "catalogue_quota_buckets_pkey", type: "p", columns: ["provider", "credential_scope"], since: M4 },
    { table: "catalogue_quota_buckets", name: "catalogue_quota_buckets_provider_check", type: "c", columns: ["provider"], tokens: providerTokens, since: M4 },
    { table: "catalogue_quota_buckets", name: "catalogue_quota_buckets_interval_check", type: "c", columns: ["interval_ms"], tokens: [">=1", "<=3600000"], since: M4 },
    { table: "catalogue_quota_reservations", name: "catalogue_quota_reservations_pkey", type: "p", columns: ["id"], since: M4 },
    { table: "catalogue_quota_reservations", name: "catalogue_quota_reservations_owner_id_users_id_fk", type: "f", columns: ["owner_id"], references: "auth.users", refColumns: ["id"], onDelete: "c", since: M4 },
    { table: "catalogue_quota_reservations", name: "catalogue_quota_reservations_bucket_fk", type: "f", columns: ["provider", "credential_scope"], references: "biblib.catalogue_quota_buckets", refColumns: ["provider", "credential_scope"], onDelete: "c", since: M4 },
    { table: "catalogue_quota_reservations", name: "catalogue_quota_reservations_purpose_check", type: "c", columns: ["purpose"], tokens: ["'interactive'", "'batch'"], since: M4 },
    { table: "catalogue_quota_reservations", name: "catalogue_quota_reservations_expiry_check", type: "c", columns: ["expires_at", "slot_at"], tokens: ["expires_at>slot_at"], since: M4 },
    { table: "catalogue_private_cache", name: "catalogue_private_cache_pkey", type: "p", columns: ["owner_id", "provider", "policy_version", "credential_scope", "schema_version", "operation", "key_hmac"], since: M4 },
    { table: "catalogue_private_cache", name: "catalogue_private_cache_owner_id_users_id_fk", type: "f", columns: ["owner_id"], references: "auth.users", refColumns: ["id"], onDelete: "c", since: M4 },
    { table: "catalogue_private_cache", name: "catalogue_private_cache_provider_check", type: "c", columns: ["provider"], tokens: providerTokens, since: M4 },
    { table: "catalogue_private_cache", name: "catalogue_private_cache_operation_check", type: "c", columns: ["operation"], tokens: ["'searchTitleAuthor'"], since: M4 },
    { table: "catalogue_private_cache", name: "catalogue_private_cache_status_check", type: "c", columns: ["status"], tokens: ["'found'", "'notFound'"], since: M4 },
    { table: "catalogue_private_cache", name: "catalogue_private_cache_key_check", type: "c", columns: ["key_hmac"], tokens: ["'^[0-9a-f]{64}$'"], since: M4 },
    { table: "catalogue_private_cache", name: "catalogue_private_cache_payload_check", type: "c", columns: ["payload"], tokens: ["jsonb_typeof(payload)", "'array'"], since: M4 },
    { table: "catalogue_private_cache", name: "catalogue_private_cache_expiry_check", type: "c", columns: ["expires_at", "fetched_at"], tokens: ["expires_at>fetched_at"], since: M4 },
    { table: "account_lifecycle", name: "account_lifecycle_pkey", type: "p", columns: ["user_id"], since: M5 },
    { table: "account_lifecycle", name: "account_lifecycle_user_id_users_id_fk", type: "f", columns: ["user_id"], references: "auth.users", refColumns: ["id"], onDelete: "c", since: M5 },
    { table: "account_lifecycle", name: "account_lifecycle_state_check", type: "c", columns: ["state"], tokens: ["'active'", "'blocked'"], since: M5 },
    { table: "library_jobs", name: "library_jobs_pkey", type: "p", columns: ["id"], since: M5 },
    { table: "library_jobs", name: "library_jobs_user_id_users_id_fk", type: "f", columns: ["user_id"], references: "auth.users", refColumns: ["id"], onDelete: "c", since: M5 },
    { table: "library_jobs", name: "library_jobs_kind_check", type: "c", columns: ["kind"], tokens: ["'import'", "'covers'"], since: M5, variants: [{ since: M9, tokens: ["'import'", "'covers'", "'cover_asset'"] }] },
    { table: "library_jobs", name: "library_jobs_state_check", type: "c", columns: ["state"], tokens: jobStateTokens, since: M5 },
    { table: "library_jobs", name: "library_jobs_phase_check", type: "c", columns: ["phase"], tokens: ["'publish'", "'covers'", "'done'"], since: M5, variants: [{ since: M9, tokens: ["'publish'", "'covers'", "'asset'", "'done'"] }] },
    { table: "library_jobs", name: "library_jobs_key_check", type: "c", columns: ["idempotency_key"], tokens: ["length(idempotency_key)", ">=16", "<=128"], since: M5 },
    { table: "library_jobs", name: "library_jobs_digest_check", type: "c", columns: ["input_digest"], tokens: ["'^[0-9a-f]{64}$'"], since: M5 },
    { table: "library_jobs", name: "library_jobs_import_check", type: "c", columns: ["kind", "preview_id", "expected_revision"], tokens: ["kind<>'import'", "preview_id is not null", "expected_revision is not null"], since: M5 },
    // Sin lease no hay ejecución, y fuera de ejecución no queda ningún lease.
    { table: "library_jobs", name: "library_jobs_lease_check", type: "c", columns: ["state", "lease_token", "lease_until"], tokens: ["state='running'", "lease_token is not null", "lease_until is not null"], since: M5 },
    { table: "library_jobs", name: "library_jobs_counts_check", type: "c", columns: ["counts"], tokens: ["jsonb_typeof(counts)", "'object'"], since: M5 },
    { table: "library_jobs", name: "library_jobs_attempts_check", type: "c", columns: ["attempts", "fencing_number"], tokens: ["attempts>=0", "fencing_number>=0"], since: M5 },
    { table: "library_job_items", name: "library_job_items_pkey", type: "p", columns: ["id"], since: M5 },
    { table: "library_job_items", name: "library_job_items_owner_job_fk", type: "f", columns: ["user_id", "job_id"], references: "biblib.library_jobs", refColumns: ["user_id", "id"], onDelete: "c", since: M5 },
    { table: "library_job_items", name: "library_job_items_phase_check", type: "c", columns: ["phase"], tokens: ["'covers'"], since: M5 },
    { table: "library_job_items", name: "library_job_items_state_check", type: "c", columns: ["state"], tokens: ["'pending'", "'waiting_retry'", "'succeeded'", "'not_found'", "'skipped'", "'failed'"], since: M5 },
    { table: "library_job_items", name: "library_job_items_key_check", type: "c", columns: ["item_key"], tokens: ["length(item_key)", ">=1", "<=200"], since: M5 },
    { table: "library_job_items", name: "library_job_items_attempts_check", type: "c", columns: ["attempts"], tokens: ["attempts>=0"], since: M5 },
    // Una vista previa importa un archivo o restaura una versión propia; borrar la versión borra sus vistas previas.
    { table: "import_previews", name: "import_previews_source_check", type: "c", columns: ["payload", "snapshot_id"], tokens: ["payload is null", "<>", "snapshot_id is null"], since: M6 },
    { table: "import_previews", name: "import_previews_owner_snapshot_fk", type: "f", columns: ["user_id", "snapshot_id"], references: "biblib.library_snapshots", refColumns: ["user_id", "id"], onDelete: "c", since: M6 },
    { table: "library_snapshots", name: "library_snapshots_pkey", type: "p", columns: ["id"], since: M6 },
    { table: "library_snapshots", name: "library_snapshots_user_id_users_id_fk", type: "f", columns: ["user_id"], references: "auth.users", refColumns: ["id"], onDelete: "c", since: M6 },
    // La operación que sustituyó el estado: sin acción al borrar, para que purgar operaciones no borre versiones en silencio.
    { table: "library_snapshots", name: "library_snapshots_owner_operation_fk", type: "f", columns: ["user_id", "source_operation_id"], references: "biblib.library_operations", refColumns: ["user_id", "id"], onDelete: "a", since: M6 },
    { table: "library_snapshots", name: "library_snapshots_reason_check", type: "c", columns: ["reason"], tokens: ["'import.replace'", "'snapshot.restore'"], since: M6 },
    { table: "library_snapshots", name: "library_snapshots_state_check", type: "c", columns: ["state"], tokens: ["'capturing'", "'ready'"], since: M6 },
    { table: "library_snapshots", name: "library_snapshots_digest_check", type: "c", columns: ["digest"], tokens: ["digest is null", "'^[0-9a-f]{64}$'"], since: M6 },
    // Solo se anuncia como válida una versión completa con hash.
    { table: "library_snapshots", name: "library_snapshots_ready_check", type: "c", columns: ["state", "digest"], tokens: ["state<>'ready'", "digest is not null"], since: M6 },
    { table: "library_snapshots", name: "library_snapshots_counts_check", type: "c", columns: ["counts"], tokens: ["jsonb_typeof(counts)", "'object'"], since: M6 },
    { table: "library_snapshots", name: "library_snapshots_schema_version_check", type: "c", columns: ["schema_version"], tokens: ["schema_version>=1"], since: M6 },
    { table: "library_snapshots", name: "library_snapshots_expiry_check", type: "c", columns: ["expires_at", "created_at"], tokens: ["expires_at>created_at"], since: M6 },
    { table: "library_snapshot_chunks", name: "library_snapshot_chunks_pkey", type: "p", columns: ["snapshot_id", "seq"], since: M6 },
    { table: "library_snapshot_chunks", name: "library_snapshot_chunks_owner_snapshot_fk", type: "f", columns: ["user_id", "snapshot_id"], references: "biblib.library_snapshots", refColumns: ["user_id", "id"], onDelete: "c", since: M6 },
    { table: "library_snapshot_chunks", name: "library_snapshot_chunks_kind_check", type: "c", columns: ["kind"], tokens: ["'shelves'", "'books'"], since: M6 },
    { table: "library_snapshot_chunks", name: "library_snapshot_chunks_seq_check", type: "c", columns: ["seq"], tokens: ["seq>=0"], since: M6 },
    { table: "library_snapshot_chunks", name: "library_snapshot_chunks_size_check", type: "c", columns: ["item_count", "payload"], tokens: [">=1", "<=200", "jsonb_array_length(payload)=item_count"], since: M6 },
    { table: "library_snapshot_chunks", name: "library_snapshot_chunks_digest_check", type: "c", columns: ["digest"], tokens: ["'^[0-9a-f]{64}$'"], since: M6 },
  ],
  indexes: [
    // T7: igualdad indexada por (dueño, ISBN-13) y una sola edición canónica por ISBN; listado por título; T8 sobre ejemplares.
    { table: "works", name: "works_user_id_id_unique", unique: true, columns: ["user_id", "id"], partial: false, since: M10 },
    { table: "editions", name: "editions_user_id_id_unique", unique: true, columns: ["user_id", "id"], partial: false, since: M10 },
    { table: "editions", name: "editions_user_isbn13_unique", unique: true, columns: ["user_id", "isbn13"], partial: true, since: M10 },
    { table: "editions", name: "editions_user_title_idx", unique: false, columns: ["user_id", "title", "id"], partial: false, since: M10 },
    { table: "editions", name: "editions_user_work_idx", unique: false, columns: ["user_id", "work_id"], partial: true, since: M10 },
    { table: "editions", name: "editions_cover_asset_idx", unique: false, columns: ["user_id", "cover_asset_id"], partial: true, since: M10 },
    { table: "copies", name: "copies_user_id_id_unique", unique: true, columns: ["user_id", "id"], partial: false, since: M10 },
    { table: "copies", name: "copies_user_legacy_identifier_unique", unique: true, columns: ["user_id", "legacy_identifier"], partial: true, since: M10 },
    { table: "copies", name: "copies_user_edition_idx", unique: false, columns: ["user_id", "edition_id"], partial: false, since: M10 },
    { table: "copies", name: "copies_user_shelf_idx", unique: false, columns: ["user_id", "shelf_id"], partial: false, since: M10 },
    { table: "copies", name: "copies_user_created_idx", unique: false, columns: ["user_id", "created_at", "id"], partial: false, since: M10 },
    { table: "model_migration_report", name: "model_migration_report_user_idx", unique: false, columns: ["user_id", "migration", "kind"], partial: false, since: M10 },
    { table: "cover_assets", name: "cover_assets_user_id_id_unique", unique: true, columns: ["user_id", "id"], partial: false, since: M9 },
    { table: "cover_assets", name: "cover_assets_user_sha_unique", unique: true, columns: ["user_id", "sha256"], partial: true, since: M9 },
    { table: "cover_assets", name: "cover_assets_job_unique", unique: true, columns: ["job_id"], partial: true, since: M9 },
    { table: "cover_assets", name: "cover_assets_user_created_idx", unique: false, columns: ["user_id", "created_at"], partial: false, since: M9 },
    { table: "cover_assets", name: "cover_assets_expires_at_idx", unique: false, columns: ["expires_at"], partial: true, since: M9 },
    { table: "books", name: "books_cover_asset_idx", unique: false, columns: ["user_id", "cover_asset_id"], partial: true, since: M9 },
    { table: "import_sessions", name: "import_sessions_user_id_id_unique", unique: true, columns: ["user_id", "id"], partial: false, since: M8 },
    { table: "import_sessions", name: "import_sessions_user_created_idx", unique: false, columns: ["user_id", "created_at", "id"], partial: false, since: M8 },
    { table: "import_sessions", name: "import_sessions_expires_at_idx", unique: false, columns: ["expires_at"], partial: false, since: M8 },
    { table: "import_session_parts", name: "import_session_parts_index_unique", unique: true, columns: ["session_id", "part_index"], partial: false, since: M8 },
    { table: "import_session_parts", name: "import_session_parts_owner_unique", unique: true, columns: ["user_id", "session_id", "part_id"], partial: false, since: M8 },
    { table: "import_session_rows", name: "import_session_rows_order_idx", unique: false, columns: ["session_id", "kind", "part_index", "position"], partial: false, since: M8 },
    // pg_index.indkey solo enumera user_id para el índice con expresión lower(name).
    { table: "saved_book_views", name: "saved_book_views_user_name_unique", unique: true, columns: ["user_id"], partial: false, definitionTokens: ["lower(name)"], since: M7 },
    { table: "saved_book_views", name: "saved_book_views_user_updated_idx", unique: false, columns: ["user_id", "updated_at"], partial: false, definitionTokens: ["updated_at desc"], since: M7 },
    { table: "shelves", name: "shelves_user_id_title_unique", unique: true, columns: ["user_id", "title"], partial: false, since: M0 },
    { table: "shelves", name: "shelves_user_id_default_unique", unique: true, columns: ["user_id", "is_default"], partial: true, since: M0 },
    { table: "books", name: "books_user_id_isbn_unique", unique: true, columns: ["user_id", "isbn"], partial: false, since: M0 },
    { table: "books", name: "books_user_id_idx", unique: false, columns: ["user_id"], partial: false, since: M0 },
    { table: "books", name: "books_shelf_id_idx", unique: false, columns: ["shelf_id"], partial: false, since: M0 },
    { table: "shelves", name: "shelves_user_id_id_unique", unique: true, columns: ["user_id", "id"], partial: false, since: M1 },
    { table: "books", name: "books_user_id_id_unique", unique: true, columns: ["user_id", "id"], partial: false, since: M1 },
    { table: "import_previews", name: "import_previews_user_id_id_unique", unique: true, columns: ["user_id", "id"], partial: false, since: M3 },
    { table: "import_previews", name: "import_previews_user_id_expires_at_idx", unique: false, columns: ["user_id", "expires_at"], partial: false, since: M3 },
    { table: "library_operations", name: "library_operations_key_unique", unique: true, columns: ["user_id", "operation", "idempotency_key"], partial: false, since: M3 },
    { table: "library_operations", name: "library_operations_preview_unique", unique: true, columns: ["user_id", "preview_id"], partial: true, since: M3 },
    { table: "catalogue_cache", name: "catalogue_cache_expires_at_idx", unique: false, columns: ["expires_at"], partial: false, since: M4 },
    { table: "catalogue_inflight", name: "catalogue_inflight_fence_unique", unique: true, columns: ["fence"], partial: false, since: M4 },
    { table: "catalogue_quota_reservations", name: "catalogue_quota_reservations_fence_unique", unique: true, columns: ["fence"], partial: false, since: M4 },
    { table: "catalogue_quota_reservations", name: "catalogue_quota_reservations_active_idx", unique: false, columns: ["provider", "credential_scope", "owner_id", "purpose"], partial: true, since: M4 },
    { table: "catalogue_quota_reservations", name: "catalogue_quota_reservations_expires_at_idx", unique: false, columns: ["provider", "credential_scope", "expires_at"], partial: false, since: M4 },
    { table: "catalogue_private_cache", name: "catalogue_private_cache_expires_at_idx", unique: false, columns: ["owner_id", "expires_at"], partial: false, since: M4 },
    { table: "library_jobs", name: "library_jobs_key_unique", unique: true, columns: ["user_id", "kind", "idempotency_key"], partial: false, since: M5 },
    { table: "library_jobs", name: "library_jobs_user_id_id_unique", unique: true, columns: ["user_id", "id"], partial: false, since: M5 },
    { table: "library_jobs", name: "library_jobs_user_id_created_at_idx", unique: false, columns: ["user_id", "created_at"], partial: false, since: M5 },
    { table: "library_jobs", name: "library_jobs_due_idx", unique: false, columns: ["next_attempt_at"], partial: true, since: M5 },
    { table: "library_job_items", name: "library_job_items_job_item_phase_unique", unique: true, columns: ["job_id", "item_key", "phase"], partial: false, since: M5 },
    { table: "library_job_items", name: "library_job_items_due_idx", unique: false, columns: ["job_id", "state", "next_attempt_at"], partial: false, since: M5 },
    // Tarea T8 de U-QA-03: listado por título, vista 3D por estantería y «Añadidos recientemente».
    { table: "books", name: "books_user_title_idx", unique: false, columns: ["user_id", "title", "id"], partial: false, since: M6 },
    { table: "books", name: "books_user_shelf_title_idx", unique: false, columns: ["user_id", "shelf_id", "title", "id"], partial: false, since: M6 },
    { table: "books", name: "books_user_created_idx", unique: false, columns: ["user_id", "created_at", "id"], partial: false, since: M6 },
    { table: "import_previews", name: "import_previews_snapshot_id_idx", unique: false, columns: ["user_id", "snapshot_id"], partial: true, since: M6 },
    { table: "library_operations", name: "library_operations_user_id_id_unique", unique: true, columns: ["user_id", "id"], partial: false, since: M6 },
    { table: "library_snapshots", name: "library_snapshots_user_id_id_unique", unique: true, columns: ["user_id", "id"], partial: false, since: M6 },
    { table: "library_snapshots", name: "library_snapshots_operation_unique", unique: true, columns: ["user_id", "source_operation_id"], partial: false, since: M6 },
    { table: "library_snapshots", name: "library_snapshots_user_id_created_at_idx", unique: false, columns: ["user_id", "created_at", "id"], partial: false, since: M6 },
    { table: "library_snapshots", name: "library_snapshots_expires_at_idx", unique: false, columns: ["expires_at"], partial: false, since: M6 },
  ],
  columns: [
    { table: "editions", name: "isbn13", type: "text", notNull: false, since: M10 },
    { table: "editions", name: "work_id", type: "uuid", notNull: false, since: M10 },
    { table: "editions", name: "catalogue", type: "jsonb", notNull: true, since: M10 },
    { table: "editions", name: "identifiers", type: "jsonb", notNull: true, since: M10 },
    { table: "editions", name: "cover_asset_id", type: "uuid", notNull: false, since: M10 },
    { table: "editions", name: "search_text", type: "text", notNull: false, since: M10 },
    { table: "copies", name: "edition_id", type: "uuid", notNull: true, since: M10 },
    { table: "copies", name: "edition_verification", type: "jsonb", notNull: true, defaultTokens: ["isbnVerified"], since: M10 },
    { table: "copies", name: "legacy_identifier", type: "text", notNull: false, since: M10 },
    ...modelTables.map((table) => ({ table, name: "version", type: "uuid", notNull: true, defaultTokens: ["gen_random_uuid()"], since: M10 })),
    { table: "books", name: "cover_asset_id", type: "uuid", notNull: false, since: M9 },
    { table: "cover_assets", name: "state", type: "text", notNull: true, defaultTokens: ["'quarantine'"], since: M9 },
    { table: "cover_assets", name: "storage_key", type: "text", notNull: false, since: M9 },
    { table: "cover_assets", name: "sha256", type: "text", notNull: false, since: M9 },
    { table: "cover_assets", name: "source_ref", type: "text", notNull: true, since: M9 },
    { table: "cover_assets", name: "rights_policy_version", type: "text", notNull: true, since: M9 },
    { table: "cover_assets", name: "upload_token", type: "text", notNull: false, since: M9 },
    { table: "cover_assets", name: "expires_at", type: "timestamp with time zone", notNull: false, since: M9 },
    { table: "cover_assets", name: "version", type: "uuid", notNull: true, defaultTokens: ["gen_random_uuid()"], since: M9 },
    { table: "import_sessions", name: "base_revision", type: "uuid", notNull: true, since: M8 },
    { table: "import_sessions", name: "manifest_digest", type: "text", notNull: true, since: M8 },
    { table: "import_sessions", name: "expires_at", type: "timestamp with time zone", notNull: true, since: M8 },
    { table: "import_sessions", name: "version", type: "uuid", notNull: true, defaultTokens: ["gen_random_uuid()"], since: M8 },
    { table: "import_session_chunks", name: "bytes", type: "bytea", notNull: true, since: M8 },
    { table: "import_session_rows", name: "data", type: "jsonb", notNull: true, since: M8 },
    ...[["id", "uuid"], ["user_id", "uuid"], ["name", "text"], ["filters", "jsonb"], ["created_at", "timestamp with time zone"], ["updated_at", "timestamp with time zone"], ["version", "uuid"]].map(([name, type]) => ({ table: "saved_book_views", name, type, notNull: true, ...(name === "version" ? { defaultTokens: ["gen_random_uuid()"] } : {}), since: M7 })),
    { table: "books", name: "catalogue", type: "jsonb", notNull: true, since: M1 },
    { table: "books", name: "version", type: "uuid", notNull: true, defaultTokens: ["gen_random_uuid()"], since: M2 },
    { table: "library_state", name: "revision", type: "uuid", notNull: true, defaultTokens: ["gen_random_uuid()"], since: M3 },
    { table: "library_state", name: "rotated_xact", type: "xid8", notNull: false, since: M3 },
    { table: "import_previews", name: "revision", type: "uuid", notNull: true, since: M3 },
    { table: "import_previews", name: "expires_at", type: "timestamp with time zone", notNull: true, since: M3 },
    { table: "catalogue_cache", name: "fence", type: "bigint", notNull: true, since: M4 },
    { table: "catalogue_cache", name: "expires_at", type: "timestamp with time zone", notNull: true, since: M4 },
    { table: "catalogue_inflight", name: "lease_expires_at", type: "timestamp with time zone", notNull: true, since: M4 },
    { table: "catalogue_quota_buckets", name: "cooldown_until", type: "timestamp with time zone", notNull: false, since: M4 },
    { table: "catalogue_quota_reservations", name: "owner_id", type: "uuid", notNull: false, since: M4 },
    { table: "catalogue_quota_reservations", name: "expires_at", type: "timestamp with time zone", notNull: true, since: M4 },
    { table: "catalogue_private_cache", name: "owner_id", type: "uuid", notNull: true, since: M4 },
    { table: "account_lifecycle", name: "state", type: "text", notNull: true, defaultTokens: ["'active'"], since: M5 },
    { table: "library_jobs", name: "version", type: "uuid", notNull: true, defaultTokens: ["gen_random_uuid()"], since: M5 },
    { table: "library_jobs", name: "lease_token", type: "uuid", notNull: false, since: M5 },
    { table: "library_jobs", name: "lease_until", type: "timestamp with time zone", notNull: false, since: M5 },
    { table: "library_jobs", name: "fencing_number", type: "bigint", notNull: true, since: M5 },
    { table: "library_jobs", name: "expires_at", type: "timestamp with time zone", notNull: true, since: M5 },
    { table: "library_jobs", name: "input_digest", type: "text", notNull: true, since: M5 },
    { table: "library_job_items", name: "target_version", type: "uuid", notNull: false, since: M5 },
    { table: "import_previews", name: "snapshot_id", type: "uuid", notNull: false, since: M6 },
    { table: "library_snapshots", name: "state", type: "text", notNull: true, defaultTokens: ["'capturing'"], since: M6 },
    { table: "library_snapshots", name: "digest", type: "text", notNull: false, since: M6 },
    { table: "library_snapshots", name: "version", type: "uuid", notNull: true, defaultTokens: ["gen_random_uuid()"], since: M6 },
    { table: "library_snapshots", name: "expires_at", type: "timestamp with time zone", notNull: true, since: M6 },
    { table: "library_snapshots", name: "source_operation_id", type: "uuid", notNull: true, since: M6 },
    { table: "library_snapshot_chunks", name: "payload", type: "jsonb", notNull: true, since: M6 },
    { table: "library_snapshot_chunks", name: "digest", type: "text", notNull: true, since: M6 },
  ],
  functions: [
    modelFunction("isbn13_normalize", "text", 1, { authenticated: true }),
    modelFunction("prune_orphan_editions", "trigger", 0),
    modelFunction("prune_orphan_works", "trigger", 0),
    modelFunction("edition_requires_copy", "trigger", 0),
    modelFunction("model_sync_book", "trigger", 0, { securityDefiner: true }),
    modelFunction("model_compare", "jsonb", 1, { securityDefiner: true }),
    { name: "saved_view_filters_valid", language: "plpgsql", returns: "boolean", args: 1, searchPath: "search_path=pg_catalog", securityDefiner: false, body: VIEWS.saved_view_filters_valid, execute: { authenticated: true, anon: false }, since: M7 },
    { name: "guard_saved_book_view", language: "plpgsql", returns: "trigger", args: 0, searchPath: "search_path=pg_catalog", securityDefiner: true, body: VIEWS.guard_saved_book_view, execute: { authenticated: false, anon: false }, since: M7 },
    { name: "rotate_book_version", language: "plpgsql", returns: "trigger", args: 0, searchPath: "search_path=pg_catalog", securityDefiner: false, body: "beginnew.version:=gen_random_uuid();returnnew;end;", since: M2 },
    // SECURITY DEFINER con search_path fijo: única vía de escritura de library_state.
    { name: "rotate_library_revision", language: "plpgsql", returns: "trigger", args: 0, searchPath: "search_path=pg_catalog", securityDefiner: true, body: normalizeBody(ROTATE_LIBRARY_REVISION), execute: { authenticated: false, anon: false }, since: M3 },
    { name: "lock_library", language: "plpgsql", returns: "uuid", args: 0, searchPath: "search_path=pg_catalog", securityDefiner: true, body: normalizeBody(LOCK_LIBRARY), execute: { authenticated: true, anon: false }, since: M3 },
    catalogueFunction("catalogue_reserve", "jsonb", 8),
    catalogueFunction("catalogue_release", "boolean", 3),
    catalogueFunction("catalogue_begin", "jsonb", 9),
    catalogueFunction("catalogue_complete", "text", 11),
    catalogueFunction("catalogue_private_get", "jsonb", 7),
    catalogueFunction("catalogue_private_put", "boolean", 10),
    catalogueFunction("catalogue_invalidate", "integer", 3),
    jobFunction("account_is_active", "boolean", 1),
    jobFunction("account_set_state", "integer", 2),
    jobFunction("library_job_create", "jsonb", 5, true),
    jobFunction("library_job_control", "jsonb", 3, true),
    { ...jobFunction("library_job_claim", "jsonb", 3), until: M9 },
    assetFunction("library_job_claim", "jsonb", 3, false),
    jobFunction("library_job_renew", "boolean", 4),
    jobFunction("library_job_fence", "uuid", 3),
    { ...snapshotFunction("library_snapshot_capture", "jsonb", 2), until: M9 },
    assetFunction("library_snapshot_capture", "jsonb", 2),
    snapshotFunction("library_snapshot_foreign_ids", "uuid[]", 1),
    snapshotFunction("library_snapshot_delete", "text", 2),
    snapshotFunction("library_snapshot_purge_expired", "integer", 1, false),
    { name: "guard_import_staging", language: "plpgsql", returns: "trigger", args: 0, searchPath: "search_path=pg_catalog", securityDefiner: false, body: RESTORE.guard_import_staging, execute: { authenticated: false, anon: false }, since: M8 },
    { name: "import_session_purge_expired", language: "plpgsql", returns: "integer", args: 1, searchPath: "search_path=pg_catalog", securityDefiner: true, body: RESTORE.import_session_purge_expired, execute: { authenticated: false, anon: false }, since: M8 },
    assetFunction("cover_object_access", "boolean", 2),
    assetFunction("cover_asset_quota", "text", 1, false),
    assetFunction("cover_asset_request", "jsonb", 7),
    assetFunction("cover_asset_begin_upload", "jsonb", 0),
    assetFunction("cover_asset_authorize", "boolean", 2),
    assetFunction("cover_asset_register", "jsonb", 7),
    assetFunction("cover_asset_discard", "boolean", 1),
    assetFunction("cover_asset_revalidate", "text", 2),
    assetFunction("guard_book_cover_asset", "trigger", 0, false, false),
    assetFunction("cover_asset_purge_candidates", "jsonb", 3, false),
    assetFunction("cover_asset_purge_confirm", "text[]", 3, false),
    assetFunction("cover_asset_quarantine_restored", "integer", 0, false),
    assetFunction("cover_storage_install", "void", 0, false, false),
  ],
  // tgtype: ROW(1) | BEFORE(2) | INSERT(4) | DELETE(8) | UPDATE(16). BEFORE INSERT OR UPDATE = 23; AFTER INSERT OR UPDATE OR DELETE = 29.
  triggers: [
    { table: "books", name: "books_rotate_version", function: "biblib.rotate_book_version", timing: "BEFORE", events: ["INSERT", "UPDATE"], level: "ROW", tgtype: 23, since: M2 },
    { table: "books", name: "books_rotate_library_revision", function: "biblib.rotate_library_revision", timing: "AFTER", events: ["INSERT", "UPDATE", "DELETE"], level: "ROW", tgtype: 29, since: M3 },
    { table: "shelves", name: "shelves_rotate_library_revision", function: "biblib.rotate_library_revision", timing: "AFTER", events: ["INSERT", "UPDATE", "DELETE"], level: "ROW", tgtype: 29, since: M3 },
    { table: "saved_book_views", name: "saved_book_views_guard", function: "biblib.guard_saved_book_view", timing: "BEFORE", events: ["INSERT", "UPDATE"], level: "ROW", tgtype: 23, since: M7 },
    // BEFORE INSERT FOR EACH ROW = 7.
    { table: "import_session_chunks", name: "import_session_chunks_guard", function: "biblib.guard_import_staging", timing: "BEFORE", events: ["INSERT"], level: "ROW", tgtype: 7, since: M8 },
    { table: "import_session_rows", name: "import_session_rows_guard", function: "biblib.guard_import_staging", timing: "BEFORE", events: ["INSERT"], level: "ROW", tgtype: 7, since: M8 },
    // BEFORE UPDATE FOR EACH ROW = 19.
    { table: "books", name: "books_guard_cover_asset", function: "biblib.guard_book_cover_asset", timing: "BEFORE", events: ["UPDATE"], level: "ROW", tgtype: 19, since: M9 },
    // Obra, edición y ejemplar (0010). Por sentencia: AFTER DELETE = 8, AFTER UPDATE = 16; restricción diferida AFTER INSERT FOR EACH ROW = 5.
    ...modelTables.flatMap((table) => [
      modelTrigger(table, `${table}_rotate_version`, "rotate_book_version", "BEFORE", ["INSERT", "UPDATE"], "ROW", 23),
      modelTrigger(table, `${table}_rotate_library_revision`, "rotate_library_revision", "AFTER", ["INSERT", "UPDATE", "DELETE"], "ROW", 29),
    ]),
    modelTrigger("editions", "editions_guard_cover_asset", "guard_book_cover_asset", "BEFORE", ["UPDATE"], "ROW", 19),
    modelTrigger("copies", "copies_prune_editions_delete", "prune_orphan_editions", "AFTER", ["DELETE"], "STATEMENT", 8),
    modelTrigger("copies", "copies_prune_editions_update", "prune_orphan_editions", "AFTER", ["UPDATE"], "STATEMENT", 16),
    modelTrigger("editions", "editions_prune_works_delete", "prune_orphan_works", "AFTER", ["DELETE"], "STATEMENT", 8),
    modelTrigger("editions", "editions_prune_works_update", "prune_orphan_works", "AFTER", ["UPDATE"], "STATEMENT", 16),
    modelTrigger("editions", "editions_require_copy", "edition_requires_copy", "AFTER", ["INSERT"], "ROW", 5),
    modelTrigger("books", "books_model_sync", "model_sync_book", "AFTER", ["INSERT", "UPDATE", "DELETE"], "ROW", 29),
  ],
  // Bucket privado de portadas y sus políticas en storage.objects (0009). Fuera del esquema biblib, pero
  // del dominio: se comprueban igual y una política biblib_* no declarada es drift.
  storage: {
    buckets: [{ id: COVERS_BUCKET, public: false, fileSizeLimit: 5242880, allowedMimeTypes: ["image/webp"], since: M9 }],
    policies: [storagePolicy("biblib_covers_select_own", "SELECT", "select"), storagePolicy("biblib_covers_insert_own", "INSERT", "insert"), storagePolicy("biblib_covers_delete_own", "DELETE", "delete")],
  },
  prerequisites: ["auth.users", "auth.uid()", "role:authenticated", "role:anon"],
})

/** Normaliza expresiones para comparar semántica estable (sin espacios, paréntesis ni casts). */
export function normalizeExpression(value) {
  if (value == null) return null
  return String(value).toLowerCase().replace(/::[a-z_]+(\[\])?/g, "").replace(/[\s()"]/g, "")
}

export function normalizeBody(value) {
  return String(value ?? "").split("\n").map((line) => line.replace(/--.*$/, "")).join("").toLowerCase().replace(/\s+/g, "")
}

function decodeTrigger(tgtype) {
  return {
    level: tgtype & 1 ? "ROW" : "STATEMENT",
    timing: tgtype & 64 ? "INSTEAD OF" : tgtype & 2 ? "BEFORE" : "AFTER",
    events: [[4, "INSERT"], [8, "DELETE"], [16, "UPDATE"], [32, "TRUNCATE"]].filter(([bit]) => tgtype & bit).map(([, name]) => name),
  }
}

// Consultas de solo lectura. Los nombres de esquema/tabla son constantes, nunca entrada de usuario.
export async function inspectObjects(sql) {
  const [roles, prerequisites, tables, policies, grants, schemaUsage, constraints, indexes, columns, functions, triggers] = await Promise.all([
    sql`select rolname from pg_roles where rolname in ('authenticated', 'anon')`,
    sql`select to_regclass('auth.users') is not null as users, to_regprocedure('auth.uid()') is not null as uid`,
    sql`select c.relname as name, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'biblib' and c.relkind = 'r'`,
    sql`select p.polname as name, c.relname as table, p.polcmd as cmd, p.polpermissive as permissive,
        coalesce((select array_agg(case when r = 0 then 'public' else (select rolname::text from pg_roles where oid = r) end order by 1) from unnest(p.polroles) r), '{}'::text[]) as roles,
        pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as check
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'biblib'`,
    sql`select grantee, table_name as table, privilege_type as privilege from information_schema.role_table_grants where table_schema = 'biblib' and grantee in ('authenticated', 'anon')`,
    sql`select r.rolname as role, has_schema_privilege(r.oid, n.oid, 'USAGE') as usage from pg_roles r cross join pg_namespace n where r.rolname in ('authenticated', 'anon') and n.nspname = 'biblib'`,
    sql`select con.conname as name, c.relname as table, con.contype as type, con.convalidated as validated,
        array(select a.attname::text from unnest(con.conkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.i) as columns,
        case when con.confrelid <> 0 then con.confrelid::regclass::text end as references,
        array(select a.attname::text from unnest(con.confkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.i) as ref_columns,
        con.confdeltype as on_delete, case when con.contype = 'c' then pg_get_constraintdef(con.oid) end as definition
      from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'biblib'`,
    sql`select i.relname as name, c.relname as table, x.indisunique as unique, x.indpred is not null as partial, pg_get_indexdef(x.indexrelid) as definition,
        array(select a.attname::text from unnest(x.indkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.n order by k.o) as columns
      from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class c on c.oid = x.indrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'biblib'`,
    sql`select c.relname as table, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as default
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname = 'biblib' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped`,
    sql`select p.proname as name, l.lanname as language, pg_get_function_result(p.oid) as returns, p.pronargs as args, p.proconfig as config, p.prosecdef as security_definer, p.prosrc as body,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as execute_authenticated, has_function_privilege('anon', p.oid, 'EXECUTE') as execute_anon
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang where n.nspname = 'biblib'`,
    sql`select t.tgname as name, c.relname as table, pn.nspname || '.' || p.proname as function, t.tgtype as tgtype, t.tgenabled as enabled, t.tgattr::text as columns, t.tgqual is not null as conditional
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
      where n.nspname = 'biblib' and not t.tgisinternal`,
  ])
  const storage = await inspectStorage(sql)
  return {
    roles: roles.map((r) => r.rolname), prerequisites: prerequisites[0],
    tables: [...tables], policies: [...policies], grants: [...grants], schemaUsage: [...schemaUsage],
    constraints: [...constraints],
    // Los respaldos anteriores sellaron estos hechos sin `definition` en sus índices.
    // Solo el objeto nuevo necesita ese detalle: se conserva el formato/hash de los heads 0000–0006.
    indexes: indexes.map(({ definition, ...entry }) => entry.table === "saved_book_views" ? { ...entry, definition } : entry),
    columns: [...columns], functions: [...functions], triggers: [...triggers],
    ...(storage ? { storage } : {}),
  }
}

/**
 * Bucket de portadas y políticas biblib_* de storage.objects, solo con el dominio de 0009 presente
 * (biblib.cover_assets): la fila del bucket es un dato de Storage que sobrevive a borrar el esquema
 * biblib, y sin el dominio no forma parte de sus hechos. null en heads anteriores a 0009.
 */
async function inspectStorage(sql) {
  const rows = await sql`select to_regclass('storage.objects') is not null and to_regclass('storage.buckets') is not null and to_regclass('biblib.cover_assets') is not null as found`
  // Un inspector simulado de heads anteriores (pruebas de hechos sellados) no responde a esta consulta.
  if (!Array.isArray(rows) || !rows[0]?.found) return null
  const [buckets, policies] = await Promise.all([
    sql`select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = ${COVERS_BUCKET}`,
    sql`select p.polname as name, p.polcmd as cmd, p.polpermissive as permissive,
        coalesce((select array_agg(case when r = 0 then 'public' else (select rolname::text from pg_roles where oid = r) end order by 1) from unnest(p.polroles) r), '{}'::text[]) as roles,
        pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as check
      from pg_policy p where p.polrelid = 'storage.objects'::regclass and starts_with(p.polname, 'biblib_')`,
  ])
  return {
    buckets: buckets.map((b) => ({ id: b.id, public: b.public, fileSizeLimit: b.file_size_limit === null ? null : Number(b.file_size_limit), allowedMimeTypes: b.allowed_mime_types ?? null })),
    policies: [...policies].sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export function checkPrerequisites(facts) {
  const ok = { "auth.users": facts.prerequisites?.users === true, "auth.uid()": facts.prerequisites?.uid === true, "role:authenticated": facts.roles.includes("authenticated"), "role:anon": facts.roles.includes("anon") }
  return MANIFEST.prerequisites.map((id) => ({ id: `prerequisite.${id}`, status: ok[id] ? "ok" : "fail", code: EXIT.SERVICE_UNAVAILABLE, message: ok[id] ? `${id} lo proporciona la plataforma.` : `${id} no existe: la plataforma (GoTrue/Supabase) debe crearlo; el runner no fabrica sustitutos.` }))
}

const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

/**
 * Verifica los hechos inspeccionados contra el manifest para las migraciones aplicadas.
 * Devuelve comprobaciones `{ id, status, message }`; cualquier `fail` es drift.
 */
export function verifyManifest(facts, appliedTags) {
  const applied = new Set(appliedTags)
  const active = (item) => applied.has(item.since) && !(item.until && applied.has(item.until))
  const checks = []
  const result = (id, okay, message, failure) => checks.push({ id, status: okay ? "ok" : "fail", code: EXIT.HISTORY_DIVERGED, message: okay ? message : failure })
  if (!applied.size) return checks

  for (const table of MANIFEST.tables.filter(active)) {
    const found = facts.tables.find((t) => t.name === table.name)
    result(`rls.${table.name}`, found?.rls === true, `RLS habilitado en biblib.${table.name}.`, found ? `RLS deshabilitado en biblib.${table.name}.` : `Falta la tabla biblib.${table.name}.`)
  }

  const expectedPolicies = MANIFEST.policies.filter(active).map((p) => ({ ...p, ...[...(p.variants ?? [])].reverse().find((v) => applied.has(v.since)) }))
  for (const expected of expectedPolicies) {
    const found = facts.policies.find((p) => p.name === expected.name && p.table === expected.table)
    const cmd = { r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", "*": "ALL" }[found?.cmd]
    const okay = found && cmd === expected.cmd && found.permissive && same(found.roles, expected.roles) && normalizeExpression(found.using) === expected.using && normalizeExpression(found.check) === expected.check
    result(`policy.${expected.name}`, okay, `Política ${expected.name} (${expected.cmd} TO ${expected.roles.join(",")}) conforme.`, found ? `La política ${expected.name} difiere en comando, roles o expresión normalizada.` : `Falta la política ${expected.name} en biblib.${expected.table}.`)
  }
  for (const extra of facts.policies.filter((p) => !expectedPolicies.some((e) => e.name === p.name && e.table === p.table))) {
    result(`policy.${extra.name}`, false, "", `Política no declarada ${extra.name} en biblib.${extra.table}: podría ampliar el acceso.`)
  }

  for (const [role, tables] of Object.entries(MANIFEST.grants)) {
    const usage = facts.schemaUsage.find((s) => s.role === role)?.usage === true
    result(`grant.${role}.schema`, usage === (role === "authenticated"), `USAGE sobre biblib ${usage ? "concedido" : "no concedido"} a ${role}, como se espera.`, `USAGE sobre biblib ${usage ? "concedido" : "ausente"} para ${role}, contrario al manifest.`)
    for (const [table, privileges] of Object.entries(tables)) {
      if (!MANIFEST.tables.some((t) => t.name === table && active(t))) continue
      const granted = facts.grants.filter((g) => g.grantee === role && g.table === table).map((g) => g.privilege)
      result(`grant.${role}.${table}`, same(granted, privileges), `Privilegios de ${role} en biblib.${table}: ${privileges.join(", ") || "ninguno"}.`, `Privilegios de ${role} en biblib.${table} distintos del manifest (${granted.sort().join(", ") || "ninguno"}).`)
    }
  }

  for (const declared of MANIFEST.constraints) {
    // Una migración posterior puede ampliar la condición de la misma restricción (variants).
    const expected = { ...declared, ...[...(declared.variants ?? [])].reverse().find((v) => applied.has(v.since)) }
    const found = facts.constraints.find((c) => c.name === expected.name && c.table === expected.table)
    if (!active(expected)) {
      if (expected.until && applied.has(expected.until)) result(`constraint.${expected.name}`, !found, `${expected.name} retirada por ${expected.until}.`, `${expected.name} debería haberse retirado en ${expected.until}.`)
      continue
    }
    const definition = normalizeExpression(found?.definition)
    const okay = found && found.type === expected.type && found.validated && same(found.columns, expected.columns) && found.columns.join() === expected.columns.join()
      && (expected.type !== "f" || (found.references === expected.references && found.ref_columns.join() === expected.refColumns.join() && found.on_delete === expected.onDelete))
      && (!expected.tokens || expected.tokens.every((token) => definition?.includes(normalizeExpression(token))))
    result(`constraint.${expected.name}`, okay, `Restricción ${expected.name} conforme.`, found ? `La restricción ${expected.name} difiere (tipo, columnas, referencia, acción o condición normalizada).` : `Falta la restricción ${expected.name}.`)
  }

  for (const expected of MANIFEST.indexes.filter(active)) {
    const found = facts.indexes.find((i) => i.name === expected.name && i.table === expected.table)
    const okay = found && found.unique === expected.unique && found.partial === expected.partial && found.columns.join() === expected.columns.join()
      && (!expected.definitionTokens || expected.definitionTokens.every((token) => normalizeExpression(found.definition)?.includes(normalizeExpression(token))))
    result(`index.${expected.name}`, okay, `Índice ${expected.name} conforme.`, found ? `El índice ${expected.name} difiere en unicidad, columnas o predicado.` : `Falta el índice ${expected.name}.`)
  }

  for (const expected of MANIFEST.columns.filter(active)) {
    const found = facts.columns.find((c) => c.table === expected.table && c.name === expected.name)
    const okay = found && found.type === expected.type && found.not_null === expected.notNull && (!expected.defaultTokens || expected.defaultTokens.every((t) => normalizeExpression(found.default)?.includes(normalizeExpression(t))))
    result(`column.${expected.table}.${expected.name}`, okay, `Columna ${expected.table}.${expected.name} conforme.`, found ? `La columna ${expected.table}.${expected.name} difiere en tipo, nulabilidad o valor por defecto.` : `Falta la columna ${expected.table}.${expected.name}.`)
  }

  for (const expected of MANIFEST.functions.filter(active)) {
    const found = facts.functions.find((f) => f.name === expected.name)
    const okay = found && found.language === expected.language && found.returns === expected.returns && found.args === expected.args && !found.security_definer === !expected.securityDefiner
      && same(found.config ?? [], [expected.searchPath]) && normalizeBody(found.body) === expected.body
      && (!expected.execute || (found.execute_authenticated === expected.execute.authenticated && found.execute_anon === expected.execute.anon))
    result(`function.${expected.name}`, okay, `Función biblib.${expected.name} conforme (plpgsql, search_path fijo, seguridad, permisos y semántica normalizada).`, found ? `La función biblib.${expected.name} difiere en lenguaje, retorno, seguridad, search_path, permisos de ejecución o semántica normalizada.` : `Falta la función biblib.${expected.name}.`)
  }

  for (const expected of MANIFEST.triggers.filter(active)) {
    const found = facts.triggers.find((t) => t.name === expected.name)
    const decoded = found ? decodeTrigger(found.tgtype) : null
    const okay = found && found.table === expected.table && found.function === expected.function && found.tgtype === expected.tgtype && decoded.timing === expected.timing && decoded.level === expected.level
      && same(decoded.events, expected.events) && found.enabled === "O" && !found.conditional && !String(found.columns ?? "").trim()
    result(`trigger.${expected.name}`, okay, `Trigger ${expected.name} conforme (${expected.timing} ${expected.events.join(" OR ")} FOR EACH ${expected.level} en biblib.${expected.table}).`, found ? `El trigger ${expected.name} difiere en momento, eventos, nivel, tabla, función o estado.` : `Falta el trigger ${expected.name} en biblib.${expected.table}.`)
  }
  const storage = facts.storage ?? { buckets: [], policies: [] }
  for (const expected of MANIFEST.storage.buckets.filter(active)) {
    const found = storage.buckets.find((b) => b.id === expected.id)
    const okay = found && found.public === expected.public && found.fileSizeLimit === expected.fileSizeLimit && same(found.allowedMimeTypes ?? [], expected.allowedMimeTypes)
    result(`storage.bucket.${expected.id}`, okay, `Bucket ${expected.id} privado, ${expected.allowedMimeTypes.join(",")} y ${expected.fileSizeLimit} bytes.`, found ? `El bucket ${expected.id} es público o admite otros tipos o tamaños.` : `Falta el bucket ${expected.id}.`)
  }
  const storagePolicies = MANIFEST.storage.policies.filter(active)
  for (const expected of storagePolicies) {
    const found = storage.policies.find((p) => p.name === expected.name)
    const cmd = { r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", "*": "ALL" }[found?.cmd]
    const okay = found && cmd === expected.cmd && found.permissive && same(found.roles, expected.roles) && normalizeExpression(found.using) === expected.using && normalizeExpression(found.check) === expected.check
    result(`storage.policy.${expected.name}`, okay, `Política ${expected.name} de storage.objects conforme.`, found ? `La política ${expected.name} de storage.objects difiere en comando, roles o expresión.` : `Falta la política ${expected.name} en storage.objects.`)
  }
  for (const extra of storage.policies.filter((p) => !storagePolicies.some((e) => e.name === p.name))) {
    result(`storage.policy.${extra.name}`, false, "", `Política no declarada ${extra.name} en storage.objects: podría ampliar el acceso a las portadas.`)
  }
  return checks
}

/** Lista pública y estable de objetos esperados tras aplicar todas las migraciones. */
export function expectedObjects(appliedTags = MANIFEST_MIGRATIONS) {
  const applied = new Set(appliedTags)
  const active = (item) => applied.has(item.since) && !(item.until && applied.has(item.until))
  return {
    rls: MANIFEST.tables.filter(active).map((t) => `biblib.${t.name}`),
    policies: MANIFEST.policies.filter(active).map((p) => `${p.table}.${p.name}:${p.cmd}:${p.roles.join(",")}`),
    grants: Object.entries(MANIFEST.grants).map(([role, tables]) => `${role}:${Object.entries(tables).map(([t, p]) => `${t}=${p.join("|") || "-"}`).join(";")}`),
    constraints: MANIFEST.constraints.filter(active).map((c) => c.name),
    indexes: MANIFEST.indexes.filter(active).map((i) => i.name),
    columns: MANIFEST.columns.filter(active).map((c) => `${c.table}.${c.name}`),
    functions: MANIFEST.functions.filter(active).map((f) => `biblib.${f.name}`),
    triggers: MANIFEST.triggers.filter(active).map((t) => `${t.name}:${t.timing} ${t.events.join(" OR ")} ${t.level}`),
    storage: [...MANIFEST.storage.buckets.filter(active).map((b) => `bucket:${b.id}`), ...MANIFEST.storage.policies.filter(active).map((p) => `policy:${p.name}:${p.cmd}`)],
  }
}

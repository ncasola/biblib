import { readFileSync } from "node:fs"
import { EXIT } from "../lib/exit-codes.mjs"

// Manifest de objetos deliberados de BibLib. Se comprueba con metadatos de pg_catalog e
// information_schema y con expresiones normalizadas, nunca comparando el pretty-print.
// `since`/`until` indican la migración que introduce o retira cada objeto.
const M0 = "0000_biblib_init", M1 = "0001_library_integrity", M2 = "0002_book_versions", M3 = "0003_library_revision", M4 = "0004_catalogue_coordination", M5 = "0005_library_jobs"
export const MANIFEST_MIGRATIONS = [M0, M1, M2, M3, M4, M5]

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
  return Object.fromEntries([...source.matchAll(/CREATE FUNCTION "biblib"\."(\w+)"\([^)]*\) RETURNS [\s\S]*?AS \$\$([\s\S]*?)\$\$;/g)].map(([, name, body]) => [name, normalizeBody(body)]))
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
const jobStateTokens = ["'queued'", "'running'", "'waiting_retry'", "'needs_review'", "'paused'", "'succeeded'", "'partially_succeeded'", "'failed'", "'cancelled'", "'expired'"]

export const MANIFEST = Object.freeze({
  tables: [{ name: "shelves", since: M0 }, { name: "books", since: M0 }, { name: "library_state", since: M3 }, { name: "import_previews", since: M3 }, { name: "library_operations", since: M3 }, ...catalogueTables.map((name) => ({ name, since: M4 })), ...jobTables.map((name) => ({ name, since: M5 }))],
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
  ],
  // library_state solo se lee: la revisión cambia por lock_library()/triggers, nunca por escritura directa.
  // La caché compartida, las consultas en vuelo y las cuotas no tienen ningún privilegio de cliente.
  grants: {
    authenticated: { shelves: ["DELETE", "INSERT", "SELECT", "UPDATE"], books: ["DELETE", "INSERT", "SELECT", "UPDATE"], library_state: ["SELECT"], import_previews: ["DELETE", "INSERT", "SELECT"], library_operations: ["INSERT", "SELECT"], catalogue_cache: [], catalogue_inflight: [], catalogue_quota_buckets: [], catalogue_quota_reservations: [], catalogue_private_cache: ["DELETE", "SELECT"], library_jobs: ["SELECT"], library_job_items: ["SELECT"], account_lifecycle: ["SELECT"] },
    anon: { shelves: [], books: [], library_state: [], import_previews: [], library_operations: [], ...Object.fromEntries([...catalogueTables, ...jobTables].map((name) => [name, []])) },
  },
  constraints: [
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
    { table: "library_jobs", name: "library_jobs_kind_check", type: "c", columns: ["kind"], tokens: ["'import'", "'covers'"], since: M5 },
    { table: "library_jobs", name: "library_jobs_state_check", type: "c", columns: ["state"], tokens: jobStateTokens, since: M5 },
    { table: "library_jobs", name: "library_jobs_phase_check", type: "c", columns: ["phase"], tokens: ["'publish'", "'covers'", "'done'"], since: M5 },
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
  ],
  indexes: [
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
  ],
  columns: [
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
  ],
  functions: [
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
    jobFunction("library_job_claim", "jsonb", 3),
    jobFunction("library_job_renew", "boolean", 4),
    jobFunction("library_job_fence", "uuid", 3),
  ],
  // tgtype: ROW(1) | BEFORE(2) | INSERT(4) | DELETE(8) | UPDATE(16). BEFORE INSERT OR UPDATE = 23; AFTER INSERT OR UPDATE OR DELETE = 29.
  triggers: [
    { table: "books", name: "books_rotate_version", function: "biblib.rotate_book_version", timing: "BEFORE", events: ["INSERT", "UPDATE"], level: "ROW", tgtype: 23, since: M2 },
    { table: "books", name: "books_rotate_library_revision", function: "biblib.rotate_library_revision", timing: "AFTER", events: ["INSERT", "UPDATE", "DELETE"], level: "ROW", tgtype: 29, since: M3 },
    { table: "shelves", name: "shelves_rotate_library_revision", function: "biblib.rotate_library_revision", timing: "AFTER", events: ["INSERT", "UPDATE", "DELETE"], level: "ROW", tgtype: 29, since: M3 },
  ],
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
    sql`select i.relname as name, c.relname as table, x.indisunique as unique, x.indpred is not null as partial,
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
  return {
    roles: roles.map((r) => r.rolname), prerequisites: prerequisites[0],
    tables: [...tables], policies: [...policies], grants: [...grants], schemaUsage: [...schemaUsage],
    constraints: [...constraints], indexes: [...indexes], columns: [...columns], functions: [...functions], triggers: [...triggers],
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

  for (const expected of MANIFEST.constraints) {
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
  }
}

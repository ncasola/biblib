import { getViewSelectedFields, sql } from "drizzle-orm"
import { authenticatedRole } from "drizzle-orm/supabase"
import { pgSchema, uuid, text, timestamp, boolean, integer, smallint, numeric, bigint, jsonb, uniqueIndex, index, check, pgPolicy, foreignKey, primaryKey, customType, type AnyPgColumn } from "drizzle-orm/pg-core"
import type { Author, Publisher, Book, CatalogueMetadata, CopyVerification, EditionCatalogue, EditionIdentifiers, LibraryData } from "@/lib/types"
import type { CopyRating, LocationKind, MediaAssetState, MediaKind } from "@/lib/product/contracts"
import type { ConfidenceLabel, EvidenceOrigin, EvidenceSourceKind, ReviewDecisionKind, ReviewEntityRef, ReviewReason, ReviewState } from "@/lib/review/contracts"
import type { CsvMapping, CsvRowIssue } from "@/lib/csv-import/contracts"
import type { ImportPlan, ImportOperationResult } from "@/lib/import-plan"
import type { PortableBackupV2 } from "@/lib/backup-v2"
import type { SavedViewFilters } from "@/lib/saved-views"

/**
 * `auth.users` de Supabase, solo como destino de las FK (no se exporta: Drizzle Kit no la genera).
 * Equivale a `authUsers` de `drizzle-orm/supabase`; se declara aquí para que las pruebas compiladas
 * con NodeNext (trabajos, U-DAT-03) no mezclen los tipos CJS y ESM de ese submódulo.
 */
const authUsers = pgSchema("auth").table("users", { id: uuid("id").primaryKey().notNull() })

export const biblibSchema = pgSchema("biblib")
const ownRow = (userIdColumn: AnyPgColumn) => sql`(select auth.uid() = ${userIdColumn})`

/*
 * U-OPS-03: con la cuenta en eliminación ninguna escritura de cliente pasa la RLS, tampoco con un JWT emitido antes
 * de revocar las sesiones. Políticas RESTRICTIVE (se suman a las del dueño) en cada tabla con privilegios de escritura
 * para `authenticated`; `biblib.account_write_allowed()` (0013) lanza BD001 y el cliente no puede cambiar su estado.
 */
type WriteCommand = "insert" | "update" | "delete"
const activeAccount = sql`(select biblib.account_write_allowed())`
const activeAccountPolicies = (name: string, commands: readonly WriteCommand[]) => commands.map((command) => pgPolicy(`${name}_${command}_active`, {
  as: "restrictive", for: command, to: authenticatedRole,
  ...(command === "insert" ? { withCheck: activeAccount } : command === "update" ? { using: activeAccount, withCheck: activeAccount } : { using: activeAccount }),
}))
const ALL_WRITES = ["insert", "update", "delete"] as const

/** Preferencias privadas independientes de la revisión de colección (U-EXP-02). */
export const savedBookViews = biblibSchema.table("saved_book_views", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  filters: jsonb("filters").$type<SavedViewFilters>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  version: uuid("version").notNull().defaultRandom(),
}, (table) => [
  uniqueIndex("saved_book_views_user_name_unique").on(table.userId, sql`lower(${table.name})`),
  index("saved_book_views_user_updated_idx").on(table.userId, table.updatedAt.desc().nullsFirst()),
  // Conjunción plana (0008): con `between … and … and` Postgres anidaba el AND y tras pg_dump quedaba
  // aplanado, de modo que db:restore:verify veía una restricción distinta del origen.
  check("saved_book_views_name_check", sql`length(btrim(${table.name})) >= 1 and length(btrim(${table.name})) <= 80 and ${table.name} = btrim(${table.name})`),
  check("saved_book_views_filters_check", sql`biblib.saved_view_filters_valid(${table.filters})`),
  pgPolicy("saved_book_views_select_own", { for: "select", to: authenticatedRole, using: ownRow(table.userId) }),
  pgPolicy("saved_book_views_insert_own", { for: "insert", to: authenticatedRole, withCheck: ownRow(table.userId) }),
  pgPolicy("saved_book_views_update_own", { for: "update", to: authenticatedRole, using: ownRow(table.userId), withCheck: ownRow(table.userId) }),
  pgPolicy("saved_book_views_delete_own", { for: "delete", to: authenticatedRole, using: ownRow(table.userId) }),
  ...activeAccountPolicies("saved_book_views", ALL_WRITES),
]).enableRLS()

export const shelves = biblibSchema.table(
  "shelves",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("shelves_user_id_title_unique").on(table.userId, table.title),
    uniqueIndex("shelves_user_id_id_unique").on(table.userId, table.id),
    check("shelves_title_check", sql`length(btrim(${table.title})) between 1 and 120`),
    uniqueIndex("shelves_user_id_default_unique")
      .on(table.userId, table.isDefault)
      .where(sql`${table.isDefault} = true`),
    pgPolicy("shelves_select_own", {
      for: "select",
      to: authenticatedRole,
      using: ownRow(table.userId),
    }),
    pgPolicy("shelves_insert_own", {
      for: "insert",
      to: authenticatedRole,
      withCheck: ownRow(table.userId),
    }),
    pgPolicy("shelves_update_own", {
      for: "update",
      to: authenticatedRole,
      using: sql`${ownRow(table.userId)} and not ${table.isDefault}`,
      withCheck: sql`${ownRow(table.userId)} and not ${table.isDefault}`,
    }),
    pgPolicy("shelves_delete_own", {
      for: "delete",
      to: authenticatedRole,
      using: sql`${ownRow(table.userId)} and not ${table.isDefault}`,
    }),
    ...activeAccountPolicies("shelves", ALL_WRITES),
  ],
).enableRLS()

/**
 * Tabla `books` anterior a U-DAT-06, congelada por 0011 como `books_legacy`: nadie la escribe ni la lee la
 * aplicación, sin políticas ni privilegios de cliente y sin FK a estanterías ni portadas (no bloquea su
 * borrado). Se conserva durante la ventana de retirada de F4 como punto de comparación del backfill
 * (`biblib.model_compare`); su retirada es un DROP TABLE en una migración de F4 (docs/operacion.md).
 */
export const booksLegacy = biblibSchema.table(
  "books_legacy",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    version: uuid("version").notNull().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    isbn: text("isbn").notNull(),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    authors: jsonb("authors").$type<Author[]>().notNull().default([]),
    publishers: jsonb("publishers").$type<Publisher[]>().notNull().default([]),
    catalogue: jsonb("catalogue").$type<CatalogueMetadata>().notNull().default({ source: "import", isbnVerified: false }),
    numberOfPages: integer("number_of_pages").notNull().default(0),
    publishDate: text("publish_date").notNull().default(""),
    coverSmall: text("cover_small").notNull().default("/default-book-cover.webp"),
    coverMedium: text("cover_medium").notNull().default("/default-book-cover.webp"),
    coverLarge: text("cover_large").notNull().default("/default-book-cover.webp"),
    status: text("status").$type<Book["status"]>().notNull().default("unread"),
    shelfId: uuid("shelf_id")
      .notNull(),
    coverAssetId: uuid("cover_asset_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("books_user_id_isbn_unique").on(table.userId, table.isbn),
    uniqueIndex("books_user_id_id_unique").on(table.userId, table.id),
    check("books_status_check", sql`${table.status} in ('read', 'reading', 'unread', 'to-read')`),
    check("books_pages_check", sql`${table.numberOfPages} between 0 and 100000`),
    check("books_title_check", sql`length(btrim(${table.title})) between 1 and 500`),
  ],
).enableRLS()

/*
 * Obra, edición y ejemplar (U-DAT-06). Todo privado por cuenta: cada FK incluye al propietario y RLS
 * limita las filas a `auth.uid()`. La descripción bibliográfica, la portada (URL y asset privado) y el
 * ISBN-13 opcional pertenecen a la edición; estado, estantería, comprobación física e identificador
 * legacy, al ejemplar. Una obra solo existe con evidencia explícita (archivo v2 o una decisión de la
 * persona): la migración no la deduce de títulos parecidos.
 */
// `user_id = (select auth.uid())`: el uid se evalúa una vez (InitPlan) y no por fila, en las tablas que crecen con la colección.
const ownCopyRow = (userIdColumn: AnyPgColumn) => sql`${userIdColumn} = (select auth.uid())`
const ownPolicies = (name: string, userIdColumn: AnyPgColumn) => [
  pgPolicy(`${name}_select_own`, { for: "select", to: authenticatedRole, using: ownCopyRow(userIdColumn) }),
  pgPolicy(`${name}_insert_own`, { for: "insert", to: authenticatedRole, withCheck: ownCopyRow(userIdColumn) }),
  pgPolicy(`${name}_update_own`, { for: "update", to: authenticatedRole, using: ownCopyRow(userIdColumn), withCheck: ownCopyRow(userIdColumn) }),
  pgPolicy(`${name}_delete_own`, { for: "delete", to: authenticatedRole, using: ownCopyRow(userIdColumn) }),
  ...activeAccountPolicies(name, ALL_WRITES),
]

export const works = biblibSchema.table("works", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  version: uuid("version").notNull().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("works_user_id_id_unique").on(table.userId, table.id),
  check("works_title_check", sql`length(btrim(${table.title})) between 1 and 500`),
  ...ownPolicies("works", table.userId),
]).enableRLS()

export const editions = biblibSchema.table("editions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  workId: uuid("work_id"),
  // ISBN-13 canónico o nulo; un identificador manual nunca ocupa este campo.
  isbn13: text("isbn13"),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  authors: jsonb("authors").$type<Author[]>().notNull().default([]),
  publishers: jsonb("publishers").$type<Publisher[]>().notNull().default([]),
  publishDate: text("publish_date").notNull().default(""),
  numberOfPages: integer("number_of_pages").notNull().default(0),
  language: text("language"),
  identifiers: jsonb("identifiers").$type<EditionIdentifiers>().notNull().default({}),
  catalogue: jsonb("catalogue").$type<EditionCatalogue>().notNull().default({ source: "import" }),
  coverSmall: text("cover_small").notNull().default("/default-book-cover.webp"),
  coverMedium: text("cover_medium").notNull().default("/default-book-cover.webp"),
  coverLarge: text("cover_large").notNull().default("/default-book-cover.webp"),
  // Portada privada validada (U-DAT-10) de la edición. Una foto de un ejemplar concreto queda para F3.
  coverAssetId: uuid("cover_asset_id"),
  // Texto de búsqueda local (tarea T5): la misma expresión que filtraba `books`, calculada al escribir.
  searchText: text("search_text").generatedAlwaysAs(sql`translate(lower(title || ' ' || coalesce(subtitle, '') || ' ' || authors::text || ' ' || coalesce(isbn13, '')), 'áéíóúüñ', 'aeiouun')`),
  version: uuid("version").notNull().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("editions_user_id_id_unique").on(table.userId, table.id),
  // T7: «¿ya tengo este ISBN?» es una igualdad indexada; varias copias comparten la edición canónica.
  uniqueIndex("editions_user_isbn13_unique").on(table.userId, table.isbn13).where(sql`${table.isbn13} is not null`),
  index("editions_user_title_idx").on(table.userId, table.title, table.id),
  index("editions_user_work_idx").on(table.userId, table.workId).where(sql`${table.workId} is not null`),
  index("editions_cover_asset_idx").on(table.userId, table.coverAssetId).where(sql`${table.coverAssetId} is not null`),
  foreignKey({ name: "editions_owner_work_fk", columns: [table.userId, table.workId], foreignColumns: [works.userId, works.id] }).onDelete("set null"),
  foreignKey({ name: "editions_owner_cover_asset_fk", columns: [table.userId, table.coverAssetId], foreignColumns: [coverAssets.userId, coverAssets.id] }),
  check("editions_isbn13_check", sql`${table.isbn13} is null or biblib.isbn13_normalize(${table.isbn13}) is not distinct from ${table.isbn13}`),
  check("editions_title_check", sql`length(btrim(${table.title})) between 1 and 500`),
  check("editions_pages_check", sql`${table.numberOfPages} between 0 and 100000`),
  check("editions_language_check", sql`${table.language} is null or ${table.language} ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'`),
  check("editions_identifiers_check", sql`jsonb_typeof(${table.identifiers}) = 'object'`),
  // La comprobación física nunca vive en la edición compartida.
  check("editions_catalogue_check", sql`jsonb_typeof(${table.catalogue}) = 'object' and not ${table.catalogue} ? 'isbnVerified'`),
  ...ownPolicies("editions", table.userId),
]).enableRLS()

export const copies = biblibSchema.table("copies", {
  // Conserva el `books.id` legacy: las rutas /book/[id] siguen apuntando al ejemplar.
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  editionId: uuid("edition_id").notNull(),
  status: text("status").$type<Book["status"]>().notNull().default("unread"),
  shelfId: uuid("shelf_id").notNull(),
  editionVerification: jsonb("edition_verification").$type<CopyVerification>().notNull().default({ isbnVerified: false }),
  legacyIdentifier: text("legacy_identifier"),
  version: uuid("version").notNull().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("copies_user_id_id_unique").on(table.userId, table.id),
  uniqueIndex("copies_user_legacy_identifier_unique").on(table.userId, table.legacyIdentifier).where(sql`${table.legacyIdentifier} is not null`),
  index("copies_user_edition_idx").on(table.userId, table.editionId),
  index("copies_user_shelf_idx").on(table.userId, table.shelfId),
  index("copies_user_created_idx").on(table.userId, table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
  foreignKey({ name: "copies_owner_edition_fk", columns: [table.userId, table.editionId], foreignColumns: [editions.userId, editions.id] }).onDelete("restrict"),
  foreignKey({ name: "copies_owner_shelf_fk", columns: [table.userId, table.shelfId], foreignColumns: [shelves.userId, shelves.id] }).onDelete("restrict"),
  check("copies_status_check", sql`${table.status} in ('read', 'reading', 'unread', 'to-read')`),
  check("copies_verification_check", sql`jsonb_typeof(${table.editionVerification}) = 'object' and jsonb_typeof(${table.editionVerification}->'isbnVerified') = 'boolean'`),
  check("copies_legacy_identifier_check", sql`${table.legacyIdentifier} is null or length(btrim(${table.legacyIdentifier})) between 1 and 100`),
  ...ownPolicies("copies", table.userId),
]).enableRLS()

/**
 * Modelo de lectura plano (U-DAT-06): la vista `biblib.books` de 0011, un ejemplar con su edición y su obra,
 * con las columnas de la tabla legacy más las del modelo. `security_invoker`: aplica RLS de las tablas a
 * quien consulta. `version` es el token plano (cambia con el ejemplar o con la edición); `isbn`, el ISBN-13
 * de la edición o el identificador legacy del ejemplar. La aplicación solo la lee: escribe en `copies`,
 * `editions` y `works`. Sus triggers INSTEAD OF mantienen compatibles los scripts SQL que escribían `books`.
 */
export const books = biblibSchema.view("books", {
  id: uuid("id").notNull(),
  version: uuid("version").notNull(),
  userId: uuid("user_id").notNull(),
  isbn: text("isbn"),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  authors: jsonb("authors").$type<Author[]>().notNull(),
  publishers: jsonb("publishers").$type<Publisher[]>().notNull(),
  catalogue: jsonb("catalogue").$type<CatalogueMetadata>().notNull(),
  numberOfPages: integer("number_of_pages").notNull(),
  publishDate: text("publish_date").notNull(),
  coverSmall: text("cover_small").notNull(),
  coverMedium: text("cover_medium").notNull(),
  coverLarge: text("cover_large").notNull(),
  status: text("status").$type<Book["status"]>().notNull(),
  shelfId: uuid("shelf_id").notNull(),
  coverAssetId: uuid("cover_asset_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  editionId: uuid("edition_id").notNull(),
  copyVersion: uuid("copy_version").notNull(),
  editionVersion: uuid("edition_version").notNull(),
  isbn13: text("isbn13"),
  legacyIdentifier: text("legacy_identifier"),
  editionVerification: jsonb("edition_verification").$type<CopyVerification>().notNull(),
  workId: uuid("work_id"),
  workTitle: text("work_title"),
  language: text("language"),
  identifiers: jsonb("identifiers").$type<EditionIdentifiers>().notNull(),
  searchText: text("search_text"),
  editionCopies: integer("edition_copies").notNull(),
  editionCatalogue: jsonb("edition_catalogue").$type<EditionCatalogue>().notNull(),
}).existing()

const viewFields = getViewSelectedFields(books)
/**
 * Columnas que la aplicación lee de la vista (`select({ book: bookFields, … })`): sin el recuento de ejemplares
 * de la edición (subconsulta por fila; lo pide aparte la ficha), sin el texto de búsqueda y con la procedencia de
 * la edición en lugar de la plana (que se recompone en el mapper sin calcularla en Postgres para cada fila).
 */
export const bookFields = {
  id: viewFields.id, version: viewFields.version, userId: viewFields.userId, title: viewFields.title, subtitle: viewFields.subtitle,
  authors: viewFields.authors, publishers: viewFields.publishers, numberOfPages: viewFields.numberOfPages, publishDate: viewFields.publishDate,
  coverSmall: viewFields.coverSmall, coverMedium: viewFields.coverMedium, coverLarge: viewFields.coverLarge, status: viewFields.status, shelfId: viewFields.shelfId,
  coverAssetId: viewFields.coverAssetId, createdAt: viewFields.createdAt, updatedAt: viewFields.updatedAt, editionId: viewFields.editionId,
  copyVersion: viewFields.copyVersion, editionVersion: viewFields.editionVersion, isbn13: viewFields.isbn13, legacyIdentifier: viewFields.legacyIdentifier,
  editionVerification: viewFields.editionVerification, workId: viewFields.workId, workTitle: viewFields.workTitle, language: viewFields.language,
  identifiers: viewFields.identifiers, editionCatalogue: viewFields.editionCatalogue,
}

export type ModelMigrationReportKind = "summary" | "normalized" | "invalid" | "conflict" | "grouped"

/**
 * Informe privado del backfill y la comparación del modelo (0010/0011): un resumen por cuenta y las
 * fichas que cambiaron de forma (ISBN normalizado, identificador no válido, equivalencias ISBN-10/13
 * en conflicto o agrupadas). El dueño solo lo lee; lo escriben las migraciones.
 */
export const modelMigrationReport = biblibSchema.table("model_migration_report", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  migration: text("migration").notNull(),
  kind: text("kind").$type<ModelMigrationReportKind>().notNull(),
  copyId: uuid("copy_id"),
  otherCopyId: uuid("other_copy_id"),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("model_migration_report_user_idx").on(table.userId, table.migration, table.kind),
  check("model_migration_report_kind_check", sql`${table.kind} in ('summary', 'normalized', 'invalid', 'conflict', 'grouped')`),
  check("model_migration_report_details_check", sql`jsonb_typeof(${table.details}) = 'object'`),
  pgPolicy("model_migration_report_select_own", { for: "select", to: authenticatedRole, using: ownCopyRow(table.userId) }),
]).enableRLS()

const xid8 = customType<{ data: string; driverData: string }>({ dataType: () => "xid8" })

/**
 * Revisión de la colección (U-DAT-01). Solo cambia por el protocolo: la función
 * `biblib.lock_library()` la bloquea y los triggers `*_rotate_library_revision` de
 * `books`/`shelves` la rotan una vez por transacción. `authenticated` solo puede leer su fila.
 */
export const libraryState = biblibSchema.table(
  "library_state",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    revision: uuid("revision").notNull().defaultRandom(),
    // Transacción que rotó la revisión por última vez; evita rotarla en cada fila de un lote.
    rotatedXact: xid8("rotated_xact"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    pgPolicy("library_state_select_own", {
      for: "select",
      to: authenticatedRole,
      using: ownRow(table.userId),
    }),
  ],
).enableRLS()

/**
 * Vista previa servidor de una importación: entrada validada, plan privado y revisión revisada.
 * La de una restauración (U-DAT-02) no copia el contenido: apunta a la versión anterior propia, y
 * borrar esa versión borra también sus vistas previas.
 */
export const importPreviews = biblibSchema.table(
  "import_previews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    revision: uuid("revision").notNull(),
    inputDigest: text("input_digest").notNull(),
    mode: text("mode").$type<"merge" | "replace">().notNull(),
    rulesVersion: integer("rules_version").notNull(),
    plan: jsonb("plan").$type<ImportPlan>().notNull(),
    /** Colección leída. Desde U-DAT-06 se guarda el payload v2; las vistas previas anteriores (forma plana) caducan con las reglas. */
    payload: jsonb("payload").$type<LibraryData | PortableBackupV2>(),
    snapshotId: uuid("snapshot_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("import_previews_user_id_id_unique").on(table.userId, table.id),
    index("import_previews_user_id_expires_at_idx").on(table.userId, table.expiresAt),
    index("import_previews_snapshot_id_idx").on(table.userId, table.snapshotId).where(sql`${table.snapshotId} is not null`),
    check("import_previews_mode_check", sql`${table.mode} in ('merge', 'replace')`),
    check("import_previews_digest_check", sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
    // Un archivo importado o una versión anterior propia, nunca las dos cosas ni ninguna.
    check("import_previews_source_check", sql`(${table.payload} is null) <> (${table.snapshotId} is null)`),
    foreignKey({ name: "import_previews_owner_snapshot_fk", columns: [table.userId, table.snapshotId], foreignColumns: [librarySnapshots.userId, librarySnapshots.id] }).onDelete("cascade"),
    pgPolicy("import_previews_select_own", {
      for: "select",
      to: authenticatedRole,
      using: ownRow(table.userId),
    }),
    pgPolicy("import_previews_insert_own", {
      for: "insert",
      to: authenticatedRole,
      withCheck: ownRow(table.userId),
    }),
    pgPolicy("import_previews_delete_own", {
      for: "delete",
      to: authenticatedRole,
      using: ownRow(table.userId),
    }),
    ...activeAccountPolicies("import_previews", ["insert", "delete"]),
  ],
).enableRLS()

/**
 * Operaciones idempotentes por (propietario, operación, clave). U-DAT-06 añade las del modelo: crear un
 * ejemplar o una edición, cambiar una edición y fusionar ediciones; su resultado durable es el de la acción.
 */
export type LibraryOperationKind = "import.confirm" | "snapshot.restore" | "restore.commit" | "copy.create" | "edition.create" | "edition.update" | "edition.merge"

/** Resultado durable e idempotente por (propietario, operación, clave). Sin UPDATE ni DELETE para `authenticated`. */
export const libraryOperations = biblibSchema.table(
  "library_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    operation: text("operation").$type<LibraryOperationKind>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputDigest: text("input_digest").notNull(),
    previewId: uuid("preview_id"),
    status: text("status").$type<"committed">().notNull(),
    result: jsonb("result").$type<ImportOperationResult | Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("library_operations_key_unique").on(table.userId, table.operation, table.idempotencyKey),
    uniqueIndex("library_operations_preview_unique").on(table.userId, table.previewId).where(sql`${table.previewId} is not null`),
    // Destino de la FK con propietario de las versiones anteriores (U-DAT-02).
    uniqueIndex("library_operations_user_id_id_unique").on(table.userId, table.id),
    check("library_operations_operation_check", sql`${table.operation} in ('import.confirm', 'snapshot.restore', 'restore.commit', 'copy.create', 'edition.create', 'edition.update', 'edition.merge')`),
    check("library_operations_status_check", sql`${table.status} in ('committed')`),
    check("library_operations_key_check", sql`length(${table.idempotencyKey}) between 16 and 128`),
    check("library_operations_digest_check", sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
    pgPolicy("library_operations_select_own", {
      for: "select",
      to: authenticatedRole,
      using: ownRow(table.userId),
    }),
    pgPolicy("library_operations_insert_own", {
      for: "insert",
      to: authenticatedRole,
      withCheck: ownRow(table.userId),
    }),
    ...activeAccountPolicies("library_operations", ["insert"]),
  ],
).enableRLS()

/*
 * Coordinación del catálogo bibliográfico (U-DAT-05). Tablas internas sin acceso directo de
 * `authenticated`/`anon`: solo las funciones `biblib.catalogue_*` (SECURITY DEFINER, search_path
 * fijo y sin EXECUTE para roles de cliente) las leen o escriben desde el servidor. Las filas
 * compartidas no contienen propietarios ni consultas privadas.
 */
const catalogueProviders = sql`('open-library', 'bne', 'google-books')`

/** Testigo de fencing común: cada concesión en vuelo o de cuota recibe un valor creciente. */
export const catalogueFenceSeq = biblibSchema.sequence("catalogue_fence_seq")

/** Caché compartida de metadatos públicos. Nunca guarda una caída como ausencia. */
export const catalogueCache = biblibSchema.table(
  "catalogue_cache",
  {
    provider: text("provider").notNull(),
    policyVersion: text("policy_version").notNull(),
    credentialScope: text("credential_scope").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    operation: text("operation").notNull(),
    canonicalKey: text("canonical_key").notNull(),
    status: text("status").$type<"found" | "notFound">().notNull(),
    payload: jsonb("payload").$type<unknown[]>().notNull(),
    provenance: jsonb("provenance").$type<Record<string, string>>().notNull().default({}),
    fence: bigint("fence", { mode: "bigint" }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ name: "catalogue_cache_pkey", columns: [table.provider, table.policyVersion, table.credentialScope, table.schemaVersion, table.operation, table.canonicalKey] }),
    index("catalogue_cache_expires_at_idx").on(table.expiresAt),
    check("catalogue_cache_provider_check", sql`${table.provider} in ${catalogueProviders}`),
    check("catalogue_cache_operation_check", sql`${table.operation} in ('lookupISBN', 'resolveEditions', 'getCover')`),
    check("catalogue_cache_status_check", sql`${table.status} in ('found', 'notFound')`),
    check("catalogue_cache_key_check", sql`length(${table.canonicalKey}) between 1 and 200`),
    check("catalogue_cache_payload_check", sql`jsonb_typeof(${table.payload}) = 'array'`),
    check("catalogue_cache_expiry_check", sql`${table.expiresAt} > ${table.fetchedAt}`),
  ],
).enableRLS()

/** Consulta en vuelo por clave: un único trabajador la resuelve mientras dure su concesión. */
export const catalogueInflight = biblibSchema.table(
  "catalogue_inflight",
  {
    provider: text("provider").notNull(),
    policyVersion: text("policy_version").notNull(),
    credentialScope: text("credential_scope").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    operation: text("operation").notNull(),
    canonicalKey: text("canonical_key").notNull(),
    fence: bigint("fence", { mode: "bigint" }).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "catalogue_inflight_pkey", columns: [table.provider, table.policyVersion, table.credentialScope, table.schemaVersion, table.operation, table.canonicalKey] }),
    uniqueIndex("catalogue_inflight_fence_unique").on(table.fence),
    check("catalogue_inflight_provider_check", sql`${table.provider} in ${catalogueProviders}`),
  ],
).enableRLS()

/** Ritmo compartido por proveedor y ámbito de credencial (despliegue), con cooldown tras 429. */
export const catalogueQuotaBuckets = biblibSchema.table(
  "catalogue_quota_buckets",
  {
    provider: text("provider").notNull(),
    credentialScope: text("credential_scope").notNull(),
    intervalMs: integer("interval_ms").notNull(),
    nextSlotAt: timestamp("next_slot_at", { withTimezone: true }).notNull(),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "catalogue_quota_buckets_pkey", columns: [table.provider, table.credentialScope] }),
    check("catalogue_quota_buckets_provider_check", sql`${table.provider} in ${catalogueProviders}`),
    check("catalogue_quota_buckets_interval_check", sql`${table.intervalMs} between 1 and 3600000`),
  ],
).enableRLS()

/** Reserva de una petición externa por dueño (o trabajador sin dueño), con caducidad y fencing. */
export const catalogueQuotaReservations = biblibSchema.table(
  "catalogue_quota_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    credentialScope: text("credential_scope").notNull(),
    ownerId: uuid("owner_id").references(() => authUsers.id, { onDelete: "cascade" }),
    purpose: text("purpose").$type<"interactive" | "batch">().notNull(),
    fence: bigint("fence", { mode: "bigint" }).notNull(),
    slotAt: timestamp("slot_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ name: "catalogue_quota_reservations_bucket_fk", columns: [table.provider, table.credentialScope], foreignColumns: [catalogueQuotaBuckets.provider, catalogueQuotaBuckets.credentialScope] }).onDelete("cascade"),
    uniqueIndex("catalogue_quota_reservations_fence_unique").on(table.fence),
    index("catalogue_quota_reservations_active_idx").on(table.provider, table.credentialScope, table.ownerId, table.purpose).where(sql`${table.releasedAt} is null`),
    index("catalogue_quota_reservations_expires_at_idx").on(table.provider, table.credentialScope, table.expiresAt),
    check("catalogue_quota_reservations_purpose_check", sql`${table.purpose} in ('interactive', 'batch')`),
    check("catalogue_quota_reservations_expiry_check", sql`${table.expiresAt} > ${table.slotAt}`),
  ],
).enableRLS()

/**
 * Caché privada de búsquedas de texto: por dueño y con la consulta reducida a un HMAC. El dueño
 * puede leer y purgar sus filas; las escrituras solo ocurren por función desde el servidor.
 */
export const cataloguePrivateCache = biblibSchema.table(
  "catalogue_private_cache",
  {
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    policyVersion: text("policy_version").notNull(),
    credentialScope: text("credential_scope").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    operation: text("operation").notNull(),
    keyHmac: text("key_hmac").notNull(),
    status: text("status").$type<"found" | "notFound">().notNull(),
    payload: jsonb("payload").$type<unknown[]>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ name: "catalogue_private_cache_pkey", columns: [table.ownerId, table.provider, table.policyVersion, table.credentialScope, table.schemaVersion, table.operation, table.keyHmac] }),
    index("catalogue_private_cache_expires_at_idx").on(table.ownerId, table.expiresAt),
    check("catalogue_private_cache_provider_check", sql`${table.provider} in ${catalogueProviders}`),
    check("catalogue_private_cache_operation_check", sql`${table.operation} in ('searchTitleAuthor')`),
    check("catalogue_private_cache_status_check", sql`${table.status} in ('found', 'notFound')`),
    check("catalogue_private_cache_key_check", sql`${table.keyHmac} ~ '^[0-9a-f]{64}$'`),
    check("catalogue_private_cache_payload_check", sql`jsonb_typeof(${table.payload}) = 'array'`),
    check("catalogue_private_cache_expiry_check", sql`${table.expiresAt} > ${table.fetchedAt}`),
    pgPolicy("catalogue_private_cache_select_own", {
      for: "select",
      to: authenticatedRole,
      using: ownRow(table.ownerId),
    }),
    pgPolicy("catalogue_private_cache_delete_own", {
      for: "delete",
      to: authenticatedRole,
      using: ownRow(table.ownerId),
    }),
    ...activeAccountPolicies("catalogue_private_cache", ["delete"]),
  ],
).enableRLS()

/*
 * Trabajos persistentes de importación y portadas (U-DAT-03). `authenticated` solo lee sus filas;
 * crear y controlar un trabajo pasa por `biblib.library_job_create`/`library_job_control` (dueño de
 * `auth.uid()`), y reclamar, renovar y cercar el lease solo lo hace el ejecutor del servidor con las
 * funciones `library_job_claim`/`renew`/`fence`, sin EXECUTE para roles de cliente.
 */
const jobStates = sql`('queued', 'running', 'waiting_retry', 'needs_review', 'paused', 'succeeded', 'partially_succeeded', 'failed', 'cancelled', 'expired')`

/** Testigo de fencing: cada reclamación recibe un número mayor que cualquier anterior. */
export const libraryJobFenceSeq = biblibSchema.sequence("library_job_fence_seq")

/**
 * Ciclo de vida mínimo de la cuenta: sin fila equivale a activa. Un estado `blocked` impide que un
 * trabajador escriba en su nombre; lo revalida cada transacción del ejecutor. `deleting` (U-OPS-03) lo
 * fija solo la solicitud de eliminación: además bloquea toda escritura de cliente y nadie lo revierte.
 */
export const accountLifecycle = biblibSchema.table(
  "account_lifecycle",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    state: text("state").$type<"active" | "blocked" | "deleting">().notNull().default("active"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("account_lifecycle_state_check", sql`${table.state} in ('active', 'blocked', 'deleting')`),
    pgPolicy("account_lifecycle_select_own", {
      for: "select",
      to: authenticatedRole,
      using: ownRow(table.userId),
    }),
  ],
).enableRLS()

/*
 * Eliminación de cuenta (U-OPS-03). Una fila por cuenta: la solicitud idempotente, el paso en curso del worker
 * administrativo (lease y fencing como los trabajos) y, al terminar, la marca técnica mínima de supresión: sin FK a
 * `auth.users` (sobrevive a la identidad) ni contenido bibliográfico, para filtrar la cuenta al restaurar un respaldo
 * anterior. Sin privilegios de cliente: el dueño solicita y consulta por `account_deletion_request`/`_status`; el
 * resto de funciones solo las ejecuta el proceso administrativo. Plazo de la marca: `purge_after` (docs/retencion.md).
 */
export type AccountDeletionState = "pending" | "running" | "waiting_retry" | "failed" | "completed"
export type AccountDeletionStep = "sessions" | "storage" | "covers" | "snapshots" | "staging" | "jobs" | "views" | "previews" | "operations"
  | "private_cache" | "product" | "media" | "copies" | "editions" | "works" | "shelves" | "state" | "auth" | "verify" | "done"
const deletionStates = sql`('pending', 'running', 'waiting_retry', 'failed', 'completed')`
// 0014 (O13): `product` (datos de producto, hijas antes que padres) y `media` (assets privados) antes de los ejemplares.
const deletionSteps = sql`('sessions', 'storage', 'covers', 'snapshots', 'staging', 'jobs', 'views', 'previews', 'operations', 'private_cache', 'product', 'media', 'copies', 'editions', 'works', 'shelves', 'state', 'auth', 'verify', 'done')`

export const accountDeletions = biblibSchema.table("account_deletions", {
  userId: uuid("user_id").primaryKey(),
  state: text("state").$type<AccountDeletionState>().notNull().default("pending"),
  step: text("step").$type<AccountDeletionStep>().notNull().default("sessions"),
  operationKey: text("operation_key").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  fencingNumber: bigint("fencing_number", { mode: "bigint" }).notNull().default(sql`0`),
  // Código técnico del último fallo (sin detalles ni rutas); solo lo ve la operación.
  errorCode: text("error_code"),
  // Filas y objetos retirados por paso mientras dura; se vacía al terminar.
  counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  purgeAfter: timestamp("purge_after", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("account_deletions_due_idx").on(table.nextAttemptAt).where(sql`${table.state} in ('pending', 'running', 'waiting_retry')`),
  index("account_deletions_purge_idx").on(table.purgeAfter).where(sql`${table.state} = 'completed'`),
  check("account_deletions_state_check", sql`${table.state} in ${deletionStates}`),
  check("account_deletions_step_check", sql`${table.step} in ${deletionSteps}`),
  check("account_deletions_key_check", sql`length(${table.operationKey}) between 16 and 128`),
  check("account_deletions_error_check", sql`${table.errorCode} is null or ${table.errorCode} ~ '^[A-Z_]{1,64}$'`),
  check("account_deletions_counts_check", sql`jsonb_typeof(${table.counts}) = 'object'`),
  check("account_deletions_attempts_check", sql`${table.attempts} >= 0 and ${table.fencingNumber} >= 0`),
  // En ejecución siempre hay testigo de lease; un restore puede vencer su plazo (lease_until nulo) sin soltarlo.
  check("account_deletions_lease_check", sql`${table.state} <> 'running' or ${table.leaseToken} is not null`),
  // Terminada si y solo si tiene fecha de fin, plazo de la marca y ningún paso pendiente.
  check("account_deletions_completed_check", sql`(${table.state} = 'completed') = (${table.completedAt} is not null and ${table.purgeAfter} is not null and ${table.step} = 'done')`),
]).enableRLS()

export const libraryJobs = biblibSchema.table(
  "library_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"import" | "covers" | "cover_asset">().notNull(),
    contractVersion: integer("contract_version").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull(),
    inputDigest: text("input_digest").notNull(),
    previewId: uuid("preview_id"),
    expectedRevision: uuid("expected_revision"),
    state: text("state").notNull().default("queued"),
    phase: text("phase").notNull(),
    // Último elemento tratado: el siguiente paso continúa a partir de él.
    cursor: text("cursor"),
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
    result: jsonb("result").$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    fencingNumber: bigint("fencing_number", { mode: "bigint" }).notNull().default(sql`0`),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    version: uuid("version").notNull().defaultRandom(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("library_jobs_key_unique").on(table.userId, table.kind, table.idempotencyKey),
    uniqueIndex("library_jobs_user_id_id_unique").on(table.userId, table.id),
    index("library_jobs_user_id_created_at_idx").on(table.userId, table.createdAt),
    index("library_jobs_due_idx").on(table.nextAttemptAt).where(sql`${table.state} in ('queued', 'running', 'waiting_retry')`),
    check("library_jobs_kind_check", sql`${table.kind} in ('import', 'covers', 'cover_asset')`),
    check("library_jobs_state_check", sql`${table.state} in ${jobStates}`),
    check("library_jobs_phase_check", sql`${table.phase} in ('publish', 'covers', 'asset', 'done')`),
    check("library_jobs_key_check", sql`length(${table.idempotencyKey}) between 16 and 128`),
    check("library_jobs_digest_check", sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
    check("library_jobs_import_check", sql`${table.kind} <> 'import' or (${table.previewId} is not null and ${table.expectedRevision} is not null)`),
    // Un trabajo en ejecución siempre tiene lease; fuera de ejecución nunca lo conserva.
    check("library_jobs_lease_check", sql`(${table.state} = 'running') = (${table.leaseToken} is not null and ${table.leaseUntil} is not null)`),
    check("library_jobs_counts_check", sql`jsonb_typeof(${table.counts}) = 'object'`),
    check("library_jobs_attempts_check", sql`${table.attempts} >= 0 and ${table.fencingNumber} >= 0`),
    pgPolicy("library_jobs_select_own", {
      for: "select",
      to: authenticatedRole,
      using: ownRow(table.userId),
    }),
  ],
).enableRLS()

/** Elemento de un trabajo: único por (trabajo, clave, fase), con versión de destino y resultado durable. */
export const libraryJobItems = biblibSchema.table(
  "library_job_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id").notNull(),
    userId: uuid("user_id").notNull(),
    itemKey: text("item_key").notNull(),
    phase: text("phase").notNull(),
    state: text("state").notNull().default("pending"),
    // Versión del libro al crear el elemento: un cambio manual posterior hace que se omita.
    targetVersion: uuid("target_version"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    fencingNumber: bigint("fencing_number", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ name: "library_job_items_owner_job_fk", columns: [table.userId, table.jobId], foreignColumns: [libraryJobs.userId, libraryJobs.id] }).onDelete("cascade"),
    uniqueIndex("library_job_items_job_item_phase_unique").on(table.jobId, table.itemKey, table.phase),
    index("library_job_items_due_idx").on(table.jobId, table.state, table.nextAttemptAt),
    check("library_job_items_phase_check", sql`${table.phase} in ('covers')`),
    check("library_job_items_state_check", sql`${table.state} in ('pending', 'waiting_retry', 'succeeded', 'not_found', 'skipped', 'failed')`),
    check("library_job_items_key_check", sql`length(${table.itemKey}) between 1 and 200`),
    check("library_job_items_attempts_check", sql`${table.attempts} >= 0`),
    pgPolicy("library_job_items_select_own", {
      for: "select",
      to: authenticatedRole,
      using: ownRow(table.userId),
    }),
  ],
).enableRLS()

/*
 * Versiones anteriores de la colección (U-DAT-02). Cada operación destructiva (reemplazo por
 * importación o restauración) captura antes, en su misma transacción, el estado que sustituye:
 * una cabecera con cantidades, caducidad y hash, y trozos acotados de filas con su propio hash.
 * `authenticated` solo lee sus filas; capturar y borrar pasan por `biblib.library_snapshot_*`.
 */
export type LibrarySnapshotReason = "import.replace" | "snapshot.restore"
export interface LibrarySnapshotCounts { books: number; shelves: number; chunks: number; bytes: number }

export const librarySnapshots = biblibSchema.table(
  "library_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    // Operación durable (library_operations) que sustituyó este estado, en la misma transacción.
    sourceOperationId: uuid("source_operation_id").notNull(),
    reason: text("reason").$type<LibrarySnapshotReason>().notNull(),
    capturedRevision: uuid("captured_revision").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    state: text("state").$type<"capturing" | "ready">().notNull().default("capturing"),
    counts: jsonb("counts").$type<LibrarySnapshotCounts>().notNull().default({ books: 0, shelves: 0, chunks: 0, bytes: 0 }),
    digest: text("digest"),
    // Autoriza borrar esta versión; nunca autoriza escribir datos de la colección.
    version: uuid("version").notNull().defaultRandom(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("library_snapshots_user_id_id_unique").on(table.userId, table.id),
    uniqueIndex("library_snapshots_operation_unique").on(table.userId, table.sourceOperationId),
    index("library_snapshots_user_id_created_at_idx").on(table.userId, table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
    index("library_snapshots_expires_at_idx").on(table.expiresAt),
    foreignKey({ name: "library_snapshots_owner_operation_fk", columns: [table.userId, table.sourceOperationId], foreignColumns: [libraryOperations.userId, libraryOperations.id] }),
    check("library_snapshots_reason_check", sql`${table.reason} in ('import.replace', 'snapshot.restore')`),
    check("library_snapshots_state_check", sql`${table.state} in ('capturing', 'ready')`),
    check("library_snapshots_digest_check", sql`${table.digest} is null or ${table.digest} ~ '^[0-9a-f]{64}$'`),
    // Solo se anuncia como válida una versión completa con hash.
    check("library_snapshots_ready_check", sql`${table.state} <> 'ready' or ${table.digest} is not null`),
    check("library_snapshots_counts_check", sql`jsonb_typeof(${table.counts}) = 'object'`),
    check("library_snapshots_schema_version_check", sql`${table.schemaVersion} >= 1`),
    check("library_snapshots_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
    pgPolicy("library_snapshots_select_own", {
      for: "select",
      to: authenticatedRole,
      using: ownRow(table.userId),
    }),
  ],
).enableRLS()

/** Trozo de una versión anterior: hasta 200 filas de un tipo, con hash de su contenido. */
export const librarySnapshotChunks = biblibSchema.table(
  "library_snapshot_chunks",
  {
    snapshotId: uuid("snapshot_id").notNull(),
    userId: uuid("user_id").notNull(),
    seq: integer("seq").notNull(),
    // 0014 (O13): las etiquetas, ubicaciones y series de la cuenta van en sus propios trozos, después de los libros.
    kind: text("kind").$type<"shelves" | "books" | "tags" | "locations" | "series">().notNull(),
    itemCount: integer("item_count").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>[]>().notNull(),
    digest: text("digest").notNull(),
  },
  (table) => [
    primaryKey({ name: "library_snapshot_chunks_pkey", columns: [table.snapshotId, table.seq] }),
    foreignKey({ name: "library_snapshot_chunks_owner_snapshot_fk", columns: [table.userId, table.snapshotId], foreignColumns: [librarySnapshots.userId, librarySnapshots.id] }).onDelete("cascade"),
    check("library_snapshot_chunks_kind_check", sql`${table.kind} in ('shelves', 'books', 'tags', 'locations', 'series')`),
    check("library_snapshot_chunks_seq_check", sql`${table.seq} >= 0`),
    check("library_snapshot_chunks_size_check", sql`${table.itemCount} >= 1 and ${table.itemCount} <= 200 and jsonb_typeof(${table.payload}) = 'array' and jsonb_array_length(${table.payload}) = ${table.itemCount}`),
    check("library_snapshot_chunks_digest_check", sql`${table.digest} ~ '^[0-9a-f]{64}$'`),
    pgPolicy("library_snapshot_chunks_select_own", {
      for: "select",
      to: authenticatedRole,
      using: ownRow(table.userId),
    }),
  ],
).enableRLS()

/*
 * Restauración de conjuntos de partes (U-DAT-04). Una sesión privada recibe las partes de un respaldo
 * en trozos de hasta 256 KiB, las comprueba contra el manifest (`bundleVersion: 1`) y deja sus filas
 * en staging; la colección activa solo cambia en la transacción final de publicación. El dueño
 * escribe sus filas con RLS y la guarda de 0008 ata cada trozo y fila nuevos a una sesión propia que
 * sigue recibiendo y no ha caducado. Las sesiones abandonadas caducan a los 7 días.
 */
export type RestoreSessionState = "receiving" | "validated" | "prepared" | "committed" | "rejected"
export interface RestoreSessionTotals { books: number; shelves: number }

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" })
const sessionStates = sql`('receiving', 'validated', 'prepared', 'committed', 'rejected')`

export const importSessions = biblibSchema.table(
  "import_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    state: text("state").$type<RestoreSessionState>().notNull().default("receiving"),
    // `manifest`: lo trae el respaldo; `loose`: partes sueltas cuyo manifest genera el servidor al inspeccionarlas;
    // `csv` (0014, U-DAT-09): un archivo CSV con su mapeo explícito.
    source: text("source").$type<"manifest" | "loose" | "csv">().notNull(),
    exportSetId: uuid("export_set_id").notNull(),
    payloadFormatVersion: integer("payload_format_version"),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    // Hash global: sha256 del manifest canónico que validó el servidor.
    manifestDigest: text("manifest_digest").notNull(),
    baseRevision: uuid("base_revision").notNull(),
    rulesVersion: integer("rules_version").notNull(),
    partCount: integer("part_count").notNull(),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
    receivedBytes: bigint("received_bytes", { mode: "number" }).notNull().default(0),
    validatedParts: integer("validated_parts").notNull().default(0),
    totals: jsonb("totals").$type<RestoreSessionTotals>(),
    previewId: uuid("preview_id"),
    previewRevision: uuid("preview_revision"),
    previewExpiresAt: timestamp("preview_expires_at", { withTimezone: true }),
    plan: jsonb("plan").$type<ImportPlan>(),
    operationId: uuid("operation_id"),
    errorCode: text("error_code"),
    // U-DAT-09 (0014): mapeo versionado de una sesión CSV y hashes de la entrada y del mapeo. Un reintento con el
    // mismo archivo y mapeo vuelve a las mismas filas (`source_row_key`); cambiar el mapeo regenera el plan.
    csvMapping: jsonb("csv_mapping").$type<CsvMapping>(),
    csvMappingVersion: integer("csv_mapping_version"),
    inputSha256: text("input_sha256"),
    mappingSha256: text("mapping_sha256"),
    version: uuid("version").notNull().defaultRandom(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("import_sessions_csv_mapping_check", sql`(${table.csvMapping} is null) = (${table.csvMappingVersion} is null) and (${table.csvMapping} is null) = (${table.mappingSha256} is null)`),
    check("import_sessions_csv_mapping_shape_check", sql`${table.csvMapping} is null or (jsonb_typeof(${table.csvMapping}) = 'object' and octet_length(${table.csvMapping}::text) <= 16384 and ${table.csvMappingVersion} >= 1)`),
    check("import_sessions_csv_hashes_check", sql`(${table.inputSha256} is null or ${table.inputSha256} ~ '^[0-9a-f]{64}$') and (${table.mappingSha256} is null or ${table.mappingSha256} ~ '^[0-9a-f]{64}$')`),
    // Una sesión CSV conserva siempre el hash de su archivo; las de respaldo no tienen mapeo.
    check("import_sessions_csv_source_check", sql`(${table.source} = 'csv') = (${table.inputSha256} is not null) and (${table.source} = 'csv' or ${table.csvMapping} is null)`),
    uniqueIndex("import_sessions_user_id_id_unique").on(table.userId, table.id),
    index("import_sessions_user_created_idx").on(table.userId, table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
    index("import_sessions_expires_at_idx").on(table.expiresAt),
    check("import_sessions_state_check", sql`${table.state} in ${sessionStates}`),
    check("import_sessions_source_check", sql`${table.source} in ('manifest', 'loose', 'csv')`),
    check("import_sessions_format_check", sql`${table.payloadFormatVersion} is null or ${table.payloadFormatVersion} in (1, 2)`),
    check("import_sessions_digest_check", sql`${table.manifestDigest} ~ '^[0-9a-f]{64}$'`),
    check("import_sessions_parts_check", sql`${table.partCount} >= 1 and ${table.partCount} <= 50 and ${table.validatedParts} >= 0 and ${table.validatedParts} <= ${table.partCount}`),
    check("import_sessions_bytes_check", sql`${table.totalBytes} >= 1 and ${table.totalBytes} <= 83886080 and ${table.receivedBytes} >= 0 and ${table.receivedBytes} <= ${table.totalBytes}`),
    // Una vista previa se guarda completa (ID, revisión, caducidad y plan) o no se guarda.
    check("import_sessions_preview_check", sql`(${table.previewId} is null) = (${table.previewRevision} is null) and (${table.previewId} is null) = (${table.previewExpiresAt} is null) and (${table.previewId} is null) = (${table.plan} is null)`),
    check("import_sessions_prepared_check", sql`${table.state} not in ('prepared', 'committed') or ${table.previewId} is not null`),
    check("import_sessions_committed_check", sql`(${table.state} = 'committed') = (${table.operationId} is not null)`),
    check("import_sessions_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
    pgPolicy("import_sessions_select_own", { for: "select", to: authenticatedRole, using: ownRow(table.userId) }),
    pgPolicy("import_sessions_insert_own", { for: "insert", to: authenticatedRole, withCheck: ownRow(table.userId) }),
    pgPolicy("import_sessions_update_own", { for: "update", to: authenticatedRole, using: ownRow(table.userId), withCheck: ownRow(table.userId) }),
    pgPolicy("import_sessions_delete_own", { for: "delete", to: authenticatedRole, using: ownRow(table.userId) }),
    ...activeAccountPolicies("import_sessions", ALL_WRITES),
  ],
).enableRLS()

/** Parte esperada de una sesión: tamaño y hash exactos del archivo, trozos y recuentos comprobados. */
export const importSessionParts = biblibSchema.table(
  "import_session_parts",
  {
    sessionId: uuid("session_id").notNull(),
    userId: uuid("user_id").notNull(),
    partId: text("part_id").notNull(),
    partIndex: integer("part_index").notNull(),
    byteLength: integer("byte_length").notNull(),
    sha256: text("sha256").notNull(),
    totalChunks: integer("total_chunks").notNull(),
    state: text("state").$type<"pending" | "received" | "validated">().notNull().default("pending"),
    formatVersion: integer("format_version"),
    exportedAt: text("exported_at"),
    counts: jsonb("counts").$type<Record<string, number>>(),
  },
  (table) => [
    primaryKey({ name: "import_session_parts_pkey", columns: [table.sessionId, table.partId] }),
    uniqueIndex("import_session_parts_index_unique").on(table.sessionId, table.partIndex),
    uniqueIndex("import_session_parts_owner_unique").on(table.userId, table.sessionId, table.partId),
    foreignKey({ name: "import_session_parts_owner_session_fk", columns: [table.userId, table.sessionId], foreignColumns: [importSessions.userId, importSessions.id] }).onDelete("cascade"),
    check("import_session_parts_id_check", sql`${table.partId} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    check("import_session_parts_index_check", sql`${table.partIndex} >= 0 and ${table.partIndex} < 50`),
    check("import_session_parts_size_check", sql`${table.byteLength} >= 1 and ${table.byteLength} <= 8388608 and ${table.totalChunks} = (${table.byteLength} + 262143) / 262144`),
    check("import_session_parts_sha_check", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check("import_session_parts_state_check", sql`${table.state} in ('pending', 'received', 'validated')`),
    check("import_session_parts_format_check", sql`${table.formatVersion} is null or ${table.formatVersion} in (1, 2)`),
    pgPolicy("import_session_parts_select_own", { for: "select", to: authenticatedRole, using: ownRow(table.userId) }),
    pgPolicy("import_session_parts_insert_own", { for: "insert", to: authenticatedRole, withCheck: ownRow(table.userId) }),
    pgPolicy("import_session_parts_update_own", { for: "update", to: authenticatedRole, using: ownRow(table.userId), withCheck: ownRow(table.userId) }),
    pgPolicy("import_session_parts_delete_own", { for: "delete", to: authenticatedRole, using: ownRow(table.userId) }),
    ...activeAccountPolicies("import_session_parts", ALL_WRITES),
  ],
).enableRLS()

/** Trozo de los bytes originales de una parte: inmutable y con su hash comprobado por Postgres. */
export const importSessionChunks = biblibSchema.table(
  "import_session_chunks",
  {
    sessionId: uuid("session_id").notNull(),
    userId: uuid("user_id").notNull(),
    partId: text("part_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    byteLength: integer("byte_length").notNull(),
    sha256: text("sha256").notNull(),
    bytes: bytea("bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "import_session_chunks_pkey", columns: [table.sessionId, table.partId, table.ordinal] }),
    foreignKey({ name: "import_session_chunks_owner_part_fk", columns: [table.userId, table.sessionId, table.partId], foreignColumns: [importSessionParts.userId, importSessionParts.sessionId, importSessionParts.partId] }).onDelete("cascade"),
    check("import_session_chunks_ordinal_check", sql`${table.ordinal} >= 0 and ${table.ordinal} < 32`),
    check("import_session_chunks_size_check", sql`${table.byteLength} >= 1 and ${table.byteLength} <= 262144 and octet_length(${table.bytes}) = ${table.byteLength}`),
    check("import_session_chunks_sha_check", sql`${table.sha256} = encode(sha256(${table.bytes}), 'hex')`),
    pgPolicy("import_session_chunks_select_own", { for: "select", to: authenticatedRole, using: ownRow(table.userId) }),
    pgPolicy("import_session_chunks_insert_own", { for: "insert", to: authenticatedRole, withCheck: ownRow(table.userId) }),
    pgPolicy("import_session_chunks_delete_own", { for: "delete", to: authenticatedRole, using: ownRow(table.userId) }),
    ...activeAccountPolicies("import_session_chunks", ["insert", "delete"]),
  ],
).enableRLS()

/**
 * Fila validada de una parte (libro o estantería ya normalizados), con clave estable por sesión. 0014 (O13) añade las
 * etiquetas, ubicaciones y series de la cuenta de una copia v2 y los registros CSV (`record`, U-DAT-09): estos llevan
 * su ordinal de registro (no de línea física), una clave durable `source_row_key` y sus incidencias.
 */
export type ImportSessionRowKind = "book" | "shelf" | "tag" | "location" | "series" | "record"

export const importSessionRows = biblibSchema.table(
  "import_session_rows",
  {
    sessionId: uuid("session_id").notNull(),
    userId: uuid("user_id").notNull(),
    kind: text("kind").$type<ImportSessionRowKind>().notNull(),
    rowKey: text("row_key").notNull(),
    partIndex: integer("part_index").notNull(),
    position: integer("position").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    sourceOrdinal: integer("source_ordinal"),
    sourceRowKey: text("source_row_key"),
    issues: jsonb("issues").$type<CsvRowIssue[]>(),
  },
  (table) => [
    primaryKey({ name: "import_session_rows_pkey", columns: [table.sessionId, table.kind, table.rowKey] }),
    index("import_session_rows_order_idx").on(table.sessionId, table.kind, table.partIndex, table.position),
    uniqueIndex("import_session_rows_source_key_unique").on(table.sessionId, table.sourceRowKey).where(sql`${table.sourceRowKey} is not null`),
    foreignKey({ name: "import_session_rows_owner_session_fk", columns: [table.userId, table.sessionId], foreignColumns: [importSessions.userId, importSessions.id] }).onDelete("cascade"),
    check("import_session_rows_kind_check", sql`${table.kind} in ('book', 'shelf', 'tag', 'location', 'series', 'record')`),
    check("import_session_rows_source_check", sql`(${table.sourceOrdinal} is null) = (${table.sourceRowKey} is null) and (${table.sourceOrdinal} is null or (${table.sourceOrdinal} >= 1 and ${table.sourceOrdinal} <= 1000000 and ${table.sourceRowKey} ~ '^[A-Za-z0-9:_-]{1,128}$'))`),
    check("import_session_rows_issues_check", sql`${table.issues} is null or (jsonb_typeof(${table.issues}) = 'array' and jsonb_array_length(${table.issues}) <= 50)`),
    check("import_session_rows_key_check", sql`length(${table.rowKey}) between 1 and 200`),
    check("import_session_rows_data_check", sql`jsonb_typeof(${table.data}) = 'object'`),
    pgPolicy("import_session_rows_select_own", { for: "select", to: authenticatedRole, using: ownRow(table.userId) }),
    pgPolicy("import_session_rows_insert_own", { for: "insert", to: authenticatedRole, withCheck: ownRow(table.userId) }),
    pgPolicy("import_session_rows_delete_own", { for: "delete", to: authenticatedRole, using: ownRow(table.userId) }),
    ...activeAccountPolicies("import_session_rows", ["insert", "delete"]),
  ],
).enableRLS()

/*
 * Portadas privadas (U-DAT-10). Un asset nace en cuarentena (subida propia o adquisición de un
 * proveedor con `rehostCover`), y solo pasa a `ready` cuando el servidor ha validado y reencodificado
 * los bytes, los ha subido al bucket privado `biblib-covers` con la sesión del dueño y ha registrado su
 * sha256. `restored` marca los assets de un restore administrativo hasta que el servidor los revalida.
 * `authenticated` solo lee sus filas; toda transición pasa por las funciones `biblib.cover_asset_*`.
 * Las políticas de `storage.objects` las instala `biblib.cover_storage_install()` (0009).
 */
export type CoverAssetState = "quarantine" | "ready" | "restored"
export type CoverAssetSourceKind = "provider" | "upload"

export const coverAssets = biblibSchema.table("cover_assets", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  // `<dueño>/<asset>/<intento>.webp`; nulo hasta registrar el objeto validado.
  storageKey: text("storage_key"),
  sha256: text("sha256"),
  mime: text("mime"),
  width: integer("width"),
  height: integer("height"),
  bytes: integer("bytes"),
  state: text("state").$type<CoverAssetState>().notNull().default("quarantine"),
  sourceKind: text("source_kind").$type<CoverAssetSourceKind>().notNull(),
  // Clave de proveedor validada por el servidor (`open-library:id:123`) o `upload`; nunca una URL.
  sourceRef: text("source_ref").notNull(),
  rightsPolicyVersion: text("rights_policy_version").notNull(),
  attribution: text("attribution"),
  // Único intento autorizado a subir: número de fencing del trabajo o token de la subida propia.
  uploadToken: text("upload_token"),
  jobId: uuid("job_id"),
  // Ficha y versión a las que adjuntar al terminar la adquisición; solo si la versión sigue igual.
  attachBookId: uuid("attach_book_id"),
  attachBookVersion: uuid("attach_book_version"),
  // Cuarentena: caducidad de la subida. Listo: caducidad de la licencia (nulo, sin caducidad).
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  version: uuid("version").notNull().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cover_assets_user_id_id_unique").on(table.userId, table.id),
  // Deduplicación solo dentro del mismo propietario: nunca un índice global de hashes.
  uniqueIndex("cover_assets_user_sha_unique").on(table.userId, table.sha256).where(sql`${table.state} in ('ready', 'restored')`),
  uniqueIndex("cover_assets_job_unique").on(table.jobId).where(sql`${table.jobId} is not null`),
  index("cover_assets_user_created_idx").on(table.userId, table.createdAt.desc().nullsFirst()),
  index("cover_assets_expires_at_idx").on(table.expiresAt).where(sql`${table.expiresAt} is not null`),
  foreignKey({ name: "cover_assets_owner_job_fk", columns: [table.userId, table.jobId], foreignColumns: [libraryJobs.userId, libraryJobs.id] }).onDelete("set null"),
  check("cover_assets_state_check", sql`${table.state} in ('quarantine', 'ready', 'restored')`),
  check("cover_assets_source_kind_check", sql`${table.sourceKind} in ('provider', 'upload')`),
  // Google Books nunca autoriza copiar sus imágenes: ni siquiera una fila manipulada lo admite.
  check("cover_assets_source_ref_check", sql`(${table.sourceKind} = 'upload' and ${table.sourceRef} = 'upload') or (${table.sourceKind} = 'provider' and ${table.sourceRef} ~ '^(open-library|bne):[a-z]{2,8}:[A-Za-z0-9-]{1,40}$')`),
  check("cover_assets_sha_check", sql`${table.sha256} is null or ${table.sha256} ~ '^[0-9a-f]{64}$'`),
  check("cover_assets_key_check", sql`${table.storageKey} is null or ${table.storageKey} ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9_-]{1,64}[.]webp$'`),
  check("cover_assets_token_check", sql`${table.uploadToken} is null or ${table.uploadToken} ~ '^[A-Za-z0-9_-]{1,64}$'`),
  check("cover_assets_size_check", sql`(${table.bytes} is null or (${table.bytes} >= 1 and ${table.bytes} <= 5242880)) and (${table.width} is null or (${table.width} >= 1 and ${table.width} <= 10000)) and (${table.height} is null or (${table.height} >= 1 and ${table.height} <= 10000))`),
  // Un asset utilizable siempre tiene objeto, hash, tipo y dimensiones; uno en cuarentena caduca.
  check("cover_assets_ready_check", sql`${table.state} = 'quarantine' or (${table.storageKey} is not null and ${table.sha256} is not null and ${table.mime} = 'image/webp' and ${table.width} is not null and ${table.height} is not null and ${table.bytes} is not null)`),
  check("cover_assets_quarantine_check", sql`${table.state} <> 'quarantine' or ${table.expiresAt} is not null`),
  check("cover_assets_attach_check", sql`(${table.attachBookId} is null) = (${table.attachBookVersion} is null)`),
  pgPolicy("cover_assets_select_own", { for: "select", to: authenticatedRole, using: ownRow(table.userId) }),
]).enableRLS()

/*
 * Lote de producto de O13 (0014). Todo privado por cuenta: cada FK entre datos privados incluye al dueño, RLS limita
 * las filas a `auth.uid()` y toda escritura de cliente exige cuenta activa (políticas RESTRICTIVE de U-OPS-03). Las
 * tablas que forman parte de la colección (etiquetas, notas, ubicaciones, series y evidencias) rotan la revisión de
 * colección como libros y estanterías; las de flujo (incidencias, decisiones), el perfil, los assets y los perfiles de
 * mapeo CSV no. Contrato completo: docs/spec-pendientes/contratos-o13.md.
 */
const ownWrites = (name: string, commands: readonly WriteCommand[], userIdColumn: AnyPgColumn) => [
  pgPolicy(`${name}_select_own`, { for: "select", to: authenticatedRole, using: ownCopyRow(userIdColumn) }),
  ...commands.map((command) => pgPolicy(`${name}_${command}_own`, {
    for: command, to: authenticatedRole,
    ...(command === "insert" ? { withCheck: ownCopyRow(userIdColumn) } : command === "update" ? { using: ownCopyRow(userIdColumn), withCheck: ownCopyRow(userIdColumn) } : { using: ownCopyRow(userIdColumn) }),
  })),
  ...activeAccountPolicies(name, commands),
]

/**
 * Imagen privada (U-EXP-06 avatar, U-PRO-03 foto de ubicación, U-DAT-07 foto fuente) en el bucket `biblib-media`,
 * con ruta `{user_id}/{kind}/{id}`. Mismo ciclo que las portadas de U-DAT-10: cuarentena de 15 minutos, objeto
 * subido con la sesión del dueño y registro tras validar y reencodificar a WebP (sin EXIF ni GPS). El dueño solo
 * lee sus filas; toda transición pasa por `biblib.media_asset_*`.
 */
export const mediaAssets = biblibSchema.table("media_assets", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  kind: text("kind").$type<MediaKind>().notNull(),
  state: text("state").$type<MediaAssetState>().notNull().default("quarantine"),
  storageKey: text("storage_key").notNull(),
  sha256: text("sha256"),
  mime: text("mime"),
  width: integer("width"),
  height: integer("height"),
  bytes: integer("bytes"),
  // Caducidad de la cuarentena; nula cuando el asset está listo.
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  version: uuid("version").notNull().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("media_assets_user_id_id_unique").on(table.userId, table.id),
  index("media_assets_user_kind_idx").on(table.userId, table.kind, table.createdAt.desc().nullsFirst()),
  index("media_assets_expires_at_idx").on(table.expiresAt).where(sql`${table.expiresAt} is not null`),
  check("media_assets_kind_check", sql`${table.kind} in ('avatar', 'location', 'evidence')`),
  check("media_assets_state_check", sql`${table.state} in ('quarantine', 'ready')`),
  check("media_assets_key_check", sql`${table.storageKey} = ${table.userId}::text || '/' || ${table.kind} || '/' || ${table.id}::text`),
  check("media_assets_sha_check", sql`${table.sha256} is null or ${table.sha256} ~ '^[0-9a-f]{64}$'`),
  check("media_assets_size_check", sql`(${table.bytes} is null or (${table.bytes} >= 1 and ${table.bytes} <= case when ${table.kind} = 'avatar' then 1048576 else 5242880 end)) and (${table.width} is null or (${table.width} >= 1 and ${table.width} <= case when ${table.kind} = 'avatar' then 1024 else 4096 end)) and (${table.height} is null or (${table.height} >= 1 and ${table.height} <= case when ${table.kind} = 'avatar' then 1024 else 4096 end))`),
  check("media_assets_ready_check", sql`${table.state} = 'quarantine' or (${table.sha256} is not null and ${table.mime} = 'image/webp' and ${table.width} is not null and ${table.height} is not null and ${table.bytes} is not null and ${table.expiresAt} is null)`),
  check("media_assets_quarantine_check", sql`${table.state} <> 'quarantine' or ${table.expiresAt} is not null`),
  pgPolicy("media_assets_select_own", { for: "select", to: authenticatedRole, using: ownCopyRow(table.userId) }),
]).enableRLS()

/** Perfil privado (U-EXP-06): el avatar propio sin tocar la metadata OAuth de Google. Una fila por cuenta. */
export const profiles = biblibSchema.table("profiles", {
  userId: uuid("user_id").primaryKey().references(() => authUsers.id, { onDelete: "cascade" }),
  avatarAssetId: uuid("avatar_asset_id"),
  version: uuid("version").notNull().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("profiles_avatar_idx").on(table.userId, table.avatarAssetId).where(sql`${table.avatarAssetId} is not null`),
  foreignKey({ name: "profiles_owner_avatar_fk", columns: [table.userId, table.avatarAssetId], foreignColumns: [mediaAssets.userId, mediaAssets.id] }),
  ...ownWrites("profiles", ALL_WRITES, table.userId),
]).enableRLS()

/** Etiqueta de la cuenta (U-PRO-01). `normalized_name` la calcula Postgres: mayúsculas y acentos no duplican. */
export const tags = biblibSchema.table("tags", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull().generatedAlwaysAs(sql`biblib.tag_normalize(name)`),
  version: uuid("version").notNull().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("tags_user_id_id_unique").on(table.userId, table.id),
  uniqueIndex("tags_user_normalized_unique").on(table.userId, table.normalizedName),
  check("tags_name_check", sql`char_length(${table.name}) >= 1 and char_length(${table.name}) <= 40 and ${table.name} = btrim(${table.name}) and ${table.name} !~ '[[:cntrl:]]'`),
  ...ownWrites("tags", ALL_WRITES, table.userId),
]).enableRLS()

/** Etiquetas de un ejemplar (hasta 20). Borrar la etiqueta o el ejemplar retira la asociación, nunca el otro. */
export const copyTags = biblibSchema.table("copy_tags", {
  userId: uuid("user_id").notNull(),
  copyId: uuid("copy_id").notNull(),
  tagId: uuid("tag_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "copy_tags_pkey", columns: [table.userId, table.copyId, table.tagId] }),
  index("copy_tags_user_tag_idx").on(table.userId, table.tagId),
  foreignKey({ name: "copy_tags_owner_copy_fk", columns: [table.userId, table.copyId], foreignColumns: [copies.userId, copies.id] }).onDelete("cascade"),
  foreignKey({ name: "copy_tags_owner_tag_fk", columns: [table.userId, table.tagId], foreignColumns: [tags.userId, tags.id] }).onDelete("cascade"),
  ...ownWrites("copy_tags", ["insert", "delete"], table.userId),
]).enableRLS()

/** Nota privada y valoración de un ejemplar (U-PRO-01), nunca en `books_legacy`. Una fila por ejemplar. */
export const copyAnnotations = biblibSchema.table("copy_annotations", {
  userId: uuid("user_id").notNull(),
  copyId: uuid("copy_id").notNull(),
  notes: text("notes"),
  rating: smallint("rating").$type<CopyRating>(),
  version: uuid("version").notNull().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "copy_annotations_pkey", columns: [table.userId, table.copyId] }),
  foreignKey({ name: "copy_annotations_owner_copy_fk", columns: [table.userId, table.copyId], foreignColumns: [copies.userId, copies.id] }).onDelete("cascade"),
  check("copy_annotations_notes_check", sql`${table.notes} is null or (char_length(${table.notes}) >= 1 and char_length(${table.notes}) <= 4000)`),
  check("copy_annotations_rating_check", sql`${table.rating} is null or (${table.rating} >= 1 and ${table.rating} <= 5)`),
  ...ownWrites("copy_annotations", ALL_WRITES, table.userId),
]).enableRLS()

/**
 * Ubicación física (U-PRO-03): árbol propio sin ciclos ni más de 8 niveles (`biblib.guard_location_tree`). No se borra
 * una ubicación con hijas ni con ejemplares. La foto es un asset `location` propio y listo.
 */
export const locations = biblibSchema.table("locations", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id"),
  name: text("name").notNull(),
  kind: text("kind").$type<LocationKind>().notNull(),
  photoAssetId: uuid("photo_asset_id"),
  version: uuid("version").notNull().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("locations_user_id_id_unique").on(table.userId, table.id),
  index("locations_user_parent_idx").on(table.userId, table.parentId),
  index("locations_photo_idx").on(table.userId, table.photoAssetId).where(sql`${table.photoAssetId} is not null`),
  foreignKey({ name: "locations_owner_parent_fk", columns: [table.userId, table.parentId], foreignColumns: [table.userId, table.id] }),
  foreignKey({ name: "locations_owner_photo_fk", columns: [table.userId, table.photoAssetId], foreignColumns: [mediaAssets.userId, mediaAssets.id] }),
  check("locations_name_check", sql`char_length(${table.name}) >= 1 and char_length(${table.name}) <= 120 and ${table.name} = btrim(${table.name})`),
  check("locations_kind_check", sql`${table.kind} in ('room', 'bookcase', 'cabinet', 'box', 'shelf', 'other')`),
  check("locations_parent_check", sql`${table.parentId} is null or ${table.parentId} <> ${table.id}`),
  ...ownWrites("locations", ALL_WRITES, table.userId),
]).enableRLS()

/** Ubicación actual de un ejemplar: una como máximo. La estantería lógica no cambia al moverlo. */
export const copyLocations = biblibSchema.table("copy_locations", {
  userId: uuid("user_id").notNull(),
  copyId: uuid("copy_id").notNull(),
  locationId: uuid("location_id").notNull(),
  shelfLabel: text("shelf_label"),
  position: integer("position"),
  version: uuid("version").notNull().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "copy_locations_pkey", columns: [table.userId, table.copyId] }),
  index("copy_locations_user_location_idx").on(table.userId, table.locationId),
  foreignKey({ name: "copy_locations_owner_copy_fk", columns: [table.userId, table.copyId], foreignColumns: [copies.userId, copies.id] }).onDelete("cascade"),
  foreignKey({ name: "copy_locations_owner_location_fk", columns: [table.userId, table.locationId], foreignColumns: [locations.userId, locations.id] }),
  check("copy_locations_shelf_label_check", sql`${table.shelfLabel} is null or (char_length(${table.shelfLabel}) >= 1 and char_length(${table.shelfLabel}) <= 60 and ${table.shelfLabel} = btrim(${table.shelfLabel}))`),
  check("copy_locations_position_check", sql`${table.position} is null or (${table.position} >= 1 and ${table.position} <= 100000)`),
  ...ownWrites("copy_locations", ALL_WRITES, table.userId),
]).enableRLS()

/** Serie privada (U-PRO-05). Su identidad no sale del ISBN; dos cuentas pueden repetir título. */
export const series = biblibSchema.table("series", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  version: uuid("version").notNull().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("series_user_id_id_unique").on(table.userId, table.id),
  index("series_user_title_idx").on(table.userId, table.title),
  check("series_title_check", sql`char_length(${table.title}) >= 1 and char_length(${table.title}) <= 300 and ${table.title} = btrim(${table.title})`),
  check("series_description_check", sql`${table.description} is null or (char_length(${table.description}) >= 1 and char_length(${table.description}) <= 2000)`),
  ...ownWrites("series", ALL_WRITES, table.userId),
]).enableRLS()

/**
 * Edición en una serie (cero o una por edición). `position` es NUMERIC exacto ≥ 0 con hasta 4 decimales: 1, 1.5 y 2
 * ordenan sin flotantes; nula si el orden es desconocido. Borrar la serie retira los vínculos, nunca las ediciones.
 */
export const seriesEditions = biblibSchema.table("series_editions", {
  userId: uuid("user_id").notNull(),
  editionId: uuid("edition_id").notNull(),
  seriesId: uuid("series_id").notNull(),
  position: numeric("position"),
  volumeLabel: text("volume_label"),
  orderNote: text("order_note"),
  version: uuid("version").notNull().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "series_editions_pkey", columns: [table.userId, table.editionId] }),
  index("series_editions_order_idx").on(table.userId, table.seriesId, table.position),
  foreignKey({ name: "series_editions_owner_edition_fk", columns: [table.userId, table.editionId], foreignColumns: [editions.userId, editions.id] }).onDelete("cascade"),
  foreignKey({ name: "series_editions_owner_series_fk", columns: [table.userId, table.seriesId], foreignColumns: [series.userId, series.id] }).onDelete("cascade"),
  check("series_editions_position_check", sql`${table.position} is null or (${table.position} >= 0 and ${table.position} < 1000000 and scale(${table.position}) <= 4)`),
  check("series_editions_volume_label_check", sql`${table.volumeLabel} is null or (char_length(${table.volumeLabel}) >= 1 and char_length(${table.volumeLabel}) <= 40)`),
  check("series_editions_order_note_check", sql`${table.orderNote} is null or (char_length(${table.orderNote}) >= 1 and char_length(${table.orderNote}) <= 200)`),
  ...ownWrites("series_editions", ALL_WRITES, table.userId),
]).enableRLS()

/**
 * Evidencia bibliográfica (U-DAT-07) de una edición o de un ejemplar (exactamente uno, con FK del mismo dueño). La
 * confianza es una etiqueta, nunca un porcentaje; `physically_checked` solo en un ejemplar. Sin URL ni foto inventadas.
 */
export const bibliographicEvidence = biblibSchema.table("bibliographic_evidence", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  editionId: uuid("edition_id"),
  copyId: uuid("copy_id"),
  sourceKind: text("source_kind").$type<EvidenceSourceKind>().notNull(),
  sourceRef: text("source_ref"),
  sourceUrl: text("source_url"),
  photoAssetId: uuid("photo_asset_id"),
  observedAt: timestamp("observed_at", { withTimezone: true }),
  fieldClaims: jsonb("field_claims").$type<Record<string, unknown>>().notNull().default({}),
  confidence: text("confidence").$type<ConfidenceLabel>().notNull(),
  origin: text("origin").$type<EvidenceOrigin>().notNull().default("review"),
  version: uuid("version").notNull().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("bibliographic_evidence_user_id_id_unique").on(table.userId, table.id),
  index("bibliographic_evidence_edition_idx").on(table.userId, table.editionId).where(sql`${table.editionId} is not null`),
  index("bibliographic_evidence_copy_idx").on(table.userId, table.copyId).where(sql`${table.copyId} is not null`),
  index("bibliographic_evidence_photo_idx").on(table.userId, table.photoAssetId).where(sql`${table.photoAssetId} is not null`),
  foreignKey({ name: "bibliographic_evidence_owner_edition_fk", columns: [table.userId, table.editionId], foreignColumns: [editions.userId, editions.id] }).onDelete("cascade"),
  foreignKey({ name: "bibliographic_evidence_owner_copy_fk", columns: [table.userId, table.copyId], foreignColumns: [copies.userId, copies.id] }).onDelete("cascade"),
  foreignKey({ name: "bibliographic_evidence_owner_photo_fk", columns: [table.userId, table.photoAssetId], foreignColumns: [mediaAssets.userId, mediaAssets.id] }),
  check("bibliographic_evidence_subject_check", sql`num_nonnulls(${table.editionId}, ${table.copyId}) = 1`),
  check("bibliographic_evidence_source_kind_check", sql`${table.sourceKind} in ('provider', 'photo', 'manual', 'import')`),
  check("bibliographic_evidence_confidence_check", sql`${table.confidence} in ('provisional', 'bibliographic_match', 'physically_checked')`),
  check("bibliographic_evidence_origin_check", sql`${table.origin} in ('backfill', 'review', 'import')`),
  check("bibliographic_evidence_physical_check", sql`${table.confidence} <> 'physically_checked' or ${table.copyId} is not null`),
  check("bibliographic_evidence_photo_check", sql`${table.photoAssetId} is null or ${table.sourceKind} = 'photo'`),
  check("bibliographic_evidence_source_ref_check", sql`${table.sourceRef} is null or ${table.sourceRef} ~ '^[A-Za-z0-9:._-]{1,200}$'`),
  check("bibliographic_evidence_source_url_check", sql`${table.sourceUrl} is null or (${table.sourceUrl} ~ '^https?://' and char_length(${table.sourceUrl}) <= 2048)`),
  check("bibliographic_evidence_claims_check", sql`jsonb_typeof(${table.fieldClaims}) = 'object' and octet_length(${table.fieldClaims}::text) <= 16384`),
  ...ownWrites("bibliographic_evidence", ALL_WRITES, table.userId),
]).enableRLS()

/** Incidencia de revisión (U-DAT-07): motivo, entidades citadas (solo IDs) y estado. Ignorar no borra evidencias. */
export const reviewIssues = biblibSchema.table("review_issues", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  reason: text("reason").$type<ReviewReason>().notNull(),
  entityRefs: jsonb("entity_refs").$type<ReviewEntityRef[]>().notNull(),
  state: text("state").$type<ReviewState>().notNull().default("open"),
  dedupeKey: text("dedupe_key"),
  version: uuid("version").notNull().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("review_issues_user_id_id_unique").on(table.userId, table.id),
  uniqueIndex("review_issues_open_dedupe_unique").on(table.userId, table.dedupeKey).where(sql`${table.dedupeKey} is not null and ${table.state} = 'open'`),
  index("review_issues_user_state_idx").on(table.userId, table.state, table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
  check("review_issues_reason_check", sql`${table.reason} in ('provisional', 'missing_isbn', 'invalid_isbn', 'missing_cover', 'isbn_conflict', 'duplicate_candidate', 'photo_doubt', 'source_conflict')`),
  check("review_issues_state_check", sql`${table.state} in ('open', 'resolved', 'ignored')`),
  check("review_issues_refs_check", sql`jsonb_typeof(${table.entityRefs}) = 'array' and jsonb_array_length(${table.entityRefs}) >= 1 and jsonb_array_length(${table.entityRefs}) <= 50`),
  check("review_issues_dedupe_check", sql`${table.dedupeKey} is null or ${table.dedupeKey} ~ '^[A-Za-z0-9:._-]{1,200}$'`),
  check("review_issues_resolved_check", sql`(${table.state} = 'open') = (${table.resolvedAt} is null)`),
  ...ownWrites("review_issues", ALL_WRITES, table.userId),
]).enableRLS()

/** Decisión humana sobre una incidencia: solo inserción desde el cliente; desaparece con su incidencia o la cuenta. */
export const reviewDecisions = biblibSchema.table("review_decisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull(),
  kind: text("kind").$type<ReviewDecisionKind>().notNull(),
  selectedFields: jsonb("selected_fields").$type<Record<string, unknown>>().notNull().default({}),
  evidenceRefs: jsonb("evidence_refs").$type<string[]>().notNull().default([]),
  actor: text("actor").$type<"owner">().notNull().default("owner"),
  operationId: uuid("operation_id"),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("review_decisions_user_id_id_unique").on(table.userId, table.id),
  index("review_decisions_issue_idx").on(table.userId, table.issueId, table.decidedAt),
  foreignKey({ name: "review_decisions_owner_issue_fk", columns: [table.userId, table.issueId], foreignColumns: [reviewIssues.userId, reviewIssues.id] }).onDelete("cascade"),
  check("review_decisions_kind_check", sql`${table.kind} in ('accept_fields', 'ignore', 'confirm_physical', 'merge', 'reopen')`),
  check("review_decisions_fields_check", sql`jsonb_typeof(${table.selectedFields}) = 'object' and octet_length(${table.selectedFields}::text) <= 16384`),
  check("review_decisions_refs_check", sql`jsonb_typeof(${table.evidenceRefs}) = 'array' and jsonb_array_length(${table.evidenceRefs}) <= 50`),
  check("review_decisions_actor_check", sql`${table.actor} = 'owner'`),
  ...ownWrites("review_decisions", ["insert"], table.userId),
]).enableRLS()

/** Perfil de mapeo CSV guardado a petición (U-DAT-09): privado, versionado y sin muestras de filas. */
export const csvMappingProfiles = biblibSchema.table("csv_mapping_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mapping: jsonb("mapping").$type<CsvMapping>().notNull(),
  mappingVersion: integer("mapping_version").notNull().default(1),
  version: uuid("version").notNull().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("csv_mapping_profiles_user_id_id_unique").on(table.userId, table.id),
  uniqueIndex("csv_mapping_profiles_user_name_unique").on(table.userId, sql`lower(${table.name})`),
  check("csv_mapping_profiles_name_check", sql`char_length(${table.name}) >= 1 and char_length(${table.name}) <= 80 and ${table.name} = btrim(${table.name})`),
  check("csv_mapping_profiles_mapping_check", sql`jsonb_typeof(${table.mapping}) = 'object' and octet_length(${table.mapping}::text) <= 16384`),
  check("csv_mapping_profiles_version_check", sql`${table.mappingVersion} >= 1`),
  ...ownWrites("csv_mapping_profiles", ALL_WRITES, table.userId),
]).enableRLS()

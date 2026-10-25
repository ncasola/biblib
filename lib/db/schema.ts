import { getViewSelectedFields, sql } from "drizzle-orm"
import { authenticatedRole } from "drizzle-orm/supabase"
import { pgSchema, uuid, text, timestamp, boolean, integer, bigint, jsonb, uniqueIndex, index, check, pgPolicy, foreignKey, primaryKey, customType, type AnyPgColumn } from "drizzle-orm/pg-core"
import type { Author, Publisher, Book, CatalogueMetadata, CopyVerification, EditionCatalogue, EditionIdentifiers, LibraryData } from "@/lib/types"
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
    /** Colección leída: forma legacy si no pierde nada; si no, el payload v2 completo (U-DAT-06). */
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
 * trabajador escriba en su nombre; lo revalida cada transacción del ejecutor.
 */
export const accountLifecycle = biblibSchema.table(
  "account_lifecycle",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    state: text("state").$type<"active" | "blocked">().notNull().default("active"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("account_lifecycle_state_check", sql`${table.state} in ('active', 'blocked')`),
    pgPolicy("account_lifecycle_select_own", {
      for: "select",
      to: authenticatedRole,
      using: ownRow(table.userId),
    }),
  ],
).enableRLS()

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
    kind: text("kind").$type<"shelves" | "books">().notNull(),
    itemCount: integer("item_count").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>[]>().notNull(),
    digest: text("digest").notNull(),
  },
  (table) => [
    primaryKey({ name: "library_snapshot_chunks_pkey", columns: [table.snapshotId, table.seq] }),
    foreignKey({ name: "library_snapshot_chunks_owner_snapshot_fk", columns: [table.userId, table.snapshotId], foreignColumns: [librarySnapshots.userId, librarySnapshots.id] }).onDelete("cascade"),
    check("library_snapshot_chunks_kind_check", sql`${table.kind} in ('shelves', 'books')`),
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
    // `manifest`: lo trae el respaldo; `loose`: partes sueltas cuyo manifest genera el servidor al inspeccionarlas.
    source: text("source").$type<"manifest" | "loose">().notNull(),
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
    version: uuid("version").notNull().defaultRandom(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("import_sessions_user_id_id_unique").on(table.userId, table.id),
    index("import_sessions_user_created_idx").on(table.userId, table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
    index("import_sessions_expires_at_idx").on(table.expiresAt),
    check("import_sessions_state_check", sql`${table.state} in ${sessionStates}`),
    check("import_sessions_source_check", sql`${table.source} in ('manifest', 'loose')`),
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
  ],
).enableRLS()

/** Fila validada de una parte (libro o estantería ya normalizados), con clave estable por sesión. */
export const importSessionRows = biblibSchema.table(
  "import_session_rows",
  {
    sessionId: uuid("session_id").notNull(),
    userId: uuid("user_id").notNull(),
    kind: text("kind").$type<"book" | "shelf">().notNull(),
    rowKey: text("row_key").notNull(),
    partIndex: integer("part_index").notNull(),
    position: integer("position").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    primaryKey({ name: "import_session_rows_pkey", columns: [table.sessionId, table.kind, table.rowKey] }),
    index("import_session_rows_order_idx").on(table.sessionId, table.kind, table.partIndex, table.position),
    foreignKey({ name: "import_session_rows_owner_session_fk", columns: [table.userId, table.sessionId], foreignColumns: [importSessions.userId, importSessions.id] }).onDelete("cascade"),
    check("import_session_rows_kind_check", sql`${table.kind} in ('book', 'shelf')`),
    check("import_session_rows_key_check", sql`length(${table.rowKey}) between 1 and 200`),
    check("import_session_rows_data_check", sql`jsonb_typeof(${table.data}) = 'object'`),
    pgPolicy("import_session_rows_select_own", { for: "select", to: authenticatedRole, using: ownRow(table.userId) }),
    pgPolicy("import_session_rows_insert_own", { for: "insert", to: authenticatedRole, withCheck: ownRow(table.userId) }),
    pgPolicy("import_session_rows_delete_own", { for: "delete", to: authenticatedRole, using: ownRow(table.userId) }),
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

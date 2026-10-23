import { sql } from "drizzle-orm"
import { authenticatedRole, authUsers } from "drizzle-orm/supabase"
import { pgSchema, uuid, text, timestamp, boolean, integer, jsonb, uniqueIndex, index, check, pgPolicy, foreignKey, customType, type AnyPgColumn } from "drizzle-orm/pg-core"
import type { Author, Publisher, Book, CatalogueMetadata, LibraryData } from "@/lib/types"
import type { ImportPlan, ImportOperationResult } from "@/lib/import-plan"

export const biblibSchema = pgSchema("biblib")
const ownRow = (userIdColumn: AnyPgColumn) => sql`(select auth.uid() = ${userIdColumn})`

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

export const books = biblibSchema.table(
  "books",
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("books_user_id_isbn_unique").on(table.userId, table.isbn),
    uniqueIndex("books_user_id_id_unique").on(table.userId, table.id),
    index("books_user_id_idx").on(table.userId),
    index("books_shelf_id_idx").on(table.shelfId),
    check("books_status_check", sql`${table.status} in ('read', 'reading', 'unread', 'to-read')`),
    check("books_pages_check", sql`${table.numberOfPages} between 0 and 100000`),
    check("books_title_check", sql`length(btrim(${table.title})) between 1 and 500`),
    foreignKey({ name: "books_owner_shelf_fk", columns: [table.userId, table.shelfId], foreignColumns: [shelves.userId, shelves.id] }).onDelete("restrict"),
    pgPolicy("books_select_own", {
      for: "select",
      to: authenticatedRole,
      using: ownRow(table.userId),
    }),
    pgPolicy("books_insert_own", {
      for: "insert",
      to: authenticatedRole,
      withCheck: ownRow(table.userId),
    }),
    pgPolicy("books_update_own", {
      for: "update",
      to: authenticatedRole,
      using: ownRow(table.userId),
      withCheck: ownRow(table.userId),
    }),
    pgPolicy("books_delete_own", {
      for: "delete",
      to: authenticatedRole,
      using: ownRow(table.userId),
    }),
  ],
).enableRLS()

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

/** Vista previa servidor de una importación: entrada validada, plan privado y revisión revisada. */
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
    payload: jsonb("payload").$type<LibraryData>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("import_previews_user_id_id_unique").on(table.userId, table.id),
    index("import_previews_user_id_expires_at_idx").on(table.userId, table.expiresAt),
    check("import_previews_mode_check", sql`${table.mode} in ('merge', 'replace')`),
    check("import_previews_digest_check", sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
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

/** Resultado durable e idempotente por (propietario, operación, clave). Sin UPDATE ni DELETE para `authenticated`. */
export const libraryOperations = biblibSchema.table(
  "library_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    operation: text("operation").$type<"import.confirm">().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputDigest: text("input_digest").notNull(),
    previewId: uuid("preview_id"),
    status: text("status").$type<"committed">().notNull(),
    result: jsonb("result").$type<ImportOperationResult>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("library_operations_key_unique").on(table.userId, table.operation, table.idempotencyKey),
    uniqueIndex("library_operations_preview_unique").on(table.userId, table.previewId).where(sql`${table.previewId} is not null`),
    check("library_operations_operation_check", sql`${table.operation} in ('import.confirm')`),
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

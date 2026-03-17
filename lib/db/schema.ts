import { sql } from "drizzle-orm"
import { authenticatedRole, authUsers } from "drizzle-orm/supabase"
import { pgSchema, uuid, text, timestamp, boolean, integer, jsonb, uniqueIndex, index, check, pgPolicy, type AnyPgColumn } from "drizzle-orm/pg-core"
import type { Author, Publisher, Book } from "@/lib/types"

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
      using: ownRow(table.userId),
      withCheck: ownRow(table.userId),
    }),
    pgPolicy("shelves_delete_own", {
      for: "delete",
      to: authenticatedRole,
      using: ownRow(table.userId),
    }),
  ],
)

export const books = biblibSchema.table(
  "books",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    isbn: text("isbn").notNull(),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    authors: jsonb("authors").$type<Author[]>().notNull().default([]),
    publishers: jsonb("publishers").$type<Publisher[]>().notNull().default([]),
    numberOfPages: integer("number_of_pages").notNull().default(0),
    publishDate: text("publish_date").notNull().default(""),
    coverSmall: text("cover_small").notNull().default("/default-book-cover.webp"),
    coverMedium: text("cover_medium").notNull().default("/default-book-cover.webp"),
    coverLarge: text("cover_large").notNull().default("/default-book-cover.webp"),
    status: text("status").$type<Book["status"]>().notNull().default("unread"),
    shelfId: uuid("shelf_id")
      .notNull()
      .references(() => shelves.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("books_user_id_isbn_unique").on(table.userId, table.isbn),
    uniqueIndex("books_user_id_id_unique").on(table.userId, table.id),
    index("books_user_id_idx").on(table.userId),
    index("books_shelf_id_idx").on(table.shelfId),
    check("books_status_check", sql`${table.status} in ('read', 'reading', 'unread', 'to-read')`),
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
)

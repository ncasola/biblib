-- Fallará si existen filas antiguas incompatibles: corregirlas explícitamente
-- antes de migrar, sin reasignar ni borrar datos personales en silencio.
ALTER TABLE biblib.books ADD COLUMN catalogue jsonb NOT NULL DEFAULT '{"source":"import","isbnVerified":false}'::jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS shelves_user_id_id_unique ON biblib.shelves (user_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS books_user_id_id_unique ON biblib.books (user_id, id);
--> statement-breakpoint
ALTER TABLE biblib.books DROP CONSTRAINT IF EXISTS books_shelf_fk;
--> statement-breakpoint
ALTER TABLE biblib.books ADD CONSTRAINT books_owner_shelf_fk
  FOREIGN KEY (user_id, shelf_id) REFERENCES biblib.shelves(user_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE biblib.books ADD CONSTRAINT books_pages_check CHECK (number_of_pages BETWEEN 0 AND 100000);
--> statement-breakpoint
ALTER TABLE biblib.books ADD CONSTRAINT books_title_check CHECK (length(btrim(title)) BETWEEN 1 AND 500);
--> statement-breakpoint
ALTER TABLE biblib.shelves ADD CONSTRAINT shelves_title_check CHECK (length(btrim(title)) BETWEEN 1 AND 120);
--> statement-breakpoint
ALTER POLICY shelves_update_own ON biblib.shelves
  USING (user_id = auth.uid() AND NOT is_default)
  WITH CHECK (user_id = auth.uid() AND NOT is_default);
--> statement-breakpoint
ALTER POLICY shelves_delete_own ON biblib.shelves
  USING (user_id = auth.uid() AND NOT is_default);

CREATE SCHEMA IF NOT EXISTS biblib;

CREATE TABLE IF NOT EXISTS biblib.shelves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shelves_user_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS shelves_user_id_title_unique
  ON biblib.shelves (user_id, title);

CREATE UNIQUE INDEX IF NOT EXISTS shelves_user_id_default_unique
  ON biblib.shelves (user_id, is_default)
  WHERE is_default = true;

CREATE TABLE IF NOT EXISTS biblib.books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  isbn text NOT NULL,
  title text NOT NULL,
  subtitle text,
  authors jsonb NOT NULL DEFAULT '[]'::jsonb,
  publishers jsonb NOT NULL DEFAULT '[]'::jsonb,
  number_of_pages integer NOT NULL DEFAULT 0,
  publish_date text NOT NULL DEFAULT '',
  cover_small text NOT NULL DEFAULT '/default-book-cover.webp',
  cover_medium text NOT NULL DEFAULT '/default-book-cover.webp',
  cover_large text NOT NULL DEFAULT '/default-book-cover.webp',
  status text NOT NULL DEFAULT 'unread',
  shelf_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT books_user_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT books_shelf_fk FOREIGN KEY (shelf_id) REFERENCES biblib.shelves(id) ON DELETE RESTRICT,
  CONSTRAINT books_status_check CHECK (status IN ('read', 'reading', 'unread', 'to-read'))
);

CREATE UNIQUE INDEX IF NOT EXISTS books_user_id_isbn_unique
  ON biblib.books (user_id, isbn);

CREATE INDEX IF NOT EXISTS books_user_id_idx
  ON biblib.books (user_id);

CREATE INDEX IF NOT EXISTS books_shelf_id_idx
  ON biblib.books (shelf_id);

ALTER TABLE biblib.shelves ENABLE ROW LEVEL SECURITY;
ALTER TABLE biblib.books ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shelves_select_own ON biblib.shelves;
DROP POLICY IF EXISTS shelves_insert_own ON biblib.shelves;
DROP POLICY IF EXISTS shelves_update_own ON biblib.shelves;
DROP POLICY IF EXISTS shelves_delete_own ON biblib.shelves;

CREATE POLICY shelves_select_own
  ON biblib.shelves
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY shelves_insert_own
  ON biblib.shelves
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY shelves_update_own
  ON biblib.shelves
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY shelves_delete_own
  ON biblib.shelves
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS books_select_own ON biblib.books;
DROP POLICY IF EXISTS books_insert_own ON biblib.books;
DROP POLICY IF EXISTS books_update_own ON biblib.books;
DROP POLICY IF EXISTS books_delete_own ON biblib.books;

CREATE POLICY books_select_own
  ON biblib.books
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY books_insert_own
  ON biblib.books
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY books_update_own
  ON biblib.books
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY books_delete_own
  ON biblib.books
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

GRANT USAGE ON SCHEMA biblib TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON biblib.shelves TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON biblib.books TO authenticated;

-- U-DAT-06 · 0010 (expandir + backfill + comparar). Primera de dos migraciones: crea obras, ediciones y
-- ejemplares, los rellena desde `books` y los mantiene sincronizados mientras `books` siga siendo la
-- tabla que escribe la aplicación anterior. Compatible con el código de 0009: se puede aplicar, revisar
-- el informe y la comparación y, solo entonces, aplicar 0011 (cambio de lecturas y escrituras). Si la
-- comparación encuentra una sola diferencia, la migración falla y el ledger no avanza.
--
-- ISBN-13 canónico de un ISBN-10/13 válido (mismo cálculo que `normalizeIsbn` de lib/isbn.ts); null si no
-- lo es. Inmutable: lo usan la restricción de `editions.isbn13`, el backfill y la sincronización.
CREATE FUNCTION "biblib"."isbn13_normalize"(p_value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
DECLARE
  digits text := upper(regexp_replace(coalesce(p_value, ''), '[[:space:]-]', '', 'g'));
  total integer := 0;
  prefix text;
BEGIN
  IF digits ~ '^[0-9]{9}[0-9X]$' THEN
    FOR i IN 1..10 LOOP
      total := total + (CASE WHEN substr(digits, i, 1) = 'X' THEN 10 ELSE substr(digits, i, 1)::integer END) * (11 - i);
    END LOOP;
    IF total % 11 <> 0 THEN
      RETURN NULL;
    END IF;
    prefix := '978' || substr(digits, 1, 9);
    total := 0;
    FOR i IN 1..12 LOOP
      total := total + substr(prefix, i, 1)::integer * (CASE WHEN i % 2 = 0 THEN 3 ELSE 1 END);
    END LOOP;
    RETURN prefix || ((10 - total % 10) % 10)::text;
  END IF;
  IF digits !~ '^97[89][0-9]{10}$' THEN
    RETURN NULL;
  END IF;
  FOR i IN 1..13 LOOP
    total := total + substr(digits, i, 1)::integer * (CASE WHEN i % 2 = 0 THEN 3 ELSE 1 END);
  END LOOP;
  RETURN CASE WHEN total % 10 = 0 THEN digits END;
END;
$$;
--> statement-breakpoint
CREATE TABLE "biblib"."copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"edition_id" uuid NOT NULL,
	"status" text DEFAULT 'unread' NOT NULL,
	"shelf_id" uuid NOT NULL,
	"edition_verification" jsonb DEFAULT '{"isbnVerified":false}'::jsonb NOT NULL,
	"legacy_identifier" text,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copies_status_check" CHECK ("biblib"."copies"."status" in ('read', 'reading', 'unread', 'to-read')),
	CONSTRAINT "copies_verification_check" CHECK (jsonb_typeof("biblib"."copies"."edition_verification") = 'object' and jsonb_typeof("biblib"."copies"."edition_verification"->'isbnVerified') = 'boolean'),
	CONSTRAINT "copies_legacy_identifier_check" CHECK ("biblib"."copies"."legacy_identifier" is null or length(btrim("biblib"."copies"."legacy_identifier")) between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "biblib"."copies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."editions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"work_id" uuid,
	"isbn13" text,
	"title" text NOT NULL,
	"subtitle" text,
	"authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"publishers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"publish_date" text DEFAULT '' NOT NULL,
	"number_of_pages" integer DEFAULT 0 NOT NULL,
	"language" text,
	"identifiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"catalogue" jsonb DEFAULT '{"source":"import"}'::jsonb NOT NULL,
	"cover_small" text DEFAULT '/default-book-cover.webp' NOT NULL,
	"cover_medium" text DEFAULT '/default-book-cover.webp' NOT NULL,
	"cover_large" text DEFAULT '/default-book-cover.webp' NOT NULL,
	"cover_asset_id" uuid,
	"search_text" text GENERATED ALWAYS AS (translate(lower(title || ' ' || coalesce(subtitle, '') || ' ' || authors::text || ' ' || coalesce(isbn13, '')), 'áéíóúüñ', 'aeiouun')) STORED,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "editions_isbn13_check" CHECK ("biblib"."editions"."isbn13" is null or biblib.isbn13_normalize("biblib"."editions"."isbn13") is not distinct from "biblib"."editions"."isbn13"),
	CONSTRAINT "editions_title_check" CHECK (length(btrim("biblib"."editions"."title")) between 1 and 500),
	CONSTRAINT "editions_pages_check" CHECK ("biblib"."editions"."number_of_pages" between 0 and 100000),
	CONSTRAINT "editions_language_check" CHECK ("biblib"."editions"."language" is null or "biblib"."editions"."language" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
	CONSTRAINT "editions_identifiers_check" CHECK (jsonb_typeof("biblib"."editions"."identifiers") = 'object'),
	CONSTRAINT "editions_catalogue_check" CHECK (jsonb_typeof("biblib"."editions"."catalogue") = 'object' and not "biblib"."editions"."catalogue" ? 'isbnVerified')
);
--> statement-breakpoint
ALTER TABLE "biblib"."editions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."model_migration_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"migration" text NOT NULL,
	"kind" text NOT NULL,
	"copy_id" uuid,
	"other_copy_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_migration_report_kind_check" CHECK ("biblib"."model_migration_report"."kind" in ('summary', 'normalized', 'invalid', 'conflict', 'grouped')),
	CONSTRAINT "model_migration_report_details_check" CHECK (jsonb_typeof("biblib"."model_migration_report"."details") = 'object')
);
--> statement-breakpoint
ALTER TABLE "biblib"."model_migration_report" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."works" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "works_title_check" CHECK (length(btrim("biblib"."works"."title")) between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "biblib"."works" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Índices antes de las FK compuestas: (user_id, id) es el destino de las FK con propietario.
CREATE UNIQUE INDEX "copies_user_id_id_unique" ON "biblib"."copies" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "copies_user_legacy_identifier_unique" ON "biblib"."copies" USING btree ("user_id","legacy_identifier") WHERE "biblib"."copies"."legacy_identifier" is not null;--> statement-breakpoint
CREATE INDEX "copies_user_edition_idx" ON "biblib"."copies" USING btree ("user_id","edition_id");--> statement-breakpoint
CREATE INDEX "copies_user_shelf_idx" ON "biblib"."copies" USING btree ("user_id","shelf_id");--> statement-breakpoint
CREATE INDEX "copies_user_created_idx" ON "biblib"."copies" USING btree ("user_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "editions_user_id_id_unique" ON "biblib"."editions" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "editions_user_isbn13_unique" ON "biblib"."editions" USING btree ("user_id","isbn13") WHERE "biblib"."editions"."isbn13" is not null;--> statement-breakpoint
CREATE INDEX "editions_user_title_idx" ON "biblib"."editions" USING btree ("user_id","title","id");--> statement-breakpoint
CREATE INDEX "editions_user_work_idx" ON "biblib"."editions" USING btree ("user_id","work_id") WHERE "biblib"."editions"."work_id" is not null;--> statement-breakpoint
CREATE INDEX "editions_cover_asset_idx" ON "biblib"."editions" USING btree ("user_id","cover_asset_id") WHERE "biblib"."editions"."cover_asset_id" is not null;--> statement-breakpoint
CREATE INDEX "model_migration_report_user_idx" ON "biblib"."model_migration_report" USING btree ("user_id","migration","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "works_user_id_id_unique" ON "biblib"."works" USING btree ("user_id","id");--> statement-breakpoint
ALTER TABLE "biblib"."copies" ADD CONSTRAINT "copies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."copies" ADD CONSTRAINT "copies_owner_edition_fk" FOREIGN KEY ("user_id","edition_id") REFERENCES "biblib"."editions"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."copies" ADD CONSTRAINT "copies_owner_shelf_fk" FOREIGN KEY ("user_id","shelf_id") REFERENCES "biblib"."shelves"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."editions" ADD CONSTRAINT "editions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."editions" ADD CONSTRAINT "editions_owner_work_fk" FOREIGN KEY ("user_id","work_id") REFERENCES "biblib"."works"("user_id","id") ON DELETE SET NULL ("work_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."editions" ADD CONSTRAINT "editions_owner_cover_asset_fk" FOREIGN KEY ("user_id","cover_asset_id") REFERENCES "biblib"."cover_assets"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."model_migration_report" ADD CONSTRAINT "model_migration_report_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."works" ADD CONSTRAINT "works_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "copies_select_own" ON "biblib"."copies" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."copies"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "copies_insert_own" ON "biblib"."copies" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."copies"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "copies_update_own" ON "biblib"."copies" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("biblib"."copies"."user_id" = (select auth.uid())) WITH CHECK ("biblib"."copies"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "copies_delete_own" ON "biblib"."copies" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."copies"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "editions_select_own" ON "biblib"."editions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."editions"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "editions_insert_own" ON "biblib"."editions" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."editions"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "editions_update_own" ON "biblib"."editions" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("biblib"."editions"."user_id" = (select auth.uid())) WITH CHECK ("biblib"."editions"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "editions_delete_own" ON "biblib"."editions" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."editions"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "model_migration_report_select_own" ON "biblib"."model_migration_report" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."model_migration_report"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "works_select_own" ON "biblib"."works" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."works"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "works_insert_own" ON "biblib"."works" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."works"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "works_update_own" ON "biblib"."works" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("biblib"."works"."user_id" = (select auth.uid())) WITH CHECK ("biblib"."works"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "works_delete_own" ON "biblib"."works" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."works"."user_id" = (select auth.uid()));
--> statement-breakpoint
-- U-DAT-06: privilegios. El dueño trabaja con RLS sobre obras, ediciones y ejemplares; el informe solo se lee.
REVOKE ALL ON "biblib"."works", "biblib"."editions", "biblib"."copies", "biblib"."model_migration_report" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "biblib"."works", "biblib"."editions", "biblib"."copies" TO authenticated;
--> statement-breakpoint
GRANT SELECT ON "biblib"."model_migration_report" TO authenticated;
--> statement-breakpoint
-- La restricción de editions.isbn13 la evalúa el rol que escribe.
REVOKE ALL ON FUNCTION "biblib"."isbn13_normalize"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "biblib"."isbn13_normalize"(text) TO authenticated;
--> statement-breakpoint
-- Mismos tokens y misma revisión de colección que `books`: cualquier escritura de obra, edición o
-- ejemplar renueva su versión y rota la revisión del dueño una vez por transacción.
CREATE TRIGGER "works_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."works"
FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();
--> statement-breakpoint
CREATE TRIGGER "editions_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."editions"
FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();
--> statement-breakpoint
CREATE TRIGGER "copies_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."copies"
FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();
--> statement-breakpoint
CREATE TRIGGER "works_rotate_library_revision" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."works"
FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_library_revision"();
--> statement-breakpoint
CREATE TRIGGER "editions_rotate_library_revision" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."editions"
FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_library_revision"();
--> statement-breakpoint
CREATE TRIGGER "copies_rotate_library_revision" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."copies"
FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_library_revision"();
--> statement-breakpoint
-- La portada privada se adjunta a la edición con la misma guarda que tenía la ficha (0009).
CREATE TRIGGER "editions_guard_cover_asset" BEFORE UPDATE ON "biblib"."editions"
FOR EACH ROW EXECUTE FUNCTION "biblib"."guard_book_cover_asset"();
--> statement-breakpoint
-- Una edición sin ejemplares y una obra sin ediciones no se conservan: al retirar o mover el último
-- ejemplar se retira su edición, y al retirar la última edición, su obra. Por sentencia, para que
-- reemplazar o restaurar una colección no ejecute una comprobación por fila.
CREATE FUNCTION "biblib"."prune_orphan_editions"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  DELETE FROM biblib.editions AS e
  USING (SELECT DISTINCT p.user_id, p.edition_id FROM previous AS p) AS gone
  WHERE e.user_id = gone.user_id AND e.id = gone.edition_id
    AND NOT EXISTS (SELECT 1 FROM biblib.copies AS c WHERE c.user_id = e.user_id AND c.edition_id = e.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "biblib"."prune_orphan_works"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  DELETE FROM biblib.works AS w
  USING (SELECT DISTINCT p.user_id, p.work_id FROM previous AS p WHERE p.work_id IS NOT NULL) AS gone
  WHERE w.user_id = gone.user_id AND w.id = gone.work_id
    AND NOT EXISTS (SELECT 1 FROM biblib.editions AS e WHERE e.user_id = w.user_id AND e.work_id = w.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "copies_prune_editions_delete" AFTER DELETE ON "biblib"."copies"
REFERENCING OLD TABLE AS previous FOR EACH STATEMENT EXECUTE FUNCTION "biblib"."prune_orphan_editions"();
--> statement-breakpoint
CREATE TRIGGER "copies_prune_editions_update" AFTER UPDATE ON "biblib"."copies"
REFERENCING OLD TABLE AS previous FOR EACH STATEMENT EXECUTE FUNCTION "biblib"."prune_orphan_editions"();
--> statement-breakpoint
CREATE TRIGGER "editions_prune_works_delete" AFTER DELETE ON "biblib"."editions"
REFERENCING OLD TABLE AS previous FOR EACH STATEMENT EXECUTE FUNCTION "biblib"."prune_orphan_works"();
--> statement-breakpoint
CREATE TRIGGER "editions_prune_works_update" AFTER UPDATE ON "biblib"."editions"
REFERENCING OLD TABLE AS previous FOR EACH STATEMENT EXECUTE FUNCTION "biblib"."prune_orphan_works"();
--> statement-breakpoint
-- Al confirmar, toda edición tiene al menos un ejemplar (también si la escribe SQL directa).
CREATE FUNCTION "biblib"."edition_requires_copy"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM biblib.editions AS e WHERE e.id = NEW.id)
    AND NOT EXISTS (SELECT 1 FROM biblib.copies AS c WHERE c.user_id = NEW.user_id AND c.edition_id = NEW.id) THEN
    RAISE EXCEPTION 'Una edición necesita al menos un ejemplar' USING ERRCODE = 'BM001';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."prune_orphan_editions"(), "biblib"."prune_orphan_works"(), "biblib"."edition_requires_copy"() FROM PUBLIC, authenticated;
--> statement-breakpoint
-- Sincronización durante la ventana de expansión: mientras la aplicación anterior escriba `books`, cada
-- ficha se refleja en una edición y un ejemplar con su mismo ID. Una equivalencia ISBN-10/13 que ya ocupa
-- otra edición no se fusiona aquí: queda sin ISBN-13, con el valor original como identificador legacy y
-- en el informe (la agrupación de equivalencias compatibles la hace 0011 con `books` ya congelada).
CREATE FUNCTION "biblib"."model_sync_book"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  candidate text;
  taken uuid;
  verified boolean;
BEGIN
  IF TG_OP = 'DELETE' OR NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id THEN
    DELETE FROM biblib.copies AS c WHERE c.id = OLD.id AND c.user_id = OLD.user_id;
    IF TG_OP = 'DELETE' THEN
      RETURN NULL;
    END IF;
  END IF;
  candidate := biblib.isbn13_normalize(NEW.isbn);
  IF candidate IS NOT NULL THEN
    SELECT e.id INTO taken FROM biblib.editions AS e WHERE e.user_id = NEW.user_id AND e.isbn13 = candidate AND e.id <> NEW.id;
    IF FOUND THEN
      INSERT INTO biblib.model_migration_report (user_id, migration, kind, copy_id, other_copy_id, details)
      VALUES (NEW.user_id, '0010_works_editions_copies', 'conflict', NEW.id, taken, jsonb_build_object('isbn13', candidate, 'source', NEW.isbn, 'during', 'sync'));
      candidate := NULL;
    END IF;
  END IF;
  verified := coalesce(NEW.catalogue->'isbnVerified' = 'true'::jsonb, false);
  INSERT INTO biblib.editions AS e (id, user_id, isbn13, title, subtitle, authors, publishers, publish_date, number_of_pages, catalogue,
    cover_small, cover_medium, cover_large, cover_asset_id, created_at, updated_at)
  VALUES (NEW.id, NEW.user_id, candidate, NEW.title, NEW.subtitle, NEW.authors, NEW.publishers, NEW.publish_date, NEW.number_of_pages,
    NEW.catalogue - 'isbnVerified', NEW.cover_small, NEW.cover_medium, NEW.cover_large, NEW.cover_asset_id, NEW.created_at, NEW.updated_at)
  ON CONFLICT (id) DO UPDATE SET isbn13 = excluded.isbn13, title = excluded.title, subtitle = excluded.subtitle, authors = excluded.authors,
    publishers = excluded.publishers, publish_date = excluded.publish_date, number_of_pages = excluded.number_of_pages, catalogue = excluded.catalogue,
    cover_small = excluded.cover_small, cover_medium = excluded.cover_medium, cover_large = excluded.cover_large, cover_asset_id = excluded.cover_asset_id,
    updated_at = excluded.updated_at;
  INSERT INTO biblib.copies AS c (id, user_id, edition_id, status, shelf_id, edition_verification, legacy_identifier, created_at, updated_at)
  VALUES (NEW.id, NEW.user_id, NEW.id, NEW.status, NEW.shelf_id, jsonb_build_object('isbnVerified', verified),
    CASE WHEN candidate IS NULL AND btrim(NEW.isbn) <> '' THEN NEW.isbn END, NEW.created_at, NEW.updated_at)
  ON CONFLICT (id) DO UPDATE SET edition_id = excluded.edition_id, status = excluded.status, shelf_id = excluded.shelf_id,
    edition_verification = excluded.edition_verification, legacy_identifier = excluded.legacy_identifier, updated_at = excluded.updated_at;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."model_sync_book"() FROM PUBLIC, authenticated;
--> statement-breakpoint
-- Comparación ficha a ficha entre `books` y el modelo, por cuenta (`p_owner`) o de todas (null). Una
-- ficha coincide si conserva ID, dueño, identificador (el mismo texto o su ISBN-13 equivalente), datos
-- bibliográficos, portadas, estado, estantería, fecha de alta y procedencia, con la comprobación física
-- en el ejemplar. Devuelve recuentos y hasta 20 IDs distintos; ningún título ni ISBN. Solo servidor.
CREATE FUNCTION "biblib"."model_compare"(p_owner uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  result jsonb;
BEGIN
  WITH legacy AS (
    SELECT b.* FROM biblib.books AS b WHERE p_owner IS NULL OR b.user_id = p_owner
  ), model AS (
    SELECT c.id, c.user_id, c.status, c.shelf_id, c.created_at, c.legacy_identifier, c.edition_verification, e.isbn13, e.title, e.subtitle,
      e.authors, e.publishers, e.number_of_pages, e.publish_date, e.catalogue, e.cover_small, e.cover_medium, e.cover_large, e.cover_asset_id
    FROM biblib.copies AS c JOIN biblib.editions AS e ON e.user_id = c.user_id AND e.id = c.edition_id
    WHERE p_owner IS NULL OR c.user_id = p_owner
  ), diff AS (
    SELECT coalesce(l.id, m.id) AS id
    FROM legacy AS l FULL JOIN model AS m ON m.id = l.id
    WHERE NOT coalesce(l.id IS NOT NULL AND m.id IS NOT NULL AND l.user_id = m.user_id
      AND (l.isbn = coalesce(m.legacy_identifier, m.isbn13)
        OR (m.legacy_identifier IS NULL AND m.isbn13 = biblib.isbn13_normalize(l.isbn))
        OR (btrim(l.isbn) = '' AND m.legacy_identifier IS NULL AND m.isbn13 IS NULL))
      AND l.title = m.title AND l.subtitle IS NOT DISTINCT FROM m.subtitle AND l.authors = m.authors AND l.publishers = m.publishers
      AND l.number_of_pages = m.number_of_pages AND l.publish_date = m.publish_date
      AND l.cover_small = m.cover_small AND l.cover_medium = m.cover_medium AND l.cover_large = m.cover_large
      AND l.cover_asset_id IS NOT DISTINCT FROM m.cover_asset_id
      AND l.status = m.status AND l.shelf_id = m.shelf_id AND l.created_at = m.created_at
      AND l.catalogue - 'isbnVerified' = m.catalogue
      AND coalesce(l.catalogue->'isbnVerified' = 'true'::jsonb, false) = (m.edition_verification->'isbnVerified' = 'true'::jsonb), false)
  )
  SELECT jsonb_build_object(
    'books', (SELECT count(*) FROM legacy),
    'copies', (SELECT count(*) FROM model),
    'editions', (SELECT count(*) FROM biblib.editions AS e WHERE p_owner IS NULL OR e.user_id = p_owner),
    'works', (SELECT count(*) FROM biblib.works AS w WHERE p_owner IS NULL OR w.user_id = p_owner),
    'accounts', (SELECT count(DISTINCT l.user_id) FROM legacy AS l),
    'mismatches', (SELECT count(*) FROM diff),
    'sample', coalesce((SELECT jsonb_agg(d.id ORDER BY d.id) FROM (SELECT id FROM diff ORDER BY id LIMIT 20) AS d), '[]'::jsonb))
  INTO result;
  RETURN result;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."model_compare"(uuid) FROM PUBLIC, authenticated;
--> statement-breakpoint
-- Backfill. Cada ficha conserva su ID como ejemplar y como edición (namespaces distintos), con obra
-- desconocida. Entre fichas de una cuenta con el mismo ISBN-13 normalizado gana la que ya tenía la forma
-- canónica, después la más antigua y por último el ID; las demás quedan sin ISBN-13, con su texto
-- original como identificador legacy y una fila `conflict` en el informe. Ninguna ficha se descarta.
CREATE TEMPORARY TABLE "model_backfill" AS
SELECT ranked.id, ranked.user_id, ranked.raw, ranked.candidate, ranked.rank, ranked.winner
FROM (
  SELECT b.id, b.user_id, b.isbn AS raw, biblib.isbn13_normalize(b.isbn) AS candidate,
    row_number() OVER w AS rank, first_value(b.id) OVER w AS winner
  FROM biblib.books AS b
  WINDOW w AS (PARTITION BY b.user_id, biblib.isbn13_normalize(b.isbn) ORDER BY (b.isbn = biblib.isbn13_normalize(b.isbn)) DESC, b.created_at, b.id)
) AS ranked;
--> statement-breakpoint
INSERT INTO "biblib"."editions" (id, user_id, isbn13, title, subtitle, authors, publishers, publish_date, number_of_pages, catalogue,
  cover_small, cover_medium, cover_large, cover_asset_id, created_at, updated_at)
SELECT b.id, b.user_id, CASE WHEN m.rank = 1 THEN m.candidate END, b.title, b.subtitle, b.authors, b.publishers, b.publish_date, b.number_of_pages,
  b.catalogue - 'isbnVerified', b.cover_small, b.cover_medium, b.cover_large, b.cover_asset_id, b.created_at, b.updated_at
FROM "biblib"."books" AS b JOIN pg_temp.model_backfill AS m ON m.id = b.id;
--> statement-breakpoint
INSERT INTO "biblib"."copies" (id, user_id, edition_id, status, shelf_id, edition_verification, legacy_identifier, created_at, updated_at)
SELECT b.id, b.user_id, b.id, b.status, b.shelf_id, jsonb_build_object('isbnVerified', coalesce(b.catalogue->'isbnVerified' = 'true'::jsonb, false)),
  CASE WHEN (m.candidate IS NULL OR m.rank > 1) AND btrim(b.isbn) <> '' THEN b.isbn END, b.created_at, b.updated_at
FROM "biblib"."books" AS b JOIN pg_temp.model_backfill AS m ON m.id = b.id;
--> statement-breakpoint
-- Informe: equivalencias en conflicto, ISBN reescritos a su forma canónica e identificadores que no son
-- ISBN ni `manual-…`, más un resumen por cuenta. Los IDs bastan para revisarlos desde la cuenta.
INSERT INTO "biblib"."model_migration_report" (user_id, migration, kind, copy_id, other_copy_id, details)
SELECT m.user_id, '0010_works_editions_copies', 'conflict', m.id, m.winner, jsonb_build_object('isbn13', m.candidate, 'source', m.raw, 'during', 'backfill')
FROM pg_temp.model_backfill AS m WHERE m.candidate IS NOT NULL AND m.rank > 1;
--> statement-breakpoint
INSERT INTO "biblib"."model_migration_report" (user_id, migration, kind, copy_id, details)
SELECT m.user_id, '0010_works_editions_copies', 'normalized', m.id, jsonb_build_object('isbn13', m.candidate, 'source', m.raw)
FROM pg_temp.model_backfill AS m WHERE m.candidate IS NOT NULL AND m.rank = 1 AND m.raw <> m.candidate;
--> statement-breakpoint
INSERT INTO "biblib"."model_migration_report" (user_id, migration, kind, copy_id, details)
SELECT m.user_id, '0010_works_editions_copies', 'invalid', m.id, jsonb_build_object('source', m.raw)
FROM pg_temp.model_backfill AS m WHERE m.candidate IS NULL AND m.raw !~ '^manual-';
--> statement-breakpoint
INSERT INTO "biblib"."model_migration_report" (user_id, migration, kind, details)
SELECT m.user_id, '0010_works_editions_copies', 'summary', jsonb_build_object(
  'books', count(*), 'copies', count(*), 'editions', count(*), 'works', 0,
  'conflicts', count(*) FILTER (WHERE m.candidate IS NOT NULL AND m.rank > 1),
  'normalized', count(*) FILTER (WHERE m.candidate IS NOT NULL AND m.rank = 1 AND m.raw <> m.candidate),
  'invalid', count(*) FILTER (WHERE m.candidate IS NULL AND m.raw !~ '^manual-'),
  'manual', count(*) FILTER (WHERE m.raw ~ '^manual-'),
  'withIsbn13', count(*) FILTER (WHERE m.candidate IS NOT NULL AND m.rank = 1))
FROM pg_temp.model_backfill AS m GROUP BY m.user_id;
--> statement-breakpoint
DROP TABLE pg_temp.model_backfill;
--> statement-breakpoint
-- Tras el backfill (cada edición ya tiene su ejemplar), la regla se aplica a toda escritura nueva.
CREATE CONSTRAINT TRIGGER "editions_require_copy" AFTER INSERT ON "biblib"."editions"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "biblib"."edition_requires_copy"();
--> statement-breakpoint
CREATE TRIGGER "books_model_sync" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."books"
FOR EACH ROW EXECUTE FUNCTION "biblib"."model_sync_book"();
--> statement-breakpoint
-- Punto de recuperación: si una sola ficha no coincide, la migración entera se revierte.
DO $$
DECLARE
  compared jsonb := biblib.model_compare(NULL);
BEGIN
  IF (compared->>'mismatches')::integer <> 0 OR (compared->>'books')::integer <> (compared->>'copies')::integer THEN
    RAISE EXCEPTION 'El backfill del modelo no coincide con books (% diferencias)', compared->>'mismatches' USING ERRCODE = 'BM002';
  END IF;
END;
$$;

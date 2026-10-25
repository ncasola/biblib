-- U-DAT-06 · 0011 (cambiar lecturas y escrituras). Segunda de dos migraciones: con 0010 aplicada y comparada,
-- congela `books`, agrupa las equivalencias ISBN-10/13 compatibles, la retira como `books_legacy` (sin uso,
-- hasta su retirada en F4) y crea en su lugar la vista de compatibilidad `books`: el modelo de lectura plano
-- de un ejemplar con su edición. Las funciones que escribían `books` pasan a escribir la edición. Si la
-- comparación final con la copia congelada encuentra una diferencia, la migración entera se revierte.
--
-- 1. Congelar: ninguna escritura de la aplicación anterior entra durante el cambio; se retira la sincronización.
DO $$
BEGIN
  LOCK TABLE biblib.books IN ACCESS EXCLUSIVE MODE;
END;
$$;
--> statement-breakpoint
DROP TRIGGER "books_model_sync" ON "biblib"."books";
--> statement-breakpoint
DROP FUNCTION "biblib"."model_sync_book"();
--> statement-breakpoint
-- 2. Equivalencias compatibles: un ejemplar que conservó como identificador legacy un ISBN válido cuyo ISBN-13
-- ya tiene otra edición de la cuenta pasa a esa edición si todos los campos bibliográficos coinciden (mismos
-- datos visibles: nada cambia en su ficha). Si alguno difiere, sigue en conflicto para revisarlo. El informe
-- conserva el texto original de cada agrupación.
CREATE TEMPORARY TABLE "model_grouping" AS
SELECT c.id AS copy_id, c.user_id, w.id AS edition_id, w.isbn13, c.legacy_identifier AS source,
  (SELECT wc.id FROM biblib.copies AS wc WHERE wc.user_id = w.user_id AND wc.edition_id = w.id ORDER BY wc.created_at, wc.id LIMIT 1) AS winner_copy
FROM biblib.copies AS c
JOIN biblib.editions AS l ON l.user_id = c.user_id AND l.id = c.edition_id
JOIN biblib.editions AS w ON w.user_id = c.user_id AND w.isbn13 = biblib.isbn13_normalize(c.legacy_identifier) AND w.id <> l.id
WHERE c.legacy_identifier IS NOT NULL AND l.isbn13 IS NULL
  AND NOT EXISTS (SELECT 1 FROM biblib.copies AS o WHERE o.user_id = c.user_id AND o.edition_id = l.id AND o.id <> c.id)
  AND l.title = w.title AND l.subtitle IS NOT DISTINCT FROM w.subtitle AND l.authors = w.authors AND l.publishers = w.publishers
  AND l.publish_date = w.publish_date AND l.number_of_pages = w.number_of_pages AND l.catalogue = w.catalogue
  AND l.cover_small = w.cover_small AND l.cover_medium = w.cover_medium AND l.cover_large = w.cover_large
  AND l.cover_asset_id IS NOT DISTINCT FROM w.cover_asset_id AND l.work_id IS NOT DISTINCT FROM w.work_id
  AND l.language IS NOT DISTINCT FROM w.language AND l.identifiers = w.identifiers;
--> statement-breakpoint
-- La edición propia que queda sin ejemplares la retira la poda de 0010.
UPDATE "biblib"."copies" AS c SET edition_id = g.edition_id, legacy_identifier = NULL
FROM pg_temp.model_grouping AS g WHERE c.id = g.copy_id AND c.user_id = g.user_id;
--> statement-breakpoint
INSERT INTO "biblib"."model_migration_report" (user_id, migration, kind, copy_id, other_copy_id, details)
SELECT g.user_id, '0011_copies_cutover', 'grouped', g.copy_id, g.winner_copy, jsonb_build_object('isbn13', g.isbn13, 'source', g.source, 'edition', g.edition_id)
FROM pg_temp.model_grouping AS g;
--> statement-breakpoint
INSERT INTO "biblib"."model_migration_report" (user_id, migration, kind, details)
SELECT c.user_id, '0011_copies_cutover', 'summary', jsonb_build_object(
  'copies', count(*), 'editions', count(DISTINCT c.edition_id),
  'grouped', (SELECT count(*) FROM pg_temp.model_grouping AS g WHERE g.user_id = c.user_id),
  'conflicts', count(*) FILTER (WHERE c.legacy_identifier IS NOT NULL AND EXISTS (SELECT 1 FROM biblib.editions AS w
    WHERE w.user_id = c.user_id AND w.isbn13 = biblib.isbn13_normalize(c.legacy_identifier))),
  'withoutIsbn13', count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM biblib.editions AS e WHERE e.user_id = c.user_id AND e.id = c.edition_id AND e.isbn13 IS NOT NULL)),
  'works', (SELECT count(*) FROM biblib.works AS w WHERE w.user_id = c.user_id))
FROM biblib.copies AS c GROUP BY c.user_id;
--> statement-breakpoint
DROP TABLE pg_temp.model_grouping;
--> statement-breakpoint
-- 3. Retirar `books` como copia congelada: sin triggers, políticas, privilegios de cliente ni FK que bloqueen
-- borrar estanterías o portadas. Conserva PK, FK al dueño (borrar la cuenta la retira), unicidades y checks.
ALTER TABLE "biblib"."books" RENAME TO "books_legacy";
--> statement-breakpoint
DROP TRIGGER "books_rotate_version" ON "biblib"."books_legacy";
--> statement-breakpoint
DROP TRIGGER "books_rotate_library_revision" ON "biblib"."books_legacy";
--> statement-breakpoint
DROP TRIGGER "books_guard_cover_asset" ON "biblib"."books_legacy";
--> statement-breakpoint
DROP POLICY "books_select_own" ON "biblib"."books_legacy";
--> statement-breakpoint
DROP POLICY "books_insert_own" ON "biblib"."books_legacy";
--> statement-breakpoint
DROP POLICY "books_update_own" ON "biblib"."books_legacy";
--> statement-breakpoint
DROP POLICY "books_delete_own" ON "biblib"."books_legacy";
--> statement-breakpoint
ALTER TABLE "biblib"."books_legacy" DROP CONSTRAINT "books_owner_shelf_fk";
--> statement-breakpoint
ALTER TABLE "biblib"."books_legacy" DROP CONSTRAINT "books_owner_cover_asset_fk";
--> statement-breakpoint
DROP INDEX "biblib"."books_cover_asset_idx";
--> statement-breakpoint
DROP INDEX "biblib"."books_user_id_idx";
--> statement-breakpoint
DROP INDEX "biblib"."books_shelf_id_idx";
--> statement-breakpoint
DROP INDEX "biblib"."books_user_title_idx";
--> statement-breakpoint
DROP INDEX "biblib"."books_user_shelf_title_idx";
--> statement-breakpoint
DROP INDEX "biblib"."books_user_created_idx";
--> statement-breakpoint
REVOKE ALL ON "biblib"."books_legacy" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
COMMENT ON TABLE "biblib"."books_legacy" IS 'U-DAT-06: copia congelada de books antes de 0011. Sin uso; se retira en F4 tras la ventana definida en docs/operacion.md.';
--> statement-breakpoint
-- Comparación ficha a ficha con la copia congelada (misma regla que 0010). Tras el cambio, una diferencia
-- solo puede venir de una edición posterior de la persona; antes de abrir el servicio debe ser cero.
CREATE OR REPLACE FUNCTION "biblib"."model_compare"(p_owner uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  result jsonb;
BEGIN
  WITH legacy AS (
    SELECT b.* FROM biblib.books_legacy AS b WHERE p_owner IS NULL OR b.user_id = p_owner
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
-- 4. Vista de compatibilidad: el DTO plano de la interfaz (un ejemplar con su edición) con las columnas de la
-- tabla anterior y las del modelo. `version` es el token plano (cambia con el ejemplar o con su edición);
-- `isbn`, el ISBN-13 de la edición o el identificador legacy del ejemplar. security_invoker: RLS de las tablas.
CREATE VIEW "biblib"."books" WITH (security_invoker = true) AS
SELECT c.id, md5(c.version::text || e.version::text)::uuid AS version, c.user_id, coalesce(e.isbn13, c.legacy_identifier) AS isbn,
  e.title, e.subtitle, e.authors, e.publishers,
  e.catalogue || jsonb_build_object('isbnVerified', coalesce(c.edition_verification->'isbnVerified', 'false'::jsonb)) AS catalogue,
  e.number_of_pages, e.publish_date, e.cover_small, e.cover_medium, e.cover_large, c.status, c.shelf_id, e.cover_asset_id,
  c.created_at, greatest(c.updated_at, e.updated_at) AS updated_at,
  c.edition_id, c.version AS copy_version, e.version AS edition_version, e.isbn13, c.legacy_identifier, c.edition_verification,
  e.work_id, w.title AS work_title, e.language, e.identifiers, e.search_text,
  (SELECT count(*)::integer FROM biblib.copies AS s WHERE s.user_id = c.user_id AND s.edition_id = c.edition_id) AS edition_copies
FROM biblib.copies AS c
JOIN biblib.editions AS e ON e.user_id = c.user_id AND e.id = c.edition_id
LEFT JOIN biblib.works AS w ON w.user_id = e.user_id AND w.id = e.work_id;
--> statement-breakpoint
COMMENT ON VIEW "biblib"."books" IS 'U-DAT-06: modelo de lectura plano (ejemplar + edición). La aplicación solo la lee; las escrituras van a copies/editions/works.';
--> statement-breakpoint
-- Escrituras de compatibilidad para scripts y SQL que todavía escriben `books`: un alta crea edición y ejemplar
-- (o un ejemplar de una edición existente si se indica edition_id); el texto `isbn` se traduce como en el
-- backfill. Se ejecutan con los privilegios y la RLS de quien escribe. Cambiar datos bibliográficos de una
-- edición compartida por varios ejemplares por esta vía se rechaza: lo hace el contrato de edición, que
-- informa de cuántos ejemplares afecta.
CREATE FUNCTION "biblib"."books_view_insert"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  copy_id uuid := coalesce(NEW.id, gen_random_uuid());
  target uuid := NEW.edition_id;
  candidate text := coalesce(NEW.isbn13, biblib.isbn13_normalize(NEW.isbn));
  legacy text := coalesce(NEW.legacy_identifier, CASE WHEN biblib.isbn13_normalize(NEW.isbn) IS NULL AND btrim(coalesce(NEW.isbn, '')) <> '' THEN NEW.isbn END);
  verification jsonb := coalesce(NEW.edition_verification, jsonb_build_object('isbnVerified', coalesce(NEW.catalogue->'isbnVerified' = 'true'::jsonb, false)));
BEGIN
  IF target IS NULL OR NOT EXISTS (SELECT 1 FROM biblib.editions AS e WHERE e.user_id = NEW.user_id AND e.id = target) THEN
    target := coalesce(target, copy_id);
    INSERT INTO biblib.editions (id, user_id, work_id, isbn13, title, subtitle, authors, publishers, publish_date, number_of_pages, language, identifiers, catalogue,
      cover_small, cover_medium, cover_large, cover_asset_id, created_at, updated_at)
    VALUES (target, NEW.user_id, NEW.work_id, candidate, NEW.title, NEW.subtitle, coalesce(NEW.authors, '[]'::jsonb), coalesce(NEW.publishers, '[]'::jsonb),
      coalesce(NEW.publish_date, ''), coalesce(NEW.number_of_pages, 0), NEW.language, coalesce(NEW.identifiers, '{}'::jsonb),
      coalesce(NEW.catalogue, '{"source":"import"}'::jsonb) - 'isbnVerified', coalesce(NEW.cover_small, '/default-book-cover.webp'),
      coalesce(NEW.cover_medium, '/default-book-cover.webp'), coalesce(NEW.cover_large, '/default-book-cover.webp'), NEW.cover_asset_id,
      coalesce(NEW.created_at, now()), coalesce(NEW.updated_at, now()));
  END IF;
  INSERT INTO biblib.copies (id, user_id, edition_id, status, shelf_id, edition_verification, legacy_identifier, created_at, updated_at)
  VALUES (copy_id, NEW.user_id, target, coalesce(NEW.status, 'unread'), NEW.shelf_id, verification, legacy, coalesce(NEW.created_at, now()), coalesce(NEW.updated_at, now()));
  SELECT b.* INTO NEW FROM biblib.books AS b WHERE b.id = copy_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "biblib"."books_view_update"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  shared integer;
  candidate text := NEW.isbn13;
  legacy text := NEW.legacy_identifier;
  verification jsonb := NEW.edition_verification;
  stamp timestamptz := CASE WHEN NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN NEW.updated_at ELSE now() END;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.edition_id IS DISTINCT FROM OLD.edition_id THEN
    RAISE EXCEPTION 'La vista books no cambia el ejemplar, su dueño ni su edición' USING ERRCODE = '0A000';
  END IF;
  IF NEW.isbn IS DISTINCT FROM OLD.isbn THEN
    candidate := biblib.isbn13_normalize(NEW.isbn);
    legacy := CASE WHEN candidate IS NULL AND btrim(coalesce(NEW.isbn, '')) <> '' THEN NEW.isbn END;
  END IF;
  IF NEW.catalogue->'isbnVerified' IS DISTINCT FROM OLD.catalogue->'isbnVerified' AND NEW.edition_verification IS NOT DISTINCT FROM OLD.edition_verification THEN
    verification := OLD.edition_verification || jsonb_build_object('isbnVerified', coalesce(NEW.catalogue->'isbnVerified' = 'true'::jsonb, false));
  END IF;
  IF (candidate, NEW.title, NEW.subtitle, NEW.authors, NEW.publishers, NEW.publish_date, NEW.number_of_pages, NEW.catalogue - 'isbnVerified',
      NEW.cover_small, NEW.cover_medium, NEW.cover_large, NEW.cover_asset_id, NEW.work_id, NEW.language, NEW.identifiers)
    IS DISTINCT FROM (OLD.isbn13, OLD.title, OLD.subtitle, OLD.authors, OLD.publishers, OLD.publish_date, OLD.number_of_pages, OLD.catalogue - 'isbnVerified',
      OLD.cover_small, OLD.cover_medium, OLD.cover_large, OLD.cover_asset_id, OLD.work_id, OLD.language, OLD.identifiers) THEN
    SELECT count(*) INTO shared FROM biblib.copies AS c WHERE c.user_id = OLD.user_id AND c.edition_id = OLD.edition_id;
    IF shared > 1 THEN
      RAISE EXCEPTION 'La edición la comparten % ejemplares: cámbiala con el contrato de edición', shared USING ERRCODE = 'BM003';
    END IF;
    UPDATE biblib.editions AS e SET isbn13 = candidate, title = NEW.title, subtitle = NEW.subtitle, authors = NEW.authors, publishers = NEW.publishers,
      publish_date = NEW.publish_date, number_of_pages = NEW.number_of_pages, catalogue = NEW.catalogue - 'isbnVerified',
      cover_small = NEW.cover_small, cover_medium = NEW.cover_medium, cover_large = NEW.cover_large, cover_asset_id = NEW.cover_asset_id,
      work_id = NEW.work_id, language = NEW.language, identifiers = NEW.identifiers, updated_at = stamp
    WHERE e.user_id = OLD.user_id AND e.id = OLD.edition_id;
  END IF;
  -- Como en la tabla anterior, toda actualización renueva el token de la ficha aunque no cambie ningún dato.
  UPDATE biblib.copies AS c SET status = NEW.status, shelf_id = NEW.shelf_id, edition_verification = verification, legacy_identifier = legacy,
    created_at = NEW.created_at, updated_at = stamp
  WHERE c.user_id = OLD.user_id AND c.id = OLD.id;
  SELECT b.* INTO NEW FROM biblib.books AS b WHERE b.id = OLD.id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Retirar la ficha retira el ejemplar; si era el último de su edición, la poda retira la edición.
CREATE FUNCTION "biblib"."books_view_delete"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  DELETE FROM biblib.copies AS c WHERE c.user_id = OLD.user_id AND c.id = OLD.id;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "books_view_insert" INSTEAD OF INSERT ON "biblib"."books"
FOR EACH ROW EXECUTE FUNCTION "biblib"."books_view_insert"();
--> statement-breakpoint
CREATE TRIGGER "books_view_update" INSTEAD OF UPDATE ON "biblib"."books"
FOR EACH ROW EXECUTE FUNCTION "biblib"."books_view_update"();
--> statement-breakpoint
CREATE TRIGGER "books_view_delete" INSTEAD OF DELETE ON "biblib"."books"
FOR EACH ROW EXECUTE FUNCTION "biblib"."books_view_delete"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."books_view_insert"(), "biblib"."books_view_update"(), "biblib"."books_view_delete"() FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON "biblib"."books" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "biblib"."books" TO authenticated;
--> statement-breakpoint
-- 5. Operaciones idempotentes del modelo: crear ejemplar o edición, cambiar una edición y fusionar ediciones.
ALTER TABLE "biblib"."library_operations" DROP CONSTRAINT "library_operations_operation_check";
--> statement-breakpoint
ALTER TABLE "biblib"."library_operations" ADD CONSTRAINT "library_operations_operation_check" CHECK ("biblib"."library_operations"."operation" in ('import.confirm', 'snapshot.restore', 'restore.commit', 'copy.create', 'edition.create', 'edition.update', 'edition.merge'));
--> statement-breakpoint
-- 6. Funciones que leían o escribían `books`. Las versiones anteriores guardan el ejemplar plano con su edición
-- (schema_version 2): clave de edición, ISBN-13 o identificador legacy, comprobación con evidencias, obra,
-- idioma e identificadores. El hash y los trozos siguen el mismo cálculo que 0006.
CREATE OR REPLACE FUNCTION "biblib"."library_snapshot_capture"(p_operation_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  now_at timestamptz := clock_timestamp();
  captured uuid;
  new_id uuid;
  book_total integer;
  shelf_total integer;
  shelf_chunks integer;
  chunk_total integer;
  byte_total bigint;
  final_digest text;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'library_snapshot_capture requiere una sesión' USING ERRCODE = '42501';
  END IF;
  IF p_reason NOT IN ('import.replace', 'snapshot.restore') THEN
    RAISE EXCEPTION 'Motivo de captura no válido' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM biblib.library_operations AS o WHERE o.id = p_operation_id AND o.user_id = owner_id AND o.created_at = now()) THEN
    RAISE EXCEPTION 'La captura exige la operación de esta misma transacción' USING ERRCODE = '42501';
  END IF;
  IF NOT biblib.account_is_active(owner_id) THEN
    RAISE EXCEPTION 'La cuenta no admite versiones nuevas' USING ERRCODE = 'BS002';
  END IF;
  captured := biblib.lock_library();
  DELETE FROM biblib.library_snapshots AS s WHERE s.user_id = owner_id AND s.expires_at <= now_at;
  IF (SELECT count(*) FROM biblib.library_snapshots AS s WHERE s.user_id = owner_id) >= 10 THEN
    RAISE EXCEPTION 'Cuota de versiones anteriores agotada' USING ERRCODE = 'BS001';
  END IF;
  SELECT count(*) INTO book_total FROM biblib.copies AS c WHERE c.user_id = owner_id;
  SELECT count(*) INTO shelf_total FROM biblib.shelves AS sh WHERE sh.user_id = owner_id;
  IF book_total > 10000 OR shelf_total > 1000 THEN
    RAISE EXCEPTION 'Colección demasiado grande para guardar una versión anterior' USING ERRCODE = 'BS003';
  END IF;
  INSERT INTO biblib.library_snapshots AS s (user_id, source_operation_id, reason, captured_revision, schema_version, state, expires_at, created_at)
  VALUES (owner_id, p_operation_id, p_reason, captured, 2, 'capturing', now_at + interval '30 days', now_at)
  RETURNING s.id INTO new_id;
  shelf_chunks := (shelf_total + 199) / 200;
  INSERT INTO biblib.library_snapshot_chunks (snapshot_id, user_id, seq, kind, item_count, payload, digest)
  SELECT new_id, owner_id, grouped.seq, grouped.kind, grouped.n, grouped.payload, encode(sha256(convert_to(grouped.payload::text, 'UTF8')), 'hex')
  FROM (
    SELECT (ranked.rn / 200)::integer AS seq, 'shelves'::text AS kind, count(*)::integer AS n, jsonb_agg(ranked.item ORDER BY ranked.rn) AS payload
    FROM (
      SELECT row_number() OVER (ORDER BY sh.created_at, sh.id) - 1 AS rn,
        jsonb_build_object('id', sh.id, 'title', sh.title, 'is_default', sh.is_default, 'created_at', sh.created_at) AS item
      FROM biblib.shelves AS sh WHERE sh.user_id = owner_id
    ) AS ranked
    GROUP BY ranked.rn / 200
    UNION ALL
    SELECT shelf_chunks + (ranked.rn / 200)::integer, 'books', count(*)::integer, jsonb_agg(ranked.item ORDER BY ranked.rn)
    FROM (
      SELECT row_number() OVER (ORDER BY b.id) - 1 AS rn,
        jsonb_build_object('id', b.id, 'isbn', b.isbn13, 'title', b.title, 'subtitle', b.subtitle, 'authors', b.authors, 'publishers', b.publishers,
          'catalogue', b.catalogue, 'number_of_pages', b.number_of_pages, 'publish_date', b.publish_date, 'cover_small', b.cover_small,
          'cover_medium', b.cover_medium, 'cover_large', b.cover_large, 'status', b.status, 'shelf_id', b.shelf_id, 'created_at', b.created_at,
          'edition_id', b.edition_id, 'verification', b.edition_verification)
          || CASE WHEN b.cover_asset_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cover_asset_id', b.cover_asset_id) END
          || CASE WHEN b.legacy_identifier IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('legacy_identifier', b.legacy_identifier) END
          || CASE WHEN b.work_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('work_id', b.work_id, 'work_title', b.work_title) END
          || CASE WHEN b.language IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('language', b.language) END
          || CASE WHEN b.identifiers = '{}'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('identifiers', b.identifiers) END AS item
      FROM biblib.books AS b WHERE b.user_id = owner_id
    ) AS ranked
    GROUP BY ranked.rn / 200
  ) AS grouped;
  SELECT count(*)::integer, coalesce(sum(octet_length(c.payload::text)), 0),
    encode(sha256(convert_to(concat_ws('|', 'biblib.snapshot.v1', book_total, shelf_total, coalesce(string_agg(c.digest, '' ORDER BY c.seq), '')), 'UTF8')), 'hex')
  INTO chunk_total, byte_total, final_digest
  FROM biblib.library_snapshot_chunks AS c WHERE c.snapshot_id = new_id;
  UPDATE biblib.library_snapshots AS s
  SET state = 'ready', digest = final_digest,
    counts = jsonb_build_object('books', book_total, 'shelves', shelf_total, 'chunks', chunk_total, 'bytes', byte_total)
  WHERE s.id = new_id;
  RETURN jsonb_build_object('id', new_id, 'digest', final_digest, 'books', book_total, 'shelves', shelf_total, 'chunks', chunk_total);
END;
$$;
--> statement-breakpoint
-- IDs de una versión propia (ejemplares, sus ediciones y obras y estanterías) que hoy usa otra cuenta.
CREATE OR REPLACE FUNCTION "biblib"."library_snapshot_foreign_ids"(p_snapshot_id uuid) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  found uuid[];
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'library_snapshot_foreign_ids requiere una sesión' USING ERRCODE = '42501';
  END IF;
  WITH entry AS (
    SELECT c.kind, (item->>'id')::uuid AS id, coalesce(item->>'edition_id', item->>'id')::uuid AS edition_id, (item->>'work_id')::uuid AS work_id
    FROM biblib.library_snapshot_chunks AS c CROSS JOIN LATERAL jsonb_array_elements(c.payload) AS item
    WHERE c.snapshot_id = p_snapshot_id AND c.user_id = owner_id
  ), taken AS (
    SELECT entry.id FROM entry WHERE entry.kind = 'books' AND EXISTS (SELECT 1 FROM biblib.copies AS cp WHERE cp.id = entry.id AND cp.user_id <> owner_id)
    UNION
    SELECT entry.edition_id FROM entry WHERE entry.kind = 'books' AND EXISTS (SELECT 1 FROM biblib.editions AS e WHERE e.id = entry.edition_id AND e.user_id <> owner_id)
    UNION
    SELECT entry.work_id FROM entry WHERE entry.kind = 'books' AND entry.work_id IS NOT NULL AND EXISTS (SELECT 1 FROM biblib.works AS w WHERE w.id = entry.work_id AND w.user_id <> owner_id)
    UNION
    SELECT entry.id FROM entry WHERE entry.kind = 'shelves' AND EXISTS (SELECT 1 FROM biblib.shelves AS sh WHERE sh.id = entry.id AND sh.user_id <> owner_id)
  )
  SELECT coalesce(array_agg(taken.id ORDER BY taken.id), '{}'::uuid[]) INTO found FROM taken;
  RETURN found;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "biblib"."cover_asset_revalidate"(p_asset_id uuid, p_accept boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'cover_asset_revalidate requiere una sesión' USING ERRCODE = '42501';
  END IF;
  IF p_accept THEN
    UPDATE biblib.cover_assets AS a SET state = 'ready', version = gen_random_uuid(), updated_at = clock_timestamp()
    WHERE a.id = p_asset_id AND a.user_id = owner_id AND a.state = 'restored';
    RETURN CASE WHEN FOUND THEN 'ready' ELSE 'not_found' END;
  END IF;
  UPDATE biblib.editions AS e SET cover_asset_id = NULL, updated_at = clock_timestamp() WHERE e.user_id = owner_id AND e.cover_asset_id = p_asset_id;
  DELETE FROM biblib.cover_assets AS a WHERE a.id = p_asset_id AND a.user_id = owner_id AND a.state = 'restored';
  RETURN CASE WHEN FOUND THEN 'discarded' ELSE 'not_found' END;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "biblib"."cover_asset_purge_candidates"(p_owner uuid, p_limit integer, p_grace_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  max_rows integer := greatest(1, least(coalesce(p_limit, 100), 1000));
  grace interval := greatest(0, coalesce(p_grace_seconds, 86400)) * interval '1 second';
  assets jsonb;
  objects jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'owner', c.user_id, 'key', c.storage_key, 'reason', c.reason)), '[]'::jsonb) INTO assets
  FROM (
    SELECT a.id, a.user_id, a.storage_key,
      CASE WHEN a.state = 'quarantine' THEN 'quarantine' WHEN a.expires_at IS NOT NULL AND a.expires_at <= now_at THEN 'license' ELSE 'unreferenced' END AS reason
    FROM biblib.cover_assets AS a
    WHERE (p_owner IS NULL OR a.user_id = p_owner) AND (
      (a.state = 'quarantine' AND a.expires_at <= now_at)
      OR (a.state <> 'quarantine' AND a.expires_at IS NOT NULL AND a.expires_at <= now_at)
      OR (a.state <> 'quarantine' AND a.updated_at <= now_at - grace
        AND NOT EXISTS (SELECT 1 FROM biblib.editions AS e WHERE e.user_id = a.user_id AND e.cover_asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM biblib.library_snapshot_chunks AS sc CROSS JOIN LATERAL jsonb_array_elements(sc.payload) AS item
          WHERE sc.user_id = a.user_id AND sc.kind = 'books' AND item->>'cover_asset_id' = a.id::text)))
    ORDER BY a.updated_at
    LIMIT max_rows
  ) AS c;
  SELECT coalesce(jsonb_agg(jsonb_build_object('owner', split_part(o.name, '/', 1), 'key', o.name)), '[]'::jsonb) INTO objects
  FROM (
    SELECT so.name FROM storage.objects AS so
    WHERE so.bucket_id = 'biblib-covers' AND (p_owner IS NULL OR so.name LIKE p_owner::text || '/%')
      AND so.created_at <= now_at - interval '10 minutes'
      AND NOT EXISTS (SELECT 1 FROM biblib.cover_assets AS a WHERE a.storage_key = so.name AND a.state <> 'quarantine')
      AND NOT EXISTS (SELECT 1 FROM biblib.cover_assets AS a WHERE a.state = 'quarantine' AND a.expires_at > now_at
        AND a.storage_key IS NULL AND so.name = a.user_id::text || '/' || a.id::text || '/' || coalesce(a.upload_token, '') || '.webp')
    ORDER BY so.created_at
    LIMIT max_rows
  ) AS o;
  RETURN jsonb_build_object('assets', assets, 'objects', objects);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "biblib"."cover_asset_purge_confirm"(p_owner uuid, p_ids uuid[], p_grace_seconds integer) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  grace interval := greatest(0, coalesce(p_grace_seconds, 86400)) * interval '1 second';
  keys text[];
BEGIN
  PERFORM 1 FROM biblib.cover_assets AS a WHERE a.id = ANY(p_ids) AND (p_owner IS NULL OR a.user_id = p_owner) FOR UPDATE;
  UPDATE biblib.editions AS e SET cover_asset_id = NULL, updated_at = now_at
  FROM biblib.cover_assets AS a
  WHERE e.user_id = a.user_id AND e.cover_asset_id = a.id AND a.id = ANY(p_ids) AND (p_owner IS NULL OR a.user_id = p_owner)
    AND a.state <> 'quarantine' AND a.expires_at IS NOT NULL AND a.expires_at <= now_at;
  WITH removed AS (
    DELETE FROM biblib.cover_assets AS a
    WHERE a.id = ANY(p_ids) AND (p_owner IS NULL OR a.user_id = p_owner) AND (
      (a.state = 'quarantine' AND a.expires_at <= now_at)
      OR (a.state <> 'quarantine' AND a.expires_at IS NOT NULL AND a.expires_at <= now_at)
      OR (a.state <> 'quarantine' AND a.updated_at <= now_at - grace
        AND NOT EXISTS (SELECT 1 FROM biblib.editions AS e WHERE e.user_id = a.user_id AND e.cover_asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM biblib.library_snapshot_chunks AS sc CROSS JOIN LATERAL jsonb_array_elements(sc.payload) AS item
          WHERE sc.user_id = a.user_id AND sc.kind = 'books' AND item->>'cover_asset_id' = a.id::text)))
    RETURNING a.storage_key
  )
  SELECT coalesce(array_agg(r.storage_key) FILTER (WHERE r.storage_key IS NOT NULL), '{}'::text[]) INTO keys FROM removed AS r;
  RETURN keys;
END;
$$;
--> statement-breakpoint
-- 7. El cambio de modelo invalida las revisiones y vistas previas anteriores: se vuelven a preparar con los datos nuevos.
UPDATE "biblib"."library_state" SET revision = gen_random_uuid(), updated_at = now();
--> statement-breakpoint
-- Punto de recuperación: la copia congelada y el modelo deben coincidir ficha a ficha antes de abrir el servicio.
DO $$
DECLARE
  compared jsonb := biblib.model_compare(NULL);
BEGIN
  IF (compared->>'mismatches')::integer <> 0 OR (compared->>'books')::integer <> (compared->>'copies')::integer THEN
    RAISE EXCEPTION 'El modelo no coincide con books_legacy (% diferencias)', compared->>'mismatches' USING ERRCODE = 'BM002';
  END IF;
END;
$$;

-- U-DAT-06: tras 0011 (cambio de lecturas y escrituras). La vista plana `books`, la agrupación de
-- equivalencias compatibles, la copia congelada `books_legacy`, las funciones que leían o escribían `books`
-- y la protección de una edición compartida por varios ejemplares.
SELECT assert_true((SELECT relkind = 'v' FROM pg_class WHERE oid = 'biblib.books'::regclass), 'books es una vista');
SELECT assert_true((SELECT relkind = 'r' FROM pg_class WHERE oid = 'biblib.books_legacy'::regclass), 'books_legacy conserva la tabla anterior');
SELECT assert_true((SELECT (biblib.model_compare(NULL)->>'mismatches')::integer = 0), 'el modelo coincide con la copia congelada');
SELECT assert_true((SELECT count(*) FROM biblib.books) = (SELECT count(*) FROM biblib.books_legacy), 'la vista tiene una fila por ficha legacy');
SELECT assert_true(NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'biblib.books_legacy'::regclass AND NOT tgisinternal), 'books_legacy sin triggers');
SELECT assert_true(NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'biblib.books_legacy'::regclass), 'books_legacy sin políticas');
SELECT assert_true(NOT has_table_privilege('authenticated', 'biblib.books_legacy', 'SELECT') AND NOT has_table_privilege('authenticated', 'biblib.books_legacy', 'INSERT'), 'authenticated no usa books_legacy');
SELECT assert_true(NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'biblib.books_legacy'::regclass AND contype = 'f' AND confrelid <> 'auth.users'::regclass), 'books_legacy solo conserva la FK al dueño');
SELECT 'Correcto: books congelada como books_legacy y sustituida por la vista plana';

-- Equivalencias compatibles agrupadas: dos ejemplares del grupo 1 y dos del grupo 3 comparten edición; los
-- incompatibles siguen en conflicto con su texto original.
SELECT assert_true((SELECT c.edition_id = '3d000000-0000-4000-8000-0000000e0a01' AND c.legacy_identifier IS NULL FROM biblib.copies AS c WHERE c.id = '3d000000-0000-4000-8000-0000000e0a02'), 'el ISBN-10 compatible pasa a la edición canónica');
SELECT assert_true(NOT EXISTS (SELECT 1 FROM biblib.editions WHERE id = '3d000000-0000-4000-8000-0000000e0a02'), 'su edición propia se retira');
SELECT assert_true((SELECT b.isbn = '9780306406157' AND b.status = 'to-read' AND b.shelf_id = '20000000-0000-4000-8000-0000000002e1' AND NOT (b.catalogue->>'isbnVerified')::boolean AND b.edition_copies = 2
  FROM biblib.books AS b WHERE b.id = '3d000000-0000-4000-8000-0000000e0a02'), 'el ejemplar agrupado conserva estado, ubicación y su propia comprobación');
SELECT assert_true((SELECT (b.catalogue->>'isbnVerified')::boolean AND b.status = 'read' FROM biblib.books AS b WHERE b.id = '3d000000-0000-4000-8000-0000000e0a01'), 'el otro ejemplar conserva la suya');
SELECT assert_true((SELECT c.edition_id = '3d000000-0000-4000-8000-0000000e0d01' FROM biblib.copies AS c WHERE c.id = '3d000000-0000-4000-8000-0000000e0d02'), 'grupo 3: el ISBN-10 compatible se agrupa');
SELECT assert_true((SELECT c.edition_id = c.id AND c.legacy_identifier = '978-0-8044-2957-3' FROM biblib.copies AS c WHERE c.id = '3d000000-0000-4000-8000-0000000e0d03'), 'grupo 3: la paginación distinta sigue en conflicto');
SELECT assert_true((SELECT c.edition_id = c.id AND c.legacy_identifier = '978-84-376-0494-7' FROM biblib.copies AS c WHERE c.id = '3d000000-0000-4000-8000-0000000e0b01'), 'grupo 2: títulos distintos no se agrupan');
SELECT assert_true((SELECT count(*) = 2 FROM biblib.model_migration_report WHERE user_id = '10000000-0000-4000-8000-0000000000e1' AND migration = '0011_copies_cutover' AND kind = 'grouped'), 'dos agrupaciones en el informe');
SELECT assert_true((SELECT details->>'source' = '0306406152' AND other_copy_id = '3d000000-0000-4000-8000-0000000e0a01' FROM biblib.model_migration_report WHERE copy_id = '3d000000-0000-4000-8000-0000000e0a02' AND kind = 'grouped'), 'el informe conserva el texto original');
SELECT assert_true((SELECT details->>'grouped' = '2' AND details->>'conflicts' = '3' FROM biblib.model_migration_report WHERE user_id = '10000000-0000-4000-8000-0000000000e1' AND migration = '0011_copies_cutover' AND kind = 'summary'), 'resumen de 0011 con agrupadas y conflictos restantes');
SELECT assert_true((SELECT count(*) FROM biblib.copies WHERE user_id = '10000000-0000-4000-8000-0000000000e1') = (SELECT count(*) FROM biblib.books_legacy WHERE user_id = '10000000-0000-4000-8000-0000000000e1'), 'ninguna ficha descartada por equivalencia');
SELECT 'Correcto: equivalencias ISBN-10/13 compatibles agrupadas y el resto en conflicto, sin descartar filas';

-- Vista plana: el ISBN es el de la edición o el identificador legacy, nunca uno inventado; versión plana.
SELECT assert_true((SELECT count(*) = 9 FROM biblib.books WHERE user_id = '10000000-0000-4000-8000-0000000000e1' AND isbn LIKE 'manual-%' AND isbn13 IS NULL AND legacy_identifier = isbn), 'los manual-… siguen como identificador legacy');
SELECT assert_true((SELECT isbn IS NULL AND isbn13 IS NULL AND legacy_identifier IS NULL FROM biblib.books WHERE id = '3d000000-0000-4000-8000-0000000e0e03'), 'sin ISBN: null');
SELECT assert_true((SELECT version = md5(copy_version::text || edition_version::text)::uuid FROM biblib.books WHERE id = '3d000000-0000-4000-8000-000000000005'), 'versión plana de ejemplar y edición');
SELECT 'Correcto: vista plana con ISBN opcional y token plano';

-- Dos ejemplares de una edición: estado y ubicación independientes; cambiar la edición por la vista se rechaza
-- (la hace el contrato de edición), cambiar un ejemplar no toca el otro.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000e1', true);
DO $test$
DECLARE
  before_other uuid := (SELECT version FROM biblib.books WHERE id = '3d000000-0000-4000-8000-0000000e0a01');
BEGIN
  UPDATE biblib.books SET status = 'reading', shelf_id = '20000000-0000-4000-8000-0000000003e1' WHERE id = '3d000000-0000-4000-8000-0000000e0a02';
  PERFORM assert_true((SELECT status = 'reading' AND shelf_id = '20000000-0000-4000-8000-0000000003e1' FROM biblib.books WHERE id = '3d000000-0000-4000-8000-0000000e0a02'), 'el ejemplar B cambia de estado y ubicación');
  PERFORM assert_true((SELECT status = 'read' AND shelf_id = '20000000-0000-4000-8000-0000000001e1' AND version = before_other FROM biblib.books WHERE id = '3d000000-0000-4000-8000-0000000e0a01'), 'el ejemplar A no cambia');
  BEGIN
    UPDATE biblib.books SET title = 'Título cambiado' WHERE id = '3d000000-0000-4000-8000-0000000e0a02';
    RAISE EXCEPTION 'Prueba fallida: la vista cambió una edición compartida';
  EXCEPTION WHEN SQLSTATE 'BM003' THEN NULL; END;
  -- La comprobación física de un ejemplar es suya: marcar B no marca A.
  UPDATE biblib.books SET catalogue = catalogue || '{"isbnVerified": true}' WHERE id = '3d000000-0000-4000-8000-0000000e0a02';
  PERFORM assert_true((SELECT (catalogue->>'isbnVerified')::boolean FROM biblib.books WHERE id = '3d000000-0000-4000-8000-0000000e0a02'), 'B verificado');
  UPDATE biblib.books SET catalogue = catalogue || '{"isbnVerified": false}' WHERE id = '3d000000-0000-4000-8000-0000000e0a01';
  PERFORM assert_true((SELECT NOT (catalogue->>'isbnVerified')::boolean FROM biblib.books WHERE id = '3d000000-0000-4000-8000-0000000e0a01'), 'A sin verificar, con B verificado');
  -- Sin edición compartida, la vista cambia la edición como antes.
  UPDATE biblib.books SET title = 'Ficha sintética 005 editada', isbn = '' WHERE id = '3d000000-0000-4000-8000-000000000005';
  PERFORM assert_true((SELECT title = 'Ficha sintética 005 editada' AND isbn IS NULL AND isbn13 IS NULL FROM biblib.books WHERE id = '3d000000-0000-4000-8000-000000000005'), 'una edición propia se edita por la vista; vaciar el ISBN deja null');
END;
$test$;
ROLLBACK;
SELECT 'Correcto: dos ejemplares de una edición con estado, ubicación y comprobación independientes';

-- Altas y bajas de compatibilidad por la vista (scripts y SQL que escribían books) con RLS de quien escribe.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000e1', true);
DO $test$
DECLARE
  created record;
BEGIN
  INSERT INTO biblib.books(id, user_id, isbn, title, shelf_id) VALUES ('3d000000-0000-4000-8000-0000000e2001', '10000000-0000-4000-8000-0000000000e1', '9780002005012', 'Alta por la vista', '20000000-0000-4000-8000-0000000000e1')
  RETURNING * INTO created;
  PERFORM assert_true(created.edition_id = '3d000000-0000-4000-8000-0000000e2001' AND created.isbn13 = '9780002005012' AND created.version IS NOT NULL AND created.status = 'unread', 'alta con edición propia y valores por defecto');
  INSERT INTO biblib.books(user_id, isbn, title, shelf_id, edition_id) VALUES ('10000000-0000-4000-8000-0000000000e1', NULL, 'Ignorado', '20000000-0000-4000-8000-0000000001e1', '3d000000-0000-4000-8000-0000000e2001');
  PERFORM assert_true((SELECT count(*) = 2 FROM biblib.copies WHERE edition_id = '3d000000-0000-4000-8000-0000000e2001'), 'un alta con edition_id añade un ejemplar a esa edición');
  INSERT INTO biblib.books(user_id, isbn, title, shelf_id) VALUES ('10000000-0000-4000-8000-0000000000e1', 'manual-90000000-0000-4000-8000-000000000001', 'Manual por la vista', '20000000-0000-4000-8000-0000000000e1');
  PERFORM assert_true((SELECT legacy_identifier = 'manual-90000000-0000-4000-8000-000000000001' AND isbn13 IS NULL FROM biblib.books WHERE title = 'Manual por la vista'), 'un manual-… no ocupa isbn13');
  BEGIN
    INSERT INTO biblib.books(user_id, isbn, title, shelf_id) VALUES ('10000000-0000-4000-8000-0000000000e1', '0306406152', 'Equivalente', '20000000-0000-4000-8000-0000000000e1');
    RAISE EXCEPTION 'Prueba fallida: dos ediciones con el mismo ISBN-13';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.books(user_id, isbn, title, shelf_id) VALUES ('10000000-0000-4000-8000-0000000000e2', '9780002005029', 'Ajeno', '20000000-0000-4000-8000-0000000000e2');
    RAISE EXCEPTION 'Prueba fallida: M creó una ficha de N por la vista';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  UPDATE biblib.books SET status = 'read' WHERE user_id = '10000000-0000-4000-8000-0000000000e2';
  PERFORM assert_true(NOT FOUND, 'M no cambia fichas de N por la vista');
  DELETE FROM biblib.books WHERE id = '3d000000-0000-4000-8000-0000000e2001';
  PERFORM assert_true(EXISTS (SELECT 1 FROM biblib.editions WHERE id = '3d000000-0000-4000-8000-0000000e2001'), 'borrar un ejemplar conserva la edición con otro ejemplar');
  DELETE FROM biblib.books WHERE edition_id = '3d000000-0000-4000-8000-0000000e2001';
  PERFORM assert_true(NOT EXISTS (SELECT 1 FROM biblib.editions WHERE id = '3d000000-0000-4000-8000-0000000e2001'), 'borrar el último retira la edición');
END;
$test$;
ROLLBACK;
SELECT 'Correcto: escrituras de compatibilidad por la vista con RLS, unicidad por ISBN-13 y poda';

-- Versiones anteriores del modelo: schema_version 2 con edición, comprobación e identificador legacy.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000e1', true);
DO $test$
DECLARE
  operation_id uuid := gen_random_uuid();
  captured jsonb;
  item jsonb;
BEGIN
  INSERT INTO biblib.library_operations(id, user_id, operation, idempotency_key, input_digest, status, result)
  VALUES (operation_id, '10000000-0000-4000-8000-0000000000e1', 'import.confirm', 'modelo-captura-0011', repeat('b', 64), 'committed', '{}');
  captured := biblib.library_snapshot_capture(operation_id, 'import.replace');
  PERFORM assert_true((captured->>'books')::integer = (SELECT count(*) FROM biblib.copies WHERE user_id = '10000000-0000-4000-8000-0000000000e1'), 'una entrada por ejemplar');
  PERFORM assert_true((SELECT schema_version = 2 FROM biblib.library_snapshots WHERE id = (captured->>'id')::uuid), 'schema_version 2');
  SELECT entry INTO item FROM biblib.library_snapshot_chunks AS c CROSS JOIN LATERAL jsonb_array_elements(c.payload) AS entry
    WHERE c.snapshot_id = (captured->>'id')::uuid AND entry->>'id' = '3d000000-0000-4000-8000-0000000e0a02';
  PERFORM assert_true(item->>'edition_id' = '3d000000-0000-4000-8000-0000000e0a01' AND item->>'isbn' = '9780306406157' AND item->'verification'->>'isbnVerified' = 'false' AND NOT item ? 'legacy_identifier', 'ejemplar agrupado con su edición y su comprobación');
  SELECT entry INTO item FROM biblib.library_snapshot_chunks AS c CROSS JOIN LATERAL jsonb_array_elements(c.payload) AS entry
    WHERE c.snapshot_id = (captured->>'id')::uuid AND entry->>'id' = '3d000000-0000-4000-8000-000000000105';
  PERFORM assert_true(item->>'isbn' IS NULL AND item->>'legacy_identifier' LIKE 'manual-%', 'manual sin ISBN y con su identificador legacy');
  PERFORM assert_true(cardinality(biblib.library_snapshot_foreign_ids((captured->>'id')::uuid)) = 0, 'ningún ID de la versión es ajeno');
END;
$test$;
ROLLBACK;
SELECT 'Correcto: versiones anteriores con ejemplares y ediciones (schema_version 2)';

-- Portadas privadas en la edición: la purga y la revalidación desadjuntan de la edición, no de una tabla legacy.
DO $test$
DECLARE
  asset_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO biblib.cover_assets(id, user_id, storage_key, sha256, mime, width, height, bytes, state, source_kind, source_ref, rights_policy_version)
  VALUES (asset_id, '10000000-0000-4000-8000-0000000000e1', '10000000-0000-4000-8000-0000000000e1/' || asset_id || '/m.webp', repeat('c', 64), 'image/webp', 10, 10, 10, 'ready', 'upload', 'upload', 'upload.v1');
  UPDATE biblib.editions SET cover_asset_id = asset_id WHERE id = '3d000000-0000-4000-8000-000000000007';
  PERFORM assert_true((SELECT cover_asset_id = asset_id FROM biblib.books WHERE id = '3d000000-0000-4000-8000-000000000007'), 'la vista muestra la portada privada de la edición');
  PERFORM assert_true((SELECT NOT (biblib.cover_asset_purge_candidates('10000000-0000-4000-8000-0000000000e1', 100, 0)->'assets') @> jsonb_build_array(jsonb_build_object('id', asset_id))), 'una edición que la cita la retiene');
  UPDATE biblib.cover_assets SET state = 'restored' WHERE id = asset_id;
  PERFORM set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000e1', true);
  PERFORM assert_true(biblib.cover_asset_revalidate(asset_id, false) = 'discarded', 'descartar la revalidación');
  PERFORM assert_true((SELECT cover_asset_id IS NULL FROM biblib.editions WHERE id = '3d000000-0000-4000-8000-000000000007'), 'la edición vuelve a su URL');
  PERFORM set_config('request.jwt.claim.sub', '', true);
END;
$test$;
SELECT assert_true((SELECT (biblib.model_compare('10000000-0000-4000-8000-0000000000e1')->>'mismatches')::integer = 0), 'el ensayo de portada no deja diferencias');
SELECT 'Correcto: portadas privadas en la edición para purga y revalidación';

-- Operaciones idempotentes del modelo y permisos de cliente de 0011.
SELECT assert_true((SELECT pg_get_constraintdef(oid) LIKE '%edition.merge%' FROM pg_constraint WHERE conname = 'library_operations_operation_check'), 'operaciones del modelo admitidas');
SELECT assert_true(has_table_privilege('authenticated', 'biblib.books', 'SELECT') AND NOT has_table_privilege('anon', 'biblib.books', 'SELECT'), 'la vista es solo del dueño autenticado');
SELECT assert_true(NOT has_function_privilege('authenticated', 'biblib.books_view_update()', 'EXECUTE'), 'los triggers de la vista no se invocan directamente');
SELECT 'Correcto: operaciones del modelo y permisos de 0011';

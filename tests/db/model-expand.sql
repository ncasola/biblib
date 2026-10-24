-- U-DAT-06: tras 0010 (expandir + backfill + comparar). Comprueba el backfill de M y N, el informe, la
-- comparación ficha a ficha, la sincronización desde books durante la ventana de expansión, RLS y FK
-- con propietario de obras/ediciones/ejemplares, la poda de ediciones huérfanas y que toda edición
-- tiene un ejemplar.
SELECT assert_true((SELECT (biblib.model_compare(NULL)->>'mismatches')::integer = 0), 'el modelo coincide con books en todas las cuentas');
SELECT assert_true((SELECT count(*) FROM biblib.books) = (SELECT count(*) FROM biblib.copies), 'un ejemplar por ficha');
SELECT assert_true((SELECT count(*) FROM biblib.books) = (SELECT count(*) FROM biblib.editions), 'una edición por ficha');
SELECT assert_true((SELECT count(*) = 0 FROM biblib.works), 'ninguna obra sin evidencia');
SELECT assert_true(NOT EXISTS (SELECT 1 FROM biblib.books AS b LEFT JOIN biblib.copies AS c ON c.id = b.id LEFT JOIN biblib.editions AS e ON e.id = b.id
  WHERE c.id IS NULL OR e.id IS NULL OR c.edition_id <> b.id OR c.user_id <> b.user_id OR e.user_id <> b.user_id), 'IDs de ficha conservados como ejemplar y edición del mismo dueño');
SELECT 'Correcto: backfill uno a uno con IDs, dueño y contenido conservados';

-- M: 122 fichas, comparación por cuenta y resumen.
SELECT assert_true((SELECT (r->>'books')::integer = 122 AND (r->>'copies')::integer = 122 AND (r->>'mismatches')::integer = 0 FROM (SELECT biblib.model_compare('10000000-0000-4000-8000-0000000000e1') AS r) AS x), 'comparación de M');
SELECT assert_true((SELECT details->>'books' = '122' AND details->>'conflicts' = '4' AND details->>'normalized' = '1' AND details->>'invalid' = '3' AND details->>'manual' = '9'
  FROM biblib.model_migration_report WHERE user_id = '10000000-0000-4000-8000-0000000000e1' AND kind = 'summary'), 'resumen de M en el informe');
SELECT 'Correcto: comparación y resumen por cuenta';

-- ISBN-13 canónico: los 102 sintéticos, el grupo 1 canónico, el ganador del grupo 2 (ya canónico), la normalizada y el ganador del grupo 3.
SELECT assert_true((SELECT count(*) = 102 FROM biblib.editions WHERE user_id = '10000000-0000-4000-8000-0000000000e1' AND isbn13 LIKE '97800020%'), '102 ISBN-13 sintéticos');
SELECT assert_true((SELECT isbn13 = '9780306406157' FROM biblib.editions WHERE id = '3d000000-0000-4000-8000-0000000e0a01'), 'la forma canónica gana el ISBN-13');
SELECT assert_true((SELECT e.isbn13 IS NULL AND c.legacy_identifier = '0306406152' FROM biblib.editions AS e JOIN biblib.copies AS c ON c.edition_id = e.id WHERE c.id = '3d000000-0000-4000-8000-0000000e0a02'), 'la equivalencia ISBN-10 queda sin ISBN-13 y conserva su texto');
SELECT assert_true((SELECT isbn13 = '9788437604947' FROM biblib.editions WHERE id = '3d000000-0000-4000-8000-0000000e0b02'), 'gana la forma canónica aunque sea más reciente');
SELECT assert_true((SELECT c.legacy_identifier = '978-84-376-0494-7' FROM biblib.copies AS c WHERE c.id = '3d000000-0000-4000-8000-0000000e0b01'), 'la forma con guiones en conflicto conserva su texto');
SELECT assert_true((SELECT e.isbn13 = '9780198534532' AND c.legacy_identifier IS NULL FROM biblib.editions AS e JOIN biblib.copies AS c ON c.edition_id = e.id WHERE c.id = '3d000000-0000-4000-8000-0000000e0c01'), 'un ISBN-10 sin equivalencia se reescribe a ISBN-13');
SELECT assert_true((SELECT count(*) = 2 FROM biblib.copies WHERE id IN ('3d000000-0000-4000-8000-0000000e0d02', '3d000000-0000-4000-8000-0000000e0d03') AND legacy_identifier IS NOT NULL), 'las dos equivalencias del grupo 3 en conflicto');
SELECT assert_true((SELECT e.isbn13 IS NULL AND c.legacy_identifier = '1234567890' FROM biblib.editions AS e JOIN biblib.copies AS c ON c.edition_id = e.id WHERE c.id = '3d000000-0000-4000-8000-0000000e0e01'), 'un identificador no válido no es un ISBN-13');
SELECT assert_true((SELECT e.isbn13 IS NULL AND c.legacy_identifier IS NULL FROM biblib.editions AS e JOIN biblib.copies AS c ON c.edition_id = e.id WHERE c.id = '3d000000-0000-4000-8000-0000000e0e03'), 'un identificador vacío queda nulo');
SELECT assert_true((SELECT count(*) = 9 FROM biblib.copies WHERE user_id = '10000000-0000-4000-8000-0000000000e1' AND legacy_identifier LIKE 'manual-%'), 'los 9 manual-… pasan a legacy_identifier');
SELECT assert_true((SELECT count(*) = 9 FROM biblib.copies AS c JOIN biblib.editions AS e ON e.id = c.edition_id WHERE c.legacy_identifier LIKE 'manual-%' AND e.user_id = '10000000-0000-4000-8000-0000000000e1' AND e.isbn13 IS NULL), 'sin ISBN inventado');
SELECT assert_true((SELECT isbn13 = '9780306406157' FROM biblib.editions WHERE id = '3d000000-0000-4000-8000-0000000e0f01'), 'N conserva su ISBN aunque M lo tenga');
SELECT assert_true((SELECT count(*) = 4 FROM biblib.model_migration_report WHERE user_id = '10000000-0000-4000-8000-0000000000e1' AND kind = 'conflict'
  AND other_copy_id IN ('3d000000-0000-4000-8000-0000000e0a01', '3d000000-0000-4000-8000-0000000e0b02', '3d000000-0000-4000-8000-0000000e0d01')), 'cada conflicto cita la ficha que conservó el ISBN-13');
SELECT assert_true((SELECT count(*) = 3 FROM biblib.model_migration_report WHERE user_id = '10000000-0000-4000-8000-0000000000e1' AND kind = 'invalid'), 'identificadores no válidos y vacío en el informe');
SELECT assert_true(NOT EXISTS (SELECT 1 FROM biblib.model_migration_report WHERE user_id = '10000000-0000-4000-8000-0000000000e2' AND kind = 'conflict'), 'N no tiene conflictos por el ISBN de M');
SELECT 'Correcto: ISBN-10/13 equivalentes en conflicto, normalizados, no válidos y manual sin descartar filas';

-- La comprobación física pasa al ejemplar; la edición no la guarda.
SELECT assert_true(NOT EXISTS (SELECT 1 FROM biblib.editions WHERE catalogue ? 'isbnVerified'), 'ninguna edición guarda isbnVerified');
SELECT assert_true((SELECT count(*) FROM biblib.copies AS c JOIN biblib.books AS b ON b.id = c.id WHERE (c.edition_verification->>'isbnVerified')::boolean)
  = (SELECT count(*) FROM biblib.books WHERE catalogue->>'isbnVerified' = 'true'), 'la comprobación de cada ficha está en su ejemplar');
SELECT assert_true((SELECT (c.edition_verification->>'isbnVerified')::boolean AND NOT (c2.edition_verification->>'isbnVerified')::boolean
  FROM biblib.copies AS c, biblib.copies AS c2 WHERE c.id = '3d000000-0000-4000-8000-0000000e0a01' AND c2.id = '3d000000-0000-4000-8000-0000000e0a02'), 'verificaciones independientes en el grupo 1');
SELECT assert_true((SELECT catalogue = '{"schemaVersion":2,"source":"bne","fields":{"title":{"provider":"bne","recordId":"bimo1","selection":"user-selected"}}}'::jsonb FROM biblib.editions WHERE id = '3d000000-0000-4000-8000-000000000001'), 'procedencia v2 por campo en la edición');
SELECT 'Correcto: comprobación física en el ejemplar y procedencia en la edición';

-- Sincronización durante la ventana: la aplicación anterior sigue escribiendo books como M.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000e1', true);
INSERT INTO biblib.books(id, user_id, isbn, title, shelf_id) VALUES ('3d000000-0000-4000-8000-0000000e1001', '10000000-0000-4000-8000-0000000000e1', '9780002005005', 'Alta en la ventana', '20000000-0000-4000-8000-0000000000e1');
UPDATE biblib.books SET status = 'read', title = 'Ficha sintética 002 editada', catalogue = '{"source":"manual","isbnVerified":true}' WHERE id = '3d000000-0000-4000-8000-000000000002';
-- Un ISBN-10 equivalente a una edición ya existente entra como conflicto, no se fusiona.
INSERT INTO biblib.books(id, user_id, isbn, title, shelf_id) VALUES ('3d000000-0000-4000-8000-0000000e1002', '10000000-0000-4000-8000-0000000000e1', '0198534531', 'Equivalencia en la ventana', '20000000-0000-4000-8000-0000000000e1');
DELETE FROM biblib.books WHERE id = '3d000000-0000-4000-8000-000000000003';
COMMIT;
SELECT assert_true((SELECT isbn13 = '9780002005005' FROM biblib.editions WHERE id = '3d000000-0000-4000-8000-0000000e1001'), 'el alta en books crea edición y ejemplar');
SELECT assert_true((SELECT e.title = 'Ficha sintética 002 editada' AND c.status = 'read' AND (c.edition_verification->>'isbnVerified')::boolean AND NOT e.catalogue ? 'isbnVerified'
  FROM biblib.copies AS c JOIN biblib.editions AS e ON e.id = c.edition_id WHERE c.id = '3d000000-0000-4000-8000-000000000002'), 'la edición en books se refleja en edición y ejemplar');
SELECT assert_true((SELECT e.isbn13 IS NULL AND c.legacy_identifier = '0198534531' FROM biblib.copies AS c JOIN biblib.editions AS e ON e.id = c.edition_id WHERE c.id = '3d000000-0000-4000-8000-0000000e1002'), 'la equivalencia de la ventana queda en conflicto');
SELECT assert_true(EXISTS (SELECT 1 FROM biblib.model_migration_report WHERE copy_id = '3d000000-0000-4000-8000-0000000e1002' AND kind = 'conflict' AND details->>'during' = 'sync'), 'y en el informe');
SELECT assert_true(NOT EXISTS (SELECT 1 FROM biblib.copies WHERE id = '3d000000-0000-4000-8000-000000000003') AND NOT EXISTS (SELECT 1 FROM biblib.editions WHERE id = '3d000000-0000-4000-8000-000000000003'), 'borrar en books retira ejemplar y edición');
SELECT assert_true((SELECT (biblib.model_compare(NULL)->>'mismatches')::integer = 0), 'la comparación sigue sin diferencias tras la ventana');
SELECT 'Correcto: sincronización desde books durante la ventana de expansión';

-- RLS y FK con propietario: M no ve los datos de N ni los cita.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000e1', true);
SELECT assert_true((SELECT count(*) = 0 FROM biblib.editions WHERE user_id = '10000000-0000-4000-8000-0000000000e2'), 'M no ve ediciones de N');
SELECT assert_true((SELECT count(*) = 0 FROM biblib.copies WHERE user_id = '10000000-0000-4000-8000-0000000000e2'), 'M no ve ejemplares de N');
SELECT assert_true((SELECT count(*) = 0 FROM biblib.model_migration_report WHERE user_id = '10000000-0000-4000-8000-0000000000e2'), 'M no ve el informe de N');
DO $test$
BEGIN
  BEGIN
    INSERT INTO biblib.copies(user_id, edition_id, shelf_id) VALUES ('10000000-0000-4000-8000-0000000000e1', '3d000000-0000-4000-8000-0000000e0f01', '20000000-0000-4000-8000-0000000000e1');
    RAISE EXCEPTION 'Prueba fallida: un ejemplar de M citó una edición de N';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.copies(user_id, edition_id, shelf_id) VALUES ('10000000-0000-4000-8000-0000000000e1', '3d000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-0000000000e2');
    RAISE EXCEPTION 'Prueba fallida: un ejemplar de M usó una estantería de N';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.copies(user_id, edition_id, shelf_id) VALUES ('10000000-0000-4000-8000-0000000000e2', '3d000000-0000-4000-8000-0000000e0f01', '20000000-0000-4000-8000-0000000000e2');
    RAISE EXCEPTION 'Prueba fallida: M escribió un ejemplar a nombre de N';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO biblib.works(id, user_id, title) VALUES ('60000000-0000-4000-8000-0000000000e2', '10000000-0000-4000-8000-0000000000e2', 'Obra ajena');
    RAISE EXCEPTION 'Prueba fallida: M creó una obra de N';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- Las fusiones cruzadas también fallan: mover un ejemplar de M a una edición de N viola la FK con dueño.
  BEGIN
    UPDATE biblib.copies SET edition_id = '3d000000-0000-4000-8000-0000000e0f01' WHERE id = '3d000000-0000-4000-8000-000000000004';
    RAISE EXCEPTION 'Prueba fallida: un ejemplar de M pasó a una edición de N';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  UPDATE biblib.editions SET title = 'Intento' WHERE user_id = '10000000-0000-4000-8000-0000000000e2';
  PERFORM assert_true(NOT FOUND, 'M no modifica ediciones de N');
END;
$test$;
COMMIT;
SELECT assert_true((SELECT title = 'Libro de N' FROM biblib.editions WHERE id = '3d000000-0000-4000-8000-0000000e0f01'), 'la edición de N sigue intacta');
SELECT 'Correcto: RLS y FK con propietario en obras, ediciones y ejemplares';

-- Unicidad por cuenta: una segunda edición de M con el mismo ISBN-13 se rechaza; la de N no cuenta.
DO $test$
BEGIN
  BEGIN
    INSERT INTO biblib.editions(user_id, isbn13, title) VALUES ('10000000-0000-4000-8000-0000000000e1', '9780306406157', 'Duplicada');
    RAISE EXCEPTION 'Prueba fallida: dos ediciones de M con el mismo ISBN-13';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.editions(user_id, isbn13, title) VALUES ('10000000-0000-4000-8000-0000000000e1', '9780306406158', 'Dígito incorrecto');
    RAISE EXCEPTION 'Prueba fallida: un ISBN-13 con dígito de control incorrecto';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.editions(user_id, isbn13, title) VALUES ('10000000-0000-4000-8000-0000000000e1', '0306406152', 'ISBN-10');
    RAISE EXCEPTION 'Prueba fallida: un ISBN-10 en isbn13';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.editions(user_id, title, catalogue) VALUES ('10000000-0000-4000-8000-0000000000e1', 'Con comprobación', '{"source":"manual","isbnVerified":true}');
    RAISE EXCEPTION 'Prueba fallida: una edición guardó la comprobación física';
  EXCEPTION WHEN check_violation THEN NULL; END;
END;
$test$;
SELECT 'Correcto: un ISBN-13 canónico y válido por cuenta; la comprobación física nunca en la edición';

-- Toda edición necesita un ejemplar al confirmar; retirar el último ejemplar retira su edición y su obra.
DO $test$
BEGIN
  BEGIN
    INSERT INTO biblib.editions(id, user_id, title) VALUES ('70000000-0000-4000-8000-0000000000e1', '10000000-0000-4000-8000-0000000000e1', 'Sin ejemplar');
    SET CONSTRAINTS biblib.editions_require_copy IMMEDIATE;
    RAISE EXCEPTION 'Prueba fallida: una edición sin ejemplar se confirmó';
  EXCEPTION WHEN SQLSTATE 'BM001' THEN NULL; END;
END;
$test$;
BEGIN;
INSERT INTO biblib.works(id, user_id, title) VALUES ('60000000-0000-4000-8000-0000000000e1', '10000000-0000-4000-8000-0000000000e1', 'Obra con evidencia');
INSERT INTO biblib.editions(id, user_id, work_id, title) VALUES ('70000000-0000-4000-8000-0000000001e1', '10000000-0000-4000-8000-0000000000e1', '60000000-0000-4000-8000-0000000000e1', 'Edición de prueba');
INSERT INTO biblib.copies(id, user_id, edition_id, shelf_id) VALUES ('80000000-0000-4000-8000-0000000001e1', '10000000-0000-4000-8000-0000000000e1', '70000000-0000-4000-8000-0000000001e1', '20000000-0000-4000-8000-0000000000e1'),
  ('80000000-0000-4000-8000-0000000002e1', '10000000-0000-4000-8000-0000000000e1', '70000000-0000-4000-8000-0000000001e1', '20000000-0000-4000-8000-0000000001e1');
COMMIT;
DELETE FROM biblib.copies WHERE id = '80000000-0000-4000-8000-0000000001e1';
SELECT assert_true(EXISTS (SELECT 1 FROM biblib.editions WHERE id = '70000000-0000-4000-8000-0000000001e1'), 'la edición sigue con su otro ejemplar');
DELETE FROM biblib.copies WHERE id = '80000000-0000-4000-8000-0000000002e1';
SELECT assert_true(NOT EXISTS (SELECT 1 FROM biblib.editions WHERE id = '70000000-0000-4000-8000-0000000001e1'), 'sin ejemplares se retira la edición');
SELECT assert_true(NOT EXISTS (SELECT 1 FROM biblib.works WHERE id = '60000000-0000-4000-8000-0000000000e1'), 'y la obra sin ediciones');
SELECT 'Correcto: ediciones con al menos un ejemplar y poda de ediciones y obras huérfanas';

-- Versiones y revisión de colección: cada escritura renueva el token y rota la revisión del dueño.
DO $test$
DECLARE
  before_copy uuid := (SELECT version FROM biblib.copies WHERE id = '3d000000-0000-4000-8000-000000000004');
  before_revision uuid := (SELECT revision FROM biblib.library_state WHERE user_id = '10000000-0000-4000-8000-0000000000e1');
BEGIN
  UPDATE biblib.copies SET status = 'reading' WHERE id = '3d000000-0000-4000-8000-000000000004';
  PERFORM assert_true((SELECT version <> before_copy FROM biblib.copies WHERE id = '3d000000-0000-4000-8000-000000000004'), 'el ejemplar renueva su versión');
  PERFORM assert_true((SELECT revision <> before_revision FROM biblib.library_state WHERE user_id = '10000000-0000-4000-8000-0000000000e1'), 'y rota la revisión de M');
END;
$test$;
-- Deshace el cambio directo para que books y el modelo vuelvan a coincidir antes de 0011.
UPDATE biblib.copies SET status = (SELECT status FROM biblib.books WHERE id = '3d000000-0000-4000-8000-000000000004') WHERE id = '3d000000-0000-4000-8000-000000000004';
SELECT assert_true((SELECT (biblib.model_compare(NULL)->>'mismatches')::integer = 0), 'books y el modelo coinciden antes del cambio');
SELECT 'Correcto: versiones y revisión de colección en obras, ediciones y ejemplares';

-- Permisos: el cliente no ejecuta la sincronización ni la comparación.
SELECT assert_true(NOT has_function_privilege('authenticated', 'biblib.model_compare(uuid)', 'EXECUTE'), 'authenticated no compara');
SELECT assert_true(NOT has_function_privilege('authenticated', 'biblib.model_sync_book()', 'EXECUTE'), 'authenticated no sincroniza');
SELECT assert_true(has_function_privilege('authenticated', 'biblib.isbn13_normalize(text)', 'EXECUTE'), 'authenticated evalúa la restricción de ISBN-13');
SELECT assert_true(NOT has_table_privilege('authenticated', 'biblib.model_migration_report', 'INSERT'), 'authenticated no escribe el informe');
SELECT assert_true(NOT has_table_privilege('anon', 'biblib.copies', 'SELECT') AND NOT has_table_privilege('anon', 'biblib.editions', 'SELECT') AND NOT has_table_privilege('anon', 'biblib.works', 'SELECT'), 'anon sin acceso');
SELECT 'Correcto: permisos de cliente de 0010';

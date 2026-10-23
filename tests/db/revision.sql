-- U-DAT-01: revisión de colección. Se ejecuta después de rls.sql, con 0003 aplicada sobre datos previos.
SELECT public.assert_true((SELECT count(*) = 2 FROM biblib.library_state), '0003 crea una revisión para cada cuenta existente');

-- Escrituras de A: una rotación por transacción, sin tocar la revisión de B.
CREATE TEMP TABLE revisiones AS SELECT user_id, revision FROM biblib.library_state;
GRANT SELECT ON revisiones TO authenticated;
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
DO $test$
DECLARE before_lock uuid; first_write uuid; second_write uuid; affected integer;
BEGIN
  SELECT biblib.lock_library() INTO before_lock;
  PERFORM public.assert_true(before_lock = (SELECT revision FROM revisiones WHERE user_id = '10000000-0000-4000-8000-000000000001'), 'lock_library devuelve la revisión vigente sin rotarla');
  PERFORM public.assert_true((SELECT count(*) = 1 FROM biblib.library_state), 'A solo lee su propia revisión');
  UPDATE biblib.books SET status = 'read' WHERE id = '30000000-0000-4000-8000-000000000001';
  SELECT revision INTO first_write FROM biblib.library_state;
  PERFORM public.assert_true(first_write <> before_lock, 'cambiar el estado de un libro rota la revisión');
  UPDATE biblib.books SET cover_large = 'https://covers.example.invalid/a.jpg' WHERE id = '30000000-0000-4000-8000-000000000001';
  INSERT INTO biblib.shelves(user_id, title) VALUES ('10000000-0000-4000-8000-000000000001', 'Estante nuevo');
  SELECT revision INTO second_write FROM biblib.library_state;
  PERFORM public.assert_true(second_write = first_write, 'una transacción rota la revisión una sola vez');

  BEGIN
    UPDATE biblib.library_state SET revision = before_lock;
    RAISE EXCEPTION 'Prueba fallida: authenticated reescribió su revisión';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO biblib.library_state(user_id) VALUES ('10000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'Prueba fallida: authenticated insertó una revisión';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    DELETE FROM biblib.library_state;
    RAISE EXCEPTION 'Prueba fallida: authenticated borró su revisión';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  INSERT INTO biblib.import_previews(id, user_id, revision, input_digest, mode, rules_version, plan, payload, expires_at)
  VALUES ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', first_write, repeat('a', 64), 'replace', 1, '{}', '{}', now() + interval '30 minutes');
  BEGIN
    INSERT INTO biblib.import_previews(user_id, revision, input_digest, mode, rules_version, plan, payload, expires_at)
    VALUES ('10000000-0000-4000-8000-000000000002', first_write, repeat('a', 64), 'merge', 1, '{}', '{}', now());
    RAISE EXCEPTION 'Prueba fallida: A creó una vista previa para B';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE biblib.import_previews SET mode = 'merge';
    RAISE EXCEPTION 'Prueba fallida: una vista previa se modificó tras prepararla';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  INSERT INTO biblib.library_operations(user_id, operation, idempotency_key, input_digest, preview_id, status, result)
  VALUES ('10000000-0000-4000-8000-000000000001', 'import.confirm', 'clave-de-prueba-0001', repeat('b', 64), '50000000-0000-4000-8000-000000000001', 'committed', '{}');
  BEGIN
    INSERT INTO biblib.library_operations(user_id, operation, idempotency_key, input_digest, status, result)
    VALUES ('10000000-0000-4000-8000-000000000001', 'import.confirm', 'clave-de-prueba-0001', repeat('c', 64), 'committed', '{}');
    RAISE EXCEPTION 'Prueba fallida: se repitió una clave de idempotencia';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE biblib.library_operations SET result = '{"falso":true}';
    RAISE EXCEPTION 'Prueba fallida: se alteró un resultado durable';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  UPDATE biblib.books SET title = title WHERE user_id = '10000000-0000-4000-8000-000000000002';
  GET DIAGNOSTICS affected = ROW_COUNT;
  PERFORM public.assert_true(affected = 0, 'A no alcanza libros de B');
END;
$test$;
COMMIT;

SELECT public.assert_true((SELECT revision = (SELECT revision FROM revisiones WHERE user_id = '10000000-0000-4000-8000-000000000002') FROM biblib.library_state WHERE user_id = '10000000-0000-4000-8000-000000000002'), 'las escrituras de A no invalidan la revisión de B');
SELECT public.assert_true((SELECT revision <> (SELECT revision FROM revisiones WHERE user_id = '10000000-0000-4000-8000-000000000001') FROM biblib.library_state WHERE user_id = '10000000-0000-4000-8000-000000000001'), 'la revisión rotada de A persiste tras el commit');

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
SELECT public.assert_true((SELECT count(*) = 0 FROM biblib.import_previews), 'B no enumera las vistas previas de A');
SELECT public.assert_true((SELECT count(*) = 0 FROM biblib.library_operations), 'B no enumera las operaciones de A');
SELECT public.assert_true((SELECT count(*) = 1 AND bool_and(user_id = '10000000-0000-4000-8000-000000000002') FROM biblib.library_state), 'B solo lee su revisión');
SELECT public.assert_true(biblib.lock_library() = (SELECT revision FROM biblib.library_state), 'lock_library solo bloquea la colección de la sesión');
COMMIT;

-- Sin sesión, la función de bloqueo no opera sobre ninguna colección.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claims', '', true);
DO $test$
BEGIN
  PERFORM biblib.lock_library();
  RAISE EXCEPTION 'Prueba fallida: lock_library sin sesión';
EXCEPTION WHEN insufficient_privilege THEN NULL; END;
$test$;
COMMIT;

-- SQL administrativo directo también rota; cuentas nuevas reciben revisión perezosa; borrar la cuenta no falla.
DO $test$
DECLARE previous uuid;
BEGIN
  SELECT revision INTO previous FROM biblib.library_state WHERE user_id = '10000000-0000-4000-8000-000000000002';
  UPDATE biblib.shelves SET title = 'Estante B renombrado' WHERE id = '20000000-0000-4000-8000-000000000004';
  PERFORM public.assert_true((SELECT revision <> previous FROM biblib.library_state WHERE user_id = '10000000-0000-4000-8000-000000000002'), 'una escritura SQL administrativa rota la revisión');

  INSERT INTO auth.users(id) VALUES ('10000000-0000-4000-8000-000000000003');
  PERFORM public.assert_true(NOT EXISTS (SELECT 1 FROM biblib.library_state WHERE user_id = '10000000-0000-4000-8000-000000000003'), 'una cuenta nueva aún no tiene revisión');
  INSERT INTO biblib.shelves(id, user_id, title, is_default) VALUES ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000003', 'Predeterminada', true);
  INSERT INTO biblib.books(user_id, isbn, title, shelf_id) VALUES ('10000000-0000-4000-8000-000000000003', 'manual-c', 'Libro de C', '20000000-0000-4000-8000-000000000005');
  PERFORM public.assert_true(EXISTS (SELECT 1 FROM biblib.library_state WHERE user_id = '10000000-0000-4000-8000-000000000003'), 'la primera escritura crea la revisión de forma perezosa');
  DELETE FROM auth.users WHERE id = '10000000-0000-4000-8000-000000000003';
  PERFORM public.assert_true(NOT EXISTS (SELECT 1 FROM biblib.library_state WHERE user_id = '10000000-0000-4000-8000-000000000003'), 'borrar la cuenta elimina su revisión sin recrearla');
  PERFORM public.assert_true(NOT EXISTS (SELECT 1 FROM biblib.books WHERE user_id = '10000000-0000-4000-8000-000000000003'), 'borrar la cuenta elimina sus libros');
END;
$test$;

SELECT 'Correcto: revisión de colección, bloqueo, rotación única, aislamiento A/B, vistas previas e idempotencia.' AS resultado;

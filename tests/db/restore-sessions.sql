-- U-DAT-04: sesiones de restauración por partes. Se ejecuta tras 0008 con cuentas propias (E y F).
-- RLS de propietario y FK compuestas, hash y tamaño de cada trozo comprobados por Postgres, trozos y
-- filas inmutables, guarda de sesión que recibe y no ha caducado, operación restore.commit, purga
-- solo desde el servidor y cascadas al borrar la sesión o la cuenta.
INSERT INTO auth.users(id) VALUES ('10000000-0000-4000-8000-0000000000e1'), ('10000000-0000-4000-8000-0000000000f1');

-- E abre una sesión con una parte de dos trozos (262 144 + 10 bytes).
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000e1', true);
DO $test$
DECLARE
  session_id uuid := '40000000-0000-4000-8000-0000000000e1';
  big bytea := convert_to(repeat('a', 262144), 'UTF8');
  small bytea := convert_to('0123456789', 'UTF8');
BEGIN
  INSERT INTO biblib.import_sessions(id, user_id, source, export_set_id, manifest, manifest_digest, base_revision, rules_version, part_count, total_bytes, expires_at)
  VALUES (session_id, auth.uid(), 'manifest', gen_random_uuid(), '{}', repeat('a', 64), gen_random_uuid(), 1, 1, 262154, now() + interval '7 days');
  INSERT INTO biblib.import_session_parts(session_id, user_id, part_id, part_index, byte_length, sha256, total_chunks)
  VALUES (session_id, auth.uid(), 'parte-01', 0, 262154, repeat('b', 64), 2);
  INSERT INTO biblib.import_session_chunks(session_id, user_id, part_id, ordinal, byte_length, sha256, bytes)
  VALUES (session_id, auth.uid(), 'parte-01', 0, 262144, encode(sha256(big), 'hex'), big);
  BEGIN
    INSERT INTO biblib.import_session_chunks(session_id, user_id, part_id, ordinal, byte_length, sha256, bytes)
    VALUES (session_id, auth.uid(), 'parte-01', 1, 10, repeat('c', 64), small);
    RAISE EXCEPTION 'Prueba fallida: un trozo con un hash que no es el de sus bytes';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.import_session_chunks(session_id, user_id, part_id, ordinal, byte_length, sha256, bytes)
    VALUES (session_id, auth.uid(), 'parte-01', 1, 11, encode(sha256(small), 'hex'), small);
    RAISE EXCEPTION 'Prueba fallida: un tamaño declarado distinto del real';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.import_session_chunks(session_id, user_id, part_id, ordinal, byte_length, sha256, bytes)
    VALUES (session_id, auth.uid(), 'parte-01', 2, 262145, encode(sha256(big || '\x00'::bytea), 'hex'), big || '\x00'::bytea);
    RAISE EXCEPTION 'Prueba fallida: un trozo de más de 256 KiB';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.import_session_chunks(session_id, user_id, part_id, ordinal, byte_length, sha256, bytes)
    VALUES (session_id, auth.uid(), 'parte-01', 0, 10, encode(sha256(small), 'hex'), small);
    RAISE EXCEPTION 'Prueba fallida: otro contenido en la misma posición';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.import_session_chunks(session_id, user_id, part_id, ordinal, byte_length, sha256, bytes)
    VALUES (session_id, auth.uid(), 'parte-99', 0, 10, encode(sha256(small), 'hex'), small);
    RAISE EXCEPTION 'Prueba fallida: un trozo de una parte que no existe';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    UPDATE biblib.import_session_chunks SET bytes = small;
    RAISE EXCEPTION 'Prueba fallida: authenticated modificó un trozo';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO biblib.import_session_parts(session_id, user_id, part_id, part_index, byte_length, sha256, total_chunks)
    VALUES (session_id, auth.uid(), 'parte-02', 1, 262154, repeat('d', 64), 1);
    RAISE EXCEPTION 'Prueba fallida: una parte con un número de trozos que no corresponde a su tamaño';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.import_session_parts(session_id, user_id, part_id, part_index, byte_length, sha256, total_chunks)
    VALUES (session_id, auth.uid(), 'parte-02', 1, 8388609, repeat('d', 64), 33);
    RAISE EXCEPTION 'Prueba fallida: una parte de más de 8 MiB';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE biblib.import_sessions SET total_bytes = 83886081 WHERE id = session_id;
    RAISE EXCEPTION 'Prueba fallida: un conjunto de más de 80 MiB';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE biblib.import_sessions SET state = 'committed' WHERE id = session_id;
    RAISE EXCEPTION 'Prueba fallida: publicada sin operación ni vista previa';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO biblib.import_session_rows(session_id, user_id, kind, row_key, part_index, position, data)
  VALUES (session_id, auth.uid(), 'book', 'libro-1', 0, 0, '{"id":"libro-1"}');
  BEGIN
    UPDATE biblib.import_session_rows SET data = '{}';
    RAISE EXCEPTION 'Prueba fallida: authenticated modificó una fila validada';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM biblib.import_session_purge_expired(10);
    RAISE EXCEPTION 'Prueba fallida: authenticated ejecutó la purga';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- La operación de publicación de un conjunto es un motivo admitido del registro durable.
  INSERT INTO biblib.library_operations(user_id, operation, idempotency_key, input_digest, status, result)
  VALUES (auth.uid(), 'restore.commit', 'clave-restaurar-e-0001', repeat('e', 64), 'committed', '{}');
END;
$test$;
COMMIT;

-- F no ve ni puede escribir en la sesión de E; ni con su propio user_id ni con el de E.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000f1', true);
DO $test$
DECLARE small bytea := convert_to('0123456789', 'UTF8');
BEGIN
  PERFORM public.assert_true((SELECT count(*) FROM biblib.import_sessions) = 0, 'F no ve sesiones de E');
  PERFORM public.assert_true((SELECT count(*) FROM biblib.import_session_parts) = 0 AND (SELECT count(*) FROM biblib.import_session_chunks) = 0 AND (SELECT count(*) FROM biblib.import_session_rows) = 0, 'ni sus partes, trozos o filas');
  BEGIN
    INSERT INTO biblib.import_session_chunks(session_id, user_id, part_id, ordinal, byte_length, sha256, bytes)
    VALUES ('40000000-0000-4000-8000-0000000000e1', '10000000-0000-4000-8000-0000000000e1', 'parte-01', 1, 10, encode(sha256(small), 'hex'), small);
    RAISE EXCEPTION 'Prueba fallida: F escribió un trozo en nombre de E';
  -- La guarda (que no ve la sesión de E) o la política WITH CHECK lo rechazan.
  EXCEPTION WHEN insufficient_privilege OR SQLSTATE 'BR001' THEN NULL; END;
  BEGIN
    INSERT INTO biblib.import_session_chunks(session_id, user_id, part_id, ordinal, byte_length, sha256, bytes)
    VALUES ('40000000-0000-4000-8000-0000000000e1', auth.uid(), 'parte-01', 1, 10, encode(sha256(small), 'hex'), small);
    RAISE EXCEPTION 'Prueba fallida: F colgó un trozo de la parte de E';
  EXCEPTION WHEN foreign_key_violation OR SQLSTATE 'BR001' THEN NULL; END;
  UPDATE biblib.import_sessions SET state = 'rejected' WHERE id = '40000000-0000-4000-8000-0000000000e1';
  DELETE FROM biblib.import_sessions WHERE id = '40000000-0000-4000-8000-0000000000e1';
END;
$test$;
COMMIT;
DO $test$
BEGIN
  PERFORM public.assert_true((SELECT state FROM biblib.import_sessions WHERE id = '40000000-0000-4000-8000-0000000000e1') = 'receiving', 'F no cambia ni borra la sesión de E');
END;
$test$;

-- La guarda: una sesión validada o caducada ya no admite trozos ni filas nuevos.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000e1', true);
DO $test$
DECLARE
  session_id uuid := '40000000-0000-4000-8000-0000000000e1';
  small bytea := convert_to('0123456789', 'UTF8');
BEGIN
  UPDATE biblib.import_sessions SET state = 'validated' WHERE id = session_id;
  BEGIN
    INSERT INTO biblib.import_session_chunks(session_id, user_id, part_id, ordinal, byte_length, sha256, bytes)
    VALUES (session_id, auth.uid(), 'parte-01', 1, 10, encode(sha256(small), 'hex'), small);
    RAISE EXCEPTION 'Prueba fallida: un trozo nuevo en una sesión validada';
  EXCEPTION WHEN SQLSTATE 'BR001' THEN NULL; END;
  BEGIN
    INSERT INTO biblib.import_session_rows(session_id, user_id, kind, row_key, part_index, position, data)
    VALUES (session_id, auth.uid(), 'book', 'libro-2', 0, 1, '{"id":"libro-2"}');
    RAISE EXCEPTION 'Prueba fallida: una fila nueva en una sesión validada';
  EXCEPTION WHEN SQLSTATE 'BR001' THEN NULL; END;
  UPDATE biblib.import_sessions SET state = 'receiving', expires_at = created_at + interval '1 millisecond' WHERE id = session_id;
  BEGIN
    INSERT INTO biblib.import_session_chunks(session_id, user_id, part_id, ordinal, byte_length, sha256, bytes)
    VALUES (session_id, auth.uid(), 'parte-01', 1, 10, encode(sha256(small), 'hex'), small);
    RAISE EXCEPTION 'Prueba fallida: un trozo nuevo en una sesión caducada';
  EXCEPTION WHEN SQLSTATE 'BR001' THEN NULL; END;
END;
$test$;
COMMIT;

-- La purga del servidor retira las sesiones caducadas con todo su staging; borrar la cuenta, el resto.
DO $test$
BEGIN
  PERFORM public.assert_true(biblib.import_session_purge_expired(100) = 1, 'la purga retira la sesión caducada');
  PERFORM public.assert_true(NOT EXISTS (SELECT 1 FROM biblib.import_session_parts WHERE user_id = '10000000-0000-4000-8000-0000000000e1')
    AND NOT EXISTS (SELECT 1 FROM biblib.import_session_chunks WHERE user_id = '10000000-0000-4000-8000-0000000000e1')
    AND NOT EXISTS (SELECT 1 FROM biblib.import_session_rows WHERE user_id = '10000000-0000-4000-8000-0000000000e1'), 'con sus partes, trozos y filas');
  INSERT INTO biblib.import_sessions(user_id, source, export_set_id, manifest, manifest_digest, base_revision, rules_version, part_count, total_bytes, expires_at)
  VALUES ('10000000-0000-4000-8000-0000000000f1', 'loose', gen_random_uuid(), '{}', repeat('f', 64), gen_random_uuid(), 1, 1, 10, now() + interval '7 days');
  PERFORM public.assert_true(biblib.import_session_purge_expired(100) = 0, 'una sesión vigente no se purga');
  DELETE FROM auth.users WHERE id IN ('10000000-0000-4000-8000-0000000000e1', '10000000-0000-4000-8000-0000000000f1');
  PERFORM public.assert_true(NOT EXISTS (SELECT 1 FROM biblib.import_sessions WHERE user_id IN ('10000000-0000-4000-8000-0000000000e1', '10000000-0000-4000-8000-0000000000f1')), 'borrar la cuenta elimina sus sesiones');
END;
$test$;

SELECT 'Correcto: sesiones de restauración (RLS E/F, hash y tamaño de trozos, inmutabilidad, guarda de sesión, restore.commit, purga y cascadas)';

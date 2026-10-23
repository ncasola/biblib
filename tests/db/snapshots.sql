-- U-DAT-02: versiones anteriores. Se ejecuta tras 0006 con cuentas propias (C y D) para no depender
-- del estado que dejan las pruebas anteriores. Captura en la misma transacción que la operación,
-- hashes, aislamiento C/D, permisos mínimos, IDs ocupados, cuota, tamaño, cuenta bloqueada,
-- caducidad, borrado con versión, cascadas y orígenes de vista previa.
INSERT INTO auth.users(id) VALUES ('10000000-0000-4000-8000-0000000000c1'), ('10000000-0000-4000-8000-0000000000d1');
INSERT INTO biblib.shelves(id, user_id, title, is_default) VALUES
  ('20000000-0000-4000-8000-0000000000c1', '10000000-0000-4000-8000-0000000000c1', 'Predeterminada', true),
  ('20000000-0000-4000-8000-0000000000c2', '10000000-0000-4000-8000-0000000000c1', 'Poesía', false),
  ('20000000-0000-4000-8000-0000000000d1', '10000000-0000-4000-8000-0000000000d1', 'Predeterminada', true);
INSERT INTO biblib.books(id, user_id, isbn, title, shelf_id, authors) VALUES
  ('30000000-0000-4000-8000-0000000000c1', '10000000-0000-4000-8000-0000000000c1', '9788401337208', 'Primero', '20000000-0000-4000-8000-0000000000c1', '[{"name":"Autoría"}]'),
  ('30000000-0000-4000-8000-0000000000c2', '10000000-0000-4000-8000-0000000000c1', 'manual-c-2', 'Segundo', '20000000-0000-4000-8000-0000000000c2', '[]'),
  ('30000000-0000-4000-8000-0000000000c3', '10000000-0000-4000-8000-0000000000c1', 'manual-c-3', 'Tercero', '20000000-0000-4000-8000-0000000000c2', '[]');
CREATE TEMP TABLE snapshot_ids (name text PRIMARY KEY, id uuid, version uuid);
GRANT ALL ON snapshot_ids TO authenticated;

-- C reemplaza: la operación y la captura en la misma transacción producen una versión completa.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000c1', true);
DO $test$
DECLARE r jsonb; op uuid := gen_random_uuid(); snap biblib.library_snapshots%ROWTYPE; recomputed text;
BEGIN
  INSERT INTO biblib.library_operations(id, user_id, operation, idempotency_key, input_digest, status, result)
  VALUES (op, auth.uid(), 'import.confirm', 'clave-reemplazo-c-0001', repeat('a', 64), 'committed', '{}');
  r := biblib.library_snapshot_capture(op, 'import.replace');
  SELECT * INTO snap FROM biblib.library_snapshots WHERE id = (r->>'id')::uuid;
  PERFORM public.assert_true(snap.state = 'ready' AND snap.reason = 'import.replace' AND snap.source_operation_id = op, 'la captura queda completa y cita su operación');
  PERFORM public.assert_true(snap.counts->>'books' = '3' AND snap.counts->>'shelves' = '2' AND snap.counts->>'chunks' = '2', 'cantidades y trozos de C');
  PERFORM public.assert_true(snap.captured_revision = (SELECT revision FROM biblib.library_state WHERE user_id = auth.uid()), 'captura la revisión vigente');
  PERFORM public.assert_true(snap.expires_at BETWEEN snap.created_at + interval '29 days 23 hours' AND snap.created_at + interval '30 days 1 hour', 'retención de 30 días');
  PERFORM public.assert_true(NOT EXISTS (SELECT 1 FROM biblib.library_snapshot_chunks c WHERE c.snapshot_id = snap.id AND c.digest <> encode(sha256(convert_to(c.payload::text, 'UTF8')), 'hex')), 'cada trozo conserva su hash');
  SELECT encode(sha256(convert_to(concat_ws('|', 'biblib.snapshot.v1', 3, 2, string_agg(c.digest, '' ORDER BY c.seq)), 'UTF8')), 'hex') INTO recomputed FROM biblib.library_snapshot_chunks c WHERE c.snapshot_id = snap.id;
  PERFORM public.assert_true(recomputed = snap.digest, 'el hash final cubre cantidades y trozos en orden');
  PERFORM public.assert_true((SELECT payload->0->>'title' FROM biblib.library_snapshot_chunks WHERE snapshot_id = snap.id AND seq = 0) = 'Predeterminada', 'las estanterías van primero, en orden de creación');
  PERFORM public.assert_true((SELECT bool_and(NOT (item ? 'version')) FROM biblib.library_snapshot_chunks c, jsonb_array_elements(c.payload) item WHERE c.snapshot_id = snap.id AND c.kind = 'books'), 'la versión no guarda tokens de edición');
  INSERT INTO snapshot_ids VALUES ('c', snap.id, snap.version);
  BEGIN
    PERFORM biblib.library_snapshot_capture(op, 'import.replace');
    RAISE EXCEPTION 'Prueba fallida: dos versiones para la misma operación';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    PERFORM biblib.library_snapshot_capture(op, 'otro');
    RAISE EXCEPTION 'Prueba fallida: motivo libre';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    UPDATE biblib.library_snapshots SET expires_at = expires_at + interval '1 year';
    RAISE EXCEPTION 'Prueba fallida: authenticated alargó una versión';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO biblib.library_snapshots (user_id, source_operation_id, reason, captured_revision, state, digest, expires_at) VALUES (auth.uid(), op, 'import.replace', gen_random_uuid(), 'ready', repeat('b', 64), now() + interval '1 day');
    RAISE EXCEPTION 'Prueba fallida: authenticated insertó una versión directamente';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE biblib.library_snapshot_chunks SET payload = '[]';
    RAISE EXCEPTION 'Prueba fallida: authenticated alteró un trozo';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    DELETE FROM biblib.library_snapshot_chunks;
    RAISE EXCEPTION 'Prueba fallida: authenticated borró trozos';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM biblib.library_snapshot_purge_expired(10);
    RAISE EXCEPTION 'Prueba fallida: authenticated purgó versiones';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$test$;
COMMIT;

-- Una operación de otra transacción no autoriza capturas: solo la publicación que sustituye el estado.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000c1', true);
DO $test$
BEGIN
  PERFORM biblib.library_snapshot_capture((SELECT source_operation_id FROM biblib.library_snapshots WHERE id = (SELECT id FROM snapshot_ids WHERE name = 'c')), 'import.replace');
  RAISE EXCEPTION 'Prueba fallida: captura con una operación ya confirmada';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$test$;
COMMIT;

-- D no ve, no consulta IDs, no borra ni cita la versión de C.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000d1', true);
DO $test$
DECLARE c_snapshot uuid := (SELECT id FROM snapshot_ids WHERE name = 'c'); c_version uuid := (SELECT version FROM snapshot_ids WHERE name = 'c');
BEGIN
  PERFORM public.assert_true((SELECT count(*) FROM biblib.library_snapshots) = 0, 'D no lista versiones de C');
  PERFORM public.assert_true((SELECT count(*) FROM biblib.library_snapshot_chunks) = 0, 'D no descarga trozos de C');
  PERFORM public.assert_true(cardinality(biblib.library_snapshot_foreign_ids(c_snapshot)) = 0, 'D no consulta IDs de una versión de C');
  PERFORM public.assert_true(biblib.library_snapshot_delete(c_snapshot, c_version) = 'not_found', 'D no borra la versión de C ni confirma que existe');
  BEGIN
    INSERT INTO biblib.import_previews (user_id, revision, input_digest, mode, rules_version, plan, snapshot_id, expires_at)
    VALUES (auth.uid(), gen_random_uuid(), repeat('c', 64), 'replace', 1, '{}', c_snapshot, now() + interval '30 minutes');
    RAISE EXCEPTION 'Prueba fallida: D preparó una restauración con una versión de C';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END;
$test$;
COMMIT;

-- Orígenes de una vista previa, IDs ocupados por otra cuenta, borrado con versión y cascadas.
DO $test$
DECLARE c_snapshot uuid := (SELECT id FROM snapshot_ids WHERE name = 'c'); c_version uuid := (SELECT version FROM snapshot_ids WHERE name = 'c'); preview uuid;
BEGIN
  BEGIN
    INSERT INTO biblib.import_previews (user_id, revision, input_digest, mode, rules_version, plan, expires_at)
    VALUES ('10000000-0000-4000-8000-0000000000c1', gen_random_uuid(), repeat('c', 64), 'replace', 1, '{}', now() + interval '30 minutes');
    RAISE EXCEPTION 'Prueba fallida: vista previa sin archivo ni versión';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.import_previews (user_id, revision, input_digest, mode, rules_version, plan, payload, snapshot_id, expires_at)
    VALUES ('10000000-0000-4000-8000-0000000000c1', gen_random_uuid(), repeat('c', 64), 'replace', 1, '{}', '{}', c_snapshot, now() + interval '30 minutes');
    RAISE EXCEPTION 'Prueba fallida: vista previa con archivo y versión';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO biblib.import_previews (user_id, revision, input_digest, mode, rules_version, plan, snapshot_id, expires_at)
  VALUES ('10000000-0000-4000-8000-0000000000c1', gen_random_uuid(), repeat('c', 64), 'replace', 1, '{}', c_snapshot, now() + interval '30 minutes')
  RETURNING id INTO preview;
  -- El libro c3 se borra después de la captura y su ID lo ocupa otra cuenta.
  DELETE FROM biblib.books WHERE id = '30000000-0000-4000-8000-0000000000c3';
  INSERT INTO biblib.books(id, user_id, isbn, title, shelf_id) VALUES ('30000000-0000-4000-8000-0000000000c3', '10000000-0000-4000-8000-0000000000d1', 'manual-d-1', 'De D', '20000000-0000-4000-8000-0000000000d1');
  PERFORM set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000c1', true);
  PERFORM public.assert_true(biblib.library_snapshot_foreign_ids(c_snapshot) = ARRAY['30000000-0000-4000-8000-0000000000c3'::uuid], 'detecta el ID propio que hoy usa otra cuenta');
  PERFORM public.assert_true(biblib.library_snapshot_delete(c_snapshot, gen_random_uuid()) = 'conflict', 'borrar con una versión antigua es un conflicto');
  BEGIN
    DELETE FROM biblib.library_operations WHERE id = (SELECT source_operation_id FROM biblib.library_snapshots WHERE id = c_snapshot);
    RAISE EXCEPTION 'Prueba fallida: purgar la operación borró la versión en silencio';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  PERFORM public.assert_true(biblib.library_snapshot_delete(c_snapshot, c_version) = 'deleted', 'C borra su versión con la versión vista');
  PERFORM public.assert_true(NOT EXISTS (SELECT 1 FROM biblib.library_snapshot_chunks WHERE snapshot_id = c_snapshot), 'borrar la versión borra sus trozos');
  PERFORM public.assert_true(NOT EXISTS (SELECT 1 FROM biblib.import_previews WHERE id = preview), 'borrar la versión invalida sus vistas previas de restauración');
  PERFORM set_config('request.jwt.claim.sub', '', true);
  DELETE FROM biblib.books WHERE id = '30000000-0000-4000-8000-0000000000c3';
END;
$test$;

-- Cuota: con 10 versiones vigentes se bloquea la siguiente sin borrar ninguna; una vencida deja sitio.
DO $test$
DECLARE op uuid; i integer; before_ids uuid[];
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000c1', true);
  FOR i IN 1..10 LOOP
    op := gen_random_uuid();
    INSERT INTO biblib.library_operations(id, user_id, operation, idempotency_key, input_digest, status, result)
    VALUES (op, '10000000-0000-4000-8000-0000000000c1', 'import.confirm', 'clave-cuota-c-' || lpad(i::text, 4, '0'), repeat('a', 64), 'committed', '{}');
    PERFORM biblib.library_snapshot_capture(op, 'import.replace');
  END LOOP;
  SELECT array_agg(id ORDER BY id) INTO before_ids FROM biblib.library_snapshots WHERE user_id = '10000000-0000-4000-8000-0000000000c1';
  op := gen_random_uuid();
  INSERT INTO biblib.library_operations(id, user_id, operation, idempotency_key, input_digest, status, result)
  VALUES (op, '10000000-0000-4000-8000-0000000000c1', 'import.confirm', 'clave-cuota-c-0011', repeat('a', 64), 'committed', '{}');
  BEGIN
    PERFORM biblib.library_snapshot_capture(op, 'import.replace');
    RAISE EXCEPTION 'Prueba fallida: se superó la cuota';
  EXCEPTION WHEN SQLSTATE 'BS001' THEN NULL; END;
  PERFORM public.assert_true((SELECT array_agg(id ORDER BY id) FROM biblib.library_snapshots WHERE user_id = '10000000-0000-4000-8000-0000000000c1') = before_ids, 'la cuota agotada no borra ninguna versión vigente');
  UPDATE biblib.library_snapshots SET expires_at = created_at + interval '1 microsecond' WHERE id = before_ids[1];
  PERFORM public.assert_true((biblib.library_snapshot_capture(op, 'import.replace'))->>'id' IS NOT NULL, 'una versión vencida libera su plaza al capturar');
  PERFORM public.assert_true(NOT EXISTS (SELECT 1 FROM biblib.library_snapshots WHERE id = before_ids[1]), 'la vencida se retira');
  UPDATE biblib.library_snapshots SET expires_at = created_at + interval '1 microsecond' WHERE id = before_ids[2];
  PERFORM public.assert_true(biblib.library_snapshot_purge_expired(100) = 1, 'la purga del servidor retira las vencidas');
  PERFORM set_config('request.jwt.claim.sub', '', true);
END;
$test$;

-- Cuenta bloqueada y colección demasiado grande: la operación destructiva no puede capturar.
DO $test$
DECLARE op uuid := gen_random_uuid(); shelf uuid := '20000000-0000-4000-8000-0000000000d1';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000d1', true);
  INSERT INTO biblib.library_operations(id, user_id, operation, idempotency_key, input_digest, status, result)
  VALUES (op, '10000000-0000-4000-8000-0000000000d1', 'import.confirm', 'clave-bloqueo-d-0001', repeat('a', 64), 'committed', '{}');
  PERFORM biblib.account_set_state('10000000-0000-4000-8000-0000000000d1', 'blocked');
  BEGIN
    PERFORM biblib.library_snapshot_capture(op, 'import.replace');
    RAISE EXCEPTION 'Prueba fallida: una cuenta bloqueada capturó';
  EXCEPTION WHEN SQLSTATE 'BS002' THEN NULL; END;
  PERFORM biblib.account_set_state('10000000-0000-4000-8000-0000000000d1', 'active');
  INSERT INTO biblib.books(user_id, isbn, title, shelf_id) SELECT '10000000-0000-4000-8000-0000000000d1', 'manual-grande-' || n, 'Libro ' || n, shelf FROM generate_series(1, 10001) AS n;
  BEGIN
    PERFORM biblib.library_snapshot_capture(op, 'import.replace');
    RAISE EXCEPTION 'Prueba fallida: se capturó una colección por encima del límite';
  EXCEPTION WHEN SQLSTATE 'BS003' THEN NULL; END;
  PERFORM public.assert_true(NOT EXISTS (SELECT 1 FROM biblib.library_snapshots WHERE user_id = '10000000-0000-4000-8000-0000000000d1'), 'ningún intento dejó una versión parcial');
  PERFORM set_config('request.jwt.claim.sub', '', true);
END;
$test$;

-- Borrar la cuenta elimina sus versiones, trozos y operaciones.
DO $test$
BEGIN
  DELETE FROM auth.users WHERE id IN ('10000000-0000-4000-8000-0000000000c1', '10000000-0000-4000-8000-0000000000d1');
  PERFORM public.assert_true(NOT EXISTS (SELECT 1 FROM biblib.library_snapshots WHERE user_id IN ('10000000-0000-4000-8000-0000000000c1', '10000000-0000-4000-8000-0000000000d1')), 'borrar la cuenta elimina sus versiones');
  PERFORM public.assert_true(NOT EXISTS (SELECT 1 FROM biblib.library_snapshot_chunks WHERE user_id IN ('10000000-0000-4000-8000-0000000000c1', '10000000-0000-4000-8000-0000000000d1')), 'y sus trozos');
  DELETE FROM biblib.account_lifecycle;
END;
$test$;

SELECT 'Correcto: versiones anteriores (captura en la transacción, hashes, C/D, permisos, IDs ocupados, borrado, cuota, cuenta bloqueada, tamaño y cascadas)';

-- U-DAT-10: portadas privadas. Se ejecuta tras 0009 con cuentas propias (G y H) y el sustituto de
-- Storage de bootstrap.sql. RLS y FK con propietario, políticas de storage.objects por intento
-- autorizado, registro solo con objeto presente, deduplicación por dueño, guarda de adjunto, trabajos
-- de adquisición fuera del ejecutor sin sesión, purga que respeta fichas y versiones anteriores,
-- cuenta bloqueada, cuotas y permisos de cliente.
INSERT INTO auth.users(id) VALUES ('10000000-0000-4000-8000-0000000000a7'), ('10000000-0000-4000-8000-0000000000b7');

-- G tiene una estantería y un libro; H, otro libro.
INSERT INTO biblib.shelves(id, user_id, title, is_default) VALUES
  ('20000000-0000-4000-8000-0000000000a7', '10000000-0000-4000-8000-0000000000a7', 'Predeterminada', true),
  ('20000000-0000-4000-8000-0000000000b7', '10000000-0000-4000-8000-0000000000b7', 'Predeterminada', true);
INSERT INTO biblib.books(id, user_id, isbn, title, shelf_id) VALUES
  ('30000000-0000-4000-8000-0000000000a7', '10000000-0000-4000-8000-0000000000a7', '9780000000019', 'Libro de G', '20000000-0000-4000-8000-0000000000a7'),
  ('30000000-0000-4000-8000-0000000000b7', '10000000-0000-4000-8000-0000000000b7', '9780000000026', 'Libro de H', '20000000-0000-4000-8000-0000000000b7');

SELECT assert_true((SELECT public = false AND allowed_mime_types = ARRAY['image/webp'] AND file_size_limit = 5242880 FROM storage.buckets WHERE id = 'biblib-covers'), 'bucket privado de portadas, solo WebP y 5 MiB');
SELECT 'Correcto: bucket privado biblib-covers con WebP y 5 MiB';

-- G reserva una subida, sube solo el intento autorizado y registra el asset validado.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000a7', true);
DO $test$
DECLARE
  begun jsonb := biblib.cover_asset_begin_upload();
  asset_id uuid := (begun->>'asset_id')::uuid;
  token text := begun->>'upload_token';
  key text := '10000000-0000-4000-8000-0000000000a7/' || asset_id || '/' || token || '.webp';
  registered jsonb;
BEGIN
  PERFORM assert_true(begun->>'status' = 'created', 'reserva de subida propia');
  PERFORM assert_true((SELECT state = 'quarantine' AND expires_at <= clock_timestamp() + interval '15 minutes' AND expires_at > now() + interval '14 minutes' FROM biblib.cover_assets WHERE id = asset_id), 'nace en cuarentena de 15 minutos');
  BEGIN
    INSERT INTO storage.objects(bucket_id, name, metadata) VALUES ('biblib-covers', '10000000-0000-4000-8000-0000000000a7/' || asset_id || '/otro.webp', '{"size": 10}');
    RAISE EXCEPTION 'Prueba fallida: subió un intento no autorizado';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  registered := biblib.cover_asset_register(asset_id, token, repeat('a', 64), 10, 100, 150, NULL);
  PERFORM assert_true(registered->>'status' = 'missing_object', 'sin objeto en Storage no se registra');
  INSERT INTO storage.objects(bucket_id, name, metadata) VALUES ('biblib-covers', key, '{"size": 10}');
  PERFORM assert_true(biblib.cover_asset_register(asset_id, 'otro', repeat('a', 64), 10, 100, 150, NULL)->>'status' = 'stale', 'otro token no registra');
  PERFORM assert_true(biblib.cover_asset_register(asset_id, token, repeat('a', 64), 11, 100, 150, NULL)->>'status' = 'missing_object', 'tamaño distinto del objeto no registra');
  registered := biblib.cover_asset_register(asset_id, token, repeat('a', 64), 10, 100, 150, NULL);
  PERFORM assert_true(registered->>'status' = 'ready', 'registro del asset validado');
  PERFORM assert_true((SELECT state = 'ready' AND storage_key = key AND upload_token IS NULL AND mime = 'image/webp' FROM biblib.cover_assets WHERE id = asset_id), 'asset utilizable con su clave');
  PERFORM assert_true(biblib.cover_asset_register(asset_id, token, repeat('a', 64), 10, 100, 150, NULL)->>'status' = 'stale', 'repetir el registro no cambia nada');
  -- El objeto registrado de un asset utilizable no se puede borrar ni sustituir desde el cliente.
  DELETE FROM storage.objects WHERE name = key;
  PERFORM assert_true(EXISTS (SELECT 1 FROM storage.objects WHERE name = key), 'el objeto registrado no se borra');
  UPDATE storage.objects SET metadata = '{"size": 1}' WHERE name = key;
  PERFORM assert_true((SELECT metadata->>'size' = '10' FROM storage.objects WHERE name = key), 'el objeto registrado no se modifica');
  PERFORM set_config('biblib.test_asset', asset_id::text, false);
END;
$test$;
COMMIT;
SELECT 'Correcto: subida propia en cuarentena, intento autorizado, registro con objeto presente e inmutable';

-- Misma imagen otra vez: se deduplica dentro del dueño; H no ve ni lee nada de G.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000a7', true);
DO $test$
DECLARE
  begun jsonb := biblib.cover_asset_begin_upload();
  asset_id uuid := (begun->>'asset_id')::uuid;
  token text := begun->>'upload_token';
  result jsonb;
BEGIN
  INSERT INTO storage.objects(bucket_id, name, metadata) VALUES ('biblib-covers', '10000000-0000-4000-8000-0000000000a7/' || asset_id || '/' || token || '.webp', '{"size": 10}');
  result := biblib.cover_asset_register(asset_id, token, repeat('a', 64), 10, 100, 150, NULL);
  PERFORM assert_true(result->>'status' = 'duplicate' AND result->>'asset_id' = current_setting('biblib.test_asset'), 'la misma imagen devuelve el asset existente');
  PERFORM assert_true(NOT EXISTS (SELECT 1 FROM biblib.cover_assets WHERE id = asset_id), 'la cuarentena duplicada se descarta');
END;
$test$;
COMMIT;
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000b7', true);
DO $test$
DECLARE
  begun jsonb;
BEGIN
  PERFORM assert_true((SELECT count(*) FROM biblib.cover_assets) = 0, 'H no ve assets de G');
  PERFORM assert_true((SELECT count(*) FROM storage.objects WHERE bucket_id = 'biblib-covers') = 0, 'H no ve objetos de G');
  BEGIN
    UPDATE biblib.books SET cover_asset_id = current_setting('biblib.test_asset')::uuid WHERE id = '30000000-0000-4000-8000-0000000000b7';
    RAISE EXCEPTION 'Prueba fallida: H adjuntó el asset de G';
  EXCEPTION WHEN OTHERS THEN IF SQLSTATE NOT IN ('BA001', '23503') THEN RAISE; END IF; END;
  -- Aunque conozca la ruta exacta, H no puede subir ni retirar objetos en la carpeta de G.
  begun := biblib.cover_asset_begin_upload();
  BEGIN
    INSERT INTO storage.objects(bucket_id, name, metadata) VALUES ('biblib-covers', '10000000-0000-4000-8000-0000000000a7/' || (begun->>'asset_id') || '/' || (begun->>'upload_token') || '.webp', '{"size": 10}');
    RAISE EXCEPTION 'Prueba fallida: H subió en la carpeta de G';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM assert_true(biblib.cover_asset_register(current_setting('biblib.test_asset')::uuid, 'x', repeat('b', 64), 10, 1, 1, NULL)->>'status' = 'not_found', 'H no registra un asset de G');
  PERFORM assert_true(NOT biblib.cover_asset_discard(current_setting('biblib.test_asset')::uuid), 'H no descarta un asset de G');
  PERFORM assert_true(biblib.cover_asset_discard((begun->>'asset_id')::uuid), 'H descarta su propia cuarentena');
END;
$test$;
COMMIT;
BEGIN;
SET LOCAL ROLE anon;
SELECT assert_true((SELECT count(*) FROM storage.objects WHERE bucket_id = 'biblib-covers') = 0, 'anon no ve objetos de portadas');
COMMIT;
SELECT 'Correcto: deduplicación solo dentro del dueño; H y anon no ven, suben, registran ni descartan nada de G';

-- Adjuntar: solo un asset propio utilizable; la versión de la ficha rota.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000a7', true);
DO $test$
DECLARE
  before_version uuid := (SELECT version FROM biblib.books WHERE id = '30000000-0000-4000-8000-0000000000a7');
  pending uuid := ((biblib.cover_asset_begin_upload())->>'asset_id')::uuid;
BEGIN
  BEGIN
    UPDATE biblib.books SET cover_asset_id = pending WHERE id = '30000000-0000-4000-8000-0000000000a7';
    RAISE EXCEPTION 'Prueba fallida: adjuntó un asset en cuarentena';
  EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> 'BA001' THEN RAISE; END IF; END;
  UPDATE biblib.books SET cover_asset_id = current_setting('biblib.test_asset')::uuid WHERE id = '30000000-0000-4000-8000-0000000000a7';
  PERFORM assert_true((SELECT version <> before_version AND cover_asset_id IS NOT NULL FROM biblib.books WHERE id = '30000000-0000-4000-8000-0000000000a7'), 'adjuntar rota la versión de la ficha');
  PERFORM assert_true(biblib.cover_asset_discard(pending), 'descarta su cuarentena');
  BEGIN
    INSERT INTO biblib.cover_assets(user_id, source_kind, source_ref, rights_policy_version, expires_at) VALUES (auth.uid(), 'upload', 'upload', 'upload.v1', now() + interval '1 hour');
    RAISE EXCEPTION 'Prueba fallida: authenticated insertó un asset directamente';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE biblib.cover_assets SET state = 'ready';
    RAISE EXCEPTION 'Prueba fallida: authenticated modificó un asset directamente';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM biblib.cover_asset_purge_candidates(NULL, 10, 0);
    RAISE EXCEPTION 'Prueba fallida: authenticated consultó candidatos de purga';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM biblib.cover_asset_quarantine_restored();
    RAISE EXCEPTION 'Prueba fallida: authenticated puso assets en cuarentena de restore';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$test$;
COMMIT;
SELECT 'Correcto: guarda de adjunto (BA001), FK con propietario y sin escritura directa ni funciones de servidor para authenticated';

-- Adquisición de un proveedor: derechos ya comprobados por el servidor; Google nunca; idempotencia y
-- ficha vigente; el ejecutor sin sesión no la reclama y la subida exige el lease y el fencing vigentes.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000a7', true);
DO $test$
DECLARE
  book_version uuid := (SELECT version FROM biblib.books WHERE id = '30000000-0000-4000-8000-0000000000a7');
  created jsonb;
BEGIN
  PERFORM assert_true(biblib.cover_asset_request('30000000-0000-4000-8000-0000000000a7', gen_random_uuid(), 'open-library:id:123', 'v1', 'OL', 'clave-adquisicion-0001', repeat('c', 64))->>'status' = 'stale', 'una versión de ficha antigua no crea nada');
  PERFORM assert_true(biblib.cover_asset_request('30000000-0000-4000-8000-0000000000b7', book_version, 'open-library:id:123', 'v1', 'OL', 'clave-adquisicion-0001', repeat('c', 64))->>'status' = 'not_found', 'una ficha ajena no existe');
  BEGIN
    PERFORM biblib.cover_asset_request('30000000-0000-4000-8000-0000000000a7', book_version, 'google-books:id:abc', 'v1', 'G', 'clave-adquisicion-0002', repeat('d', 64));
    RAISE EXCEPTION 'Prueba fallida: aceptó una clave de Google Books';
  EXCEPTION WHEN check_violation THEN NULL; END;
  created := biblib.cover_asset_request('30000000-0000-4000-8000-0000000000a7', book_version, 'open-library:id:123', 'v1', 'OL', 'clave-adquisicion-0001', repeat('c', 64));
  PERFORM assert_true(created->>'status' = 'created', 'solicitud creada');
  PERFORM assert_true(biblib.cover_asset_request('30000000-0000-4000-8000-0000000000a7', book_version, 'open-library:id:123', 'v1', 'OL', 'clave-adquisicion-0001', repeat('c', 64))->>'job_id' = created->>'job_id', 'repetir devuelve el mismo trabajo');
  PERFORM assert_true(biblib.cover_asset_request('30000000-0000-4000-8000-0000000000a7', book_version, 'open-library:id:999', 'v1', 'OL', 'clave-adquisicion-0001', repeat('e', 64))->>'status' = 'conflict', 'la misma clave con otra entrada es conflicto');
  PERFORM set_config('biblib.test_job', created->>'job_id', false);
  PERFORM set_config('biblib.test_job_asset', created->>'asset_id', false);
END;
$test$;
COMMIT;
DO $test$
DECLARE
  job_id uuid := current_setting('biblib.test_job')::uuid;
  asset_id uuid := current_setting('biblib.test_job_asset')::uuid;
  claimed jsonb;
BEGIN
  PERFORM assert_true(biblib.library_job_claim(NULL, '10000000-0000-4000-8000-0000000000a7', 60000) IS NULL, 'el ejecutor sin sesión no reclama adquisiciones de portada');
  claimed := biblib.library_job_claim(job_id, NULL, 60000);
  PERFORM assert_true(claimed->>'id' = job_id::text, 'la sesión del dueño reclama su trabajo por ID');
  PERFORM set_config('biblib.test_fence', claimed->>'fencing_number', false);
END;
$test$;
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000a7', true);
DO $test$
DECLARE
  asset_id uuid := current_setting('biblib.test_job_asset')::uuid;
  fence text := current_setting('biblib.test_fence');
  prefix text := '10000000-0000-4000-8000-0000000000a7/' || current_setting('biblib.test_job_asset') || '/';
BEGIN
  BEGIN
    INSERT INTO storage.objects(bucket_id, name, metadata) VALUES ('biblib-covers', prefix || fence || '.webp', '{"size": 10}');
    RAISE EXCEPTION 'Prueba fallida: subió sin intento autorizado';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM assert_true(biblib.cover_asset_authorize(asset_id, fence), 'el paso cercado autoriza su fencing');
  BEGIN
    INSERT INTO storage.objects(bucket_id, name, metadata) VALUES ('biblib-covers', prefix || '1' || fence || '.webp', '{"size": 10}');
    RAISE EXCEPTION 'Prueba fallida: subió con otro número de fencing';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  INSERT INTO storage.objects(bucket_id, name, metadata) VALUES ('biblib-covers', prefix || fence || '.webp', '{"size": 20}');
END;
$test$;
COMMIT;
-- Lease vencido: ningún trabajador antiguo vuelve a subir aunque conserve el token autorizado.
UPDATE biblib.library_jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = current_setting('biblib.test_job')::uuid;
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000a7', true);
DO $test$
BEGIN
  DELETE FROM storage.objects WHERE name LIKE '10000000-0000-4000-8000-0000000000a7/' || current_setting('biblib.test_job_asset') || '/%';
  BEGIN
    INSERT INTO storage.objects(bucket_id, name, metadata) VALUES ('biblib-covers', '10000000-0000-4000-8000-0000000000a7/' || current_setting('biblib.test_job_asset') || '/' || current_setting('biblib.test_fence') || '.webp', '{"size": 20}');
    RAISE EXCEPTION 'Prueba fallida: subió con un lease vencido';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$test$;
COMMIT;
SELECT 'Correcto: adquisición idempotente atada a la ficha vigente, Google rechazado por Postgres y subida solo con lease y fencing vigentes';

-- Versiones anteriores y purga: una referencia de ficha o de versión anterior protege el asset.
DO $test$
DECLARE
  asset_id uuid := current_setting('biblib.test_asset')::uuid;
  candidates jsonb;
  removed text[];
BEGIN
  INSERT INTO storage.objects(bucket_id, name, metadata, created_at) VALUES ('biblib-covers', '10000000-0000-4000-8000-0000000000a7/' || gen_random_uuid() || '/huerfano.webp', '{"size": 5}', now() - interval '1 hour');
  candidates := biblib.cover_asset_purge_candidates('10000000-0000-4000-8000-0000000000a7', 100, 0);
  PERFORM assert_true(NOT candidates->'assets' @> jsonb_build_array(jsonb_build_object('id', asset_id)), 'un asset adjunto a una ficha no se purga');
  PERFORM assert_true(jsonb_array_length(candidates->'objects') = 1 AND candidates->'objects'->0->>'key' LIKE '%/huerfano.webp', 'el objeto sin asset es purgable');
  UPDATE biblib.books SET cover_asset_id = NULL WHERE id = '30000000-0000-4000-8000-0000000000a7';
  INSERT INTO biblib.library_operations(id, user_id, operation, idempotency_key, input_digest, status, result)
  VALUES ('50000000-0000-4000-8000-0000000000a7', '10000000-0000-4000-8000-0000000000a7', 'snapshot.restore', 'clave-version-0000001', repeat('f', 64), 'committed', '{}');
  INSERT INTO biblib.library_snapshots(id, user_id, source_operation_id, reason, captured_revision, state, digest, expires_at)
  VALUES ('60000000-0000-4000-8000-0000000000a7', '10000000-0000-4000-8000-0000000000a7', '50000000-0000-4000-8000-0000000000a7', 'snapshot.restore', gen_random_uuid(), 'ready', repeat('f', 64), now() + interval '30 days');
  INSERT INTO biblib.library_snapshot_chunks(snapshot_id, user_id, seq, kind, item_count, payload, digest)
  VALUES ('60000000-0000-4000-8000-0000000000a7', '10000000-0000-4000-8000-0000000000a7', 0, 'books', 1, jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'cover_asset_id', asset_id)), repeat('f', 64));
  candidates := biblib.cover_asset_purge_candidates('10000000-0000-4000-8000-0000000000a7', 100, 0);
  PERFORM assert_true(NOT candidates->'assets' @> jsonb_build_array(jsonb_build_object('id', asset_id)), 'un asset citado por una versión anterior no se purga');
  DELETE FROM biblib.library_snapshots WHERE id = '60000000-0000-4000-8000-0000000000a7';
  candidates := biblib.cover_asset_purge_candidates('10000000-0000-4000-8000-0000000000a7', 100, 3600);
  PERFORM assert_true(NOT candidates->'assets' @> jsonb_build_array(jsonb_build_object('id', asset_id)), 'dentro del periodo de gracia no se purga');
  candidates := biblib.cover_asset_purge_candidates('10000000-0000-4000-8000-0000000000a7', 100, 0);
  PERFORM assert_true(candidates->'assets' @> jsonb_build_array(jsonb_build_object('id', asset_id, 'reason', 'unreferenced')), 'sin referencias y tras la gracia es purgable');
  PERFORM assert_true(NOT (biblib.cover_asset_purge_candidates('10000000-0000-4000-8000-0000000000b7', 100, 0)->'assets' @> jsonb_build_array(jsonb_build_object('id', asset_id))), 'la purga de H no ve assets de G');
  removed := biblib.cover_asset_purge_confirm('10000000-0000-4000-8000-0000000000a7', ARRAY[asset_id], 0);
  PERFORM assert_true(array_length(removed, 1) = 1 AND removed[1] LIKE '10000000-0000-4000-8000-0000000000a7/%', 'la purga devuelve la clave del objeto que queda huérfano');
  PERFORM assert_true(NOT EXISTS (SELECT 1 FROM biblib.cover_assets WHERE id = asset_id), 'fila retirada');
END;
$test$;
SELECT 'Correcto: fichas y versiones anteriores retienen el asset; gracia, huérfanos y purga confirmada';

-- La versión anterior guarda la referencia solo en las fichas con portada privada.
DO $test$
DECLARE
  begun jsonb;
  captured jsonb;
  payload jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000a7', true);
  begun := biblib.cover_asset_begin_upload();
  INSERT INTO storage.objects(bucket_id, name, metadata) VALUES ('biblib-covers', '10000000-0000-4000-8000-0000000000a7/' || (begun->>'asset_id') || '/' || (begun->>'upload_token') || '.webp', '{"size": 30}');
  PERFORM biblib.cover_asset_register((begun->>'asset_id')::uuid, begun->>'upload_token', repeat('9', 64), 30, 10, 10, NULL);
  UPDATE biblib.books SET cover_asset_id = (begun->>'asset_id')::uuid WHERE id = '30000000-0000-4000-8000-0000000000a7';
  INSERT INTO biblib.books(id, user_id, isbn, title, shelf_id) VALUES ('30000000-0000-4000-8000-0000000001a7', '10000000-0000-4000-8000-0000000000a7', '9780000000033', 'Sin portada privada', '20000000-0000-4000-8000-0000000000a7');
  INSERT INTO biblib.library_operations(id, user_id, operation, idempotency_key, input_digest, status, result)
  VALUES ('50000000-0000-4000-8000-0000000001a7', '10000000-0000-4000-8000-0000000000a7', 'snapshot.restore', 'clave-version-0000002', repeat('f', 64), 'committed', '{}');
  captured := biblib.library_snapshot_capture('50000000-0000-4000-8000-0000000001a7', 'snapshot.restore');
  SELECT jsonb_agg(item) INTO payload FROM biblib.library_snapshot_chunks AS c CROSS JOIN LATERAL jsonb_array_elements(c.payload) AS item WHERE c.snapshot_id = (captured->>'id')::uuid AND c.kind = 'books';
  PERFORM assert_true(payload @> jsonb_build_array(jsonb_build_object('id', '30000000-0000-4000-8000-0000000000a7', 'cover_asset_id', begun->>'asset_id')), 'la ficha con asset lo conserva en la versión');
  PERFORM assert_true((SELECT NOT (item ? 'cover_asset_id') FROM jsonb_array_elements(payload) AS item WHERE item->>'id' = '30000000-0000-4000-8000-0000000001a7'), 'una ficha sin asset conserva el formato de 0006');
  PERFORM set_config('biblib.test_asset', begun->>'asset_id', false);
END;
$test$;
SELECT 'Correcto: la versión anterior retiene la referencia sin cambiar las fichas sin asset';

-- Restore administrativo: los assets restaurados no se adjuntan ni se sirven hasta revalidarse.
DO $test$
DECLARE
  restored integer := biblib.cover_asset_quarantine_restored();
BEGIN
  PERFORM assert_true(restored >= 1 AND NOT EXISTS (SELECT 1 FROM biblib.cover_assets WHERE state = 'quarantine' AND (upload_token IS NOT NULL OR expires_at > clock_timestamp())), 'restaurados a revisión y cuarentenas caducadas sin intento autorizado');
  PERFORM set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000a7', true);
  BEGIN
    UPDATE biblib.books SET cover_asset_id = current_setting('biblib.test_asset')::uuid WHERE id = '30000000-0000-4000-8000-0000000001a7';
    RAISE EXCEPTION 'Prueba fallida: adjuntó un asset restaurado sin revisar';
  EXCEPTION WHEN OTHERS THEN IF SQLSTATE <> 'BA001' THEN RAISE; END IF; END;
  PERFORM assert_true(biblib.cover_asset_revalidate(current_setting('biblib.test_asset')::uuid, true) = 'ready', 'el servidor lo revalida');
END;
$test$;
SELECT 'Correcto: restore deja los assets en revisión hasta revalidarlos';

-- Cuenta bloqueada y cuotas.
DO $test$
DECLARE
  i integer;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000b7', true);
  DELETE FROM biblib.cover_assets WHERE user_id = '10000000-0000-4000-8000-0000000000b7' AND state = 'quarantine';
  FOR i IN 1..5 LOOP PERFORM biblib.cover_asset_begin_upload(); END LOOP;
  PERFORM assert_true(biblib.cover_asset_begin_upload()->>'quota' = 'quarantine', 'máximo 5 subidas en cuarentena');
  PERFORM biblib.account_set_state('10000000-0000-4000-8000-0000000000a7', 'blocked');
  PERFORM set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000a7', true);
  PERFORM assert_true(biblib.cover_asset_begin_upload()->>'status' = 'inactive', 'una cuenta bloqueada no reserva subidas');
  PERFORM assert_true(biblib.cover_asset_request('30000000-0000-4000-8000-0000000000a7', gen_random_uuid(), 'open-library:id:1', 'v1', 'OL', 'clave-adquisicion-0003', repeat('a', 64))->>'status' = 'inactive', 'ni solicita adquisiciones');
  PERFORM assert_true((SELECT state = 'expired' FROM biblib.library_jobs WHERE id = current_setting('biblib.test_job')::uuid), 'su adquisición queda expirada');
END;
$test$;
SELECT 'Correcto: cuenta bloqueada sin subidas ni adquisiciones; cuota de cuarentena';

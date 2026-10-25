-- U-OPS-03 · 0013. Solicitud propia e idempotente, bloqueo de escrituras de cliente (RLS RESTRICTIVE, bloqueo de
-- colección, Storage), worker por pasos con lease y fencing, marca mínima y cobertura del inventario.
INSERT INTO auth.users(id) VALUES ('ad000000-0000-4000-8000-0000000000e1'), ('ad000000-0000-4000-8000-0000000000e2');
INSERT INTO biblib.shelves(id, user_id, title, is_default) VALUES
  ('ae000000-0000-4000-8000-0000000000e1', 'ad000000-0000-4000-8000-0000000000e1', 'Principal', true),
  ('ae000000-0000-4000-8000-0000000000e3', 'ad000000-0000-4000-8000-0000000000e1', 'Otra', false),
  ('ae000000-0000-4000-8000-0000000000e2', 'ad000000-0000-4000-8000-0000000000e2', 'Principal', true);
INSERT INTO biblib.books(id, user_id, isbn, title, shelf_id) VALUES
  ('ae000000-0000-4000-8000-0000000000a1', 'ad000000-0000-4000-8000-0000000000e1', '9780306406157', 'De A', 'ae000000-0000-4000-8000-0000000000e1'),
  ('ae000000-0000-4000-8000-0000000000a2', 'ad000000-0000-4000-8000-0000000000e1', 'manual-a-2', 'De A sin ISBN', 'ae000000-0000-4000-8000-0000000000e3'),
  ('ae000000-0000-4000-8000-0000000000b1', 'ad000000-0000-4000-8000-0000000000e2', '9780306406157', 'De B', 'ae000000-0000-4000-8000-0000000000e2');
-- Un segundo ejemplar de la misma edición, una obra, una vista y una portada privada con su objeto.
INSERT INTO biblib.copies(id, user_id, edition_id, shelf_id) VALUES ('ae000000-0000-4000-8000-0000000000a3', 'ad000000-0000-4000-8000-0000000000e1', 'ae000000-0000-4000-8000-0000000000a1', 'ae000000-0000-4000-8000-0000000000e1');
INSERT INTO biblib.works(id, user_id, title) VALUES ('ae000000-0000-4000-8000-0000000000a4', 'ad000000-0000-4000-8000-0000000000e1', 'Obra de A');
UPDATE biblib.editions SET work_id = 'ae000000-0000-4000-8000-0000000000a4' WHERE id = 'ae000000-0000-4000-8000-0000000000a1';
INSERT INTO biblib.saved_book_views(user_id, name, filters) VALUES
  ('ad000000-0000-4000-8000-0000000000e1', 'Vista de A', '{"status":"all","shelf":"all","sort":"title","view":"table","pageSize":25}'), ('ad000000-0000-4000-8000-0000000000e2', 'Vista de B', '{"status":"all","shelf":"all","sort":"title","view":"table","pageSize":25}');
INSERT INTO biblib.cover_assets(id, user_id, storage_key, sha256, mime, width, height, bytes, state, source_kind, source_ref, rights_policy_version)
VALUES ('ae000000-0000-4000-8000-0000000000a5', 'ad000000-0000-4000-8000-0000000000e1', 'ad000000-0000-4000-8000-0000000000e1/ae000000-0000-4000-8000-0000000000a5/v1.webp',
  repeat('a', 64), 'image/webp', 10, 10, 100, 'ready', 'upload', 'upload', 'v1');
UPDATE biblib.editions SET cover_asset_id = 'ae000000-0000-4000-8000-0000000000a5' WHERE id = 'ae000000-0000-4000-8000-0000000000a1';
INSERT INTO storage.objects(bucket_id, name, owner, metadata) VALUES
  ('biblib-covers', 'ad000000-0000-4000-8000-0000000000e1/ae000000-0000-4000-8000-0000000000a5/v1.webp', 'ad000000-0000-4000-8000-0000000000e1', '{"size": 100}'),
  ('biblib-covers', 'ad000000-0000-4000-8000-0000000000e2/ae000000-0000-4000-8000-0000000000b5/v1.webp', 'ad000000-0000-4000-8000-0000000000e2', '{"size": 100}');
INSERT INTO biblib.library_operations(id, user_id, operation, idempotency_key, input_digest, status, result)
VALUES ('ae000000-0000-4000-8000-0000000000a6', 'ad000000-0000-4000-8000-0000000000e1', 'import.confirm', 'clave-borrado-a-0001', repeat('b', 64), 'committed', '{}');
INSERT INTO biblib.library_snapshots(user_id, source_operation_id, reason, captured_revision, expires_at)
VALUES ('ad000000-0000-4000-8000-0000000000e1', 'ae000000-0000-4000-8000-0000000000a6', 'import.replace', gen_random_uuid(), now() + interval '30 days');
INSERT INTO biblib.library_jobs(user_id, kind, idempotency_key, input_digest, state, phase, expires_at, lease_token, lease_until)
VALUES ('ad000000-0000-4000-8000-0000000000e1', 'covers', 'clave-trabajo-a-0001', repeat('c', 64), 'running', 'covers', now() + interval '1 day', gen_random_uuid(), now() + interval '5 minutes');

-- A solo pide su propia eliminación (auth.uid(), sin argumento de cuenta); repetirla devuelve el mismo estado.
DO $test$
DECLARE
  first jsonb;
  second jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'ad000000-0000-4000-8000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  PERFORM assert_true(biblib.account_deletion_status()->>'state' = 'none', 'sin solicitud, estado none');
  BEGIN
    PERFORM biblib.account_deletion_request('corta');
    RAISE EXCEPTION 'Prueba fallida: aceptó una clave corta';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  first := biblib.account_deletion_request('clave-eliminacion-a-0001');
  second := biblib.account_deletion_request('otra-clave-distinta-0002');
  PERFORM assert_true((first->>'created')::boolean AND NOT (second->>'created')::boolean, 'la segunda solicitud no crea otra');
  PERFORM assert_true(first->>'state' = 'pending' AND second->>'state' = 'pending' AND first->>'requestedAt' = second->>'requestedAt', 'doble clic: mismo estado y fecha');
  PERFORM assert_true((first->>'expiredJobs')::integer = 1, 'el trabajo en vuelo expira al solicitar');
  PERFORM assert_true(biblib.account_deletion_status()->>'state' = 'pending' AND NOT biblib.account_deletion_status() ? 'errorCode', 'el dueño ve el estado, sin código de error');
  RESET ROLE;
END;
$test$;
SELECT assert_true((SELECT state FROM biblib.account_lifecycle WHERE user_id = 'ad000000-0000-4000-8000-0000000000e1') = 'deleting', 'la cuenta queda en eliminación');
SELECT assert_true((SELECT state = 'expired' AND lease_token IS NULL FROM biblib.library_jobs WHERE user_id = 'ad000000-0000-4000-8000-0000000000e1'), 'el trabajo pierde su lease');
SELECT assert_true(NOT biblib.account_is_active('ad000000-0000-4000-8000-0000000000e1') AND biblib.account_is_active('ad000000-0000-4000-8000-0000000000e2'), 'A inactiva, B activa');
SELECT assert_true(NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'biblib.account_deletions'::regclass AND contype = 'f'), 'la marca no depende de auth.users (sobrevive a la identidad)');
SELECT 'Correcto: solicitud propia e idempotente; trabajos expirados';

-- Un JWT antiguo de A no escribe en ninguna tabla ni por el bloqueo de colección; B sí.
DO $test$
DECLARE
  statement text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'ad000000-0000-4000-8000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  FOREACH statement IN ARRAY ARRAY[
    $$INSERT INTO biblib.shelves(user_id, title) VALUES ('ad000000-0000-4000-8000-0000000000e1', 'Nueva')$$,
    $$UPDATE biblib.shelves SET title = 'Renombrada' WHERE id = 'ae000000-0000-4000-8000-0000000000e3'$$,
    $$DELETE FROM biblib.saved_book_views WHERE user_id = 'ad000000-0000-4000-8000-0000000000e1'$$,
    $$UPDATE biblib.copies SET status = 'read' WHERE user_id = 'ad000000-0000-4000-8000-0000000000e1'$$,
    $$UPDATE biblib.books SET status = 'read' WHERE id = 'ae000000-0000-4000-8000-0000000000a2'$$,
    $$INSERT INTO biblib.books(user_id, isbn, title, shelf_id) VALUES ('ad000000-0000-4000-8000-0000000000e1', 'manual-a-9', 'Nuevo', 'ae000000-0000-4000-8000-0000000000e1')$$,
    $$INSERT INTO biblib.library_operations(user_id, operation, idempotency_key, input_digest, status, result) VALUES ('ad000000-0000-4000-8000-0000000000e1', 'copy.create', 'clave-tardia-a-0001', repeat('d', 64), 'committed', '{}')$$,
    $$SELECT biblib.lock_library()$$,
    $$SELECT biblib.cover_asset_discard('ae000000-0000-4000-8000-0000000000a5')$$,
    $$SELECT biblib.cover_asset_revalidate('ae000000-0000-4000-8000-0000000000a5', true)$$
  ] LOOP
    BEGIN
      EXECUTE statement;
      RAISE EXCEPTION 'Prueba fallida: escribió con la cuenta en eliminación: %', statement;
    EXCEPTION WHEN SQLSTATE 'BD001' THEN NULL; END;
  END LOOP;
  PERFORM assert_true(NOT biblib.cover_object_access('ad000000-0000-4000-8000-0000000000e1/ae000000-0000-4000-8000-0000000000a5/v1.webp', 'delete'), 'Storage: no retira sus objetos');
  PERFORM assert_true(NOT biblib.cover_object_access('ad000000-0000-4000-8000-0000000000e1/ae000000-0000-4000-8000-0000000000a9/x.webp', 'delete'), 'ni objetos sin fila');
  PERFORM assert_true(biblib.cover_object_access('ad000000-0000-4000-8000-0000000000e1/ae000000-0000-4000-8000-0000000000a5/v1.webp', 'select'), 'aún lee los suyos');
  PERFORM assert_true((SELECT count(*) FROM biblib.books) = 3, 'y lee su colección');
  PERFORM set_config('request.jwt.claim.sub', 'ad000000-0000-4000-8000-0000000000e2', true);
  INSERT INTO biblib.shelves(user_id, title) VALUES ('ad000000-0000-4000-8000-0000000000e2', 'Nueva de B');
  UPDATE biblib.books SET status = 'read' WHERE id = 'ae000000-0000-4000-8000-0000000000b1';
  PERFORM biblib.lock_library();
  RESET ROLE;
END;
$test$;
DO $test$
BEGIN
  BEGIN
    PERFORM biblib.account_set_state('ad000000-0000-4000-8000-0000000000e1', 'active');
    RAISE EXCEPTION 'Prueba fallida: account_set_state reactivó una cuenta en eliminación';
  EXCEPTION WHEN SQLSTATE 'BD002' THEN NULL; END;
  PERFORM assert_true(NOT has_function_privilege('authenticated', 'biblib.account_set_state(uuid, text)', 'EXECUTE'), 'el cliente no cambia el ciclo de vida');
  PERFORM assert_true(NOT has_table_privilege('authenticated', 'biblib.account_deletions', 'SELECT') AND NOT has_table_privilege('authenticated', 'biblib.account_deletions', 'UPDATE'), 'ni lee ni escribe la marca');
  PERFORM assert_true(NOT has_function_privilege('authenticated', 'biblib.account_deletion_claim(uuid, integer)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'biblib.account_deletion_purge(uuid, uuid, text, integer)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'biblib.account_deletion_retry(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'biblib.account_deletion_suppress(uuid, timestamptz, integer)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'biblib.account_deletion_request(text)', 'EXECUTE'), 'las funciones administrativas no son una vía del navegador');
END;
$test$;
SELECT 'Correcto: JWT antiguo sin escrituras (tablas, vista, bloqueo, funciones y Storage); B intacto; cuenta no reactivable';

-- Worker: lease y fencing, Storage pendiente, pasos que no avanzan con recursos y reintento.
DO $test$
DECLARE
  owner_id uuid := 'ad000000-0000-4000-8000-0000000000e1';
  claimed jsonb;
  stale uuid;
  token uuid;
  current_step text;
  removed integer;
BEGIN
  claimed := biblib.account_deletion_claim(NULL, 60000);
  PERFORM assert_true((claimed->>'userId')::uuid = owner_id AND claimed->>'step' = 'sessions', 'reclama la eliminación pendiente');
  PERFORM assert_true(biblib.account_deletion_claim(NULL, 60000) IS NULL, 'con lease vigente nadie más la reclama');
  stale := (claimed->>'token')::uuid;
  -- El lease vence: otro worker la reclama con un testigo nuevo y fencing mayor; el antiguo ya no hace nada.
  UPDATE biblib.account_deletions SET lease_until = clock_timestamp() - interval '1 second' WHERE user_id = owner_id;
  claimed := biblib.account_deletion_claim(owner_id, 60000);
  token := (claimed->>'token')::uuid;
  PERFORM assert_true(token <> stale AND (claimed->>'fence')::bigint = 2, 'nuevo testigo y fencing creciente');
  BEGIN
    PERFORM biblib.account_deletion_advance(owner_id, stale, 'sessions', '{}', 60000);
    RAISE EXCEPTION 'Prueba fallida: un worker vencido avanzó';
  EXCEPTION WHEN SQLSTATE 'BD003' THEN NULL; END;
  PERFORM assert_true(biblib.account_deletion_fail(owner_id, stale, 'STORAGE_UNAVAILABLE', 0, 5) = 'lease_lost', 'ni registra un fallo');
  current_step := biblib.account_deletion_advance(owner_id, token, 'sessions', '{"sessions": 1}', 60000);
  PERFORM assert_true(current_step = 'storage', 'sesiones → storage');
  -- Storage caído: el objeto sigue y el paso no avanza; el fallo queda visible y se reintenta.
  BEGIN
    PERFORM biblib.account_deletion_advance(owner_id, token, 'storage', '{}', 60000);
    RAISE EXCEPTION 'Prueba fallida: avanzó con objetos en Storage';
  EXCEPTION WHEN SQLSTATE 'BD004' THEN NULL; END;
  PERFORM assert_true(jsonb_array_length(biblib.account_deletion_objects(owner_id, 100)) = 1, 'solo lista los objetos de A');
  PERFORM assert_true(biblib.account_deletion_fail(owner_id, token, 'STORAGE_UNAVAILABLE', 0, 5) = 'waiting_retry', 'queda a la espera de reintento');
  PERFORM assert_true((SELECT state = 'waiting_retry' AND error_code = 'STORAGE_UNAVAILABLE' AND step = 'storage' FROM biblib.account_deletions WHERE user_id = owner_id), 'error visible en el paso de Storage');
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM assert_true(biblib.account_deletion_status()->>'state' = 'waiting_retry' AND NOT biblib.account_deletion_status() ? 'errorCode', 'el dueño no ve el código técnico');
  RESET ROLE;
  -- Fallos seguidos hasta el máximo: pasa a failed y solo se reanuda desde operación.
  FOR i IN 1..3 LOOP
    claimed := biblib.account_deletion_claim(owner_id, 60000);
    PERFORM biblib.account_deletion_fail(owner_id, (claimed->>'token')::uuid, 'STORAGE_UNAVAILABLE', 0, 3);
  END LOOP;
  PERFORM assert_true((SELECT state FROM biblib.account_deletions WHERE user_id = owner_id) = 'failed', 'tras 3 intentos seguidos del mismo paso, failed');
  PERFORM assert_true(biblib.account_deletion_claim(owner_id, 60000) IS NULL, 'una fallida no se reclama sola');
  PERFORM assert_true(biblib.account_deletion_retry(owner_id) = 1, 'reintento desde operación');
  claimed := biblib.account_deletion_claim(owner_id, 60000);
  token := (claimed->>'token')::uuid;
  PERFORM assert_true(claimed->>'step' = 'storage', 'continúa en el paso pendiente');
  -- Storage vuelve: se retiran los objetos (el worker usa la API) y el paso avanza.
  DELETE FROM storage.objects WHERE name LIKE owner_id::text || '/%';
  current_step := biblib.account_deletion_advance(owner_id, token, 'storage', '{"objects": 1}', 60000);
  BEGIN
    PERFORM biblib.account_deletion_purge(owner_id, token, 'shelves', 100);
    RAISE EXCEPTION 'Prueba fallida: borró fuera de orden';
  EXCEPTION WHEN SQLSTATE 'BD004' THEN NULL; END;
  WHILE current_step <> 'auth' LOOP
    LOOP
      removed := biblib.account_deletion_purge(owner_id, token, current_step, 1);
      EXIT WHEN removed = 0;
    END LOOP;
    current_step := biblib.account_deletion_advance(owner_id, token, current_step, jsonb_build_object(current_step, 1), 60000);
  END LOOP;
  -- Solo queda el ciclo de vida en eliminación, que mantiene el bloqueo hasta que Auth borra la identidad (cascada).
  PERFORM assert_true(biblib.account_residue(owner_id)->'tables' = '{"account_lifecycle": 1}'::jsonb, 'antes de borrar la identidad solo queda el ciclo de vida');
  BEGIN
    PERFORM biblib.account_deletion_advance(owner_id, token, 'auth', '{}', 60000);
    RAISE EXCEPTION 'Prueba fallida: avanzó con la identidad viva';
  EXCEPTION WHEN SQLSTATE 'BD004' THEN NULL; END;
  BEGIN
    PERFORM biblib.account_deletion_complete(owner_id, token, 90);
    RAISE EXCEPTION 'Prueba fallida: terminó sin verificar';
  EXCEPTION WHEN SQLSTATE 'BD004' THEN NULL; END;
  -- Auth borra la identidad (en el stack real, la API admin de GoTrue).
  DELETE FROM auth.users WHERE id = owner_id;
  PERFORM assert_true(biblib.account_deletion_advance(owner_id, token, 'auth', '{"auth": 1}', 60000) = 'verify', 'identidad borrada → verificación');
  PERFORM biblib.account_deletion_complete(owner_id, token, 90);
END;
$test$;
SELECT assert_true((SELECT state = 'completed' AND step = 'done' AND counts = '{}'::jsonb AND lease_token IS NULL AND purge_after > now() + interval '89 days' FROM biblib.account_deletions WHERE user_id = 'ad000000-0000-4000-8000-0000000000e1'), 'marca mínima terminada con plazo');
SELECT assert_true(biblib.account_residue('ad000000-0000-4000-8000-0000000000e1') = '{"rows": 0, "tables": {}, "objects": 0, "account": false}'::jsonb, 'ningún recurso de A');
SELECT assert_true((SELECT count(*) FROM biblib.books WHERE user_id = 'ad000000-0000-4000-8000-0000000000e2') = 1
  AND (SELECT count(*) FROM biblib.shelves WHERE user_id = 'ad000000-0000-4000-8000-0000000000e2') = 2
  AND (SELECT count(*) FROM biblib.saved_book_views WHERE user_id = 'ad000000-0000-4000-8000-0000000000e2') = 1
  AND (SELECT count(*) FROM storage.objects WHERE owner = 'ad000000-0000-4000-8000-0000000000e2') = 1, 'B intacto');
SELECT 'Correcto: worker por pasos con lease, fencing, Storage pendiente, failed/reintento, identidad al final y marca mínima';

-- Tras borrar la identidad, un JWT antiguo de A sigue sin escribir: la marca basta aunque ya no haya ciclo de vida.
DO $test$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'ad000000-0000-4000-8000-0000000000e1', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM biblib.lock_library();
    RAISE EXCEPTION 'Prueba fallida: la cuenta suprimida tomó el bloqueo';
  EXCEPTION WHEN SQLSTATE 'BD001' THEN NULL; END;
  PERFORM assert_true(biblib.account_deletion_status()->>'state' = 'none', 'la marca no es visible para la cuenta suprimida');
  RESET ROLE;
END;
$test$;

-- Restore: la marca de una cuenta ya borrada en el destino; idempotente. Las marcas vencidas se retiran.
DO $test$
BEGIN
  PERFORM assert_true(biblib.account_deletion_suppress('ad000000-0000-4000-8000-0000000000e9', now() - interval '2 days', 90), 'marca de restore');
  PERFORM assert_true(biblib.account_deletion_suppress('ad000000-0000-4000-8000-0000000000e9', now() - interval '2 days', 90), 'repetida, sin error');
  BEGIN
    PERFORM biblib.account_deletion_suppress('ad000000-0000-4000-8000-0000000000e2', now(), 90);
    RAISE EXCEPTION 'Prueba fallida: marcó una identidad que sigue en el destino';
  EXCEPTION WHEN SQLSTATE 'BD004' THEN NULL; END;
  UPDATE biblib.account_deletions SET purge_after = now() - interval '1 second' WHERE user_id = 'ad000000-0000-4000-8000-0000000000e9';
  PERFORM assert_true(biblib.account_deletion_purge_marks(100) = 1, 'retira la marca vencida');
  PERFORM assert_true((SELECT count(*) FROM biblib.account_deletions) = 1, 'conserva la vigente');
END;
$test$;
SELECT 'Correcto: marca de restore idempotente y plazo de la marca';

-- Inventario: toda tabla de biblib con dueño la retira un paso, y toda tabla con escritura de cliente exige cuenta
-- activa para cada comando concedido. Una tabla nueva sin paso o sin guarda hace fallar esta prueba.
DO $test$
DECLARE
  item record;
  covered text[] := ARRAY[]::text[];
  step_name text;
BEGIN
  FOREACH step_name IN ARRAY ARRAY['covers', 'snapshots', 'staging', 'jobs', 'views', 'previews', 'operations', 'private_cache', 'copies', 'editions', 'works', 'shelves', 'state'] LOOP
    covered := covered || biblib.account_deletion_step_tables(step_name);
  END LOOP;
  FOR item IN SELECT DISTINCT c.relname AS name FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace JOIN pg_attribute AS a ON a.attrelid = c.oid
    WHERE n.nspname = 'biblib' AND c.relkind = 'r' AND c.relname NOT IN ('account_deletions', 'account_lifecycle') AND a.attname IN ('user_id', 'owner_id') AND NOT a.attisdropped
  LOOP
    PERFORM assert_true(item.name = ANY(covered), format('la tabla %s tiene paso de eliminación', item.name));
  END LOOP;
  FOR item IN SELECT g.table_name AS name, lower(g.privilege_type) AS command FROM information_schema.role_table_grants AS g
    JOIN pg_class AS c ON c.relname = g.table_name JOIN pg_namespace AS n ON n.oid = c.relnamespace AND n.nspname = g.table_schema
    WHERE g.table_schema = 'biblib' AND g.grantee = 'authenticated' AND g.privilege_type IN ('INSERT', 'UPDATE', 'DELETE') AND c.relkind = 'r'
  LOOP
    PERFORM assert_true(EXISTS (SELECT 1 FROM pg_policy AS p WHERE p.polrelid = format('biblib.%I', item.name)::regclass AND NOT p.polpermissive
      AND p.polcmd = CASE item.command WHEN 'insert' THEN 'a' WHEN 'update' THEN 'w' ELSE 'd' END
      AND coalesce(pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) LIKE '%account_write_allowed%'), format('%s.%s exige cuenta activa', item.name, item.command));
  END LOOP;
END;
$test$;
SELECT 'Correcto: inventario de eliminación y guarda de cuenta activa en todas las tablas con escritura de cliente';

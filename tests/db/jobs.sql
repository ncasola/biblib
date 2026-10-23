-- U-DAT-03: trabajos persistentes. Se ejecuta tras 0005 con las cuentas A/B de rls.sql.
-- Alta idempotente, aislamiento A/B, permisos mínimos, reclamación con lease y fencing, control con
-- versión, guarda de cuenta activa, caducidad y restricciones de elementos.
CREATE TEMP TABLE job_ids (name text PRIMARY KEY, id uuid);
GRANT ALL ON job_ids TO authenticated;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
DO $test$
DECLARE r jsonb; again jsonb;
BEGIN
  r := biblib.library_job_create('covers', 'clave-portadas-a-0001', repeat('a', 64), NULL, NULL);
  PERFORM public.assert_true(r->>'status' = 'created', 'A crea un trabajo de portadas');
  INSERT INTO job_ids VALUES ('a', (r->>'id')::uuid);
  again := biblib.library_job_create('covers', 'clave-portadas-a-0001', repeat('a', 64), NULL, NULL);
  PERFORM public.assert_true(again->>'status' = 'existing' AND again->>'id' = r->>'id', 'la misma clave y entrada devuelven el mismo trabajo');
  PERFORM public.assert_true((biblib.library_job_create('covers', 'clave-portadas-a-0001', repeat('b', 64), NULL, NULL))->>'status' = 'conflict', 'la misma clave con otra entrada es un conflicto');
  PERFORM public.assert_true((biblib.library_job_create('covers', 'clave-portadas-a-0002', repeat('a', 64), NULL, NULL))->>'status' = 'busy', 'solo un trabajo de portadas activo por cuenta');
  PERFORM public.assert_true((biblib.library_job_create('import', 'clave-import-a-00001', repeat('c', 64), gen_random_uuid(), gen_random_uuid()))->>'status' = 'not_found', 'una importación exige una vista previa propia');
  PERFORM public.assert_true((SELECT count(*) FROM biblib.library_jobs) = 1, 'A ve su trabajo');
  PERFORM public.assert_true((SELECT state FROM biblib.library_jobs) = 'queued' AND (SELECT phase FROM biblib.library_jobs) = 'covers', 'el trabajo nace en cola');
  BEGIN
    UPDATE biblib.library_jobs SET state = 'succeeded';
    RAISE EXCEPTION 'Prueba fallida: authenticated actualizó un trabajo';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO biblib.library_jobs (user_id, kind, idempotency_key, input_digest, phase, expires_at) VALUES (auth.uid(), 'covers', 'clave-directa-00001', repeat('d', 64), 'covers', now());
    RAISE EXCEPTION 'Prueba fallida: authenticated insertó un trabajo directamente';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    DELETE FROM biblib.library_job_items;
    RAISE EXCEPTION 'Prueba fallida: authenticated borró elementos';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM biblib.library_job_claim(NULL, NULL, 60000);
    RAISE EXCEPTION 'Prueba fallida: authenticated reclamó un trabajo';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM biblib.library_job_fence((r->>'id')::uuid, gen_random_uuid(), 1);
    RAISE EXCEPTION 'Prueba fallida: authenticated cercó un trabajo';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM biblib.library_job_renew((r->>'id')::uuid, gen_random_uuid(), 1, 60000);
    RAISE EXCEPTION 'Prueba fallida: authenticated renovó un lease';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM biblib.account_set_state(auth.uid(), 'active');
    RAISE EXCEPTION 'Prueba fallida: authenticated cambió el ciclo de vida';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM nextval('biblib.library_job_fence_seq');
    RAISE EXCEPTION 'Prueba fallida: authenticated avanzó el fencing';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$test$;
COMMIT;

-- B no ve ni controla el trabajo de A, y no puede citarlo en sus elementos.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
DO $test$
DECLARE a_job uuid := (SELECT id FROM job_ids WHERE name = 'a');
BEGIN
  PERFORM public.assert_true((SELECT count(*) FROM biblib.library_jobs) = 0, 'B no lista trabajos de A');
  PERFORM public.assert_true((biblib.library_job_control(a_job, gen_random_uuid(), 'cancel'))->>'status' = 'not_found', 'B no controla un trabajo de A ni confirma que existe');
END;
$test$;
COMMIT;

-- Reclamar, fencing, expiración del lease y renovación (conexión del servidor).
DO $test$
DECLARE a_job uuid := (SELECT id FROM job_ids WHERE name = 'a'); first_claim jsonb; second_claim jsonb; version_before uuid;
BEGIN
  SELECT version INTO version_before FROM biblib.library_jobs WHERE id = a_job;
  first_claim := biblib.library_job_claim(a_job, NULL, 1000);
  PERFORM public.assert_true(first_claim->>'state' = 'running' AND first_claim->>'lease_token' IS NOT NULL, 'el ejecutor reclama el trabajo con lease');
  PERFORM public.assert_true((SELECT version FROM biblib.library_jobs WHERE id = a_job) = version_before, 'pasar de cola a ejecución no cambia la versión del cliente');
  PERFORM public.assert_true(biblib.library_job_claim(a_job, NULL, 1000) IS NULL, 'un lease vigente no se vuelve a reclamar');
  PERFORM public.assert_true(biblib.library_job_fence(a_job, (first_claim->>'lease_token')::uuid, (first_claim->>'fencing_number')::bigint) = '10000000-0000-4000-8000-000000000001', 'el fencing vigente devuelve el dueño de la fila');
  BEGIN
    PERFORM biblib.library_job_fence(a_job, gen_random_uuid(), (first_claim->>'fencing_number')::bigint);
    RAISE EXCEPTION 'Prueba fallida: un token ajeno pasó el fencing';
  EXCEPTION WHEN SQLSTATE 'BJ001' THEN NULL; END;
  PERFORM pg_sleep(1.1);
  PERFORM public.assert_true(NOT biblib.library_job_renew(a_job, (first_claim->>'lease_token')::uuid, (first_claim->>'fencing_number')::bigint, 60000), 'un lease vencido no se renueva');
  BEGIN
    PERFORM biblib.library_job_fence(a_job, (first_claim->>'lease_token')::uuid, (first_claim->>'fencing_number')::bigint);
    RAISE EXCEPTION 'Prueba fallida: un lease vencido pasó el fencing';
  EXCEPTION WHEN SQLSTATE 'BJ001' THEN NULL; END;
  second_claim := biblib.library_job_claim(NULL, '10000000-0000-4000-8000-000000000001', 60000);
  PERFORM public.assert_true(second_claim->>'id' = a_job::text AND (second_claim->>'fencing_number')::bigint > (first_claim->>'fencing_number')::bigint, 'un lease vencido se reclama con un fencing mayor');
  PERFORM public.assert_true((second_claim->>'attempts')::int = 2, 'cada reclamación cuenta como intento');
  BEGIN
    PERFORM biblib.library_job_fence(a_job, (first_claim->>'lease_token')::uuid, (first_claim->>'fencing_number')::bigint);
    RAISE EXCEPTION 'Prueba fallida: el trabajador antiguo escribe tras otra reclamación';
  EXCEPTION WHEN SQLSTATE 'BJ001' THEN NULL; END;
  PERFORM public.assert_true(biblib.library_job_renew(a_job, (second_claim->>'lease_token')::uuid, (second_claim->>'fencing_number')::bigint, 60000), 'el titular vigente renueva');
  BEGIN
    UPDATE biblib.library_jobs SET lease_token = NULL WHERE id = a_job;
    RAISE EXCEPTION 'Prueba fallida: un trabajo en ejecución sin lease';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO job_ids VALUES ('a-token', (second_claim->>'lease_token')::uuid);
END;
$test$;

-- Control con versión: pausar corta el lease, reanudar vuelve a la cola, cancelar es definitivo.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
DO $test$
DECLARE a_job uuid := (SELECT id FROM job_ids WHERE name = 'a'); v uuid; r jsonb;
BEGIN
  PERFORM public.assert_true((biblib.library_job_control(a_job, gen_random_uuid(), 'pause'))->>'status' = 'conflict', 'una versión antigua no pausa');
  SELECT version INTO v FROM biblib.library_jobs WHERE id = a_job;
  r := biblib.library_job_control(a_job, v, 'pause');
  PERFORM public.assert_true(r->>'status' = 'ok' AND (r->>'published')::boolean = false, 'pausar un trabajo en ejecución');
  PERFORM public.assert_true((SELECT state = 'paused' AND lease_token IS NULL AND version <> v FROM biblib.library_jobs WHERE id = a_job), 'la pausa libera el lease y rota la versión');
  SELECT version INTO v FROM biblib.library_jobs WHERE id = a_job;
  PERFORM public.assert_true((biblib.library_job_control(a_job, v, 'pause'))->>'status' = 'ok', 'pausar de nuevo no cambia nada');
  PERFORM public.assert_true((biblib.library_job_control(a_job, v, 'resume'))->>'status' = 'ok', 'reanudar');
  PERFORM public.assert_true((SELECT state FROM biblib.library_jobs WHERE id = a_job) = 'queued', 'reanudar devuelve el trabajo a la cola');
END;
$test$;
COMMIT;

DO $test$
DECLARE a_job uuid := (SELECT id FROM job_ids WHERE name = 'a');
BEGIN
  BEGIN
    PERFORM biblib.library_job_fence(a_job, (SELECT id FROM job_ids WHERE name = 'a-token'), (SELECT fencing_number FROM biblib.library_jobs WHERE id = a_job));
    RAISE EXCEPTION 'Prueba fallida: el trabajador pausado sigue escribiendo';
  EXCEPTION WHEN SQLSTATE 'BJ001' THEN NULL; END;
  PERFORM public.assert_true(biblib.library_job_claim(a_job, NULL, 60000) IS NOT NULL, 'el trabajo reanudado se vuelve a reclamar');
END;
$test$;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
DO $test$
DECLARE a_job uuid := (SELECT id FROM job_ids WHERE name = 'a'); v uuid;
BEGIN
  SELECT version INTO v FROM biblib.library_jobs WHERE id = a_job;
  PERFORM public.assert_true((biblib.library_job_control(a_job, v, 'cancel'))->>'status' = 'ok', 'cancelar durante la ejecución');
  PERFORM public.assert_true((SELECT state = 'cancelled' AND error_code = 'CANCELLED' AND finished_at IS NOT NULL AND lease_token IS NULL FROM biblib.library_jobs WHERE id = a_job), 'la cancelación es definitiva y libera el lease');
  SELECT version INTO v FROM biblib.library_jobs WHERE id = a_job;
  PERFORM public.assert_true((biblib.library_job_control(a_job, v, 'cancel'))->>'status' = 'ok', 'cancelar dos veces es idempotente');
  PERFORM public.assert_true((biblib.library_job_control(a_job, v, 'resume'))->>'status' = 'conflict', 'un trabajo cancelado no se reanuda');
  PERFORM public.assert_true((biblib.library_job_create('covers', 'clave-portadas-a-0003', repeat('a', 64), NULL, NULL))->>'status' = 'created', 'tras cancelar se puede iniciar otro recorrido');
END;
$test$;
COMMIT;

-- Guarda de cuenta activa: un estado bloqueado impide reclamar, cercar y crear; los trabajos expiran.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
DO $test$
DECLARE r jsonb;
BEGIN
  r := biblib.library_job_create('covers', 'clave-portadas-b-0001', repeat('b', 64), NULL, NULL);
  PERFORM public.assert_true(r->>'status' = 'created', 'B crea su trabajo');
  INSERT INTO job_ids VALUES ('b', (r->>'id')::uuid);
END;
$test$;
COMMIT;

DO $test$
DECLARE b_job uuid := (SELECT id FROM job_ids WHERE name = 'b'); claim jsonb;
BEGIN
  claim := biblib.library_job_claim(b_job, NULL, 60000);
  INSERT INTO biblib.account_lifecycle (user_id, state) VALUES ('10000000-0000-4000-8000-000000000002', 'blocked');
  BEGIN
    PERFORM biblib.library_job_fence(b_job, (claim->>'lease_token')::uuid, (claim->>'fencing_number')::bigint);
    RAISE EXCEPTION 'Prueba fallida: un trabajador escribió para una cuenta bloqueada';
  EXCEPTION WHEN SQLSTATE 'BJ002' THEN NULL; END;
  PERFORM public.assert_true(NOT biblib.library_job_renew(b_job, (claim->>'lease_token')::uuid, (claim->>'fencing_number')::bigint, 60000), 'una cuenta bloqueada no renueva leases');
  PERFORM public.assert_true(biblib.account_set_state('10000000-0000-4000-8000-000000000002', 'blocked') = 1, 'bloquear expira los trabajos no terminados');
  PERFORM public.assert_true((SELECT state = 'expired' AND error_code = 'ACCOUNT_INACTIVE' AND lease_token IS NULL FROM biblib.library_jobs WHERE id = b_job), 'el trabajo queda no autorizado');
  BEGIN
    PERFORM biblib.library_job_fence(b_job, (claim->>'lease_token')::uuid, (claim->>'fencing_number')::bigint);
    RAISE EXCEPTION 'Prueba fallida: el trabajador antiguo escribió tras el bloqueo';
  EXCEPTION WHEN SQLSTATE 'BJ001' THEN NULL; END;
END;
$test$;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
DO $test$
BEGIN
  PERFORM public.assert_true((biblib.library_job_create('covers', 'clave-portadas-b-0002', repeat('b', 64), NULL, NULL))->>'status' = 'inactive', 'una cuenta bloqueada no crea trabajos');
  PERFORM public.assert_true((SELECT state FROM biblib.account_lifecycle) = 'blocked', 'el dueño ve su estado de cuenta');
END;
$test$;
COMMIT;

-- Caducidad, poison y restricciones de elementos; borrado de cuenta en cascada.
DO $test$
DECLARE a_job uuid; b_job uuid := (SELECT id FROM job_ids WHERE name = 'b'); claimed jsonb;
BEGIN
  PERFORM biblib.account_set_state('10000000-0000-4000-8000-000000000002', 'active');
  SELECT id INTO a_job FROM biblib.library_jobs WHERE user_id = '10000000-0000-4000-8000-000000000001' AND state = 'queued';
  UPDATE biblib.library_jobs SET expires_at = clock_timestamp() - interval '1 second' WHERE id = a_job;
  PERFORM public.assert_true(biblib.library_job_claim(a_job, NULL, 60000) IS NULL, 'un trabajo caducado no se ejecuta');
  PERFORM public.assert_true((SELECT state = 'expired' AND error_code = 'JOB_EXPIRED' FROM biblib.library_jobs WHERE id = a_job), 'la caducidad la decide la hora de la base');
  INSERT INTO biblib.library_job_items (job_id, user_id, item_key, phase) VALUES (a_job, '10000000-0000-4000-8000-000000000001', 'libro-1', 'covers');
  BEGIN
    INSERT INTO biblib.library_job_items (job_id, user_id, item_key, phase) VALUES (a_job, '10000000-0000-4000-8000-000000000001', 'libro-1', 'covers');
    RAISE EXCEPTION 'Prueba fallida: elemento duplicado';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.library_job_items (job_id, user_id, item_key, phase) VALUES (a_job, '10000000-0000-4000-8000-000000000002', 'libro-2', 'covers');
    RAISE EXCEPTION 'Prueba fallida: un elemento de B citó un trabajo de A';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  INSERT INTO auth.users(id) VALUES ('10000000-0000-4000-8000-000000000004');
  PERFORM set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', true);
  PERFORM biblib.library_job_create('covers', 'clave-portadas-c-0001', repeat('e', 64), NULL, NULL);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  UPDATE biblib.library_jobs SET attempts = 10 WHERE user_id = '10000000-0000-4000-8000-000000000004';
  PERFORM public.assert_true(biblib.library_job_claim(NULL, '10000000-0000-4000-8000-000000000004', 60000) IS NULL, 'un trabajo que falla una y otra vez se cierra');
  PERFORM public.assert_true((SELECT state = 'failed' AND error_code = 'STEP_FAILED' FROM biblib.library_jobs WHERE user_id = '10000000-0000-4000-8000-000000000004'), 'se marca como fallido sin ejecutarse');
  DELETE FROM auth.users WHERE id = '10000000-0000-4000-8000-000000000004';
  PERFORM public.assert_true(NOT EXISTS (SELECT 1 FROM biblib.library_jobs WHERE user_id = '10000000-0000-4000-8000-000000000004'), 'borrar la cuenta elimina sus trabajos');
  DELETE FROM biblib.library_jobs WHERE id IN (a_job, b_job);
  DELETE FROM biblib.library_jobs WHERE user_id IN ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002');
  DELETE FROM biblib.account_lifecycle;
END;
$test$;

SELECT 'Correcto: trabajos (alta idempotente, A/B, permisos, lease, fencing, control, cuenta activa, caducidad y elementos)';

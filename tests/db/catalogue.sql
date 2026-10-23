-- U-DAT-05: coordinación del catálogo. Se ejecuta tras 0004 con las cuentas A/B de rls.sql.
-- Cuota: plazas separadas por el intervalo, horizonte, tope por dueño, cubos por proveedor y cooldown.
DO $test$
DECLARE r jsonb;
BEGIN
  r := biblib.catalogue_reserve('open-library', 'db', '10000000-0000-4000-8000-000000000001', 'interactive', 1000, 2500, 5, 10000);
  PERFORM public.assert_true(r->>'state' = 'reserved' AND (r->>'waitMs')::int = 0, 'la primera reserva de OL es inmediata');
  r := biblib.catalogue_reserve('open-library', 'db', '10000000-0000-4000-8000-000000000001', 'interactive', 1000, 2500, 5, 10000);
  PERFORM public.assert_true(r->>'state' = 'reserved' AND (r->>'waitMs')::int BETWEEN 990 AND 1000, 'la segunda espera el intervalo de 1 s fuera de la base');
  r := biblib.catalogue_reserve('open-library', 'db', '10000000-0000-4000-8000-000000000002', 'interactive', 1000, 2500, 5, 10000);
  PERFORM public.assert_true(r->>'state' = 'reserved' AND (r->>'waitMs')::int BETWEEN 1990 AND 2000, 'otro dueño comparte el mismo intervalo global');
  r := biblib.catalogue_reserve('open-library', 'db', '10000000-0000-4000-8000-000000000002', 'interactive', 1000, 2500, 5, 10000);
  PERFORM public.assert_true(r->>'state' = 'wait' AND (r->>'retryMs')::int > 0, 'fuera del horizonte se pide volver, sin conceder ni dormir');
  r := biblib.catalogue_reserve('open-library', 'db', NULL, 'batch', 1000, 250, 1, 10000);
  PERFORM public.assert_true(r->>'state' = 'wait', 'el lote no hace cola por delante de las búsquedas');
  r := biblib.catalogue_reserve('bne', 'db', '10000000-0000-4000-8000-000000000001', 'interactive', 2000, 2500, 5, 10000);
  PERFORM public.assert_true(r->>'state' = 'reserved' AND (r->>'waitMs')::int = 0, 'BNE no consume la reserva de OL');
  r := biblib.catalogue_reserve('bne', 'db', '10000000-0000-4000-8000-000000000001', 'interactive', 2000, 2500, 1, 10000);
  PERFORM public.assert_true(r->>'state' = 'busy', 'tope de reservas activas por dueño y propósito');
  PERFORM public.assert_true(biblib.catalogue_release((r->>'reservationId')::uuid, 1, NULL) IS NOT TRUE, 'liberar exige reserva y testigo válidos');
  BEGIN
    PERFORM biblib.catalogue_reserve('open-library', 'db', NULL, 'otro', 1000, 0, 1, 1000);
    RAISE EXCEPTION 'Prueba fallida: propósito desconocido aceptado';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END;
$test$;

DO $test$
DECLARE r jsonb; reservation biblib.catalogue_quota_reservations%ROWTYPE;
BEGIN
  SELECT * INTO reservation FROM biblib.catalogue_quota_reservations WHERE provider = 'bne' AND credential_scope = 'db' LIMIT 1;
  PERFORM public.assert_true(biblib.catalogue_release(reservation.id, reservation.fence, 3000), 'liberar con 429 aplica el cooldown');
  PERFORM public.assert_true(NOT biblib.catalogue_release(reservation.id, reservation.fence, 3000), 'una reserva solo se libera una vez');
  r := biblib.catalogue_reserve('bne', 'db', '10000000-0000-4000-8000-000000000002', 'interactive', 2000, 2500, 5, 10000);
  PERFORM public.assert_true(r->>'state' = 'cooldown' AND (r->>'retryMs')::int BETWEEN 1 AND 3000, 'tras un 429 nadie reserva hasta Retry-After');
  r := biblib.catalogue_reserve('open-library', 'db', '10000000-0000-4000-8000-000000000002', 'interactive', 1000, 60000, 5, 10000);
  PERFORM public.assert_true(r->>'state' = 'reserved', 'el cooldown de BNE no afecta a OL');
END;
$test$;

-- Consultas en vuelo y fencing: un trabajador tardío no publica y una caída nunca se guarda.
DO $test$
DECLARE first_lease jsonb; second jsonb; fresh jsonb; hit jsonb;
BEGIN
  first_lease := biblib.catalogue_begin('open-library', 'v1', 'db', 1, 'lookupISBN', '9790000900011', true, 50, NULL);
  PERFORM public.assert_true(first_lease->>'state' = 'leased', 'la primera solicitud obtiene la concesión');
  second := biblib.catalogue_begin('open-library', 'v1', 'db', 1, 'lookupISBN', '9790000900011', true, 50, NULL);
  PERFORM public.assert_true(second->>'state' = 'pending', 'la segunda espera a la consulta en vuelo');
  PERFORM pg_sleep(0.1);
  fresh := biblib.catalogue_begin('open-library', 'v1', 'db', 1, 'lookupISBN', '9790000900011', true, 60000, NULL);
  PERFORM public.assert_true(fresh->>'state' = 'leased' AND (fresh->>'fence')::bigint > (first_lease->>'fence')::bigint, 'una concesión caducada se reasigna con un testigo mayor');
  PERFORM public.assert_true(biblib.catalogue_complete('open-library', 'v1', 'db', 1, 'lookupISBN', '9790000900011', (first_lease->>'fence')::bigint, 'found', '[{"title":"vieja"}]', '{}', 60000) = 'stale', 'el trabajador tardío no publica');
  PERFORM public.assert_true(NOT EXISTS (SELECT 1 FROM biblib.catalogue_cache WHERE canonical_key = '9790000900011'), 'la entrada vieja no llegó a la caché');
  PERFORM public.assert_true(biblib.catalogue_complete('open-library', 'v1', 'db', 1, 'lookupISBN', '9790000900011', (fresh->>'fence')::bigint, 'found', '[{"title":"reciente"}]', '{"provider":"open-library"}', 60000) = 'published', 'el titular vigente publica');
  hit := biblib.catalogue_begin('open-library', 'v1', 'db', 1, 'lookupISBN', '9790000900011', true, 60000, NULL);
  PERFORM public.assert_true(hit->>'state' = 'hit' AND hit->'payload'->0->>'title' = 'reciente', 'la siguiente solicitud sale de la caché');
  PERFORM public.assert_true((biblib.catalogue_begin('open-library', 'v2', 'db', 1, 'lookupISBN', '9790000900011', true, 60000, NULL))->>'state' = 'leased', 'otra versión de política no reutiliza la entrada');
  PERFORM public.assert_true(biblib.catalogue_complete('open-library', 'v2', 'db', 1, 'lookupISBN', '9790000900011', (SELECT fence FROM biblib.catalogue_inflight WHERE policy_version = 'v2'), 'unavailable', '[]', '{}', 60000) = 'released', 'una caída cierra la concesión sin escribir');
  PERFORM public.assert_true(NOT EXISTS (SELECT 1 FROM biblib.catalogue_cache WHERE policy_version = 'v2'), 'una caída nunca se guarda como ausencia');
  BEGIN
    INSERT INTO biblib.catalogue_cache (provider, policy_version, credential_scope, schema_version, operation, canonical_key, status, payload, fence, fetched_at, expires_at)
    VALUES ('open-library', 'v1', 'db', 1, 'lookupISBN', 'x', 'unavailable', '[]', 1, now(), now() + interval '1 minute');
    RAISE EXCEPTION 'Prueba fallida: la caché aceptó un estado de caída';
  EXCEPTION WHEN check_violation THEN NULL; END;
  PERFORM public.assert_true(biblib.catalogue_invalidate('open-library', 'v2', 1) = 1, 'invalidar retira las entradas de otra versión');
  PERFORM public.assert_true(NOT EXISTS (SELECT 1 FROM biblib.catalogue_cache), 'no quedan entradas incompatibles');
END;
$test$;

-- Caché privada por dueño y ningún acceso de cliente a la coordinación compartida.
SELECT biblib.catalogue_private_put('10000000-0000-4000-8000-000000000001', 'open-library', 'v1', 'db', 1, 'searchTitleAuthor', repeat('a', 64), 'notFound', '[]', 60000);
SELECT biblib.catalogue_private_put('10000000-0000-4000-8000-000000000002', 'open-library', 'v1', 'db', 1, 'searchTitleAuthor', repeat('b', 64), 'notFound', '[]', 60000);
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
DO $test$
DECLARE affected integer;
BEGIN
  PERFORM public.assert_true((SELECT count(*) = 1 AND bool_and(key_hmac = repeat('a', 64)) FROM biblib.catalogue_private_cache), 'A solo ve su caché privada');
  DELETE FROM biblib.catalogue_private_cache WHERE owner_id = '10000000-0000-4000-8000-000000000002';
  GET DIAGNOSTICS affected = ROW_COUNT;
  PERFORM public.assert_true(affected = 0, 'A no puede purgar la caché privada de B');
  BEGIN
    UPDATE biblib.catalogue_private_cache SET status = 'found';
    RAISE EXCEPTION 'Prueba fallida: authenticated actualizó la caché privada';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM count(*) FROM biblib.catalogue_cache;
    RAISE EXCEPTION 'Prueba fallida: authenticated leyó la caché compartida';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM count(*) FROM biblib.catalogue_quota_reservations;
    RAISE EXCEPTION 'Prueba fallida: authenticated leyó las reservas de cuota';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM biblib.catalogue_reserve('open-library', 'db', '10000000-0000-4000-8000-000000000001', 'interactive', 1000, 2500, 5, 10000);
    RAISE EXCEPTION 'Prueba fallida: authenticated reservó cuota directamente';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM biblib.catalogue_complete('open-library', 'v1', 'db', 1, 'lookupISBN', 'k', 1, 'found', '[]', '{}', 1000);
    RAISE EXCEPTION 'Prueba fallida: authenticated publicó en la caché compartida';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$test$;
ROLLBACK;
SELECT public.assert_true((SELECT count(*) = 2 FROM biblib.catalogue_private_cache), 'las filas privadas de A y B siguen intactas');

SELECT 'Correcto: cuota atómica, intervalo, horizonte, tope por dueño, cooldown, fencing, caché sin caídas, invalidación y aislamiento A/B.' AS resultado;

-- 0016. Programador de los trabajos persistentes (U-DAT-03). En Vercel Hobby un cron solo puede ejecutarse una vez al
-- día, así que lo hace Postgres: pg_cron comprueba cada minuto si hay pasos vencidos y, solo entonces, pg_net llama a
-- `POST /api/internal/jobs/run` con el token del ejecutor. URL y token viven en Supabase Vault
-- (`biblib_jobs_runner_url`, `biblib_jobs_runner_token`); sin ellos no se llama a nada, de modo que los entornos locales
-- y de prueba no salen a la red. La petición es asíncrona: el minuto siguiente vuelve a comprobar el estado.
CREATE FUNCTION "biblib"."library_job_dispatch"() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  target text;
  token text;
BEGIN
  -- Misma condición que library_job_claim para el ejecutor sin sesión: sin pasos reclamables no hay petición.
  IF NOT EXISTS (
    SELECT 1 FROM biblib.library_jobs AS j
    WHERE j.kind <> 'cover_asset' AND j.state IN ('queued', 'running', 'waiting_retry') AND j.next_attempt_at <= now_at
      AND (j.state <> 'running' OR j.lease_until <= now_at)
  ) THEN
    RETURN false;
  END IF;
  IF to_regclass('vault.decrypted_secrets') IS NULL OR to_regnamespace('net') IS NULL THEN
    RETURN false;
  END IF;
  SELECT s.decrypted_secret INTO target FROM vault.decrypted_secrets AS s WHERE s.name = 'biblib_jobs_runner_url';
  SELECT s.decrypted_secret INTO token FROM vault.decrypted_secrets AS s WHERE s.name = 'biblib_jobs_runner_token';
  -- El token nunca viaja sin TLS.
  IF target IS NULL OR token IS NULL OR target !~ '^https://[^/]+/api/internal/jobs/run$' THEN
    RETURN false;
  END IF;
  PERFORM net.http_post(url := target, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || token), timeout_milliseconds := 60000);
  RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."library_job_dispatch"() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
-- pg_cron y pg_net los proporciona Supabase. Un Postgres sin ellas (el remoto simulado de las pruebas de promoción)
-- recibe la función, pero no el programador: los trabajos siguen avanzando con la app abierta o con jobs:run:local.
-- Con el mismo nombre, cron.schedule actualiza el trabajo existente: reaplicar no lo duplica.
DO $scheduler$
BEGIN
  IF (SELECT count(*) FROM pg_available_extensions WHERE name IN ('pg_cron', 'pg_net')) < 2 THEN
    RAISE NOTICE 'pg_cron o pg_net no están disponibles: no se programa biblib-library-jobs.';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_net;
  CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
  PERFORM cron.schedule('biblib-library-jobs', '* * * * *', 'select biblib.library_job_dispatch()');
END;
$scheduler$;

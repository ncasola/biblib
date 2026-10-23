CREATE SEQUENCE "biblib"."library_job_fence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "biblib"."account_lifecycle" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_lifecycle_state_check" CHECK ("biblib"."account_lifecycle"."state" in ('active', 'blocked'))
);
--> statement-breakpoint
ALTER TABLE "biblib"."account_lifecycle" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."library_job_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"phase" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"target_version" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" jsonb,
	"error_code" text,
	"fencing_number" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_job_items_phase_check" CHECK ("biblib"."library_job_items"."phase" in ('covers')),
	CONSTRAINT "library_job_items_state_check" CHECK ("biblib"."library_job_items"."state" in ('pending', 'waiting_retry', 'succeeded', 'not_found', 'skipped', 'failed')),
	CONSTRAINT "library_job_items_key_check" CHECK (length("biblib"."library_job_items"."item_key") between 1 and 200),
	CONSTRAINT "library_job_items_attempts_check" CHECK ("biblib"."library_job_items"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "biblib"."library_job_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."library_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"contract_version" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_digest" text NOT NULL,
	"preview_id" uuid,
	"expected_revision" uuid,
	"state" text DEFAULT 'queued' NOT NULL,
	"phase" text NOT NULL,
	"cursor" text,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_token" uuid,
	"fencing_number" bigint DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "library_jobs_kind_check" CHECK ("biblib"."library_jobs"."kind" in ('import', 'covers')),
	CONSTRAINT "library_jobs_state_check" CHECK ("biblib"."library_jobs"."state" in ('queued', 'running', 'waiting_retry', 'needs_review', 'paused', 'succeeded', 'partially_succeeded', 'failed', 'cancelled', 'expired')),
	CONSTRAINT "library_jobs_phase_check" CHECK ("biblib"."library_jobs"."phase" in ('publish', 'covers', 'done')),
	CONSTRAINT "library_jobs_key_check" CHECK (length("biblib"."library_jobs"."idempotency_key") between 16 and 128),
	CONSTRAINT "library_jobs_digest_check" CHECK ("biblib"."library_jobs"."input_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "library_jobs_import_check" CHECK ("biblib"."library_jobs"."kind" <> 'import' or ("biblib"."library_jobs"."preview_id" is not null and "biblib"."library_jobs"."expected_revision" is not null)),
	CONSTRAINT "library_jobs_lease_check" CHECK (("biblib"."library_jobs"."state" = 'running') = ("biblib"."library_jobs"."lease_token" is not null and "biblib"."library_jobs"."lease_until" is not null)),
	CONSTRAINT "library_jobs_counts_check" CHECK (jsonb_typeof("biblib"."library_jobs"."counts") = 'object'),
	CONSTRAINT "library_jobs_attempts_check" CHECK ("biblib"."library_jobs"."attempts" >= 0 and "biblib"."library_jobs"."fencing_number" >= 0)
);
--> statement-breakpoint
ALTER TABLE "biblib"."library_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "biblib"."account_lifecycle" ADD CONSTRAINT "account_lifecycle_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."library_jobs" ADD CONSTRAINT "library_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "library_job_items_job_item_phase_unique" ON "biblib"."library_job_items" USING btree ("job_id","item_key","phase");--> statement-breakpoint
CREATE INDEX "library_job_items_due_idx" ON "biblib"."library_job_items" USING btree ("job_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "library_jobs_key_unique" ON "biblib"."library_jobs" USING btree ("user_id","kind","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "library_jobs_user_id_id_unique" ON "biblib"."library_jobs" USING btree ("user_id","id");--> statement-breakpoint
-- La FK compuesta (propietario, trabajo) necesita antes el índice único de library_jobs.
ALTER TABLE "biblib"."library_job_items" ADD CONSTRAINT "library_job_items_owner_job_fk" FOREIGN KEY ("user_id","job_id") REFERENCES "biblib"."library_jobs"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_jobs_user_id_created_at_idx" ON "biblib"."library_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "library_jobs_due_idx" ON "biblib"."library_jobs" USING btree ("next_attempt_at") WHERE "biblib"."library_jobs"."state" in ('queued', 'running', 'waiting_retry');--> statement-breakpoint
CREATE POLICY "account_lifecycle_select_own" ON "biblib"."account_lifecycle" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid() = "biblib"."account_lifecycle"."user_id"));--> statement-breakpoint
CREATE POLICY "library_job_items_select_own" ON "biblib"."library_job_items" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid() = "biblib"."library_job_items"."user_id"));--> statement-breakpoint
CREATE POLICY "library_jobs_select_own" ON "biblib"."library_jobs" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid() = "biblib"."library_jobs"."user_id"));
--> statement-breakpoint
-- U-DAT-03: trabajos persistentes. Todas las funciones son SECURITY DEFINER con search_path fijo y
-- usan la hora de la base (clock_timestamp), nunca la del navegador ni la del trabajador.
-- Guarda de cuenta activa: sin fila de ciclo de vida la cuenta está activa; `blocked` o una cuenta
-- inexistente impiden que un trabajo escriba en su nombre.
CREATE FUNCTION "biblib"."account_is_active"(p_owner uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM auth.users AS account WHERE account.id = p_owner)
    AND NOT EXISTS (SELECT 1 FROM biblib.account_lifecycle AS lifecycle WHERE lifecycle.user_id = p_owner AND lifecycle.state <> 'active');
END;
$$;
--> statement-breakpoint
-- Transición administrativa del ciclo de vida. Al bloquear, los trabajos no terminados pasan a
-- `expired` (no autorizados) y ningún trabajador antiguo puede volver a escribir.
CREATE FUNCTION "biblib"."account_set_state"(p_owner uuid, p_state text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  affected integer := 0;
BEGIN
  IF p_state NOT IN ('active', 'blocked') THEN
    RAISE EXCEPTION 'Estado de cuenta no válido' USING ERRCODE = '22023';
  END IF;
  INSERT INTO biblib.account_lifecycle AS lifecycle (user_id, state, changed_at) VALUES (p_owner, p_state, now_at)
  ON CONFLICT (user_id) DO UPDATE SET state = excluded.state, changed_at = excluded.changed_at;
  IF p_state = 'blocked' THEN
    UPDATE biblib.library_jobs AS j
    SET state = 'expired', error_code = 'ACCOUNT_INACTIVE', lease_token = NULL, lease_until = NULL, version = gen_random_uuid(),
      finished_at = now_at, expires_at = now_at + interval '30 days', updated_at = now_at
    WHERE j.user_id = p_owner AND j.state IN ('queued', 'running', 'waiting_retry', 'needs_review', 'paused');
    GET DIAGNOSTICS affected = ROW_COUNT;
  END IF;
  RETURN affected;
END;
$$;
--> statement-breakpoint
-- Alta idempotente de un trabajo. El dueño sale de auth.uid(); la misma clave con otra entrada es
-- un conflicto y una repetición idéntica devuelve el trabajo existente.
CREATE FUNCTION "biblib"."library_job_create"(p_kind text, p_idempotency_key text, p_input_digest text, p_preview_id uuid, p_expected_revision uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  now_at timestamptz := clock_timestamp();
  existing biblib.library_jobs%ROWTYPE;
  active_id uuid;
  created_id uuid;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'library_job_create requiere una sesión' USING ERRCODE = '42501';
  END IF;
  IF NOT biblib.account_is_active(owner_id) THEN
    RETURN jsonb_build_object('status', 'inactive');
  END IF;
  -- Serializa las altas del mismo dueño: clave, límite y trabajo de portadas activo.
  PERFORM pg_advisory_xact_lock(hashtextextended('biblib.library_jobs:' || owner_id::text, 0));
  SELECT * INTO existing FROM biblib.library_jobs AS j WHERE j.user_id = owner_id AND j.kind = p_kind AND j.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.input_digest <> p_input_digest THEN
      RETURN jsonb_build_object('status', 'conflict');
    END IF;
    RETURN jsonb_build_object('status', 'existing', 'id', existing.id);
  END IF;
  IF p_kind = 'import' AND NOT EXISTS (SELECT 1 FROM biblib.import_previews AS preview WHERE preview.id = p_preview_id AND preview.user_id = owner_id) THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  -- Resúmenes terminados fuera de su retención.
  DELETE FROM biblib.library_jobs AS j WHERE j.user_id = owner_id AND j.finished_at IS NOT NULL AND j.expires_at <= now_at;
  IF p_kind = 'covers' THEN
    SELECT j.id INTO active_id FROM biblib.library_jobs AS j
    WHERE j.user_id = owner_id AND j.kind = 'covers' AND j.state IN ('queued', 'running', 'waiting_retry', 'paused') LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'busy', 'id', active_id);
    END IF;
  END IF;
  IF (SELECT count(*) FROM biblib.library_jobs AS j WHERE j.user_id = owner_id AND j.state IN ('queued', 'running', 'waiting_retry', 'paused')) >= 5 THEN
    RETURN jsonb_build_object('status', 'limit');
  END IF;
  INSERT INTO biblib.library_jobs (user_id, kind, contract_version, idempotency_key, input_digest, preview_id, expected_revision, phase, next_attempt_at, expires_at)
  VALUES (owner_id, p_kind, 1, p_idempotency_key, p_input_digest, p_preview_id, p_expected_revision,
    CASE WHEN p_kind = 'import' THEN 'publish' ELSE 'covers' END, now_at, now_at + interval '7 days')
  RETURNING id INTO created_id;
  RETURN jsonb_build_object('status', 'created', 'id', created_id);
END;
$$;
--> statement-breakpoint
-- Pausar, reanudar o cancelar con la versión vista por el dueño. Bloquea la fila: si un paso está
-- publicando, espera a que termine y responde si la publicación ya se había confirmado.
CREATE FUNCTION "biblib"."library_job_control"(p_job_id uuid, p_expected_version uuid, p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  now_at timestamptz;
  job biblib.library_jobs%ROWTYPE;
  target text;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'library_job_control requiere una sesión' USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN ('pause', 'resume', 'cancel') THEN
    RAISE EXCEPTION 'Acción de trabajo no válida' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO job FROM biblib.library_jobs AS j WHERE j.id = p_job_id AND j.user_id = owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  now_at := clock_timestamp();
  IF job.state IN ('queued', 'running', 'waiting_retry', 'needs_review', 'paused') AND (job.expires_at <= now_at OR NOT biblib.account_is_active(owner_id)) THEN
    UPDATE biblib.library_jobs AS j
    SET state = 'expired', error_code = CASE WHEN job.expires_at <= now_at THEN 'JOB_EXPIRED' ELSE 'ACCOUNT_INACTIVE' END,
      lease_token = NULL, lease_until = NULL, version = gen_random_uuid(), finished_at = now_at, expires_at = now_at + interval '30 days', updated_at = now_at
    WHERE j.id = job.id;
    RETURN jsonb_build_object('status', 'expired', 'published', job.published_at IS NOT NULL);
  END IF;
  IF job.state = 'expired' THEN
    RETURN jsonb_build_object('status', 'expired', 'published', job.published_at IS NOT NULL);
  END IF;
  IF job.version <> p_expected_version THEN
    RETURN jsonb_build_object('status', 'conflict');
  END IF;
  target := CASE
    WHEN p_action = 'pause' AND job.state IN ('queued', 'running', 'waiting_retry') THEN 'paused'
    WHEN p_action = 'resume' AND job.state = 'paused' THEN 'queued'
    WHEN p_action = 'cancel' AND job.state IN ('queued', 'running', 'waiting_retry', 'needs_review', 'paused') THEN 'cancelled'
  END;
  IF target IS NULL THEN
    IF (p_action = 'pause' AND job.state = 'paused') OR (p_action = 'resume' AND job.state IN ('queued', 'running', 'waiting_retry')) OR (p_action = 'cancel' AND job.state = 'cancelled') THEN
      RETURN jsonb_build_object('status', 'ok', 'published', job.published_at IS NOT NULL);
    END IF;
    RETURN jsonb_build_object('status', 'conflict');
  END IF;
  UPDATE biblib.library_jobs AS j
  SET state = target, version = gen_random_uuid(), lease_token = NULL, lease_until = NULL,
    next_attempt_at = CASE WHEN target = 'queued' THEN now_at ELSE j.next_attempt_at END,
    error_code = CASE WHEN target = 'cancelled' THEN 'CANCELLED' ELSE j.error_code END,
    finished_at = CASE WHEN target = 'cancelled' THEN now_at ELSE j.finished_at END,
    expires_at = CASE WHEN target = 'cancelled' THEN now_at + interval '30 days' ELSE j.expires_at END,
    updated_at = now_at
  WHERE j.id = job.id;
  RETURN jsonb_build_object('status', 'ok', 'published', job.published_at IS NOT NULL);
END;
$$;
--> statement-breakpoint
-- Reclama el siguiente trabajo vencido con FOR UPDATE SKIP LOCKED: lease nuevo, token nuevo y un
-- número de fencing mayor que cualquier anterior. Un lease caducado se puede volver a reclamar.
CREATE FUNCTION "biblib"."library_job_claim"(p_job_id uuid, p_owner uuid, p_lease_ms integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  lease_ms integer := greatest(1000, least(coalesce(p_lease_ms, 60000), 300000));
  candidate biblib.library_jobs%ROWTYPE;
  claimed biblib.library_jobs%ROWTYPE;
  active boolean;
BEGIN
  FOR candidate IN
    SELECT * FROM biblib.library_jobs AS j
    WHERE (p_job_id IS NULL OR j.id = p_job_id) AND (p_owner IS NULL OR j.user_id = p_owner)
      AND j.state IN ('queued', 'running', 'waiting_retry') AND j.next_attempt_at <= now_at
      AND (j.state <> 'running' OR j.lease_until <= now_at)
    ORDER BY j.next_attempt_at, j.created_at
    LIMIT 10
    FOR UPDATE SKIP LOCKED
  LOOP
    active := biblib.account_is_active(candidate.user_id);
    -- Caducado, cuenta no activa o pasos que fallan una y otra vez: se cierra sin ejecutar.
    IF candidate.expires_at <= now_at OR NOT active OR candidate.attempts >= 10 THEN
      UPDATE biblib.library_jobs AS j
      SET state = CASE WHEN candidate.expires_at <= now_at OR NOT active THEN 'expired' ELSE 'failed' END,
        error_code = CASE WHEN candidate.expires_at <= now_at THEN 'JOB_EXPIRED' WHEN NOT active THEN 'ACCOUNT_INACTIVE' ELSE 'STEP_FAILED' END,
        lease_token = NULL, lease_until = NULL, version = gen_random_uuid(), finished_at = now_at, expires_at = now_at + interval '30 days', updated_at = now_at
      WHERE j.id = candidate.id;
      CONTINUE;
    END IF;
    UPDATE biblib.library_jobs AS j
    SET state = 'running', lease_token = gen_random_uuid(), lease_until = now_at + lease_ms * interval '1 millisecond',
      fencing_number = nextval('biblib.library_job_fence_seq'), attempts = j.attempts + 1, updated_at = now_at
    WHERE j.id = candidate.id
    RETURNING * INTO claimed;
    RETURN to_jsonb(claimed) || jsonb_build_object('fencing_number', claimed.fencing_number::text);
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- Renueva un lease vigente con su token y fencing; un lease vencido o reclamado por otro no se renueva.
CREATE FUNCTION "biblib"."library_job_renew"(p_job_id uuid, p_lease_token uuid, p_fencing bigint, p_lease_ms integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
BEGIN
  UPDATE biblib.library_jobs AS j
  SET lease_until = now_at + greatest(1000, least(coalesce(p_lease_ms, 60000), 300000)) * interval '1 millisecond', updated_at = now_at
  WHERE j.id = p_job_id AND j.state = 'running' AND j.lease_token = p_lease_token AND j.fencing_number = p_fencing
    AND j.lease_until > now_at AND biblib.account_is_active(j.user_id);
  RETURN FOUND;
END;
$$;
--> statement-breakpoint
-- Primera sentencia de cada transacción de escritura del ejecutor: bloquea la fila del trabajo y
-- comprueba lease, token, fencing y cuenta activa. Devuelve el dueño de la fila reclamada.
CREATE FUNCTION "biblib"."library_job_fence"(p_job_id uuid, p_lease_token uuid, p_fencing bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  job record;
BEGIN
  SELECT j.user_id, j.state, j.lease_token, j.fencing_number, j.lease_until INTO job
  FROM biblib.library_jobs AS j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND OR job.state <> 'running' OR job.lease_token IS DISTINCT FROM p_lease_token OR job.fencing_number <> p_fencing OR job.lease_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'El lease del trabajo ya no es válido' USING ERRCODE = 'BJ001';
  END IF;
  IF NOT biblib.account_is_active(job.user_id) THEN
    RAISE EXCEPTION 'La cuenta del trabajo no está activa' USING ERRCODE = 'BJ002';
  END IF;
  RETURN job.user_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."account_is_active"(uuid) FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."account_set_state"(uuid, text) FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."library_job_claim"(uuid, uuid, integer) FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."library_job_renew"(uuid, uuid, bigint, integer) FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."library_job_fence"(uuid, uuid, bigint) FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."library_job_create"(text, text, text, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."library_job_control"(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "biblib"."library_job_create"(text, text, text, uuid, uuid) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "biblib"."library_job_control"(uuid, uuid, text) TO authenticated;
--> statement-breakpoint
-- El dueño solo lee sus trabajos, elementos y ciclo de vida; toda escritura pasa por las funciones.
REVOKE ALL ON "biblib"."library_jobs", "biblib"."library_job_items", "biblib"."account_lifecycle" FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON SEQUENCE "biblib"."library_job_fence_seq" FROM PUBLIC, authenticated;
--> statement-breakpoint
GRANT SELECT ON "biblib"."library_jobs", "biblib"."library_job_items", "biblib"."account_lifecycle" TO authenticated;

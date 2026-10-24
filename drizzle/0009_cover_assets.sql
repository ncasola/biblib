CREATE TABLE "biblib"."cover_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"storage_key" text,
	"sha256" text,
	"mime" text,
	"width" integer,
	"height" integer,
	"bytes" integer,
	"state" text DEFAULT 'quarantine' NOT NULL,
	"source_kind" text NOT NULL,
	"source_ref" text NOT NULL,
	"rights_policy_version" text NOT NULL,
	"attribution" text,
	"upload_token" text,
	"job_id" uuid,
	"attach_book_id" uuid,
	"attach_book_version" uuid,
	"expires_at" timestamp with time zone,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cover_assets_state_check" CHECK ("biblib"."cover_assets"."state" in ('quarantine', 'ready', 'restored')),
	CONSTRAINT "cover_assets_source_kind_check" CHECK ("biblib"."cover_assets"."source_kind" in ('provider', 'upload')),
	CONSTRAINT "cover_assets_source_ref_check" CHECK (("biblib"."cover_assets"."source_kind" = 'upload' and "biblib"."cover_assets"."source_ref" = 'upload') or ("biblib"."cover_assets"."source_kind" = 'provider' and "biblib"."cover_assets"."source_ref" ~ '^(open-library|bne):[a-z]{2,8}:[A-Za-z0-9-]{1,40}$')),
	CONSTRAINT "cover_assets_sha_check" CHECK ("biblib"."cover_assets"."sha256" is null or "biblib"."cover_assets"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cover_assets_key_check" CHECK ("biblib"."cover_assets"."storage_key" is null or "biblib"."cover_assets"."storage_key" ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9_-]{1,64}[.]webp$'),
	CONSTRAINT "cover_assets_token_check" CHECK ("biblib"."cover_assets"."upload_token" is null or "biblib"."cover_assets"."upload_token" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "cover_assets_size_check" CHECK (("biblib"."cover_assets"."bytes" is null or ("biblib"."cover_assets"."bytes" >= 1 and "biblib"."cover_assets"."bytes" <= 5242880)) and ("biblib"."cover_assets"."width" is null or ("biblib"."cover_assets"."width" >= 1 and "biblib"."cover_assets"."width" <= 10000)) and ("biblib"."cover_assets"."height" is null or ("biblib"."cover_assets"."height" >= 1 and "biblib"."cover_assets"."height" <= 10000))),
	CONSTRAINT "cover_assets_ready_check" CHECK ("biblib"."cover_assets"."state" = 'quarantine' or ("biblib"."cover_assets"."storage_key" is not null and "biblib"."cover_assets"."sha256" is not null and "biblib"."cover_assets"."mime" = 'image/webp' and "biblib"."cover_assets"."width" is not null and "biblib"."cover_assets"."height" is not null and "biblib"."cover_assets"."bytes" is not null)),
	CONSTRAINT "cover_assets_quarantine_check" CHECK ("biblib"."cover_assets"."state" <> 'quarantine' or "biblib"."cover_assets"."expires_at" is not null),
	CONSTRAINT "cover_assets_attach_check" CHECK (("biblib"."cover_assets"."attach_book_id" is null) = ("biblib"."cover_assets"."attach_book_version" is null))
);
--> statement-breakpoint
ALTER TABLE "biblib"."cover_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "biblib"."library_jobs" DROP CONSTRAINT "library_jobs_kind_check";--> statement-breakpoint
ALTER TABLE "biblib"."library_jobs" DROP CONSTRAINT "library_jobs_phase_check";--> statement-breakpoint
ALTER TABLE "biblib"."books" ADD COLUMN "cover_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "biblib"."cover_assets" ADD CONSTRAINT "cover_assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."cover_assets" ADD CONSTRAINT "cover_assets_owner_job_fk" FOREIGN KEY ("user_id","job_id") REFERENCES "biblib"."library_jobs"("user_id","id") ON DELETE SET NULL ("job_id") ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cover_assets_user_id_id_unique" ON "biblib"."cover_assets" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "cover_assets_user_sha_unique" ON "biblib"."cover_assets" USING btree ("user_id","sha256") WHERE "biblib"."cover_assets"."state" in ('ready', 'restored');--> statement-breakpoint
CREATE UNIQUE INDEX "cover_assets_job_unique" ON "biblib"."cover_assets" USING btree ("job_id") WHERE "biblib"."cover_assets"."job_id" is not null;--> statement-breakpoint
CREATE INDEX "cover_assets_user_created_idx" ON "biblib"."cover_assets" USING btree ("user_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "cover_assets_expires_at_idx" ON "biblib"."cover_assets" USING btree ("expires_at") WHERE "biblib"."cover_assets"."expires_at" is not null;--> statement-breakpoint
ALTER TABLE "biblib"."books" ADD CONSTRAINT "books_owner_cover_asset_fk" FOREIGN KEY ("user_id","cover_asset_id") REFERENCES "biblib"."cover_assets"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "books_cover_asset_idx" ON "biblib"."books" USING btree ("user_id","cover_asset_id") WHERE "biblib"."books"."cover_asset_id" is not null;--> statement-breakpoint
ALTER TABLE "biblib"."library_jobs" ADD CONSTRAINT "library_jobs_kind_check" CHECK ("biblib"."library_jobs"."kind" in ('import', 'covers', 'cover_asset'));--> statement-breakpoint
ALTER TABLE "biblib"."library_jobs" ADD CONSTRAINT "library_jobs_phase_check" CHECK ("biblib"."library_jobs"."phase" in ('publish', 'covers', 'asset', 'done'));--> statement-breakpoint
CREATE POLICY "cover_assets_select_own" ON "biblib"."cover_assets" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid() = "biblib"."cover_assets"."user_id"));
--> statement-breakpoint
-- U-DAT-10: portadas privadas. Toda transición de un asset pasa por funciones con search_path fijo; el
-- dueño sale de auth.uid() (sesión del servidor o trabajo con los claims del dueño de la fila reclamada),
-- nunca de un argumento. La hora es la de la base.
--> statement-breakpoint
-- Las versiones anteriores retienen la portada privada de cada ficha (solo si la tiene: el contenido
-- de las fichas sin asset no cambia y sus hashes siguen siendo los de 0006).
CREATE OR REPLACE FUNCTION "biblib"."library_snapshot_capture"(p_operation_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  now_at timestamptz := clock_timestamp();
  captured uuid;
  new_id uuid;
  book_total integer;
  shelf_total integer;
  shelf_chunks integer;
  chunk_total integer;
  byte_total bigint;
  final_digest text;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'library_snapshot_capture requiere una sesión' USING ERRCODE = '42501';
  END IF;
  IF p_reason NOT IN ('import.replace', 'snapshot.restore') THEN
    RAISE EXCEPTION 'Motivo de captura no válido' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM biblib.library_operations AS o WHERE o.id = p_operation_id AND o.user_id = owner_id AND o.created_at = now()) THEN
    RAISE EXCEPTION 'La captura exige la operación de esta misma transacción' USING ERRCODE = '42501';
  END IF;
  IF NOT biblib.account_is_active(owner_id) THEN
    RAISE EXCEPTION 'La cuenta no admite versiones nuevas' USING ERRCODE = 'BS002';
  END IF;
  -- Bajo el bloqueo de colección: la revisión capturada es la que la operación va a sustituir.
  captured := biblib.lock_library();
  -- Las versiones vencidas ya no se muestran ni se restauran: se retiran al capturar.
  DELETE FROM biblib.library_snapshots AS s WHERE s.user_id = owner_id AND s.expires_at <= now_at;
  IF (SELECT count(*) FROM biblib.library_snapshots AS s WHERE s.user_id = owner_id) >= 10 THEN
    RAISE EXCEPTION 'Cuota de versiones anteriores agotada' USING ERRCODE = 'BS001';
  END IF;
  SELECT count(*) INTO book_total FROM biblib.books AS b WHERE b.user_id = owner_id;
  SELECT count(*) INTO shelf_total FROM biblib.shelves AS sh WHERE sh.user_id = owner_id;
  IF book_total > 10000 OR shelf_total > 1000 THEN
    RAISE EXCEPTION 'Colección demasiado grande para guardar una versión anterior' USING ERRCODE = 'BS003';
  END IF;
  INSERT INTO biblib.library_snapshots AS s (user_id, source_operation_id, reason, captured_revision, schema_version, state, expires_at, created_at)
  VALUES (owner_id, p_operation_id, p_reason, captured, 1, 'capturing', now_at + interval '30 days', now_at)
  RETURNING s.id INTO new_id;
  shelf_chunks := (shelf_total + 199) / 200;
  INSERT INTO biblib.library_snapshot_chunks (snapshot_id, user_id, seq, kind, item_count, payload, digest)
  SELECT new_id, owner_id, grouped.seq, grouped.kind, grouped.n, grouped.payload, encode(sha256(convert_to(grouped.payload::text, 'UTF8')), 'hex')
  FROM (
    SELECT (ranked.rn / 200)::integer AS seq, 'shelves'::text AS kind, count(*)::integer AS n, jsonb_agg(ranked.item ORDER BY ranked.rn) AS payload
    FROM (
      SELECT row_number() OVER (ORDER BY sh.created_at, sh.id) - 1 AS rn,
        jsonb_build_object('id', sh.id, 'title', sh.title, 'is_default', sh.is_default, 'created_at', sh.created_at) AS item
      FROM biblib.shelves AS sh WHERE sh.user_id = owner_id
    ) AS ranked
    GROUP BY ranked.rn / 200
    UNION ALL
    SELECT shelf_chunks + (ranked.rn / 200)::integer, 'books', count(*)::integer, jsonb_agg(ranked.item ORDER BY ranked.rn)
    FROM (
      SELECT row_number() OVER (ORDER BY b.id) - 1 AS rn,
        jsonb_build_object('id', b.id, 'isbn', b.isbn, 'title', b.title, 'subtitle', b.subtitle, 'authors', b.authors, 'publishers', b.publishers,
          'catalogue', b.catalogue, 'number_of_pages', b.number_of_pages, 'publish_date', b.publish_date, 'cover_small', b.cover_small,
          'cover_medium', b.cover_medium, 'cover_large', b.cover_large, 'status', b.status, 'shelf_id', b.shelf_id, 'created_at', b.created_at)
          || CASE WHEN b.cover_asset_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cover_asset_id', b.cover_asset_id) END AS item
      FROM biblib.books AS b WHERE b.user_id = owner_id
    ) AS ranked
    GROUP BY ranked.rn / 200
  ) AS grouped;
  SELECT count(*)::integer, coalesce(sum(octet_length(c.payload::text)), 0),
    encode(sha256(convert_to(concat_ws('|', 'biblib.snapshot.v1', book_total, shelf_total, coalesce(string_agg(c.digest, '' ORDER BY c.seq), '')), 'UTF8')), 'hex')
  INTO chunk_total, byte_total, final_digest
  FROM biblib.library_snapshot_chunks AS c WHERE c.snapshot_id = new_id;
  UPDATE biblib.library_snapshots AS s
  SET state = 'ready', digest = final_digest,
    counts = jsonb_build_object('books', book_total, 'shelves', shelf_total, 'chunks', chunk_total, 'bytes', byte_total)
  WHERE s.id = new_id;
  RETURN jsonb_build_object('id', new_id, 'digest', final_digest, 'books', book_total, 'shelves', shelf_total, 'chunks', chunk_total);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "biblib"."library_job_claim"(p_job_id uuid, p_owner uuid, p_lease_ms integer) RETURNS jsonb
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
      -- U-DAT-10: una adquisición de portada sube con la sesión del dueño; el ejecutor sin sesión no la reclama.
      AND (p_job_id IS NOT NULL OR j.kind <> 'cover_asset')
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
-- Guarda de las políticas de storage.objects del bucket privado `biblib-covers`. Ruta exacta
-- `<dueño>/<asset>/<intento>.webp`: el dueño lee sus objetos, sube solo el intento autorizado de un
-- asset en cuarentena vigente (si lo adquiere un trabajo, con su lease y el mismo número de fencing) y
-- retira objetos que no son el registrado de un asset utilizable. Sin sesión, nada.
CREATE FUNCTION "biblib"."cover_object_access"(p_name text, p_action text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  parts text[];
  asset biblib.cover_assets%ROWTYPE;
BEGIN
  IF owner_id IS NULL OR p_name IS NULL OR p_action IS NULL OR p_action NOT IN ('select', 'insert', 'delete') THEN
    RETURN false;
  END IF;
  parts := string_to_array(p_name, '/');
  IF coalesce(array_length(parts, 1), 0) <> 3 OR parts[1] <> owner_id::text
    OR parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR parts[3] !~ '^[A-Za-z0-9_-]{1,64}[.]webp$' THEN
    RETURN false;
  END IF;
  SELECT * INTO asset FROM biblib.cover_assets AS a WHERE a.id = parts[2]::uuid AND a.user_id = owner_id;
  IF NOT FOUND THEN
    -- Objeto propio sin fila (subido y nunca registrado, o asset ya purgado): solo se puede retirar.
    RETURN p_action = 'delete';
  END IF;
  IF p_action = 'select' THEN
    RETURN true;
  END IF;
  IF p_action = 'delete' THEN
    RETURN asset.state = 'quarantine' OR asset.storage_key IS DISTINCT FROM p_name;
  END IF;
  RETURN asset.state = 'quarantine' AND asset.expires_at > clock_timestamp() AND asset.upload_token IS NOT NULL
    AND parts[3] = asset.upload_token || '.webp' AND biblib.account_is_active(owner_id)
    AND (asset.job_id IS NULL OR EXISTS (SELECT 1 FROM biblib.library_jobs AS j WHERE j.id = asset.job_id AND j.user_id = owner_id
      AND j.state = 'running' AND j.lease_until > clock_timestamp() AND j.fencing_number::text = asset.upload_token));
END;
$$;
--> statement-breakpoint
-- Cuotas del dueño bajo el mismo bloqueo que las altas de trabajos: en cuarentena, utilizables y bytes.
CREATE FUNCTION "biblib"."cover_asset_quota"(p_owner uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
BEGIN
  IF (SELECT count(*) FROM biblib.cover_assets AS a WHERE a.user_id = p_owner AND a.state = 'quarantine' AND a.expires_at > now_at) >= 5 THEN
    RETURN 'quarantine';
  END IF;
  IF (SELECT count(*) FROM biblib.cover_assets AS a WHERE a.user_id = p_owner AND a.state <> 'quarantine') >= 500
    OR (SELECT coalesce(sum(a.bytes), 0) FROM biblib.cover_assets AS a WHERE a.user_id = p_owner AND a.state <> 'quarantine') >= 209715200 THEN
    RETURN 'stored';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- Solicitud idempotente de copia privada de la portada de un proveedor. El servidor ya comprobó los
-- derechos vigentes (rehostCover) y validó la clave; aquí se ata a la ficha y su versión, se aplican
-- cuotas y se crean el trabajo y el asset en cuarentena en la misma transacción.
CREATE FUNCTION "biblib"."cover_asset_request"(p_book_id uuid, p_book_version uuid, p_source_ref text, p_policy_version text, p_attribution text, p_idempotency_key text, p_input_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  now_at timestamptz := clock_timestamp();
  existing biblib.library_jobs%ROWTYPE;
  current_version uuid;
  quota text;
  job_id uuid;
  asset_id uuid;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'cover_asset_request requiere una sesión' USING ERRCODE = '42501';
  END IF;
  IF NOT biblib.account_is_active(owner_id) THEN
    RETURN jsonb_build_object('status', 'inactive');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('biblib.library_jobs:' || owner_id::text, 0));
  SELECT * INTO existing FROM biblib.library_jobs AS j WHERE j.user_id = owner_id AND j.kind = 'cover_asset' AND j.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.input_digest <> p_input_digest THEN
      RETURN jsonb_build_object('status', 'conflict');
    END IF;
    SELECT a.id INTO asset_id FROM biblib.cover_assets AS a WHERE a.job_id = existing.id AND a.user_id = owner_id;
    RETURN jsonb_build_object('status', 'existing', 'job_id', existing.id, 'asset_id', asset_id);
  END IF;
  SELECT b.version INTO current_version FROM biblib.books AS b WHERE b.id = p_book_id AND b.user_id = owner_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF current_version <> p_book_version THEN
    RETURN jsonb_build_object('status', 'stale');
  END IF;
  IF (SELECT count(*) FROM biblib.library_jobs AS j WHERE j.user_id = owner_id AND j.state IN ('queued', 'running', 'waiting_retry', 'paused')) >= 5 THEN
    RETURN jsonb_build_object('status', 'limit');
  END IF;
  quota := biblib.cover_asset_quota(owner_id);
  IF quota IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'quota', 'quota', quota);
  END IF;
  INSERT INTO biblib.library_jobs (user_id, kind, contract_version, idempotency_key, input_digest, phase, next_attempt_at, expires_at)
  VALUES (owner_id, 'cover_asset', 1, p_idempotency_key, p_input_digest, 'asset', now_at, now_at + interval '1 day')
  RETURNING id INTO job_id;
  INSERT INTO biblib.cover_assets (user_id, state, source_kind, source_ref, rights_policy_version, attribution, job_id, attach_book_id, attach_book_version, expires_at)
  VALUES (owner_id, 'quarantine', 'provider', p_source_ref, p_policy_version, p_attribution, job_id, p_book_id, p_book_version, now_at + interval '1 day')
  RETURNING id INTO asset_id;
  RETURN jsonb_build_object('status', 'created', 'job_id', job_id, 'asset_id', asset_id);
END;
$$;
--> statement-breakpoint
-- Reserva de una subida propia: asset en cuarentena 15 minutos con un token de intento de un solo uso.
CREATE FUNCTION "biblib"."cover_asset_begin_upload"() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  now_at timestamptz := clock_timestamp();
  quota text;
  token text := replace(gen_random_uuid()::text, '-', '');
  asset_id uuid;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'cover_asset_begin_upload requiere una sesión' USING ERRCODE = '42501';
  END IF;
  IF NOT biblib.account_is_active(owner_id) THEN
    RETURN jsonb_build_object('status', 'inactive');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('biblib.library_jobs:' || owner_id::text, 0));
  quota := biblib.cover_asset_quota(owner_id);
  IF quota IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'quota', 'quota', quota);
  END IF;
  INSERT INTO biblib.cover_assets (user_id, state, source_kind, source_ref, rights_policy_version, upload_token, expires_at)
  VALUES (owner_id, 'quarantine', 'upload', 'upload', 'upload.v1', token, now_at + interval '15 minutes')
  RETURNING id INTO asset_id;
  RETURN jsonb_build_object('status', 'created', 'asset_id', asset_id, 'upload_token', token);
END;
$$;
--> statement-breakpoint
-- Autoriza el siguiente intento de subida de un asset en cuarentena. Para un trabajo, el token es su
-- número de fencing y solo lo fija una transacción ya cercada por library_job_fence.
CREATE FUNCTION "biblib"."cover_asset_authorize"(p_asset_id uuid, p_upload_token text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'cover_asset_authorize requiere una sesión' USING ERRCODE = '42501';
  END IF;
  UPDATE biblib.cover_assets AS a SET upload_token = p_upload_token, updated_at = clock_timestamp()
  WHERE a.id = p_asset_id AND a.user_id = owner_id AND a.state = 'quarantine' AND a.expires_at > clock_timestamp()
    AND biblib.account_is_active(owner_id);
  RETURN FOUND;
END;
$$;
--> statement-breakpoint
-- Registra un asset validado. Exige el intento autorizado, la cuarentena vigente, la cuenta activa y el
-- objeto ya presente en Storage con el tamaño declarado: nunca se confirma un enlace sin objeto. Si el
-- dueño ya tenía la misma imagen, se descarta esta cuarentena y se devuelve la existente.
CREATE FUNCTION "biblib"."cover_asset_register"(p_asset_id uuid, p_upload_token text, p_sha256 text, p_bytes integer, p_width integer, p_height integer, p_license_expires_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  now_at timestamptz := clock_timestamp();
  asset biblib.cover_assets%ROWTYPE;
  key text;
  duplicate uuid;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'cover_asset_register requiere una sesión' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO asset FROM biblib.cover_assets AS a WHERE a.id = p_asset_id AND a.user_id = owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF NOT biblib.account_is_active(owner_id) THEN
    RETURN jsonb_build_object('status', 'inactive');
  END IF;
  IF asset.state <> 'quarantine' OR asset.expires_at <= now_at OR asset.upload_token IS DISTINCT FROM p_upload_token THEN
    RETURN jsonb_build_object('status', 'stale');
  END IF;
  SELECT a.id INTO duplicate FROM biblib.cover_assets AS a WHERE a.user_id = owner_id AND a.sha256 = p_sha256 AND a.state IN ('ready', 'restored') AND a.id <> asset.id;
  IF FOUND THEN
    DELETE FROM biblib.cover_assets AS a WHERE a.id = asset.id;
    RETURN jsonb_build_object('status', 'duplicate', 'asset_id', duplicate);
  END IF;
  key := owner_id::text || '/' || asset.id::text || '/' || p_upload_token || '.webp';
  IF NOT EXISTS (SELECT 1 FROM storage.objects AS o WHERE o.bucket_id = 'biblib-covers' AND o.name = key AND (o.metadata->>'size')::bigint = p_bytes) THEN
    RETURN jsonb_build_object('status', 'missing_object');
  END IF;
  UPDATE biblib.cover_assets AS a
  SET state = 'ready', storage_key = key, sha256 = p_sha256, mime = 'image/webp', bytes = p_bytes, width = p_width, height = p_height,
    upload_token = NULL, expires_at = p_license_expires_at, version = gen_random_uuid(), updated_at = now_at
  WHERE a.id = asset.id;
  RETURN jsonb_build_object('status', 'ready', 'asset_id', asset.id);
END;
$$;
--> statement-breakpoint
-- Descarta un asset propio todavía en cuarentena (rechazo, derechos denegados o cancelación). Su objeto,
-- si llegó a subirse, queda huérfano y lo retira la purga.
CREATE FUNCTION "biblib"."cover_asset_discard"(p_asset_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'cover_asset_discard requiere una sesión' USING ERRCODE = '42501';
  END IF;
  DELETE FROM biblib.cover_assets AS a WHERE a.id = p_asset_id AND a.user_id = owner_id AND a.state = 'quarantine';
  RETURN FOUND;
END;
$$;
--> statement-breakpoint
-- Tras un restore administrativo, el servidor revalida bytes y derechos vigentes antes de volver a servir
-- un asset `restored`: lo promueve a `ready` o lo descarta (sus fichas vuelven a la URL o a la genérica).
CREATE FUNCTION "biblib"."cover_asset_revalidate"(p_asset_id uuid, p_accept boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'cover_asset_revalidate requiere una sesión' USING ERRCODE = '42501';
  END IF;
  IF p_accept THEN
    UPDATE biblib.cover_assets AS a SET state = 'ready', version = gen_random_uuid(), updated_at = clock_timestamp()
    WHERE a.id = p_asset_id AND a.user_id = owner_id AND a.state = 'restored';
    RETURN CASE WHEN FOUND THEN 'ready' ELSE 'not_found' END;
  END IF;
  UPDATE biblib.books AS b SET cover_asset_id = NULL, updated_at = clock_timestamp() WHERE b.user_id = owner_id AND b.cover_asset_id = p_asset_id;
  DELETE FROM biblib.cover_assets AS a WHERE a.id = p_asset_id AND a.user_id = owner_id AND a.state = 'restored';
  RETURN CASE WHEN FOUND THEN 'discarded' ELSE 'not_found' END;
END;
$$;
--> statement-breakpoint
-- Una ficha solo adjunta un asset propio utilizable y con licencia vigente. La FK con propietario ya
-- impide citar un asset ajeno; esta guarda impide citar uno en cuarentena, restaurado sin revisar o vencido.
CREATE FUNCTION "biblib"."guard_book_cover_asset"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.cover_asset_id IS NOT NULL AND NEW.cover_asset_id IS DISTINCT FROM OLD.cover_asset_id AND NOT EXISTS (
    SELECT 1 FROM biblib.cover_assets AS a WHERE a.id = NEW.cover_asset_id AND a.user_id = NEW.user_id AND a.state = 'ready'
      AND (a.expires_at IS NULL OR a.expires_at > clock_timestamp())) THEN
    RAISE EXCEPTION 'La portada privada no está disponible' USING ERRCODE = 'BA001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."guard_book_cover_asset"() FROM PUBLIC, authenticated;
--> statement-breakpoint
CREATE TRIGGER "books_guard_cover_asset" BEFORE UPDATE ON "biblib"."books"
FOR EACH ROW EXECUTE FUNCTION "biblib"."guard_book_cover_asset"();
--> statement-breakpoint
-- Candidatos de purga (servidor o script administrativo; `p_owner` nulo = todas las cuentas):
-- cuarentenas vencidas, assets con licencia vencida y assets sin fichas ni versiones anteriores que los
-- citen durante el periodo de gracia, más objetos del bucket sin asset registrado (subidas interrumpidas).
-- Nunca devuelve un asset todavía citado por una ficha o una versión anterior, salvo licencia vencida.
CREATE FUNCTION "biblib"."cover_asset_purge_candidates"(p_owner uuid, p_limit integer, p_grace_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  max_rows integer := greatest(1, least(coalesce(p_limit, 100), 1000));
  grace interval := greatest(0, coalesce(p_grace_seconds, 86400)) * interval '1 second';
  assets jsonb;
  objects jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'owner', c.user_id, 'key', c.storage_key, 'reason', c.reason)), '[]'::jsonb) INTO assets
  FROM (
    SELECT a.id, a.user_id, a.storage_key,
      CASE WHEN a.state = 'quarantine' THEN 'quarantine' WHEN a.expires_at IS NOT NULL AND a.expires_at <= now_at THEN 'license' ELSE 'unreferenced' END AS reason
    FROM biblib.cover_assets AS a
    WHERE (p_owner IS NULL OR a.user_id = p_owner) AND (
      (a.state = 'quarantine' AND a.expires_at <= now_at)
      OR (a.state <> 'quarantine' AND a.expires_at IS NOT NULL AND a.expires_at <= now_at)
      OR (a.state <> 'quarantine' AND a.updated_at <= now_at - grace
        AND NOT EXISTS (SELECT 1 FROM biblib.books AS b WHERE b.user_id = a.user_id AND b.cover_asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM biblib.library_snapshot_chunks AS sc CROSS JOIN LATERAL jsonb_array_elements(sc.payload) AS item
          WHERE sc.user_id = a.user_id AND sc.kind = 'books' AND item->>'cover_asset_id' = a.id::text)))
    ORDER BY a.updated_at
    LIMIT max_rows
  ) AS c;
  SELECT coalesce(jsonb_agg(jsonb_build_object('owner', split_part(o.name, '/', 1), 'key', o.name)), '[]'::jsonb) INTO objects
  FROM (
    SELECT so.name FROM storage.objects AS so
    WHERE so.bucket_id = 'biblib-covers' AND (p_owner IS NULL OR so.name LIKE p_owner::text || '/%')
      AND so.created_at <= now_at - interval '10 minutes'
      AND NOT EXISTS (SELECT 1 FROM biblib.cover_assets AS a WHERE a.storage_key = so.name AND a.state <> 'quarantine')
      AND NOT EXISTS (SELECT 1 FROM biblib.cover_assets AS a WHERE a.state = 'quarantine' AND a.expires_at > now_at
        AND a.storage_key IS NULL AND so.name = a.user_id::text || '/' || a.id::text || '/' || coalesce(a.upload_token, '') || '.webp')
    ORDER BY so.created_at
    LIMIT max_rows
  ) AS o;
  RETURN jsonb_build_object('assets', assets, 'objects', objects);
END;
$$;
--> statement-breakpoint
-- Retira las filas candidatas que siguen siéndolo bajo bloqueo (una ficha pudo adjuntarlas entretanto).
-- Una licencia vencida se desadjunta antes de borrar. Devuelve las claves de objeto que quedan huérfanas.
CREATE FUNCTION "biblib"."cover_asset_purge_confirm"(p_owner uuid, p_ids uuid[], p_grace_seconds integer) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  grace interval := greatest(0, coalesce(p_grace_seconds, 86400)) * interval '1 second';
  keys text[];
BEGIN
  PERFORM 1 FROM biblib.cover_assets AS a WHERE a.id = ANY(p_ids) AND (p_owner IS NULL OR a.user_id = p_owner) FOR UPDATE;
  UPDATE biblib.books AS b SET cover_asset_id = NULL, updated_at = now_at
  FROM biblib.cover_assets AS a
  WHERE b.user_id = a.user_id AND b.cover_asset_id = a.id AND a.id = ANY(p_ids) AND (p_owner IS NULL OR a.user_id = p_owner)
    AND a.state <> 'quarantine' AND a.expires_at IS NOT NULL AND a.expires_at <= now_at;
  WITH removed AS (
    DELETE FROM biblib.cover_assets AS a
    WHERE a.id = ANY(p_ids) AND (p_owner IS NULL OR a.user_id = p_owner) AND (
      (a.state = 'quarantine' AND a.expires_at <= now_at)
      OR (a.state <> 'quarantine' AND a.expires_at IS NOT NULL AND a.expires_at <= now_at)
      OR (a.state <> 'quarantine' AND a.updated_at <= now_at - grace
        AND NOT EXISTS (SELECT 1 FROM biblib.books AS b WHERE b.user_id = a.user_id AND b.cover_asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM biblib.library_snapshot_chunks AS sc CROSS JOIN LATERAL jsonb_array_elements(sc.payload) AS item
          WHERE sc.user_id = a.user_id AND sc.kind = 'books' AND item->>'cover_asset_id' = a.id::text)))
    RETURNING a.storage_key
  )
  SELECT coalesce(array_agg(r.storage_key) FILTER (WHERE r.storage_key IS NOT NULL), '{}'::text[]) INTO keys FROM removed AS r;
  RETURN keys;
END;
$$;
--> statement-breakpoint
-- Tras un restore administrativo, los assets restaurados no se sirven hasta que el servidor revalide
-- bytes y derechos vigentes, y las subidas que no terminaron antes del respaldo ya no se pueden
-- completar. Script del operador, sin EXECUTE para roles de cliente.
CREATE FUNCTION "biblib"."cover_asset_quarantine_restored"() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE biblib.cover_assets AS a SET state = 'restored', updated_at = clock_timestamp() WHERE a.state = 'ready';
  GET DIAGNOSTICS affected = ROW_COUNT;
  UPDATE biblib.cover_assets AS a SET upload_token = NULL, expires_at = least(a.expires_at, clock_timestamp()), updated_at = clock_timestamp()
  WHERE a.state = 'quarantine';
  RETURN affected;
END;
$$;
--> statement-breakpoint
-- Bucket privado y políticas de storage.objects. Una sola definición: la ejecuta esta migración y la
-- repite db:restore:local, porque el restore recrea el esquema biblib y con él caen estas políticas.
CREATE FUNCTION "biblib"."cover_storage_install"() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('biblib-covers', 'biblib-covers', false, 5242880, ARRAY['image/webp'])
  ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  DROP POLICY IF EXISTS "biblib_covers_select_own" ON storage.objects;
  DROP POLICY IF EXISTS "biblib_covers_insert_own" ON storage.objects;
  DROP POLICY IF EXISTS "biblib_covers_delete_own" ON storage.objects;
  CREATE POLICY "biblib_covers_select_own" ON storage.objects AS PERMISSIVE FOR SELECT TO authenticated
    USING (bucket_id = 'biblib-covers' AND biblib.cover_object_access(name, 'select'));
  CREATE POLICY "biblib_covers_insert_own" ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'biblib-covers' AND biblib.cover_object_access(name, 'insert'));
  CREATE POLICY "biblib_covers_delete_own" ON storage.objects AS PERMISSIVE FOR DELETE TO authenticated
    USING (bucket_id = 'biblib-covers' AND biblib.cover_object_access(name, 'delete'));
END;
$$;
--> statement-breakpoint
SELECT "biblib"."cover_storage_install"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."cover_storage_install"() FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."cover_asset_quota"(uuid) FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."cover_asset_purge_candidates"(uuid, integer, integer) FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."cover_asset_purge_confirm"(uuid, uuid[], integer) FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."cover_asset_quarantine_restored"() FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."cover_object_access"(text, text), "biblib"."cover_asset_request"(uuid, uuid, text, text, text, text, text), "biblib"."cover_asset_begin_upload"(), "biblib"."cover_asset_authorize"(uuid, text), "biblib"."cover_asset_register"(uuid, text, text, integer, integer, integer, timestamptz), "biblib"."cover_asset_discard"(uuid), "biblib"."cover_asset_revalidate"(uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "biblib"."cover_object_access"(text, text), "biblib"."cover_asset_request"(uuid, uuid, text, text, text, text, text), "biblib"."cover_asset_begin_upload"(), "biblib"."cover_asset_authorize"(uuid, text), "biblib"."cover_asset_register"(uuid, text, text, integer, integer, integer, timestamptz), "biblib"."cover_asset_discard"(uuid), "biblib"."cover_asset_revalidate"(uuid, boolean) TO authenticated;
--> statement-breakpoint
-- El dueño solo lee sus assets; toda escritura pasa por las funciones anteriores.
REVOKE ALL ON "biblib"."cover_assets" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON "biblib"."cover_assets" TO authenticated;

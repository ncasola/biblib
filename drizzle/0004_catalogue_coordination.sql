CREATE SEQUENCE "biblib"."catalogue_fence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "biblib"."catalogue_cache" (
	"provider" text NOT NULL,
	"policy_version" text NOT NULL,
	"credential_scope" text NOT NULL,
	"schema_version" integer NOT NULL,
	"operation" text NOT NULL,
	"canonical_key" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fence" bigint NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "catalogue_cache_pkey" PRIMARY KEY("provider","policy_version","credential_scope","schema_version","operation","canonical_key"),
	CONSTRAINT "catalogue_cache_provider_check" CHECK ("biblib"."catalogue_cache"."provider" in ('open-library', 'bne', 'google-books')),
	CONSTRAINT "catalogue_cache_operation_check" CHECK ("biblib"."catalogue_cache"."operation" in ('lookupISBN', 'resolveEditions', 'getCover')),
	CONSTRAINT "catalogue_cache_status_check" CHECK ("biblib"."catalogue_cache"."status" in ('found', 'notFound')),
	CONSTRAINT "catalogue_cache_key_check" CHECK (length("biblib"."catalogue_cache"."canonical_key") between 1 and 200),
	CONSTRAINT "catalogue_cache_payload_check" CHECK (jsonb_typeof("biblib"."catalogue_cache"."payload") = 'array'),
	CONSTRAINT "catalogue_cache_expiry_check" CHECK ("biblib"."catalogue_cache"."expires_at" > "biblib"."catalogue_cache"."fetched_at")
);
--> statement-breakpoint
ALTER TABLE "biblib"."catalogue_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."catalogue_inflight" (
	"provider" text NOT NULL,
	"policy_version" text NOT NULL,
	"credential_scope" text NOT NULL,
	"schema_version" integer NOT NULL,
	"operation" text NOT NULL,
	"canonical_key" text NOT NULL,
	"fence" bigint NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalogue_inflight_pkey" PRIMARY KEY("provider","policy_version","credential_scope","schema_version","operation","canonical_key"),
	CONSTRAINT "catalogue_inflight_provider_check" CHECK ("biblib"."catalogue_inflight"."provider" in ('open-library', 'bne', 'google-books'))
);
--> statement-breakpoint
ALTER TABLE "biblib"."catalogue_inflight" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."catalogue_private_cache" (
	"owner_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"policy_version" text NOT NULL,
	"credential_scope" text NOT NULL,
	"schema_version" integer NOT NULL,
	"operation" text NOT NULL,
	"key_hmac" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "catalogue_private_cache_pkey" PRIMARY KEY("owner_id","provider","policy_version","credential_scope","schema_version","operation","key_hmac"),
	CONSTRAINT "catalogue_private_cache_provider_check" CHECK ("biblib"."catalogue_private_cache"."provider" in ('open-library', 'bne', 'google-books')),
	CONSTRAINT "catalogue_private_cache_operation_check" CHECK ("biblib"."catalogue_private_cache"."operation" in ('searchTitleAuthor')),
	CONSTRAINT "catalogue_private_cache_status_check" CHECK ("biblib"."catalogue_private_cache"."status" in ('found', 'notFound')),
	CONSTRAINT "catalogue_private_cache_key_check" CHECK ("biblib"."catalogue_private_cache"."key_hmac" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "catalogue_private_cache_payload_check" CHECK (jsonb_typeof("biblib"."catalogue_private_cache"."payload") = 'array'),
	CONSTRAINT "catalogue_private_cache_expiry_check" CHECK ("biblib"."catalogue_private_cache"."expires_at" > "biblib"."catalogue_private_cache"."fetched_at")
);
--> statement-breakpoint
ALTER TABLE "biblib"."catalogue_private_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."catalogue_quota_buckets" (
	"provider" text NOT NULL,
	"credential_scope" text NOT NULL,
	"interval_ms" integer NOT NULL,
	"next_slot_at" timestamp with time zone NOT NULL,
	"cooldown_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalogue_quota_buckets_pkey" PRIMARY KEY("provider","credential_scope"),
	CONSTRAINT "catalogue_quota_buckets_provider_check" CHECK ("biblib"."catalogue_quota_buckets"."provider" in ('open-library', 'bne', 'google-books')),
	CONSTRAINT "catalogue_quota_buckets_interval_check" CHECK ("biblib"."catalogue_quota_buckets"."interval_ms" between 1 and 3600000)
);
--> statement-breakpoint
ALTER TABLE "biblib"."catalogue_quota_buckets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."catalogue_quota_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"credential_scope" text NOT NULL,
	"owner_id" uuid,
	"purpose" text NOT NULL,
	"fence" bigint NOT NULL,
	"slot_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalogue_quota_reservations_purpose_check" CHECK ("biblib"."catalogue_quota_reservations"."purpose" in ('interactive', 'batch')),
	CONSTRAINT "catalogue_quota_reservations_expiry_check" CHECK ("biblib"."catalogue_quota_reservations"."expires_at" > "biblib"."catalogue_quota_reservations"."slot_at")
);
--> statement-breakpoint
ALTER TABLE "biblib"."catalogue_quota_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "biblib"."catalogue_private_cache" ADD CONSTRAINT "catalogue_private_cache_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."catalogue_quota_reservations" ADD CONSTRAINT "catalogue_quota_reservations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."catalogue_quota_reservations" ADD CONSTRAINT "catalogue_quota_reservations_bucket_fk" FOREIGN KEY ("provider","credential_scope") REFERENCES "biblib"."catalogue_quota_buckets"("provider","credential_scope") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalogue_cache_expires_at_idx" ON "biblib"."catalogue_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "catalogue_inflight_fence_unique" ON "biblib"."catalogue_inflight" USING btree ("fence");--> statement-breakpoint
CREATE INDEX "catalogue_private_cache_expires_at_idx" ON "biblib"."catalogue_private_cache" USING btree ("owner_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "catalogue_quota_reservations_fence_unique" ON "biblib"."catalogue_quota_reservations" USING btree ("fence");--> statement-breakpoint
CREATE INDEX "catalogue_quota_reservations_active_idx" ON "biblib"."catalogue_quota_reservations" USING btree ("provider","credential_scope","owner_id","purpose") WHERE "biblib"."catalogue_quota_reservations"."released_at" is null;--> statement-breakpoint
CREATE INDEX "catalogue_quota_reservations_expires_at_idx" ON "biblib"."catalogue_quota_reservations" USING btree ("provider","credential_scope","expires_at");--> statement-breakpoint
CREATE POLICY "catalogue_private_cache_select_own" ON "biblib"."catalogue_private_cache" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid() = "biblib"."catalogue_private_cache"."owner_id"));--> statement-breakpoint
CREATE POLICY "catalogue_private_cache_delete_own" ON "biblib"."catalogue_private_cache" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid() = "biblib"."catalogue_private_cache"."owner_id"));--> statement-breakpoint
-- U-DAT-05: coordinación del catálogo entre instancias. Ninguna función concede EXECUTE a
-- anon/authenticated: las llama el servidor con su conexión propia, nunca la Data API ni una
-- sesión de cliente. Usan la hora de la base (clock_timestamp) para no depender del reloj de cada
-- proceso, y ninguna duerme: devuelven cuánto esperar y el llamador espera fuera de la transacción.
-- Reserva atómica de una petición externa por proveedor/ámbito, con tope por dueño y propósito.
CREATE FUNCTION "biblib"."catalogue_reserve"(p_provider text, p_scope text, p_owner uuid, p_purpose text, p_interval_ms integer, p_horizon_ms integer, p_owner_cap integer, p_lease_ms integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  bucket biblib.catalogue_quota_buckets%ROWTYPE;
  slot timestamptz;
  active integer;
  granted bigint;
  reservation uuid;
BEGIN
  IF p_purpose IS NULL OR p_purpose NOT IN ('interactive', 'batch') OR p_interval_ms NOT BETWEEN 1 AND 3600000
    OR p_horizon_ms NOT BETWEEN 0 AND 60000 OR p_owner_cap NOT BETWEEN 1 AND 100 OR p_lease_ms NOT BETWEEN 1 AND 600000 THEN
    RAISE EXCEPTION 'Parámetros de cuota no válidos' USING ERRCODE = '22023';
  END IF;
  INSERT INTO biblib.catalogue_quota_buckets (provider, credential_scope, interval_ms, next_slot_at)
  VALUES (p_provider, p_scope, p_interval_ms, now_at) ON CONFLICT (provider, credential_scope) DO NOTHING;
  SELECT * INTO bucket FROM biblib.catalogue_quota_buckets AS b
  WHERE b.provider = p_provider AND b.credential_scope = p_scope FOR UPDATE;
  -- Limpieza acotada de reservas antiguas; nunca toca las vigentes.
  DELETE FROM biblib.catalogue_quota_reservations AS r WHERE r.ctid IN (
    SELECT old.ctid FROM biblib.catalogue_quota_reservations AS old
    WHERE old.provider = p_provider AND old.credential_scope = p_scope AND old.expires_at < now_at - interval '1 hour' LIMIT 100);
  IF bucket.cooldown_until > now_at THEN
    RETURN jsonb_build_object('state', 'cooldown', 'retryMs', ceil(extract(epoch FROM bucket.cooldown_until - now_at) * 1000)::bigint);
  END IF;
  SELECT count(*) INTO active FROM biblib.catalogue_quota_reservations AS r
  WHERE r.provider = p_provider AND r.credential_scope = p_scope AND r.owner_id IS NOT DISTINCT FROM p_owner
    AND r.purpose = p_purpose AND r.released_at IS NULL AND r.expires_at > now_at;
  IF active >= p_owner_cap THEN
    RETURN jsonb_build_object('state', 'busy', 'retryMs', p_interval_ms);
  END IF;
  slot := greatest(now_at, bucket.next_slot_at);
  IF slot > now_at + p_horizon_ms * interval '1 millisecond' THEN
    RETURN jsonb_build_object('state', 'wait', 'retryMs', greatest(1, ceil(extract(epoch FROM slot - now_at) * 1000) - p_horizon_ms)::bigint);
  END IF;
  granted := nextval('biblib.catalogue_fence_seq');
  UPDATE biblib.catalogue_quota_buckets AS b
  SET interval_ms = p_interval_ms, next_slot_at = slot + p_interval_ms * interval '1 millisecond', updated_at = now_at
  WHERE b.provider = p_provider AND b.credential_scope = p_scope;
  INSERT INTO biblib.catalogue_quota_reservations (provider, credential_scope, owner_id, purpose, fence, slot_at, expires_at)
  VALUES (p_provider, p_scope, p_owner, p_purpose, granted, slot, slot + p_lease_ms * interval '1 millisecond')
  RETURNING id INTO reservation;
  RETURN jsonb_build_object('state', 'reserved', 'reservationId', reservation, 'fence', granted::text, 'waitMs', ceil(extract(epoch FROM slot - now_at) * 1000)::bigint);
END;
$$;
--> statement-breakpoint
-- Libera una reserva con su testigo y, tras un 429, aplica el cooldown compartido (máximo 1 h).
CREATE FUNCTION "biblib"."catalogue_release"(p_reservation uuid, p_fence bigint, p_retry_after_ms integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  released biblib.catalogue_quota_reservations%ROWTYPE;
  cooldown timestamptz;
BEGIN
  UPDATE biblib.catalogue_quota_reservations AS r SET released_at = now_at
  WHERE r.id = p_reservation AND r.fence = p_fence AND r.released_at IS NULL
  RETURNING * INTO released;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF p_retry_after_ms > 0 THEN
    cooldown := now_at + least(p_retry_after_ms, 3600000) * interval '1 millisecond';
    UPDATE biblib.catalogue_quota_buckets AS b
    SET cooldown_until = greatest(b.cooldown_until, cooldown), next_slot_at = greatest(b.next_slot_at, cooldown), updated_at = now_at
    WHERE b.provider = released.provider AND b.credential_scope = released.credential_scope;
  END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
-- Lectura de caché compartida y concesión en vuelo de una clave. Devuelve hit, pending o leased.
CREATE FUNCTION "biblib"."catalogue_begin"(p_provider text, p_policy_version text, p_scope text, p_schema_version integer, p_operation text, p_key text, p_use_cache boolean, p_lease_ms integer, p_discard_fence bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  entry biblib.catalogue_cache%ROWTYPE;
  leased bigint;
BEGIN
  IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1 AND 600000 THEN
    RAISE EXCEPTION 'Concesión no válida' USING ERRCODE = '22023';
  END IF;
  -- Una entrada ilegible se retira solo si sigue siendo la misma que se leyó.
  IF p_discard_fence IS NOT NULL THEN
    DELETE FROM biblib.catalogue_cache AS c
    WHERE c.provider = p_provider AND c.policy_version = p_policy_version AND c.credential_scope = p_scope
      AND c.schema_version = p_schema_version AND c.operation = p_operation AND c.canonical_key = p_key AND c.fence = p_discard_fence;
  END IF;
  IF p_use_cache THEN
    SELECT * INTO entry FROM biblib.catalogue_cache AS c
    WHERE c.provider = p_provider AND c.policy_version = p_policy_version AND c.credential_scope = p_scope
      AND c.schema_version = p_schema_version AND c.operation = p_operation AND c.canonical_key = p_key;
    IF FOUND AND entry.expires_at > now_at THEN
      RETURN jsonb_build_object('state', 'hit', 'status', entry.status, 'payload', entry.payload, 'fence', entry.fence::text, 'fetchedAt', entry.fetched_at, 'expiresAt', entry.expires_at);
    END IF;
  END IF;
  -- Solo se toma la concesión si no existe o si la anterior caducó (trabajador muerto o tardío).
  INSERT INTO biblib.catalogue_inflight AS f (provider, policy_version, credential_scope, schema_version, operation, canonical_key, fence, lease_expires_at)
  VALUES (p_provider, p_policy_version, p_scope, p_schema_version, p_operation, p_key, nextval('biblib.catalogue_fence_seq'), now_at + p_lease_ms * interval '1 millisecond')
  ON CONFLICT (provider, policy_version, credential_scope, schema_version, operation, canonical_key) DO UPDATE
    SET fence = excluded.fence, lease_expires_at = excluded.lease_expires_at, created_at = now_at
    WHERE f.lease_expires_at <= now_at
  RETURNING f.fence INTO leased;
  IF leased IS NULL THEN
    RETURN jsonb_build_object('state', 'pending');
  END IF;
  -- Otro trabajador pudo publicar entre la lectura y la concesión.
  IF p_use_cache THEN
    SELECT * INTO entry FROM biblib.catalogue_cache AS c
    WHERE c.provider = p_provider AND c.policy_version = p_policy_version AND c.credential_scope = p_scope
      AND c.schema_version = p_schema_version AND c.operation = p_operation AND c.canonical_key = p_key;
    IF FOUND AND entry.expires_at > now_at THEN
      DELETE FROM biblib.catalogue_inflight AS f
      WHERE f.provider = p_provider AND f.policy_version = p_policy_version AND f.credential_scope = p_scope
        AND f.schema_version = p_schema_version AND f.operation = p_operation AND f.canonical_key = p_key AND f.fence = leased;
      RETURN jsonb_build_object('state', 'hit', 'status', entry.status, 'payload', entry.payload, 'fence', entry.fence::text, 'fetchedAt', entry.fetched_at, 'expiresAt', entry.expires_at);
    END IF;
  END IF;
  RETURN jsonb_build_object('state', 'leased', 'fence', leased::text);
END;
$$;
--> statement-breakpoint
-- Cierra la concesión y publica el resultado solo si el testigo sigue vigente (fencing). Una
-- caída (unavailable/rateLimited) nunca se guarda como ausencia.
CREATE FUNCTION "biblib"."catalogue_complete"(p_provider text, p_policy_version text, p_scope text, p_schema_version integer, p_operation text, p_key text, p_fence bigint, p_status text, p_payload jsonb, p_provenance jsonb, p_ttl_ms integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
BEGIN
  DELETE FROM biblib.catalogue_inflight AS f
  WHERE f.provider = p_provider AND f.policy_version = p_policy_version AND f.credential_scope = p_scope
    AND f.schema_version = p_schema_version AND f.operation = p_operation AND f.canonical_key = p_key
    AND f.fence = p_fence AND f.lease_expires_at > now_at;
  IF NOT FOUND THEN
    DELETE FROM biblib.catalogue_inflight AS f
    WHERE f.provider = p_provider AND f.policy_version = p_policy_version AND f.credential_scope = p_scope
      AND f.schema_version = p_schema_version AND f.operation = p_operation AND f.canonical_key = p_key AND f.fence = p_fence;
    RETURN 'stale';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('found', 'notFound') OR p_ttl_ms IS NULL OR p_ttl_ms <= 0 OR p_payload IS NULL THEN
    RETURN 'released';
  END IF;
  INSERT INTO biblib.catalogue_cache AS c (provider, policy_version, credential_scope, schema_version, operation, canonical_key, status, payload, provenance, fence, fetched_at, expires_at)
  VALUES (p_provider, p_policy_version, p_scope, p_schema_version, p_operation, p_key, p_status, p_payload, coalesce(p_provenance, '{}'::jsonb), p_fence, now_at, now_at + least(p_ttl_ms, 86400000) * interval '1 millisecond')
  ON CONFLICT (provider, policy_version, credential_scope, schema_version, operation, canonical_key) DO UPDATE
    SET status = excluded.status, payload = excluded.payload, provenance = excluded.provenance, fence = excluded.fence,
      fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
    WHERE c.fence < excluded.fence;
  IF FOUND THEN
    RETURN 'published';
  END IF;
  RETURN 'stale';
END;
$$;
--> statement-breakpoint
-- Caché privada de búsquedas de texto: solo devuelve filas vigentes del dueño indicado por el servidor.
CREATE FUNCTION "biblib"."catalogue_private_get"(p_owner uuid, p_provider text, p_policy_version text, p_scope text, p_schema_version integer, p_operation text, p_key_hmac text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  entry biblib.catalogue_private_cache%ROWTYPE;
BEGIN
  SELECT * INTO entry FROM biblib.catalogue_private_cache AS c
  WHERE c.owner_id = p_owner AND c.provider = p_provider AND c.policy_version = p_policy_version AND c.credential_scope = p_scope
    AND c.schema_version = p_schema_version AND c.operation = p_operation AND c.key_hmac = p_key_hmac AND c.expires_at > clock_timestamp();
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object('status', entry.status, 'payload', entry.payload, 'fetchedAt', entry.fetched_at, 'expiresAt', entry.expires_at);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "biblib"."catalogue_private_put"(p_owner uuid, p_provider text, p_policy_version text, p_scope text, p_schema_version integer, p_operation text, p_key_hmac text, p_status text, p_payload jsonb, p_ttl_ms integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
BEGIN
  IF p_owner IS NULL OR p_status IS NULL OR p_status NOT IN ('found', 'notFound') OR p_ttl_ms IS NULL OR p_ttl_ms <= 0 OR p_payload IS NULL THEN
    RETURN false;
  END IF;
  DELETE FROM biblib.catalogue_private_cache AS c WHERE c.ctid IN (
    SELECT old.ctid FROM biblib.catalogue_private_cache AS old WHERE old.owner_id = p_owner AND old.expires_at <= now_at LIMIT 100);
  INSERT INTO biblib.catalogue_private_cache AS c (owner_id, provider, policy_version, credential_scope, schema_version, operation, key_hmac, status, payload, fetched_at, expires_at)
  VALUES (p_owner, p_provider, p_policy_version, p_scope, p_schema_version, p_operation, p_key_hmac, p_status, p_payload, now_at, now_at + least(p_ttl_ms, 86400000) * interval '1 millisecond')
  ON CONFLICT (owner_id, provider, policy_version, credential_scope, schema_version, operation, key_hmac) DO UPDATE
    SET status = excluded.status, payload = excluded.payload, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
    WHERE c.fetched_at <= excluded.fetched_at;
  RETURN true;
END;
$$;
--> statement-breakpoint
-- Retira las entradas de versiones de política o schema incompatibles (todas si la política está
-- revocada) y las caducadas, para que no se reutilicen.
CREATE FUNCTION "biblib"."catalogue_invalidate"(p_provider text, p_policy_version text, p_schema_version integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  removed integer;
  counted integer;
BEGIN
  DELETE FROM biblib.catalogue_cache AS c WHERE c.provider = p_provider
    AND (p_policy_version IS NULL OR c.policy_version <> p_policy_version OR c.schema_version <> p_schema_version OR c.expires_at <= now_at);
  GET DIAGNOSTICS removed = ROW_COUNT;
  DELETE FROM biblib.catalogue_private_cache AS c WHERE c.provider = p_provider
    AND (p_policy_version IS NULL OR c.policy_version <> p_policy_version OR c.schema_version <> p_schema_version OR c.expires_at <= now_at);
  GET DIAGNOSTICS counted = ROW_COUNT;
  removed := removed + counted;
  DELETE FROM biblib.catalogue_inflight AS f WHERE f.provider = p_provider AND f.lease_expires_at <= now_at
    AND (p_policy_version IS NULL OR f.policy_version <> p_policy_version OR f.schema_version <> p_schema_version);
  RETURN removed;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."catalogue_reserve"(text, text, uuid, text, integer, integer, integer, integer) FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."catalogue_release"(uuid, bigint, integer) FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."catalogue_begin"(text, text, text, integer, text, text, boolean, integer, bigint) FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."catalogue_complete"(text, text, text, integer, text, text, bigint, text, jsonb, jsonb, integer) FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."catalogue_private_get"(uuid, text, text, text, integer, text, text) FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."catalogue_private_put"(uuid, text, text, text, integer, text, text, text, jsonb, integer) FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."catalogue_invalidate"(text, text, integer) FROM PUBLIC, authenticated;
--> statement-breakpoint
-- Caché compartida, consultas en vuelo y cuotas: sin privilegios para roles de cliente. El dueño
-- solo puede leer y purgar su caché privada (RLS por auth.uid()).
REVOKE ALL ON "biblib"."catalogue_cache", "biblib"."catalogue_inflight", "biblib"."catalogue_quota_buckets", "biblib"."catalogue_quota_reservations", "biblib"."catalogue_private_cache" FROM PUBLIC, authenticated;
--> statement-breakpoint
REVOKE ALL ON SEQUENCE "biblib"."catalogue_fence_seq" FROM PUBLIC, authenticated;
--> statement-breakpoint
GRANT SELECT, DELETE ON "biblib"."catalogue_private_cache" TO authenticated;

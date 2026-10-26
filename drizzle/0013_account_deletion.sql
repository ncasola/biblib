-- U-OPS-03 · 0013. Eliminación de cuenta y retención. Una solicitud idempotente marca la cuenta en eliminación
-- (`account_lifecycle.state = 'deleting'`); desde ese momento ninguna escritura de cliente pasa: el bloqueo de
-- colección, las políticas RESTRICTIVE de todas las tablas con escritura de cliente y las de Storage exigen cuenta
-- activa mediante funciones SECURITY DEFINER que el cliente no puede usar para reactivarla. El worker administrativo
-- (fuera de Next) borra por pasos reintentables con lease y fencing, borra la identidad de Auth al final y deja una
-- marca técnica mínima (`account_deletions`, sin FK a auth.users ni contenido bibliográfico) que filtra la cuenta al
-- restaurar un respaldo anterior.
CREATE TABLE "biblib"."account_deletions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"step" text DEFAULT 'sessions' NOT NULL,
	"operation_key" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"fencing_number" bigint DEFAULT 0 NOT NULL,
	"error_code" text,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_deletions_state_check" CHECK ("biblib"."account_deletions"."state" in ('pending', 'running', 'waiting_retry', 'failed', 'completed')),
	CONSTRAINT "account_deletions_step_check" CHECK ("biblib"."account_deletions"."step" in ('sessions', 'storage', 'covers', 'snapshots', 'staging', 'jobs', 'views', 'previews', 'operations', 'private_cache', 'copies', 'editions', 'works', 'shelves', 'state', 'auth', 'verify', 'done')),
	CONSTRAINT "account_deletions_key_check" CHECK (length("biblib"."account_deletions"."operation_key") between 16 and 128),
	CONSTRAINT "account_deletions_error_check" CHECK ("biblib"."account_deletions"."error_code" is null or "biblib"."account_deletions"."error_code" ~ '^[A-Z_]{1,64}$'),
	CONSTRAINT "account_deletions_counts_check" CHECK (jsonb_typeof("biblib"."account_deletions"."counts") = 'object'),
	CONSTRAINT "account_deletions_attempts_check" CHECK ("biblib"."account_deletions"."attempts" >= 0 and "biblib"."account_deletions"."fencing_number" >= 0),
	CONSTRAINT "account_deletions_lease_check" CHECK ("biblib"."account_deletions"."state" <> 'running' or "biblib"."account_deletions"."lease_token" is not null),
	CONSTRAINT "account_deletions_completed_check" CHECK (("biblib"."account_deletions"."state" = 'completed') = ("biblib"."account_deletions"."completed_at" is not null and "biblib"."account_deletions"."purge_after" is not null and "biblib"."account_deletions"."step" = 'done'))
);
--> statement-breakpoint
ALTER TABLE "biblib"."account_deletions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "biblib"."account_lifecycle" DROP CONSTRAINT "account_lifecycle_state_check";--> statement-breakpoint
CREATE INDEX "account_deletions_due_idx" ON "biblib"."account_deletions" USING btree ("next_attempt_at") WHERE "biblib"."account_deletions"."state" in ('pending', 'running', 'waiting_retry');--> statement-breakpoint
CREATE INDEX "account_deletions_purge_idx" ON "biblib"."account_deletions" USING btree ("purge_after") WHERE "biblib"."account_deletions"."state" = 'completed';--> statement-breakpoint
ALTER TABLE "biblib"."account_lifecycle" ADD CONSTRAINT "account_lifecycle_state_check" CHECK ("biblib"."account_lifecycle"."state" in ('active', 'blocked', 'deleting'));--> statement-breakpoint
-- La marca y el estado de la eliminación no tienen privilegios de cliente: el dueño solo usa las dos funciones de abajo.
REVOKE ALL ON "biblib"."account_deletions" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
-- Guarda de escritura de las políticas RESTRICTIVE y de las funciones con escritura de cliente. Lanza BD001 si la
-- cuenta de la sesión está en eliminación o ya tiene marca de supresión (también tras borrar su identidad, mientras un
-- JWT antiguo no caduque). Solo lee: el cliente no tiene ninguna vía para cambiar ese estado.
CREATE FUNCTION "biblib"."account_write_allowed"() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
BEGIN
  IF owner_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM biblib.account_lifecycle AS lifecycle WHERE lifecycle.user_id = owner_id AND lifecycle.state = 'deleting')
    OR EXISTS (SELECT 1 FROM biblib.account_deletions AS deletion WHERE deletion.user_id = owner_id)) THEN
    RAISE EXCEPTION 'La cuenta se está eliminando y no admite cambios' USING ERRCODE = 'BD001';
  END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
-- Guarda de cuenta activa de los trabajos y las portadas (0005): una cuenta con solicitud o marca de supresión
-- tampoco está activa, aunque un restore haya perdido su fila de ciclo de vida.
CREATE OR REPLACE FUNCTION "biblib"."account_is_active"(p_owner uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM auth.users AS account WHERE account.id = p_owner)
    AND NOT EXISTS (SELECT 1 FROM biblib.account_lifecycle AS lifecycle WHERE lifecycle.user_id = p_owner AND lifecycle.state <> 'active')
    AND NOT EXISTS (SELECT 1 FROM biblib.account_deletions AS deletion WHERE deletion.user_id = p_owner);
END;
$$;
--> statement-breakpoint
-- Transición administrativa del ciclo de vida (0005). Una cuenta en eliminación no se reactiva ni se bloquea por esta
-- vía: su estado solo lo cambia la supresión, que termina borrando la identidad.
CREATE OR REPLACE FUNCTION "biblib"."account_set_state"(p_owner uuid, p_state text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  affected integer := 0;
BEGIN
  IF p_state NOT IN ('active', 'blocked') THEN
    RAISE EXCEPTION 'Estado de cuenta no válido' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM biblib.account_deletions AS deletion WHERE deletion.user_id = p_owner) THEN
    RAISE EXCEPTION 'La cuenta está en eliminación: su estado lo gestiona la supresión' USING ERRCODE = 'BD002';
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
-- Bloqueo de colección (0003): toda escritura de dominio lo toma antes de escribir. Una cuenta en eliminación no
-- escribe: se comprueba antes de crear la fila de estado y otra vez tras obtener el bloqueo (la solicitud de
-- eliminación toma el mismo, así que una escritura que esperaba ya ve la cuenta en eliminación).
CREATE OR REPLACE FUNCTION "biblib"."lock_library"() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  current_revision uuid;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'lock_library requiere una sesión' USING ERRCODE = '42501';
  END IF;
  PERFORM biblib.account_write_allowed();
  INSERT INTO biblib.library_state (user_id) VALUES (owner_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT state.revision INTO current_revision FROM biblib.library_state AS state WHERE state.user_id = owner_id FOR UPDATE;
  PERFORM biblib.account_write_allowed();
  RETURN current_revision;
END;
$$;
--> statement-breakpoint
-- Guarda de storage.objects (0009): además de subir, retirar un objeto exige cuenta activa. Leer los propios no cambia.
CREATE OR REPLACE FUNCTION "biblib"."cover_object_access"(p_name text, p_action text) RETURNS boolean
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
    RETURN p_action = 'delete' AND biblib.account_is_active(owner_id);
  END IF;
  IF p_action = 'select' THEN
    RETURN true;
  END IF;
  IF p_action = 'delete' THEN
    RETURN biblib.account_is_active(owner_id) AND (asset.state = 'quarantine' OR asset.storage_key IS DISTINCT FROM p_name);
  END IF;
  RETURN asset.state = 'quarantine' AND asset.expires_at > clock_timestamp() AND asset.upload_token IS NOT NULL
    AND parts[3] = asset.upload_token || '.webp' AND biblib.account_is_active(owner_id)
    AND (asset.job_id IS NULL OR EXISTS (SELECT 1 FROM biblib.library_jobs AS j WHERE j.id = asset.job_id AND j.user_id = owner_id
      AND j.state = 'running' AND j.lease_until > clock_timestamp() AND j.fencing_number::text = asset.upload_token));
END;
$$;
--> statement-breakpoint
-- Descartar un asset en cuarentena (0009) o revalidar uno restaurado (0011) escriben como SECURITY DEFINER: también
-- exigen cuenta activa.
CREATE OR REPLACE FUNCTION "biblib"."cover_asset_discard"(p_asset_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'cover_asset_discard requiere una sesión' USING ERRCODE = '42501';
  END IF;
  PERFORM biblib.account_write_allowed();
  DELETE FROM biblib.cover_assets AS a WHERE a.id = p_asset_id AND a.user_id = owner_id AND a.state = 'quarantine';
  RETURN FOUND;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "biblib"."cover_asset_revalidate"(p_asset_id uuid, p_accept boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'cover_asset_revalidate requiere una sesión' USING ERRCODE = '42501';
  END IF;
  PERFORM biblib.account_write_allowed();
  IF p_accept THEN
    UPDATE biblib.cover_assets AS a SET state = 'ready', version = gen_random_uuid(), updated_at = clock_timestamp()
    WHERE a.id = p_asset_id AND a.user_id = owner_id AND a.state = 'restored';
    RETURN CASE WHEN FOUND THEN 'ready' ELSE 'not_found' END;
  END IF;
  UPDATE biblib.editions AS e SET cover_asset_id = NULL, updated_at = clock_timestamp() WHERE e.user_id = owner_id AND e.cover_asset_id = p_asset_id;
  DELETE FROM biblib.cover_assets AS a WHERE a.id = p_asset_id AND a.user_id = owner_id AND a.state = 'restored';
  RETURN CASE WHEN FOUND THEN 'discarded' ELSE 'not_found' END;
END;
$$;
--> statement-breakpoint
-- Solicitud del dueño de la sesión (nunca un ID del cliente). Toma el bloqueo de colección: espera a la escritura en
-- curso de la cuenta, y las posteriores ya ven la cuenta en eliminación. Repetirla, con cualquier clave, devuelve el
-- mismo estado. Al crearla expira los trabajos no terminados (ningún trabajador antiguo vuelve a escribir).
CREATE FUNCTION "biblib"."account_deletion_request"(p_operation_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  now_at timestamptz := clock_timestamp();
  created boolean;
  expired integer := 0;
  deletion biblib.account_deletions%ROWTYPE;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'account_deletion_request requiere una sesión' USING ERRCODE = '42501';
  END IF;
  IF p_operation_key IS NULL OR length(p_operation_key) NOT BETWEEN 16 AND 128 THEN
    RAISE EXCEPTION 'Clave de operación no válida' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users AS account WHERE account.id = owner_id) THEN
    RAISE EXCEPTION 'La cuenta de la sesión no existe' USING ERRCODE = '42501';
  END IF;
  INSERT INTO biblib.library_state (user_id) VALUES (owner_id) ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM biblib.library_state AS state WHERE state.user_id = owner_id FOR UPDATE;
  INSERT INTO biblib.account_deletions (user_id, operation_key, requested_at, next_attempt_at, updated_at)
  VALUES (owner_id, p_operation_key, now_at, now_at, now_at) ON CONFLICT (user_id) DO NOTHING;
  created := FOUND;
  IF created THEN
    INSERT INTO biblib.account_lifecycle AS lifecycle (user_id, state, changed_at) VALUES (owner_id, 'deleting', now_at)
    ON CONFLICT (user_id) DO UPDATE SET state = 'deleting', changed_at = excluded.changed_at;
    UPDATE biblib.library_jobs AS j
    SET state = 'expired', error_code = 'ACCOUNT_INACTIVE', lease_token = NULL, lease_until = NULL, version = gen_random_uuid(),
      finished_at = now_at, expires_at = now_at + interval '30 days', updated_at = now_at
    WHERE j.user_id = owner_id AND j.state IN ('queued', 'running', 'waiting_retry', 'needs_review', 'paused');
    GET DIAGNOSTICS expired = ROW_COUNT;
  END IF;
  SELECT * INTO deletion FROM biblib.account_deletions AS d WHERE d.user_id = owner_id;
  RETURN jsonb_build_object('state', deletion.state, 'step', deletion.step, 'requestedAt', deletion.requested_at, 'created', created, 'expiredJobs', expired);
END;
$$;
--> statement-breakpoint
-- Estado para el dueño mientras su identidad exista: sin código de error, contadores ni datos de otras cuentas.
CREATE FUNCTION "biblib"."account_deletion_status"() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  deletion biblib.account_deletions%ROWTYPE;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'account_deletion_status requiere una sesión' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO deletion FROM biblib.account_deletions AS d WHERE d.user_id = owner_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM auth.users AS account WHERE account.id = owner_id) THEN
    RETURN jsonb_build_object('state', 'none');
  END IF;
  RETURN jsonb_build_object('state', deletion.state, 'step', deletion.step, 'requestedAt', deletion.requested_at);
END;
$$;
--> statement-breakpoint
-- Tablas que retira cada paso de base de datos, en orden (hijas antes que padres). La columna de dueño es `owner_id`
-- donde existe y si no `user_id`. Una tabla privada nueva se añade aquí, en el inventario de lib/account-deletion y en
-- docs/retencion.md; tests/db/account-deletion.sql falla si alguna tabla con dueño queda fuera.
CREATE FUNCTION "biblib"."account_deletion_step_tables"(p_step text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  RETURN CASE p_step
    WHEN 'covers' THEN ARRAY['cover_assets']
    WHEN 'snapshots' THEN ARRAY['library_snapshot_chunks', 'library_snapshots']
    WHEN 'staging' THEN ARRAY['import_session_rows', 'import_session_chunks', 'import_session_parts', 'import_sessions']
    WHEN 'jobs' THEN ARRAY['library_job_items', 'library_jobs']
    WHEN 'views' THEN ARRAY['saved_book_views']
    WHEN 'previews' THEN ARRAY['import_previews']
    WHEN 'operations' THEN ARRAY['library_operations']
    WHEN 'private_cache' THEN ARRAY['catalogue_private_cache', 'catalogue_quota_reservations']
    WHEN 'copies' THEN ARRAY['copies']
    WHEN 'editions' THEN ARRAY['editions']
    WHEN 'works' THEN ARRAY['works']
    WHEN 'shelves' THEN ARRAY['shelves']
    WHEN 'state' THEN ARRAY['library_state', 'model_migration_report', 'books_legacy']
    ELSE NULL
  END;
END;
$$;
--> statement-breakpoint
-- Filas que quedan de un paso (y, en `covers`, ediciones que aún citan una portada privada).
CREATE FUNCTION "biblib"."account_deletion_step_remaining"(p_owner uuid, p_step text) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  item text;
  owner_column text;
  found integer;
  total integer := 0;
BEGIN
  IF p_step = 'covers' THEN
    SELECT count(*)::integer INTO total FROM biblib.editions AS e WHERE e.user_id = p_owner AND e.cover_asset_id IS NOT NULL;
  END IF;
  FOREACH item IN ARRAY coalesce(biblib.account_deletion_step_tables(p_step), '{}'::text[]) LOOP
    SELECT CASE WHEN bool_or(a.attname = 'owner_id') THEN 'owner_id' ELSE 'user_id' END INTO owner_column
    FROM pg_attribute AS a WHERE a.attrelid = format('biblib.%I', item)::regclass AND a.attname IN ('owner_id', 'user_id') AND NOT a.attisdropped;
    EXECUTE format('SELECT count(*)::integer FROM biblib.%I WHERE %I = $1', item, owner_column) INTO found USING p_owner;
    total := total + found;
  END LOOP;
  RETURN total;
END;
$$;
--> statement-breakpoint
-- Testigo del worker: la fila bloqueada con su lease vigente y su token. Un worker vencido o reemplazado recibe BD003
-- y no toca nada más.
CREATE FUNCTION "biblib"."account_deletion_lease"(p_owner uuid, p_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  deletion biblib.account_deletions%ROWTYPE;
BEGIN
  SELECT * INTO deletion FROM biblib.account_deletions AS d WHERE d.user_id = p_owner FOR UPDATE;
  IF NOT FOUND OR deletion.state <> 'running' OR deletion.lease_token IS DISTINCT FROM p_token OR deletion.lease_until IS NULL OR deletion.lease_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'El worker de eliminación perdió su lease' USING ERRCODE = 'BD003';
  END IF;
  RETURN jsonb_build_object('step', deletion.step, 'attempts', deletion.attempts, 'fence', deletion.fencing_number);
END;
$$;
--> statement-breakpoint
-- Renueva el lease vigente del testigo (pasos largos, p. ej. muchos objetos de Storage). Falso si ya no lo tiene.
CREATE FUNCTION "biblib"."account_deletion_renew"(p_owner uuid, p_token uuid, p_lease_ms integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
BEGIN
  UPDATE biblib.account_deletions AS d SET lease_until = now_at + greatest(1000, least(coalesce(p_lease_ms, 60000), 600000)) * interval '1 millisecond', updated_at = now_at
  WHERE d.user_id = p_owner AND d.state = 'running' AND d.lease_token = p_token AND d.lease_until > now_at;
  RETURN FOUND;
END;
$$;
--> statement-breakpoint
-- Reclama una eliminación vencida (o la de `p_owner`): pendiente, a la espera de reintento o en ejecución con lease
-- vencido. Cada reclamación recibe un testigo nuevo y un número de fencing mayor.
CREATE FUNCTION "biblib"."account_deletion_claim"(p_owner uuid, p_lease_ms integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  lease interval := greatest(1000, least(coalesce(p_lease_ms, 60000), 600000)) * interval '1 millisecond';
  candidate uuid;
  deletion biblib.account_deletions%ROWTYPE;
BEGIN
  SELECT d.user_id INTO candidate FROM biblib.account_deletions AS d
  WHERE (p_owner IS NULL OR d.user_id = p_owner)
    AND ((d.state IN ('pending', 'waiting_retry') AND d.next_attempt_at <= now_at) OR (d.state = 'running' AND (d.lease_until IS NULL OR d.lease_until <= now_at)))
  ORDER BY d.next_attempt_at, d.user_id
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF candidate IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE biblib.account_deletions AS d SET state = 'running', lease_token = gen_random_uuid(), lease_until = now_at + lease,
    fencing_number = d.fencing_number + 1, attempts = d.attempts + 1, updated_at = now_at
  WHERE d.user_id = candidate RETURNING * INTO deletion;
  RETURN jsonb_build_object('userId', deletion.user_id, 'step', deletion.step, 'token', deletion.lease_token, 'fence', deletion.fencing_number,
    'attempts', deletion.attempts, 'requestedAt', deletion.requested_at);
END;
$$;
--> statement-breakpoint
-- Un lote de un paso de base de datos, bajo el lease: hasta `p_limit` filas de la primera tabla del paso que aún tiene
-- filas del dueño. Devuelve cuántas retiró (0 = paso vacío). Solo borra: nunca inserta ni actualiza datos del dueño,
-- salvo soltar la portada privada de sus ediciones antes de retirar los assets.
CREATE FUNCTION "biblib"."account_deletion_purge"(p_owner uuid, p_token uuid, p_step text, p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  max_rows integer := greatest(1, least(coalesce(p_limit, 500), 5000));
  lease_row jsonb := biblib.account_deletion_lease(p_owner, p_token);
  tables text[] := biblib.account_deletion_step_tables(p_step);
  item text;
  owner_column text;
  removed integer;
BEGIN
  IF lease_row->>'step' IS DISTINCT FROM p_step OR tables IS NULL THEN
    RAISE EXCEPTION 'Paso de eliminación no válido para este lote' USING ERRCODE = 'BD004';
  END IF;
  IF p_step = 'covers' THEN
    UPDATE biblib.editions AS e SET cover_asset_id = NULL, updated_at = clock_timestamp()
    WHERE e.user_id = p_owner AND e.id = ANY(ARRAY(SELECT x.id FROM biblib.editions AS x WHERE x.user_id = p_owner AND x.cover_asset_id IS NOT NULL LIMIT max_rows));
    GET DIAGNOSTICS removed = ROW_COUNT;
    IF removed > 0 THEN
      RETURN removed;
    END IF;
  END IF;
  FOREACH item IN ARRAY tables LOOP
    SELECT CASE WHEN bool_or(a.attname = 'owner_id') THEN 'owner_id' ELSE 'user_id' END INTO owner_column
    FROM pg_attribute AS a WHERE a.attrelid = format('biblib.%I', item)::regclass AND a.attname IN ('owner_id', 'user_id') AND NOT a.attisdropped;
    EXECUTE format('DELETE FROM biblib.%I AS t WHERE t.ctid = ANY(ARRAY(SELECT s.ctid FROM biblib.%I AS s WHERE s.%I = $1 LIMIT $2))', item, item, owner_column)
      USING p_owner, max_rows;
    GET DIAGNOSTICS removed = ROW_COUNT;
    IF removed > 0 THEN
      RETURN removed;
    END IF;
  END LOOP;
  RETURN 0;
END;
$$;
--> statement-breakpoint
-- Objetos de Storage del dueño en cualquier bucket: por prefijo `<dueño>/` o por propietario registrado.
CREATE FUNCTION "biblib"."account_deletion_objects"(p_owner uuid, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  found jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('bucket', o.bucket_id, 'name', o.name) ORDER BY o.bucket_id, o.name), '[]'::jsonb) INTO found
  FROM (SELECT so.bucket_id, so.name FROM storage.objects AS so WHERE so.name LIKE p_owner::text || '/%' OR so.owner = p_owner
    ORDER BY so.bucket_id, so.name LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))) AS o;
  RETURN found;
END;
$$;
--> statement-breakpoint
-- Lo que queda de una cuenta: filas de cualquier tabla de biblib con dueño (descubiertas en el catálogo, no por lista),
-- objetos de Storage y su identidad. La marca de supresión no cuenta.
CREATE FUNCTION "biblib"."account_residue"(p_owner uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  item record;
  found integer;
  total integer := 0;
  tables jsonb := '{}'::jsonb;
  objects integer;
BEGIN
  FOR item IN SELECT c.relname AS name, a.attname AS owner_column FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_attribute AS a ON a.attrelid = c.oid
    WHERE n.nspname = 'biblib' AND c.relkind = 'r' AND c.relname <> 'account_deletions' AND a.attname IN ('user_id', 'owner_id') AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*)::integer FROM biblib.%I WHERE %I = $1', item.name, item.owner_column) INTO found USING p_owner;
    IF found > 0 THEN
      tables := tables || jsonb_build_object(item.name, found);
      total := total + found;
    END IF;
  END LOOP;
  SELECT count(*)::integer INTO objects FROM storage.objects AS so WHERE so.name LIKE p_owner::text || '/%' OR so.owner = p_owner;
  RETURN jsonb_build_object('rows', total, 'tables', tables, 'objects', objects, 'account', EXISTS (SELECT 1 FROM auth.users AS account WHERE account.id = p_owner));
END;
$$;
--> statement-breakpoint
-- Cierra el paso en curso y pasa al siguiente si de verdad está vacío: Storage sin objetos, tablas del paso sin filas
-- e identidad ya borrada. Si no, BD004: el worker reintenta el paso y nunca afirma haber terminado.
CREATE FUNCTION "biblib"."account_deletion_advance"(p_owner uuid, p_token uuid, p_step text, p_counts jsonb, p_lease_ms integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  steps text[] := ARRAY['sessions', 'storage', 'covers', 'snapshots', 'staging', 'jobs', 'views', 'previews', 'operations', 'private_cache', 'copies', 'editions', 'works', 'shelves', 'state', 'auth', 'verify'];
  now_at timestamptz := clock_timestamp();
  lease interval := greatest(1000, least(coalesce(p_lease_ms, 60000), 600000)) * interval '1 millisecond';
  lease_row jsonb := biblib.account_deletion_lease(p_owner, p_token);
  step_index integer := array_position(steps, p_step);
  pending boolean;
BEGIN
  IF lease_row->>'step' IS DISTINCT FROM p_step OR step_index IS NULL OR p_step = 'verify' THEN
    RAISE EXCEPTION 'Paso de eliminación no válido' USING ERRCODE = 'BD004';
  END IF;
  pending := CASE p_step
    WHEN 'sessions' THEN false
    WHEN 'storage' THEN EXISTS (SELECT 1 FROM storage.objects AS so WHERE so.name LIKE p_owner::text || '/%' OR so.owner = p_owner)
    WHEN 'auth' THEN EXISTS (SELECT 1 FROM auth.users AS account WHERE account.id = p_owner)
    ELSE biblib.account_deletion_step_remaining(p_owner, p_step) > 0
  END;
  IF pending THEN
    RAISE EXCEPTION 'El paso % de la eliminación aún tiene recursos', p_step USING ERRCODE = 'BD004';
  END IF;
  UPDATE biblib.account_deletions AS d SET step = steps[step_index + 1], attempts = 0, error_code = NULL,
    counts = d.counts || CASE WHEN jsonb_typeof(p_counts) = 'object' THEN p_counts ELSE '{}'::jsonb END, lease_until = now_at + lease, updated_at = now_at
  WHERE d.user_id = p_owner;
  RETURN steps[step_index + 1];
END;
$$;
--> statement-breakpoint
-- Fallo de un paso: queda visible para la operación (código técnico) y se reintenta con espera; tras `p_max_attempts`
-- intentos seguidos pasa a `failed` y solo se reanuda con account_deletion_retry. Un worker que ya no tiene el testigo
-- no cambia nada.
CREATE FUNCTION "biblib"."account_deletion_fail"(p_owner uuid, p_token uuid, p_error_code text, p_retry_ms integer, p_max_attempts integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  deletion biblib.account_deletions%ROWTYPE;
  next_state text;
BEGIN
  SELECT * INTO deletion FROM biblib.account_deletions AS d WHERE d.user_id = p_owner FOR UPDATE;
  IF NOT FOUND OR deletion.state <> 'running' OR deletion.lease_token IS DISTINCT FROM p_token THEN
    RETURN 'lease_lost';
  END IF;
  next_state := CASE WHEN deletion.attempts >= greatest(1, coalesce(p_max_attempts, 5)) THEN 'failed' ELSE 'waiting_retry' END;
  UPDATE biblib.account_deletions AS d SET state = next_state,
    error_code = CASE WHEN p_error_code ~ '^[A-Z_]{1,64}$' THEN p_error_code ELSE 'UNEXPECTED' END,
    lease_token = NULL, lease_until = NULL,
    next_attempt_at = now_at + greatest(0, least(coalesce(p_retry_ms, 60000), 86400000)) * interval '1 millisecond', updated_at = now_at
  WHERE d.user_id = p_owner;
  RETURN next_state;
END;
$$;
--> statement-breakpoint
-- Final: sin filas con dueño en biblib, sin objetos de Storage y sin identidad. Solo entonces queda la marca mínima
-- (`completed`, sin contadores) con su plazo de conservación.
CREATE FUNCTION "biblib"."account_deletion_complete"(p_owner uuid, p_token uuid, p_mark_days integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  lease_row jsonb := biblib.account_deletion_lease(p_owner, p_token);
  residue jsonb;
BEGIN
  IF lease_row->>'step' IS DISTINCT FROM 'verify' THEN
    RAISE EXCEPTION 'La eliminación no ha llegado a la verificación' USING ERRCODE = 'BD004';
  END IF;
  residue := biblib.account_residue(p_owner);
  IF (residue->>'rows')::integer > 0 OR (residue->>'objects')::integer > 0 OR (residue->>'account')::boolean THEN
    RAISE EXCEPTION 'Quedan recursos de la cuenta' USING ERRCODE = 'BD004';
  END IF;
  UPDATE biblib.account_deletions AS d SET state = 'completed', step = 'done', completed_at = now_at,
    purge_after = now_at + make_interval(days => greatest(1, least(coalesce(p_mark_days, 90), 3650))),
    counts = '{}'::jsonb, error_code = NULL, lease_token = NULL, lease_until = NULL, attempts = 0, updated_at = now_at
  WHERE d.user_id = p_owner;
  RETURN jsonb_build_object('completedAt', now_at);
END;
$$;
--> statement-breakpoint
-- Reintento desde operación de las eliminaciones fallidas (de una cuenta o de todas). Devuelve cuántas reanuda.
CREATE FUNCTION "biblib"."account_deletion_retry"(p_owner uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE biblib.account_deletions AS d SET state = 'pending', attempts = 0, next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE d.state = 'failed' AND (p_owner IS NULL OR d.user_id = p_owner);
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
--> statement-breakpoint
-- Marca de supresión aplicada al restaurar un respaldo anterior: la cuenta ya se borró en el destino antes de abrirlo.
-- Crea la marca terminada o termina una solicitud restaurada a medias. Idempotente.
CREATE FUNCTION "biblib"."account_deletion_suppress"(p_owner uuid, p_requested_at timestamptz, p_mark_days integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  mark_days interval := make_interval(days => greatest(1, least(coalesce(p_mark_days, 90), 3650)));
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users AS account WHERE account.id = p_owner) THEN
    RAISE EXCEPTION 'La identidad suprimida sigue en el destino' USING ERRCODE = 'BD004';
  END IF;
  INSERT INTO biblib.account_deletions AS d (user_id, state, step, operation_key, requested_at, completed_at, purge_after, updated_at)
  VALUES (p_owner, 'completed', 'done', 'restore-suppression', coalesce(p_requested_at, now_at), now_at, now_at + mark_days, now_at)
  ON CONFLICT (user_id) DO UPDATE SET state = 'completed', step = 'done', completed_at = coalesce(d.completed_at, now_at),
    purge_after = greatest(coalesce(d.purge_after, now_at + mark_days), now_at + mark_days), counts = '{}'::jsonb, error_code = NULL,
    lease_token = NULL, lease_until = NULL, attempts = 0, updated_at = now_at;
  RETURN true;
END;
$$;
--> statement-breakpoint
-- Retira las marcas terminadas cuyo plazo venció (mantenimiento periódico). Devuelve cuántas.
CREATE FUNCTION "biblib"."account_deletion_purge_marks"(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM biblib.account_deletions AS d WHERE d.user_id = ANY(ARRAY(SELECT m.user_id FROM biblib.account_deletions AS m
    WHERE m.state = 'completed' AND m.purge_after <= clock_timestamp() ORDER BY m.purge_after LIMIT greatest(1, least(coalesce(p_limit, 500), 5000))));
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."account_write_allowed"(), "biblib"."account_deletion_request"(text), "biblib"."account_deletion_status"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "biblib"."account_write_allowed"(), "biblib"."account_deletion_request"(text), "biblib"."account_deletion_status"() TO authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."account_deletion_step_tables"(text), "biblib"."account_deletion_step_remaining"(uuid, text), "biblib"."account_deletion_lease"(uuid, uuid),
  "biblib"."account_deletion_renew"(uuid, uuid, integer), "biblib"."account_deletion_claim"(uuid, integer), "biblib"."account_deletion_purge"(uuid, uuid, text, integer), "biblib"."account_deletion_objects"(uuid, integer),
  "biblib"."account_residue"(uuid), "biblib"."account_deletion_advance"(uuid, uuid, text, jsonb, integer), "biblib"."account_deletion_fail"(uuid, uuid, text, integer, integer),
  "biblib"."account_deletion_complete"(uuid, uuid, integer), "biblib"."account_deletion_retry"(uuid), "biblib"."account_deletion_suppress"(uuid, timestamptz, integer),
  "biblib"."account_deletion_purge_marks"(integer) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE POLICY "catalogue_private_cache_delete_active" ON "biblib"."catalogue_private_cache" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "copies_insert_active" ON "biblib"."copies" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "copies_update_active" ON "biblib"."copies" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "copies_delete_active" ON "biblib"."copies" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "editions_insert_active" ON "biblib"."editions" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "editions_update_active" ON "biblib"."editions" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "editions_delete_active" ON "biblib"."editions" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "import_previews_insert_active" ON "biblib"."import_previews" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "import_previews_delete_active" ON "biblib"."import_previews" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "import_session_chunks_insert_active" ON "biblib"."import_session_chunks" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "import_session_chunks_delete_active" ON "biblib"."import_session_chunks" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "import_session_parts_insert_active" ON "biblib"."import_session_parts" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "import_session_parts_update_active" ON "biblib"."import_session_parts" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "import_session_parts_delete_active" ON "biblib"."import_session_parts" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "import_session_rows_insert_active" ON "biblib"."import_session_rows" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "import_session_rows_delete_active" ON "biblib"."import_session_rows" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "import_sessions_insert_active" ON "biblib"."import_sessions" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "import_sessions_update_active" ON "biblib"."import_sessions" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "import_sessions_delete_active" ON "biblib"."import_sessions" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "library_operations_insert_active" ON "biblib"."library_operations" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "saved_book_views_insert_active" ON "biblib"."saved_book_views" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "saved_book_views_update_active" ON "biblib"."saved_book_views" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "saved_book_views_delete_active" ON "biblib"."saved_book_views" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "shelves_insert_active" ON "biblib"."shelves" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "shelves_update_active" ON "biblib"."shelves" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "shelves_delete_active" ON "biblib"."shelves" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "works_insert_active" ON "biblib"."works" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "works_update_active" ON "biblib"."works" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "works_delete_active" ON "biblib"."works" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));

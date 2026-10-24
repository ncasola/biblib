CREATE TABLE "biblib"."import_session_chunks" (
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"part_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_session_chunks_pkey" PRIMARY KEY("session_id","part_id","ordinal"),
	CONSTRAINT "import_session_chunks_ordinal_check" CHECK ("biblib"."import_session_chunks"."ordinal" >= 0 and "biblib"."import_session_chunks"."ordinal" < 32),
	CONSTRAINT "import_session_chunks_size_check" CHECK ("biblib"."import_session_chunks"."byte_length" >= 1 and "biblib"."import_session_chunks"."byte_length" <= 262144 and octet_length("biblib"."import_session_chunks"."bytes") = "biblib"."import_session_chunks"."byte_length"),
	CONSTRAINT "import_session_chunks_sha_check" CHECK ("biblib"."import_session_chunks"."sha256" = encode(sha256("biblib"."import_session_chunks"."bytes"), 'hex'))
);
--> statement-breakpoint
ALTER TABLE "biblib"."import_session_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."import_session_parts" (
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"part_id" text NOT NULL,
	"part_index" integer NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"total_chunks" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"format_version" integer,
	"exported_at" text,
	"counts" jsonb,
	CONSTRAINT "import_session_parts_pkey" PRIMARY KEY("session_id","part_id"),
	CONSTRAINT "import_session_parts_id_check" CHECK ("biblib"."import_session_parts"."part_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "import_session_parts_index_check" CHECK ("biblib"."import_session_parts"."part_index" >= 0 and "biblib"."import_session_parts"."part_index" < 50),
	CONSTRAINT "import_session_parts_size_check" CHECK ("biblib"."import_session_parts"."byte_length" >= 1 and "biblib"."import_session_parts"."byte_length" <= 8388608 and "biblib"."import_session_parts"."total_chunks" = ("biblib"."import_session_parts"."byte_length" + 262143) / 262144),
	CONSTRAINT "import_session_parts_sha_check" CHECK ("biblib"."import_session_parts"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "import_session_parts_state_check" CHECK ("biblib"."import_session_parts"."state" in ('pending', 'received', 'validated')),
	CONSTRAINT "import_session_parts_format_check" CHECK ("biblib"."import_session_parts"."format_version" is null or "biblib"."import_session_parts"."format_version" in (1, 2))
);
--> statement-breakpoint
ALTER TABLE "biblib"."import_session_parts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."import_session_rows" (
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"row_key" text NOT NULL,
	"part_index" integer NOT NULL,
	"position" integer NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "import_session_rows_pkey" PRIMARY KEY("session_id","kind","row_key"),
	CONSTRAINT "import_session_rows_kind_check" CHECK ("biblib"."import_session_rows"."kind" in ('book', 'shelf')),
	CONSTRAINT "import_session_rows_key_check" CHECK (length("biblib"."import_session_rows"."row_key") between 1 and 200),
	CONSTRAINT "import_session_rows_data_check" CHECK (jsonb_typeof("biblib"."import_session_rows"."data") = 'object')
);
--> statement-breakpoint
ALTER TABLE "biblib"."import_session_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."import_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"state" text DEFAULT 'receiving' NOT NULL,
	"source" text NOT NULL,
	"export_set_id" uuid NOT NULL,
	"payload_format_version" integer,
	"manifest" jsonb NOT NULL,
	"manifest_digest" text NOT NULL,
	"base_revision" uuid NOT NULL,
	"rules_version" integer NOT NULL,
	"part_count" integer NOT NULL,
	"total_bytes" bigint NOT NULL,
	"received_bytes" bigint DEFAULT 0 NOT NULL,
	"validated_parts" integer DEFAULT 0 NOT NULL,
	"totals" jsonb,
	"preview_id" uuid,
	"preview_revision" uuid,
	"preview_expires_at" timestamp with time zone,
	"plan" jsonb,
	"operation_id" uuid,
	"error_code" text,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_sessions_state_check" CHECK ("biblib"."import_sessions"."state" in ('receiving', 'validated', 'prepared', 'committed', 'rejected')),
	CONSTRAINT "import_sessions_source_check" CHECK ("biblib"."import_sessions"."source" in ('manifest', 'loose')),
	CONSTRAINT "import_sessions_format_check" CHECK ("biblib"."import_sessions"."payload_format_version" is null or "biblib"."import_sessions"."payload_format_version" in (1, 2)),
	CONSTRAINT "import_sessions_digest_check" CHECK ("biblib"."import_sessions"."manifest_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "import_sessions_parts_check" CHECK ("biblib"."import_sessions"."part_count" >= 1 and "biblib"."import_sessions"."part_count" <= 50 and "biblib"."import_sessions"."validated_parts" >= 0 and "biblib"."import_sessions"."validated_parts" <= "biblib"."import_sessions"."part_count"),
	CONSTRAINT "import_sessions_bytes_check" CHECK ("biblib"."import_sessions"."total_bytes" >= 1 and "biblib"."import_sessions"."total_bytes" <= 83886080 and "biblib"."import_sessions"."received_bytes" >= 0 and "biblib"."import_sessions"."received_bytes" <= "biblib"."import_sessions"."total_bytes"),
	CONSTRAINT "import_sessions_preview_check" CHECK (("biblib"."import_sessions"."preview_id" is null) = ("biblib"."import_sessions"."preview_revision" is null) and ("biblib"."import_sessions"."preview_id" is null) = ("biblib"."import_sessions"."preview_expires_at" is null) and ("biblib"."import_sessions"."preview_id" is null) = ("biblib"."import_sessions"."plan" is null)),
	CONSTRAINT "import_sessions_prepared_check" CHECK ("biblib"."import_sessions"."state" not in ('prepared', 'committed') or "biblib"."import_sessions"."preview_id" is not null),
	CONSTRAINT "import_sessions_committed_check" CHECK (("biblib"."import_sessions"."state" = 'committed') = ("biblib"."import_sessions"."operation_id" is not null)),
	CONSTRAINT "import_sessions_expiry_check" CHECK ("biblib"."import_sessions"."expires_at" > "biblib"."import_sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "biblib"."import_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "biblib"."library_operations" DROP CONSTRAINT "library_operations_operation_check";--> statement-breakpoint
-- Las FK compuestas con propietario necesitan antes los índices únicos (user_id, …) de su destino.
CREATE UNIQUE INDEX "import_session_parts_index_unique" ON "biblib"."import_session_parts" USING btree ("session_id","part_index");--> statement-breakpoint
CREATE UNIQUE INDEX "import_session_parts_owner_unique" ON "biblib"."import_session_parts" USING btree ("user_id","session_id","part_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_sessions_user_id_id_unique" ON "biblib"."import_sessions" USING btree ("user_id","id");--> statement-breakpoint
ALTER TABLE "biblib"."import_session_chunks" ADD CONSTRAINT "import_session_chunks_owner_part_fk" FOREIGN KEY ("user_id","session_id","part_id") REFERENCES "biblib"."import_session_parts"("user_id","session_id","part_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."import_session_parts" ADD CONSTRAINT "import_session_parts_owner_session_fk" FOREIGN KEY ("user_id","session_id") REFERENCES "biblib"."import_sessions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."import_session_rows" ADD CONSTRAINT "import_session_rows_owner_session_fk" FOREIGN KEY ("user_id","session_id") REFERENCES "biblib"."import_sessions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."import_sessions" ADD CONSTRAINT "import_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_session_rows_order_idx" ON "biblib"."import_session_rows" USING btree ("session_id","kind","part_index","position");--> statement-breakpoint
CREATE INDEX "import_sessions_user_created_idx" ON "biblib"."import_sessions" USING btree ("user_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "import_sessions_expires_at_idx" ON "biblib"."import_sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "biblib"."library_operations" ADD CONSTRAINT "library_operations_operation_check" CHECK ("biblib"."library_operations"."operation" in ('import.confirm', 'snapshot.restore', 'restore.commit'));--> statement-breakpoint
CREATE POLICY "import_session_chunks_select_own" ON "biblib"."import_session_chunks" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid() = "biblib"."import_session_chunks"."user_id"));--> statement-breakpoint
CREATE POLICY "import_session_chunks_insert_own" ON "biblib"."import_session_chunks" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid() = "biblib"."import_session_chunks"."user_id"));--> statement-breakpoint
CREATE POLICY "import_session_chunks_delete_own" ON "biblib"."import_session_chunks" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid() = "biblib"."import_session_chunks"."user_id"));--> statement-breakpoint
CREATE POLICY "import_session_parts_select_own" ON "biblib"."import_session_parts" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid() = "biblib"."import_session_parts"."user_id"));--> statement-breakpoint
CREATE POLICY "import_session_parts_insert_own" ON "biblib"."import_session_parts" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid() = "biblib"."import_session_parts"."user_id"));--> statement-breakpoint
CREATE POLICY "import_session_parts_update_own" ON "biblib"."import_session_parts" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid() = "biblib"."import_session_parts"."user_id")) WITH CHECK ((select auth.uid() = "biblib"."import_session_parts"."user_id"));--> statement-breakpoint
CREATE POLICY "import_session_parts_delete_own" ON "biblib"."import_session_parts" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid() = "biblib"."import_session_parts"."user_id"));--> statement-breakpoint
CREATE POLICY "import_session_rows_select_own" ON "biblib"."import_session_rows" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid() = "biblib"."import_session_rows"."user_id"));--> statement-breakpoint
CREATE POLICY "import_session_rows_insert_own" ON "biblib"."import_session_rows" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid() = "biblib"."import_session_rows"."user_id"));--> statement-breakpoint
CREATE POLICY "import_session_rows_delete_own" ON "biblib"."import_session_rows" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid() = "biblib"."import_session_rows"."user_id"));--> statement-breakpoint
CREATE POLICY "import_sessions_select_own" ON "biblib"."import_sessions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid() = "biblib"."import_sessions"."user_id"));--> statement-breakpoint
CREATE POLICY "import_sessions_insert_own" ON "biblib"."import_sessions" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid() = "biblib"."import_sessions"."user_id"));--> statement-breakpoint
CREATE POLICY "import_sessions_update_own" ON "biblib"."import_sessions" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid() = "biblib"."import_sessions"."user_id")) WITH CHECK ((select auth.uid() = "biblib"."import_sessions"."user_id"));--> statement-breakpoint
CREATE POLICY "import_sessions_delete_own" ON "biblib"."import_sessions" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid() = "biblib"."import_sessions"."user_id"));
--> statement-breakpoint
-- U-DAT-04: un trozo o una fila de staging nuevos solo entran en una sesión propia que sigue
-- recibiendo y no ha caducado. Una sesión validada, preparada o publicada ya no cambia de contenido:
-- su plan y su publicación se basan exactamente en lo que se comprobó. Se ejecuta con los permisos
-- de quien escribe (RLS del dueño).
CREATE FUNCTION "biblib"."guard_import_staging"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  current_state text;
BEGIN
  SELECT s.state INTO current_state FROM biblib.import_sessions AS s
  WHERE s.id = NEW.session_id AND s.user_id = NEW.user_id AND s.expires_at > now();
  IF current_state IS DISTINCT FROM 'receiving' THEN
    RAISE EXCEPTION 'La sesión de restauración no admite más datos' USING ERRCODE = 'BR001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."guard_import_staging"() FROM PUBLIC, authenticated;
--> statement-breakpoint
CREATE TRIGGER "import_session_chunks_guard" BEFORE INSERT ON "biblib"."import_session_chunks"
FOR EACH ROW EXECUTE FUNCTION "biblib"."guard_import_staging"();
--> statement-breakpoint
CREATE TRIGGER "import_session_rows_guard" BEFORE INSERT ON "biblib"."import_session_rows"
FOR EACH ROW EXECUTE FUNCTION "biblib"."guard_import_staging"();
--> statement-breakpoint
-- Retirada por lotes de las sesiones caducadas de todas las cuentas, con sus partes, trozos y filas
-- (mantenimiento F4/U-OPS-03). Nunca toca la colección activa.
CREATE FUNCTION "biblib"."import_session_purge_expired"(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM biblib.import_sessions AS s
  WHERE s.id IN (SELECT e.id FROM biblib.import_sessions AS e WHERE e.expires_at <= clock_timestamp() ORDER BY e.expires_at LIMIT greatest(1, least(coalesce(p_limit, 100), 1000)));
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."import_session_purge_expired"(integer) FROM PUBLIC, authenticated;
--> statement-breakpoint
-- El dueño gestiona sus sesiones y partes; los trozos y las filas validadas no se modifican nunca.
REVOKE ALL ON "biblib"."import_sessions", "biblib"."import_session_parts", "biblib"."import_session_chunks", "biblib"."import_session_rows" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "biblib"."import_sessions", "biblib"."import_session_parts" TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "biblib"."import_session_chunks", "biblib"."import_session_rows" TO authenticated;

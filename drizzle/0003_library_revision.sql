CREATE TABLE "biblib"."import_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" uuid NOT NULL,
	"input_digest" text NOT NULL,
	"mode" text NOT NULL,
	"rules_version" integer NOT NULL,
	"plan" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_previews_mode_check" CHECK ("biblib"."import_previews"."mode" in ('merge', 'replace')),
	CONSTRAINT "import_previews_digest_check" CHECK ("biblib"."import_previews"."input_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "biblib"."import_previews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."library_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_digest" text NOT NULL,
	"preview_id" uuid,
	"status" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_operations_operation_check" CHECK ("biblib"."library_operations"."operation" in ('import.confirm')),
	CONSTRAINT "library_operations_status_check" CHECK ("biblib"."library_operations"."status" in ('committed')),
	CONSTRAINT "library_operations_key_check" CHECK (length("biblib"."library_operations"."idempotency_key") between 16 and 128),
	CONSTRAINT "library_operations_digest_check" CHECK ("biblib"."library_operations"."input_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "biblib"."library_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."library_state" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"rotated_xact" "xid8",
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "biblib"."library_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "biblib"."import_previews" ADD CONSTRAINT "import_previews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."library_operations" ADD CONSTRAINT "library_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."library_state" ADD CONSTRAINT "library_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_previews_user_id_id_unique" ON "biblib"."import_previews" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "import_previews_user_id_expires_at_idx" ON "biblib"."import_previews" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "library_operations_key_unique" ON "biblib"."library_operations" USING btree ("user_id","operation","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "library_operations_preview_unique" ON "biblib"."library_operations" USING btree ("user_id","preview_id") WHERE "biblib"."library_operations"."preview_id" is not null;--> statement-breakpoint
CREATE POLICY "import_previews_select_own" ON "biblib"."import_previews" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid() = "biblib"."import_previews"."user_id"));--> statement-breakpoint
CREATE POLICY "import_previews_insert_own" ON "biblib"."import_previews" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid() = "biblib"."import_previews"."user_id"));--> statement-breakpoint
CREATE POLICY "import_previews_delete_own" ON "biblib"."import_previews" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid() = "biblib"."import_previews"."user_id"));--> statement-breakpoint
CREATE POLICY "library_operations_select_own" ON "biblib"."library_operations" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid() = "biblib"."library_operations"."user_id"));--> statement-breakpoint
CREATE POLICY "library_operations_insert_own" ON "biblib"."library_operations" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid() = "biblib"."library_operations"."user_id"));--> statement-breakpoint
CREATE POLICY "library_state_select_own" ON "biblib"."library_state" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid() = "biblib"."library_state"."user_id"));--> statement-breakpoint
-- U-DAT-01: protocolo único de revisión de la colección. La revisión solo cambia mediante estos
-- objetos; `authenticated` no tiene INSERT/UPDATE/DELETE sobre library_state.
-- Rota la revisión del propietario una vez por transacción en cualquier escritura de libros o
-- estanterías, incluida SQL directa autorizada. La fila se crea de forma perezosa si falta.
CREATE FUNCTION "biblib"."rotate_library_revision"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owners uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    owners := ARRAY[NEW.user_id];
  ELSIF TG_OP = 'DELETE' THEN
    owners := ARRAY[OLD.user_id];
  ELSE
    owners := ARRAY[NEW.user_id, OLD.user_id];
  END IF;
  INSERT INTO biblib.library_state AS state (user_id, rotated_xact)
  SELECT DISTINCT owner_id, pg_current_xact_id() FROM unnest(owners) AS owner_id
  WHERE EXISTS (SELECT 1 FROM auth.users AS account WHERE account.id = owner_id)
  ON CONFLICT (user_id) DO UPDATE
    SET revision = gen_random_uuid(), rotated_xact = excluded.rotated_xact, updated_at = now()
    WHERE state.rotated_xact IS DISTINCT FROM excluded.rotated_xact;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- Bloqueo de colección: se toma antes de escribir y devuelve la revisión vigente. El propietario
-- sale siempre de auth.uid(); no admite argumentos.
CREATE FUNCTION "biblib"."lock_library"() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  current_revision uuid;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'lock_library requiere una sesión' USING ERRCODE = '42501';
  END IF;
  INSERT INTO biblib.library_state (user_id) VALUES (owner_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT state.revision INTO current_revision FROM biblib.library_state AS state WHERE state.user_id = owner_id FOR UPDATE;
  RETURN current_revision;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."rotate_library_revision"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."lock_library"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "biblib"."lock_library"() TO authenticated;
--> statement-breakpoint
GRANT SELECT ON "biblib"."library_state" TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "biblib"."import_previews" TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON "biblib"."library_operations" TO authenticated;
--> statement-breakpoint
CREATE TRIGGER "books_rotate_library_revision" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."books"
FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_library_revision"();
--> statement-breakpoint
CREATE TRIGGER "shelves_rotate_library_revision" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."shelves"
FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_library_revision"();
--> statement-breakpoint
-- Backfill: una revisión para cada cuenta existente; las nuevas se crean al bloquear o escribir.
INSERT INTO "biblib"."library_state" ("user_id") SELECT "id" FROM "auth"."users" ON CONFLICT ("user_id") DO NOTHING;

-- U-EXP-02: preferencias privadas, independientes de library_state y sus triggers.
CREATE FUNCTION "biblib"."saved_view_filters_valid"(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object' THEN RETURN false; END IF;
  IF NOT (value ?& ARRAY['status','shelf','sort','view','pageSize'])
    OR (value - ARRAY['q','status','shelf','sort','view','pageSize']) <> '{}'::jsonb THEN RETURN false; END IF;
  IF value ? 'q' AND (jsonb_typeof(value->'q') <> 'string' OR length(value->>'q') > 500) THEN RETURN false; END IF;
  IF jsonb_typeof(value->'status') <> 'string' OR value->>'status' NOT IN ('all','read','reading','unread','to-read') THEN RETURN false; END IF;
  IF jsonb_typeof(value->'shelf') <> 'string' OR (value->>'shelf' <> 'all' AND value->>'shelf' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN RETURN false; END IF;
  IF jsonb_typeof(value->'sort') <> 'string' OR value->>'sort' NOT IN ('title','-title','author','-author','pages','-pages','date','-date','status','-status') THEN RETURN false; END IF;
  IF jsonb_typeof(value->'view') <> 'string' OR value->>'view' NOT IN ('table','grid') THEN RETURN false; END IF;
  IF jsonb_typeof(value->'pageSize') <> 'number' THEN RETURN false; END IF;
  RETURN (value->>'pageSize')::numeric BETWEEN 10 AND 100 AND trunc((value->>'pageSize')::numeric) = (value->>'pageSize')::numeric;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."saved_view_filters_valid"(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "biblib"."saved_view_filters_valid"(jsonb) TO authenticated;
--> statement-breakpoint
CREATE TABLE "biblib"."saved_book_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "saved_book_views_name_check" CHECK (length(btrim("biblib"."saved_book_views"."name")) between 1 and 80 and "biblib"."saved_book_views"."name" = btrim("biblib"."saved_book_views"."name")),
	CONSTRAINT "saved_book_views_filters_check" CHECK (biblib.saved_view_filters_valid("biblib"."saved_book_views"."filters"))
);
--> statement-breakpoint
ALTER TABLE "biblib"."saved_book_views" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "biblib"."saved_book_views" ADD CONSTRAINT "saved_book_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_book_views_user_name_unique" ON "biblib"."saved_book_views" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE INDEX "saved_book_views_user_updated_idx" ON "biblib"."saved_book_views" USING btree ("user_id","updated_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE POLICY "saved_book_views_select_own" ON "biblib"."saved_book_views" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid() = "biblib"."saved_book_views"."user_id"));--> statement-breakpoint
CREATE POLICY "saved_book_views_insert_own" ON "biblib"."saved_book_views" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid() = "biblib"."saved_book_views"."user_id"));--> statement-breakpoint
CREATE POLICY "saved_book_views_update_own" ON "biblib"."saved_book_views" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid() = "biblib"."saved_book_views"."user_id")) WITH CHECK ((select auth.uid() = "biblib"."saved_book_views"."user_id"));--> statement-breakpoint
CREATE POLICY "saved_book_views_delete_own" ON "biblib"."saved_book_views" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((select auth.uid() = "biblib"."saved_book_views"."user_id"));
--> statement-breakpoint
-- Serializa altas por cuenta (incluidas Data API y SQL) y evita transferir filas para eludir la cuota.
-- SECURITY DEFINER solo para contar todas las filas del dueño; no hay RPC ejecutable por clientes.
CREATE FUNCTION "biblib"."guard_saved_book_view"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('biblib.saved_views:' || NEW.user_id::text, 0));
    IF (SELECT count(*) FROM biblib.saved_book_views WHERE user_id = NEW.user_id) >= 100 THEN
      RAISE EXCEPTION 'Máximo de 100 vistas por cuenta' USING ERRCODE = 'BV001';
    END IF;
  ELSE
    IF NEW.user_id <> OLD.user_id OR NEW.id <> OLD.id THEN
      RAISE EXCEPTION 'No se puede transferir una vista' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := OLD.created_at;
    NEW.updated_at := clock_timestamp();
  END IF;
  NEW.version := gen_random_uuid();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."guard_saved_book_view"() FROM PUBLIC, authenticated;
--> statement-breakpoint
CREATE TRIGGER "saved_book_views_guard" BEFORE INSERT OR UPDATE ON "biblib"."saved_book_views"
FOR EACH ROW EXECUTE FUNCTION "biblib"."guard_saved_book_view"();
--> statement-breakpoint
REVOKE ALL ON "biblib"."saved_book_views" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "biblib"."saved_book_views" TO authenticated;

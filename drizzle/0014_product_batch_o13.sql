-- O13 · 0014. Lote único de schema de producto (D): etiquetas, notas y valoración por ejemplar (U-PRO-01), ubicaciones
-- físicas (U-PRO-03), series (U-PRO-05), perfil y avatar propio (U-EXP-06), evidencias, incidencias y decisiones de
-- revisión (U-DAT-07), y lo que el CSV persiste sobre el staging de 0008 (U-DAT-09). Todo privado por cuenta, con FK del
-- mismo dueño, RLS, escritura condicionada a cuenta activa (U-OPS-03) y su paso de eliminación de cuenta. Las imágenes
-- viven en el bucket privado `biblib-media` (`{user_id}/{kind}/{asset_id}`), con el patrón de portadas de U-DAT-10.
-- Contrato para las unidades: docs/spec-pendientes/contratos-o13.md.
--
-- Forma comparable de un nombre de etiqueta (mismo cálculo que `normalizeTagName` de lib/product/contracts.ts):
-- espacios colapsados, sin diacríticos salvo la tilde de la ñ y en minúsculas. Inmutable: la usa la columna generada
-- `tags.normalized_name`, que sostiene la unicidad por cuenta.
CREATE FUNCTION "biblib"."tag_normalize"(p_name text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
DECLARE
  value text := regexp_replace(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'), '^ | $', '', 'g');
BEGIN
  value := normalize(value, NFD);
  value := regexp_replace(value, '[nN]' || U&'\0303', U&'\E000', 'g');
  value := regexp_replace(value, '[' || U&'\0300' || '-' || U&'\036F' || ']', '', 'g');
  RETURN normalize(replace(lower(value), U&'\E000', 'ñ'), NFC);
END;
$$;
--> statement-breakpoint
CREATE TABLE "biblib"."bibliographic_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"edition_id" uuid,
	"copy_id" uuid,
	"source_kind" text NOT NULL,
	"source_ref" text,
	"source_url" text,
	"photo_asset_id" uuid,
	"observed_at" timestamp with time zone,
	"field_claims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" text NOT NULL,
	"origin" text DEFAULT 'review' NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bibliographic_evidence_subject_check" CHECK (num_nonnulls("biblib"."bibliographic_evidence"."edition_id", "biblib"."bibliographic_evidence"."copy_id") = 1),
	CONSTRAINT "bibliographic_evidence_source_kind_check" CHECK ("biblib"."bibliographic_evidence"."source_kind" in ('provider', 'photo', 'manual', 'import')),
	CONSTRAINT "bibliographic_evidence_confidence_check" CHECK ("biblib"."bibliographic_evidence"."confidence" in ('provisional', 'bibliographic_match', 'physically_checked')),
	CONSTRAINT "bibliographic_evidence_origin_check" CHECK ("biblib"."bibliographic_evidence"."origin" in ('backfill', 'review', 'import')),
	CONSTRAINT "bibliographic_evidence_physical_check" CHECK ("biblib"."bibliographic_evidence"."confidence" <> 'physically_checked' or "biblib"."bibliographic_evidence"."copy_id" is not null),
	CONSTRAINT "bibliographic_evidence_photo_check" CHECK ("biblib"."bibliographic_evidence"."photo_asset_id" is null or "biblib"."bibliographic_evidence"."source_kind" = 'photo'),
	CONSTRAINT "bibliographic_evidence_source_ref_check" CHECK ("biblib"."bibliographic_evidence"."source_ref" is null or "biblib"."bibliographic_evidence"."source_ref" ~ '^[A-Za-z0-9:._-]{1,200}$'),
	CONSTRAINT "bibliographic_evidence_source_url_check" CHECK ("biblib"."bibliographic_evidence"."source_url" is null or ("biblib"."bibliographic_evidence"."source_url" ~ '^https?://' and char_length("biblib"."bibliographic_evidence"."source_url") <= 2048)),
	CONSTRAINT "bibliographic_evidence_claims_check" CHECK (jsonb_typeof("biblib"."bibliographic_evidence"."field_claims") = 'object' and octet_length("biblib"."bibliographic_evidence"."field_claims"::text) <= 16384)
);
--> statement-breakpoint
ALTER TABLE "biblib"."bibliographic_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."copy_annotations" (
	"user_id" uuid NOT NULL,
	"copy_id" uuid NOT NULL,
	"notes" text,
	"rating" smallint,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_annotations_pkey" PRIMARY KEY("user_id","copy_id"),
	CONSTRAINT "copy_annotations_notes_check" CHECK ("biblib"."copy_annotations"."notes" is null or (char_length("biblib"."copy_annotations"."notes") >= 1 and char_length("biblib"."copy_annotations"."notes") <= 4000)),
	CONSTRAINT "copy_annotations_rating_check" CHECK ("biblib"."copy_annotations"."rating" is null or ("biblib"."copy_annotations"."rating" >= 1 and "biblib"."copy_annotations"."rating" <= 5))
);
--> statement-breakpoint
ALTER TABLE "biblib"."copy_annotations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."copy_locations" (
	"user_id" uuid NOT NULL,
	"copy_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"shelf_label" text,
	"position" integer,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_locations_pkey" PRIMARY KEY("user_id","copy_id"),
	CONSTRAINT "copy_locations_shelf_label_check" CHECK ("biblib"."copy_locations"."shelf_label" is null or (char_length("biblib"."copy_locations"."shelf_label") >= 1 and char_length("biblib"."copy_locations"."shelf_label") <= 60 and "biblib"."copy_locations"."shelf_label" = btrim("biblib"."copy_locations"."shelf_label"))),
	CONSTRAINT "copy_locations_position_check" CHECK ("biblib"."copy_locations"."position" is null or ("biblib"."copy_locations"."position" >= 1 and "biblib"."copy_locations"."position" <= 100000))
);
--> statement-breakpoint
ALTER TABLE "biblib"."copy_locations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."copy_tags" (
	"user_id" uuid NOT NULL,
	"copy_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_tags_pkey" PRIMARY KEY("user_id","copy_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "biblib"."copy_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."csv_mapping_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"mapping_version" integer DEFAULT 1 NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csv_mapping_profiles_name_check" CHECK (char_length("biblib"."csv_mapping_profiles"."name") >= 1 and char_length("biblib"."csv_mapping_profiles"."name") <= 80 and "biblib"."csv_mapping_profiles"."name" = btrim("biblib"."csv_mapping_profiles"."name")),
	CONSTRAINT "csv_mapping_profiles_mapping_check" CHECK (jsonb_typeof("biblib"."csv_mapping_profiles"."mapping") = 'object' and octet_length("biblib"."csv_mapping_profiles"."mapping"::text) <= 16384),
	CONSTRAINT "csv_mapping_profiles_version_check" CHECK ("biblib"."csv_mapping_profiles"."mapping_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "biblib"."csv_mapping_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"photo_asset_id" uuid,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_name_check" CHECK (char_length("biblib"."locations"."name") >= 1 and char_length("biblib"."locations"."name") <= 120 and "biblib"."locations"."name" = btrim("biblib"."locations"."name")),
	CONSTRAINT "locations_kind_check" CHECK ("biblib"."locations"."kind" in ('room', 'bookcase', 'cabinet', 'box', 'shelf', 'other')),
	CONSTRAINT "locations_parent_check" CHECK ("biblib"."locations"."parent_id" is null or "biblib"."locations"."parent_id" <> "biblib"."locations"."id")
);
--> statement-breakpoint
ALTER TABLE "biblib"."locations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'quarantine' NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text,
	"mime" text,
	"width" integer,
	"height" integer,
	"bytes" integer,
	"expires_at" timestamp with time zone,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_kind_check" CHECK ("biblib"."media_assets"."kind" in ('avatar', 'location', 'evidence')),
	CONSTRAINT "media_assets_state_check" CHECK ("biblib"."media_assets"."state" in ('quarantine', 'ready')),
	CONSTRAINT "media_assets_key_check" CHECK ("biblib"."media_assets"."storage_key" = "biblib"."media_assets"."user_id"::text || '/' || "biblib"."media_assets"."kind" || '/' || "biblib"."media_assets"."id"::text),
	CONSTRAINT "media_assets_sha_check" CHECK ("biblib"."media_assets"."sha256" is null or "biblib"."media_assets"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_assets_size_check" CHECK (("biblib"."media_assets"."bytes" is null or ("biblib"."media_assets"."bytes" >= 1 and "biblib"."media_assets"."bytes" <= case when "biblib"."media_assets"."kind" = 'avatar' then 1048576 else 5242880 end)) and ("biblib"."media_assets"."width" is null or ("biblib"."media_assets"."width" >= 1 and "biblib"."media_assets"."width" <= case when "biblib"."media_assets"."kind" = 'avatar' then 1024 else 4096 end)) and ("biblib"."media_assets"."height" is null or ("biblib"."media_assets"."height" >= 1 and "biblib"."media_assets"."height" <= case when "biblib"."media_assets"."kind" = 'avatar' then 1024 else 4096 end))),
	CONSTRAINT "media_assets_ready_check" CHECK ("biblib"."media_assets"."state" = 'quarantine' or ("biblib"."media_assets"."sha256" is not null and "biblib"."media_assets"."mime" = 'image/webp' and "biblib"."media_assets"."width" is not null and "biblib"."media_assets"."height" is not null and "biblib"."media_assets"."bytes" is not null and "biblib"."media_assets"."expires_at" is null)),
	CONSTRAINT "media_assets_quarantine_check" CHECK ("biblib"."media_assets"."state" <> 'quarantine' or "biblib"."media_assets"."expires_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "biblib"."media_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"avatar_asset_id" uuid,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "biblib"."profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."review_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"selected_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor" text DEFAULT 'owner' NOT NULL,
	"operation_id" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_decisions_kind_check" CHECK ("biblib"."review_decisions"."kind" in ('accept_fields', 'ignore', 'confirm_physical', 'merge', 'reopen')),
	CONSTRAINT "review_decisions_fields_check" CHECK (jsonb_typeof("biblib"."review_decisions"."selected_fields") = 'object' and octet_length("biblib"."review_decisions"."selected_fields"::text) <= 16384),
	CONSTRAINT "review_decisions_refs_check" CHECK (jsonb_typeof("biblib"."review_decisions"."evidence_refs") = 'array' and jsonb_array_length("biblib"."review_decisions"."evidence_refs") <= 50),
	CONSTRAINT "review_decisions_actor_check" CHECK ("biblib"."review_decisions"."actor" = 'owner')
);
--> statement-breakpoint
ALTER TABLE "biblib"."review_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."review_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"entity_refs" jsonb NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"dedupe_key" text,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "review_issues_reason_check" CHECK ("biblib"."review_issues"."reason" in ('provisional', 'missing_isbn', 'invalid_isbn', 'missing_cover', 'isbn_conflict', 'duplicate_candidate', 'photo_doubt', 'source_conflict')),
	CONSTRAINT "review_issues_state_check" CHECK ("biblib"."review_issues"."state" in ('open', 'resolved', 'ignored')),
	CONSTRAINT "review_issues_refs_check" CHECK (jsonb_typeof("biblib"."review_issues"."entity_refs") = 'array' and jsonb_array_length("biblib"."review_issues"."entity_refs") >= 1 and jsonb_array_length("biblib"."review_issues"."entity_refs") <= 50),
	CONSTRAINT "review_issues_dedupe_check" CHECK ("biblib"."review_issues"."dedupe_key" is null or "biblib"."review_issues"."dedupe_key" ~ '^[A-Za-z0-9:._-]{1,200}$'),
	CONSTRAINT "review_issues_resolved_check" CHECK (("biblib"."review_issues"."state" = 'open') = ("biblib"."review_issues"."resolved_at" is null))
);
--> statement-breakpoint
ALTER TABLE "biblib"."review_issues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_title_check" CHECK (char_length("biblib"."series"."title") >= 1 and char_length("biblib"."series"."title") <= 300 and "biblib"."series"."title" = btrim("biblib"."series"."title")),
	CONSTRAINT "series_description_check" CHECK ("biblib"."series"."description" is null or (char_length("biblib"."series"."description") >= 1 and char_length("biblib"."series"."description") <= 2000))
);
--> statement-breakpoint
ALTER TABLE "biblib"."series" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."series_editions" (
	"user_id" uuid NOT NULL,
	"edition_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"position" numeric,
	"volume_label" text,
	"order_note" text,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_editions_pkey" PRIMARY KEY("user_id","edition_id"),
	CONSTRAINT "series_editions_position_check" CHECK ("biblib"."series_editions"."position" is null or ("biblib"."series_editions"."position" >= 0 and "biblib"."series_editions"."position" < 1000000 and scale("biblib"."series_editions"."position") <= 4)),
	CONSTRAINT "series_editions_volume_label_check" CHECK ("biblib"."series_editions"."volume_label" is null or (char_length("biblib"."series_editions"."volume_label") >= 1 and char_length("biblib"."series_editions"."volume_label") <= 40)),
	CONSTRAINT "series_editions_order_note_check" CHECK ("biblib"."series_editions"."order_note" is null or (char_length("biblib"."series_editions"."order_note") >= 1 and char_length("biblib"."series_editions"."order_note") <= 200))
);
--> statement-breakpoint
ALTER TABLE "biblib"."series_editions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text GENERATED ALWAYS AS (biblib.tag_normalize(name)) STORED NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_name_check" CHECK (char_length("biblib"."tags"."name") >= 1 and char_length("biblib"."tags"."name") <= 40 and "biblib"."tags"."name" = btrim("biblib"."tags"."name") and "biblib"."tags"."name" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
ALTER TABLE "biblib"."tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "biblib"."account_deletions" DROP CONSTRAINT "account_deletions_step_check";--> statement-breakpoint
ALTER TABLE "biblib"."import_session_rows" DROP CONSTRAINT "import_session_rows_kind_check";--> statement-breakpoint
ALTER TABLE "biblib"."import_sessions" DROP CONSTRAINT "import_sessions_source_check";--> statement-breakpoint
ALTER TABLE "biblib"."library_snapshot_chunks" DROP CONSTRAINT "library_snapshot_chunks_kind_check";--> statement-breakpoint
ALTER TABLE "biblib"."import_session_rows" ADD COLUMN "source_ordinal" integer;--> statement-breakpoint
ALTER TABLE "biblib"."import_session_rows" ADD COLUMN "source_row_key" text;--> statement-breakpoint
ALTER TABLE "biblib"."import_session_rows" ADD COLUMN "issues" jsonb;--> statement-breakpoint
ALTER TABLE "biblib"."import_sessions" ADD COLUMN "csv_mapping" jsonb;--> statement-breakpoint
ALTER TABLE "biblib"."import_sessions" ADD COLUMN "csv_mapping_version" integer;--> statement-breakpoint
ALTER TABLE "biblib"."import_sessions" ADD COLUMN "input_sha256" text;--> statement-breakpoint
ALTER TABLE "biblib"."import_sessions" ADD COLUMN "mapping_sha256" text;--> statement-breakpoint
-- Índices antes de las FK compuestas: (user_id, id) es el destino de las FK con propietario.
CREATE UNIQUE INDEX "bibliographic_evidence_user_id_id_unique" ON "biblib"."bibliographic_evidence" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "bibliographic_evidence_edition_idx" ON "biblib"."bibliographic_evidence" USING btree ("user_id","edition_id") WHERE "biblib"."bibliographic_evidence"."edition_id" is not null;--> statement-breakpoint
CREATE INDEX "bibliographic_evidence_copy_idx" ON "biblib"."bibliographic_evidence" USING btree ("user_id","copy_id") WHERE "biblib"."bibliographic_evidence"."copy_id" is not null;--> statement-breakpoint
CREATE INDEX "bibliographic_evidence_photo_idx" ON "biblib"."bibliographic_evidence" USING btree ("user_id","photo_asset_id") WHERE "biblib"."bibliographic_evidence"."photo_asset_id" is not null;--> statement-breakpoint
CREATE INDEX "copy_locations_user_location_idx" ON "biblib"."copy_locations" USING btree ("user_id","location_id");--> statement-breakpoint
CREATE INDEX "copy_tags_user_tag_idx" ON "biblib"."copy_tags" USING btree ("user_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "csv_mapping_profiles_user_id_id_unique" ON "biblib"."csv_mapping_profiles" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "csv_mapping_profiles_user_name_unique" ON "biblib"."csv_mapping_profiles" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "locations_user_id_id_unique" ON "biblib"."locations" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "locations_user_parent_idx" ON "biblib"."locations" USING btree ("user_id","parent_id");--> statement-breakpoint
CREATE INDEX "locations_photo_idx" ON "biblib"."locations" USING btree ("user_id","photo_asset_id") WHERE "biblib"."locations"."photo_asset_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_user_id_id_unique" ON "biblib"."media_assets" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "media_assets_user_kind_idx" ON "biblib"."media_assets" USING btree ("user_id","kind","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "media_assets_expires_at_idx" ON "biblib"."media_assets" USING btree ("expires_at") WHERE "biblib"."media_assets"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "profiles_avatar_idx" ON "biblib"."profiles" USING btree ("user_id","avatar_asset_id") WHERE "biblib"."profiles"."avatar_asset_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "review_decisions_user_id_id_unique" ON "biblib"."review_decisions" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "review_decisions_issue_idx" ON "biblib"."review_decisions" USING btree ("user_id","issue_id","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_issues_user_id_id_unique" ON "biblib"."review_issues" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_issues_open_dedupe_unique" ON "biblib"."review_issues" USING btree ("user_id","dedupe_key") WHERE "biblib"."review_issues"."dedupe_key" is not null and "biblib"."review_issues"."state" = 'open';--> statement-breakpoint
CREATE INDEX "review_issues_user_state_idx" ON "biblib"."review_issues" USING btree ("user_id","state","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "series_user_id_id_unique" ON "biblib"."series" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "series_user_title_idx" ON "biblib"."series" USING btree ("user_id","title");--> statement-breakpoint
CREATE INDEX "series_editions_order_idx" ON "biblib"."series_editions" USING btree ("user_id","series_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_user_id_id_unique" ON "biblib"."tags" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_user_normalized_unique" ON "biblib"."tags" USING btree ("user_id","normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "import_session_rows_source_key_unique" ON "biblib"."import_session_rows" USING btree ("session_id","source_row_key") WHERE "biblib"."import_session_rows"."source_row_key" is not null;--> statement-breakpoint
ALTER TABLE "biblib"."bibliographic_evidence" ADD CONSTRAINT "bibliographic_evidence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."bibliographic_evidence" ADD CONSTRAINT "bibliographic_evidence_owner_edition_fk" FOREIGN KEY ("user_id","edition_id") REFERENCES "biblib"."editions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."bibliographic_evidence" ADD CONSTRAINT "bibliographic_evidence_owner_copy_fk" FOREIGN KEY ("user_id","copy_id") REFERENCES "biblib"."copies"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."bibliographic_evidence" ADD CONSTRAINT "bibliographic_evidence_owner_photo_fk" FOREIGN KEY ("user_id","photo_asset_id") REFERENCES "biblib"."media_assets"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."copy_annotations" ADD CONSTRAINT "copy_annotations_owner_copy_fk" FOREIGN KEY ("user_id","copy_id") REFERENCES "biblib"."copies"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."copy_locations" ADD CONSTRAINT "copy_locations_owner_copy_fk" FOREIGN KEY ("user_id","copy_id") REFERENCES "biblib"."copies"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."copy_locations" ADD CONSTRAINT "copy_locations_owner_location_fk" FOREIGN KEY ("user_id","location_id") REFERENCES "biblib"."locations"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."copy_tags" ADD CONSTRAINT "copy_tags_owner_copy_fk" FOREIGN KEY ("user_id","copy_id") REFERENCES "biblib"."copies"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."copy_tags" ADD CONSTRAINT "copy_tags_owner_tag_fk" FOREIGN KEY ("user_id","tag_id") REFERENCES "biblib"."tags"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."csv_mapping_profiles" ADD CONSTRAINT "csv_mapping_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."locations" ADD CONSTRAINT "locations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."locations" ADD CONSTRAINT "locations_owner_parent_fk" FOREIGN KEY ("user_id","parent_id") REFERENCES "biblib"."locations"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."locations" ADD CONSTRAINT "locations_owner_photo_fk" FOREIGN KEY ("user_id","photo_asset_id") REFERENCES "biblib"."media_assets"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."media_assets" ADD CONSTRAINT "media_assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."profiles" ADD CONSTRAINT "profiles_owner_avatar_fk" FOREIGN KEY ("user_id","avatar_asset_id") REFERENCES "biblib"."media_assets"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."review_decisions" ADD CONSTRAINT "review_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."review_decisions" ADD CONSTRAINT "review_decisions_owner_issue_fk" FOREIGN KEY ("user_id","issue_id") REFERENCES "biblib"."review_issues"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."review_issues" ADD CONSTRAINT "review_issues_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."series" ADD CONSTRAINT "series_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."series_editions" ADD CONSTRAINT "series_editions_owner_edition_fk" FOREIGN KEY ("user_id","edition_id") REFERENCES "biblib"."editions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."series_editions" ADD CONSTRAINT "series_editions_owner_series_fk" FOREIGN KEY ("user_id","series_id") REFERENCES "biblib"."series"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."tags" ADD CONSTRAINT "tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."account_deletions" ADD CONSTRAINT "account_deletions_step_check" CHECK ("biblib"."account_deletions"."step" in ('sessions', 'storage', 'covers', 'snapshots', 'staging', 'jobs', 'views', 'previews', 'operations', 'private_cache', 'product', 'media', 'copies', 'editions', 'works', 'shelves', 'state', 'auth', 'verify', 'done'));--> statement-breakpoint
ALTER TABLE "biblib"."import_session_rows" ADD CONSTRAINT "import_session_rows_source_check" CHECK (("biblib"."import_session_rows"."source_ordinal" is null) = ("biblib"."import_session_rows"."source_row_key" is null) and ("biblib"."import_session_rows"."source_ordinal" is null or ("biblib"."import_session_rows"."source_ordinal" >= 1 and "biblib"."import_session_rows"."source_ordinal" <= 1000000 and "biblib"."import_session_rows"."source_row_key" ~ '^[A-Za-z0-9:_-]{1,128}$')));--> statement-breakpoint
ALTER TABLE "biblib"."import_session_rows" ADD CONSTRAINT "import_session_rows_issues_check" CHECK ("biblib"."import_session_rows"."issues" is null or (jsonb_typeof("biblib"."import_session_rows"."issues") = 'array' and jsonb_array_length("biblib"."import_session_rows"."issues") <= 50));--> statement-breakpoint
ALTER TABLE "biblib"."import_session_rows" ADD CONSTRAINT "import_session_rows_kind_check" CHECK ("biblib"."import_session_rows"."kind" in ('book', 'shelf', 'tag', 'location', 'series', 'record'));--> statement-breakpoint
ALTER TABLE "biblib"."import_sessions" ADD CONSTRAINT "import_sessions_csv_mapping_check" CHECK (("biblib"."import_sessions"."csv_mapping" is null) = ("biblib"."import_sessions"."csv_mapping_version" is null) and ("biblib"."import_sessions"."csv_mapping" is null) = ("biblib"."import_sessions"."mapping_sha256" is null));--> statement-breakpoint
ALTER TABLE "biblib"."import_sessions" ADD CONSTRAINT "import_sessions_csv_mapping_shape_check" CHECK ("biblib"."import_sessions"."csv_mapping" is null or (jsonb_typeof("biblib"."import_sessions"."csv_mapping") = 'object' and octet_length("biblib"."import_sessions"."csv_mapping"::text) <= 16384 and "biblib"."import_sessions"."csv_mapping_version" >= 1));--> statement-breakpoint
ALTER TABLE "biblib"."import_sessions" ADD CONSTRAINT "import_sessions_csv_hashes_check" CHECK (("biblib"."import_sessions"."input_sha256" is null or "biblib"."import_sessions"."input_sha256" ~ '^[0-9a-f]{64}$') and ("biblib"."import_sessions"."mapping_sha256" is null or "biblib"."import_sessions"."mapping_sha256" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "biblib"."import_sessions" ADD CONSTRAINT "import_sessions_csv_source_check" CHECK (("biblib"."import_sessions"."source" = 'csv') = ("biblib"."import_sessions"."input_sha256" is not null) and ("biblib"."import_sessions"."source" = 'csv' or "biblib"."import_sessions"."csv_mapping" is null));--> statement-breakpoint
ALTER TABLE "biblib"."import_sessions" ADD CONSTRAINT "import_sessions_source_check" CHECK ("biblib"."import_sessions"."source" in ('manifest', 'loose', 'csv'));--> statement-breakpoint
ALTER TABLE "biblib"."library_snapshot_chunks" ADD CONSTRAINT "library_snapshot_chunks_kind_check" CHECK ("biblib"."library_snapshot_chunks"."kind" in ('shelves', 'books', 'tags', 'locations', 'series'));--> statement-breakpoint
CREATE POLICY "bibliographic_evidence_select_own" ON "biblib"."bibliographic_evidence" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."bibliographic_evidence"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "bibliographic_evidence_insert_own" ON "biblib"."bibliographic_evidence" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."bibliographic_evidence"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "bibliographic_evidence_update_own" ON "biblib"."bibliographic_evidence" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("biblib"."bibliographic_evidence"."user_id" = (select auth.uid())) WITH CHECK ("biblib"."bibliographic_evidence"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "bibliographic_evidence_delete_own" ON "biblib"."bibliographic_evidence" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."bibliographic_evidence"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "bibliographic_evidence_insert_active" ON "biblib"."bibliographic_evidence" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "bibliographic_evidence_update_active" ON "biblib"."bibliographic_evidence" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "bibliographic_evidence_delete_active" ON "biblib"."bibliographic_evidence" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "copy_annotations_select_own" ON "biblib"."copy_annotations" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."copy_annotations"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "copy_annotations_insert_own" ON "biblib"."copy_annotations" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."copy_annotations"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "copy_annotations_update_own" ON "biblib"."copy_annotations" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("biblib"."copy_annotations"."user_id" = (select auth.uid())) WITH CHECK ("biblib"."copy_annotations"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "copy_annotations_delete_own" ON "biblib"."copy_annotations" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."copy_annotations"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "copy_annotations_insert_active" ON "biblib"."copy_annotations" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "copy_annotations_update_active" ON "biblib"."copy_annotations" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "copy_annotations_delete_active" ON "biblib"."copy_annotations" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "copy_locations_select_own" ON "biblib"."copy_locations" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."copy_locations"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "copy_locations_insert_own" ON "biblib"."copy_locations" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."copy_locations"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "copy_locations_update_own" ON "biblib"."copy_locations" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("biblib"."copy_locations"."user_id" = (select auth.uid())) WITH CHECK ("biblib"."copy_locations"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "copy_locations_delete_own" ON "biblib"."copy_locations" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."copy_locations"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "copy_locations_insert_active" ON "biblib"."copy_locations" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "copy_locations_update_active" ON "biblib"."copy_locations" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "copy_locations_delete_active" ON "biblib"."copy_locations" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "copy_tags_select_own" ON "biblib"."copy_tags" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."copy_tags"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "copy_tags_insert_own" ON "biblib"."copy_tags" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."copy_tags"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "copy_tags_delete_own" ON "biblib"."copy_tags" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."copy_tags"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "copy_tags_insert_active" ON "biblib"."copy_tags" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "copy_tags_delete_active" ON "biblib"."copy_tags" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "csv_mapping_profiles_select_own" ON "biblib"."csv_mapping_profiles" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."csv_mapping_profiles"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "csv_mapping_profiles_insert_own" ON "biblib"."csv_mapping_profiles" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."csv_mapping_profiles"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "csv_mapping_profiles_update_own" ON "biblib"."csv_mapping_profiles" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("biblib"."csv_mapping_profiles"."user_id" = (select auth.uid())) WITH CHECK ("biblib"."csv_mapping_profiles"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "csv_mapping_profiles_delete_own" ON "biblib"."csv_mapping_profiles" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."csv_mapping_profiles"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "csv_mapping_profiles_insert_active" ON "biblib"."csv_mapping_profiles" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "csv_mapping_profiles_update_active" ON "biblib"."csv_mapping_profiles" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "csv_mapping_profiles_delete_active" ON "biblib"."csv_mapping_profiles" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "locations_select_own" ON "biblib"."locations" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."locations"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "locations_insert_own" ON "biblib"."locations" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."locations"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "locations_update_own" ON "biblib"."locations" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("biblib"."locations"."user_id" = (select auth.uid())) WITH CHECK ("biblib"."locations"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "locations_delete_own" ON "biblib"."locations" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."locations"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "locations_insert_active" ON "biblib"."locations" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "locations_update_active" ON "biblib"."locations" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "locations_delete_active" ON "biblib"."locations" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "media_assets_select_own" ON "biblib"."media_assets" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."media_assets"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "profiles_select_own" ON "biblib"."profiles" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."profiles"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "profiles_insert_own" ON "biblib"."profiles" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."profiles"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "profiles_update_own" ON "biblib"."profiles" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("biblib"."profiles"."user_id" = (select auth.uid())) WITH CHECK ("biblib"."profiles"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "profiles_delete_own" ON "biblib"."profiles" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."profiles"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "profiles_insert_active" ON "biblib"."profiles" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "profiles_update_active" ON "biblib"."profiles" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "profiles_delete_active" ON "biblib"."profiles" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "review_decisions_select_own" ON "biblib"."review_decisions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."review_decisions"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "review_decisions_insert_own" ON "biblib"."review_decisions" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."review_decisions"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "review_decisions_insert_active" ON "biblib"."review_decisions" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "review_issues_select_own" ON "biblib"."review_issues" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."review_issues"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "review_issues_insert_own" ON "biblib"."review_issues" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."review_issues"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "review_issues_update_own" ON "biblib"."review_issues" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("biblib"."review_issues"."user_id" = (select auth.uid())) WITH CHECK ("biblib"."review_issues"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "review_issues_delete_own" ON "biblib"."review_issues" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."review_issues"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "review_issues_insert_active" ON "biblib"."review_issues" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "review_issues_update_active" ON "biblib"."review_issues" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "review_issues_delete_active" ON "biblib"."review_issues" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "series_select_own" ON "biblib"."series" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."series"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "series_insert_own" ON "biblib"."series" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."series"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "series_update_own" ON "biblib"."series" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("biblib"."series"."user_id" = (select auth.uid())) WITH CHECK ("biblib"."series"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "series_delete_own" ON "biblib"."series" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."series"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "series_insert_active" ON "biblib"."series" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "series_update_active" ON "biblib"."series" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "series_delete_active" ON "biblib"."series" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "series_editions_select_own" ON "biblib"."series_editions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."series_editions"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "series_editions_insert_own" ON "biblib"."series_editions" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."series_editions"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "series_editions_update_own" ON "biblib"."series_editions" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("biblib"."series_editions"."user_id" = (select auth.uid())) WITH CHECK ("biblib"."series_editions"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "series_editions_delete_own" ON "biblib"."series_editions" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."series_editions"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "series_editions_insert_active" ON "biblib"."series_editions" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "series_editions_update_active" ON "biblib"."series_editions" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "series_editions_delete_active" ON "biblib"."series_editions" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "tags_select_own" ON "biblib"."tags" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."tags"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "tags_insert_own" ON "biblib"."tags" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."tags"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "tags_update_own" ON "biblib"."tags" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("biblib"."tags"."user_id" = (select auth.uid())) WITH CHECK ("biblib"."tags"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "tags_delete_own" ON "biblib"."tags" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."tags"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "tags_insert_active" ON "biblib"."tags" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "tags_update_active" ON "biblib"."tags" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "tags_delete_active" ON "biblib"."tags" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));
--> statement-breakpoint
-- Privilegios. El dueño trabaja con RLS (y las políticas RESTRICTIVE de cuenta activa) sobre sus datos de producto; las
-- decisiones de revisión son de solo inserción; los assets de imagen solo se leen: sus transiciones pasan por funciones.
REVOKE ALL ON "biblib"."tags", "biblib"."copy_tags", "biblib"."copy_annotations", "biblib"."locations", "biblib"."copy_locations", "biblib"."series",
  "biblib"."series_editions", "biblib"."media_assets", "biblib"."profiles", "biblib"."bibliographic_evidence", "biblib"."review_issues",
  "biblib"."review_decisions", "biblib"."csv_mapping_profiles" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "biblib"."tags", "biblib"."copy_annotations", "biblib"."locations", "biblib"."copy_locations", "biblib"."series",
  "biblib"."series_editions", "biblib"."profiles", "biblib"."bibliographic_evidence", "biblib"."review_issues", "biblib"."csv_mapping_profiles" TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "biblib"."copy_tags" TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON "biblib"."review_decisions" TO authenticated;
--> statement-breakpoint
GRANT SELECT ON "biblib"."media_assets" TO authenticated;
--> statement-breakpoint
-- La columna generada `tags.normalized_name` la evalúa el rol que escribe.
REVOKE ALL ON FUNCTION "biblib"."tag_normalize"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "biblib"."tag_normalize"(text) TO authenticated;
--> statement-breakpoint
-- Tokens y revisión de colección. Toda escritura de una tabla con `version` la renueva; las que forman parte de la
-- colección (exportación, versiones anteriores y reemplazo) rotan además la revisión del dueño una vez por transacción,
-- de modo que una vista previa de importación o restauración preparada antes deja de valer.
CREATE TRIGGER "tags_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."tags" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();
--> statement-breakpoint
CREATE TRIGGER "copy_annotations_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."copy_annotations" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();
--> statement-breakpoint
CREATE TRIGGER "locations_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."locations" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();
--> statement-breakpoint
CREATE TRIGGER "copy_locations_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."copy_locations" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();
--> statement-breakpoint
CREATE TRIGGER "series_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."series" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();
--> statement-breakpoint
CREATE TRIGGER "series_editions_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."series_editions" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();
--> statement-breakpoint
CREATE TRIGGER "bibliographic_evidence_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."bibliographic_evidence" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();
--> statement-breakpoint
CREATE TRIGGER "review_issues_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."review_issues" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();
--> statement-breakpoint
CREATE TRIGGER "profiles_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."profiles" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();
--> statement-breakpoint
CREATE TRIGGER "csv_mapping_profiles_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."csv_mapping_profiles" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();
--> statement-breakpoint
CREATE TRIGGER "tags_rotate_library_revision" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."tags" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_library_revision"();
--> statement-breakpoint
CREATE TRIGGER "copy_tags_rotate_library_revision" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."copy_tags" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_library_revision"();
--> statement-breakpoint
CREATE TRIGGER "copy_annotations_rotate_library_revision" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."copy_annotations" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_library_revision"();
--> statement-breakpoint
CREATE TRIGGER "locations_rotate_library_revision" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."locations" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_library_revision"();
--> statement-breakpoint
CREATE TRIGGER "copy_locations_rotate_library_revision" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."copy_locations" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_library_revision"();
--> statement-breakpoint
CREATE TRIGGER "series_rotate_library_revision" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."series" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_library_revision"();
--> statement-breakpoint
CREATE TRIGGER "series_editions_rotate_library_revision" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."series_editions" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_library_revision"();
--> statement-breakpoint
CREATE TRIGGER "bibliographic_evidence_rotate_library_revision" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."bibliographic_evidence" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_library_revision"();
--> statement-breakpoint
-- Límites por cuenta (o por ejemplar con un segundo argumento) bajo un bloqueo consultivo del dueño: dos altas
-- simultáneas no superan el límite. BP001 → LIMIT_EXCEEDED en las acciones. Ve las filas que ve quien escribe (RLS).
CREATE FUNCTION "biblib"."enforce_row_limit"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  max_rows integer := TG_ARGV[0]::integer;
  group_column text := CASE WHEN TG_NARGS > 1 THEN TG_ARGV[1] END;
  group_value text;
  total integer;
BEGIN
  IF group_column IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(format('biblib.%s:%s', TG_TABLE_NAME, NEW.user_id), 0));
    EXECUTE format('SELECT count(*)::integer FROM biblib.%I AS t WHERE t.user_id = $1', TG_TABLE_NAME) INTO total USING NEW.user_id;
  ELSE
    group_value := to_jsonb(NEW)->>group_column;
    PERFORM pg_advisory_xact_lock(hashtextextended(format('biblib.%s:%s:%s', TG_TABLE_NAME, NEW.user_id, group_value), 0));
    EXECUTE format('SELECT count(*)::integer FROM biblib.%I AS t WHERE t.user_id = $1 AND t.%I::text = $2', TG_TABLE_NAME, group_column) INTO total USING NEW.user_id, group_value;
  END IF;
  IF total >= max_rows THEN
    RAISE EXCEPTION 'Límite alcanzado en % (%)', TG_TABLE_NAME, max_rows USING ERRCODE = 'BP001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tags_limit" BEFORE INSERT ON "biblib"."tags" FOR EACH ROW EXECUTE FUNCTION "biblib"."enforce_row_limit"('1000');
--> statement-breakpoint
CREATE TRIGGER "copy_tags_limit" BEFORE INSERT ON "biblib"."copy_tags" FOR EACH ROW EXECUTE FUNCTION "biblib"."enforce_row_limit"('20', 'copy_id');
--> statement-breakpoint
CREATE TRIGGER "locations_limit" BEFORE INSERT ON "biblib"."locations" FOR EACH ROW EXECUTE FUNCTION "biblib"."enforce_row_limit"('500');
--> statement-breakpoint
CREATE TRIGGER "series_limit" BEFORE INSERT ON "biblib"."series" FOR EACH ROW EXECUTE FUNCTION "biblib"."enforce_row_limit"('1000');
--> statement-breakpoint
CREATE TRIGGER "bibliographic_evidence_limit" BEFORE INSERT ON "biblib"."bibliographic_evidence" FOR EACH ROW EXECUTE FUNCTION "biblib"."enforce_row_limit"('50000');
--> statement-breakpoint
CREATE TRIGGER "review_issues_limit" BEFORE INSERT ON "biblib"."review_issues" FOR EACH ROW EXECUTE FUNCTION "biblib"."enforce_row_limit"('10000');
--> statement-breakpoint
CREATE TRIGGER "csv_mapping_profiles_limit" BEFORE INSERT ON "biblib"."csv_mapping_profiles" FOR EACH ROW EXECUTE FUNCTION "biblib"."enforce_row_limit"('20');
--> statement-breakpoint
-- Árbol de ubicaciones: antes de escribir, el bloqueo consultivo del dueño serializa los cambios de su árbol; después de
-- la sentencia (con todas sus filas ya visibles) se recorre el árbol: sin ciclos (BL001) y sin más de 8 niveles contando
-- los descendientes de la ubicación movida (BL002). La FK con dueño impide colgar una ubicación de otra cuenta.
CREATE FUNCTION "biblib"."guard_location_tree"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  cursor_id uuid;
  depth integer := 1;
  below integer;
BEGIN
  IF TG_WHEN = 'BEFORE' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('biblib.locations:' || NEW.user_id::text, 0));
    RETURN NEW;
  END IF;
  cursor_id := NEW.parent_id;
  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id = NEW.id THEN
      RAISE EXCEPTION 'Una ubicación no puede estar dentro de sí misma' USING ERRCODE = 'BL001';
    END IF;
    depth := depth + 1;
    IF depth > 8 THEN
      RAISE EXCEPTION 'Las ubicaciones admiten como máximo 8 niveles' USING ERRCODE = 'BL002';
    END IF;
    SELECT l.parent_id INTO cursor_id FROM biblib.locations AS l WHERE l.user_id = NEW.user_id AND l.id = cursor_id;
  END LOOP;
  WITH RECURSIVE subtree(id, level) AS (
    SELECT NEW.id, 0
    UNION ALL
    SELECT l.id, s.level + 1 FROM biblib.locations AS l JOIN subtree AS s ON l.parent_id = s.id
    WHERE l.user_id = NEW.user_id AND s.level < 8
  )
  SELECT max(s.level) INTO below FROM subtree AS s;
  IF depth + coalesce(below, 0) > 8 THEN
    RAISE EXCEPTION 'Las ubicaciones admiten como máximo 8 niveles' USING ERRCODE = 'BL002';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "locations_tree_lock" BEFORE INSERT OR UPDATE ON "biblib"."locations" FOR EACH ROW EXECUTE FUNCTION "biblib"."guard_location_tree"();
--> statement-breakpoint
CREATE TRIGGER "locations_tree_check" AFTER INSERT OR UPDATE ON "biblib"."locations" FOR EACH ROW EXECUTE FUNCTION "biblib"."guard_location_tree"();
--> statement-breakpoint
-- Una referencia a un asset de imagen (avatar, foto de ubicación o foto fuente) solo cita un asset propio, listo y del
-- tipo que corresponde. La FK con dueño ya impide citar el de otra cuenta. Argumentos: columna y tipo de asset.
CREATE FUNCTION "biblib"."guard_media_reference"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  asset_id uuid := (to_jsonb(NEW)->>TG_ARGV[0])::uuid;
BEGIN
  IF asset_id IS NULL OR (TG_OP = 'UPDATE' AND asset_id IS NOT DISTINCT FROM (to_jsonb(OLD)->>TG_ARGV[0])::uuid) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM biblib.media_assets AS a WHERE a.id = asset_id AND a.user_id = NEW.user_id AND a.kind = TG_ARGV[1] AND a.state = 'ready') THEN
    RAISE EXCEPTION 'La imagen privada no está disponible' USING ERRCODE = 'BA010';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "profiles_guard_avatar" BEFORE INSERT OR UPDATE ON "biblib"."profiles" FOR EACH ROW EXECUTE FUNCTION "biblib"."guard_media_reference"('avatar_asset_id', 'avatar');
--> statement-breakpoint
CREATE TRIGGER "locations_guard_photo" BEFORE INSERT OR UPDATE ON "biblib"."locations" FOR EACH ROW EXECUTE FUNCTION "biblib"."guard_media_reference"('photo_asset_id', 'location');
--> statement-breakpoint
CREATE TRIGGER "bibliographic_evidence_guard_photo" BEFORE INSERT OR UPDATE ON "biblib"."bibliographic_evidence" FOR EACH ROW EXECUTE FUNCTION "biblib"."guard_media_reference"('photo_asset_id', 'evidence');
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."enforce_row_limit"(), "biblib"."guard_location_tree"(), "biblib"."guard_media_reference"() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
-- Guarda de las políticas de storage.objects del bucket privado `biblib-media`. Ruta exacta `<dueño>/<tipo>/<asset>`:
-- el dueño lee sus objetos registrados, sube solo el de un asset propio en cuarentena vigente (una sola vez: sin
-- política UPDATE no hay sobrescritura) y, con cuenta activa, retira objetos en cuarentena o sin fila. Sin sesión, nada.
CREATE FUNCTION "biblib"."media_object_access"(p_name text, p_action text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  parts text[];
  asset biblib.media_assets%ROWTYPE;
BEGIN
  IF owner_id IS NULL OR p_name IS NULL OR p_action IS NULL OR p_action NOT IN ('select', 'insert', 'delete') THEN
    RETURN false;
  END IF;
  parts := string_to_array(p_name, '/');
  IF coalesce(array_length(parts, 1), 0) <> 3 OR parts[1] <> owner_id::text OR parts[2] NOT IN ('avatar', 'location', 'evidence')
    OR parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  SELECT * INTO asset FROM biblib.media_assets AS a WHERE a.id = parts[3]::uuid AND a.user_id = owner_id AND a.kind = parts[2];
  IF NOT FOUND THEN
    -- Objeto propio sin fila (subida descartada o asset ya retirado): el dueño lo ve y, con cuenta activa, lo retira
    -- (la API de Storage borra con RETURNING, que exige verlo). Nunca se sube sin fila.
    RETURN p_action = 'select' OR (p_action = 'delete' AND biblib.account_is_active(owner_id));
  END IF;
  IF p_action = 'select' THEN
    RETURN true;
  END IF;
  IF p_action = 'delete' THEN
    RETURN asset.state = 'quarantine' AND biblib.account_is_active(owner_id);
  END IF;
  RETURN asset.state = 'quarantine' AND asset.expires_at > clock_timestamp() AND biblib.account_is_active(owner_id);
END;
$$;
--> statement-breakpoint
-- Reserva de una subida: asset en cuarentena 15 minutos con su ruta fija. Cuotas del dueño bajo bloqueo: 5 en cuarentena
-- y 500 listos o 200 MiB. Cuenta en eliminación: BD001; bloqueada: `inactive`.
CREATE FUNCTION "biblib"."media_asset_begin_upload"(p_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  now_at timestamptz := clock_timestamp();
  new_id uuid := gen_random_uuid();
  key text;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'media_asset_begin_upload requiere una sesión' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('avatar', 'location', 'evidence') THEN
    RAISE EXCEPTION 'Tipo de imagen no válido' USING ERRCODE = '22023';
  END IF;
  PERFORM biblib.account_write_allowed();
  IF NOT biblib.account_is_active(owner_id) THEN
    RETURN jsonb_build_object('status', 'inactive');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('biblib.media_assets:' || owner_id::text, 0));
  IF (SELECT count(*) FROM biblib.media_assets AS a WHERE a.user_id = owner_id AND a.state = 'quarantine' AND a.expires_at > now_at) >= 5 THEN
    RETURN jsonb_build_object('status', 'quota', 'quota', 'quarantine');
  END IF;
  IF (SELECT count(*) FROM biblib.media_assets AS a WHERE a.user_id = owner_id AND a.state = 'ready') >= 500
    OR (SELECT coalesce(sum(a.bytes), 0) FROM biblib.media_assets AS a WHERE a.user_id = owner_id AND a.state = 'ready') >= 209715200 THEN
    RETURN jsonb_build_object('status', 'quota', 'quota', 'stored');
  END IF;
  key := owner_id::text || '/' || p_kind || '/' || new_id::text;
  INSERT INTO biblib.media_assets (id, user_id, kind, state, storage_key, expires_at, created_at, updated_at)
  VALUES (new_id, owner_id, p_kind, 'quarantine', key, now_at + interval '15 minutes', now_at, now_at);
  RETURN jsonb_build_object('status', 'created', 'asset_id', new_id, 'storage_key', key);
END;
$$;
--> statement-breakpoint
-- Registra un asset validado por el servidor (WebP reencodificado, sin metadatos): exige la cuarentena vigente, la cuenta
-- activa, límites del tipo y el objeto ya presente en el bucket con el tamaño declarado. Nunca confirma sin objeto.
CREATE FUNCTION "biblib"."media_asset_register"(p_asset_id uuid, p_sha256 text, p_bytes integer, p_width integer, p_height integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  now_at timestamptz := clock_timestamp();
  asset biblib.media_assets%ROWTYPE;
  max_bytes integer;
  max_side integer;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'media_asset_register requiere una sesión' USING ERRCODE = '42501';
  END IF;
  PERFORM biblib.account_write_allowed();
  SELECT * INTO asset FROM biblib.media_assets AS a WHERE a.id = p_asset_id AND a.user_id = owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF NOT biblib.account_is_active(owner_id) THEN
    RETURN jsonb_build_object('status', 'inactive');
  END IF;
  IF asset.state <> 'quarantine' OR asset.expires_at <= now_at THEN
    RETURN jsonb_build_object('status', 'stale');
  END IF;
  max_bytes := CASE WHEN asset.kind = 'avatar' THEN 1048576 ELSE 5242880 END;
  max_side := CASE WHEN asset.kind = 'avatar' THEN 1024 ELSE 4096 END;
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' OR p_bytes IS NULL OR p_bytes < 1 OR p_bytes > max_bytes
    OR p_width IS NULL OR p_width < 1 OR p_width > max_side OR p_height IS NULL OR p_height < 1 OR p_height > max_side THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects AS o WHERE o.bucket_id = 'biblib-media' AND o.name = asset.storage_key AND (o.metadata->>'size')::bigint = p_bytes) THEN
    RETURN jsonb_build_object('status', 'missing_object');
  END IF;
  UPDATE biblib.media_assets AS a SET state = 'ready', sha256 = p_sha256, mime = 'image/webp', bytes = p_bytes, width = p_width, height = p_height,
    expires_at = NULL, version = gen_random_uuid(), updated_at = now_at
  WHERE a.id = asset.id;
  RETURN jsonb_build_object('status', 'ready', 'asset_id', asset.id);
END;
$$;
--> statement-breakpoint
-- Retira un asset propio que nada cita (perfil, ubicación o evidencia): una cuarentena descartada o una imagen sustituida.
-- Devuelve su ruta para que el servidor retire el objeto con la sesión del dueño; uno citado no se toca.
CREATE FUNCTION "biblib"."media_asset_discard"(p_asset_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  asset biblib.media_assets%ROWTYPE;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'media_asset_discard requiere una sesión' USING ERRCODE = '42501';
  END IF;
  PERFORM biblib.account_write_allowed();
  SELECT * INTO asset FROM biblib.media_assets AS a WHERE a.id = p_asset_id AND a.user_id = owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF EXISTS (SELECT 1 FROM biblib.profiles AS p WHERE p.user_id = owner_id AND p.avatar_asset_id = asset.id)
    OR EXISTS (SELECT 1 FROM biblib.locations AS l WHERE l.user_id = owner_id AND l.photo_asset_id = asset.id)
    OR EXISTS (SELECT 1 FROM biblib.bibliographic_evidence AS e WHERE e.user_id = owner_id AND e.photo_asset_id = asset.id) THEN
    RETURN jsonb_build_object('status', 'referenced');
  END IF;
  DELETE FROM biblib.media_assets AS a WHERE a.id = asset.id;
  RETURN jsonb_build_object('status', 'discarded', 'storage_key', asset.storage_key);
END;
$$;
--> statement-breakpoint
-- Candidatos de purga (servidor o script administrativo; `p_owner` nulo = todas las cuentas): cuarentenas vencidas,
-- assets listos que nada cita durante el periodo de gracia (ni una versión anterior) y objetos del bucket sin asset.
CREATE FUNCTION "biblib"."media_asset_purge_candidates"(p_owner uuid, p_limit integer, p_grace_seconds integer) RETURNS jsonb
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
    SELECT a.id, a.user_id, a.storage_key, CASE WHEN a.state = 'quarantine' THEN 'quarantine' ELSE 'unreferenced' END AS reason
    FROM biblib.media_assets AS a
    WHERE (p_owner IS NULL OR a.user_id = p_owner) AND (
      (a.state = 'quarantine' AND a.expires_at <= now_at)
      OR (a.state = 'ready' AND a.updated_at <= now_at - grace
        AND NOT EXISTS (SELECT 1 FROM biblib.profiles AS p WHERE p.user_id = a.user_id AND p.avatar_asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM biblib.locations AS l WHERE l.user_id = a.user_id AND l.photo_asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM biblib.bibliographic_evidence AS e WHERE e.user_id = a.user_id AND e.photo_asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM biblib.library_snapshot_chunks AS sc WHERE sc.user_id = a.user_id AND sc.kind IN ('books', 'locations')
          AND strpos(sc.payload::text, a.id::text) > 0)))
    ORDER BY a.updated_at
    LIMIT max_rows
  ) AS c;
  SELECT coalesce(jsonb_agg(jsonb_build_object('owner', split_part(o.name, '/', 1), 'key', o.name)), '[]'::jsonb) INTO objects
  FROM (
    SELECT so.name FROM storage.objects AS so
    WHERE so.bucket_id = 'biblib-media' AND (p_owner IS NULL OR so.name LIKE p_owner::text || '/%')
      AND so.created_at <= now_at - interval '10 minutes'
      AND NOT EXISTS (SELECT 1 FROM biblib.media_assets AS a WHERE a.storage_key = so.name)
    ORDER BY so.created_at
    LIMIT max_rows
  ) AS o;
  RETURN jsonb_build_object('assets', assets, 'objects', objects);
END;
$$;
--> statement-breakpoint
-- Retira las filas candidatas que siguen siéndolo bajo bloqueo (algo pudo citarlas entretanto). Devuelve sus rutas.
CREATE FUNCTION "biblib"."media_asset_purge_confirm"(p_owner uuid, p_ids uuid[], p_grace_seconds integer) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  grace interval := greatest(0, coalesce(p_grace_seconds, 86400)) * interval '1 second';
  keys text[];
BEGIN
  PERFORM 1 FROM biblib.media_assets AS a WHERE a.id = ANY(p_ids) AND (p_owner IS NULL OR a.user_id = p_owner) FOR UPDATE;
  WITH removed AS (
    DELETE FROM biblib.media_assets AS a
    WHERE a.id = ANY(p_ids) AND (p_owner IS NULL OR a.user_id = p_owner) AND (
      (a.state = 'quarantine' AND a.expires_at <= now_at)
      OR (a.state = 'ready' AND a.updated_at <= now_at - grace
        AND NOT EXISTS (SELECT 1 FROM biblib.profiles AS p WHERE p.user_id = a.user_id AND p.avatar_asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM biblib.locations AS l WHERE l.user_id = a.user_id AND l.photo_asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM biblib.bibliographic_evidence AS e WHERE e.user_id = a.user_id AND e.photo_asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM biblib.library_snapshot_chunks AS sc WHERE sc.user_id = a.user_id AND sc.kind IN ('books', 'locations')
          AND strpos(sc.payload::text, a.id::text) > 0)))
    RETURNING a.storage_key
  )
  SELECT coalesce(array_agg(r.storage_key), '{}'::text[]) INTO keys FROM removed AS r;
  RETURN keys;
END;
$$;
--> statement-breakpoint
-- Bucket privado y políticas de storage.objects. Una sola definición: la ejecuta esta migración y la repite
-- db:restore:local, porque el restore recrea el esquema biblib y con él caen estas políticas.
CREATE FUNCTION "biblib"."media_storage_install"() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('biblib-media', 'biblib-media', false, 5242880, ARRAY['image/webp'])
  ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  DROP POLICY IF EXISTS "biblib_media_select_own" ON storage.objects;
  DROP POLICY IF EXISTS "biblib_media_insert_own" ON storage.objects;
  DROP POLICY IF EXISTS "biblib_media_delete_own" ON storage.objects;
  CREATE POLICY "biblib_media_select_own" ON storage.objects AS PERMISSIVE FOR SELECT TO authenticated
    USING (bucket_id = 'biblib-media' AND biblib.media_object_access(name, 'select'));
  CREATE POLICY "biblib_media_insert_own" ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'biblib-media' AND biblib.media_object_access(name, 'insert'));
  CREATE POLICY "biblib_media_delete_own" ON storage.objects AS PERMISSIVE FOR DELETE TO authenticated
    USING (bucket_id = 'biblib-media' AND biblib.media_object_access(name, 'delete'));
END;
$$;
--> statement-breakpoint
SELECT "biblib"."media_storage_install"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."media_storage_install"(), "biblib"."media_asset_purge_candidates"(uuid, integer, integer), "biblib"."media_asset_purge_confirm"(uuid, uuid[], integer) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."media_object_access"(text, text), "biblib"."media_asset_begin_upload"(text), "biblib"."media_asset_register"(uuid, text, integer, integer, integer), "biblib"."media_asset_discard"(uuid) FROM PUBLIC, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "biblib"."media_object_access"(text, text), "biblib"."media_asset_begin_upload"(text), "biblib"."media_asset_register"(uuid, text, integer, integer, integer), "biblib"."media_asset_discard"(uuid) TO authenticated;
--> statement-breakpoint
-- Evidencia tal como la guarda una versión anterior: sin las claves nulas, sin tocar las afirmaciones por campo.
CREATE FUNCTION "biblib"."evidence_snapshot_item"(p_row biblib.bibliographic_evidence) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  RETURN jsonb_build_object('id', p_row.id, 'source_kind', p_row.source_kind, 'field_claims', p_row.field_claims, 'confidence', p_row.confidence, 'origin', p_row.origin)
    || CASE WHEN p_row.source_ref IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('source_ref', p_row.source_ref) END
    || CASE WHEN p_row.source_url IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('source_url', p_row.source_url) END
    || CASE WHEN p_row.photo_asset_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('photo_asset_id', p_row.photo_asset_id) END
    || CASE WHEN p_row.observed_at IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('observed_at', p_row.observed_at) END;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."evidence_snapshot_item"(biblib.bibliographic_evidence) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
-- Versiones anteriores (schema_version 3): cada ejemplar conserva además su nota, valoración y etiquetas, su ubicación,
-- la serie de su edición y las evidencias de ejemplar y de edición; las etiquetas, ubicaciones y series de la cuenta van
-- en trozos propios tras los libros. El hash final y los trozos siguen el mismo cálculo que 0006.
CREATE OR REPLACE FUNCTION "biblib"."library_snapshot_capture"(p_operation_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  now_at timestamptz := clock_timestamp();
  captured uuid;
  new_id uuid;
  book_total integer;
  shelf_total integer;
  tag_total integer;
  location_total integer;
  series_total integer;
  shelf_chunks integer;
  book_chunks integer;
  tag_chunks integer;
  location_chunks integer;
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
  captured := biblib.lock_library();
  DELETE FROM biblib.library_snapshots AS s WHERE s.user_id = owner_id AND s.expires_at <= now_at;
  IF (SELECT count(*) FROM biblib.library_snapshots AS s WHERE s.user_id = owner_id) >= 10 THEN
    RAISE EXCEPTION 'Cuota de versiones anteriores agotada' USING ERRCODE = 'BS001';
  END IF;
  SELECT count(*) INTO book_total FROM biblib.copies AS c WHERE c.user_id = owner_id;
  SELECT count(*) INTO shelf_total FROM biblib.shelves AS sh WHERE sh.user_id = owner_id;
  SELECT count(*) INTO tag_total FROM biblib.tags AS t WHERE t.user_id = owner_id;
  SELECT count(*) INTO location_total FROM biblib.locations AS l WHERE l.user_id = owner_id;
  SELECT count(*) INTO series_total FROM biblib.series AS se WHERE se.user_id = owner_id;
  IF book_total > 10000 OR shelf_total > 1000 THEN
    RAISE EXCEPTION 'Colección demasiado grande para guardar una versión anterior' USING ERRCODE = 'BS003';
  END IF;
  INSERT INTO biblib.library_snapshots AS s (user_id, source_operation_id, reason, captured_revision, schema_version, state, expires_at, created_at)
  VALUES (owner_id, p_operation_id, p_reason, captured, 3, 'capturing', now_at + interval '30 days', now_at)
  RETURNING s.id INTO new_id;
  shelf_chunks := (shelf_total + 199) / 200;
  book_chunks := (book_total + 199) / 200;
  tag_chunks := (tag_total + 199) / 200;
  location_chunks := (location_total + 199) / 200;
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
        jsonb_build_object('id', b.id, 'isbn', b.isbn13, 'title', b.title, 'subtitle', b.subtitle, 'authors', b.authors, 'publishers', b.publishers,
          'catalogue', b.catalogue, 'number_of_pages', b.number_of_pages, 'publish_date', b.publish_date, 'cover_small', b.cover_small,
          'cover_medium', b.cover_medium, 'cover_large', b.cover_large, 'status', b.status, 'shelf_id', b.shelf_id, 'created_at', b.created_at,
          'edition_id', b.edition_id, 'verification', b.edition_verification)
          || CASE WHEN b.cover_asset_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cover_asset_id', b.cover_asset_id) END
          || CASE WHEN b.legacy_identifier IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('legacy_identifier', b.legacy_identifier) END
          || CASE WHEN b.work_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('work_id', b.work_id, 'work_title', b.work_title) END
          || CASE WHEN b.language IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('language', b.language) END
          || CASE WHEN b.identifiers = '{}'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('identifiers', b.identifiers) END
          || CASE WHEN ann.notes IS NULL AND ann.rating IS NULL AND ct.tag_ids IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('personal', jsonb_strip_nulls(jsonb_build_object('notes', ann.notes, 'rating', ann.rating, 'tag_ids', ct.tag_ids))) END
          || CASE WHEN cl.location_id IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('location', jsonb_strip_nulls(jsonb_build_object('location_id', cl.location_id, 'shelf_label', cl.shelf_label, 'position', cl.position))) END
          || CASE WHEN se.series_id IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('series', jsonb_strip_nulls(jsonb_build_object('series_id', se.series_id, 'position', trim_scale(se.position)::text, 'volume_label', se.volume_label, 'order_note', se.order_note))) END
          || CASE WHEN ce.items IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('evidence', ce.items) END
          || CASE WHEN ee.items IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('edition_evidence', ee.items) END AS item
      FROM biblib.books AS b
      LEFT JOIN biblib.copy_annotations AS ann ON ann.user_id = b.user_id AND ann.copy_id = b.id
      LEFT JOIN LATERAL (SELECT jsonb_agg(t.tag_id ORDER BY t.tag_id) AS tag_ids FROM biblib.copy_tags AS t WHERE t.user_id = b.user_id AND t.copy_id = b.id) AS ct ON true
      LEFT JOIN biblib.copy_locations AS cl ON cl.user_id = b.user_id AND cl.copy_id = b.id
      LEFT JOIN biblib.series_editions AS se ON se.user_id = b.user_id AND se.edition_id = b.edition_id
      LEFT JOIN LATERAL (SELECT jsonb_agg(biblib.evidence_snapshot_item(ev) ORDER BY ev.created_at, ev.id) AS items
        FROM biblib.bibliographic_evidence AS ev WHERE ev.user_id = b.user_id AND ev.copy_id = b.id) AS ce ON true
      LEFT JOIN LATERAL (SELECT jsonb_agg(biblib.evidence_snapshot_item(ev) ORDER BY ev.created_at, ev.id) AS items
        FROM biblib.bibliographic_evidence AS ev WHERE ev.user_id = b.user_id AND ev.edition_id = b.edition_id) AS ee ON true
      WHERE b.user_id = owner_id
    ) AS ranked
    GROUP BY ranked.rn / 200
    UNION ALL
    SELECT shelf_chunks + book_chunks + (ranked.rn / 200)::integer, 'tags', count(*)::integer, jsonb_agg(ranked.item ORDER BY ranked.rn)
    FROM (
      SELECT row_number() OVER (ORDER BY t.created_at, t.id) - 1 AS rn, jsonb_build_object('id', t.id, 'name', t.name, 'created_at', t.created_at) AS item
      FROM biblib.tags AS t WHERE t.user_id = owner_id
    ) AS ranked
    GROUP BY ranked.rn / 200
    UNION ALL
    SELECT shelf_chunks + book_chunks + tag_chunks + (ranked.rn / 200)::integer, 'locations', count(*)::integer, jsonb_agg(ranked.item ORDER BY ranked.rn)
    FROM (
      SELECT row_number() OVER (ORDER BY l.created_at, l.id) - 1 AS rn,
        jsonb_build_object('id', l.id, 'parent_id', l.parent_id, 'name', l.name, 'kind', l.kind, 'photo_asset_id', l.photo_asset_id, 'created_at', l.created_at) AS item
      FROM biblib.locations AS l WHERE l.user_id = owner_id
    ) AS ranked
    GROUP BY ranked.rn / 200
    UNION ALL
    SELECT shelf_chunks + book_chunks + tag_chunks + location_chunks + (ranked.rn / 200)::integer, 'series', count(*)::integer, jsonb_agg(ranked.item ORDER BY ranked.rn)
    FROM (
      SELECT row_number() OVER (ORDER BY se.created_at, se.id) - 1 AS rn,
        jsonb_build_object('id', se.id, 'title', se.title, 'description', se.description, 'created_at', se.created_at) AS item
      FROM biblib.series AS se WHERE se.user_id = owner_id
    ) AS ranked
    GROUP BY ranked.rn / 200
  ) AS grouped;
  SELECT count(*)::integer, coalesce(sum(octet_length(c.payload::text)), 0),
    encode(sha256(convert_to(concat_ws('|', 'biblib.snapshot.v1', book_total, shelf_total, coalesce(string_agg(c.digest, '' ORDER BY c.seq), '')), 'UTF8')), 'hex')
  INTO chunk_total, byte_total, final_digest
  FROM biblib.library_snapshot_chunks AS c WHERE c.snapshot_id = new_id;
  UPDATE biblib.library_snapshots AS s
  SET state = 'ready', digest = final_digest,
    counts = jsonb_build_object('books', book_total, 'shelves', shelf_total, 'tags', tag_total, 'locations', location_total, 'series', series_total,
      'chunks', chunk_total, 'bytes', byte_total)
  WHERE s.id = new_id;
  RETURN jsonb_build_object('id', new_id, 'digest', final_digest, 'books', book_total, 'shelves', shelf_total, 'chunks', chunk_total);
END;
$$;
--> statement-breakpoint
-- IDs de una versión propia (ejemplares, sus ediciones y obras, estanterías, etiquetas, ubicaciones, series y
-- evidencias) que hoy usa otra cuenta: la restauración les asigna otro.
CREATE OR REPLACE FUNCTION "biblib"."library_snapshot_foreign_ids"(p_snapshot_id uuid) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  found uuid[];
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'library_snapshot_foreign_ids requiere una sesión' USING ERRCODE = '42501';
  END IF;
  WITH entry AS (
    SELECT c.kind, item, (item->>'id')::uuid AS id, coalesce(item->>'edition_id', item->>'id')::uuid AS edition_id, (item->>'work_id')::uuid AS work_id
    FROM biblib.library_snapshot_chunks AS c CROSS JOIN LATERAL jsonb_array_elements(c.payload) AS item
    WHERE c.snapshot_id = p_snapshot_id AND c.user_id = owner_id
  ), evidence AS (
    SELECT (ev->>'id')::uuid AS id FROM entry CROSS JOIN LATERAL jsonb_array_elements(coalesce(entry.item->'evidence', '[]'::jsonb) || coalesce(entry.item->'edition_evidence', '[]'::jsonb)) AS ev
    WHERE entry.kind = 'books'
  ), taken AS (
    SELECT entry.id FROM entry WHERE entry.kind = 'books' AND EXISTS (SELECT 1 FROM biblib.copies AS cp WHERE cp.id = entry.id AND cp.user_id <> owner_id)
    UNION
    SELECT entry.edition_id FROM entry WHERE entry.kind = 'books' AND EXISTS (SELECT 1 FROM biblib.editions AS e WHERE e.id = entry.edition_id AND e.user_id <> owner_id)
    UNION
    SELECT entry.work_id FROM entry WHERE entry.kind = 'books' AND entry.work_id IS NOT NULL AND EXISTS (SELECT 1 FROM biblib.works AS w WHERE w.id = entry.work_id AND w.user_id <> owner_id)
    UNION
    SELECT entry.id FROM entry WHERE entry.kind = 'shelves' AND EXISTS (SELECT 1 FROM biblib.shelves AS sh WHERE sh.id = entry.id AND sh.user_id <> owner_id)
    UNION
    SELECT entry.id FROM entry WHERE entry.kind = 'tags' AND EXISTS (SELECT 1 FROM biblib.tags AS t WHERE t.id = entry.id AND t.user_id <> owner_id)
    UNION
    SELECT entry.id FROM entry WHERE entry.kind = 'locations' AND EXISTS (SELECT 1 FROM biblib.locations AS l WHERE l.id = entry.id AND l.user_id <> owner_id)
    UNION
    SELECT entry.id FROM entry WHERE entry.kind = 'series' AND EXISTS (SELECT 1 FROM biblib.series AS se WHERE se.id = entry.id AND se.user_id <> owner_id)
    UNION
    SELECT evidence.id FROM evidence WHERE EXISTS (SELECT 1 FROM biblib.bibliographic_evidence AS ev WHERE ev.id = evidence.id AND ev.user_id <> owner_id)
  )
  SELECT coalesce(array_agg(taken.id ORDER BY taken.id), '{}'::uuid[]) INTO found FROM taken;
  RETURN found;
END;
$$;
--> statement-breakpoint
-- Eliminación de cuenta (U-OPS-03): los datos de producto se retiran en `product` (hijas antes que padres) y las imágenes
-- en `media`, tras sus referencias y antes de los ejemplares. Cada tabla privada nueva tiene su paso aquí, en
-- lib/account-deletion y en docs/retencion.md.
CREATE OR REPLACE FUNCTION "biblib"."account_deletion_step_tables"(p_step text) RETURNS text[]
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
    WHEN 'product' THEN ARRAY['review_decisions', 'review_issues', 'bibliographic_evidence', 'copy_tags', 'copy_annotations', 'copy_locations', 'series_editions', 'tags', 'locations', 'series', 'csv_mapping_profiles', 'profiles']
    WHEN 'media' THEN ARRAY['media_assets']
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
CREATE OR REPLACE FUNCTION "biblib"."account_deletion_advance"(p_owner uuid, p_token uuid, p_step text, p_counts jsonb, p_lease_ms integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  steps text[] := ARRAY['sessions', 'storage', 'covers', 'snapshots', 'staging', 'jobs', 'views', 'previews', 'operations', 'private_cache', 'product', 'media', 'copies', 'editions', 'works', 'shelves', 'state', 'auth', 'verify'];
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
-- Un lote de un paso de base de datos, bajo el lease. Las ubicaciones se retiran de las hojas hacia la raíz (la FK con
-- su padre no admite retirar una ubicación que aún contiene otras).
CREATE OR REPLACE FUNCTION "biblib"."account_deletion_purge"(p_owner uuid, p_token uuid, p_step text, p_limit integer) RETURNS integer
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
    IF item = 'locations' THEN
      DELETE FROM biblib.locations AS t WHERE t.ctid = ANY(ARRAY(SELECT s.ctid FROM biblib.locations AS s WHERE s.user_id = p_owner
        AND NOT EXISTS (SELECT 1 FROM biblib.locations AS child WHERE child.user_id = s.user_id AND child.parent_id = s.id) LIMIT max_rows));
    ELSE
      SELECT CASE WHEN bool_or(a.attname = 'owner_id') THEN 'owner_id' ELSE 'user_id' END INTO owner_column
      FROM pg_attribute AS a WHERE a.attrelid = format('biblib.%I', item)::regclass AND a.attname IN ('owner_id', 'user_id') AND NOT a.attisdropped;
      EXECUTE format('DELETE FROM biblib.%I AS t WHERE t.ctid = ANY(ARRAY(SELECT s.ctid FROM biblib.%I AS s WHERE s.%I = $1 LIMIT $2))', item, item, owner_column)
        USING p_owner, max_rows;
    END IF;
    GET DIAGNOSTICS removed = ROW_COUNT;
    IF removed > 0 THEN
      RETURN removed;
    END IF;
  END LOOP;
  RETURN 0;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."account_deletion_step_tables"(text), "biblib"."account_deletion_advance"(uuid, uuid, text, jsonb, integer),
  "biblib"."account_deletion_purge"(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
-- U-DAT-07: la procedencia actual se convierte en evidencia inicial (`origin = 'backfill'`), sin fabricar URL ni foto.
-- Cada edición recibe una evidencia con su fuente: los proveedores bibliográficos quedan como `bibliographic_match` y el
-- resto (manual, foto sin asset, importación) como `provisional`; la URL solo si ya constaba y la procedencia por campo
-- como afirmaciones. Cada ejemplar con comprobación física humana recibe la suya (`physically_checked`), con la fecha
-- solo si se registró. Ningún proveedor ni checksum crea una comprobación física.
INSERT INTO "biblib"."bibliographic_evidence" (user_id, edition_id, source_kind, source_ref, source_url, field_claims, confidence, origin, created_at, updated_at)
SELECT e.user_id, e.id,
  CASE WHEN e.catalogue->>'source' IN ('open-library', 'bne', 'google-books') THEN 'provider' WHEN e.catalogue->>'source' = 'photo' THEN 'photo'
    WHEN e.catalogue->>'source' = 'manual' THEN 'manual' ELSE 'import' END,
  CASE WHEN e.catalogue->>'source' IN ('open-library', 'bne', 'google-books') THEN e.catalogue->>'source' END,
  CASE WHEN e.catalogue->>'sourceUrl' ~ '^https?://' AND char_length(e.catalogue->>'sourceUrl') <= 2048 THEN e.catalogue->>'sourceUrl' END,
  CASE WHEN jsonb_typeof(e.catalogue->'fields') = 'object' AND octet_length((e.catalogue->'fields')::text) <= 16384
    THEN jsonb_build_object('fields', e.catalogue->'fields') ELSE '{}'::jsonb END,
  CASE WHEN e.catalogue->>'source' IN ('open-library', 'bne', 'google-books') THEN 'bibliographic_match' ELSE 'provisional' END,
  'backfill', now(), now()
FROM "biblib"."editions" AS e;
--> statement-breakpoint
INSERT INTO "biblib"."bibliographic_evidence" (user_id, copy_id, source_kind, observed_at, field_claims, confidence, origin, created_at, updated_at)
SELECT c.user_id, c.id, 'manual',
  CASE WHEN c.edition_verification->>'checkedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
    THEN (c.edition_verification->>'checkedAt')::timestamptz END,
  jsonb_build_object('isbnVerified', true), 'physically_checked', 'backfill', now(), now()
FROM "biblib"."copies" AS c
WHERE c.edition_verification->'isbnVerified' = 'true'::jsonb;

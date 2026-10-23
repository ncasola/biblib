CREATE TABLE "biblib"."library_snapshot_chunks" (
	"snapshot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"item_count" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" text NOT NULL,
	CONSTRAINT "library_snapshot_chunks_pkey" PRIMARY KEY("snapshot_id","seq"),
	CONSTRAINT "library_snapshot_chunks_kind_check" CHECK ("biblib"."library_snapshot_chunks"."kind" in ('shelves', 'books')),
	CONSTRAINT "library_snapshot_chunks_seq_check" CHECK ("biblib"."library_snapshot_chunks"."seq" >= 0),
	CONSTRAINT "library_snapshot_chunks_size_check" CHECK ("biblib"."library_snapshot_chunks"."item_count" between 1 and 200 and jsonb_typeof("biblib"."library_snapshot_chunks"."payload") = 'array' and jsonb_array_length("biblib"."library_snapshot_chunks"."payload") = "biblib"."library_snapshot_chunks"."item_count"),
	CONSTRAINT "library_snapshot_chunks_digest_check" CHECK ("biblib"."library_snapshot_chunks"."digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "biblib"."library_snapshot_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."library_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_operation_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"captured_revision" uuid NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'capturing' NOT NULL,
	"counts" jsonb DEFAULT '{"books":0,"shelves":0,"chunks":0,"bytes":0}'::jsonb NOT NULL,
	"digest" text,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_snapshots_reason_check" CHECK ("biblib"."library_snapshots"."reason" in ('import.replace', 'snapshot.restore')),
	CONSTRAINT "library_snapshots_state_check" CHECK ("biblib"."library_snapshots"."state" in ('capturing', 'ready')),
	CONSTRAINT "library_snapshots_digest_check" CHECK ("biblib"."library_snapshots"."digest" is null or "biblib"."library_snapshots"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "library_snapshots_ready_check" CHECK ("biblib"."library_snapshots"."state" <> 'ready' or "biblib"."library_snapshots"."digest" is not null),
	CONSTRAINT "library_snapshots_counts_check" CHECK (jsonb_typeof("biblib"."library_snapshots"."counts") = 'object'),
	CONSTRAINT "library_snapshots_schema_version_check" CHECK ("biblib"."library_snapshots"."schema_version" >= 1),
	CONSTRAINT "library_snapshots_expiry_check" CHECK ("biblib"."library_snapshots"."expires_at" > "biblib"."library_snapshots"."created_at")
);
--> statement-breakpoint
ALTER TABLE "biblib"."library_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "biblib"."library_operations" DROP CONSTRAINT "library_operations_operation_check";--> statement-breakpoint
ALTER TABLE "biblib"."import_previews" ALTER COLUMN "payload" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "biblib"."import_previews" ADD COLUMN "snapshot_id" uuid;--> statement-breakpoint
-- Las FK compuestas con propietario necesitan antes los índices únicos (user_id, id) de su destino.
CREATE UNIQUE INDEX "library_operations_user_id_id_unique" ON "biblib"."library_operations" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_snapshots_user_id_id_unique" ON "biblib"."library_snapshots" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_snapshots_operation_unique" ON "biblib"."library_snapshots" USING btree ("user_id","source_operation_id");--> statement-breakpoint
CREATE INDEX "library_snapshots_user_id_created_at_idx" ON "biblib"."library_snapshots" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "library_snapshots_expires_at_idx" ON "biblib"."library_snapshots" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "biblib"."library_snapshot_chunks" ADD CONSTRAINT "library_snapshot_chunks_owner_snapshot_fk" FOREIGN KEY ("user_id","snapshot_id") REFERENCES "biblib"."library_snapshots"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."library_snapshots" ADD CONSTRAINT "library_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."library_snapshots" ADD CONSTRAINT "library_snapshots_owner_operation_fk" FOREIGN KEY ("user_id","source_operation_id") REFERENCES "biblib"."library_operations"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."import_previews" ADD CONSTRAINT "import_previews_owner_snapshot_fk" FOREIGN KEY ("user_id","snapshot_id") REFERENCES "biblib"."library_snapshots"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_previews_snapshot_id_idx" ON "biblib"."import_previews" USING btree ("user_id","snapshot_id") WHERE "biblib"."import_previews"."snapshot_id" is not null;--> statement-breakpoint
-- Tarea T8 de U-QA-03 (informe de rendimiento del 23-10-2026, §6): índices de lectura 1–3, aditivos.
-- Retirada: DROP INDEX de cada uno en una migración posterior; books_user_id_idx se conserva.
CREATE INDEX "books_user_title_idx" ON "biblib"."books" USING btree ("user_id","title","id");--> statement-breakpoint
CREATE INDEX "books_user_shelf_title_idx" ON "biblib"."books" USING btree ("user_id","shelf_id","title","id");--> statement-breakpoint
CREATE INDEX "books_user_created_idx" ON "biblib"."books" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "biblib"."import_previews" ADD CONSTRAINT "import_previews_source_check" CHECK (("biblib"."import_previews"."payload" is null) <> ("biblib"."import_previews"."snapshot_id" is null));--> statement-breakpoint
ALTER TABLE "biblib"."library_operations" ADD CONSTRAINT "library_operations_operation_check" CHECK ("biblib"."library_operations"."operation" in ('import.confirm', 'snapshot.restore'));--> statement-breakpoint
CREATE POLICY "library_snapshot_chunks_select_own" ON "biblib"."library_snapshot_chunks" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid() = "biblib"."library_snapshot_chunks"."user_id"));--> statement-breakpoint
CREATE POLICY "library_snapshots_select_own" ON "biblib"."library_snapshots" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid() = "biblib"."library_snapshots"."user_id"));
--> statement-breakpoint
-- U-DAT-02: versiones anteriores de la colección. authenticated solo lee sus filas; capturar,
-- comprobar IDs ocupados y borrar pasan por estas funciones (SECURITY DEFINER, search_path fijo,
-- dueño siempre de auth.uid()). Límites iniciales: 10 versiones vigentes por cuenta, 30 días,
-- 10 000 libros y 1 000 estanterías por versión, trozos de 200 filas.
-- Captura el estado vigente antes de que la operación p_operation_id lo sustituya. Solo dentro de
-- la transacción que registró esa operación: la versión y la publicación se confirman juntas o no
-- se confirma ninguna. Cuota agotada, colección demasiado grande o cuenta bloqueada abortan la
-- operación destructiva; nunca se borra en silencio una versión vigente para hacer sitio.
CREATE FUNCTION "biblib"."library_snapshot_capture"(p_operation_id uuid, p_reason text) RETURNS jsonb
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
          'cover_medium', b.cover_medium, 'cover_large', b.cover_large, 'status', b.status, 'shelf_id', b.shelf_id, 'created_at', b.created_at) AS item
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
-- IDs de una versión propia que hoy usa otra cuenta: la restauración los reasigna e informa sin
-- revelar el titular. Solo consulta IDs que el servidor guardó en la versión del dueño.
CREATE FUNCTION "biblib"."library_snapshot_foreign_ids"(p_snapshot_id uuid) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  found uuid[];
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'library_snapshot_foreign_ids requiere una sesión' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(array_agg(DISTINCT entry.id ORDER BY entry.id), '{}'::uuid[]) INTO found
  FROM (
    SELECT c.kind, (item->>'id')::uuid AS id
    FROM biblib.library_snapshot_chunks AS c CROSS JOIN LATERAL jsonb_array_elements(c.payload) AS item
    WHERE c.snapshot_id = p_snapshot_id AND c.user_id = owner_id
  ) AS entry
  WHERE (entry.kind = 'books' AND EXISTS (SELECT 1 FROM biblib.books AS b WHERE b.id = entry.id AND b.user_id <> owner_id))
    OR (entry.kind = 'shelves' AND EXISTS (SELECT 1 FROM biblib.shelves AS sh WHERE sh.id = entry.id AND sh.user_id <> owner_id));
  RETURN found;
END;
$$;
--> statement-breakpoint
-- Borrado explícito con la versión vista por el dueño. Toma el bloqueo de colección: espera a una
-- restauración en curso y borra en cascada los trozos y las vistas previas de restauración.
CREATE FUNCTION "biblib"."library_snapshot_delete"(p_snapshot_id uuid, p_expected_version uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  current_version uuid;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'library_snapshot_delete requiere una sesión' USING ERRCODE = '42501';
  END IF;
  PERFORM biblib.lock_library();
  SELECT s.version INTO current_version FROM biblib.library_snapshots AS s WHERE s.id = p_snapshot_id AND s.user_id = owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF current_version <> p_expected_version THEN
    RETURN 'conflict';
  END IF;
  DELETE FROM biblib.library_snapshots AS s WHERE s.id = p_snapshot_id AND s.user_id = owner_id;
  RETURN 'deleted';
END;
$$;
--> statement-breakpoint
-- Retirada por lotes de las versiones vencidas de todas las cuentas (mantenimiento F4/U-OPS-03).
CREATE FUNCTION "biblib"."library_snapshot_purge_expired"(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM biblib.library_snapshots AS s
  WHERE s.id IN (SELECT e.id FROM biblib.library_snapshots AS e WHERE e.expires_at <= clock_timestamp() ORDER BY e.expires_at LIMIT greatest(1, least(coalesce(p_limit, 100), 1000)));
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."library_snapshot_capture"(uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."library_snapshot_foreign_ids"(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."library_snapshot_delete"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."library_snapshot_purge_expired"(integer) FROM PUBLIC, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "biblib"."library_snapshot_capture"(uuid, text) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "biblib"."library_snapshot_foreign_ids"(uuid) TO authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "biblib"."library_snapshot_delete"(uuid, uuid) TO authenticated;
--> statement-breakpoint
-- El dueño solo lee sus versiones y trozos; ninguna escritura directa.
REVOKE ALL ON "biblib"."library_snapshots", "biblib"."library_snapshot_chunks" FROM PUBLIC, authenticated;
--> statement-breakpoint
GRANT SELECT ON "biblib"."library_snapshots", "biblib"."library_snapshot_chunks" TO authenticated;

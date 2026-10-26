-- O14 · 0015. Lote único de schema de lectura y préstamos (D): ciclos y entradas de lectura (U-PRO-02) y préstamos
-- (U-PRO-04). Todo privado por cuenta, con FK compuestas `(user_id, …)` a la copia, RLS del dueño, escritura condicionada a
-- cuenta activa (U-OPS-03), `version` por fila, límites en Postgres y su paso de eliminación de cuenta. Lectura y préstamo
-- son independientes entre sí y del estado actual del ejemplar (`copies.status`). Contrato para las unidades:
-- docs/spec-pendientes/contratos-o14.md.
--
-- Sin backfill: el estado `read` legado no se convierte en ciclos, entradas ni fechas, y nunca se usa la fecha actual para
-- rellenar el pasado. Las tablas nacen vacías y solo se llenan con lo que la persona registra o importa.
CREATE TABLE "biblib"."loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"copy_id" uuid NOT NULL,
	"borrower_label" text NOT NULL,
	"loaned_on" date NOT NULL,
	"due_on" date,
	"returned_on" date,
	"note" text,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loans_borrower_label_check" CHECK (char_length("biblib"."loans"."borrower_label") >= 1 and char_length("biblib"."loans"."borrower_label") <= 40 and "biblib"."loans"."borrower_label" = btrim("biblib"."loans"."borrower_label") and "biblib"."loans"."borrower_label" !~ '[[:cntrl:]]' and strpos("biblib"."loans"."borrower_label", '@') = 0 and char_length(regexp_replace("biblib"."loans"."borrower_label", '[^0-9]', '', 'g')) <= 6),
	CONSTRAINT "loans_dates_check" CHECK ("biblib"."loans"."loaned_on" >= '1900-01-01'::date and "biblib"."loans"."loaned_on" <= '2999-12-31'::date and ("biblib"."loans"."due_on" is null or ("biblib"."loans"."due_on" >= "biblib"."loans"."loaned_on" and "biblib"."loans"."due_on" <= '2999-12-31'::date)) and ("biblib"."loans"."returned_on" is null or ("biblib"."loans"."returned_on" >= "biblib"."loans"."loaned_on" and "biblib"."loans"."returned_on" <= '2999-12-31'::date))),
	CONSTRAINT "loans_note_check" CHECK ("biblib"."loans"."note" is null or (char_length("biblib"."loans"."note") >= 1 and char_length("biblib"."loans"."note") <= 500))
);
--> statement-breakpoint
ALTER TABLE "biblib"."loans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."reading_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"copy_id" uuid NOT NULL,
	"cycle_number" integer NOT NULL,
	"status" text DEFAULT 'reading' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_cycles_status_check" CHECK ("biblib"."reading_cycles"."status" in ('reading', 'paused', 'finished', 'abandoned')),
	CONSTRAINT "reading_cycles_number_check" CHECK ("biblib"."reading_cycles"."cycle_number" >= 1 and "biblib"."reading_cycles"."cycle_number" <= 1000),
	CONSTRAINT "reading_cycles_open_check" CHECK ("biblib"."reading_cycles"."status" in ('finished', 'abandoned') or "biblib"."reading_cycles"."finished_at" is null),
	CONSTRAINT "reading_cycles_dates_check" CHECK ("biblib"."reading_cycles"."started_at" is null or "biblib"."reading_cycles"."finished_at" is null or "biblib"."reading_cycles"."finished_at" >= "biblib"."reading_cycles"."started_at")
);
--> statement-breakpoint
ALTER TABLE "biblib"."reading_cycles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "biblib"."reading_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"page_from" integer,
	"page_to" integer,
	"note" text,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_entries_pages_check" CHECK (("biblib"."reading_entries"."page_from" is null or ("biblib"."reading_entries"."page_from" >= 0 and "biblib"."reading_entries"."page_from" <= 100000)) and ("biblib"."reading_entries"."page_to" is null or ("biblib"."reading_entries"."page_to" >= 0 and "biblib"."reading_entries"."page_to" <= 100000)) and ("biblib"."reading_entries"."page_from" is null or ("biblib"."reading_entries"."page_to" is not null and "biblib"."reading_entries"."page_from" <= "biblib"."reading_entries"."page_to"))),
	CONSTRAINT "reading_entries_content_check" CHECK ("biblib"."reading_entries"."page_to" is not null or "biblib"."reading_entries"."note" is not null),
	CONSTRAINT "reading_entries_note_check" CHECK ("biblib"."reading_entries"."note" is null or (char_length("biblib"."reading_entries"."note") >= 1 and char_length("biblib"."reading_entries"."note") <= 1000))
);
--> statement-breakpoint
ALTER TABLE "biblib"."reading_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Índices antes de las FK compuestas: (user_id, id) es el destino de las FK con propietario.
CREATE UNIQUE INDEX "loans_user_id_id_unique" ON "biblib"."loans" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "loans_active_unique" ON "biblib"."loans" USING btree ("user_id","copy_id") WHERE "biblib"."loans"."returned_on" is null;--> statement-breakpoint
CREATE INDEX "loans_copy_idx" ON "biblib"."loans" USING btree ("user_id","copy_id","loaned_on");--> statement-breakpoint
CREATE UNIQUE INDEX "reading_cycles_user_id_id_unique" ON "biblib"."reading_cycles" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "reading_cycles_copy_number_unique" ON "biblib"."reading_cycles" USING btree ("user_id","copy_id","cycle_number");--> statement-breakpoint
CREATE UNIQUE INDEX "reading_cycles_open_unique" ON "biblib"."reading_cycles" USING btree ("user_id","copy_id") WHERE "biblib"."reading_cycles"."status" in ('reading', 'paused');--> statement-breakpoint
CREATE UNIQUE INDEX "reading_entries_user_id_id_unique" ON "biblib"."reading_entries" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "reading_entries_cycle_idx" ON "biblib"."reading_entries" USING btree ("user_id","cycle_id","occurred_at");--> statement-breakpoint
ALTER TABLE "biblib"."loans" ADD CONSTRAINT "loans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."loans" ADD CONSTRAINT "loans_owner_copy_fk" FOREIGN KEY ("user_id","copy_id") REFERENCES "biblib"."copies"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."reading_cycles" ADD CONSTRAINT "reading_cycles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."reading_cycles" ADD CONSTRAINT "reading_cycles_owner_copy_fk" FOREIGN KEY ("user_id","copy_id") REFERENCES "biblib"."copies"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."reading_entries" ADD CONSTRAINT "reading_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biblib"."reading_entries" ADD CONSTRAINT "reading_entries_owner_cycle_fk" FOREIGN KEY ("user_id","cycle_id") REFERENCES "biblib"."reading_cycles"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "loans_select_own" ON "biblib"."loans" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."loans"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "loans_insert_own" ON "biblib"."loans" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."loans"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "loans_update_own" ON "biblib"."loans" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("biblib"."loans"."user_id" = (select auth.uid())) WITH CHECK ("biblib"."loans"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "loans_delete_own" ON "biblib"."loans" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."loans"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "loans_insert_active" ON "biblib"."loans" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "loans_update_active" ON "biblib"."loans" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "loans_delete_active" ON "biblib"."loans" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "reading_cycles_select_own" ON "biblib"."reading_cycles" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."reading_cycles"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "reading_cycles_insert_own" ON "biblib"."reading_cycles" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."reading_cycles"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "reading_cycles_update_own" ON "biblib"."reading_cycles" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("biblib"."reading_cycles"."user_id" = (select auth.uid())) WITH CHECK ("biblib"."reading_cycles"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "reading_cycles_delete_own" ON "biblib"."reading_cycles" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."reading_cycles"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "reading_cycles_insert_active" ON "biblib"."reading_cycles" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "reading_cycles_update_active" ON "biblib"."reading_cycles" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "reading_cycles_delete_active" ON "biblib"."reading_cycles" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "reading_entries_select_own" ON "biblib"."reading_entries" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("biblib"."reading_entries"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "reading_entries_insert_own" ON "biblib"."reading_entries" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("biblib"."reading_entries"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "reading_entries_update_own" ON "biblib"."reading_entries" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("biblib"."reading_entries"."user_id" = (select auth.uid())) WITH CHECK ("biblib"."reading_entries"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "reading_entries_delete_own" ON "biblib"."reading_entries" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("biblib"."reading_entries"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "reading_entries_insert_active" ON "biblib"."reading_entries" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "reading_entries_update_active" ON "biblib"."reading_entries" AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((select biblib.account_write_allowed())) WITH CHECK ((select biblib.account_write_allowed()));--> statement-breakpoint
CREATE POLICY "reading_entries_delete_active" ON "biblib"."reading_entries" AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((select biblib.account_write_allowed()));
--> statement-breakpoint
-- Privilegios. El dueño trabaja con RLS (y las políticas RESTRICTIVE de cuenta activa) sobre su lectura y sus préstamos.
REVOKE ALL ON "biblib"."reading_cycles", "biblib"."reading_entries", "biblib"."loans" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "biblib"."reading_cycles", "biblib"."reading_entries", "biblib"."loans" TO authenticated;
--> statement-breakpoint
-- Tokens y revisión de colección: como los datos de producto de 0014, toda escritura renueva la `version` de la fila y
-- rota la revisión del dueño (lectura y préstamos viajan en la exportación v2, las versiones anteriores y el reemplazo).
CREATE TRIGGER "reading_cycles_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."reading_cycles" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();
--> statement-breakpoint
CREATE TRIGGER "reading_entries_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."reading_entries" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();
--> statement-breakpoint
CREATE TRIGGER "loans_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."loans" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();
--> statement-breakpoint
CREATE TRIGGER "reading_cycles_rotate_library_revision" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."reading_cycles" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_library_revision"();
--> statement-breakpoint
CREATE TRIGGER "reading_entries_rotate_library_revision" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."reading_entries" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_library_revision"();
--> statement-breakpoint
CREATE TRIGGER "loans_rotate_library_revision" AFTER INSERT OR UPDATE OR DELETE ON "biblib"."loans" FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_library_revision"();
--> statement-breakpoint
-- Límites con `biblib.enforce_row_limit` (0014, BP001 → LIMIT_EXCEEDED): por ejemplar o ciclo y por cuenta.
CREATE TRIGGER "reading_cycles_limit_copy" BEFORE INSERT ON "biblib"."reading_cycles" FOR EACH ROW EXECUTE FUNCTION "biblib"."enforce_row_limit"('50', 'copy_id');
--> statement-breakpoint
CREATE TRIGGER "reading_cycles_limit" BEFORE INSERT ON "biblib"."reading_cycles" FOR EACH ROW EXECUTE FUNCTION "biblib"."enforce_row_limit"('20000');
--> statement-breakpoint
CREATE TRIGGER "reading_entries_limit_cycle" BEFORE INSERT ON "biblib"."reading_entries" FOR EACH ROW EXECUTE FUNCTION "biblib"."enforce_row_limit"('1000', 'cycle_id');
--> statement-breakpoint
CREATE TRIGGER "reading_entries_limit" BEFORE INSERT ON "biblib"."reading_entries" FOR EACH ROW EXECUTE FUNCTION "biblib"."enforce_row_limit"('50000');
--> statement-breakpoint
CREATE TRIGGER "loans_limit_copy" BEFORE INSERT ON "biblib"."loans" FOR EACH ROW EXECUTE FUNCTION "biblib"."enforce_row_limit"('200', 'copy_id');
--> statement-breakpoint
CREATE TRIGGER "loans_limit" BEFORE INSERT ON "biblib"."loans" FOR EACH ROW EXECUTE FUNCTION "biblib"."enforce_row_limit"('20000');
--> statement-breakpoint
-- Una entrada nunca supera el total de páginas conocido de la edición del ejemplar (BR001 → INVALID_INPUT). Con el total
-- desconocido (0) se admite y la interfaz no muestra porcentaje. Solo se comprueba al escribir páginas o mover la entrada:
-- corregir después el total de la edición no reescribe ni bloquea las entradas ya registradas.
CREATE FUNCTION "biblib"."guard_reading_entry_pages"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  total integer;
BEGIN
  IF NEW.page_to IS NULL OR (TG_OP = 'UPDATE' AND NEW.page_to IS NOT DISTINCT FROM OLD.page_to AND NEW.cycle_id IS NOT DISTINCT FROM OLD.cycle_id) THEN
    RETURN NEW;
  END IF;
  SELECT e.number_of_pages INTO total
  FROM biblib.reading_cycles AS r
  JOIN biblib.copies AS c ON c.user_id = r.user_id AND c.id = r.copy_id
  JOIN biblib.editions AS e ON e.user_id = c.user_id AND e.id = c.edition_id
  WHERE r.user_id = NEW.user_id AND r.id = NEW.cycle_id;
  IF total > 0 AND NEW.page_to > total THEN
    RAISE EXCEPTION 'La página % supera el total conocido de la edición (%)', NEW.page_to, total USING ERRCODE = 'BR001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "reading_entries_guard_pages" BEFORE INSERT OR UPDATE ON "biblib"."reading_entries" FOR EACH ROW EXECUTE FUNCTION "biblib"."guard_reading_entry_pages"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."guard_reading_entry_pages"() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
-- Funciones transaccionales de las acciones (SECURITY INVOKER: corren con la RLS y las políticas de quien llama). El dueño
-- es siempre auth.uid(); con la cuenta en eliminación, BD001. El bloqueo consultivo por ejemplar es el mismo que toma
-- `enforce_row_limit`, de modo que dos dispositivos que inician o prestan a la vez se serializan.
--
-- Inicia una lectura o relectura: un ciclo nuevo con el número siguiente. Si ya hay uno abierto (reintento tras una
-- respuesta perdida o un segundo dispositivo), lo devuelve sin crear otro. `p_started_at` nulo si no consta.
CREATE FUNCTION "biblib"."reading_cycle_start"(p_copy_id uuid, p_started_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  found_cycle biblib.reading_cycles%ROWTYPE;
  next_number integer;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'reading_cycle_start requiere una sesión' USING ERRCODE = '42501';
  END IF;
  PERFORM biblib.account_write_allowed();
  PERFORM pg_advisory_xact_lock(hashtextextended(format('biblib.%s:%s:%s', 'reading_cycles', owner_id, p_copy_id), 0));
  IF NOT EXISTS (SELECT 1 FROM biblib.copies AS c WHERE c.user_id = owner_id AND c.id = p_copy_id) THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  SELECT * INTO found_cycle FROM biblib.reading_cycles AS r WHERE r.user_id = owner_id AND r.copy_id = p_copy_id AND r.status IN ('reading', 'paused');
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'open', 'cycle_id', found_cycle.id, 'cycle_number', found_cycle.cycle_number, 'version', found_cycle.version);
  END IF;
  SELECT coalesce(max(r.cycle_number), 0) + 1 INTO next_number FROM biblib.reading_cycles AS r WHERE r.user_id = owner_id AND r.copy_id = p_copy_id;
  INSERT INTO biblib.reading_cycles (user_id, copy_id, cycle_number, status, started_at)
  VALUES (owner_id, p_copy_id, next_number, 'reading', p_started_at)
  RETURNING * INTO found_cycle;
  RETURN jsonb_build_object('status', 'started', 'cycle_id', found_cycle.id, 'cycle_number', found_cycle.cycle_number, 'version', found_cycle.version);
END;
$$;
--> statement-breakpoint
-- Cierra un ciclo abierto (terminado o abandonado) con la versión esperada. Uno ya cerrado se devuelve tal cual
-- (`already_closed`: la acción decide si es su propio reintento); otra versión, `conflict`. `p_finished_at` nulo si no consta.
CREATE FUNCTION "biblib"."reading_cycle_close"(p_cycle_id uuid, p_expected_version uuid, p_status text, p_finished_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  found_cycle biblib.reading_cycles%ROWTYPE;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'reading_cycle_close requiere una sesión' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('finished', 'abandoned') THEN
    RAISE EXCEPTION 'Estado de cierre no válido' USING ERRCODE = '22023';
  END IF;
  PERFORM biblib.account_write_allowed();
  SELECT * INTO found_cycle FROM biblib.reading_cycles AS r WHERE r.user_id = owner_id AND r.id = p_cycle_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF found_cycle.status IN ('finished', 'abandoned') THEN
    RETURN jsonb_build_object('status', 'already_closed', 'cycle_status', found_cycle.status, 'finished_at', found_cycle.finished_at, 'version', found_cycle.version);
  END IF;
  IF found_cycle.version IS DISTINCT FROM p_expected_version THEN
    RETURN jsonb_build_object('status', 'conflict', 'version', found_cycle.version);
  END IF;
  UPDATE biblib.reading_cycles AS r SET status = p_status, finished_at = p_finished_at, updated_at = clock_timestamp()
  WHERE r.user_id = owner_id AND r.id = p_cycle_id
  RETURNING * INTO found_cycle;
  RETURN jsonb_build_object('status', 'closed', 'version', found_cycle.version);
END;
$$;
--> statement-breakpoint
-- Presta un ejemplar: un préstamo activo por ejemplar. Si ya está prestado devuelve el préstamo activo (`active`) para que
-- la acción distinga su propio reintento de un préstamo distinto. Fechas civiles sin conversión.
CREATE FUNCTION "biblib"."loan_open"(p_copy_id uuid, p_borrower_label text, p_loaned_on date, p_due_on date, p_note text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  found_loan biblib.loans%ROWTYPE;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'loan_open requiere una sesión' USING ERRCODE = '42501';
  END IF;
  PERFORM biblib.account_write_allowed();
  PERFORM pg_advisory_xact_lock(hashtextextended(format('biblib.%s:%s:%s', 'loans', owner_id, p_copy_id), 0));
  IF NOT EXISTS (SELECT 1 FROM biblib.copies AS c WHERE c.user_id = owner_id AND c.id = p_copy_id) THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  SELECT * INTO found_loan FROM biblib.loans AS l WHERE l.user_id = owner_id AND l.copy_id = p_copy_id AND l.returned_on IS NULL;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'active', 'loan_id', found_loan.id, 'borrower_label', found_loan.borrower_label, 'loaned_on', found_loan.loaned_on, 'version', found_loan.version);
  END IF;
  INSERT INTO biblib.loans (user_id, copy_id, borrower_label, loaned_on, due_on, note)
  VALUES (owner_id, p_copy_id, p_borrower_label, p_loaned_on, p_due_on, p_note)
  RETURNING * INTO found_loan;
  RETURN jsonb_build_object('status', 'opened', 'loan_id', found_loan.id, 'version', found_loan.version);
END;
$$;
--> statement-breakpoint
-- Registra la devolución con la versión esperada; el ejemplar queda libre para un préstamo nuevo. Uno ya devuelto se
-- devuelve tal cual (`already_returned`); otra versión, `conflict`.
CREATE FUNCTION "biblib"."loan_return"(p_loan_id uuid, p_expected_version uuid, p_returned_on date) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  owner_id uuid := auth.uid();
  found_loan biblib.loans%ROWTYPE;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'loan_return requiere una sesión' USING ERRCODE = '42501';
  END IF;
  IF p_returned_on IS NULL THEN
    RAISE EXCEPTION 'La devolución exige una fecha' USING ERRCODE = '22023';
  END IF;
  PERFORM biblib.account_write_allowed();
  SELECT * INTO found_loan FROM biblib.loans AS l WHERE l.user_id = owner_id AND l.id = p_loan_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF found_loan.returned_on IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_returned', 'returned_on', found_loan.returned_on, 'version', found_loan.version);
  END IF;
  IF found_loan.version IS DISTINCT FROM p_expected_version THEN
    RETURN jsonb_build_object('status', 'conflict', 'version', found_loan.version);
  END IF;
  UPDATE biblib.loans AS l SET returned_on = p_returned_on, updated_at = clock_timestamp()
  WHERE l.user_id = owner_id AND l.id = p_loan_id
  RETURNING * INTO found_loan;
  RETURN jsonb_build_object('status', 'returned', 'version', found_loan.version);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."reading_cycle_start"(uuid, timestamptz), "biblib"."reading_cycle_close"(uuid, uuid, text, timestamptz),
  "biblib"."loan_open"(uuid, text, date, date, text), "biblib"."loan_return"(uuid, uuid, date) FROM PUBLIC, anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "biblib"."reading_cycle_start"(uuid, timestamptz), "biblib"."reading_cycle_close"(uuid, uuid, text, timestamptz),
  "biblib"."loan_open"(uuid, text, date, date, text), "biblib"."loan_return"(uuid, uuid, date) TO authenticated;
--> statement-breakpoint
-- Versiones anteriores (schema_version 4): además de lo de 0014, cada ejemplar conserva sus ciclos de lectura con sus
-- entradas y sus préstamos (activos y devueltos). El hash final y los trozos siguen el mismo cálculo que 0006.
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
  cycle_total integer;
  entry_total integer;
  loan_total integer;
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
  SELECT count(*) INTO cycle_total FROM biblib.reading_cycles AS r WHERE r.user_id = owner_id;
  SELECT count(*) INTO entry_total FROM biblib.reading_entries AS r WHERE r.user_id = owner_id;
  SELECT count(*) INTO loan_total FROM biblib.loans AS l WHERE l.user_id = owner_id;
  IF book_total > 10000 OR shelf_total > 1000 THEN
    RAISE EXCEPTION 'Colección demasiado grande para guardar una versión anterior' USING ERRCODE = 'BS003';
  END IF;
  INSERT INTO biblib.library_snapshots AS s (user_id, source_operation_id, reason, captured_revision, schema_version, state, expires_at, created_at)
  VALUES (owner_id, p_operation_id, p_reason, captured, 4, 'capturing', now_at + interval '30 days', now_at)
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
          || CASE WHEN ee.items IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('edition_evidence', ee.items) END
          || CASE WHEN rc.items IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reading', rc.items) END
          || CASE WHEN lo.items IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('loans', lo.items) END AS item
      FROM biblib.books AS b
      LEFT JOIN biblib.copy_annotations AS ann ON ann.user_id = b.user_id AND ann.copy_id = b.id
      LEFT JOIN LATERAL (SELECT jsonb_agg(t.tag_id ORDER BY t.tag_id) AS tag_ids FROM biblib.copy_tags AS t WHERE t.user_id = b.user_id AND t.copy_id = b.id) AS ct ON true
      LEFT JOIN biblib.copy_locations AS cl ON cl.user_id = b.user_id AND cl.copy_id = b.id
      LEFT JOIN biblib.series_editions AS se ON se.user_id = b.user_id AND se.edition_id = b.edition_id
      LEFT JOIN LATERAL (SELECT jsonb_agg(biblib.evidence_snapshot_item(ev) ORDER BY ev.created_at, ev.id) AS items
        FROM biblib.bibliographic_evidence AS ev WHERE ev.user_id = b.user_id AND ev.copy_id = b.id) AS ce ON true
      LEFT JOIN LATERAL (SELECT jsonb_agg(biblib.evidence_snapshot_item(ev) ORDER BY ev.created_at, ev.id) AS items
        FROM biblib.bibliographic_evidence AS ev WHERE ev.user_id = b.user_id AND ev.edition_id = b.edition_id) AS ee ON true
      LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', cy.id, 'cycle_number', cy.cycle_number, 'status', cy.status,
            'started_at', cy.started_at, 'finished_at', cy.finished_at))
          || CASE WHEN en.items IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('entries', en.items) END ORDER BY cy.cycle_number, cy.id) AS items
        FROM biblib.reading_cycles AS cy
        LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', re.id, 'occurred_at', re.occurred_at, 'page_from', re.page_from,
            'page_to', re.page_to, 'note', re.note)) ORDER BY re.occurred_at, re.id) AS items
          FROM biblib.reading_entries AS re WHERE re.user_id = cy.user_id AND re.cycle_id = cy.id) AS en ON true
        WHERE cy.user_id = b.user_id AND cy.copy_id = b.id) AS rc ON true
      LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', l.id, 'borrower_label', l.borrower_label, 'loaned_on', l.loaned_on,
          'due_on', l.due_on, 'returned_on', l.returned_on, 'note', l.note)) ORDER BY l.loaned_on, l.created_at, l.id) AS items
        FROM biblib.loans AS l WHERE l.user_id = b.user_id AND l.copy_id = b.id) AS lo ON true
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
      'reading_cycles', cycle_total, 'reading_entries', entry_total, 'loans', loan_total, 'chunks', chunk_total, 'bytes', byte_total)
  WHERE s.id = new_id;
  RETURN jsonb_build_object('id', new_id, 'digest', final_digest, 'books', book_total, 'shelves', shelf_total, 'chunks', chunk_total);
END;
$$;
--> statement-breakpoint
-- IDs de una versión propia que hoy usa otra cuenta (0014 más ciclos, entradas y préstamos de 0015): la restauración les
-- asigna otro.
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
  ), cycle AS (
    SELECT (cy->>'id')::uuid AS id, cy FROM entry CROSS JOIN LATERAL jsonb_array_elements(coalesce(entry.item->'reading', '[]'::jsonb)) AS cy
    WHERE entry.kind = 'books'
  ), reading_entry AS (
    SELECT (re->>'id')::uuid AS id FROM cycle CROSS JOIN LATERAL jsonb_array_elements(coalesce(cycle.cy->'entries', '[]'::jsonb)) AS re
  ), loan AS (
    SELECT (lo->>'id')::uuid AS id FROM entry CROSS JOIN LATERAL jsonb_array_elements(coalesce(entry.item->'loans', '[]'::jsonb)) AS lo
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
    UNION
    SELECT cycle.id FROM cycle WHERE EXISTS (SELECT 1 FROM biblib.reading_cycles AS r WHERE r.id = cycle.id AND r.user_id <> owner_id)
    UNION
    SELECT reading_entry.id FROM reading_entry WHERE EXISTS (SELECT 1 FROM biblib.reading_entries AS r WHERE r.id = reading_entry.id AND r.user_id <> owner_id)
    UNION
    SELECT loan.id FROM loan WHERE EXISTS (SELECT 1 FROM biblib.loans AS l WHERE l.id = loan.id AND l.user_id <> owner_id)
  )
  SELECT coalesce(array_agg(taken.id ORDER BY taken.id), '{}'::uuid[]) INTO found FROM taken;
  RETURN found;
END;
$$;
--> statement-breakpoint
-- Eliminación de cuenta (U-OPS-03): la lectura (entradas antes que ciclos) y los préstamos se retiran al principio del paso
-- `product`, antes que los ejemplares. Mismo inventario en lib/account-deletion y docs/retencion.md.
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
    WHEN 'product' THEN ARRAY['reading_entries', 'reading_cycles', 'loans', 'review_decisions', 'review_issues', 'bibliographic_evidence', 'copy_tags', 'copy_annotations', 'copy_locations', 'series_editions', 'tags', 'locations', 'series', 'csv_mapping_profiles', 'profiles']
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
REVOKE ALL ON FUNCTION "biblib"."account_deletion_step_tables"(text) FROM PUBLIC, anon, authenticated;

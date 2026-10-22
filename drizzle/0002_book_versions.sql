ALTER TABLE "biblib"."books" ADD COLUMN "version" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
-- Rota incluso si la escritura procede de SQL o de una restauración con el mismo ID.
CREATE FUNCTION "biblib"."rotate_book_version"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.version := gen_random_uuid();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "books_rotate_version" BEFORE INSERT OR UPDATE ON "biblib"."books"
FOR EACH ROW EXECUTE FUNCTION "biblib"."rotate_book_version"();

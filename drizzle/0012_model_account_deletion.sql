-- U-DAT-06 · 0012. Borrar una cuenta desde Auth (GoTrue, rol supabase_auth_admin) borra en cascada sus ejemplares,
-- ediciones y obras, y esa cascada dispara la poda de ediciones y obras huérfanas. Con SECURITY INVOKER la poda se
-- ejecutaba con el rol de Auth, que no tiene USAGE en biblib, y el borrado de la cuenta fallaba. Pasan a SECURITY
-- DEFINER con search_path fijo: solo borran ediciones y obras del mismo dueño que ya no tienen ejemplares ni
-- ediciones (lo que dice la tabla de transición), y nadie puede llamarlas directamente (sin EXECUTE para clientes).
ALTER FUNCTION "biblib"."prune_orphan_editions"() SECURITY DEFINER;
--> statement-breakpoint
ALTER FUNCTION "biblib"."prune_orphan_works"() SECURITY DEFINER;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "biblib"."prune_orphan_editions"(), "biblib"."prune_orphan_works"() FROM PUBLIC, anon, authenticated;

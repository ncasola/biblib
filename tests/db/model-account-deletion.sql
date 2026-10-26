-- U-DAT-06 · 0012: borrar una cuenta desde Auth (un rol sin USAGE en biblib, como supabase_auth_admin) borra en
-- cascada sus ejemplares, ediciones, obras, estanterías y la copia congelada, y la poda no falla.
BEGIN;
INSERT INTO auth.users(id) VALUES ('10000000-0000-4000-8000-0000000000d1'), ('10000000-0000-4000-8000-0000000000d3');
INSERT INTO biblib.shelves(id, user_id, title, is_default) VALUES
  ('3d000000-0000-4000-8000-0000000000d1', '10000000-0000-4000-8000-0000000000d1', 'Principal', true),
  ('3d000000-0000-4000-8000-0000000000d3', '10000000-0000-4000-8000-0000000000d3', 'Principal', true);
INSERT INTO biblib.works(id, user_id, title) VALUES ('3d000000-0000-4000-8000-0000000000d9', '10000000-0000-4000-8000-0000000000d1', 'Obra que se borra');
INSERT INTO biblib.books(id, user_id, isbn, title, shelf_id, work_id) VALUES
  ('3d000000-0000-4000-8000-0000000000d2', '10000000-0000-4000-8000-0000000000d1', '9780306406157', 'Cuenta que se borra', '3d000000-0000-4000-8000-0000000000d1', '3d000000-0000-4000-8000-0000000000d9'),
  ('3d000000-0000-4000-8000-0000000000d4', '10000000-0000-4000-8000-0000000000d3', '9780306406157', 'Cuenta que se queda', '3d000000-0000-4000-8000-0000000000d3', NULL);
-- Un segundo ejemplar de la misma edición.
INSERT INTO biblib.copies(id, user_id, edition_id, shelf_id) VALUES ('3d000000-0000-4000-8000-0000000000d5', '10000000-0000-4000-8000-0000000000d1', '3d000000-0000-4000-8000-0000000000d2', '3d000000-0000-4000-8000-0000000000d1');
SET LOCAL ROLE biblib_auth_admin_sim;
DELETE FROM auth.users WHERE id = '10000000-0000-4000-8000-0000000000d1';
RESET ROLE;
SELECT assert_true((SELECT count(*) FROM biblib.copies WHERE user_id = '10000000-0000-4000-8000-0000000000d1') = 0, 'sin ejemplares de la cuenta borrada');
SELECT assert_true((SELECT count(*) FROM biblib.editions WHERE user_id = '10000000-0000-4000-8000-0000000000d1') = 0, 'sin ediciones de la cuenta borrada');
SELECT assert_true((SELECT count(*) FROM biblib.works WHERE user_id = '10000000-0000-4000-8000-0000000000d1') = 0, 'sin obras de la cuenta borrada');
SELECT assert_true((SELECT count(*) FROM biblib.shelves WHERE user_id = '10000000-0000-4000-8000-0000000000d1') = 0, 'sin estanterías de la cuenta borrada');
SELECT assert_true((SELECT count(*) FROM biblib.books WHERE user_id = '10000000-0000-4000-8000-0000000000d3') = 1, 'la otra cuenta conserva su ejemplar');
SELECT assert_true((SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc WHERE oid = 'biblib.prune_orphan_editions()'::regprocedure), 'poda de ediciones definer con search_path fijo');
SELECT assert_true((SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc WHERE oid = 'biblib.prune_orphan_works()'::regprocedure), 'poda de obras definer con search_path fijo');
SELECT assert_true(NOT has_function_privilege('authenticated', 'biblib.prune_orphan_editions()', 'EXECUTE') AND NOT has_function_privilege('anon', 'biblib.prune_orphan_works()', 'EXECUTE'), 'nadie invoca la poda directamente');
ROLLBACK;
REVOKE ALL ON auth.users FROM biblib_auth_admin_sim;
REVOKE ALL ON SCHEMA auth FROM biblib_auth_admin_sim;
DROP ROLE biblib_auth_admin_sim;
SELECT 'Correcto: borrar una cuenta desde Auth retira su modelo en cascada (0012)';

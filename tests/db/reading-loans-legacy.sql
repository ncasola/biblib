-- O14 · antes de 0015. Cuentas S (A) y T (B) con libros legados en estado `read`, `reading` y `unread`, con total de
-- páginas conocido (300, 100) y desconocido (0). Sirve para comprobar que la migración no convierte el estado legado en
-- ciclos, sesiones ni fechas, y que no toca el estado ni la versión de ningún ejemplar.
INSERT INTO auth.users(id) VALUES ('b1500000-0000-4000-8000-0000000000a1'), ('b1500000-0000-4000-8000-0000000000b1');
INSERT INTO biblib.shelves(id, user_id, title, is_default) VALUES
  ('b1510000-0000-4000-8000-0000000000a1', 'b1500000-0000-4000-8000-0000000000a1', 'Principal', true),
  ('b1510000-0000-4000-8000-0000000000b1', 'b1500000-0000-4000-8000-0000000000b1', 'Principal', true);
INSERT INTO biblib.books(id, user_id, isbn, title, shelf_id, status, number_of_pages) VALUES
  ('b1520000-0000-4000-8000-0000000000a1', 'b1500000-0000-4000-8000-0000000000a1', 'manual-o14-1', 'Leído hace años, 300 páginas', 'b1510000-0000-4000-8000-0000000000a1', 'read', 300),
  ('b1520000-0000-4000-8000-0000000000a2', 'b1500000-0000-4000-8000-0000000000a1', 'manual-o14-2', 'Leído, páginas desconocidas', 'b1510000-0000-4000-8000-0000000000a1', 'read', 0),
  ('b1520000-0000-4000-8000-0000000000a3', 'b1500000-0000-4000-8000-0000000000a1', 'manual-o14-3', 'Leyendo, 100 páginas', 'b1510000-0000-4000-8000-0000000000a1', 'reading', 100),
  ('b1520000-0000-4000-8000-0000000000a4', 'b1500000-0000-4000-8000-0000000000a1', 'manual-o14-4', 'Sin leer', 'b1510000-0000-4000-8000-0000000000a1', 'unread', 0),
  ('b1520000-0000-4000-8000-0000000000b1', 'b1500000-0000-4000-8000-0000000000b1', 'manual-o14-5', 'De B, leído', 'b1510000-0000-4000-8000-0000000000b1', 'read', 200);
-- Estado y versión de cada ejemplar antes de 0015, para compararlos después.
CREATE TABLE public.o14_copies_before AS SELECT id, status, version, updated_at FROM biblib.copies;
SELECT 'Correcto: datos previos a 0015 con libros leídos legados y totales de páginas conocidos y desconocidos';

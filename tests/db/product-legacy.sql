-- O13 · antes de 0014. Cuentas P (A) y Q (B) con procedencias variadas para comprobar que la migración convierte la
-- procedencia actual en evidencia inicial sin fabricar URL ni foto: Open Library con URL, manual, foto sin asset y
-- comprobada físicamente, BNE con procedencia por campo y una importación de otra cuenta.
INSERT INTO auth.users(id) VALUES ('b1400000-0000-4000-8000-0000000000a1'), ('b1400000-0000-4000-8000-0000000000b1');
INSERT INTO biblib.shelves(id, user_id, title, is_default) VALUES
  ('b1410000-0000-4000-8000-0000000000a1', 'b1400000-0000-4000-8000-0000000000a1', 'Principal', true),
  ('b1410000-0000-4000-8000-0000000000a2', 'b1400000-0000-4000-8000-0000000000a1', 'Lógica', false),
  ('b1410000-0000-4000-8000-0000000000b1', 'b1400000-0000-4000-8000-0000000000b1', 'Principal', true);
INSERT INTO biblib.books(id, user_id, isbn, title, shelf_id, catalogue) VALUES
  ('b1420000-0000-4000-8000-0000000000a1', 'b1400000-0000-4000-8000-0000000000a1', '9780306406157', 'Con Open Library', 'b1410000-0000-4000-8000-0000000000a1',
    '{"source":"open-library","sourceUrl":"https://openlibrary.org/books/OL1M","isbnVerified":false}'),
  ('b1420000-0000-4000-8000-0000000000a2', 'b1400000-0000-4000-8000-0000000000a1', 'manual-o13-1', 'Manual', 'b1410000-0000-4000-8000-0000000000a1',
    '{"source":"manual","isbnVerified":false}'),
  ('b1420000-0000-4000-8000-0000000000a3', 'b1400000-0000-4000-8000-0000000000a1', '9780140449136', 'Foto sin asset', 'b1410000-0000-4000-8000-0000000000a2',
    '{"source":"photo","isbnVerified":true}'),
  ('b1420000-0000-4000-8000-0000000000a4', 'b1400000-0000-4000-8000-0000000000a1', '9781861972712', 'BNE por campo', 'b1410000-0000-4000-8000-0000000000a1',
    '{"schemaVersion":2,"source":"bne","isbnVerified":false,"fields":{"title":{"provider":"bne","selection":"user-selected"}}}'),
  ('b1420000-0000-4000-8000-0000000000b1', 'b1400000-0000-4000-8000-0000000000b1', '9780306406157', 'De B', 'b1410000-0000-4000-8000-0000000000b1',
    '{"source":"import","isbnVerified":false}');
UPDATE biblib.copies SET edition_verification = '{"isbnVerified":true,"checkedAt":"2026-10-01T10:00:00Z","evidenceRefs":["foto-lomo-1"]}'
WHERE id = 'b1420000-0000-4000-8000-0000000000a3';
-- Una segunda copia de la edición de Open Library: comparte edición y no está comprobada.
INSERT INTO biblib.copies(id, user_id, edition_id, shelf_id) VALUES
  ('b1420000-0000-4000-8000-0000000000a5', 'b1400000-0000-4000-8000-0000000000a1', 'b1420000-0000-4000-8000-0000000000a1', 'b1410000-0000-4000-8000-0000000000a2');
SELECT 'Correcto: datos previos a 0014 con procedencias variadas';

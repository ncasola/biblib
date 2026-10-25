-- U-DAT-06: estado legacy antes de 0010 para comprobar el backfill. Cuenta M con una colección de 111
-- fichas con la forma del fixture sintético (102 ISBN-13 válidos y 9 identificadores manuales, cinco
-- estanterías, cuatro estados, procedencia v1 y v2, comprobación física y portadas) más equivalencias
-- ISBN-10/13 compatibles y en conflicto, ISBN reescritos, identificadores no válidos y uno vacío. La
-- cuenta N repite un ISBN de M para comprobar que la unicidad es por cuenta.
INSERT INTO auth.users(id) VALUES ('10000000-0000-4000-8000-0000000000e1'), ('10000000-0000-4000-8000-0000000000e2');

INSERT INTO biblib.shelves(id, user_id, title, is_default) VALUES
  ('20000000-0000-4000-8000-0000000000e1', '10000000-0000-4000-8000-0000000000e1', 'Predeterminada', true),
  ('20000000-0000-4000-8000-0000000001e1', '10000000-0000-4000-8000-0000000000e1', 'Balda A', false),
  ('20000000-0000-4000-8000-0000000002e1', '10000000-0000-4000-8000-0000000000e1', 'Balda B', false),
  ('20000000-0000-4000-8000-0000000003e1', '10000000-0000-4000-8000-0000000000e1', 'Balda C', false),
  ('20000000-0000-4000-8000-0000000004e1', '10000000-0000-4000-8000-0000000000e1', 'Balda D', false),
  ('20000000-0000-4000-8000-0000000000e2', '10000000-0000-4000-8000-0000000000e2', 'Predeterminada', true);

-- ISBN-13 sintético válido 97800020NNNN + dígito de control.
CREATE FUNCTION pg_temp.synthetic_isbn(n integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT p || ((10 - (SELECT sum(substr(p, i, 1)::integer * CASE WHEN i % 2 = 0 THEN 3 ELSE 1 END) FROM generate_series(1, 12) AS i) % 10) % 10)::text
  FROM (SELECT '97800020' || lpad(n::text, 4, '0') AS p) AS prefix
$$;

INSERT INTO biblib.books(id, user_id, isbn, title, subtitle, authors, publishers, catalogue, number_of_pages, publish_date, cover_small, cover_medium, cover_large, status, shelf_id, created_at)
SELECT ('3d000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '10000000-0000-4000-8000-0000000000e1',
  CASE WHEN n <= 102 THEN pg_temp.synthetic_isbn(n) ELSE 'manual-' || ('40000000-0000-4000-8000-' || lpad(n::text, 12, '0')) END,
  'Ficha sintética ' || lpad(n::text, 3, '0'), CASE WHEN n % 7 = 0 THEN 'Subtítulo ' || n END,
  CASE WHEN n % 5 = 0 THEN jsonb_build_array(jsonb_build_object('name', 'Autoría ' || n), jsonb_build_object('name', 'Coautoría ' || n, 'url', 'https://openlibrary.org/authors/OL' || n || 'A'))
    ELSE jsonb_build_array(jsonb_build_object('name', 'Autoría ' || (n % 13))) END,
  CASE WHEN n % 4 = 3 THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('name', 'Editorial ' || (n % 6))) END,
  CASE n % 4
    WHEN 0 THEN jsonb_build_object('source', 'open-library', 'isbnVerified', n <= 102 AND n % 8 = 0, 'sourceUrl', 'https://openlibrary.org/books/OL' || n || 'M')
    WHEN 1 THEN jsonb_build_object('schemaVersion', 2, 'source', 'bne', 'isbnVerified', n <= 102 AND n % 3 = 0,
      'fields', jsonb_build_object('title', jsonb_build_object('provider', 'bne', 'recordId', 'bimo' || n, 'selection', 'user-selected')))
    WHEN 2 THEN jsonb_build_object('source', 'manual', 'isbnVerified', false)
    ELSE jsonb_build_object('source', 'import')
  END,
  (n * 37) % 900, CASE WHEN n % 6 = 0 THEN '' ELSE (1900 + n)::text END,
  CASE WHEN n % 3 = 0 THEN '/default-book-cover.webp' ELSE 'https://covers.biblib.invalid/s/' || n || '.jpg' END,
  CASE WHEN n % 3 = 0 THEN '/default-book-cover.webp' ELSE 'https://covers.biblib.invalid/m/' || n || '.jpg' END,
  CASE WHEN n % 3 = 0 THEN '/default-book-cover.webp' ELSE 'https://covers.biblib.invalid/l/' || n || '.jpg' END,
  (ARRAY['read', 'reading', 'unread', 'to-read'])[1 + n % 4],
  (ARRAY['20000000-0000-4000-8000-0000000000e1', '20000000-0000-4000-8000-0000000001e1', '20000000-0000-4000-8000-0000000002e1', '20000000-0000-4000-8000-0000000003e1', '20000000-0000-4000-8000-0000000004e1'])[1 + n % 5]::uuid,
  timestamptz '2026-01-01 10:00:00+00' + n * interval '1 minute'
FROM generate_series(1, 111) AS n;

-- Equivalencias y formas no canónicas. Las fichas «e0a…» son las únicas con el mismo contenido bibliográfico.
INSERT INTO biblib.books(id, user_id, isbn, title, authors, publishers, catalogue, number_of_pages, publish_date, status, shelf_id, created_at) VALUES
  -- Grupo 1: ISBN-13 canónico y su ISBN-10, mismos datos: se agrupan en 0011.
  ('3d000000-0000-4000-8000-0000000e0a01', '10000000-0000-4000-8000-0000000000e1', '9780306406157', 'Ensayo compatible', '[{"name":"Autoría compatible"}]', '[{"name":"Editorial X"}]', '{"source":"import","isbnVerified":true}', 320, '1999', 'read', '20000000-0000-4000-8000-0000000001e1', '2026-02-01 10:00:00+00'),
  ('3d000000-0000-4000-8000-0000000e0a02', '10000000-0000-4000-8000-0000000000e1', '0306406152', 'Ensayo compatible', '[{"name":"Autoría compatible"}]', '[{"name":"Editorial X"}]', '{"source":"import","isbnVerified":false}', 320, '1999', 'to-read', '20000000-0000-4000-8000-0000000002e1', '2026-02-01 10:01:00+00'),
  -- Grupo 2: forma con guiones y canónica con títulos distintos: conflicto, nunca se agrupan.
  ('3d000000-0000-4000-8000-0000000e0b01', '10000000-0000-4000-8000-0000000000e1', '978-84-376-0494-7', 'Edición en rústica', '[{"name":"Autoría B"}]', '[]', '{"source":"manual","isbnVerified":false}', 500, '1967', 'reading', '20000000-0000-4000-8000-0000000000e1', '2026-02-01 09:00:00+00'),
  ('3d000000-0000-4000-8000-0000000e0b02', '10000000-0000-4000-8000-0000000000e1', '9788437604947', 'Edición en tapa dura', '[{"name":"Autoría B"}]', '[]', '{"source":"manual","isbnVerified":false}', 500, '1967', 'unread', '20000000-0000-4000-8000-0000000000e1', '2026-02-01 11:00:00+00'),
  -- Una sola ficha con un ISBN-10 con guiones: se reescribe a su ISBN-13 y queda en el informe.
  ('3d000000-0000-4000-8000-0000000e0c01', '10000000-0000-4000-8000-0000000000e1', '0-19-853453-1', 'Normalizada', '[]', '[]', '{"source":"import"}', 0, '', 'unread', '20000000-0000-4000-8000-0000000000e1', '2026-02-02 10:00:00+00'),
  -- Grupo 3: canónica, ISBN-10 compatible y forma con guiones con otra paginación.
  ('3d000000-0000-4000-8000-0000000e0d01', '10000000-0000-4000-8000-0000000000e1', '9780804429573', 'Triple', '[{"name":"Autoría D"}]', '[]', '{"source":"open-library","isbnVerified":false,"sourceUrl":"https://openlibrary.org/books/OL1M"}', 210, '2001', 'read', '20000000-0000-4000-8000-0000000003e1', '2026-02-03 10:00:00+00'),
  ('3d000000-0000-4000-8000-0000000e0d02', '10000000-0000-4000-8000-0000000000e1', '080442957X', 'Triple', '[{"name":"Autoría D"}]', '[]', '{"source":"open-library","isbnVerified":false,"sourceUrl":"https://openlibrary.org/books/OL1M"}', 210, '2001', 'unread', '20000000-0000-4000-8000-0000000004e1', '2026-02-03 10:01:00+00'),
  ('3d000000-0000-4000-8000-0000000e0d03', '10000000-0000-4000-8000-0000000000e1', '978-0-8044-2957-3', 'Triple', '[{"name":"Autoría D"}]', '[]', '{"source":"open-library","isbnVerified":false,"sourceUrl":"https://openlibrary.org/books/OL1M"}', 212, '2001', 'reading', '20000000-0000-4000-8000-0000000004e1', '2026-02-03 10:02:00+00'),
  -- Identificadores que no son ISBN (dígito de control incorrecto) y uno vacío.
  ('3d000000-0000-4000-8000-0000000e0e01', '10000000-0000-4000-8000-0000000000e1', '1234567890', 'Identificador no válido', '[]', '[]', '{"source":"import"}', 0, '', 'unread', '20000000-0000-4000-8000-0000000000e1', '2026-02-04 10:00:00+00'),
  ('3d000000-0000-4000-8000-0000000e0e02', '10000000-0000-4000-8000-0000000000e1', '019853453X', 'Otro no válido', '[]', '[]', '{"source":"import"}', 0, '', 'unread', '20000000-0000-4000-8000-0000000000e1', '2026-02-04 10:01:00+00'),
  ('3d000000-0000-4000-8000-0000000e0e03', '10000000-0000-4000-8000-0000000000e1', '', 'Sin identificador', '[]', '[]', '{"source":"manual","isbnVerified":false}', 0, '', 'unread', '20000000-0000-4000-8000-0000000000e1', '2026-02-04 10:02:00+00'),
  -- N tiene el mismo ISBN que el grupo 1 de M: cada cuenta conserva el suyo.
  ('3d000000-0000-4000-8000-0000000e0f01', '10000000-0000-4000-8000-0000000000e2', '9780306406157', 'Libro de N', '[]', '[]', '{"source":"import","isbnVerified":true}', 100, '2000', 'read', '20000000-0000-4000-8000-0000000000e2', '2026-02-05 10:00:00+00'),
  ('3d000000-0000-4000-8000-0000000e0f02', '10000000-0000-4000-8000-0000000000e2', 'manual-50000000-0000-4000-8000-000000000001', 'Manual de N', '[]', '[]', '{"source":"manual","isbnVerified":false}', 0, '', 'unread', '20000000-0000-4000-8000-0000000000e2', '2026-02-05 10:01:00+00');

SELECT assert_true((SELECT count(*) = 122 FROM biblib.books WHERE user_id = '10000000-0000-4000-8000-0000000000e1'), 'M tiene 122 fichas legacy');
SELECT 'Correcto: estado legacy de 0009 para el backfill (111 fichas sintéticas y equivalencias)';

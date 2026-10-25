-- O14 · 0015. Lectura y préstamos: sin backfill del estado legado, un ciclo abierto por ejemplar y relecturas que
-- conservan la historia, páginas dentro del total conocido (y sin límite inventado si se desconoce), un préstamo activo
-- por ejemplar con fechas civiles sin desplazamiento por huso, alias sin correo ni teléfono, independencia del estado de
-- lectura, aislamiento A/B con FK del mismo dueño, copia borrada, límites, revisión de colección, versiones anteriores
-- (esquema 4), cuenta en eliminación e inventario. Cuentas: S (A), T (B) de reading-loans-legacy.sql y U (C).

-- Sin backfill: el estado `read` legado no crea ciclos, entradas ni préstamos, y ningún ejemplar cambia.
DO $test$
BEGIN
  PERFORM assert_true((SELECT count(*) FROM biblib.reading_cycles) = 0 AND (SELECT count(*) FROM biblib.reading_entries) = 0 AND (SELECT count(*) FROM biblib.loans) = 0,
    'la migración no inventa ciclos, sesiones ni préstamos');
  PERFORM assert_true(NOT EXISTS (SELECT 1 FROM public.o14_copies_before AS b JOIN biblib.copies AS c ON c.id = b.id
    WHERE c.status IS DISTINCT FROM b.status OR c.version IS DISTINCT FROM b.version OR c.updated_at IS DISTINCT FROM b.updated_at), 'estado, versión y fecha de los ejemplares intactos');
  PERFORM assert_true((SELECT count(*) FROM biblib.copies WHERE status = 'read' AND user_id IN ('b1500000-0000-4000-8000-0000000000a1', 'b1500000-0000-4000-8000-0000000000b1')) = 3, 'los leídos legados siguen leídos, sin fecha');
  PERFORM assert_true(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'biblib' AND table_name IN ('loans', 'reading_cycles', 'reading_entries')
    AND column_name ~ '(remind|notif|sent|email|phone|telefono|correo)'), 'ninguna columna de recordatorios, envíos ni contacto');
END;
$test$;
DROP TABLE public.o14_copies_before;
SELECT 'Correcto: sin backfill del estado legado y sin columnas de recordatorio ni contacto';

-- Ciclos: iniciar es idempotente mientras hay uno abierto; cerrar exige la versión; una relectura es un ciclo nuevo y el
-- anterior conserva estado y fechas. Ni el estado ni la versión del ejemplar cambian.
DO $test$
DECLARE
  owner_a uuid := 'b1500000-0000-4000-8000-0000000000a1';
  copy_a1 uuid := 'b1520000-0000-4000-8000-0000000000a1';
  copy_before biblib.copies%ROWTYPE;
  first jsonb;
  again jsonb;
  closed jsonb;
  second jsonb;
BEGIN
  SELECT * INTO copy_before FROM biblib.copies WHERE id = copy_a1;
  PERFORM set_config('request.jwt.claim.sub', owner_a::text, true);
  SET LOCAL ROLE authenticated;
  first := biblib.reading_cycle_start(copy_a1, '2026-01-10T10:00:00Z');
  PERFORM assert_true(first->>'status' = 'started' AND (first->>'cycle_number')::integer = 1, 'primer ciclo');
  again := biblib.reading_cycle_start(copy_a1, '2026-01-11T10:00:00Z');
  PERFORM assert_true(again->>'status' = 'open' AND again->>'cycle_id' = first->>'cycle_id' AND again->>'version' = first->>'version', 'un reintento devuelve el ciclo abierto, sin otro');
  BEGIN
    INSERT INTO biblib.reading_cycles(user_id, copy_id, cycle_number, status) VALUES (owner_a, copy_a1, 2, 'paused');
    RAISE EXCEPTION 'Prueba fallida: dos ciclos abiertos en un ejemplar';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  PERFORM assert_true(biblib.reading_cycle_close((first->>'cycle_id')::uuid, gen_random_uuid(), 'finished', '2026-02-01T20:00:00Z')->>'status' = 'conflict', 'cerrar con otra versión es un conflicto');
  BEGIN
    PERFORM biblib.reading_cycle_close((first->>'cycle_id')::uuid, (first->>'version')::uuid, 'finished', '2026-01-01T00:00:00Z');
    RAISE EXCEPTION 'Prueba fallida: terminó antes de empezar';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM biblib.reading_cycle_close((first->>'cycle_id')::uuid, (first->>'version')::uuid, 'paused', NULL);
    RAISE EXCEPTION 'Prueba fallida: cerró con un estado abierto';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  closed := biblib.reading_cycle_close((first->>'cycle_id')::uuid, (first->>'version')::uuid, 'finished', '2026-02-01T20:00:00Z');
  PERFORM assert_true(closed->>'status' = 'closed' AND closed->>'version' <> first->>'version', 'cerrado con versión nueva');
  again := biblib.reading_cycle_close((first->>'cycle_id')::uuid, (first->>'version')::uuid, 'finished', '2026-02-01T20:00:00Z');
  PERFORM assert_true(again->>'status' = 'already_closed' AND again->>'cycle_status' = 'finished' AND (again->>'finished_at')::timestamptz = '2026-02-01T20:00:00Z', 'el reintento ve el cierre');
  second := biblib.reading_cycle_start(copy_a1, NULL);
  PERFORM assert_true(second->>'status' = 'started' AND (second->>'cycle_number')::integer = 2 AND second->>'cycle_id' <> first->>'cycle_id', 'la relectura es el ciclo 2');
  PERFORM assert_true((SELECT status = 'finished' AND started_at = '2026-01-10T10:00:00Z' AND finished_at = '2026-02-01T20:00:00Z' FROM biblib.reading_cycles WHERE id = (first->>'cycle_id')::uuid),
    'la primera lectura conserva estado y fechas');
  PERFORM assert_true((SELECT started_at IS NULL FROM biblib.reading_cycles WHERE id = (second->>'cycle_id')::uuid), 'sin fecha de inicio si no consta: nunca la actual');
  BEGIN
    UPDATE biblib.reading_cycles SET status = 'reading', finished_at = NULL WHERE id = (first->>'cycle_id')::uuid;
    RAISE EXCEPTION 'Prueba fallida: reabrió una lectura con otra abierta';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE biblib.reading_cycles SET finished_at = '2026-03-01T00:00:00Z' WHERE id = (second->>'cycle_id')::uuid;
    RAISE EXCEPTION 'Prueba fallida: un ciclo abierto con fecha de fin';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.reading_cycles(user_id, copy_id, cycle_number, status) VALUES (owner_a, copy_a1, 1, 'finished');
    RAISE EXCEPTION 'Prueba fallida: repitió el número de ciclo';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.reading_cycles(user_id, copy_id, cycle_number, status) VALUES (owner_a, 'b1520000-0000-4000-8000-0000000000a2', 1, 'leído');
    RAISE EXCEPTION 'Prueba fallida: estado de ciclo desconocido';
  EXCEPTION WHEN check_violation THEN NULL; END;
  PERFORM assert_true(biblib.reading_cycle_start('b1520000-0000-4000-8000-0000000000b1', NULL)->>'status' = 'not_found', 'el ejemplar de B no existe para A');
  PERFORM assert_true(biblib.reading_cycle_start(gen_random_uuid(), NULL)->>'status' = 'not_found', 'ejemplar inexistente');
  RESET ROLE;
  PERFORM assert_true((SELECT status = copy_before.status AND version = copy_before.version FROM biblib.copies WHERE id = copy_a1), 'leer no cambia el estado ni la versión del ejemplar');
END;
$test$;
SELECT 'Correcto: un ciclo abierto por ejemplar, cierre con versión y relectura que conserva la historia';

-- Entradas: páginas no negativas, desde ≤ hasta, nunca por encima del total conocido (BR001); sin total conocido no hay
-- tope inventado; una entrada lleva página o nota y su instante explícito.
DO $test$
DECLARE
  owner_a uuid := 'b1500000-0000-4000-8000-0000000000a1';
  cycle_300 uuid;
  cycle_unknown uuid;
  entry_id uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', owner_a::text, true);
  SET LOCAL ROLE authenticated;
  SELECT id INTO cycle_300 FROM biblib.reading_cycles WHERE copy_id = 'b1520000-0000-4000-8000-0000000000a1' AND cycle_number = 2;
  cycle_unknown := (biblib.reading_cycle_start('b1520000-0000-4000-8000-0000000000a2', '2026-04-01T08:00:00+02:00')->>'cycle_id')::uuid;
  INSERT INTO biblib.reading_entries(user_id, cycle_id, occurred_at, page_from, page_to) VALUES (owner_a, cycle_300, '2026-04-02T21:30:00+02:00', 0, 300) RETURNING id INTO entry_id;
  PERFORM assert_true((SELECT occurred_at = '2026-04-02T19:30:00Z' FROM biblib.reading_entries WHERE id = entry_id), 'el instante se guarda en UTC');
  BEGIN
    INSERT INTO biblib.reading_entries(user_id, cycle_id, occurred_at, page_to) VALUES (owner_a, cycle_300, now(), 301);
    RAISE EXCEPTION 'Prueba fallida: aceptó la página 301 de 300';
  EXCEPTION WHEN SQLSTATE 'BR001' THEN NULL; END;
  BEGIN
    INSERT INTO biblib.reading_entries(user_id, cycle_id, occurred_at, page_from, page_to) VALUES (owner_a, cycle_300, now(), 50, 40);
    RAISE EXCEPTION 'Prueba fallida: aceptó desde > hasta';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.reading_entries(user_id, cycle_id, occurred_at, page_to) VALUES (owner_a, cycle_300, now(), -1);
    RAISE EXCEPTION 'Prueba fallida: aceptó una página negativa';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.reading_entries(user_id, cycle_id, occurred_at, page_from) VALUES (owner_a, cycle_300, now(), 10);
    RAISE EXCEPTION 'Prueba fallida: aceptó una página de inicio sin final';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.reading_entries(user_id, cycle_id, occurred_at) VALUES (owner_a, cycle_300, now());
    RAISE EXCEPTION 'Prueba fallida: aceptó una entrada vacía';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.reading_entries(user_id, cycle_id, note) VALUES (owner_a, cycle_300, 'Sin instante');
    RAISE EXCEPTION 'Prueba fallida: aceptó una entrada sin instante';
  EXCEPTION WHEN not_null_violation THEN NULL; END;
  INSERT INTO biblib.reading_entries(user_id, cycle_id, occurred_at, note) VALUES (owner_a, cycle_300, '2026-04-03T07:00:00Z', 'Solo una nota');
  -- Total desconocido (0): se admite cualquier página dentro del máximo general, sin porcentaje.
  INSERT INTO biblib.reading_entries(user_id, cycle_id, occurred_at, page_to) VALUES (owner_a, cycle_unknown, '2026-04-02T10:00:00Z', 5000);
  BEGIN
    INSERT INTO biblib.reading_entries(user_id, cycle_id, occurred_at, page_to) VALUES (owner_a, cycle_unknown, now(), 100001);
    RAISE EXCEPTION 'Prueba fallida: aceptó más páginas que el máximo general';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RESET ROLE;
  -- Corregir el total de la edición no invalida lo registrado: editar la nota sigue pasando; subir la página, no.
  UPDATE biblib.editions SET number_of_pages = 250 WHERE id = (SELECT edition_id FROM biblib.copies WHERE id = 'b1520000-0000-4000-8000-0000000000a1');
  PERFORM set_config('request.jwt.claim.sub', owner_a::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE biblib.reading_entries SET note = 'Corregida' WHERE id = entry_id;
  BEGIN
    UPDATE biblib.reading_entries SET page_to = 299 WHERE id = entry_id;
    RAISE EXCEPTION 'Prueba fallida: subió la página por encima del nuevo total';
  EXCEPTION WHEN SQLSTATE 'BR001' THEN NULL; END;
  RESET ROLE;
  UPDATE biblib.editions SET number_of_pages = 300 WHERE id = (SELECT edition_id FROM biblib.copies WHERE id = 'b1520000-0000-4000-8000-0000000000a1');
END;
$test$;
SELECT 'Correcto: entradas con páginas dentro del total conocido, sin tope inventado si se desconoce e instante en UTC';

-- Préstamos: uno activo por ejemplar, devolución con versión y préstamo sucesivo; fechas civiles sin desplazamiento por
-- huso; alias sin correo ni teléfono; prestar no cambia el estado de lectura ni la versión del ejemplar.
DO $test$
DECLARE
  owner_a uuid := 'b1500000-0000-4000-8000-0000000000a1';
  copy_a3 uuid := 'b1520000-0000-4000-8000-0000000000a3';
  copy_before biblib.copies%ROWTYPE;
  opened jsonb;
  returned jsonb;
  label text;
BEGIN
  SELECT * INTO copy_before FROM biblib.copies WHERE id = copy_a3;
  PERFORM set_config('request.jwt.claim.sub', owner_a::text, true);
  SET LOCAL ROLE authenticated;
  SET LOCAL TimeZone = 'Pacific/Kiritimati';
  opened := biblib.loan_open(copy_a3, 'Tía Ana', '2026-03-29', NULL, 'Lo devuelve en Semana Santa');
  PERFORM assert_true(opened->>'status' = 'opened', 'prestado');
  PERFORM assert_true((SELECT loaned_on::text = '2026-03-29' AND due_on IS NULL FROM biblib.loans WHERE id = (opened->>'loan_id')::uuid), 'fecha civil intacta con UTC+14');
  SET LOCAL TimeZone = 'America/Los_Angeles';
  PERFORM assert_true((SELECT loaned_on::text = '2026-03-29' AND to_jsonb(loaned_on) = '"2026-03-29"'::jsonb FROM biblib.loans WHERE id = (opened->>'loan_id')::uuid), 'y con UTC-7: sin desplazamiento');
  PERFORM assert_true(biblib.loan_open(copy_a3, 'Tía Ana', '2026-03-29', NULL, NULL)->>'status' = 'active', 'un segundo préstamo devuelve el activo');
  BEGIN
    INSERT INTO biblib.loans(user_id, copy_id, borrower_label, loaned_on) VALUES (owner_a, copy_a3, 'Otra', '2026-03-30');
    RAISE EXCEPTION 'Prueba fallida: dos préstamos activos';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  PERFORM assert_true(biblib.loan_return((opened->>'loan_id')::uuid, gen_random_uuid(), '2026-04-05')->>'status' = 'conflict', 'devolver con otra versión es un conflicto');
  BEGIN
    PERFORM biblib.loan_return((opened->>'loan_id')::uuid, (opened->>'version')::uuid, '2026-03-28');
    RAISE EXCEPTION 'Prueba fallida: devuelto antes de prestarse';
  EXCEPTION WHEN check_violation THEN NULL; END;
  returned := biblib.loan_return((opened->>'loan_id')::uuid, (opened->>'version')::uuid, '2026-04-05');
  PERFORM assert_true(returned->>'status' = 'returned', 'devuelto');
  returned := biblib.loan_return((opened->>'loan_id')::uuid, (opened->>'version')::uuid, '2026-04-05');
  PERFORM assert_true(returned->>'status' = 'already_returned' AND returned->>'returned_on' = '2026-04-05', 'el reintento ve la devolución');
  opened := biblib.loan_open(copy_a3, 'Luis', '2026-04-06', '2026-05-06', NULL);
  PERFORM assert_true(opened->>'status' = 'opened' AND (SELECT count(*) FROM biblib.loans WHERE copy_id = copy_a3) = 2
    AND (SELECT count(*) FROM biblib.loans WHERE copy_id = copy_a3 AND returned_on IS NULL) = 1, 'préstamo sucesivo con el historial');
  BEGIN
    PERFORM biblib.loan_open('b1520000-0000-4000-8000-0000000000a4', 'Marta', '2026-04-06', '2026-04-05', NULL);
    RAISE EXCEPTION 'Prueba fallida: vencimiento anterior al préstamo';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM biblib.loan_open('b1520000-0000-4000-8000-0000000000a4', 'Marta', '1899-12-31', NULL, NULL);
    RAISE EXCEPTION 'Prueba fallida: fecha fuera de rango';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM biblib.loan_open('b1520000-0000-4000-8000-0000000000a4', 'Marta', NULL, NULL, NULL);
    RAISE EXCEPTION 'Prueba fallida: préstamo sin fecha de salida';
  EXCEPTION WHEN not_null_violation THEN NULL; END;
  FOREACH label IN ARRAY ARRAY['ana@example.com', '+34 600 123 456', '6001234567', ' Ana', 'Ana ', repeat('a', 41), '', E'Ana\tB'] LOOP
    BEGIN
      PERFORM biblib.loan_open('b1520000-0000-4000-8000-0000000000a4', label, '2026-04-06', NULL, NULL);
      RAISE EXCEPTION 'Prueba fallida: aceptó el alias «%»', label;
    EXCEPTION WHEN check_violation THEN NULL; END;
  END LOOP;
  PERFORM assert_true(biblib.loan_open('b1520000-0000-4000-8000-0000000000a4', 'Vecina 3.º B', '2026-04-06', NULL, NULL)->>'status' = 'opened', 'un alias corto con algún número');
  PERFORM assert_true(biblib.loan_open('b1520000-0000-4000-8000-0000000000b1', 'Marta', '2026-04-06', NULL, NULL)->>'status' = 'not_found', 'no presta un ejemplar de B');
  RESET ROLE;
  PERFORM assert_true((SELECT status = copy_before.status AND version = copy_before.version FROM biblib.copies WHERE id = copy_a3), 'prestar no cambia el estado de lectura ni la versión del ejemplar');
END;
$test$;
SELECT 'Correcto: un préstamo activo por ejemplar, devolución con versión, préstamo sucesivo y fechas civiles sin huso';

-- Aislamiento A/B: B no ve, no escribe a nombre de A, no cita ejemplares ni ciclos de A y las funciones no le dan acceso.
DO $test$
DECLARE
  owner_a uuid := 'b1500000-0000-4000-8000-0000000000a1';
  owner_b uuid := 'b1500000-0000-4000-8000-0000000000b1';
  cycle_a uuid := (SELECT id FROM biblib.reading_cycles WHERE copy_id = 'b1520000-0000-4000-8000-0000000000a1' AND cycle_number = 1);
  loan_a biblib.loans%ROWTYPE;
  affected integer;
BEGIN
  SELECT * INTO loan_a FROM biblib.loans WHERE copy_id = 'b1520000-0000-4000-8000-0000000000a3' AND returned_on IS NULL;
  PERFORM set_config('request.jwt.claim.sub', owner_b::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM assert_true((SELECT count(*) FROM biblib.reading_cycles) = 0 AND (SELECT count(*) FROM biblib.reading_entries) = 0 AND (SELECT count(*) FROM biblib.loans) = 0, 'B no ve nada de A');
  BEGIN
    INSERT INTO biblib.loans(user_id, copy_id, borrower_label, loaned_on) VALUES (owner_a, 'b1520000-0000-4000-8000-0000000000a4', 'Intruso', '2026-04-06');
    RAISE EXCEPTION 'Prueba fallida: B prestó a nombre de A';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO biblib.loans(user_id, copy_id, borrower_label, loaned_on) VALUES (owner_b, 'b1520000-0000-4000-8000-0000000000a4', 'Intruso', '2026-04-06');
    RAISE EXCEPTION 'Prueba fallida: B prestó un ejemplar de A';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.reading_cycles(user_id, copy_id, cycle_number) VALUES (owner_b, 'b1520000-0000-4000-8000-0000000000a1', 9);
    RAISE EXCEPTION 'Prueba fallida: B leyó un ejemplar de A';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.reading_entries(user_id, cycle_id, occurred_at, note) VALUES (owner_b, cycle_a, now(), 'Intrusa');
    RAISE EXCEPTION 'Prueba fallida: B escribió en un ciclo de A';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  UPDATE biblib.loans SET returned_on = '2026-04-07' WHERE id = loan_a.id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  PERFORM assert_true(affected = 0, 'B no devuelve préstamos de A');
  DELETE FROM biblib.reading_cycles WHERE id = cycle_a;
  GET DIAGNOSTICS affected = ROW_COUNT;
  PERFORM assert_true(affected = 0, 'B no borra lecturas de A');
  PERFORM assert_true(biblib.loan_return(loan_a.id, loan_a.version, '2026-04-07')->>'status' = 'not_found', 'loan_return no revela préstamos de A');
  PERFORM assert_true(biblib.reading_cycle_close(cycle_a, gen_random_uuid(), 'finished', NULL)->>'status' = 'not_found', 'reading_cycle_close no revela ciclos de A');
  RESET ROLE;
  PERFORM assert_true((SELECT returned_on IS NULL AND version = loan_a.version FROM biblib.loans WHERE id = loan_a.id), 'el préstamo de A sigue intacto');
END;
$test$;
SELECT 'Correcto: aislamiento A/B en lectura y préstamos, también por las funciones';

-- Límites (BP001): 50 ciclos por ejemplar y 1000 entradas por ciclo, también en una sola sentencia. Revisión de colección:
-- escribir lectura o préstamos la rota. Copia borrada: su lectura y sus préstamos se retiran con ella.
CREATE TEMP TABLE o14_revision AS SELECT revision FROM biblib.library_state WHERE user_id = 'b1500000-0000-4000-8000-0000000000a1';
DO $test$
DECLARE
  owner_a uuid := 'b1500000-0000-4000-8000-0000000000a1';
  copy_a4 uuid := 'b1520000-0000-4000-8000-0000000000a4';
  cycle_id uuid;
  revision_before uuid := (SELECT revision FROM o14_revision);
BEGIN
  PERFORM set_config('request.jwt.claim.sub', owner_a::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO biblib.reading_cycles(user_id, copy_id, cycle_number, status) SELECT owner_a, copy_a4, n, 'finished' FROM generate_series(1, 50) AS n;
  BEGIN
    PERFORM biblib.reading_cycle_start(copy_a4, NULL);
    RAISE EXCEPTION 'Prueba fallida: aceptó el ciclo 51 de un ejemplar';
  EXCEPTION WHEN SQLSTATE 'BP001' THEN NULL; END;
  SELECT id INTO cycle_id FROM biblib.reading_cycles WHERE copy_id = copy_a4 AND cycle_number = 1;
  BEGIN
    INSERT INTO biblib.reading_entries(user_id, cycle_id, occurred_at, note) SELECT owner_a, cycle_id, now(), 'Sesión ' || n FROM generate_series(1, 1001) AS n;
    RAISE EXCEPTION 'Prueba fallida: aceptó 1001 entradas en un ciclo';
  EXCEPTION WHEN SQLSTATE 'BP001' THEN NULL; END;
  RESET ROLE;
  -- Copia borrada: arrastra sus 50 ciclos y su préstamo; el resto de la cuenta no cambia.
  DELETE FROM biblib.copies WHERE id = copy_a4;
  PERFORM assert_true(NOT EXISTS (SELECT 1 FROM biblib.reading_cycles WHERE copy_id = copy_a4) AND NOT EXISTS (SELECT 1 FROM biblib.loans WHERE copy_id = copy_a4),
    'la copia borrada se lleva su lectura y sus préstamos');
  PERFORM assert_true((SELECT count(*) FROM biblib.reading_cycles WHERE user_id = owner_a) = 3 AND (SELECT count(*) FROM biblib.loans WHERE user_id = owner_a) = 2, 'lo demás sigue');
  PERFORM assert_true((SELECT revision FROM biblib.library_state WHERE user_id = owner_a) <> revision_before, 'la revisión de colección rota');
END;
$test$;
DROP TABLE o14_revision;
SELECT 'Correcto: límites de ciclos y entradas, revisión de colección y copia borrada sin restos';

-- Versiones anteriores (esquema 4): cada ejemplar conserva sus ciclos con sus entradas y sus préstamos; los IDs que hoy
-- usa otra cuenta se informan.
DO $test$
DECLARE
  owner_a uuid := 'b1500000-0000-4000-8000-0000000000a1';
  operation_id uuid := gen_random_uuid();
  captured jsonb;
  entry jsonb;
  moved uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', owner_a::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO biblib.library_operations(id, user_id, operation, idempotency_key, input_digest, status, result) VALUES (operation_id, owner_a, 'import.confirm', 'clave-lectura-o14-01', repeat('e', 64), 'committed', '{}');
  captured := biblib.library_snapshot_capture(operation_id, 'import.replace');
  PERFORM assert_true((SELECT schema_version = 4 AND (counts->>'reading_cycles')::integer = 3 AND (counts->>'reading_entries')::integer = 3 AND (counts->>'loans')::integer = 2
    FROM biblib.library_snapshots WHERE id = (captured->>'id')::uuid), 'esquema 4 con recuentos de lectura y préstamos');
  SELECT item INTO entry FROM biblib.library_snapshot_chunks AS c CROSS JOIN LATERAL jsonb_array_elements(c.payload) AS item
  WHERE c.snapshot_id = (captured->>'id')::uuid AND c.kind = 'books' AND item->>'id' = 'b1520000-0000-4000-8000-0000000000a1';
  PERFORM assert_true(jsonb_array_length(entry->'reading') = 2 AND entry->'reading'->0->>'status' = 'finished' AND (entry->'reading'->0->>'cycle_number')::integer = 1
    AND (entry->'reading'->0->>'started_at')::timestamptz = '2026-01-10T10:00:00Z' AND NOT entry->'reading'->1 ? 'started_at', 'ciclos en orden, sin fechas inventadas');
  PERFORM assert_true(jsonb_array_length(entry->'reading'->1->'entries') = 2 AND (entry->'reading'->1->'entries'->0->>'page_to')::integer = 300
    AND entry->'reading'->1->'entries'->1->>'note' = 'Solo una nota' AND NOT entry->'reading'->1->'entries'->1 ? 'page_to', 'entradas del ciclo sin claves vacías');
  PERFORM assert_true(NOT entry ? 'loans', 'sin préstamos, sin sección');
  SELECT item INTO entry FROM biblib.library_snapshot_chunks AS c CROSS JOIN LATERAL jsonb_array_elements(c.payload) AS item
  WHERE c.snapshot_id = (captured->>'id')::uuid AND c.kind = 'books' AND item->>'id' = 'b1520000-0000-4000-8000-0000000000a3';
  PERFORM assert_true(jsonb_array_length(entry->'loans') = 2 AND entry->'loans'->0->>'loaned_on' = '2026-03-29' AND entry->'loans'->0->>'returned_on' = '2026-04-05'
    AND entry->'loans'->1->>'due_on' = '2026-05-06' AND NOT entry->'loans'->1 ? 'returned_on', 'préstamos con fechas civiles, el activo sin devolución');
  PERFORM assert_true(cardinality(biblib.library_snapshot_foreign_ids((captured->>'id')::uuid)) = 0, 'sin IDs ajenos');
  RESET ROLE;
  -- Un préstamo de la versión cuyo ID hoy es de otra cuenta se informa.
  moved := (entry->'loans'->0->>'id')::uuid;
  DELETE FROM biblib.loans WHERE id = moved;
  INSERT INTO biblib.loans(id, user_id, copy_id, borrower_label, loaned_on) VALUES (moved, 'b1500000-0000-4000-8000-0000000000b1', 'b1520000-0000-4000-8000-0000000000b1', 'Ajeno', '2026-01-01');
  PERFORM set_config('request.jwt.claim.sub', owner_a::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM assert_true(biblib.library_snapshot_foreign_ids((captured->>'id')::uuid) = ARRAY[moved], 'el préstamo ajeno se informa');
  RESET ROLE;
  RAISE EXCEPTION USING ERRCODE = 'P0004', MESSAGE = 'rollback';
EXCEPTION WHEN SQLSTATE 'P0004' THEN NULL;
END;
$test$;
SELECT 'Correcto: versiones anteriores con lectura y préstamos (esquema 4) e IDs ajenos informados';

-- Cuenta en eliminación (C): ninguna escritura de lectura ni préstamos, tampoco por las funciones; el paso `product` los
-- retira y no avanza con restos.
INSERT INTO auth.users(id) VALUES ('b1500000-0000-4000-8000-0000000000c1');
INSERT INTO biblib.shelves(id, user_id, title, is_default) VALUES ('b1510000-0000-4000-8000-0000000000c1', 'b1500000-0000-4000-8000-0000000000c1', 'Principal', true);
INSERT INTO biblib.books(id, user_id, isbn, title, shelf_id, number_of_pages) VALUES ('b1520000-0000-4000-8000-0000000000c1', 'b1500000-0000-4000-8000-0000000000c1', 'manual-o14-c', 'De C', 'b1510000-0000-4000-8000-0000000000c1', 120);
DO $test$
DECLARE
  owner_c uuid := 'b1500000-0000-4000-8000-0000000000c1';
  started jsonb;
  opened jsonb;
  statement text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', owner_c::text, true);
  SET LOCAL ROLE authenticated;
  started := biblib.reading_cycle_start('b1520000-0000-4000-8000-0000000000c1', '2026-05-01T09:00:00Z');
  INSERT INTO biblib.reading_entries(user_id, cycle_id, occurred_at, page_to) VALUES (owner_c, (started->>'cycle_id')::uuid, '2026-05-01T10:00:00Z', 20);
  opened := biblib.loan_open('b1520000-0000-4000-8000-0000000000c1', 'Primo', '2026-05-02', NULL, NULL);
  PERFORM biblib.account_deletion_request('clave-eliminacion-c-o14');
  FOREACH statement IN ARRAY ARRAY[
    format($$SELECT biblib.reading_cycle_start(%L, NULL)$$, 'b1520000-0000-4000-8000-0000000000c1'),
    format($$SELECT biblib.reading_cycle_close(%L, %L, 'finished', NULL)$$, started->>'cycle_id', started->>'version'),
    format($$SELECT biblib.loan_open(%L, 'Otro', '2026-05-03', NULL, NULL)$$, 'b1520000-0000-4000-8000-0000000000c1'),
    format($$SELECT biblib.loan_return(%L, %L, '2026-05-04')$$, opened->>'loan_id', opened->>'version'),
    format($$INSERT INTO biblib.reading_entries(user_id, cycle_id, occurred_at, page_to) VALUES (%L, %L, now(), 30)$$, owner_c, started->>'cycle_id'),
    $$UPDATE biblib.reading_cycles SET status = 'paused' WHERE user_id = 'b1500000-0000-4000-8000-0000000000c1'$$,
    $$DELETE FROM biblib.reading_entries WHERE user_id = 'b1500000-0000-4000-8000-0000000000c1'$$,
    $$UPDATE biblib.loans SET note = 'Tarde' WHERE user_id = 'b1500000-0000-4000-8000-0000000000c1'$$,
    $$DELETE FROM biblib.loans WHERE user_id = 'b1500000-0000-4000-8000-0000000000c1'$$
  ] LOOP
    BEGIN
      EXECUTE statement;
      RAISE EXCEPTION 'Prueba fallida: escribió con la cuenta en eliminación: %', statement;
    EXCEPTION WHEN SQLSTATE 'BD001' THEN NULL; END;
  END LOOP;
  RESET ROLE;
END;
$test$;
DO $test$
DECLARE
  owner_c uuid := 'b1500000-0000-4000-8000-0000000000c1';
  token uuid := (biblib.account_deletion_claim('b1500000-0000-4000-8000-0000000000c1', 60000)->>'token')::uuid;
  removed integer;
  total integer := 0;
BEGIN
  UPDATE biblib.account_deletions SET step = 'product' WHERE user_id = owner_c;
  BEGIN
    PERFORM biblib.account_deletion_advance(owner_c, token, 'product', '{}', 60000);
    RAISE EXCEPTION 'Prueba fallida: avanzó con lectura o préstamos';
  EXCEPTION WHEN SQLSTATE 'BD004' THEN NULL; END;
  LOOP
    removed := biblib.account_deletion_purge(owner_c, token, 'product', 1);
    EXIT WHEN removed = 0;
    total := total + removed;
  END LOOP;
  PERFORM assert_true(total = 3 AND NOT EXISTS (SELECT 1 FROM biblib.reading_cycles WHERE user_id = owner_c) AND NOT EXISTS (SELECT 1 FROM biblib.loans WHERE user_id = owner_c),
    'el paso product retira entradas, ciclos y préstamos');
  PERFORM assert_true(biblib.account_deletion_advance(owner_c, token, 'product', '{}', 60000) = 'media', 'tras product, media');
  PERFORM assert_true(EXISTS (SELECT 1 FROM biblib.copies WHERE user_id = owner_c), 'los ejemplares siguen hasta su paso');
END;
$test$;
SELECT 'Correcto: cuenta en eliminación sin escrituras de lectura ni préstamos; el paso product los retira';

-- Inventario, guardas y privilegios: toda tabla de biblib con dueño la retira un paso, toda escritura de cliente exige
-- cuenta activa, las funciones de lectura y préstamos son SECURITY INVOKER con search_path fijo y solo para authenticated.
DO $test$
DECLARE
  item record;
  covered text[] := ARRAY[]::text[];
  step_name text;
BEGIN
  FOREACH step_name IN ARRAY ARRAY['covers', 'snapshots', 'staging', 'jobs', 'views', 'previews', 'operations', 'private_cache', 'product', 'media', 'copies', 'editions', 'works', 'shelves', 'state'] LOOP
    covered := covered || biblib.account_deletion_step_tables(step_name);
  END LOOP;
  PERFORM assert_true((biblib.account_deletion_step_tables('product'))[1:3] = ARRAY['reading_entries', 'reading_cycles', 'loans'], 'lectura y préstamos al principio de product');
  FOR item IN SELECT DISTINCT c.relname AS name FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace JOIN pg_attribute AS a ON a.attrelid = c.oid
    WHERE n.nspname = 'biblib' AND c.relkind = 'r' AND c.relname NOT IN ('account_deletions', 'account_lifecycle') AND a.attname IN ('user_id', 'owner_id') AND NOT a.attisdropped
  LOOP
    PERFORM assert_true(item.name = ANY(covered), format('la tabla %s tiene paso de eliminación', item.name));
  END LOOP;
  FOR item IN SELECT g.table_name AS name, lower(g.privilege_type) AS command FROM information_schema.role_table_grants AS g
    JOIN pg_class AS c ON c.relname = g.table_name JOIN pg_namespace AS n ON n.oid = c.relnamespace AND n.nspname = g.table_schema
    WHERE g.table_schema = 'biblib' AND g.grantee = 'authenticated' AND g.privilege_type IN ('INSERT', 'UPDATE', 'DELETE') AND c.relkind = 'r'
  LOOP
    PERFORM assert_true(EXISTS (SELECT 1 FROM pg_policy AS p WHERE p.polrelid = format('biblib.%I', item.name)::regclass AND NOT p.polpermissive
      AND p.polcmd = CASE item.command WHEN 'insert' THEN 'a' WHEN 'update' THEN 'w' ELSE 'd' END
      AND coalesce(pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) LIKE '%account_write_allowed%'), format('%s.%s exige cuenta activa', item.name, item.command));
  END LOOP;
  FOR item IN SELECT p.oid, p.proname, p.prosecdef, p.proconfig FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'biblib' AND p.proname IN ('reading_cycle_start', 'reading_cycle_close', 'loan_open', 'loan_return')
  LOOP
    PERFORM assert_true(NOT item.prosecdef AND 'search_path=pg_catalog' = ANY(item.proconfig), format('%s es invoker con search_path fijo', item.proname));
    PERFORM assert_true(has_function_privilege('authenticated', item.oid, 'EXECUTE') AND NOT has_function_privilege('anon', item.oid, 'EXECUTE'), format('%s solo para authenticated', item.proname));
  END LOOP;
  PERFORM assert_true((SELECT count(*) FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'biblib' AND p.proname IN ('reading_cycle_start', 'reading_cycle_close', 'loan_open', 'loan_return')) = 4, 'las cuatro funciones existen');
  PERFORM assert_true(NOT has_function_privilege('authenticated', 'biblib.guard_reading_entry_pages()', 'EXECUTE'), 'la guarda de páginas no es invocable');
  PERFORM assert_true(NOT has_table_privilege('anon', 'biblib.loans', 'SELECT') AND NOT has_table_privilege('anon', 'biblib.reading_cycles', 'SELECT')
    AND NOT has_table_privilege('anon', 'biblib.reading_entries', 'SELECT'), 'anon no ve nada');
END;
$test$;
SELECT 'Correcto: inventario de eliminación, guarda de cuenta activa y funciones invoker con las tablas de 0015';

SELECT public.assert_true((SELECT count(*) = 2 FROM biblib.books), '0001 conserva los libros previos');
SELECT public.assert_true((SELECT bool_and(catalogue = '{"source":"import","isbnVerified":false}'::jsonb) FROM biblib.books), '0001 asigna procedencia provisional a libros previos');

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
SELECT public.assert_true((SELECT count(*) = 1 FROM biblib.books), 'A solo lee su libro');
SELECT public.assert_true((SELECT count(*) = 2 FROM biblib.shelves), 'A solo lee sus estanterías');
SELECT public.assert_true((SELECT count(*) = 0 FROM biblib.books WHERE user_id = '10000000-0000-4000-8000-000000000002'), 'A no lee libros de B');

DO $test$
DECLARE affected integer;
BEGIN
  UPDATE biblib.books SET title = 'Ataque' WHERE id = '30000000-0000-4000-8000-000000000002';
  GET DIAGNOSTICS affected = ROW_COUNT;
  PERFORM public.assert_true(affected = 0, 'A no actualiza libros de B');
  DELETE FROM biblib.books WHERE id = '30000000-0000-4000-8000-000000000002';
  GET DIAGNOSTICS affected = ROW_COUNT;
  PERFORM public.assert_true(affected = 0, 'A no elimina libros de B');
  UPDATE biblib.shelves SET title = 'Ataque' WHERE id = '20000000-0000-4000-8000-000000000004';
  GET DIAGNOSTICS affected = ROW_COUNT;
  PERFORM public.assert_true(affected = 0, 'A no actualiza estanterías de B');
  DELETE FROM biblib.shelves WHERE id = '20000000-0000-4000-8000-000000000004';
  GET DIAGNOSTICS affected = ROW_COUNT;
  PERFORM public.assert_true(affected = 0, 'A no elimina estanterías de B');

  BEGIN
    INSERT INTO biblib.books(user_id, isbn, title, shelf_id) VALUES ('10000000-0000-4000-8000-000000000002', 'intento-ajeno', 'Intruso', '20000000-0000-4000-8000-000000000004');
    RAISE EXCEPTION 'Prueba fallida: A insertó un libro para B';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO biblib.shelves(user_id, title) VALUES ('10000000-0000-4000-8000-000000000002', 'Intruso');
    RAISE EXCEPTION 'Prueba fallida: A insertó una estantería para B';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    INSERT INTO biblib.books(user_id, isbn, title, shelf_id) VALUES ('10000000-0000-4000-8000-000000000001', 'intento-fk', 'Referencia ajena', '20000000-0000-4000-8000-000000000004');
    RAISE EXCEPTION 'Prueba fallida: FK permite estantería de otro dueño';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    UPDATE biblib.books SET shelf_id = '20000000-0000-4000-8000-000000000004' WHERE id = '30000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'Prueba fallida: se movió un libro a la estantería ajena';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    UPDATE biblib.books SET user_id = '10000000-0000-4000-8000-000000000002', shelf_id = '20000000-0000-4000-8000-000000000004' WHERE id = '30000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'Prueba fallida: se cambió el dueño del libro';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  UPDATE biblib.shelves SET title = 'Renombrada' WHERE id = '20000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS affected = ROW_COUNT;
  PERFORM public.assert_true(affected = 0, 'la predeterminada no se renombra');
  DELETE FROM biblib.shelves WHERE id = '20000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS affected = ROW_COUNT;
  PERFORM public.assert_true(affected = 0, 'la predeterminada no se elimina');
  BEGIN
    UPDATE biblib.shelves SET is_default = true WHERE id = '20000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'Prueba fallida: se convirtió una estantería en predeterminada';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    UPDATE biblib.books SET number_of_pages = -1 WHERE id = '30000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'Prueba fallida: se guardaron páginas negativas';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE biblib.books SET title = '   ' WHERE id = '30000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'Prueba fallida: se guardó un título vacío';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE biblib.books SET status = 'inexistente' WHERE id = '30000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'Prueba fallida: se guardó un estado inválido';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE biblib.shelves SET title = '   ' WHERE id = '20000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'Prueba fallida: se guardó una estantería sin título';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.books(user_id, isbn, title, shelf_id) VALUES ('10000000-0000-4000-8000-000000000001', '9788401337208', 'Duplicado', '20000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'Prueba fallida: se duplicó un ISBN del mismo usuario';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- El bloque interno es una subtransacción: un error debe revertir todas sus escrituras.
  BEGIN
    DELETE FROM biblib.books;
    INSERT INTO biblib.books(user_id, isbn, title, shelf_id) VALUES ('10000000-0000-4000-8000-000000000001', 'nuevo-en-reemplazo', 'Importación parcial', '20000000-0000-4000-8000-000000000002');
    INSERT INTO biblib.books(user_id, isbn, title, number_of_pages, shelf_id) VALUES ('10000000-0000-4000-8000-000000000001', 'fallo-en-reemplazo', 'Error', -1, '20000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'Prueba fallida: no falló la escritura inválida';
  EXCEPTION WHEN check_violation THEN NULL; END;
  PERFORM public.assert_true((SELECT count(*) = 1 FROM biblib.books), 'el rollback restaura la colección anterior');
  PERFORM public.assert_true((SELECT title = 'Libro de A' FROM biblib.books WHERE id = '30000000-0000-4000-8000-000000000001'), 'el rollback conserva la ficha original');

  UPDATE biblib.books SET title = 'Libro de A actualizado' WHERE id = '30000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS affected = ROW_COUNT;
  PERFORM public.assert_true(affected = 1, 'A sí actualiza su libro');
END;
$test$;
COMMIT;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
SELECT public.assert_true((SELECT count(*) = 1 AND min(title) = 'Libro de B' FROM biblib.books), 'B conserva sus datos después de operaciones de A');
SELECT public.assert_true((SELECT count(*) = 2 FROM biblib.shelves), 'B conserva sus estanterías');
COMMIT;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claims', '', true);
SELECT public.assert_true((SELECT count(*) = 0 FROM biblib.books), 'una sesión sin claims no hereda libros del usuario anterior');
SELECT public.assert_true((SELECT count(*) = 0 FROM biblib.shelves), 'una sesión sin claims no hereda estanterías del usuario anterior');
COMMIT;

SELECT 'Correcto: migraciones, aislamiento A/B, FK de propietario, predeterminada, integridad y rollback.' AS resultado;

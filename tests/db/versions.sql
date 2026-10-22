SELECT public.assert_true((SELECT count(*) = 2 AND count(DISTINCT version) = 2 FROM biblib.books), '0002 asigna versiones únicas a los libros anteriores');
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
DO $test$
DECLARE initial_version uuid; second_version uuid; restored_version uuid; affected integer;
BEGIN
  SELECT version INTO initial_version FROM biblib.books WHERE id = '30000000-0000-4000-8000-000000000001';
  UPDATE biblib.books SET status = 'reading' WHERE id = '30000000-0000-4000-8000-000000000001' AND version = initial_version RETURNING version INTO second_version;
  PERFORM public.assert_true(initial_version <> second_version, 'un cambio de estado invalida el formulario anterior');
  UPDATE biblib.books SET title = 'Cambio antiguo' WHERE id = '30000000-0000-4000-8000-000000000001' AND version = initial_version;
  GET DIAGNOSTICS affected = ROW_COUNT;
  PERFORM public.assert_true(affected = 0, 'la versión antigua no sobrescribe la ficha');
  -- Incluso intentar reintroducir el token anterior no lo reutiliza.
  UPDATE biblib.books SET version = initial_version WHERE id = '30000000-0000-4000-8000-000000000001' RETURNING version INTO restored_version;
  PERFORM public.assert_true(restored_version <> initial_version AND restored_version <> second_version, 'SQL directo también rota el token');
  DELETE FROM biblib.books WHERE id = '30000000-0000-4000-8000-000000000001';
  INSERT INTO biblib.books(id,user_id,isbn,title,shelf_id,version) VALUES ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','9788401337208','Restaurado','20000000-0000-4000-8000-000000000001',initial_version) RETURNING version INTO restored_version;
  PERFORM public.assert_true(restored_version <> initial_version, 'restaurar el mismo ID no reactiva formularios antiguos');
END;
$test$;
ROLLBACK;
SELECT 'Correcto: versiones, escritura condicional y restauración sin reutilización de tokens.' AS resultado;

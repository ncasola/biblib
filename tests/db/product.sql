-- O13 · 0014. Lote de producto: backfill de evidencias, etiquetas normalizadas y límites, notas y valoración, árbol de
-- ubicaciones sin ciclos, series con posición NUMERIC exacta, assets privados de imagen y su bucket, perfil con
-- avatar, revisión, columnas CSV del staging, aislamiento A/B con FK del mismo dueño, cuenta en eliminación, inventario
-- de eliminación y versiones anteriores con los datos nuevos. Cuentas: P (A), Q (B) de product-legacy.sql y R (C).

-- Backfill: una evidencia por edición con su fuente, sin URL ni foto inventadas; la comprobación física, solo en el
-- ejemplar comprobado por una persona.
DO $test$
DECLARE
  owner_a uuid := 'b1400000-0000-4000-8000-0000000000a1';
BEGIN
  PERFORM assert_true((SELECT count(*) FROM biblib.bibliographic_evidence WHERE origin = 'backfill' AND edition_id IS NOT NULL) = (SELECT count(*) FROM biblib.editions), 'una evidencia inicial por edición');
  PERFORM assert_true((SELECT source_kind = 'provider' AND source_ref = 'open-library' AND source_url = 'https://openlibrary.org/books/OL1M' AND confidence = 'bibliographic_match'
    FROM biblib.bibliographic_evidence WHERE edition_id = 'b1420000-0000-4000-8000-0000000000a1'), 'Open Library: proveedor con su URL');
  PERFORM assert_true((SELECT source_kind = 'manual' AND source_url IS NULL AND confidence = 'provisional' FROM biblib.bibliographic_evidence WHERE edition_id = 'b1420000-0000-4000-8000-0000000000a2'), 'manual provisional sin URL');
  PERFORM assert_true((SELECT source_kind = 'photo' AND photo_asset_id IS NULL AND source_url IS NULL AND confidence = 'provisional'
    FROM biblib.bibliographic_evidence WHERE edition_id = 'b1420000-0000-4000-8000-0000000000a3'), 'foto declarada sin asset: no se inventa la foto');
  PERFORM assert_true((SELECT field_claims = '{"fields":{"title":{"provider":"bne","selection":"user-selected"}}}'::jsonb AND confidence = 'bibliographic_match'
    FROM biblib.bibliographic_evidence WHERE edition_id = 'b1420000-0000-4000-8000-0000000000a4'), 'procedencia por campo como afirmaciones');
  PERFORM assert_true((SELECT count(*) FROM biblib.bibliographic_evidence WHERE confidence = 'physically_checked') = (SELECT count(*) FROM biblib.copies WHERE edition_verification->'isbnVerified' = 'true'::jsonb),
    'una comprobación física por ejemplar comprobado, ninguna más');
  PERFORM assert_true((SELECT copy_id = 'b1420000-0000-4000-8000-0000000000a3' AND observed_at = '2026-10-01T10:00:00Z'::timestamptz AND source_kind = 'manual'
    FROM biblib.bibliographic_evidence WHERE user_id = owner_a AND confidence = 'physically_checked'), 'el ejemplar comprobado conserva su fecha');
  PERFORM assert_true(NOT EXISTS (SELECT 1 FROM biblib.bibliographic_evidence WHERE copy_id = 'b1420000-0000-4000-8000-0000000000a5'), 'la segunda copia de una edición no hereda la comprobación');
  PERFORM assert_true(NOT EXISTS (SELECT 1 FROM biblib.bibliographic_evidence WHERE confidence = 'physically_checked' AND source_kind = 'provider'), 'ningún proveedor acredita verificación física');
END;
$test$;
SELECT 'Correcto: procedencia convertida en evidencia inicial sin URL ni foto inventadas';

-- Normalización de etiquetas idéntica a la del cliente.
SELECT assert_true(biblib.tag_normalize('  Novela   Histórica ') = 'novela historica', 'espacios, mayúsculas y acentos');
SELECT assert_true(biblib.tag_normalize('AÑO') = 'año' AND biblib.tag_normalize('año') <> biblib.tag_normalize('ano'), 'la ñ se conserva');
SELECT assert_true(biblib.tag_normalize('Pingüino Éxito') = 'pinguino exito', 'diéresis y tildes');
SELECT 'Correcto: normalización de etiquetas';

-- Etiquetas: unicidad normalizada por cuenta, longitud, 20 por ejemplar, asociación del mismo dueño y RLS.
DO $test$
DECLARE
  owner_a uuid := 'b1400000-0000-4000-8000-0000000000a1';
  owner_b uuid := 'b1400000-0000-4000-8000-0000000000b1';
  tag_a uuid;
  affected integer;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', owner_a::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO biblib.tags(user_id, name) VALUES (owner_a, 'Novela') RETURNING id INTO tag_a;
  BEGIN
    INSERT INTO biblib.tags(user_id, name) VALUES (owner_a, 'NÓVELA');
    RAISE EXCEPTION 'Prueba fallida: duplicó una etiqueta por mayúsculas y acentos';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  INSERT INTO biblib.tags(user_id, name) VALUES (owner_a, 'Año'), (owner_a, 'Ano');
  BEGIN
    INSERT INTO biblib.tags(user_id, name) VALUES (owner_a, repeat('x', 41));
    RAISE EXCEPTION 'Prueba fallida: aceptó una etiqueta de 41 caracteres';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.tags(user_id, name) VALUES (owner_a, ' Espacios ');
    RAISE EXCEPTION 'Prueba fallida: aceptó espacios en los extremos';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO biblib.tags(user_id, name) VALUES (owner_a, repeat('ñ', 40));
  INSERT INTO biblib.copy_tags(user_id, copy_id, tag_id) VALUES (owner_a, 'b1420000-0000-4000-8000-0000000000a1', tag_a);
  -- 20 etiquetas en un ejemplar; la 21.ª se rechaza (BP001), también en una sola sentencia.
  INSERT INTO biblib.tags(user_id, name) SELECT owner_a, 'Tema ' || n FROM generate_series(1, 21) AS n;
  INSERT INTO biblib.copy_tags(user_id, copy_id, tag_id) SELECT owner_a, 'b1420000-0000-4000-8000-0000000000a2', id FROM biblib.tags WHERE user_id = owner_a AND name LIKE 'Tema %' ORDER BY name LIMIT 20;
  BEGIN
    INSERT INTO biblib.copy_tags(user_id, copy_id, tag_id) SELECT owner_a, 'b1420000-0000-4000-8000-0000000000a2', id FROM biblib.tags WHERE user_id = owner_a AND name LIKE 'Tema %' ORDER BY name OFFSET 20;
    RAISE EXCEPTION 'Prueba fallida: aceptó la etiqueta 21 de un ejemplar';
  EXCEPTION WHEN SQLSTATE 'BP001' THEN NULL; END;
  BEGIN
    INSERT INTO biblib.copy_tags(user_id, copy_id, tag_id) SELECT owner_a, 'b1420000-0000-4000-8000-0000000000a5', id FROM biblib.tags WHERE user_id = owner_a AND name LIKE 'Tema %';
    RAISE EXCEPTION 'Prueba fallida: aceptó 21 etiquetas en una sola sentencia';
  EXCEPTION WHEN SQLSTATE 'BP001' THEN NULL; END;
  -- B no ve las etiquetas de A, no etiqueta ejemplares de A ni usa sus etiquetas.
  PERFORM set_config('request.jwt.claim.sub', owner_b::text, true);
  PERFORM assert_true((SELECT count(*) FROM biblib.tags) = 0 AND (SELECT count(*) FROM biblib.copy_tags) = 0, 'B no ve etiquetas de A');
  INSERT INTO biblib.tags(user_id, name) VALUES (owner_b, 'Novela');
  BEGIN
    INSERT INTO biblib.copy_tags(user_id, copy_id, tag_id) VALUES (owner_b, 'b1420000-0000-4000-8000-0000000000a1', (SELECT id FROM biblib.tags WHERE user_id = owner_b));
    RAISE EXCEPTION 'Prueba fallida: B etiquetó un ejemplar de A';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.copy_tags(user_id, copy_id, tag_id) VALUES (owner_b, 'b1420000-0000-4000-8000-0000000000b1', tag_a);
    RAISE EXCEPTION 'Prueba fallida: B usó una etiqueta de A';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.tags(user_id, name) VALUES (owner_a, 'Intrusa');
    RAISE EXCEPTION 'Prueba fallida: B creó una etiqueta para A';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  DELETE FROM biblib.tags WHERE id = tag_a;
  GET DIAGNOSTICS affected = ROW_COUNT;
  PERFORM assert_true(affected = 0, 'B no borra etiquetas de A');
  RESET ROLE;
  -- Borrar la etiqueta retira la asociación, nunca el libro.
  DELETE FROM biblib.tags WHERE id = tag_a;
  PERFORM assert_true(EXISTS (SELECT 1 FROM biblib.copies WHERE id = 'b1420000-0000-4000-8000-0000000000a1') AND NOT EXISTS (SELECT 1 FROM biblib.copy_tags WHERE tag_id = tag_a), 'el libro sigue sin la etiqueta');
END;
$test$;
SELECT 'Correcto: etiquetas únicas por nombre normalizado, límites, FK del mismo dueño y RLS';

-- Notas y valoración por ejemplar.
DO $test$
DECLARE
  owner_a uuid := 'b1400000-0000-4000-8000-0000000000a1';
  first_version uuid;
  affected integer;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', owner_a::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO biblib.copy_annotations(user_id, copy_id, notes, rating) VALUES (owner_a, 'b1420000-0000-4000-8000-0000000000a1', repeat('n', 4000), 5) RETURNING version INTO first_version;
  INSERT INTO biblib.copy_annotations(user_id, copy_id, notes, rating) VALUES (owner_a, 'b1420000-0000-4000-8000-0000000000a5', NULL, NULL);
  BEGIN
    INSERT INTO biblib.copy_annotations(user_id, copy_id, notes) VALUES (owner_a, 'b1420000-0000-4000-8000-0000000000a2', repeat('n', 4001));
    RAISE EXCEPTION 'Prueba fallida: aceptó 4001 caracteres';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.copy_annotations(user_id, copy_id, rating) VALUES (owner_a, 'b1420000-0000-4000-8000-0000000000a2', 6);
    RAISE EXCEPTION 'Prueba fallida: aceptó una valoración 6';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.copy_annotations(user_id, copy_id, rating) VALUES (owner_a, 'b1420000-0000-4000-8000-0000000000a1', 3);
    RAISE EXCEPTION 'Prueba fallida: dos notas para un ejemplar';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  UPDATE biblib.copy_annotations SET rating = 4 WHERE copy_id = 'b1420000-0000-4000-8000-0000000000a1' AND version = first_version;
  PERFORM assert_true((SELECT version <> first_version FROM biblib.copy_annotations WHERE copy_id = 'b1420000-0000-4000-8000-0000000000a1'), 'escribir rota la versión');
  UPDATE biblib.copy_annotations SET rating = 1 WHERE copy_id = 'b1420000-0000-4000-8000-0000000000a1' AND version = first_version;
  GET DIAGNOSTICS affected = ROW_COUNT;
  PERFORM assert_true(affected = 0, 'una versión antigua no escribe');
  PERFORM set_config('request.jwt.claim.sub', 'b1400000-0000-4000-8000-0000000000b1', true);
  PERFORM assert_true((SELECT count(*) FROM biblib.copy_annotations) = 0, 'B no lee notas de A');
  BEGIN
    INSERT INTO biblib.copy_annotations(user_id, copy_id, notes) VALUES ('b1400000-0000-4000-8000-0000000000b1', 'b1420000-0000-4000-8000-0000000000a2', 'Intrusa');
    RAISE EXCEPTION 'Prueba fallida: B anotó un ejemplar de A';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  RESET ROLE;
  PERFORM assert_true(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'biblib' AND table_name = 'books_legacy' AND column_name IN ('notes', 'rating')), 'books legacy sin notas ni valoración');
END;
$test$;
SELECT 'Correcto: notas de hasta 4000 caracteres y valoración 1–5 o nula por ejemplar, con versión y RLS';

-- Ubicaciones: árbol del mismo dueño, sin ciclos ni más de 8 niveles; una ubicación actual por ejemplar.
DO $test$
DECLARE
  owner_a uuid := 'b1400000-0000-4000-8000-0000000000a1';
  owner_b uuid := 'b1400000-0000-4000-8000-0000000000b1';
  room uuid := 'b1430000-0000-4000-8000-0000000000a1';
  bookcase uuid := 'b1430000-0000-4000-8000-0000000000a2';
  shelf uuid := 'b1430000-0000-4000-8000-0000000000a3';
  previous uuid;
  node uuid;
  i integer;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', owner_a::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO biblib.locations(id, user_id, parent_id, name, kind) VALUES (room, owner_a, NULL, 'Salón', 'room'), (bookcase, owner_a, room, 'Estantería alta', 'bookcase'), (shelf, owner_a, bookcase, 'Balda 3', 'shelf');
  BEGIN
    UPDATE biblib.locations SET parent_id = shelf WHERE id = room;
    RAISE EXCEPTION 'Prueba fallida: aceptó un ciclo';
  EXCEPTION WHEN SQLSTATE 'BL001' THEN NULL; END;
  BEGIN
    UPDATE biblib.locations SET parent_id = room WHERE id = room;
    RAISE EXCEPTION 'Prueba fallida: una ubicación dentro de sí misma';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.locations(id, user_id, parent_id, name, kind) VALUES
      ('b1430000-0000-4000-8000-0000000000c1', owner_a, 'b1430000-0000-4000-8000-0000000000c2', 'Caja 1', 'box'),
      ('b1430000-0000-4000-8000-0000000000c2', owner_a, 'b1430000-0000-4000-8000-0000000000c1', 'Caja 2', 'box');
    RAISE EXCEPTION 'Prueba fallida: aceptó un ciclo dentro de una sola sentencia';
  EXCEPTION WHEN SQLSTATE 'BL001' THEN NULL; END;
  -- Ocho niveles sí; el noveno no, tampoco al mover un subárbol debajo de otro.
  previous := NULL;
  FOR i IN 1..8 LOOP
    INSERT INTO biblib.locations(user_id, parent_id, name, kind) VALUES (owner_a, previous, 'Nivel ' || i, 'other') RETURNING id INTO node;
    previous := node;
  END LOOP;
  BEGIN
    INSERT INTO biblib.locations(user_id, parent_id, name, kind) VALUES (owner_a, previous, 'Nivel 9', 'other');
    RAISE EXCEPTION 'Prueba fallida: aceptó 9 niveles';
  EXCEPTION WHEN SQLSTATE 'BL002' THEN NULL; END;
  BEGIN
    UPDATE biblib.locations SET parent_id = previous WHERE id = room;
    RAISE EXCEPTION 'Prueba fallida: aceptó mover un subárbol por encima de 8 niveles';
  EXCEPTION WHEN SQLSTATE 'BL002' THEN NULL; END;
  INSERT INTO biblib.copy_locations(user_id, copy_id, location_id, shelf_label, position) VALUES (owner_a, 'b1420000-0000-4000-8000-0000000000a1', shelf, 'Balda 3', 7);
  BEGIN
    INSERT INTO biblib.copy_locations(user_id, copy_id, location_id) VALUES (owner_a, 'b1420000-0000-4000-8000-0000000000a1', bookcase);
    RAISE EXCEPTION 'Prueba fallida: dos ubicaciones actuales';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.copy_locations(user_id, copy_id, location_id, position) VALUES (owner_a, 'b1420000-0000-4000-8000-0000000000a2', shelf, 0);
    RAISE EXCEPTION 'Prueba fallida: posición 0';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- Mover de ubicación no toca la estantería lógica ni el estado.
  UPDATE biblib.copy_locations SET location_id = bookcase, position = NULL WHERE copy_id = 'b1420000-0000-4000-8000-0000000000a1';
  PERFORM assert_true((SELECT shelf_id = 'b1410000-0000-4000-8000-0000000000a1' AND status = 'unread' FROM biblib.copies WHERE id = 'b1420000-0000-4000-8000-0000000000a1'), 'la estantería lógica no cambia');
  BEGIN
    DELETE FROM biblib.locations WHERE id = bookcase;
    RAISE EXCEPTION 'Prueba fallida: borró una ubicación ocupada';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    DELETE FROM biblib.locations WHERE id = room;
    RAISE EXCEPTION 'Prueba fallida: borró una ubicación con hijas';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  -- B: sin lectura, sin colgar su ubicación de una de A y sin ubicar ejemplares en ubicaciones de A.
  PERFORM set_config('request.jwt.claim.sub', owner_b::text, true);
  PERFORM assert_true((SELECT count(*) FROM biblib.locations) = 0, 'B no ve ubicaciones de A');
  BEGIN
    INSERT INTO biblib.locations(user_id, parent_id, name, kind) VALUES (owner_b, room, 'Intrusa', 'box');
    RAISE EXCEPTION 'Prueba fallida: B colgó una ubicación de A';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.copy_locations(user_id, copy_id, location_id) VALUES (owner_b, 'b1420000-0000-4000-8000-0000000000b1', room);
    RAISE EXCEPTION 'Prueba fallida: B usó una ubicación de A';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  RESET ROLE;
END;
$test$;
SELECT 'Correcto: ubicaciones sin ciclos ni más de 8 niveles, una por ejemplar, sin borrar ocupadas y sin cruzar cuentas';

-- Series: posición NUMERIC exacta, una serie por edición, FK del mismo dueño; borrar la serie no borra ediciones.
DO $test$
DECLARE
  owner_a uuid := 'b1400000-0000-4000-8000-0000000000a1';
  owner_b uuid := 'b1400000-0000-4000-8000-0000000000b1';
  saga uuid := 'b1440000-0000-4000-8000-0000000000a1';
  ordered text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', owner_a::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO biblib.series(id, user_id, title) VALUES (saga, owner_a, 'Saga');
  INSERT INTO biblib.series_editions(user_id, edition_id, series_id, position, volume_label) VALUES
    (owner_a, 'b1420000-0000-4000-8000-0000000000a4', saga, 2, 'II'),
    (owner_a, 'b1420000-0000-4000-8000-0000000000a1', saga, 1, 'I'),
    (owner_a, 'b1420000-0000-4000-8000-0000000000a3', saga, 1.5, 'Interludio'),
    (owner_a, 'b1420000-0000-4000-8000-0000000000a2', saga, NULL, NULL);
  SELECT string_agg(coalesce(position::text, 'desconocida'), ',' ORDER BY position NULLS LAST) INTO ordered FROM biblib.series_editions WHERE series_id = saga;
  PERFORM assert_true(ordered = '1,1.5,2,desconocida', format('orden exacto 1, 1.5, 2 y desconocido al final (%s)', ordered));
  PERFORM assert_true((SELECT position = 1.5 AND position::text = '1.5' FROM biblib.series_editions WHERE edition_id = 'b1420000-0000-4000-8000-0000000000a3'), 'sin redondeo de flotantes');
  BEGIN
    UPDATE biblib.series_editions SET position = 1.00001 WHERE edition_id = 'b1420000-0000-4000-8000-0000000000a3';
    RAISE EXCEPTION 'Prueba fallida: más de 4 decimales';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE biblib.series_editions SET position = -1 WHERE edition_id = 'b1420000-0000-4000-8000-0000000000a3';
    RAISE EXCEPTION 'Prueba fallida: posición negativa';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO biblib.series(id, user_id, title) VALUES ('b1440000-0000-4000-8000-0000000000a2', owner_a, 'Otra');
  BEGIN
    INSERT INTO biblib.series_editions(user_id, edition_id, series_id) VALUES (owner_a, 'b1420000-0000-4000-8000-0000000000a1', 'b1440000-0000-4000-8000-0000000000a2');
    RAISE EXCEPTION 'Prueba fallida: una edición en dos series';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  -- B repite el título sin conflicto, pero no enlaza ediciones de A ni usa la serie de A.
  PERFORM set_config('request.jwt.claim.sub', owner_b::text, true);
  INSERT INTO biblib.series(user_id, title) VALUES (owner_b, 'Saga');
  BEGIN
    INSERT INTO biblib.series_editions(user_id, edition_id, series_id) VALUES (owner_b, 'b1420000-0000-4000-8000-0000000000a1', (SELECT id FROM biblib.series WHERE user_id = owner_b));
    RAISE EXCEPTION 'Prueba fallida: B enlazó una edición de A';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.series_editions(user_id, edition_id, series_id) VALUES (owner_b, 'b1420000-0000-4000-8000-0000000000b1', saga);
    RAISE EXCEPTION 'Prueba fallida: B usó una serie de A';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  PERFORM set_config('request.jwt.claim.sub', owner_a::text, true);
  DELETE FROM biblib.series WHERE id = 'b1440000-0000-4000-8000-0000000000a2';
  RESET ROLE;
END;
$test$;
SELECT 'Correcto: series con posición NUMERIC exacta (1, 1.5, 2), una por edición y del mismo dueño';

-- Assets de imagen: bucket privado, ruta fija, subida única en cuarentena, registro con objeto, guarda de referencias,
-- avatar en el perfil sin tocar Auth y descarte que respeta lo citado.
SELECT assert_true((SELECT public = false AND allowed_mime_types = ARRAY['image/webp'] AND file_size_limit = 5242880 FROM storage.buckets WHERE id = 'biblib-media'), 'bucket privado de imágenes');
SELECT assert_true((SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'biblib_media_%') = 3, 'tres políticas de storage.objects');
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'b1400000-0000-4000-8000-0000000000a1', true);
DO $test$
DECLARE
  owner_a uuid := 'b1400000-0000-4000-8000-0000000000a1';
  begun jsonb := biblib.media_asset_begin_upload('avatar');
  asset_id uuid := (begun->>'asset_id')::uuid;
  key text := begun->>'storage_key';
  photo jsonb;
BEGIN
  PERFORM assert_true(begun->>'status' = 'created' AND key = owner_a::text || '/avatar/' || asset_id::text, 'ruta {user_id}/avatar/{asset_id}');
  BEGIN
    PERFORM biblib.media_asset_begin_upload('documento');
    RAISE EXCEPTION 'Prueba fallida: tipo de imagen libre';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  BEGIN
    INSERT INTO storage.objects(bucket_id, name, metadata) VALUES ('biblib-media', owner_a::text || '/location/' || asset_id::text, '{"size": 10}');
    RAISE EXCEPTION 'Prueba fallida: subió con otro tipo en la ruta';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM assert_true(biblib.media_asset_register(asset_id, repeat('a', 64), 10, 64, 64)->>'status' = 'missing_object', 'sin objeto no se registra');
  INSERT INTO storage.objects(bucket_id, name, metadata) VALUES ('biblib-media', key, '{"size": 10}');
  PERFORM assert_true(biblib.media_asset_register(asset_id, repeat('a', 64), 10, 2048, 64)->>'status' = 'invalid', 'un avatar de más de 1024 px no se registra');
  PERFORM assert_true(biblib.media_asset_register(asset_id, repeat('a', 64), 2000000, 64, 64)->>'status' = 'invalid', 'un avatar de más de 1 MiB no se registra');
  -- En cuarentena todavía no se puede citar.
  BEGIN
    INSERT INTO biblib.profiles(user_id, avatar_asset_id) VALUES (owner_a, asset_id);
    RAISE EXCEPTION 'Prueba fallida: citó un asset en cuarentena';
  EXCEPTION WHEN SQLSTATE 'BA010' THEN NULL; END;
  PERFORM assert_true(biblib.media_asset_register(asset_id, repeat('a', 64), 10, 64, 64)->>'status' = 'ready', 'registro del avatar validado');
  PERFORM assert_true(biblib.media_asset_register(asset_id, repeat('a', 64), 10, 64, 64)->>'status' = 'stale', 'repetir no cambia nada');
  DELETE FROM storage.objects WHERE name = key;
  PERFORM assert_true(EXISTS (SELECT 1 FROM storage.objects WHERE name = key), 'el objeto registrado no se borra desde el cliente');
  INSERT INTO biblib.profiles(user_id, avatar_asset_id) VALUES (owner_a, asset_id);
  -- Un avatar no sirve como foto de ubicación.
  BEGIN
    UPDATE biblib.locations SET photo_asset_id = asset_id WHERE id = 'b1430000-0000-4000-8000-0000000000a1';
    RAISE EXCEPTION 'Prueba fallida: usó un avatar como foto de ubicación';
  EXCEPTION WHEN SQLSTATE 'BA010' THEN NULL; END;
  PERFORM assert_true(biblib.media_asset_discard(asset_id)->>'status' = 'referenced', 'no se descarta un avatar en uso');
  UPDATE biblib.profiles SET avatar_asset_id = NULL WHERE user_id = owner_a;
  photo := biblib.media_asset_discard(asset_id);
  PERFORM assert_true(photo->>'status' = 'discarded' AND photo->>'storage_key' = key, 'sustituido: se descarta y devuelve su ruta');
  PERFORM assert_true(biblib.media_object_access(key, 'select'), 'sin fila, el dueño ve su objeto (Storage borra con RETURNING)');
  DELETE FROM storage.objects WHERE name = key;
  PERFORM assert_true(NOT EXISTS (SELECT 1 FROM storage.objects WHERE name = key), 'sin fila, el dueño retira el objeto');
  PERFORM assert_true(NOT biblib.media_object_access(key, 'insert'), 'y no vuelve a subirlo sin una reserva');
  PERFORM set_config('request.jwt.claim.sub', 'b1400000-0000-4000-8000-0000000000b1', true);
  PERFORM assert_true((SELECT count(*) FROM biblib.media_assets) = 0 AND (SELECT count(*) FROM biblib.profiles) = 0, 'B no ve assets ni perfil de A');
  PERFORM assert_true(NOT biblib.media_object_access(key, 'select') AND NOT biblib.media_object_access(key, 'delete'), 'B no lee ni retira rutas de A');
END;
$test$;
COMMIT;
SELECT 'Correcto: imágenes privadas con ruta fija, cuarentena, registro con objeto, referencias guardadas y avatar en el perfil';

-- Revisión: incidencias con deduplicación de abiertas, decisiones de solo inserción y FK del mismo dueño; CSV en staging.
DO $test$
DECLARE
  owner_a uuid := 'b1400000-0000-4000-8000-0000000000a1';
  issue uuid;
  session_id uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('request.jwt.claim.sub', owner_a::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO biblib.review_issues(user_id, reason, entity_refs, dedupe_key) VALUES (owner_a, 'missing_isbn', '[{"kind":"copy","id":"b1420000-0000-4000-8000-0000000000a2"}]', 'missing_isbn:a2') RETURNING id INTO issue;
  BEGIN
    INSERT INTO biblib.review_issues(user_id, reason, entity_refs, dedupe_key) VALUES (owner_a, 'missing_isbn', '[{"kind":"copy","id":"b1420000-0000-4000-8000-0000000000a2"}]', 'missing_isbn:a2');
    RAISE EXCEPTION 'Prueba fallida: dos incidencias abiertas con la misma clave';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.review_issues(user_id, reason, entity_refs) VALUES (owner_a, 'missing_isbn', '[]');
    RAISE EXCEPTION 'Prueba fallida: incidencia sin entidades';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO biblib.review_decisions(user_id, issue_id, kind, selected_fields) VALUES (owner_a, issue, 'ignore', '{}');
  UPDATE biblib.review_issues SET state = 'ignored', resolved_at = now() WHERE id = issue;
  PERFORM assert_true((SELECT count(*) FROM biblib.bibliographic_evidence WHERE user_id = owner_a) > 0, 'ignorar no borra evidencias');
  BEGIN
    UPDATE biblib.review_decisions SET kind = 'accept_fields' WHERE issue_id = issue;
    RAISE EXCEPTION 'Prueba fallida: editó una decisión';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO biblib.bibliographic_evidence(user_id, edition_id, source_kind, confidence) VALUES (owner_a, 'b1420000-0000-4000-8000-0000000000a1', 'provider', 'physically_checked');
    RAISE EXCEPTION 'Prueba fallida: comprobación física en una edición';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.bibliographic_evidence(user_id, edition_id, copy_id, source_kind, confidence) VALUES (owner_a, 'b1420000-0000-4000-8000-0000000000a1', 'b1420000-0000-4000-8000-0000000000a1', 'manual', 'provisional');
    RAISE EXCEPTION 'Prueba fallida: evidencia con dos sujetos';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.bibliographic_evidence(user_id, edition_id, source_kind, source_ref, confidence) VALUES (owner_a, 'b1420000-0000-4000-8000-0000000000a1', 'provider', 'https://x.test/a', 'provisional');
    RAISE EXCEPTION 'Prueba fallida: una URL como referencia opaca';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.bibliographic_evidence(user_id, edition_id, source_kind, confidence) VALUES (owner_a, 'b1420000-0000-4000-8000-0000000000b1', 'manual', 'provisional');
    RAISE EXCEPTION 'Prueba fallida: evidencia sobre una edición de B';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  -- CSV: sesión con mapeo versionado y hashes; clave durable por ordinal; una sesión de respaldo no tiene mapeo.
  INSERT INTO biblib.import_sessions(id, user_id, source, export_set_id, manifest, manifest_digest, base_revision, rules_version, part_count, total_bytes, expires_at, csv_mapping, csv_mapping_version, input_sha256, mapping_sha256)
  VALUES (session_id, owner_a, 'csv', gen_random_uuid(), '{}', repeat('a', 64), gen_random_uuid(), 2, 1, 100, now() + interval '7 days',
    '{"delimiter":";","header":true,"columns":[{"sourceColumn":"Título","target":"title"}]}', 1, repeat('b', 64), repeat('c', 64));
  INSERT INTO biblib.import_session_rows(session_id, user_id, kind, row_key, part_index, position, data, source_ordinal, source_row_key, issues)
  VALUES (session_id, owner_a, 'record', 'csv:1', 0, 0, '{"cells":["A"]}', 1, 'csv:1', '[]'), (session_id, owner_a, 'book', 'csv:2', 0, 1, '{"title":"B"}', 2, 'csv:2', NULL);
  BEGIN
    INSERT INTO biblib.import_session_rows(session_id, user_id, kind, row_key, part_index, position, data, source_ordinal, source_row_key)
    VALUES (session_id, owner_a, 'book', 'otra', 0, 2, '{}', 3, 'csv:1');
    RAISE EXCEPTION 'Prueba fallida: dos filas con la misma clave de registro';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.import_sessions(user_id, source, export_set_id, manifest, manifest_digest, base_revision, rules_version, part_count, total_bytes, expires_at)
    VALUES (owner_a, 'csv', gen_random_uuid(), '{}', repeat('a', 64), gen_random_uuid(), 2, 1, 100, now() + interval '7 days');
    RAISE EXCEPTION 'Prueba fallida: sesión CSV sin hash de entrada';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO biblib.import_sessions(user_id, source, export_set_id, manifest, manifest_digest, base_revision, rules_version, part_count, total_bytes, expires_at, csv_mapping, csv_mapping_version, mapping_sha256)
    VALUES (owner_a, 'manifest', gen_random_uuid(), '{}', repeat('a', 64), gen_random_uuid(), 2, 1, 100, now() + interval '7 days', '{}', 1, repeat('c', 64));
    RAISE EXCEPTION 'Prueba fallida: mapeo CSV en una sesión de respaldo';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO biblib.csv_mapping_profiles(user_id, name, mapping) VALUES (owner_a, 'Goodreads', '{"delimiter":",","header":true,"columns":[]}');
  BEGIN
    INSERT INTO biblib.csv_mapping_profiles(user_id, name, mapping) VALUES (owner_a, 'GOODREADS', '{"delimiter":",","header":true,"columns":[]}');
    RAISE EXCEPTION 'Prueba fallida: dos perfiles con el mismo nombre';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  DELETE FROM biblib.import_sessions WHERE id = session_id;
  RESET ROLE;
END;
$test$;
SELECT 'Correcto: incidencias, decisiones de solo inserción, evidencias acotadas y CSV con mapeo versionado y clave durable';

-- Versiones anteriores: la captura incluye datos personales, ubicación, serie, evidencias y los trozos de la cuenta, y
-- los IDs que hoy usa otra cuenta se informan para reasignarlos.
DO $test$
DECLARE
  owner_a uuid := 'b1400000-0000-4000-8000-0000000000a1';
  operation_id uuid := gen_random_uuid();
  captured jsonb;
  entry jsonb;
  kinds text[];
BEGIN
  PERFORM set_config('request.jwt.claim.sub', owner_a::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO biblib.library_operations(id, user_id, operation, idempotency_key, input_digest, status, result) VALUES (operation_id, owner_a, 'import.confirm', 'clave-producto-o13-01', repeat('e', 64), 'committed', '{}');
  captured := biblib.library_snapshot_capture(operation_id, 'import.replace');
  SELECT array_agg(DISTINCT kind ORDER BY kind) INTO kinds FROM biblib.library_snapshot_chunks WHERE snapshot_id = (captured->>'id')::uuid;
  PERFORM assert_true(kinds = ARRAY['books', 'locations', 'series', 'shelves', 'tags'], format('trozos de la cuenta (%s)', kinds));
  PERFORM assert_true((SELECT schema_version = 3 AND (counts->>'tags')::integer > 0 AND (counts->>'locations')::integer > 0 AND (counts->>'series')::integer = 1
    FROM biblib.library_snapshots WHERE id = (captured->>'id')::uuid), 'esquema 3 con recuentos de producto');
  SELECT item INTO entry FROM biblib.library_snapshot_chunks AS c CROSS JOIN LATERAL jsonb_array_elements(c.payload) AS item
  WHERE c.snapshot_id = (captured->>'id')::uuid AND c.kind = 'books' AND item->>'id' = 'b1420000-0000-4000-8000-0000000000a1';
  PERFORM assert_true(entry->'personal'->>'rating' = '4' AND char_length(entry->'personal'->>'notes') = 4000, 'nota y valoración del ejemplar');
  PERFORM assert_true(entry->'location'->>'location_id' = 'b1430000-0000-4000-8000-0000000000a2' AND NOT entry->'location' ? 'position', 'ubicación sin posición');
  PERFORM assert_true(entry->'series'->>'position' = '1' AND entry->'series'->>'volume_label' = 'I', 'serie de la edición con posición exacta');
  PERFORM assert_true(jsonb_array_length(entry->'edition_evidence') >= 1 AND entry->'edition_evidence'->0->>'source_url' = 'https://openlibrary.org/books/OL1M', 'evidencias de la edición');
  SELECT item INTO entry FROM biblib.library_snapshot_chunks AS c CROSS JOIN LATERAL jsonb_array_elements(c.payload) AS item
  WHERE c.snapshot_id = (captured->>'id')::uuid AND c.kind = 'books' AND item->>'id' = 'b1420000-0000-4000-8000-0000000000a3';
  PERFORM assert_true(entry->'evidence'->0->>'confidence' = 'physically_checked' AND entry->'series'->>'position' = '1.5', 'comprobación física y posición 1.5');
  PERFORM assert_true(cardinality(biblib.library_snapshot_foreign_ids((captured->>'id')::uuid)) = 0, 'sin IDs ajenos');
  RESET ROLE;
  -- Una etiqueta de la versión que hoy es de otra cuenta se informa.
  UPDATE biblib.tags SET user_id = 'b1400000-0000-4000-8000-0000000000b1', name = 'Movida' WHERE id = (SELECT (item->>'id')::uuid FROM biblib.library_snapshot_chunks AS c
    CROSS JOIN LATERAL jsonb_array_elements(c.payload) AS item WHERE c.snapshot_id = (captured->>'id')::uuid AND c.kind = 'tags' AND item->>'name' = 'Ano');
  PERFORM set_config('request.jwt.claim.sub', owner_a::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM assert_true(cardinality(biblib.library_snapshot_foreign_ids((captured->>'id')::uuid)) = 1, 'la etiqueta ajena se informa');
  RESET ROLE;
  RAISE EXCEPTION USING ERRCODE = 'P0004', MESSAGE = 'rollback';
EXCEPTION WHEN SQLSTATE 'P0004' THEN NULL;
END;
$test$;
SELECT 'Correcto: versiones anteriores con datos de producto (esquema 3) e IDs ajenos informados';

-- Cuenta en eliminación (C): ninguna escritura de producto ni de imágenes; el worker retira el árbol de ubicaciones de
-- las hojas a la raíz y los pasos `product` y `media` no avanzan con restos.
INSERT INTO auth.users(id) VALUES ('b1400000-0000-4000-8000-0000000000c1');
INSERT INTO biblib.shelves(id, user_id, title, is_default) VALUES ('b1410000-0000-4000-8000-0000000000c1', 'b1400000-0000-4000-8000-0000000000c1', 'Principal', true);
INSERT INTO biblib.books(id, user_id, isbn, title, shelf_id) VALUES ('b1420000-0000-4000-8000-0000000000c1', 'b1400000-0000-4000-8000-0000000000c1', 'manual-o13-c', 'De C', 'b1410000-0000-4000-8000-0000000000c1');
DO $test$
DECLARE
  owner_c uuid := 'b1400000-0000-4000-8000-0000000000c1';
  statement text;
  parent uuid := NULL;
  node uuid;
  i integer;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', owner_c::text, true);
  SET LOCAL ROLE authenticated;
  FOR i IN 1..6 LOOP
    INSERT INTO biblib.locations(user_id, parent_id, name, kind) VALUES (owner_c, parent, 'Nivel ' || i, 'other') RETURNING id INTO node;
    parent := node;
  END LOOP;
  INSERT INTO biblib.copy_locations(user_id, copy_id, location_id) VALUES (owner_c, 'b1420000-0000-4000-8000-0000000000c1', node);
  INSERT INTO biblib.tags(user_id, name) VALUES (owner_c, 'Pendiente');
  INSERT INTO biblib.copy_tags(user_id, copy_id, tag_id) SELECT owner_c, 'b1420000-0000-4000-8000-0000000000c1', id FROM biblib.tags WHERE user_id = owner_c;
  INSERT INTO biblib.profiles(user_id) VALUES (owner_c);
  PERFORM biblib.media_asset_begin_upload('location');
  PERFORM biblib.account_deletion_request('clave-eliminacion-c-o13');
  FOREACH statement IN ARRAY ARRAY[
    $$INSERT INTO biblib.tags(user_id, name) VALUES ('b1400000-0000-4000-8000-0000000000c1', 'Nueva')$$,
    $$DELETE FROM biblib.copy_tags WHERE user_id = 'b1400000-0000-4000-8000-0000000000c1'$$,
    $$UPDATE biblib.locations SET name = 'Otro' WHERE user_id = 'b1400000-0000-4000-8000-0000000000c1'$$,
    $$INSERT INTO biblib.copy_annotations(user_id, copy_id, notes) VALUES ('b1400000-0000-4000-8000-0000000000c1', 'b1420000-0000-4000-8000-0000000000c1', 'Tarde')$$,
    $$INSERT INTO biblib.series(user_id, title) VALUES ('b1400000-0000-4000-8000-0000000000c1', 'Tarde')$$,
    $$UPDATE biblib.profiles SET updated_at = now() WHERE user_id = 'b1400000-0000-4000-8000-0000000000c1'$$,
    $$INSERT INTO biblib.review_issues(user_id, reason, entity_refs) VALUES ('b1400000-0000-4000-8000-0000000000c1', 'provisional', '[{"kind":"copy","id":"b1420000-0000-4000-8000-0000000000c1"}]')$$,
    $$INSERT INTO biblib.csv_mapping_profiles(user_id, name, mapping) VALUES ('b1400000-0000-4000-8000-0000000000c1', 'Tarde', '{}')$$,
    $$SELECT biblib.media_asset_begin_upload('avatar')$$
  ] LOOP
    BEGIN
      EXECUTE statement;
      RAISE EXCEPTION 'Prueba fallida: escribió con la cuenta en eliminación: %', statement;
    EXCEPTION WHEN SQLSTATE 'BD001' THEN NULL; END;
  END LOOP;
  PERFORM assert_true(NOT biblib.media_object_access(owner_c::text || '/location/' || (SELECT id FROM biblib.media_assets WHERE user_id = owner_c)::text, 'insert'), 'Storage: no sube con la cuenta en eliminación');
  RESET ROLE;
END;
$test$;
DO $test$
DECLARE
  owner_c uuid := 'b1400000-0000-4000-8000-0000000000c1';
  token uuid := (biblib.account_deletion_claim('b1400000-0000-4000-8000-0000000000c1', 60000)->>'token')::uuid;
  removed integer;
  total integer := 0;
BEGIN
  UPDATE biblib.account_deletions SET step = 'product' WHERE user_id = owner_c;
  BEGIN
    PERFORM biblib.account_deletion_advance(owner_c, token, 'product', '{}', 60000);
    RAISE EXCEPTION 'Prueba fallida: avanzó con datos de producto';
  EXCEPTION WHEN SQLSTATE 'BD004' THEN NULL; END;
  LOOP
    removed := biblib.account_deletion_purge(owner_c, token, 'product', 2);
    EXIT WHEN removed = 0;
    total := total + removed;
  END LOOP;
  PERFORM assert_true(total >= 10 AND NOT EXISTS (SELECT 1 FROM biblib.locations WHERE user_id = owner_c), 'el árbol de ubicaciones se retira de las hojas a la raíz en lotes pequeños');
  PERFORM assert_true(biblib.account_deletion_advance(owner_c, token, 'product', '{}', 60000) = 'media', 'tras product, media');
  PERFORM assert_true(biblib.account_deletion_purge(owner_c, token, 'media', 100) = 1 AND biblib.account_deletion_advance(owner_c, token, 'media', '{}', 60000) = 'copies', 'tras media, los ejemplares');
  PERFORM assert_true(EXISTS (SELECT 1 FROM biblib.copies WHERE user_id = owner_c), 'los ejemplares siguen hasta su paso');
END;
$test$;
SELECT 'Correcto: cuenta en eliminación sin escrituras de producto; pasos product y media de las hojas a la raíz';

-- Inventario: toda tabla de biblib con dueño la retira un paso, y toda tabla con escritura de cliente exige cuenta activa.
DO $test$
DECLARE
  item record;
  covered text[] := ARRAY[]::text[];
  step_name text;
BEGIN
  FOREACH step_name IN ARRAY ARRAY['covers', 'snapshots', 'staging', 'jobs', 'views', 'previews', 'operations', 'private_cache', 'product', 'media', 'copies', 'editions', 'works', 'shelves', 'state'] LOOP
    covered := covered || biblib.account_deletion_step_tables(step_name);
  END LOOP;
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
  PERFORM assert_true(NOT has_table_privilege('authenticated', 'biblib.media_assets', 'INSERT') AND NOT has_table_privilege('authenticated', 'biblib.media_assets', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'biblib.review_decisions', 'UPDATE') AND NOT has_table_privilege('authenticated', 'biblib.review_decisions', 'DELETE')
    AND NOT has_table_privilege('authenticated', 'biblib.copy_tags', 'UPDATE'), 'privilegios mínimos de cliente');
  PERFORM assert_true(NOT has_function_privilege('authenticated', 'biblib.media_asset_purge_candidates(uuid, integer, integer)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'biblib.media_storage_install()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'biblib.media_asset_begin_upload(text)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'biblib.media_asset_begin_upload(text)', 'EXECUTE'), 'funciones de imágenes: solo las del dueño');
END;
$test$;
SELECT 'Correcto: inventario de eliminación y guarda de cuenta activa con las tablas de 0014';

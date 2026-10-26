# Contratos de datos de O13 · migración `0014_product_batch_o13`

**Fecha:** 25 de octubre de 2026 · **Lote:** D (único escritor de schema en O13) · **Estado:** implementado y verificado en local (evidencia en [validación O13/d](../validacion/2026-10-25/O13/d/informe.md)).

Este documento fija lo que leen las unidades de O13 —U-PRO-01, U-PRO-03, U-PRO-05, U-EXP-06, U-DAT-07 y U-DAT-09— antes de escribir sus acciones y pantallas: tablas y columnas, restricciones, funciones SQL, límites, rutas de Storage, la forma v2 de cada entidad y cómo entran en versiones anteriores, respaldo, restauración y eliminación de cuenta. Las especificaciones de producto siguen en [02](02-datos-importacion-y-catalogacion.md) y [03](03-experiencia-y-funciones.md); aquí solo el contrato de datos. **Ninguna unidad genera otra migración en O13**: si un contrato no basta, se pide al lote D.

Tipos y límites en TypeScript (sin `server-only`, válidos en cliente y servidor):

| Módulo | Contenido |
| --- | --- |
| [`lib/product/contracts.ts`](../../lib/product/contracts.ts) | Etiquetas (`normalizeTagName`, `isValidTagName`, `TAG_LIMITS`, `NOTES_MAX`), ubicaciones (`LOCATION_KINDS`, etiquetas en español, `LOCATION_LIMITS`), series (`SERIES_POSITION_PATTERN`, `canonicalSeriesPosition`, `compareSeriesPositions`), imágenes (`MEDIA_BUCKET`, `MEDIA_KINDS`, `MEDIA_LIMITS`, `mediaStorageKey`, respuestas de las funciones), perfil y SQLSTATE propios. |
| [`lib/review/contracts.ts`](../../lib/review/contracts.ts) | Evidencias, confianza, incidencias, decisiones y sus límites (U-DAT-07). |
| [`lib/csv-import/contracts.ts`](../../lib/csv-import/contracts.ts) | Mapeo CSV, incidencias por registro, `csvSourceRowKey` y perfiles guardados (U-DAT-09). |
| [`lib/types.ts`](../../lib/types.ts) | `Book.personal`, `Book.location`, `Book.evidence`, `BookEdition.series`, `BookEdition.evidence` y `LibraryData.tags/locations/series` (opcionales). |
| [`lib/db/schema.ts`](../../lib/db/schema.ts) | Tablas Drizzle: `tags`, `copyTags`, `copyAnnotations`, `locations`, `copyLocations`, `series`, `seriesEditions`, `mediaAssets`, `profiles`, `bibliographicEvidence`, `reviewIssues`, `reviewDecisions`, `csvMappingProfiles`. |
| [`lib/db/product.ts`](../../lib/db/product.ts) | Lectura y escritura de producto para exportar, importar y restaurar (no son acciones de unidad). |

## Reglas comunes (todas las tablas nuevas)

1. **Dueño y RLS.** Columna `user_id` y políticas `*_select_own`/`*_insert_own`/`*_update_own`/`*_delete_own` con `user_id = (select auth.uid())`. El dueño sale siempre de la sesión (`withRlsContext`); ningún DTO elige `user_id`.
2. **Cuenta activa.** Cada privilegio de escritura de `authenticated` tiene su política RESTRICTIVE `*_insert_active`/`*_update_active`/`*_delete_active` con `biblib.account_write_allowed()`: con la cuenta en eliminación lanza **BD001** (traducir a `UNAUTHORIZED`/«Tu cuenta no admite cambios», como el resto de la app). También las funciones de imágenes y las políticas de Storage.
3. **FK con el mismo dueño.** Toda FK entre datos privados es compuesta `(user_id, …) → (user_id, id)`. Citar una etiqueta, ubicación, serie, ejemplar, edición, incidencia o imagen de otra cuenta da **23503** (respuesta genérica de «no existe», sin confirmar nada de B).
4. **Versión por fila.** Las tablas con `version uuid` la renuevan en cada `INSERT`/`UPDATE` (trigger `rotate_book_version`). Las mutaciones de las acciones comparan `version` (`… where id = $1 and version = $2`); 0 filas → `CONFLICT`/`REVISION_CONFLICT` según el contrato de la acción. La restauración administrativa rota todas estas versiones.
5. **Revisión de colección.** Escribir `tags`, `copy_tags`, `copy_annotations`, `locations`, `copy_locations`, `series`, `series_editions` o `bibliographic_evidence` rota la revisión del dueño (igual que libros y estanterías): una vista previa de importación o restauración preparada antes deja de valer. `review_issues`, `review_decisions`, `profiles`, `media_assets` y `csv_mapping_profiles` no la rotan.
6. **Límites.** Los aplica Postgres; un límite superado nunca recorta. SQLSTATE propios: **BP001** límite (→ `LIMIT_EXCEEDED`), **BL001** ciclo de ubicaciones y **BL002** más de 8 niveles (→ `INVALID_INPUT`), **BA010** imagen no disponible para esa referencia (→ `CONFLICT` o `ASSET_REJECTED`). Checks: 23514 → `INVALID_INPUT`; unicidad: 23505 → `CONFLICT`.
7. **Textos.** Las longitudes son en caracteres (`char_length`, puntos de código). Los nombres no admiten espacios en los extremos (`= btrim(…)`).

## U-PRO-01 · Etiquetas, notas y valoración (por ejemplar)

| Tabla | Columnas | Restricciones |
| --- | --- | --- |
| `tags` | `id`, `user_id`, `name`, `normalized_name` (generada), `version`, `created_at`, `updated_at` | `name` 1–40, sin espacios en los extremos ni caracteres de control; **única por cuenta en `normalized_name`** = `biblib.tag_normalize(name)`; máx. **1000** por cuenta (BP001). |
| `copy_tags` | `user_id`, `copy_id`, `tag_id`, `created_at` | PK `(user_id, copy_id, tag_id)`; FK a `copies` y a `tags` **en cascada** (borrar la etiqueta o el ejemplar retira el vínculo, nunca el otro); máx. **20 por ejemplar** (BP001, también en una sola sentencia). Sin `UPDATE`. |
| `copy_annotations` | `user_id`, `copy_id`, `notes` (null o 1–4000), `rating` (`smallint` null o 1–5), `version`, fechas | PK `(user_id, copy_id)`: una por ejemplar; FK al ejemplar en cascada. **Nunca en `books_legacy`.** |

- `normalizeTagName` (TS) = `tag_normalize` (SQL): espacios colapsados, sin diacríticos **salvo la tilde de la ñ**, minúsculas. «Novela», «NÓVELA» y «Nóvela» son la misma; «año» y «ano», no. Para crear una etiqueta «si no existe», usar `insert … on conflict (user_id, normalized_name) do nothing returning id` y releer.
- Filtros por etiquetas: índice `copy_tags_user_tag_idx (user_id, tag_id)`. OR por defecto, AND explícito (spec 03).
- DTO: `Book.personal = { notes?, rating?, tagIds? }` (ausente si no hay nada).

## U-PRO-03 · Ubicación física

| Tabla | Columnas | Restricciones |
| --- | --- | --- |
| `locations` | `id`, `user_id`, `parent_id` (null en la raíz), `name` (1–120), `kind`, `photo_asset_id`, `version`, fechas | `kind` ∈ `room`, `bookcase`, `cabinet`, `box`, `shelf`, `other` (etiquetas: `LOCATION_KIND_LABELS`); padre del mismo dueño; **sin ciclos (BL001)** y **≤ 8 niveles** contando los descendientes al mover un subárbol (BL002), comprobado tras cada sentencia con todas sus filas; máx. **500** por cuenta. Borrar una ubicación **con hijas o con ejemplares falla (23503)**: la acción debe vaciarla o mover antes. |
| `copy_locations` | `user_id`, `copy_id`, `location_id`, `shelf_label` (1–60), `position` (entero 1–100000), `version`, fechas | PK `(user_id, copy_id)`: **una ubicación actual por ejemplar**; FK al ejemplar en cascada y a la ubicación sin cascada. |

- **Mover** = `insert … on conflict (user_id, copy_id) do update set location_id = …, shelf_label = …, position = … where copy_locations.version = $expected` (o `update … where version = $expected`); no hace falta función SQL. Cambiar la ubicación **no toca** `copies.shelf_id` ni el estado.
- La posición es manual: nadie la renumera. Sin historial de ubicaciones (no se pidió).
- Foto: `photo_asset_id` → asset `location` propio y **listo** (guarda BA010). Ver «Imágenes privadas».
- DTO: `PhysicalLocation`, `CopyLocationRef { locationId, shelfLabel?, position? }`.

## U-PRO-05 · Series

| Tabla | Columnas | Restricciones |
| --- | --- | --- |
| `series` | `id`, `user_id`, `title` (1–300), `description` (null o 1–2000), `version`, fechas | Título repetible (también entre cuentas); máx. **1000** por cuenta. Nunca se deduce del ISBN. |
| `series_editions` | `user_id`, `edition_id`, `series_id`, `position` **`numeric`** (null o 0 ≤ p < 1000000, ≤ 4 decimales), `volume_label` (1–40), `order_note` (1–200), `version`, fechas | PK `(user_id, edition_id)`: **cero o una serie por edición**; FK a la edición y a la serie **en cascada** (borrar la serie retira los vínculos, nunca las ediciones; la poda de una edición retira su vínculo). |

- Orden: `order by position nulls last` (desconocido al final; nunca se infiere de la fecha). Las posiciones pueden repetirse (dos ediciones del mismo volumen).
- Nunca `float`: enviar y leer la posición como **texto** decimal (`SERIES_POSITION_PATTERN`; leer con `trim_scale(position)::text`, como la exportación). En TS, `compareSeriesPositions`.
- DTO: `EditionSeriesRef { seriesId, position?, volumeLabel?, orderNote? }` en `Book.edition.series`.

## Imágenes privadas (U-EXP-06, U-PRO-03, U-DAT-07)

| Elemento | Contrato |
| --- | --- |
| Tabla `media_assets` | `id`, `user_id`, `kind` (`avatar`, `location`, `evidence`), `state` (`quarantine` → `ready`), `storage_key` = **`{user_id}/{kind}/{id}`** (check), `sha256`, `mime` = `image/webp`, `bytes`, `width`, `height`, `expires_at` (solo cuarentena), `version`. El cliente solo la **lee**. |
| Bucket `biblib-media` | Privado, solo `image/webp`, 5 MiB. Políticas `biblib_media_{select,insert,delete}_own` con `biblib.media_object_access(name, acción)`. |
| Límites | avatar ≤ 1 MiB y ≤ 1024 px por lado; ubicación y evidencia ≤ 5 MiB y ≤ 4096 px. Cuotas: 5 en cuarentena, 500 listas o 200 MiB por cuenta (`status: "quota"`). |
| Sin EXIF ni GPS | El servidor decodifica y **reencodifica a WebP** (como portadas, `sharp`) antes de subir: el bucket no admite otro tipo y los bytes nunca llevan metadatos del original. |

Flujo (todas `SECURITY DEFINER`, dueño de `auth.uid()`, BD001 con la cuenta en eliminación):

1. `biblib.media_asset_begin_upload(kind) → { status: "created", asset_id, storage_key } | { status: "quota", quota } | { status: "inactive" }`: cuarentena de 15 minutos.
2. El servidor sube los bytes validados a `storage_key` **con la sesión del dueño** (`upsert: false`). Solo se admite esa ruta, una vez, mientras la cuarentena vive; no hay política `UPDATE`: no se sobrescribe.
3. `biblib.media_asset_register(asset_id, sha256, bytes, width, height) → { status: "ready" | "not_found" | "inactive" | "stale" | "missing_object" | "invalid" }`: exige el objeto presente con ese tamaño y los límites del tipo.
4. Citar: `profiles.avatar_asset_id`, `locations.photo_asset_id` o `bibliographic_evidence.photo_asset_id`. Un trigger exige asset propio, listo y del tipo correcto (BA010); la FK con dueño impide uno ajeno.
5. Sustituir o quitar: soltar la referencia y `biblib.media_asset_discard(asset_id) → { status: "discarded", storage_key } | { status: "referenced" | "not_found" }`; luego retirar el objeto con la sesión del dueño (la política lo permite cuando ya no hay fila). Un fallo de subida conserva la imagen anterior: no se suelta la referencia hasta registrar la nueva.
6. Lectura: endpoint autenticado o URL firmada de TTL corto creada con la sesión del dueño (la política `select` solo deja leer los propios). Nunca una URL pública.

Purga administrativa (sin `EXECUTE` de cliente): `media_asset_purge_candidates(owner|null, limit, grace_s)` y `media_asset_purge_confirm(owner|null, ids[], grace_s)` devuelven cuarentenas vencidas, imágenes listas que nada cita (ni una versión anterior) y objetos sin fila; el script que borre los objetos es de las unidades (U-EXP-06/U-PRO-03), sobre el patrón de `assets:purge:local`.

### U-EXP-06 · Perfil y avatar

`profiles(user_id PK, avatar_asset_id, version, fechas)`: una fila por cuenta, creada por la acción si no existe (`insert … on conflict (user_id) do update`). `avatar_path` del contrato de 03 es `media_assets.storage_key` del asset citado (`{user_id}/avatar/{asset_id}`), derivado, nunca editable. La metadata OAuth (`user_metadata.avatar_url`) **no se toca**: sin avatar propio se muestra la de Google o las iniciales.

## U-DAT-07 · Evidencias, incidencias y decisiones

| Tabla | Columnas | Restricciones |
| --- | --- | --- |
| `bibliographic_evidence` | `id`, `user_id`, `edition_id` **o** `copy_id` (exactamente uno), `source_kind` (`provider`, `photo`, `manual`, `import`), `source_ref` (clave opaca `^[A-Za-z0-9:._-]{1,200}$`, nunca URL ni ruta), `source_url` (solo `http(s)` que ya constaba, ≤ 2048), `photo_asset_id` (solo con `source_kind = 'photo'`), `observed_at` (null si se desconoce), `field_claims` (objeto ≤ 16 KiB), `confidence`, `origin` (`backfill`, `review`, `import`), `version`, fechas | `confidence` ∈ **`provisional`, `bibliographic_match`, `physically_checked`** (nunca porcentaje); `physically_checked` solo en un ejemplar; FK a edición/ejemplar en cascada; máx. 50000 por cuenta. |
| `review_issues` | `id`, `user_id`, `reason`, `entity_refs` (array de `{kind: "copy"|"edition"|"work", id}`, 1–50), `state` (`open`, `resolved`, `ignored`), `dedupe_key`, `version`, fechas, `resolved_at` | `resolved_at` nulo si y solo si `open`; **una abierta por `(user_id, dedupe_key)`** (p. ej. `missing_isbn:<copy_id>`); máx. 10000 por cuenta. `entity_refs` son IDs sin FK: al listar, descartar las que ya no existen. |
| `review_decisions` | `id`, `user_id`, `issue_id`, `kind` (`accept_fields`, `ignore`, `confirm_physical`, `merge`, `reopen`), `selected_fields` (objeto ≤ 16 KiB), `evidence_refs` (array ≤ 50), `actor` = `owner`, `operation_id`, `decided_at` | **Solo inserción** (`SELECT, INSERT`): el historial no se edita; desaparece con su incidencia (cascada) o con la cuenta. |

- **Backfill de 0014.** Cada edición existente recibió una evidencia `origin = 'backfill'` con su procedencia: `open-library`/`bne`/`google-books` → `provider` + `bibliographic_match` (con `source_ref` = proveedor), `photo` → `photo` **sin foto** y `provisional`, `manual` → `manual`, resto → `import`; `source_url` solo si ya constaba; `catalogue.fields` como `field_claims.fields`. Cada ejemplar con `isbnVerified` humano recibió `manual` + `physically_checked` con `observed_at` = `checkedAt` si existía. Ningún proveedor ni checksum crea una comprobación física. No se crearon incidencias: las genera U-DAT-07.
- Ignorar una incidencia no borra evidencias. Fusionar ediciones (U-DAT-06) **debe mover** antes las evidencias de las ediciones de origen (`update … set edition_id = <destino>`): la cascada las retiraría con la edición.
- La foto fuente es un asset `evidence` propio (ver «Imágenes privadas»).

## U-DAT-09 · CSV sobre el staging de 0008

| Elemento | Contrato |
| --- | --- |
| `import_sessions.source` | Admite `'csv'`. Las funciones de restauración por partes ignoran las sesiones CSV (no las listan, cargan ni cuentan). |
| `import_sessions.input_sha256` | sha256 del archivo; **obligatorio si y solo si** `source = 'csv'`. |
| `import_sessions.csv_mapping`, `csv_mapping_version`, `mapping_sha256` | Mapeo versionado de la sesión (`CsvMapping`, objeto ≤ 16 KiB), su versión (≥ 1) y su sha256: los tres juntos o ninguno, y solo en sesiones CSV. Cambiar el mapeo sube la versión y regenera el plan (invalida la confirmación anterior). |
| `import_session_rows.kind` | Añade `'record'` (registro CSV tal cual, antes o sin mapeo) y `'tag'`, `'location'`, `'series'` (estas tres las usa la restauración por partes v2). |
| `import_session_rows.source_ordinal`, `source_row_key` | Ordinal del **registro** CSV (1–1000000, no línea física) y clave durable `csv:<ordinal>` (`csvSourceRowKey`): ambos o ninguno; **única por sesión** (`import_session_rows_source_key_unique`). Un reintento con el mismo archivo y mapeo encuentra las mismas filas y no regenera identificadores manuales. |
| `import_session_rows.issues` | Incidencias del registro (`CsvRowIssue[]`, ≤ 50): código y campo, sin el contenido de la celda. |
| `csv_mapping_profiles` | Perfil guardado **solo si la persona lo pide**: `name` (1–80, único por cuenta sin distinguir mayúsculas), `mapping` (≤ 16 KiB, **sin muestras de filas**), `mapping_version`, `version`; máx. 20 por cuenta. |

Las filas de staging siguen siendo inmutables (sin `UPDATE`; la guarda de 0008 exige sesión propia en `receiving` y vigente): un mapeo corregido borra y vuelve a insertar las filas de la sesión. El límite de sesiones abiertas de CSV lo define U-DAT-09 (las de restauración no las cuentan).

## Formato v2 (`formatVersion: 2`)

Secciones **opcionales y declaradas** (un lector anterior las rechaza con explicación en lugar de descartarlas; un archivo anterior no las trae y se importa con esos datos **vacíos**, sin inventarlos):

| Capacidad | Dónde | Forma |
| --- | --- | --- |
| `copies.personal` | `copies[].personal`, `tags[]` | `personal: { notes?, rating?, tagIds? }`; `tags: [{ id, name }]` (también las no usadas). |
| `copies.locations` | `copies[].location`, `locations[]` | `location: { locationId, shelfLabel?, position? }`; `locations: [{ id, name, kind, parentId, photo?: { assetId, sha256 } }]` (también las vacías). |
| `editions.series` | `editions[].series`, `series[]` | `series: { seriesId, position?, volumeLabel?, orderNote? }` (posición en texto canónico); `series: [{ id, title, description? }]`. |
| `bibliographic.evidence` | `copies[].evidence`, `editions[].evidence` | `[{ id, sourceKind, sourceRef?, sourceUrl?, photo?: { assetId, sha256 }, observedAt?, fieldClaims, confidence, origin? }]`; `physically_checked` solo en una copia. |

- El lector valida referencias (etiqueta, ubicación, serie y padre dentro del archivo), árbol sin ciclos ni más de 8 niveles, etiquetas equivalentes por nombre normalizado, límites y la capacidad declarada.
- **Fotos por referencia, nunca bytes ni URL firmada.** Al importar o restaurar, una foto solo se conserva si ese asset **sigue siendo del dueño, está listo, es del tipo y (en v2) tiene el mismo sha256**; si no, la entidad se importa sin foto. Otra cuenta nunca hereda una foto.
- Partes: cada parte lleva completas las etiquetas, ubicaciones y series de la cuenta (cada una se valida sola; la restauración por partes exige que sean idénticas en todas).
- **Fusión:** solo los ejemplares nuevos reciben notas, etiquetas, ubicación y evidencias, y solo las ediciones nuevas, serie y evidencias; las etiquetas se reutilizan por nombre normalizado; ubicaciones y series propias con el mismo ID se reutilizan; el resto recibe IDs nuevos. **Reemplazo:** la colección resultante es la del archivo también en etiquetas, ubicaciones y series (un archivo sin ellas las deja vacías; la versión anterior capturada permite deshacerlo); se conservan los IDs que la cuenta aún tenía. Límites superados → `LIMIT_EXCEEDED` sin aplicar nada.
- **Fuera de v2 (decisión del lote D):** incidencias y decisiones de revisión (estado de flujo, se regeneran desde las evidencias), perfil y avatar (ajuste de cuenta cuyos bytes no viajan en JSON) y perfiles CSV (preferencia, como las vistas guardadas). Los conservan el respaldo administrativo y la eliminación de cuenta.
- v1 nunca lleva datos de producto: una colección con cualquiera de ellos exige v2 (`libraryRequiresV2`).

## Versiones anteriores, respaldo y restauración

- **Versiones anteriores (schema_version 3).** `library_snapshot_capture` guarda por ejemplar `personal`, `location`, `series` (de su edición), `evidence` y `edition_evidence`, y en trozos propios tras los libros `tags`, `locations` y `series`. Restaurar devuelve todo con sus IDs salvo los que hoy usa otra cuenta (`library_snapshot_foreign_ids` también los informa). Las versiones 1 y 2 se siguen restaurando (sin datos de producto). La purga de imágenes no retira una citada por una versión anterior.
- **Respaldo administrativo** (`db:backup:local`): las tablas nuevas entran por esquema; el bucket `biblib-media` se copia objeto a objeto y cada imagen lista debe coincidir en bytes y sha256 con su registro o el respaldo no se guarda. **Restauración** (`db:restore:local`): reinstala las políticas de Storage de `biblib-media` (`media_storage_install`), admite su bucket vacío en un destino recién reseteado y rota las versiones de todas las tablas nuevas (`PRODUCT_TOKEN_TABLES`); las supresiones de cuentas se aplican antes de abrir. `db:restore:verify` compara contenido sin esas versiones.

## Eliminación de cuenta (U-OPS-03)

Dos pasos nuevos tras `private_cache` y antes de `copies`: **`product`** (`review_decisions`, `review_issues`, `bibliographic_evidence`, `copy_tags`, `copy_annotations`, `copy_locations`, `series_editions`, `tags`, `locations` —de las hojas a la raíz—, `series`, `csv_mapping_profiles`, `profiles`) y **`media`** (`media_assets`, cuando ya nada las cita). Los objetos de `biblib-media` los retira el paso `storage` (prefijo del dueño). Inventario: `ACCOUNT_DATA_INVENTORY`, `account_deletion_step_tables` (0014) y [retención](../retencion.md). Lectura y préstamos (O14) quedan anotados como futuros.

## Lo que queda en las unidades

| Unidad | Pendiente sobre este contrato |
| --- | --- |
| U-PRO-01 | Acciones por `copyId` con versión, creación de etiquetas por nombre normalizado, filtros OR/AND, formulario y estrellas accesibles. |
| U-PRO-03 | `/locations`, acciones de árbol (crear, renombrar, mover, vaciar antes de borrar), mover ejemplar con versión, subida de foto con el flujo de imágenes. |
| U-PRO-05 | `/series` y `/series/[id]`, vínculo de edición con posición en texto, orden desconocido visible. |
| U-EXP-06 | Formulario de avatar (recorte simple, tipo y tamaño visibles), lectura autenticada, sustitución sin perder el anterior y purga de los sustituidos. |
| U-DAT-07 | Generación de incidencias con `dedupe_key`, bandeja paginada, comparación, lotes con vista previa y versión; mover evidencias al fusionar ediciones. |
| U-DAT-09 | Parser, mapeo y normalización; sesiones CSV con `input_sha256`, mapeo versionado y filas `record` con clave durable; límite propio de sesiones abiertas. |

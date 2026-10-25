# Informe O13 · lote D · migración `0014_product_batch_o13`

**Fecha:** 25-10-2026 · **Rama:** `o13-d` (worktree `stack-scratch`) · **Perfil:** `scratch` · **Contrato para las unidades:** [contratos-o13](../../../../spec-pendientes/contratos-o13.md).

## Qué se entrega

- **Una sola migración** `drizzle/0014_product_batch_o13.sql` con su snapshot y su entrada en el journal (generada con Drizzle y completada a mano: funciones, triggers, grants, Storage y backfill). Tablas: `tags`, `copy_tags`, `copy_annotations` (U-PRO-01); `locations`, `copy_locations` (U-PRO-03); `series`, `series_editions` (U-PRO-05); `media_assets`, `profiles` y el bucket privado `biblib-media` (U-EXP-06, fotos de U-PRO-03/U-DAT-07); `bibliographic_evidence`, `review_issues`, `review_decisions` (U-DAT-07); columnas CSV en `import_sessions`/`import_session_rows` y `csv_mapping_profiles` (U-DAT-09).
- **Seguridad:** RLS del dueño, FK compuestas `(user_id, …)`, política RESTRICTIVE de cuenta activa en cada escritura de cliente (también en Storage y en las funciones de imágenes), límites en Postgres (BP001), árbol de ubicaciones sin ciclos ni más de 8 niveles (BL001/BL002), referencias a imágenes propias y listas (BA010). Funciones `SECURITY DEFINER` con `search_path` fijo y añadidas a la lista de exposición.
- **v2, importación y restauraciones:** secciones declaradas `copies.personal`, `copies.locations`, `editions.series`, `bibliographic.evidence` con las etiquetas, ubicaciones y series de la cuenta; exportación, confirmación de importaciones, restauración por partes y versiones anteriores (schema_version 3) escriben los datos de producto en la misma transacción. Un JSON v1 o v2 anterior importa con esos datos vacíos.
- **Respaldo y restauración administrativos:** `biblib-media` copiado y comprobado por sha256; restore reinstala sus políticas, rota las versiones nuevas y compara por claves naturales. **Eliminación de cuenta:** pasos `product` y `media`. **Inventario:** `docs/retencion.md`, `lib/account-deletion`, `docs/seguridad.md`, `docs/operacion.md`.
- **Pruebas:** `tests/db/product-legacy.sql` + `tests/db/product.sql`, `tests/product-v2.test.ts`, manifest y hechos reales `objects-0014.json`, grupo `tests/integration/product` (17 pruebas) añadido a `SUITES` y `pnpm test:integration:product`.

## Resultados (ejecutados en esta sesión)

| Comprobación | Resultado |
| --- | --- |
| `0013 → 0014` en scratch con datos (`scratch-0013-antes.json`, `scratch-migracion-0013-0014.txt`, `scratch-0014-backfill.json`) | Aplicada y verificada. 12 ediciones → 12 evidencias de backfill; 1 comprobación física (solo la copia comprobada); URL solo donde constaba (1); 0 fotos inventadas. |
| Desde vacío con `db:reset:local` (`ensayo-03`, `ensayo-04`) | Head 0014, 780 comprobaciones, sin pendientes ni drift. |
| `db:status:local` final (`validacion-status-final.txt`) | up-to-date, 780 comprobaciones. |
| Ensayo respaldo → reset → restore → verify con entidades nuevas pobladas (`ensayo-01`…`ensayo-08`) | **Superado**: 62/62 comprobaciones, 3 objetos de `biblib-media` con su sha256, todas las tablas de producto iguales al recibo y sus versiones rotadas. |
| Grupos en scratch | `product` 17/17, `account` 11/11, `snapshots` 10/10, `restore` 11/11, `model` 8/8, `security` 23/23. |
| `pnpm test` | 377/377. |
| `pnpm test:scripts` | 263/263 (incluido el ensayo de promoción con Postgres efímeros). |
| `pnpm test:db` | Correcto (todas las migraciones y `product*.sql`). |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test:smoke` | Correctos. |
| HolaERP (`holaerp-antes.txt` / `holaerp-despues.txt`) | Idéntico (solo cambia el tiempo de «Up»). |

## Hallazgos durante el lote (corregidos)

1. **Orden de índices y FK** en el SQL generado por Drizzle: las FK compuestas se emitían antes que los índices `(user_id, id)` que necesitan. Se reordenó como en 0010.
2. **Vista previa de importación** (`app/actions/import-preview.ts`): guardaba solo libros y estanterías; las referencias a etiquetas, ubicaciones y series fallaban al confirmar (PREVIEW_EXPIRED). Ahora guarda también las secciones de la cuenta.
3. **Storage borra con `RETURNING`:** el dueño necesita ver su objeto sin fila para retirarlo tras `media_asset_discard`; `media_object_access` lo permite (sin poder volver a subirlo).
4. **Posiciones de serie canónicas:** Postgres conserva `1.50`; exportación y captura usan `trim_scale` para no producir posiciones que el lector v2 rechaza.
5. **Verificación del restore:** las tablas sin `id` (`copy_tags`, `copy_annotations`, `copy_locations`, `series_editions`, `profiles`) se comparaban por todas sus columnas, incluida la `version` rotada. Ahora por su clave primaria (`TABLE_KEYS`). El primer ensayo falló por esto; el segundo, con el respaldo rehecho, se superó.
6. **Smoke** (`scripts/smoke-app.mjs`) solo aplicaba hasta 0012; la exportación ya lee tablas de 0014. Ahora aplica 0013 y 0014.

## Decisiones del lote (documentadas en el contrato)

- **Fuera de v2 y de versiones anteriores:** incidencias y decisiones de revisión (estado de flujo), perfil y avatar (sus bytes no viajan en JSON) y perfiles CSV (preferencia, como las vistas guardadas). Los cubren el respaldo administrativo y la eliminación de cuenta.
- **Reemplazo:** la colección resultante es la del archivo también en etiquetas, ubicaciones y series; se conservan los IDs que la cuenta aún tiene (como con los ejemplares). **Fusión:** etiquetas reutilizadas por nombre normalizado; solo los ejemplares y ediciones nuevos reciben datos.
- **Fotos por referencia:** solo vuelven si el asset sigue siendo del dueño, listo, del tipo y con el mismo sha256; otra cuenta nunca hereda una foto.
- **Evidencias:** sujeto edición o ejemplar (no obra). Fusionar ediciones debe mover antes sus evidencias (U-DAT-06/07).

## Recursos Docker que quedan

`db:local:down --profile scratch` ejecutado. Quedan solo los del perfil, conservados por diseño: red `biblib-scratch-network` y volúmenes `supabase_db_biblib-scratch` y `supabase_storage_biblib-scratch` (`scratch-recursos-restantes.txt`). Respaldos del ensayo en `.biblib/backups/` (ignorado por Git). La cuenta desechable del ensayo se retiró.

## Pendiente fuera de este lote

Acciones, pantallas y formularios de U-PRO-01/03/05, U-EXP-06, U-DAT-07 y U-DAT-09 (tabla final del contrato), el script de purga de objetos de `biblib-media` (U-EXP-06/U-PRO-03) y lectura y préstamos (O14, anotados como futuros en la retención). Sin push ni PR.

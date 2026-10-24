# U-DAT-04 · Restauración de todas las partes con staging y publicación atómica (O11)

**Fecha:** 24 de octubre de 2026 · **Rama:** `u-dat-04` (worktree `u-inf-03`, desde `feature/spec-pendientes` en `1c4215d`) · **Perfil:** `scratch` (`biblib-scratch`, 55340–55349, app 3149) · **Especificación:** [02 · U-DAT-04](../../../../spec-pendientes/02-datos-importacion-y-catalogacion.md#u-dat-04--restauración-de-todas-las-partes-con-staging-y-publicación-atómica) · **Operación:** [operacion.md](../../../../operacion.md#restauración-por-partes-con-staging-y-publicación-atómica--u-dat-04) · **Formato:** [formatos.md](../../../../formatos.md#conjunto-de-partes-bundleversion-1) · **Recuperación:** [recuperacion.md](../../../../recuperacion.md#restauraciones-por-partes-u-dat-04)

Incluye la **tarea T1** de [U-QA-03 §9](../../../rendimiento/2026-10-23/informe.md#9-tareas-por-presupuesto-incumplido).

## Qué se entrega

| Pieza | Archivos |
| --- | --- |
| Migración `0008_restore_sessions` | `lib/db/schema.ts`, `drizzle/0008_restore_sessions.sql`, journal y snapshot. Cuatro tablas de staging con RLS de propietario, FK compuestas y hashes/tamaños comprobados por Postgres; guarda `guard_import_staging` (`BR001`); purga `import_session_purge_expired` solo para el servidor; operación `restore.commit`. Corrección hacia delante de `saved_book_views_name_check` (0007), ver «Hallazgos». |
| Manifest de objetos | `scripts/db/objects-manifest.mjs` y `tests/fixtures/migrations/objects-0008.json` (metadatos reales tras 0008). |
| Formato y dominio | `lib/import-manifest.ts` (manifest `bundleVersion: 1`, límites), `lib/import-staging.ts` (sesiones, trozos, validación, plan y publicación), `lib/library-export.ts` (`buildBackupSet`), `lib/library-export-server.ts`, `MANIFEST_MISMATCH` (422) en `lib/domain-errors.ts`. |
| Acciones y ruta | `app/actions/restore-sessions.ts` (begin, upload por Blob, validate, prepare, commit, listar, descartar), `app/actions/library-export.ts` (recuentos, exportación, títulos acotados) y `app/api/library/export/route.ts` (descarga de cada parte con revisión y hash). |
| Interfaz | `components/restore-set-panel.tsx` (selección múltiple, manifiesto o partes sueltas, progreso, revisión, confirmación) y `app/settings/page.tsx` (T1 y la nueva sección). |
| Restore administrativo | `scripts/db/restore-local.mjs`: el staging se restaura tal cual, se comprueban los trozos y las sesiones abiertas quedan para revisión. |
| Medición | `scripts/performance/restore-bench.mjs` (`pnpm perf:restore`). |
| Pruebas | `tests/restore-sets.test.ts`, `tests/db/restore-sessions.sql`, `tests/integration/restore/**` (`pnpm test:integration:restore`, también en SUITES de `test:integration:local`), `tests/scripts/restore-sessions.test.mjs` y drift de 0008 en `tests/scripts/migrations.test.mjs`. |

## Aceptación de 02 y dónde se demuestra

Grupo `restore` en scratch ([35](35-integracion-restore-scratch.txt), 11/11), con sesiones GoTrue reales, la app compilada, los trozos en multipart como el navegador y el publicador compilado para inyectar fallos.

| Criterio | Prueba | Resultado |
| --- | --- | --- |
| 2001 libros en dos partes publican juntos; los observadores ven la colección anterior o la nueva | «2001 libros en dos partes…»: un observador cuenta los libros de A en bucle desde otra conexión durante la publicación; solo ve 4 o 2001. Se comprueban fichas, estanterías (también la vacía), predeterminada propia, revisión rotada, versión anterior en la misma transacción, sesión `committed` y staging liberado. | ✔ |
| Parte ausente, duplicada, corrupta, de otro conjunto y total falso | «parte ausente, duplicada, corrupta…»: `MANIFEST_MISMATCH` en cada caso (la ausente deja la sesión abierta para completarla; el resto la rechaza y libera el staging); un trozo dañado en tránsito no se guarda; la colección y sus versiones no cambian. | ✔ |
| Estantería vacía o compartida | «estanterías vacías y compartidas…»: la compartida queda una sola vez con todos sus libros y las vacías existen; la misma estantería con otro nombre en otra parte se rechaza. | ✔ |
| Error en la última sentencia o timeout revierten todo | «un error en la última sentencia o un timeout…»: `select 1/0` antes de marcar la sesión (con los 2001 libros ya insertados dentro), `statement_timeout` de 1 ms y presupuesto total agotado. En los tres casos no cambian colección, versiones de ficha, revisión, versión anterior ni operación; la sesión sigue `prepared` con su staging, y la misma clave publica después. «lock_timeout de 1 s»: con el bloqueo ocupado, falla en < 4 s sin aplicar nada. | ✔ |
| Repetir parte o commit da el mismo resultado; mismo `partId` con otros bytes, conflicto | «repetir una parte o el commit…»: trozo idéntico `replayed`, otros bytes `CONFLICT`, posición o total ajenos `MANIFEST_MISMATCH`; commit repetido devuelve la misma operación y versión sin otra escritura; otra clave sobre una publicada, `CONFLICT`. | ✔ |
| Edición en otra pestaña invalida el CAS y conserva el staging | «una edición en otra pestaña…»: otra sesión de A cambia una estantería; confirmar da `REVISION_CONFLICT` (no reintentable) también al repetir, el staging queda intacto, la vista previa nueva publica y la sustituida ya no sirve. | ✔ |
| A/B por la Data API y por SQL | «A/B…»: B recibe `NOT_FOUND` en validar, preparar, publicar, descartar y subir; no lista la sesión; SQL con sus claims ve 0 filas y no escribe; la Data API responde 406 para las tres tablas; anónimo, 307. | ✔ |
| Límites con `LIMIT_EXCEEDED` sin tocar la colección | «límites…»: más de 10 000 libros y más de 80 MiB se rechazan antes de aceptar bytes. Unitarias: 1 000 estanterías, 50 partes y 8 MiB por parte. | ✔ |
| 111 fichas legacy y una parte v1 sola importable | «las 111 fichas legacy…»: como parte suelta (manifiesto generado en el servidor con el hash exacto) restaura 111 fichas, los 9 `manual-…`, estado y procedencia; la misma parte por la importación de un archivo sigue funcionando. | ✔ |
| Auth/Storage local real, proveedor simulado, sin consultas externas en el commit | Sesiones GoTrue reales; la publicación es SQL por conjuntos sin red; catálogo en fixture. | ✔ |
| Tiempos y filas de 100, 1000 y 10 000 sin datos privados | [medicion-restauracion.json](medicion-restauracion.json), tabla en [operación](../../../../operacion.md#publicación-atómica-medida). 10 000 libros: publicación p50 1,3 s (colección actual pequeña) y 2,0 s (llena); sentencia más larga < 1,7 s. El JSON no contiene títulos, ISBN ni IDs. | ✔ |

**T1:** Ajustes carga `getLibraryCountsAction` (sin `getLibraryDataAction`, retirada) y la copia la genera el servidor; el navegador descarga cada parte por enlace sin materializar fichas. `test:smoke` exporta 2001 libros en dos partes por esta vía ([37](37-test-smoke.txt)) y la matriz de cabeceras cubre la ruta nueva ([34](34-cabeceras.txt), 36/36).

## Migración, restore administrativo y medición

| Paso | Resultado |
| --- | --- |
| Desde vacío: `db:reset:local --dry-run/--apply --discard-local-data` ([07](07-reset-dry-run.txt), [08](08-reset-apply.txt), [09](09-status-desde-vacio.txt)) | 0000→0008, seed y verify; `up-to-date`, 326 comprobaciones. |
| Actualización con datos: restore del respaldo con head 0006 ([12](12-restore-respaldo-0006.txt), [13](13-status-0006.txt)), plan y migrate ([14](14-plan-0007-0008.txt), [15](15-migrate-0007-0008.txt), [16](16-status-tras-migrar.txt)) | 0007 → 0008 en orden sobre datos restaurados; 326 comprobaciones sin drift. (Antes se aplicó 0007→0008 directamente sobre el scratch existente con la primera versión de 0008; tras la corrección de la restricción se repitió por esta ruta con el archivo final.) |
| Ensayo con una restauración a medias ([17](17-sesion-de-ensayo.txt)–[23](23-retirar-sesion-de-ensayo.txt), script [sesion-de-ensayo.mjs](sesion-de-ensayo.mjs)) | Sesión con trozos → `db:backup:local` → reset → `db:restore:local` (`restoreSessions`: 1 sesión abierta para revisión, trozos íntegros) → `db:restore:verify` superado: hechos de catálogo idénticos al origen y las cuatro tablas con cantidades, claves y contenido iguales. Sin depender de la normalización del comparador de U-EXP-03. Sesión de ensayo retirada. |
| `db:status:local` final ([38](38-status-final.txt)) | `up-to-date`, 326 comprobaciones. |

La medición se hizo antes de la corrección de `saved_book_views_name_check`; esa restricción no interviene en la publicación.

## Validación

| Comando | Resultado |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` ([30](30-lint.txt), [31](31-typecheck.txt)) | Sin errores. |
| `pnpm test` ([32](32-test.txt)) | 329/329. |
| `pnpm test:scripts` ([33](33-test-scripts.txt)) | 237 superadas; **falla** la suite `[stack]` «promoción contra un remoto simulado» (8 canceladas) con `role "anon" already exists`: es previa a esta unidad (ver «Hallazgos»). |
| `pnpm test:db` ([36](36-test-db.txt)) | Todas las fases, incluida `restore-sessions.sql`. |
| `pnpm build` ([39](39-build.txt)) / `pnpm test:smoke` ([37](37-test-smoke.txt)) | Correcto / 12/12. |
| `pnpm test:integration:restore --profile scratch` ([35](35-integracion-restore-scratch.txt)) | 11/11. |
| Otros grupos en scratch tras los cambios (logs en `.biblib/integration/dat04-g-*.log`) | snapshots 10/10, views 5/5, security 23/23 (incluye el aislamiento adaptado), jobs 19/19. |
| `pnpm security:headers:local --profile scratch` ([34](34-cabeceras.txt)) | 36/36 respuestas conformes, incluida `/api/library/export`. |
| HolaERP ([antes](holaerp-antes.txt), [después](holaerp-despues.txt)) | Mismos contenedores, estados, volúmenes y redes. |

**Interfaz** (sesión GoTrue real de A en la app de scratch; [captura-ui.mjs](captura-ui.mjs), [informe](ui-informe.json)): [inicio](ui-restaurar-inicio.png), [conjunto verificado](ui-restaurar-verificado.png), [revisión](ui-restaurar-revision.png), [confirmación](ui-restaurar-confirmacion.png), [publicada](ui-restaurar-publicada.png) (2001 libros), [exportación por partes con manifiesto](ui-exportacion-partes-manifiesto.png) y [parte suelta en móvil](ui-restaurar-sueltas-movil.png); sin desbordamiento horizontal ni errores de consola, y la biblioteca de A devuelta al terminar.

No se ejecutaron `pnpm test:integration:local` ni el E2E: el perfil `test` es de U-EXP-03 en esta ola. Por eso los grupos `rls` y `auth`, adaptados aquí, no se han ejecutado contra el stack; `restore` ya está en SUITES y admite `--profile test`.

## Hallazgos y decisiones

- **Sin ADR de generaciones/puntero:** con 10 000 libros la transacción final cabe holgadamente en el presupuesto (`lock_timeout` 1 s, `statement_timeout` 5 s por sentencia, 15 s en total, configurable con `BIBLIB_RESTORE_COMMIT_BUDGET_MS`).
- **Transporte:** los trozos viajan como Blob en la Server Action (multipart), nunca en base64; el servidor mide su tamaño real y su hash antes de guardar, y Postgres vuelve a comprobar ambos.
- **Publicación por defecto activa**, con el interruptor `BIBLIB_RESTORE_SESSIONS_PUBLISH=false` (valida y revisa sin publicar): las pruebas de fallo que la spec pedía antes de abrirla están en este grupo.
- **Decisiones del coordinador:**
  - Opción B: se retiró `getLibraryDataAction` (lectura sin límite) y se adaptaron, en commits propios, `tests/integration/{rls,auth,security}` y `scripts/performance` a acciones acotadas, conservando lo que verifican.
  - Opción A: `saved_book_views_name_check` (0007, U-EXP-02) cambiaba tras `pg_dump` (`between … and … and` anidado) y hacía fallar `db:restore:verify` en cualquier head ≥ 0007. Se corrige hacia delante en 0008 con la misma restricción como conjunción plana; 0007 no se reescribe.
- **Cambios mínimos en archivos de otras unidades**, cada uno en su propio commit: `scripts/test-database.mjs` y `scripts/smoke-app.mjs` (aplicar 0007/0008), `tests/scripts/saved-views.test.mjs` (los hechos de 0007 contra su prefijo), `tests/integration/run.mjs` (SUITES), `scripts/security/headers-matrix.mjs` (ruta nueva) y la lista de escenarios de `perf:local` en `docs/operacion.md`.
- **Pendiente ajeno:** la suite `[stack]` de promoción falla porque `tests/db/bootstrap.sql` crea `anon` desde `7a4e62a` (U-EXP-02) y `tests/scripts/promotion-harness.mjs` lo vuelve a crear. U-EXP-03 toca ese harness en esta ola; no se ha modificado aquí.
- **Fuera de alcance:** la purga programada (`import_session_purge_expired`, F4), la limpieza integral de cuenta (U-OPS-03, inventario en `RESTORE_SESSION_INVENTORY`) y un trabajo persistente para publicar en segundo plano (la publicación es una única transacción en línea que cabe en el presupuesto).

## Recursos Docker al terminar

`pnpm db:local:down --profile scratch` ([40](40-down-scratch.txt)): contenedores de scratch parados y retirados. Quedan, propios del perfil, la red `biblib-scratch-network` y los volúmenes `supabase_db_biblib-scratch` y `supabase_storage_biblib-scratch`. No se tocó ningún recurso de HolaERP ni del perfil `test`.

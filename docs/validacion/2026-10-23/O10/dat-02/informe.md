# U-DAT-02 · Versiones anteriores y deshacer recuperable (O10)

**Fecha:** 23 de octubre de 2026 · **Rama:** `u-dat-02` (worktree `u-inf-03`, desde `feature/spec-pendientes` en `7e9a1dd`) · **Perfil:** `scratch` (`biblib-scratch`, 55340–55349, app 3149) · **Especificación:** [02 · U-DAT-02](../../../../spec-pendientes/02-datos-importacion-y-catalogacion.md#u-dat-02--versiones-anteriores-y-deshacer-recuperable) · **Operación:** [operacion.md](../../../../operacion.md#versiones-anteriores-y-deshacer-recuperable--u-dat-02) · **Recuperación:** [recuperacion.md](../../../../recuperacion.md#versiones-anteriores-u-dat-02)

## Qué se entrega

| Pieza | Archivos |
| --- | --- |
| Migración `0006_library_snapshots` | `lib/db/schema.ts`, `drizzle/0006_library_snapshots.sql`, journal y snapshot. Tablas `library_snapshots` y `library_snapshot_chunks` (RLS de propietario, FK compuestas, índices) y 4 funciones `SECURITY DEFINER` con `search_path` fijo. También `import_previews.snapshot_id`, `library_operations (user_id, id)` y el motivo `snapshot.restore`. |
| Índices T8 (U-QA-03) | `books_user_title_idx`, `books_user_shelf_title_idx` y `books_user_created_idx` en la misma migración. |
| Manifest de objetos | `scripts/db/objects-manifest.mjs` y `tests/fixtures/migrations/objects-0006.json` (metadatos reales tras 0006). |
| Dominio | `lib/library-snapshots.ts` (plan de restauración, integridad, cursor, límites, inventario) y `lib/import-publisher.ts`: captura en la transacción final y `publishSnapshotRestore`. |
| Acciones | `app/actions/library-snapshots.ts`: `listLibrarySnapshotsAction`, `previewSnapshotRestoreAction`, `restoreSnapshotAction` y `deleteLibrarySnapshotAction`. Código `LIMIT_EXCEEDED` (413) en `lib/domain-errors.ts`. |
| Interfaz | `app/settings/page.tsx`: sección «Versiones anteriores» y tarea **T2** (avisos en una región `aria-live` fija, estado de la copia con espacio reservado y partes en un diálogo). |
| Restore administrativo | `scripts/db/restore-local.mjs`: las versiones se restauran tal cual y se verifica su integridad; documentado en `docs/recuperacion.md`. |
| Pruebas | `tests/library-snapshots.test.ts`, `tests/db/snapshots.sql`, `tests/integration/snapshots/**` (`pnpm test:integration:snapshots`, también en SUITES de `test:integration:local`), `tests/scripts/snapshots-restore.test.mjs` y drift de 0006 en `tests/scripts/migrations.test.mjs`. |

## Aceptación de 02 y dónde se demuestra

| Criterio | Prueba | Resultado |
| --- | --- | --- |
| Reemplazar A crea exactamente una versión coherente | `integration/snapshots` «reemplazar A crea exactamente una versión…»: una versión por `operationId`, `ready`, revisión capturada = la revisada, cantidades e IDs de la colección sustituida, trozos con hash válido y 30 días. Repetir la clave no crea otra y fusionar no captura. `snapshots.sql`: hash final recalculado en SQL. | ✔ |
| B no puede listar, descargar ni restaurar la de A | «B no puede listar, descargar, comparar, restaurar ni borrar…»: listar, comparar, borrar y restaurar con la vista previa de A dan `NOT_FOUND`. SQL con los claims de B ve 0 cabeceras y 0 trozos, y la Data API responde 406. `snapshots.sql`: C/D con permisos mínimos y FK de propietario. | ✔ |
| Un fallo entre captura y publicación conserva la colección sin versión válida parcial | «un fallo entre la captura y la publicación…»: el publicador compilado recibe un fallo en `afterCapture`. Dentro de la transacción la versión estaba `ready`; tras el fallo, la colección (con sus versiones de ficha) y la revisión siguen iguales, y no quedan versión ni operación. La misma vista previa se publica después por la app con una sola versión. Igual para `publishSnapshotRestore`. | ✔ |
| Deshacer devuelve datos y referencias, con IDs propios y versiones nuevas | «deshacer devuelve datos y referencias…»: estanterías, IDs, campos y `shelf_id` idénticos a los de antes del reemplazo; todas las `books.version` son nuevas; la revisión rota; se captura la versión del estado sustituido (`snapshot.restore`). | ✔ |
| Una segunda pestaña que edita antes de confirmar provoca conflicto | «una segunda pestaña…»: otra sesión GoTrue de A renombra una estantería. Restaurar con la comparación vieja da `REVISION_CONFLICT` (no reintentable) también al repetir, sin cambios ni versión nueva. Una comparación nueva con la revisión actual sí restaura. | ✔ |
| Caducidad | «caducidad…»: una versión vencida no se lista; restaurar o comparar dan `PREVIEW_EXPIRED`; la siguiente captura la retira. `snapshots.sql`: la purga del servidor. | ✔ |
| Cuota agotada | «cuota agotada…»: con 10 versiones, reemplazar y restaurar dan `LIMIT_EXCEEDED` con un mensaje claro. Ninguna versión se borra y la colección no cambia. Eliminar una de forma explícita permite reemplazar. | ✔ |
| Borrado de la versión durante una vista previa | «borrar la versión mientras se prepara…»: una versión antigua no autoriza el borrado (`CONFLICT`); borrar elimina la vista previa en cascada y restaurar responde `NOT_FOUND` («ya no está disponible») sin cambios. | ✔ |
| Reintento con respuesta perdida | Restaurar dos veces con la misma clave devuelve el mismo `operationId` con `replayed: true`, sin otra versión ni escritura. Confirmar un reemplazo dos veces, igual. | ✔ |
| La eliminación de cuenta (estado bloqueado) impide capturas | «una cuenta bloqueada…»: restaurar y reemplazar dan `UNAUTHORIZED` sin cambios. `snapshots.sql`: `BS002` y el borrado en cascada de la cuenta. | ✔ |
| Integración Auth/Storage cuando haya blobs | Las versiones no guardan blobs: las portadas son URL dentro del JSON. El proveedor no participa en su contenido. | n/a |
| Compatibilidad | Sin historial inferido antes del despliegue; el respaldo portable no cambia; IDs ocupados por otra cuenta se reasignan e informan (unitaria y `snapshots.sql`). | ✔ |

## Migración y restore administrativo (salidas en esta carpeta)

| Paso | Resultado |
| --- | --- |
| 0005→0006 sobre el scratch existente (head 0005 de la ola anterior) | Al empezar, `db:local:bootstrap --profile scratch` aplicó 0006 sobre la base en 0005. Su verificación marcó 2 políticas no declaradas porque el manifest aún no incluía 0006; se declararon sin reaplicar. Esa salida no se conservó y la migración se corrigió después dos veces (ver «Hallazgos»), así que la ruta de actualización se repitió con el archivo final: |
| Desde vacío: `db:reset:local --dry-run/--apply --discard-local-data` ([02](02-reset-dry-run.txt), [03](03-reset-apply.txt), [04](04-status-desde-vacio.txt)) | 0000→0006, seed y verify correctos; `up-to-date` con 242 comprobaciones. |
| Actualización con datos: restore de un respaldo con head 0004 ([05](05-restore-respaldo-0004.txt)), `db:plan:local` y `db:migrate:local` ([06](06-plan-0004-0005-0006.txt), [07](07-migrate.txt), [08](08-status-tras-migrar.txt)) | Aplicadas 0005 → 0006 en orden sobre datos restaurados; 242 comprobaciones sin drift. |
| Ensayo de recuperación con una versión anterior ([09](09-version-de-ensayo.txt)–[15](15-retirar-version-de-ensayo.txt)) | Versión capturada por el protocolo → `db:backup:local` → reset → `db:restore:local` (`rotation.snapshots`: 1 restaurada, 2 trozos, sin revisiones pendientes) → `db:restore:verify` superado, con `library_snapshots`/`library_snapshot_chunks` iguales al recibo y el ledger de 7 migraciones. La versión de ensayo se retiró al terminar. |
| EXPLAIN de los índices T8 ([16](16-explain-indices.json), script [explain-indices.mjs](explain-indices.mjs)) | Como `authenticated` con RLS, 10 000 fichas en una transacción revertida. Inicio «Añadidos recientemente» usa `books_user_created_idx` (0,04 ms frente a 10,1 ms sin él), Colección página 1 usa `books_user_title_idx` (0,05 frente a 13,7 ms) y Estantería 3D usa `books_user_shelf_title_idx` (0,10 frente a 3,0 ms). |
| Tamaño y coste de captura ([18](18-tamano-captura.txt)) | 111 libros: 75 KiB, 2 trozos, 13 ms. 10 000 libros: 6,6 MiB, 51 trozos, 393 ms (transacción revertida). |

## Validación

| Comando | Resultado |
| --- | --- |
| `pnpm test:integration:snapshots --profile scratch` ([17](17-integracion-snapshots-scratch.txt)) | 10/10 con build nuevo. |
| `pnpm test:integration:jobs --profile scratch --reuse-build` ([19](19-integracion-jobs-scratch.txt)) | 19/19: el publicador con captura no rompe los trabajos. |
| `pnpm lint` / `pnpm typecheck` ([20](20-lint.txt), [21](21-typecheck.txt)) | Sin errores. |
| `pnpm test` ([22](22-test.txt)) | 305/305. |
| `pnpm test:scripts` ([23](23-test-scripts.txt)) | 229/229. |
| `pnpm test:db` ([24](24-test-db.txt)) | Todas las fases, incluida `snapshots.sql`. |
| `pnpm test:smoke` ([25](25-test-smoke.txt)) | 12/12, con la exportación por partes en el diálogo. |
| `db:status:local --profile scratch` ([26](26-status-final.txt)) | `up-to-date`, 242 comprobaciones. |
| HolaERP ([27](27-holaerp.txt)) | Mismos contenedores, estados y volúmenes antes y después. |

**Interfaz** (sesión GoTrue real de A en la app de scratch; [captura-ui.mjs](captura-ui.mjs), [informe](ui-informe.json)):

- Historial: [escritorio](ui-historial-escritorio.png) y [móvil](ui-historial-movil.png), sin desbordamiento horizontal.
- [Comparación](ui-comparacion.png), [confirmación](ui-confirmacion.png) y [restaurada](ui-restaurada.png). Tras deshacer desde la UI, A vuelve exactamente a sus IDs.
- [Partes de una copia en diálogo](ui-exportacion-partes-dialogo.png), del smoke.

No se ejecutó `pnpm test:integration:local` ni el E2E: el perfil `test` lo usa U-FIX-02 en esta ola. El grupo `snapshots` ya está en sus SUITES y admite `--profile test`.

## Hallazgos y decisiones

- **Cuota propuesta: 10 versiones vigentes por cuenta y 30 días**, con 10 000 libros y 1 000 estanterías por versión. Con la cuota llena se bloquea la operación destructiva y nunca se borra una versión vigente para hacer sitio. La capacidad definitiva la fija F4.
- **Restricción estable tras un volcado**: `BETWEEN … AND …` combinado con `AND` se deparseaba con un AND anidado que `pg_dump` aplanaba, y `db:restore:verify` veía restricciones distintas del origen. Se reescribió como conjunción plana (punto fijo). Lo detectó el ensayo de recuperación.
- **Índices descendentes**: Drizzle genera `DESC NULLS LAST` con `.desc()`, pero `ORDER BY created_at DESC` usa `NULLS FIRST`, y el planificador no usaba el índice. Se declaran con `.desc().nullsFirst()`. Lo detectó el EXPLAIN.
- **Versiones en el restore administrativo**: se restauran tal cual y no se rotan. Su `version` solo autoriza borrar esa versión, y restaurarla exige una vista previa nueva contra la revisión, que sí se rota. Sí se verifican sus hashes.
- **Cambios mínimos en archivos de otras unidades**, cada uno en su propio commit:
  - `lib/jobs/server.ts`: traducción de `LIMIT_EXCEEDED`.
  - `scripts/test-database.mjs` y `scripts/smoke-app.mjs`: aplicar 0006.
  - `tests/e2e/flujos/importacion.spec.ts`: el E2E de reemplazo retira la versión que ahora crea, para no agotar la cuota de A entre ejecuciones.
  - `tests/scripts/migrations.test.mjs`: nuevo head y drift de 0006.
  - `tests/integration/run.mjs`: SUITES.
- **Fuera de alcance**:
  - Exportar una versión anterior como archivo (acción aparte en la spec).
  - La purga programada con `library_snapshot_purge_expired` (F4).
  - La limpieza integral de cuenta (U-OPS-03, con el inventario preparado en `SNAPSHOT_INVENTORY`).
  - El aviso preexistente `bindings.loopback` del perfil scratch, que también aparece en la evidencia de U-DAT-03.

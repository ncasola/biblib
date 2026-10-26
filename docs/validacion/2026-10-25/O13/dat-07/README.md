# U-DAT-07 · Bandeja de revisión bibliográfica y decisiones masivas (O13 · paso 2)

**Fecha:** 25 de octubre de 2026 · **Rama:** `u-dat-07` (worktree `stack-scratch`) · **Perfil:** `scratch`, head `0014_product_batch_o13` · **Sin schema ni migraciones nuevas.**

## Entrega

| Pieza | Archivos |
| --- | --- |
| Lógica pura (cliente y servidor) | `lib/catalogue-review.ts`: incidencias derivadas con `dedupe_key` estable, sincronización con las guardadas, filtros y cursor, comparación campo a campo con la fuente de cada afirmación, plan de cada decisión y huella por fila. |
| Persistencia | `lib/db/review.ts`: sincronización bajo bloqueo consultivo, listado por cursor, carga de hechos, aplicación atómica o parcial con idempotencia. |
| Acciones del contrato de 02 | `app/actions/review.ts`: `listReviewIssuesAction`, `compareBibliographicCandidatesAction`, `prepareReviewBatchAction`, `applyReviewBatchAction` y `decideReviewIssueAction` (decisión individual). |
| Interfaz | `app/books/review/page.tsx`, `app/books/review/[id]/page.tsx`, `components/review-inbox.tsx`, `components/review-comparison.tsx`, `lib/review-batch-draft.ts`; enlace «Revisar fichas» en `app/books/page.tsx`. |
| Fusión (U-DAT-06) | `lib/db/editions.ts`: `mergeEditions` mueve antes las evidencias de las ediciones de origen al destino (contrato de 0014). Commit propio. |
| Pruebas | `tests/catalogue-review.test.ts` (12), grupo `tests/integration/review` (14, en SUITES y `pnpm test:integration:review`), `tests/e2e/flujos/revision.spec.ts`, rutas en `tests/accessibility/audit.spec.ts` y en `scripts/security/headers-matrix.mjs`. |
| Documentación | `docs/operacion.md` → «Bandeja de revisión bibliográfica · U-DAT-07 (O13)». |

## Decisión sin respuesta del coordinador

El contrato de 0014 no cubre dónde guardar las vistas previas de lotes ni la idempotencia de `applyReviewBatchAction`: `library_operations_operation_check` no admite una operación de revisión e `import_previews` exige `mode` `merge|replace`. Se preguntó por `orca orchestration ask` (`msg_d83791e89cd5`) y no hubo respuesta en 20 minutos. Se aplicó la opción conservadora, que no toca el schema:

- **Vista previa sin estado.** `previewId` es el sha256 canónico de dueño, revisión, caducidad (15 minutos), decisiones y la huella de cada fila. El cliente devuelve `preview` tal cual, un campo aditivo en `applyReviewBatchAction`. El servidor recalcula el plan bajo el bloqueo de colección: aplica todo o nada (`REVISION_CONFLICT`, `CONFLICT`, `PREVIEW_EXPIRED`), salvo con `mode: "partial"` explícito, que aplica cada fila válida en un punto de guardado y devuelve un informe por fila. La huella no autoriza nada: cada escritura vuelve a comprobar versiones, dueño y RLS.
- **Idempotencia.** `review_decisions.operation_id` es un UUID derivado de dueño, operación y clave, y los IDs de decisión son deterministas. La misma confirmación devuelve `status: "replayed"`; la misma clave con otras decisiones devuelve `IDEMPOTENCY_CONFLICT`. Si el lote D añade `review.apply` y un almacén de vistas previas, se puede migrar sin cambiar la interfaz.

## Reglas de procedencia aplicadas

- **Procedencia por campo.** `accept_fields` escribe en `catalogue.fields` solo los campos elegidos, con `selection: "user-selected"`.
- **Licencias.** Una ficha de proveedor solo se acepta si `canRetainMetadata` lo permite. Google Books aparece como vista previa, no se puede aceptar y no se persiste. De un proveedor se guarda solo lo aceptado, como evidencia `bibliographic_match`.
- **Comprobación física.** Solo existe con `confirm_physical` y `confirmed: true`. Ninguna selección automática, ficha pública ni foto la produce.
- **Fotos.** La comparación cita las fotos como «foto privada propia», sin clave de Storage, ID del asset ni URL firmada. Esta unidad solo cita assets `evidence` existentes; la subida de fotos nuevas espera al helper `lib/media/server.ts` de U-EXP-06.

## Resultados (ejecutados en esta sesión)

| Comprobación | Resultado | Evidencia |
| --- | --- | --- |
| `pnpm lint` | 0 errores | `validacion-lint.txt` |
| `pnpm typecheck` | correcto | `validacion-typecheck.txt` |
| `pnpm test` | 399/399 | `validacion-test.log` |
| `pnpm test:scripts` | 265/265 (incluidas las pruebas `[stack]` con `scratch` en marcha) | `validacion-test-scripts.log` |
| `pnpm test:db` | completadas en contenedor aislado (incluido «incidencias, decisiones de solo inserción, evidencias acotadas…») | salida en la terminal de la sesión |
| `pnpm build` | correcto; rutas `ƒ /books/review` y `ƒ /books/review/[id]` | salida en la terminal de la sesión |
| `pnpm test:smoke` | `ok: true` (el script solo imprime el JSON final si todas las comprobaciones pasan) | artefactos en la carpeta temporal del sistema |
| Grupo `review` (scratch) | 14/14 | `grupo-review.log` |
| Grupo `product` (scratch, `--reuse-build`) | 17/17 | `grupo-product.log` |
| Grupo `model` (scratch, `--reuse-build`) | 8/8 | `grupo-model.log` |
| Grupo `security` (scratch, `--reuse-build`) | 23/23 | `grupo-security.log` |
| Recorrido del E2E en `scratch` (script de ensayo, no versionado) | todos los pasos; sin desbordamiento a 320 px | `ui/recorrido-scratch.txt`, `ui/*.png` |

Durante la primera ejecución de `pnpm test:scripts` fallaron dos pruebas `[stack]` (`reset`, `seed`) porque el grupo `review` tenía tomado el bloqueo del perfil. Al repetirlas sin contención pasaron (28/28), y la ejecución completa registrada pasa entera. También falló la cobertura de la matriz de cabeceras por las rutas nuevas; se corrigió inventariándolas.

## Aceptación de U-DAT-07 (02)

- **Importación de referencia.** La de 111 registros genera 9 sin ISBN, 9 sin portada y 76 ISBN provisionales, sin ninguna comprobación física. Regenerar no duplica: hay una abierta por clave.
- **Filtros y vuelta.** Se filtra por motivo, fuente y resolución en la URL. Tras abrir una ficha se vuelve a la misma selección con el foco en la incidencia (integración y recorrido de la interfaz).
- **Lotes.** Admiten hasta 50 decisiones (51 se rechazan). La vista previa muestra altas, modificaciones y fusiones y requiere confirmación. Una versión antigua produce conflicto sin aplicar nada; el modo parcial explícito informa por fila.
- **Casos de concurrencia y datos.** Probados: dos revisores de la misma cuenta, una fuente eliminada tras la vista previa, homónimos, autores iguales con obras distintas y una vista previa alterada o de otra cuenta.
- **Aislamiento.** Con sesiones GoTrue reales, B no enumera fotos, fuentes, evidencias ni incidencias de A, y no compara ni decide sobre ellas. La respuesta es igual a la de una incidencia inexistente.
- **Proveedores simulados.** El fixture de Open Library aporta datos que contradicen la edición, y las pruebas unitarias usan OL, BNE y Google contradictorios. Ninguna selección automática eleva una ficha a `physically_checked`.
- **Fusión.** Mueve antes las evidencias. El destino conserva sus valores y las discrepancias abren `source_conflict` con los valores de origen como evidencia.

## Recursos Docker que quedan

`pnpm db:local:down --profile scratch` salió con 0 (`scratch-down.txt`). Quedan la red `biblib-scratch-network` y los volúmenes `supabase_db_biblib-scratch` y `supabase_storage_biblib-scratch` (`scratch-recursos-restantes.txt`). HolaERP siguió en marcha y no se tocó. Un contenedor `biblib-smoke-edff9ce1`, creado por una invocación accidental del propio smoke de esta sesión y cortada por `timeout`, se retiró por nombre exacto.

## Pendiente o fuera del alcance

- **Para el coordinador.** Ejecutar en `test` `tests/e2e/flujos/revision.spec.ts` y la suite de accesibilidad con la ruta `/books/review` añadida. La pantalla de comparación no está en axe porque necesita una incidencia. Faltan los ensayos manuales con NVDA, Narrator y VoiceOver.
- **Fusión de obras.** No se implementa: U-DAT-06 no tiene `mergeWorks`, y la generación nunca agrupa ediciones de obras distintas.
- **ISBN y portada.** `accept_fields` no cambia ninguno de los dos. El ISBN se corrige desde la ficha o fusionando; la portada, desde la ficha.
- **Motivos sin generar.** `invalid_isbn` e `isbn_conflict` existen en el contrato, pero no se generan todavía. La comparación y las decisiones ya los admiten.
- **Series en la fusión (para U-PRO-05 o el coordinador).** Al fusionar ediciones, el vínculo `series_editions` de una edición de origen se retira en cascada con la poda; no se mueve al destino.

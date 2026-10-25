# Retención y eliminación de cuenta · U-OPS-03

Inventario de lo que BibLib guarda de cada cuenta, cómo se elimina cuando la persona lo pide y qué se conserva, durante cuánto tiempo y por qué. Especificación: [04 · U-OPS-03](spec-pendientes/04-calidad-seguridad-y-operacion.md#u-ops-03--eliminación-de-cuenta-y-retención-de-datos). Operación: [operacion.md](operacion.md#eliminación-de-cuenta-y-retención--u-ops-03-o12). Recuperación: [recuperacion.md](recuperacion.md#supresiones-de-cuentas-al-restaurar-u-ops-03).

## Flujo

1. **Perfil → Eliminar la cuenta** muestra el alcance, enlaza a **Exportar mi biblioteca** (Ajustes) y exige escribir «ELIMINAR MI CUENTA», marcar que se entiende que es definitivo y haber iniciado sesión hace menos de 15 minutos (claim `amr` verificado de GoTrue). La cuenta es siempre la de la sesión: `requestAccountDeletionAction({ confirmation, operationKey })` no acepta ningún ID.
2. `biblib.account_deletion_request` (0013) crea la solicitud una sola vez por cuenta, toma el bloqueo de colección, marca `account_lifecycle.state = 'deleting'` y expira los trabajos no terminados. Repetirla, con cualquier clave, devuelve el mismo estado (doble clic, respuesta perdida).
3. La acción cierra todas las sesiones con el logout global de GoTrue usando el token del propio usuario (Next no tiene `service_role`). Mientras un JWT anterior no caduque, **ninguna escritura pasa**: el bloqueo de colección y las políticas RESTRICTIVE de todas las tablas con escritura de cliente llaman a `biblib.account_write_allowed()` (BD001 → `ACCOUNT_INACTIVE`), y las políticas de Storage exigen cuenta activa para subir o retirar objetos. El cliente no puede cambiar ese estado: no tiene privilegios sobre `account_lifecycle` ni sobre `account_deletions`, y `account_set_state` rechaza una cuenta en eliminación (BD002).
4. El worker administrativo (`pnpm account:deletions:local`, fuera de Next) reclama la solicitud con lease y fencing y ejecuta los pasos del inventario en orden; cada paso es idempotente y solo avanza cuando la base confirma que está vacío.
5. Al final borra la identidad con la API admin de GoTrue y comprueba que no queda nada (`biblib.account_residue`: filas de cualquier tabla de `biblib` con dueño, objetos de Storage e identidad). Con Storage pendiente o un paso con restos, **no se da por terminada**: el error queda en `account_deletions.error_code`, se reintenta con espera creciente y, tras 5 intentos seguidos del mismo paso, pasa a `failed` hasta que operación la reanuda (`--retry-failed`).
6. Queda solo la **marca técnica** (`completed`): ID de la cuenta, fechas y plazo. Sin correo, sin contadores ni contenido bibliográfico, sin FK a `auth.users` y sin acceso para la cuenta eliminada.
7. Las copias administrativas anteriores siguen su propia política (abajo); si alguna se restaura, la supresión se aplica antes de abrir el servicio.

## Inventario

Orden de los pasos: sesiones → Storage → filas (hijas antes que padres) → identidad → verificación. Es el mismo en `ACCOUNT_DATA_INVENTORY` (`lib/account-deletion/worker.ts`) y en `biblib.account_deletion_step_tables` (0013, ampliada en 0014 con los pasos `product` y `media` y en 0015 con la lectura y los préstamos); `tests/account-deletion.test.ts` y `tests/db/account-deletion.sql` fallan si una tabla con dueño queda fuera o si una tabla con escritura de cliente no exige cuenta activa.

| Recurso | Tipo | Contenido | Paso y tratamiento |
| --- | --- | --- | --- |
| `auth.sessions` | GoTrue | Sesiones y refresh tokens. | `sessions`: logout global al solicitar; el worker bloquea la cuenta en GoTrue (`ban_duration`) para que ningún refresh token superviviente ni un nuevo inicio de sesión funcionen. |
| `biblib-covers` | Storage | Imágenes de portadas privadas `<dueño>/<asset>/<intento>.webp`. | `storage`: el worker las retira con la API de Storage (credencial administrativa) por lotes de 100. |
| `biblib-media` | Storage | Avatar propio, fotos de ubicaciones y fotos fuente de evidencias (`<dueño>/<tipo>/<asset>`, WebP sin EXIF ni GPS). | `storage`: como las portadas. |
| `storage.objects` | Storage | Cualquier otro objeto con prefijo `<dueño>/` o propietario de la cuenta, en cualquier bucket. | `storage`: igual que las portadas; el paso no avanza mientras quede alguno. |
| `cover_assets` | tabla | Metadatos de portadas privadas (clave, hash, tamaño, origen y derechos). | `covers`: se sueltan de sus ediciones y se borran. |
| `library_snapshot_chunks` | tabla | Trozos de versiones anteriores de la colección. | `snapshots`. |
| `library_snapshots` | tabla | Cabeceras de versiones anteriores. | `snapshots` (antes que las operaciones que citan). |
| `import_session_rows` | tabla | Filas validadas de restauraciones por partes. | `staging`. |
| `import_session_chunks` | tabla | Bytes de las partes recibidas. | `staging`. |
| `import_session_parts` | tabla | Partes esperadas. | `staging`. |
| `import_sessions` | tabla | Sesiones de restauración por partes. | `staging`. |
| `library_job_items` | tabla | Elementos de trabajos. | `jobs`. |
| `library_jobs` | tabla | Trabajos persistentes (ya expirados al solicitar). | `jobs`. |
| `saved_book_views` | tabla | Vistas guardadas (nombre y filtros). | `views`. |
| `import_previews` | tabla | Vistas previas de importación con el archivo leído. | `previews`. |
| `library_operations` | tabla | Resultados idempotentes de operaciones. | `operations`. |
| `catalogue_private_cache` | tabla | Caché privada de búsquedas por título o autor (consulta reducida a HMAC). | `private_cache`. |
| `catalogue_quota_reservations` | tabla | Reservas de cuota de proveedores a nombre de la cuenta. | `private_cache`. |
| `reading_entries` | tabla | Sesiones y cambios de progreso de lectura (U-PRO-02): instante, páginas y nota. | `product` (antes que sus ciclos). |
| `reading_cycles` | tabla | Ciclos de lectura y relecturas de cada ejemplar: estado y fechas que constan. | `product`. |
| `loans` | tabla | Préstamos de cada ejemplar (U-PRO-04): alias corto de quien lo tiene (nunca correo ni teléfono), fechas civiles y nota. | `product`. |
| `review_decisions` | tabla | Decisiones de revisión bibliográfica (U-DAT-07): campos elegidos y evidencias citadas. | `product` (antes que sus incidencias). |
| `review_issues` | tabla | Incidencias de revisión: motivo, IDs de las entidades y estado. | `product`. |
| `bibliographic_evidence` | tabla | Evidencias de ediciones y ejemplares: fuente, afirmaciones por campo, confianza y foto citada. | `product`. |
| `copy_tags` | tabla | Etiquetas de cada ejemplar (U-PRO-01). | `product`. |
| `copy_annotations` | tabla | Notas privadas y valoración de cada ejemplar. | `product`. |
| `copy_locations` | tabla | Ubicación física actual de cada ejemplar (U-PRO-03). | `product`. |
| `series_editions` | tabla | Ediciones en series con su posición (U-PRO-05). | `product`. |
| `tags` | tabla | Etiquetas de la cuenta. | `product`. |
| `locations` | tabla | Árbol de ubicaciones físicas. | `product`: de las hojas a la raíz (la FK con el padre no admite otra cosa). |
| `series` | tabla | Series privadas. | `product`. |
| `csv_mapping_profiles` | tabla | Perfiles de mapeo CSV guardados a petición, sin muestras (U-DAT-09). | `product`. |
| `profiles` | tabla | Perfil privado con la referencia al avatar propio (U-EXP-06). | `product`. |
| `media_assets` | tabla | Metadatos de las imágenes privadas (ruta, hash, tamaño, tipo). | `media`: después de retirar todo lo que las cita. |
| `copies` | tabla | Ejemplares (estado, estantería, comprobación física, identificador legacy). | `copies`: la poda de 0012 retira las ediciones y obras que quedan sin ejemplares. |
| `editions` | tabla | Ediciones (descripción bibliográfica, ISBN-13, portada). | `editions`: las que no podó la cascada. |
| `works` | tabla | Obras. | `works`. |
| `shelves` | tabla | Estanterías, incluida la predeterminada. | `shelves`. |
| `library_state` | tabla | Revisión de la colección. | `state` (después de las filas: sus triggers la recrean mientras exista la identidad). |
| `model_migration_report` | tabla | Informe del backfill obra/edición/ejemplar. | `state`. |
| `books_legacy` | tabla | Copia congelada de la ficha plana anterior a 0011 (se retira en F4). | `state`. |
| `account_lifecycle` | tabla | Estado `deleting` que bloquea las escrituras. | `auth`: lo retira la cascada al borrar la identidad. |
| `auth.users` | GoTrue | Identidad, identidades vinculadas (Google), factores y sesiones. | `auth`: `auth.admin.deleteUser`; la cascada de `auth.users` retira cualquier fila con dueño que quedara. |
| `account_deletions` | tabla | Solicitud, paso del worker y, al terminar, la marca técnica. | Se conserva; ver plazos. |

Sin datos de la cuenta, y por tanto fuera del inventario: la caché compartida de metadatos públicos (`catalogue_cache`, `catalogue_inflight`), los buckets de cuota por proveedor (`catalogue_quota_buckets`) y el ledger de migraciones. Los registros operativos (U-OPS-01) no llevan datos de biblioteca ni IDs de cuenta en claro (solo `accountRef` seudónimo).

**Ampliación.** O13 (0014) incorporó notas, etiquetas, valoración, ubicaciones, series, perfil con avatar, imágenes privadas, revisión bibliográfica y perfiles CSV; el staging CSV vive en `import_sessions`/`import_session_rows` (paso `staging`). O14 (0015) incorporó los ciclos y entradas de lectura (U-PRO-02) y los préstamos (U-PRO-04) al paso `product`; un préstamo guarda solo el alias que escribe la persona, sin datos de contacto, y se retira con la cuenta del dueño. Cada tabla o bucket privado nuevo entra en la misma migración que lo crea: un paso en `account_deletion_step_tables`, su fila aquí y en `ACCOUNT_DATA_INVENTORY`, y la política RESTRICTIVE de cuenta activa si tiene escritura de cliente. Una referencia a otra cuenta (p. ej., un préstamo a un contacto) nunca se borra en cascada desde la cuenta eliminada: sus FK incluyen al dueño.

## Plazos

| Qué | Plazo | Motivo |
| --- | --- | --- |
| Datos de la cuenta | Hasta terminar el worker (local: un ciclo; en despliegue, según el scheduler de F4). | Mientras tanto la cuenta no admite escrituras ni trabajos. |
| Marca técnica `completed` (`purge_after`) | **90 días** desde que termina. | Debe superar la copia administrativa más antigua anterior a la supresión (35 días). `account:deletions:local --purge-marks` retira las vencidas. |
| Registro privado de supresiones (`.biblib/state/<perfil>-suppressions.json`) | El mismo `purge_after` de cada marca. | Copia de las marcas fuera de la base para aplicarlas a un respaldo restaurado aunque la base se haya reconstruido. |
| Copias administrativas (U-OPS-02) | 7 diarias y 4 semanales: **35 días** como máximo. Un respaldo previo a una migración se conserva hasta aceptar esa versión. | Recuperación ante desastres. No se reescriben para quitar una cuenta. |
| Sesiones de restauración sin publicar | 7 días. | Staging propio de U-DAT-04. |
| Trabajos expirados | 30 días. | Resumen operativo de U-DAT-03. |

Si un respaldo debe conservarse más de 35 días (por ejemplo, el previo a una migración aún no aceptada), se amplía la marca de las cuentas suprimidas después de ese respaldo hasta que caduque, o se destruye el respaldo; nunca se restaura sin aplicar sus supresiones.

## Eliminar la cuenta frente a las copias administrativas

Eliminar la cuenta borra en el momento la base, Storage y la identidad del entorno en servicio. **No** reescribe las copias administrativas históricas: cada copia expira según su política y su contenido deja de existir cuando caduca. Mientras tanto, la marca técnica impide que una restauración devuelva la cuenta: `db:restore:local` aplica, antes de terminar y de abrir el destino, todas las supresiones conocidas (las marcas restauradas y el registro privado del perfil, más el que se indique con `--suppressions`): borra la identidad con GoTrue (su cascada retira las filas con dueño), retira sus objetos de Storage y deja la marca `completed`. `db:restore:verify` comprueba que ninguna cuenta suprimida tiene identidad, filas ni objetos, y compara las tablas afectadas contra los hechos que registra el restore tras aplicar la supresión.

La persona ve esta diferencia antes de confirmar. La copia **offline** de solo lectura (U-EXP-08) no existe todavía: cuando exista, un dispositivo sin red no se entera de la revocación hasta reconectar, y entonces se purga; este límite se informará en la misma pantalla.

## Errores, reintento y recuperación

- Estados internos: `pending` → `running` (lease) → `waiting_retry` (fallo temporal) → `failed` (revisión de operación) → `completed`. La persona solo ve «registrada», «en curso», «con retraso, se reintentará», «necesita revisión» o «eliminada», sin códigos ni contadores.
- Códigos técnicos de operación: `SESSIONS_UNAVAILABLE`, `STORAGE_UNAVAILABLE`, `STORAGE_PENDING`, `DATABASE_UNAVAILABLE`, `STEP_INCOMPLETE`, `AUTH_UNAVAILABLE`, `RESIDUE_FOUND`, `UNEXPECTED`. Consulta: `select state, step, error_code, attempts, next_attempt_at from biblib.account_deletions where state <> 'completed'` (sin datos de biblioteca).
- Un worker vencido o reemplazado recibe BD003 y se detiene; solo borra, así que nunca recrea datos. Un trabajo de importación o portadas que estaba en vuelo queda expirado al solicitar, y sus renovaciones y subidas fallan por cuenta inactiva.
- Recuperar es **reintentar la limpieza**, nunca «deshacer» una supresión: una eliminación terminada no se revierte, ni restaurando un respaldo.

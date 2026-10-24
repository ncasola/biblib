# U-DAT-10 · Almacenamiento opcional y seguro de portadas (O11)

**Fecha:** 24 de octubre de 2026 · **Rama:** `u-dat-10` (worktree `u-inf-03`, desde `1ca8433`) · **Perfil:** `scratch` (`biblib-scratch`, 55340–55349, app 3149) · **Especificación:** [02 · U-DAT-10](../../../../spec-pendientes/02-datos-importacion-y-catalogacion.md#u-dat-10--almacenamiento-opcional-y-seguro-de-portadas) · **Operación:** [operacion.md](../../../../operacion.md#portadas-privadas--u-dat-10-o11) · **Seguridad:** [seguridad.md](../../../../seguridad.md#portadas-privadas-u-dat-10) · **Formatos:** [formatos.md](../../../../formatos.md#portadas-privadas-u-dat-10) · **Recuperación:** [recuperacion.md](../../../../recuperacion.md#portadas-privadas-u-dat-10)

## Qué se entrega

| Pieza | Archivos |
| --- | --- |
| `sharp` como decodificador (decisión de Néstor, 24-10-2026) | `pnpm-workspace.yaml` (`allowBuilds: sharp: true`, con el comentario de la decisión), `package.json` (`sharp@0.35.5` directa, bajo el override `>=0.35.5`), lockfile. Compila y `sharp.versions` responde ([00](00-sharp.txt)). `next/image` funciona en el build y el smoke; sigue con `unoptimized: true` (ver «Decisiones»). |
| Migración `0009_cover_assets` | `lib/db/schema.ts`, `drizzle/0009_cover_assets.sql`, journal y snapshot. Incluye: <ul><li>`cover_assets` con RLS de lectura propia y `books.cover_asset_id` con FK de propietario y guarda `BA001`;</li><li>`library_jobs` con `cover_asset` y la fase `asset`;</li><li>las funciones `cover_asset_*`, `cover_object_access` y `cover_storage_install`;</li><li>el bucket privado `biblib-covers` y tres políticas de `storage.objects`;</li><li>`library_job_claim`, que no reclama adquisiciones sin sesión;</li><li>versiones anteriores que retienen `cover_asset_id`.</li></ul> Nada en `supabase/migrations`. |
| Manifest de objetos | `scripts/db/objects-manifest.mjs` (sección `storage`, variantes de restricciones) y `tests/fixtures/migrations/objects-0009.json` (metadatos reales desde vacío). |
| Primitivas | `lib/assets/contracts.ts`, `fetch-policy.ts`, `image-validation.ts`, `repository.ts` y `server.ts` (cableado). |
| Trabajo de adquisición | `lib/jobs/cover-assets.ts`, más `worker.ts`, `contracts.ts` y `repository.ts` de U-DAT-03. |
| Acciones y ruta | `app/actions/book-cover-assets.ts` y `app/api/covers/[assetId]/route.ts`. |
| Interfaz | `components/book-cover-assets.tsx` en la ficha: «Subir portada propia», «Guardar copia privada» (solo si la política lo permite), «Cancelar copia» y «Usar la portada original». `displayCover` en tabla, tarjetas, ficha y 3D. |
| Versiones anteriores | `lib/library-snapshots.ts`: restaurar una versión recupera la portada privada si sigue utilizable. |
| Respaldo y restore | `scripts/lib/backup-db.mjs`, `scripts/db/backup-local.mjs`, `restore-local.mjs` y `restore-verify.mjs`. |
| Purga | `scripts/jobs/purge-cover-assets.mjs` (`pnpm assets:purge:local`, fuera de Next). |
| Pruebas | <ul><li>`tests/cover-assets.test.ts`;</li><li>`tests/db/cover-assets.sql` y el sustituto de Storage en `tests/db/bootstrap.sql`;</li><li>`tests/scripts/cover-assets.test.mjs` y el drift de 0009 en `migrations.test.mjs`;</li><li>el grupo `tests/integration/assets/**` (`pnpm test:integration:assets`, también en SUITES).</li></ul> |

## Aceptación de 02 y dónde se demuestra

Grupo `assets` en scratch: [37](37-integracion-assets-scratch.txt), **10/10**. Usa Postgres, GoTrue, Storage y la app compilada reales y sesiones A/B reales. La red siempre es simulada: DNS y transporte se inyectan en el ejecutor compilado.

| Criterio | Prueba | Resultado |
| --- | --- | --- |
| A adjunta y lee su portada; B no la obtiene ni firma su ruta, tampoco por Storage; conocer el UUID no basta | «A sube y adjunta…»: <ul><li>subida multipart por la acción real, adjunto con la versión y lectura con sha256, WebP sin EXIF y `private, no-store`;</li><li>B: 404 (igual que un UUID inexistente). Con su JWT contra Storage no puede descargar, firmar, listar, sustituir ni retirar;</li><li>anon: 401 en la app y sin acceso en Storage;</li><li>B tampoco adjunta el asset a su ficha ni lo ve por SQL con sus claims;</li><li>ni A puede borrar o sustituir el objeto registrado.</li></ul> | ✔ |
| Google o `rehostCover=false`: ni fetch ni objeto, ni con un trabajo antiguo ni con un cliente manipulado | «Google Books o una política sin rehostCover…»: <ul><li>la acción rechaza `google-books`, `open-library` y `bne` con `ASSET_REJECTED` sin crear el trabajo;</li><li>la función SQL rechaza una clave de Google (`CHECK`);</li><li>un trabajo antiguo de Open Library termina `RIGHTS_DENIED` con 0 descargas, sin objeto y con la cuarentena descartada.</li></ul> | ✔ |
| Una política que permite rehosting pero deniega backup u offline conserva esas diferencias | Unitaria de `coverAssetRights` y `classifyCoverAssets`: el respaldo solo incluye proveedores con `backupAsset`, en una lista alineada con `rights.ts`. | ✔ |
| Red simulada: redirección a localhost, respuesta lenta, tamaño mentido, DNS cambiante, MIME falso, SVG y dimensiones excesivas | «red simulada…», con nueve casos más la lentitud: <ul><li>redirección (302 a `127.0.0.1`);</li><li>DNS privado;</li><li>rebinding con 169.254.169.254;</li><li>`::ffff:127.0.0.1`;</li><li>`Content-Length` mentido (se corta en 5 MiB);</li><li>HTML como JPEG;</li><li>SVG declarado y SVG como PNG;</li><li>12 MP;</li><li>respuesta lenta: `waiting_retry` sin «no hay portada».</li></ul> En todos: una sola resolución, ninguna conexión con destinos bloqueados, sin objeto y la ficha intacta. Las unitarias cubren además puertos, esquemas, hosts, IPv6 especiales y 3xx/4xx/5xx. | ✔ |
| Una edición concurrente o una cancelación impiden adjuntar el resultado tardío | «una edición concurrente o una cancelación…»: <ul><li>con la ficha editada antes de registrar: `succeeded` con `CHANGED`, sin adjuntar;</li><li>cancelado tras subir: no se registra, el intento ya no puede volver a subir (Storage exige el trabajo en ejecución) y la purga lo retira.</li></ul> | ✔ |
| Repetir no duplica | Misma clave: el mismo trabajo y asset; otra entrada: conflicto. La misma imagen por otra solicitud o subida se deduplica sin otro objeto. B con la misma imagen tiene su propio asset. | ✔ |
| Matar el trabajador tras subir y antes de registrar deja un objeto purgable, no un enlace roto | «repetir no duplica y matar…», en un proceso hijo que sale con 137 tras subir: <ul><li>el objeto existe, el asset sigue en cuarentena, la ficha no cambia y la ruta da 404;</li><li>con el lease vencido, ese intento ya no está autorizado a subir;</li><li>el siguiente trabajador registra con su propio fencing y adjunta;</li><li>la purga retira el huérfano y conserva el registrado.</li></ul> | ✔ |
| Cuotas, referencias desde versiones anteriores, expiración de licencia, caducidad y cuenta bloqueada | «versiones anteriores…» y «cuotas y cuenta bloqueada…»: <ul><li>una versión anterior retiene el asset ante la purga, y el periodo de gracia también;</li><li>una licencia vencida no se sirve y la purga devuelve la URL original;</li><li>una subida a medias caduca y se purga;</li><li>500 imágenes dan `LIMIT_EXCEEDED` a A pero no a B;</li><li>bloquear la cuenta a mitad de una adquisición la expira sin registrar, y después no se sube ni por la acción ni directamente a Storage.</li></ul> | ✔ |
| Restaurar revalida políticas en cuarentena | «tras un restore, la ruta revalida…»: B no lo obtiene; A sí y pasa a `ready`; una copia de proveedor sin derecho vigente se descarta y la ficha recupera su URL. El ensayo administrativo, más abajo. | ✔ |

Además, `pnpm test:db` ([34](34-test-db.txt)) cubre lo mismo en SQL con cuentas G/H: políticas de Storage por intento, registro solo con objeto presente y del tamaño declarado, guarda `BA001`, permisos de cliente, lease y fencing, purga, versión anterior, restore, cuenta bloqueada y cuota.

## Migración, respaldo y medición

| Paso | Resultado |
| --- | --- |
| Desde vacío: `db:reset:local --dry-run/--apply --discard-local-data` ([01](01-reset-dry-run.txt), [02](02-reset-apply.txt), [03](03-status-desde-vacio.txt)) | 0000→0009, seed y verify; `up-to-date`, **377 comprobaciones** (incluidas las del bucket y las políticas de Storage). |
| Actualización con datos: restore del respaldo de DAT-04 con head 0008 ([04](04-restore-respaldo-0008.txt), [05](05-status-0008.txt)), plan y migrate ([07](07-plan-0009.txt), [08](08-migrate-0009.txt), [09](09-status-tras-migrar.txt)) | 0008 → 0009 sobre los datos restaurados, sin drift. [06](06-restore-verify-0008.txt) falla en `objects.facts`: ese respaldo de DAT-04 selló `saved_book_views_name_check` antes de la normalización de U-EXP-03 (ver «Hallazgos»); no es de esta unidad. |
| Ensayo con una portada privada ([10](10-portada-de-ensayo.txt)–[18](18-retirar-portada-de-ensayo.txt), script [portada-de-ensayo.mjs](portada-de-ensayo.mjs)) | Se sube una portada con la sesión real de A y se adjunta. Después: <ul><li>`db:backup:local` con manifiesto `assets` y el objeto con su sha256;</li><li>reset;</li><li>`db:restore:local`: políticas reinstaladas y 1 portada en revisión;</li><li>`db:restore:verify` **superado**, con `assets.manifest`, `storage.objects` 2/2 y hechos de catálogo idénticos;</li><li>el asset queda `restored`, citado por su ficha y legible con la sesión de A en Storage;</li><li>recibo reemitido y portada retirada.</li></ul> |
| `db:status:local` final ([39](39-status-final.txt)) | `up-to-date`, 377 comprobaciones. |
| Presupuesto de decodificación ([medición](medicion-decodificacion.json)) | sharp 0.35.5 / libvips 8.18.7. Portada 600×900: 69 ms; PNG 1600×2400: 273 ms; JPEG de 10 MP: 178 ms; WebP de 10 MP: 310 ms. Plazo: 5 s. |

## Validación

| Comando | Resultado |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` ([30](30-lint.txt), [31](31-typecheck.txt)) | Sin errores. |
| `pnpm test` ([32](32-test.txt)) | 348/348. |
| `pnpm test:scripts`, completo y sin `BIBLIB_SKIP_STACK_TESTS` ([33](33-test-scripts.txt)) | **253/253**, incluida la suite `[stack]` de promoción, que DAT-04 había dejado fallando. |
| `pnpm test:db` ([34](34-test-db.txt)) | Todas las fases, incluida `cover-assets.sql`. |
| `pnpm build` ([35](35-build.txt)) / `pnpm test:smoke` ([36](36-test-smoke.txt)) | Correcto (`ƒ /api/covers/[assetId]`) / `ok: true`. |
| `pnpm test:integration:assets --profile scratch` ([37](37-integracion-assets-scratch.txt)) | 10/10. |
| Otros grupos en scratch tras los cambios (registros en `.biblib/integration/dat10-g-*.log`) | jobs 19/19, snapshots 10/10, restore 11/11, security 23/23 (con la lista de funciones `SECURITY DEFINER` ampliada) y views 5/5. |
| `pnpm security:headers:local --profile scratch` ([38](38-cabeceras.txt)) | 37/37, incluida `/api/covers/:libroA`. |
| HolaERP ([antes](holaerp-antes.txt), [después](holaerp-despues.txt)) | Mismos contenedores, estados, volúmenes y redes. Solo cambia la antigüedad de los dos contenedores que ya estaban parados. |

No se ejecutaron `pnpm test:integration:local` ni el E2E: el perfil `test` es del coordinador en esta ola. El grupo `assets` ya está en SUITES y admite `--profile test`.

## Hallazgos y decisiones

- **Derechos (decisión del coordinador):** `rights.ts` no concede `rehostCover` a ningún proveedor y no se ha tocado. La adquisición remota está implementada y probada con una política inyectada solo en pruebas. En la app solo opera «Subir portada propia», y «Guardar copia privada» queda oculto hasta que una política lo permita (procedimiento en operación).
- **Storage sin credencial administrativa en Next (U-OPS-04).**
  - Leer, subir y retirar usan la sesión del dueño; las políticas de `storage.objects` son la segunda barrera.
  - La subida exige el intento autorizado: el token de la subida o el fencing del trabajo con el lease vigente. Así, un trabajador con un lease antiguo no puede subir, porque se lo impide Storage, no solo la aplicación.
  - Por eso la adquisición se ejecuta en peticiones del dueño (la acción y la consulta de estado), y el ejecutor sin sesión no reclama trabajos `cover_asset`.
  - La purga global es el script administrativo `pnpm assets:purge:local`, fuera de Next.
- **`next/image`:** se mantiene `images.unoptimized: true`. Las portadas privadas ya llegan reencodificadas, y el optimizador pediría la ruta autenticada sin cookies y traería al servidor las imágenes externas. Con `sharp` compilado, activarlo es un cambio aparte en `next.config.mjs`, que no es de esta unidad.
- **Restore administrativo:** `drop schema biblib cascade` retira las políticas de Storage que dependen de funciones de `biblib`. Se reinstalan con la misma función de 0009 en el restore y en el ensayo de promoción. Los assets restaurados quedan en revisión y la ruta los revalida con el dueño. `restore-verify` compara la tabla por claves y los assets por su manifiesto.
- **Cambios mínimos en archivos de otras unidades**, cada uno en su propio commit:
  - `scripts/test-database.mjs` y `scripts/smoke-app.mjs`: aplican 0009;
  - `tests/db/bootstrap.sql`: sustituto de Storage;
  - `tests/integration/run.mjs`: SUITES;
  - `scripts/security/headers-matrix.mjs`: la ruta nueva;
  - `tests/integration/security/exposicion.test.mjs`: funciones permitidas;
  - `tests/scripts/promotion-harness.mjs`: Storage idempotente y reinstalación tras el volcado;
  - `scripts/db/remote-preflight.mjs`: la huella de plataforma excluye las políticas `biblib_*` del dominio;
  - `lib/domain-errors.ts`: `ASSET_REJECTED`, 422;
  - los componentes de presentación de la portada (`displayCover`).
- **Pendiente ajeno:** el respaldo de DAT-04 `20261024T103626Z-scratch-aaa2fa` selló `saved_book_views_name_check` en forma plana. La normalización de `objectFacts` de U-EXP-03 la convierte en anidada, así que `db:restore:verify` de ese respaldo concreto falla en `objects.facts`. Los respaldos nuevos son coherentes: este ensayo lo supera.
- **Fuera de alcance:**
  - el borrado integral de cuenta (U-OPS-03): filas y objetos de `cover_assets`; el bloqueo ya impide escribir;
  - el scheduler de la purga (F4);
  - el traslado de la referencia a la edición o el ejemplar (U-DAT-06);
  - la reutilización para el avatar (otra unidad);
  - activar un proveedor con `rehostCover` (requiere revisar su licencia).

## Recursos Docker al terminar

`pnpm db:local:down --profile scratch` ([40](40-down-scratch.txt)): los contenedores de scratch quedan parados y retirados. Quedan, propios del perfil, la red `biblib-scratch-network` y los volúmenes `supabase_db_biblib-scratch` y `supabase_storage_biblib-scratch`. No se tocó ningún recurso de HolaERP ni del perfil `test`.

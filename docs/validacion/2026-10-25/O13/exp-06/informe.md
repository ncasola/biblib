# U-EXP-06 · Avatar personal separado de Google

Fecha: 25 de octubre de 2026. Rama: `u-exp-06`, hija de `feature/spec-pendientes`. Sin stack Supabase propio, sin migraciones, sin cambios en OAuth, sin push ni PR.

## Entrega

- `lib/media/server.ts`: helper compartido para avatar, ubicación y evidencia. Firmas: `beginUpload(kind) → { assetId, storageKey, kind }`; `upload(asset, bytes, declaredType?) → NormalizedImage`; `register(assetId, { sha256, bytes, width, height })`; `discard(assetId)`; `signedUrl(assetId)` (60 s); `read(assetId)` (Blob). El dueño sale de la sesión y se valida con RLS; la subida vuelve a leer la reserva para rechazar una ruta o tipo manipulados. Storage usa la sesión propia y nunca sobrescribe.
- `lib/media/image-validation.ts`: reutiliza los controles de portadas de U-DAT-10 (firma, tipo, marcado, datos añadidos, animación, límites de decodificación). JPEG/PNG/WebP entran; sale siempre WebP sin EXIF, GPS, XMP ni ICC. Límites del contrato 0014 por tipo, sin recortar originales fuera de límite silenciosamente.
- `app/actions/profile.ts`: crea el perfil si falta, compara versión y publica solo después de registrar la imagen. Un fallo de preparación conserva la referencia anterior; un conflicto limpia solo el nuevo; la limpieza posterior no invalida un guardado confirmado. La respuesta confirmada actualiza el contexto sin una segunda petición que pueda presentar el guardado como fallido.
- `GET /api/media/[id]`: lectura autenticada con `private, no-store`, `Vary: Cookie`, MIME fijo, nosniff, CORP y CSP de imagen. No admite rutas de Storage desde el cliente.
- Editor detrás de `BIBLIB_PRIVATE_MEDIA_UPLOADS=1`, apagado por defecto y permitido expresamente por el wrapper de Next. Carga, previsualización local, recorte cuadrado desplazable, límites visibles, reemplazo y retirada. Un fallo de capacidad/servicio oculta el editor; el fallback conserva Google/iniciales sin borrar datos. Correo informativo.
- Perfil, cabecera de escritorio y menú móvil comparten `UserAvatar`: propio → Google → iniciales, con nombre alternativo accesible en el perfil y avatar decorativo en enlaces/botones que ya tienen nombre accesible.
- `pnpm media:purge:local`: candidatos → confirmación bajo bloqueo → Storage, con el patrón administrativo de portadas. Reintenta objetos huérfanos si falla Storage; respeta referencias y versiones anteriores. Sección añadida al final de `docs/operacion.md`.

## Comprobaciones ejecutadas

| Comando | Resultado | Evidencia |
| --- | --- | --- |
| `pnpm lint` | Exit 0 | `lint.log` |
| `pnpm typecheck` | Exit 0 | `typecheck.log` |
| `pnpm test` | 395/395, exit 0 | `test.log` |
| `pnpm test:scripts` | Exit 0; 266 pruebas, 264 superadas y 2 omitidas por requerir scratch acreditado | `test-scripts.log` |
| `pnpm test:db` | Exit 0, migraciones hasta 0014 y sus pruebas | `test-db.log` |
| `pnpm build` | Exit 0, compilación final con Turbopack | `build.log` |
| `pnpm test:smoke --artifacts=docs/validacion/2026-10-25/O13/exp-06/smoke` | Exit 0; 13 recorridos existentes, Auth simulado y Postgres aislado | `smoke.log`, `smoke/report.json` y capturas |
| `node --test tests/scripts/media-purge.test.mjs` | 4/4, exit 0 | `media-scripts.log` |
| `node --check` de runner/grupo media y purga | Exit 0 | Verificación de sintaxis, sin stack |
| `pnpm exec playwright test tests/e2e/flujos/avatar.spec.ts --list` | Exit 0; reconoce el recorrido y sus dependencias en Chromium, Firefox y WebKit | `e2e-collection.log` (solo colección, no ejecución) |

Las ocho pruebas nuevas de `tests/media.test.ts` comprueban los tres formatos válidos, SVG/HTML/GIF/tipo falso/truncados/datos añadidos rechazados, dimensiones/bytes por tipo, EXIF/GPS eliminados y los puntos de publicación y limpieza ante fallos. Las cuatro de scripts comprueban bandera estricta, perfiles acotados, argumentos, confirmación de candidatos y fallo reintentable de Storage.

Incidencias conservadas: los dos primeros `test:db` fallaron en `tests/db/catalogue.sql:9`, una tolerancia preexistente de 990–1000 ms que se incumplió bajo carga concurrente; sin compilaciones concurrentes pasó todo el grupo. No se modificaron esas pruebas ni las migraciones. Logs: `test-db-first.log` y `test-db-second.log`.

La primera ejecución de `test:scripts` detectó correctamente que faltaba inventariar la ruta nueva `/api/media/[id]` en la matriz de seguridad. Se solicitó al coordinador el añadido mínimo en `scripts/security/headers-matrix.mjs` y su nota correspondiente en `docs/seguridad.md`, fuera del scope inicial (pregunta `msg_1583ef225bc0`); tras agotar sus 600000 ms sin respuesta se aplicó literalmente la regla común 9 de la tarea: cambio mínimo conservador, aislado en `bd56439`. Solo añade una petición API al inventario y documenta la ruta/cabeceras, sin cambiar permisos, políticas ni infraestructura. `test-scripts-first.log` y `media-security-before.log` conservan la detección; `media-security.log` acredita el grupo enfocado corregido.

En la segunda ejecución de scripts hice un commit de la prueba E2E mientras corría la promoción; su guarda rechazó correctamente el plan porque había cambiado el commit del checkout (`test-scripts-second.log`). La ejecución final mantuvo el commit fijo y pasó completa. Las dos omisiones finales corresponden a ensayos de reset/fixtures que exigen un perfil scratch acreditado; no se levantó para forzarlos.

## Pendiente del coordinador

- Ejecutar `pnpm test:integration:media --profile test` (o `scratch` propio autorizado), registrado también en `SUITES`: subida/reemplazo/retirada reales por Server Actions, persistencia, metadata intacta, A/B, ruta manipulada, conflicto de versión, red de Storage simulada sin parar servicios, purga/reintento y cuenta inactiva. El runner habilita la capacidad únicamente en su proceso y usa cuentas desechables del harness de producto.
- Ejecutar `tests/e2e/flujos/avatar.spec.ts` con el runner E2E: previsualización, recorte por teclado, persistencia, foto de cabecera, red caída que mantiene el anterior, menú móvil y retirada. El runner habilita la capacidad; la prueba protege un avatar previo ajeno al ensayo y limpia en `finally`.
- Conciliar los añadidos finales de scripts en `package.json`, `SUITES` y los entornos de los runners con las otras unidades O13. U-PRO-03 puede consumir directamente las firmas del helper indicadas arriba.

No se ejecutaron los nuevos recorridos con GoTrue/Storage ni el E2E real: corresponden al coordinador según la asignación «sin stack». El smoke valida los recorridos existentes y no sustituye esas pruebas de avatar. No se aplicó esquema ni se amplió v2/snapshots/restore/eliminación porque ya cubre estas referencias el contrato 0014.

## Recursos

No se levantó ni modificó ningún perfil Supabase, red o volumen persistente. Los contenedores temporales de `test:db`, ensayos aislados de scripts y smoke se retiraron con sus propias limpiezas; no queda un contenedor de esos ensayos en marcha. Los recursos preexistentes `biblib-test`, red `biblib-scratch-network`, volúmenes `supabase_db_biblib-scratch`/`supabase_storage_biblib-scratch` y todos los recursos ajenos (incluido HolaERP) se dejaron intactos. No hay stack ni volúmenes asignados a este worktree que liberar.

# U-DAT-03 · Trabajos persistentes de importación y enriquecimiento (O09)

**Fecha:** 23 de octubre de 2026 · **Rama:** `u-dat-03` (worktree `u-inf-03`) · **Perfil:** `scratch` (`biblib-scratch`, 55340–55349, app 3149) · **Especificación:** [02 · U-DAT-03](../../../../spec-pendientes/02-datos-importacion-y-catalogacion.md#u-dat-03--trabajos-persistentes-de-importación-y-enriquecimiento) · **Operación:** [operacion.md](../../../../operacion.md#trabajos-persistentes-de-importación-y-portadas--u-dat-03)

## Qué se entrega

| Pieza | Archivos |
| --- | --- |
| Migración `0005_library_jobs` | `lib/db/schema.ts`, `drizzle/0005_library_jobs.sql`, journal y snapshot. Incluye `library_jobs`, `library_job_items`, `account_lifecycle`, la secuencia de fencing y 7 funciones `SECURITY DEFINER` con `search_path` fijo. |
| Manifest de objetos | `scripts/db/objects-manifest.mjs`, `tests/fixtures/migrations/objects-0005.json` (metadatos reales tras 0005) |
| Contrato, repositorio y ejecutor | `lib/jobs/{contracts,repository,worker,runner-auth,server}.ts` |
| Publicador base | `lib/import-publisher.ts` (extraído de la confirmación de U-DAT-01) |
| Acciones | `app/actions/library-jobs.ts`; `confirmImportAction` publica mediante un trabajo y `recoverMissingCoversAction` inicia uno de portadas |
| Errores | `JOB_CONFLICT` (409) y `JOB_EXPIRED` (410) en `lib/domain-errors.ts` |
| Entrada interna y runner | `app/api/internal/jobs/run/route.ts`, `scripts/jobs/run-local.mjs` (`pnpm jobs:run:local`) |
| Interfaz | `components/library-job-progress.tsx`, `cover-recovery-job-panel.tsx`, `import-job-panel.tsx` y `app/settings/page.tsx`. Se retira `components/cover-recovery-panel.tsx`, el panel antiguo guiado por la página. |
| Pruebas | `tests/library-jobs.test.ts`, `tests/db/jobs.sql`, `tests/integration/jobs/**` (`pnpm test:integration:jobs`) y `tests/scripts/jobs-runner.test.mjs` |

## Aceptación de 02 y dónde se demuestra

| Criterio | Prueba | Resultado |
| --- | --- | --- |
| Crear, recargar y continuar con Auth local real conserva trabajo y cantidades | `integration/jobs/acciones` «crear, recargar y continuar». Una sesión GoTrue pausa; otra sesión nueva lista el trabajo con las mismas cantidades, lo reanuda y el servidor lo termina. | ✔ |
| Dos trabajadores sobre el mismo elemento: solo uno confirma | `trabajadores` «dos trabajadores…». El primero se para tras consultar más allá de su lease; el segundo reclama con un fencing mayor y confirma; el primero acaba en `lease_lost`. | ✔ |
| Matar el primero tras el fetch y antes de persistir: sin duplicados | `trabajadores` «matar el trabajador tras la consulta…» (proceso con salida 137) e `importacion` «matar la publicación antes del commit». Nada queda confirmado y el segundo trabajador publica una sola vez: 3 libros y 1 operación. | ✔ |
| Matar tras el commit con la respuesta perdida: consultar devuelve el resultado | `importacion` «matar tras el commit…». `getLibraryJobAction` devuelve el resultado publicado y `confirmImportAction` con la misma clave devuelve el mismo `operationId` con `replayed: true`. | ✔ |
| Expiración del lease; el lease antiguo no escribe (fencing) | `trabajadores` «lease vencido…» y `tests/db/jobs.sql`. Ni el token ajeno, ni el lease vencido, ni la renovación tardía, ni el trabajador antiguo tras otra reclamación pasan el fencing. | ✔ |
| Cancelar en cada fase | `importacion`: antes de publicar (`before`, nada aplicado), durante la publicación atómica (espera al commit y responde `after`) y en la fase de portadas (la importación se conserva). `trabajadores`: durante las portadas el paso en curso no escribe. `jobs.sql`: estado en pausa y cancelado. | ✔ |
| HTTP 429/503/JSON roto | `trabajadores` «429…» y «503 y JSON roto…», con el fetch simulado tras el gateway real en modo lote. El 429 aplica una espera compartida, no consume intentos y no se trata como «sin portada»; el 503 y el JSON roto se reintentan con backoff. Al agotar los intentos, el resultado es `partially_succeeded`. La reanudación tras la espera se simula adelantando `next_attempt_at`. | ✔ |
| A no usa IDs de B ni invoca la ruta interna | `acciones` «A no usa IDs de B» (consultar, pausar, reanudar, cancelar y confirmar una vista previa de B devuelven `NOT_FOUND`; B no cambia) y «la entrada interna…» (sesión, clave anónima, JWT de A con `owner` en el cuerpo y token alterado devuelven 401; el token del ejecutor reclama por fila). | ✔ |
| Cuenta bloqueada: el trabajador antiguo no escribe | `trabajadores` «cuenta bloqueada…» con `account_set_state(A, 'blocked')` en mitad de un paso: el trabajo pasa a `expired`/`ACCOUNT_INACTIVE` y nadie lo reclama. `jobs.sql` incluye el borrado de cuenta en cascada. | ✔ |
| Red siempre simulada o fixture | Procesos con fetch simulado (solo ISBN sintéticos `979-0-0003…`) y app en `BIBLIB_CATALOGUE_MODE=fixture`; las importaciones usan identificadores manuales. Los libros del seed no cambian (comprobado). | ✔ |
| Unitarias de estados y backoff | `tests/library-jobs.test.ts`: transiciones, control, versión, estado tras un paso, backoff con jitter, `Retry-After`, clasificación y el paso de portadas con un repositorio en memoria. | ✔ |

## Comandos y resultados (salida completa en esta carpeta)

| Paso | Resultado |
| --- | --- |
| `db:status` → `db:plan` → `db:migrate` 0004→0005 en scratch ([01](01-status-antes.txt)–[04](04-status-despues.txt)) | Aplicada. La verificación posterior marcó 3 políticas no declaradas porque el manifest aún no incluía 0005. Se declaró a continuación, sin reaplicar: [05](05-status-con-manifest.txt), 195 comprobaciones sin drift. |
| Desde vacío: `db:reset:local --dry-run/--apply --discard-local-data` y `db:local:bootstrap` ([06](06-reset-dry-run.txt)–[09](09-status-desde-vacio.txt)) | 0000→0005, seed y verify correctos; `up-to-date` con 195 comprobaciones. |
| `pnpm test:integration:jobs --profile scratch` ([10](10-integracion-jobs-scratch.txt)) | **19/19** sobre el scratch reconstruido (segunda ejecución; la primera, 18/19, llevó a corregir el orden de una prueba). |
| `pnpm lint` / `pnpm typecheck` ([11](11-lint.txt), [12](12-typecheck.txt)) | Correctos |
| `pnpm test` ([13](13-test.txt)) | 245/245 |
| `pnpm test:db` ([14](14-test-db.txt)) | Correcto, incluido `tests/db/jobs.sql` |
| `pnpm test:scripts` ([15](15-test-scripts.txt)) | 193/193, incluidas las pruebas `[stack]` sobre scratch |
| `pnpm test:smoke` (Chrome real, Auth simulado) | 12/12; importación por trabajo y portadas por trabajo ([captura](smoke-portadas-trabajo.png)) |
| `db:status:local` final ([16](16-status-final.txt)) | Sin drift |
| HolaERP ([17](17-holaerp.txt)) | Mismos contenedores, estado y puertos; arrancados antes de la sesión |

`pnpm test:integration:local` no se ejecutó en esta unidad: solo admite el perfil `test`, que pertenece al worktree `u-qa-01` y estaba en uso por U-QA-03. Por acuerdo con la coordinación, `jobs` se añade a sus `SUITES` y la coordinación lo ejecuta al integrar.

## Decisiones

- **Ejecutor sin cola externa.** Postgres más `after()` del servidor Next, la entrada interna protegida y `jobs:run:local`. Sin scheduler, un trabajo avanza mientras alguien consulta o llama al ejecutor; el estado confirmado no se pierde. El scheduler de despliegue queda para F4.
- **Permisos mínimos.** El cliente solo lee sus filas y crea o controla con `auth.uid()`. Reclamar, renovar, cercar y cambiar el ciclo de vida no tienen EXECUTE para `authenticated`/`anon`. Cada escritura de dominio del ejecutor usa RLS con el dueño de la fila reclamada.
- **Gateway en modo lote sin tocar U-BIB.** `lib/jobs/server.ts` construye el mismo orquestador con un `execute` que fija `purpose: "batch"`, sobre la misma conexión de coordinación de `server.ts`.
- **Token del ejecutor.** `BIBLIB_JOBS_RUNNER_SECRET`, o un HMAC derivado de `SUPABASE_DB_URL`, porque los wrappers de U-INF-02 no admiten variables nuevas y quien tiene esa URL ya tiene acceso total.
- **`auth.users` en el schema.** Se declara localmente (equivalente a `drizzle-orm/supabase`) porque compilar el schema en las pruebas NodeNext mezclaba tipos CJS/ESM. `drizzle-kit generate` confirma que no hay cambios de schema.

## Fuera de alcance, pendientes y conciliación

- **U-FIX-01:** `prepareImportAction` sigue enriqueciendo portadas con `enrichImportedBookCovers` (fetch directo, que U-FIX-01 está cambiando). La recuperación de portadas ya no lo usa: va por el servicio bibliográfico desde el trabajo. No se tocaron `lib/library-import.ts` ni `lib/api-client.ts`.
- **`startImportJobAction`:** ninguna pantalla la usa (Ajustes confirma con `confirmImportAction`, que comparte `startImportJob`), así que no está en el manifiesto de acciones del build y no se prueba por HTTP.
- **Archivos ajenos con cambio mínimo:**
  - `tests/integration/run.mjs`: `jobs` en `SUITES`, commit aislado y acordado.
  - `scripts/smoke-app.mjs`: aplica 0004 y 0005, commit aislado.
  - `scripts/test-database.mjs`: añade 0005 y `jobs.sql`.
  - `tests/scripts/migrations.test.mjs` y `promotion-stack.test.mjs`: la migración de fallo se crea tras el head vigente en lugar de fijar 0005, y los hechos del head pasan a `objects-0005.json`.
- **U-OPS-03:** completará la solicitud y la limpieza de eliminación de cuenta; aquí solo existe el estado local `blocked` con su guarda.
- **Recursos Docker al terminar:** `db:local:down --profile scratch` conserva la red `biblib-scratch-network` y los volúmenes `supabase_db_biblib-scratch` y `supabase_storage_biblib-scratch`.

# U-DAT-01 · Confirmación vinculada a una revisión de la colección (O07)

Rama `u-dat-01` (desde `feature/spec-pendientes`), worktree `u-qa-01`, perfil `test` (`biblib-test`, 55330–55339). Fecha: 23-10-2026. Hallazgos: BE-02, IMP-01, UX-04. La operación detallada está en [operacion.md § U-DAT-01](../../../../operacion.md#revisión-de-colección-e-importación-en-dos-pasos--u-dat-01).

## Qué se entrega

| Pieza | Archivos |
| --- | --- |
| Modelo y protocolo | `lib/db/schema.ts`, `drizzle/0003_library_revision.sql` (+ journal y snapshot): `library_state`, `import_previews`, `library_operations`, `biblib.lock_library()` y triggers `*_rotate_library_revision` |
| Bloqueo en mutaciones | `lib/db/library.ts` (`lockLibrary(tx)` → `lock_library()`), `app/actions/books.ts`, `shelves.ts` y `cover-recovery.ts` |
| Plan y confirmación | `lib/import-plan.ts`, `app/actions/import-preview.ts`; se retira `importLibraryDataAction` de `app/actions/library.ts` |
| Errores | `lib/domain-errors.ts` (códigos nuevos, `isRetryable` y `httpStatusForDomainError`), `lib/action-result.ts` (`retryable` y `correlationId`), `lib/server-action.ts` |
| UI | `app/settings/page.tsx`: preparar → plan → confirmar; ante conflicto o caducidad, «Volver a revisar» |
| Manifest de objetos | `scripts/db/objects-manifest.mjs`, `tests/fixtures/migrations/objects-0003.json` (metadatos reales) |
| Pruebas | `tests/import-plan.test.ts`, `tests/action-result.test.ts`, `tests/db/revision.sql`, `tests/integration/import/*`, fixture `tests/fixtures/import/sintetico-111.json` |

**Decisión del protocolo: guardas en la base.** La función de bloqueo `SECURITY DEFINER` con `search_path=pg_catalog` toma el propietario de `auth.uid()`. Los triggers `AFTER` de fila rotan la revisión una vez por transacción mediante `rotated_xact = pg_current_xact_id()`. Así queda cubierta también la SQL directa autorizada, y `authenticated` solo puede leer `library_state`.

## Criterios de aceptación de 02 → evidencia

| Criterio | Evidencia |
| --- | --- |
| Dos sesiones de A: preparar un reemplazo, añadir un libro en la otra y confirmar da conflicto sin eliminar nada. Igual con cambio de estantería, estado o portada. | `integracion.txt` · «reemplazo preparado y cambio posterior…». Cubre seis mutaciones: alta, mover, estado, portada, renombrar estantería y SQL directo. Las colecciones de libros y estanterías no cambian y el reintento sigue en conflicto. |
| Una mutación de B no invalida la revisión de A. | «una mutación de B no invalida…» y `tests/db/revision.sql`. |
| Confirmar dos veces con la misma clave da una operación y un resultado únicos. | Repetición secuencial (`replayed: true`, mismo `operationId`) y dos confirmaciones simultáneas: una sola operación y los libros insertados una vez. |
| La misma clave con otro modo o archivo falla. | `IDEMPOTENCY_CONFLICT` en los dos casos, sin ningún cambio en la colección. |
| Con Auth/PostgREST real, nadie altera `library_state` ni confirma o enumera una vista previa ajena. | `aislamiento.test.mjs` cubre SQL con `authenticated` y `anon`, y PostgREST (406, también `rpc/lock_library`). `revision.test.mjs` cubre que B confirme la vista previa de A (`NOT_FOUND`). |
| Tras un conflicto, el borrador y la selección persisten, pero una confirmación antigua nunca se aplica al reintentar. | La UI conserva el archivo y el modo. En integración, el reintento con la misma clave sigue en `REVISION_CONFLICT`. |
| Los 111 registros legacy siguen siendo válidos. | Unitaria (parse + plan) e integración: se importan 111 libros, de ellos 9 `manual-`. |
| `PREVIEW_EXPIRED`. | Integración con `expires_at` vencido y unitaria (caducidad y reglas). |
| Migración: backfill y alta perezosa. | `tests/db/revision.sql`. En el ensayo real, las 2 cuentas del perfil `test` reciben su fila. |

## Comandos ejecutados (resultados reales)

| Comando | Resultado |
| --- | --- |
| `pnpm db:local:up --profile test` | Stack sano. |
| `db:status` → `db:plan:local --out dat01-upgrade.json` → `db:migrate:local …` | **0002 → 0003 aplicado**. Exit 0 y 76/76 comprobaciones del manifest ([migracion-0002-0003.json](migracion-0002-0003.json)). |
| `pnpm db:status:local --profile test` | `up-to-date`, 80 comprobaciones correctas. |
| `pnpm test:integration:local` (1.ª) | Exit 11: 40 escenarios superados y 5 fallidos. 4 de `rls/data-api` fallaron por un timeout de Docker en su `setup` («Docker no respondió al comprobar la propiedad»), transitorio. 1 de `auth/caida-servicios` falló porque contaba libros marcados que el grupo `import` aún no había limpiado. Corregido con `cleanupOwn()` por suite. |
| `pnpm test:integration:local --reuse-build` (2.ª) | **45/45, exit 0**, cuentas de Auth sin cambios y limpieza completa ([integracion.txt](integracion.txt)). |
| `pnpm test:db` | Exit 0, incluido `tests/db/revision.sql`. `versions.sql` y `rls.sql` no requirieron cambios. |
| `pnpm test` | 82/82. |
| `pnpm test:scripts` | 122/124: 2 omitidas `[stack]` de scratch, que pertenece a otro worktree y no se toca. |
| `pnpm lint` y `pnpm typecheck` | Exit 0 ([validacion.txt](validacion.txt)). |
| `pnpm test:smoke` | **Falla antes de la app, por un problema previo ajeno a esta unidad.** El build temporal no encuentra `scripts/db/environment.mjs`, que importa `next.config.mjs` desde U-INF-02, porque el smoke no enlaza `scripts/`. Se añadió `0003` a la base del smoke para cuando se corrija. |

## Ensayo desde vacío

`pnpm db:reset:local --profile test` no puede ejecutarse desde este worktree: `scripts/db/reset-local.mjs:151` aborta con 3 («Desde este worktree solo se puede reconstruir scratch»). Se consultó al coordinador (`msg_45b93738b145`). La aplicación `0000→0003` desde un Postgres vacío sí está cubierta por `pnpm test:db`, que aplica las cuatro migraciones en orden sobre un contenedor efímero. La actualización sobre datos reales sembrados se ensayó en el perfil `test`.

## Limitaciones y fuera de alcance

- No se puede inyectar un proveedor lento en la app compilada (U-BIB). Lo que se prueba es una escritura entre la preparación, que incluye el enriquecimiento, y la confirmación.
- Las vistas previas guardan la entrada validada; el límite es de 10 por cuenta y la purga de caducadas se hace a +1 día. La cuota y la retención definitivas corresponden a F4.
- `TRUNCATE` y los backfills administrativos quedan fuera del protocolo de fila y requieren ventana coordinada.
- Cambio autorizado fuera de scope: `app/api/books/search/route.ts` (U-BIB-01) y `app/api/books/add/route.ts` usan `httpStatusForDomainError` (commit `69d0c03`).

## Privacidad y recursos

La evidencia no contiene JWT, cookies, contraseñas, claves ni URL privadas. El fixture de 111 es sintético. HolaERP y los recursos `biblib-scratch` de otra raíz no se tocaron. Al terminar se ejecuta `pnpm db:local:down --profile test`; se conservan la red `biblib-test-network` y los volúmenes del perfil.

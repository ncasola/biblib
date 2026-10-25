# U-OPS-03 · Eliminación de cuenta y retención (O12) · Informe

**Fecha:** 25-10-2026 · **Rama:** `u-ops-03` (worktree `stack-scratch`) · **Perfil:** `scratch` (`biblib-scratch`, puertos 55340–55349) · **Head:** `0013_account_deletion`.

Especificación: [04 · U-OPS-03](../../../../spec-pendientes/04-calidad-seguridad-y-operacion.md#u-ops-03--eliminación-de-cuenta-y-retención-de-datos) y puerta G12 (parte de cuenta) en [05 · O12](../../../../spec-pendientes/05-fases-olas-y-trazabilidad.md#o12--ejemplares-y-ciclo-de-vida-de-cuenta). Documentación: [retencion.md](../../../../retencion.md), [operación](../../../../operacion.md#eliminación-de-cuenta-y-retención--u-ops-03-o12), [recuperación](../../../../recuperacion.md#supresiones-de-cuentas-al-restaurar-u-ops-03), [seguridad](../../../../seguridad.md#eliminación-de-cuenta-u-ops-03).

## Qué se entrega

| Paso de 04 | Implementación |
| --- | --- |
| 1. Página con alcance, exportar antes, sesión reciente y confirmación | Perfil → **Eliminar la cuenta** (`components/account-deletion.tsx`): alcance, enlace a exportar (Ajustes), frase «ELIMINAR MI CUENTA», casilla de conformidad, inicio de sesión de hace < 15 min (claim `amr` verificado). La cuenta sale de la sesión; la entrada es estricta. |
| 2. Solicitud idempotente, cuenta marcada y bloqueo | `requestAccountDeletionAction({ confirmation, operationKey })` → `biblib.account_deletion_request` (0013): una fila por cuenta, `account_lifecycle = 'deleting'`, trabajos expirados, bloqueo de colección. Repetir con cualquier clave devuelve el mismo estado. |
| 3. Revocar sesiones; RLS y Storage exigen cuenta activa | Logout global de GoTrue con el token del propio usuario + bloqueo `ban_duration` por el worker. 29 políticas RESTRICTIVE con `account_write_allowed()` (BD001), `lock_library`, Storage y funciones definer de escritura con guarda; nada que el cliente pueda reactivar. |
| 4. Worker por pasos reintentables | `lib/account-deletion/worker.ts` + `pnpm account:deletions:local` (fuera de Next): sesiones → Storage → portadas → versiones → staging → trabajos → vistas → previews → operaciones → caché privada → ejemplares → ediciones → obras → estanterías → estado, con lease/fencing. |
| 5. Identidad al final; no terminar con Storage pendiente | Paso `auth` (GoTrue admin) y `verify` (`account_residue` a cero). Storage caído/pendiente → `waiting_retry` → `failed` tras 5 intentos; `--retry-failed`. |
| 6. Marca técnica mínima | `account_deletions` `completed`: ID, fechas y `purge_after` (90 días); sin FK a `auth.users`, contadores ni contenido; sin acceso de cliente. Copia en el registro privado del perfil. |
| 7. Copias administrativas | `docs/retencion.md`; restore aplica las supresiones antes de abrir (fase `suppress`) y verify lo acredita (`suppressions.applied`). |

## Resultados

| Comprobación | Resultado | Evidencia |
| --- | --- | --- |
| Migración 0012 → 0013 con datos (restore del respaldo 0012 → plan → migrate) | Verde; 532 comprobaciones de manifest sin drift | `09`–`14` |
| 0013 desde vacío con `db:reset:local` (bootstrap: migrate + seed + verify) | Verde | `07`, `08` |
| `pnpm test:db` (contenedor aislado, incl. `tests/db/account-deletion.sql`) | Verde | `44` |
| Grupo `account` (`--profile scratch`) | 11/11 | `34` |
| Grupos `jobs` 19/19, `snapshots` 10/10, `restore` 11/11, `views` 5/5, `assets` 10/10, `security` 23/23, `model` 8/8 (`--profile scratch`) | Verde | `16-*`, `34-integracion-restore` |
| Ensayo G12 backup → eliminación (worker CLI) → reset → restore → verify | Verde: la cuenta C del respaldo se retira antes de abrir (1 cuenta, 2 objetos, 1 marca); verify con `suppressions.applied` | `20`–`33` |
| `pnpm lint`, `pnpm typecheck` | Verde | `40`, `41` |
| `pnpm test` | 368/368 | `42` |
| `pnpm test:scripts` (completo, con pruebas `[stack]` en scratch) | 262/262 | `43` |
| `pnpm build` | Verde | `45` |
| `pnpm test:smoke` | Verde | `46` |
| HolaERP | Contenedores, volúmenes y redes idénticos antes y después | `00`, `48` |

Aceptación de U-OPS-03 cubierta por pruebas reales: A solo pide su propia eliminación (un `userId` en la entrada es `INVALID_INPUT`); doble clic y reintento con otra clave devuelven la misma solicitud; un JWT antiguo no escribe por acciones (sesión viva → `ACCOUNT_INACTIVE`; sesión cerrada → el proxy devuelve al acceso), por la Data API (`biblib` no expuesto) ni por Storage (ni sube ni retira); GoTrue rechaza un inicio de sesión nuevo y el refresh anterior; un trabajo en vuelo queda expirado y su lease ya no renueva ni cerca; Storage caído deja `waiting_retry` sin borrar la identidad; un worker interrumpido lo continúa otro desde su paso sin recrear nada; al terminar no quedan filas, objetos ni identidad de A; B intacto; un respaldo restaurado no resucita la cuenta.

## Incidencias encontradas y corregidas

- **Rotación del restore con trabajos en vuelo** (`scripts/lib/backup-db.mjs`, U-OPS-02): `rotateRestoredTokens` anulaba `lease_until` de un trabajo `running` sin cambiar su estado y `library_jobs_lease_check` hacía fallar la fase `rotate` de cualquier respaldo con un trabajo en ejecución (`27a-restore-g12-fallo-rotacion.txt`). Ahora `library_jobs` y `account_deletions` en ejecución se reanudan como `waiting_retry` sin lease y con fencing nuevo (commit propio y prueba en el grupo `account`).
- **Prueba de promoción 7** (`tests/scripts/promotion-stack.test.mjs`): fijaba `when 1792900000000` para su migración de fallo; con 0013 el head es posterior. Ahora sigue al `when` del head (commit propio).
- **Lista de definers de seguridad** (`tests/integration/security/exposicion.test.mjs`): se añaden las tres funciones ejecutables por `authenticated` de 0013 (commit propio).
- El primer `db:migrate:local` de 0013 salió con 11 por un error de mi declaración del manifest (orden de columnas de `account_deletions_completed_check`), no de la base (`04`, `05`). Tras corregirlo, scratch se reconstruyó y la migración se repitió desde el respaldo de 0012 (`06`–`14`).

## Decisiones y límites

- **Revocación de sesiones.** `admin.signOut(jwt, "global")` exige un JWT del usuario que el proceso administrativo no tiene; guardarlo sería persistir un secreto. Se combina el logout global con el token del propio usuario (en la acción, sin credencial de servicio en Next) y el bloqueo `ban_duration` del worker, más las guardas de RLS/Storage mientras el JWT antiguo no caduca. Se propuso al coordinador (`msg_087eb1a049d7`); sin respuesta en 10 minutos, se aplicó esta opción conservadora.
- **Registro privado de supresiones** (`.biblib/state/<perfil>-suppressions.json`): copia de las marcas fuera de la base para aplicarlas aunque el respaldo sea anterior y la base se reconstruya. En producción (U-INF-07) debe formar parte del procedimiento de respaldo.
- **Copia offline (U-EXP-08):** no existe; su límite de revocación sin red queda anotado en `retencion.md`. **Préstamos, notas y lectura (F3):** no existen; el inventario y la prueba SQL obligan a incluir cada tabla nueva.
- La sesión reciente con más de 15 minutos solo se prueba con claims simulados (unitarias): forzar un `amr` antiguo en GoTrue real no es posible sin esperar.
- Los grupos `jobs`, `snapshots`, `views`, `assets` y `model` se ejecutaron antes de la corrección de rotación y del traslado del adaptador (que no tocan su código); `account` y `restore` se repitieron después.

## Recursos Docker al terminar

`db:local:down --profile scratch` ejecutado: sin contenedores del perfil; quedan su red `biblib-scratch-network` y sus volúmenes `supabase_db_biblib-scratch` y `supabase_storage_biblib-scratch`. No se han tocado recursos de HolaERP ni de otros perfiles.

# U-QA-05 · Cierre verificable de la auditoría (O16)

**Fecha:** 26 de octubre de 2026 · **Rama:** `u-qa-05`, worktree `stack-scratch`, base `b02afe7` (O15 integrada) más `feature/spec-pendientes` con U-EXP-07 (`07f7dcf`) · **Perfil:** `scratch` (`biblib-scratch`) · **Unidad:** [04 · U-QA-05](../../../../spec-pendientes/04-calidad-seguridad-y-operacion.md#u-qa-05--cierre-verificable-de-la-auditoría).

**Entregables:**
- [Matriz de los 35 hallazgos](../matriz-auditoria.md).
- [Lista de entrega de O16](../entrega.md).
- Este informe, con la evidencia de esta carpeta.

Se siguieron solo `README.md`, `docs/operacion.md`, `docs/recuperacion.md` y `docs/retencion.md`, como lo haría una persona nueva. Los documentos que fallaban o estaban desfasados se corrigieron con cambios mínimos (§5).

Ninguna operación tocó nada remoto: ni preproducción, ni producción, ni Google, ni proveedores con clave. El perfil `test` no se usó. HolaERP no estaba en marcha durante el trabajo (0 contenedores `*holaerp*`) y no se arrancó ni se tocó.

## 1. Instalación limpia

| Paso | Resultado |
| --- | --- |
| `git clone --no-local` de `b02afe7` en `.biblib/tmp/clean-install` (sin `node_modules`) | Correcto. |
| `pnpm install --frozen-lockfile` (Node 24.11.1, pnpm 10.32.1) | Correcto en 30,5 s. El lockfile no cambia (`git status` limpio). [00-install-limpio.log](00-install-limpio.log) |
| `pnpm lint` / `pnpm typecheck` en el clon | Correctos. |
| `pnpm test` en el clon | 516/516. |
| `BIBLIB_SKIP_STACK_TESTS=1 pnpm test:scripts` en el clon | 265 superadas y 2 omitidas, porque el clon no posee `scratch`. |

El stack no se puede arrancar desde el clon: `scratch` pertenece a la raíz de este worktree, y otra raíz se rechaza con salida 3 por diseño. La reconstrucción desde volúmenes vacíos se hizo en este worktree.

## 2. Instalación limpia y migración desde la versión previa

### 2.1 Reconstrucción desde volúmenes vacíos

Se siguió [Reset y bootstrap](../../../../operacion.md#reset-y-bootstrap): `db:local:doctor` → `db:local:up` → `db:reset:local --dry-run` → `--apply … --discard-local-data`.

| Paso | Resultado |
| --- | --- |
| `db:local:doctor --profile scratch` | 10/10 comprobaciones correctas ([01-doctor.txt](01-doctor.txt)). |
| `db:local:up` y plan de reset | Correctos ([02-up.txt](02-up.txt), [03-reset-dry-run.txt](03-reset-dry-run.txt)). |
| Primer `--apply` | Destruyó contenedores y volúmenes registrados. El bootstrap falló en la fase `stack` con salida **8**, aunque los contenedores nuevos quedaron sanos poco después ([04-reset-apply.txt](04-reset-apply.txt)). Había carga simultánea: el build del clon. |
| Mismo `--apply` repetido, como indica la guía | Continuó desde `bootstrap` y completó preflight → stack → env → migrate → seed → verify ([05-reset-apply-continuacion.txt](05-reset-apply-continuacion.txt)). |
| `db:status:local` | `up-to-date`, head `0015_reading_and_loans`, 864 comprobaciones del manifest ([06-status-limpio.txt](06-status-limpio.txt)). |
| App: `dev:local --profile scratch` y [acceso-app.mjs](acceso-app.mjs) | Anónimo: `/login` 200 y `/books` → `307 /login?redirect=%2Fbooks`. Con sesiones GoTrue reales de A y B (cookies de `@supabase/ssr`): 13 rutas privadas con 200, incluidas `/shelves/3d`, `/loans`, `/locations`, `/series`, `/books/review` y `/offline` ([07-acceso-app.json](07-acceso-app.json)). |
| Bordes de paginación (UX-06) con Chrome y [paginacion.mjs](paginacion.mjs) | Ver §2.3. |

Incidencias:
- **Primer bootstrap con salida 8:** fue transitorio y se recuperó con la continuación documentada, sin borrar nada a mano. No es un defecto de la guía, que ya indica repetir la misma orden. Queda anotado como observación.
- **`agents.md` modificado por `next dev`:** Next 16.4.2 añade a `agents.md` un bloque «nextjs-agent-rules» (`node_modules/next/dist/server/lib/generate-agent-files.js`), lo que ensucia el árbol de quien sigue la guía. Se revirtió y se avisa en el README. La solución (`agentRules: false` en `next.config.mjs` o conservar el bloque) queda fuera del scope de U-QA-05; ver §7.

### 2.2 Migración desde el esquema previo a la spec

PENDIENTE_UPGRADE

### 2.3 Paginación

PENDIENTE_PAGINACION

## 3. Respaldo y restauración de la versión final

Procedimiento de [recuperación](../../../../recuperacion.md#procedimiento-local) y [retención](../../../../retencion.md), con head `0015`. El script [ensayo-final.mjs](ensayo-final.mjs) reutiliza el contexto real del grupo `product`:
- subida de imágenes por el flujo de la app: reserva con la sesión, Storage con el JWT del dueño y registro;
- worker de eliminación real.

| Paso | Resultado |
| --- | --- |
| `cargar`: cuentas desechables K (se conserva) y C (se suprime) | Cada una con 3 ejemplares; avatar y foto de ubicación en `biblib-media`; portada privada en `biblib-covers`; etiqueta, nota, serie, ciclo de lectura con entrada y préstamo. 3 objetos por cuenta ([10-ensayo-cargar.json](10-ensayo-cargar.json)). |
| `db:backup:local --profile scratch --json` (respaldo con C) | `20261026T075637Z-scratch-07510c`, head `0015`, 7 objetos Storage, `receipt.json` con alcance `mailpit` ([11-backup-con-C.json](11-backup-con-C.json)). |
| `solicitar` y `account:deletions:local --once` | C pide su eliminación con sus claims. El worker la completa: sin identidad, sin filas (`account_residue` = 0) y sin objetos. K intacta y con sha256 iguales ([12](12-ensayo-solicitar.json), [13](13-worker-eliminacion.txt), [14](14-ensayo-tras-worker.json)). |
| Reset desde vacío | Correcto ([15](15-reset-dry-run.txt), [16](16-reset-apply.txt)). |
| `db:restore:local` del respaldo **anterior** al borrado | Completado en 5 s. Rota 18 familias de tokens. Fase `suppress`: «1 cuenta del respaldo eliminada, 3 objetos retirados, 2 marcas» antes de abrir ([17-restore.txt](17-restore.txt)). |
| `db:restore:verify` | **Superado** en 20 s ([18-restore-verify.txt](18-restore-verify.txt)): ledger de 16 migraciones; manifest; tokens rotados; muestra de fichas; `suppressions.applied`; sesiones reales A/B con RLS; los tres buckets privados; 4/4 objetos con su sha256 (los 3 de C, retirados). |
| `comprobar` tras restaurar | **C no resucita:** sin identidad, 0 filas, 0 objetos y marca `completed`. K conserva sus filas de producto, lectura y préstamo, y sus 3 objetos con sha256 idéntico ([19-ensayo-tras-restore.json](19-ensayo-tras-restore.json)). |
| Catálogo tras restaurar frente a la instalación limpia | Ver §2.2 (comparación de los tres catálogos). |

La cuenta K se retiró al terminar (`ensayo-final.mjs retirar`). Los respaldos quedan en `.biblib/backups/`, ignorado por Git.

## 4. Benchmark final frente a G09

PENDIENTE_BENCH

## 5. Errores de documentación corregidos

| Documento | Error | Corrección mínima |
| --- | --- | --- |
| `README.md` | Decía que los comandos de la spec «todavía no están implementados». Solo ofrecía `pnpm dev` con `.env.local` de un Supabase remoto. Proponía `pnpm db:migrate`, que hoy sale con 2. Describía solo `0000`–`0002`. | Estado real y enlace a la matriz; arranque local con `db:local:bootstrap`, `dev:local` y credenciales ficticias; migración por objetivo (`db:status|plan|migrate:local`) y aviso de `agents.md`. |
| `docs/operacion.md` · Migraciones y recuperación | «Preproducción y producción no tienen todavía comando de migración (U-INF-07)». | Comandos existentes desde U-INF-07, preparados pero sin ejecutar contra un destino real. |
| `docs/operacion.md` · Ensayo manual | Presentaba `docker network create` + `supabase start` a mano como el procedimiento vigente. Hacerlo deja recursos sin registro que los wrappers rechazan. | Marcado como histórico; remite a `db:local:up|down`. |
| `docs/recuperacion.md` · Limitaciones | «Mailpit no se respalda; el recibo no satisface `--backup-receipt`». Ya no es cierto: `receipt.json`, carpeta `mailpit/`. | Texto actualizado y comprobado con el respaldo de §3. |
| `docs/mantenimiento.md` | «Hoy no existe `pnpm test:scripts`». | Existe desde U-INF-01. |
| 9 enlaces de evidencia | `O03/u-inf-03-informe.md` → `operacion.md`; los `tablas.md` de `rendimiento/2026-10-23-fix-02/*` y `O12/dat-06/rendimiento/*` → `informe.md` de otra carpeta. | Rutas relativas corregidas (commit `db3109e`). |

## 6. Enlaces y validación de la rama

PENDIENTE_VALIDACION

## 7. No verificado o fuera de alcance

PENDIENTE_FUERA

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

**Versión previa.** `main` (`3c6fd35`, el commit anterior a la spec) no tiene wrappers de stack. Se usó el mecanismo del workflow `extended.yml` (U-QA-04): extraer la versión anterior **en el mismo checkout**, para conservar la propiedad de `scratch`; hacer bootstrap; volver a la rama y planificar y aplicar el upgrade.

Como versión anterior se tomó `81c57d1`, el último commit de integración con head `0002` y con bootstrap (cierre de F0, justo antes de U-DAT-01). Su esquema es el de `main`:
- el journal es idéntico;
- `drizzle/` y `lib/db/schema.ts` no difieren;
- los sha256 de `0000`–`0002` coinciden en `main`, `81c57d1` y la rama;
- `node scripts/ci/previous-schema.mjs 81c57d1…` → «Upgrade fijado: 0002_book_versions → 0015_reading_and_loans».

Un worktree temporal en `.biblib/tmp` no sirve: otra raíz no puede usar `scratch`, que se rechaza con salida 3.

| Paso | Resultado |
| --- | --- |
| `git checkout --detach 81c57d1` + `pnpm install --frozen-lockfile` | Correcto ([30-install-previa.log](30-install-previa.log)). |
| `db:local:doctor` y `db:reset:local` (dry-run y apply) **con el código anterior** | Bootstrap completo con head `0002` y el seed de F0 ([31](31-doctor-previa.txt), [32](32-reset-dry-run-previa.txt), [33](33-reset-apply-previa.txt), [34](34-status-previa.txt)). |
| Datos legados: [legado.mjs](legado.mjs) `cargar` | Las **111 fichas sintéticas** de `tests/fixtures/import/sintetico-111.json` (9 manuales, 4 estados, 4 estanterías y la predeterminada) en la cuenta A, en el esquema `0002`, más el censo A/B (4 + 4). No se usó la biblioteca fotografiada (A06) ([35](35-legado-cargar.json)). |
| Huella y catálogo en `0002` | A: 115 fichas y 7 estanterías; B: 4 y 3 ([36-huella-0002.json](36-huella-0002.json), [catalogo-0002.json](catalogo-0002.json)). |
| `git checkout u-qa-05` + `pnpm install --frozen-lockfile` → `db:status:local` | `pending`, 13 migraciones pendientes ([40](40-install-actual.log), [41](41-status-antes-upgrade.txt)). |
| `db:plan:local --out qa05-upgrade.json` → `db:migrate:local --plan … --expect-project biblib-scratch --expect-plan <sha256>` | `0003` → … → `0015` en una transacción, en 3,4 s ([42](42-plan-upgrade.txt), [43](43-migrate-upgrade.txt)). `db:status:local`: `up-to-date`, 864 comprobaciones ([44](44-status-tras-upgrade.txt)). |
| Huella tras migrar | **Idéntica** a la de `0002` en las dos cuentas: cantidades, IDs, títulos, estado, estantería, páginas, fecha, autores, editoriales y portada (`huella_fichas`); ID + identificador ISBN/manual (`huella_isbn`); estanterías y predeterminada ([45-huella-0015.json](45-huella-0015.json)). |
| `db:seed:local` actual sobre la base migrada | Correcto e idempotente; no cambia la huella ([46](46-seed-tras-upgrade.txt)). |
| `test:integration:model --profile scratch` sobre la base migrada | 8/8 ([47](47-integracion-model-tras-upgrade.txt)). |
| Instalación limpia del head con el código actual (reset) | Correcta ([50](50-reset-dry-run.txt), [51](51-reset-apply.txt)). |

**Comparación de catálogos de objetos.** [catalogo.mjs](catalogo.mjs) lee `pg_catalog` en una transacción `read only`, sin filas de datos. Cubre los esquemas `biblib` y `drizzle`:
- relaciones, con RLS y ACL;
- columnas, con tipo, nulabilidad, default, identidad, generadas y ACL;
- restricciones (`pg_get_constraintdef`), índices (`indexdef`) y vistas (md5 de la definición);
- funciones (argumentos, resultado, lenguaje, `SECURITY DEFINER`, volatilidad, `search_path`, propietario, ACL y md5 del cuerpo);
- triggers (`pg_get_triggerdef`, también los de `storage.objects` sobre funciones de `biblib`);
- políticas de `biblib` y las `biblib_*` de `storage.objects`;
- ACL por defecto, tipos, buckets `biblib*` y hashes del ledger.

| Comparación | Resultado |
| --- | --- |
| Instalación limpia frente a migrada desde `0002` | **Equivalentes**: 47 relaciones, 482 columnas, 279 restricciones, 131 índices, 1 vista, 80 funciones, 62 triggers, 184 políticas, 3 buckets y ledger de 16 hashes ([23-diff-limpio-migrado.txt](23-diff-limpio-migrado.txt)). |
| Instalación limpia frente a restaurada (§3) | **Equivalentes** ([24-diff-limpio-restaurado.txt](24-diff-limpio-restaurado.txt)). |

La primera comparación con la restaurada encontró 16 diferencias solo de representación: ACL `NULL` en la restaurada frente a la ACL explícita del propietario, equivalente, en la limpia. `pg_dump` no emite la ACL por defecto. Por eso el script compara ACL **efectivas** (`acldefault()` del propietario cuando es `NULL`), y la limpia se volvió a capturar con esa regla tras el reset final ([catalogo-limpio.json](catalogo-limpio.json), [catalogo-migrado.json](catalogo-migrado.json), [catalogo-restaurado.json](catalogo-restaurado.json)). Las cantidades del diff cuentan líneas distintas; hay 4 restricciones con texto repetido.

### 2.3 Paginación

Es el criterio de cierre de UX-06: «probar 0, 1, 10 y 11 resultados y un filtro aplicado desde una página posterior». Los E2E existentes cubren 0 y 12 resultados, pero no los bordes 10 y 11 de forma explícita.

[paginacion.mjs](paginacion.mjs) usa Chrome (Playwright, canal `chrome`), la app compilada con el código integrado (`build:local` + `start:local`) y la sesión real de A. Crea fichas manuales ficticias `[QA05-PAG] nn` y las retira al terminar. Resultado: **7/7** ([22-paginacion.json](22-paginacion.json)).

| Caso | Resultado |
| --- | --- |
| 11 resultados | «Mostrando 1 a 10 de 11 libros · Página 1 de 2»; en la página 2, «Mostrando 11 a 11 de 11 · Página 2 de 2». |
| Búsqueda nueva desde la página 2 | Vuelve a la página 1: «Mostrando 1 a 1 de 1». |
| 10 resultados | «Mostrando 1 a 10 de 10 · Página 1 de 1». Con `?page=2`, la página que ya no existe se ajusta a la 1. |
| 1 resultado | «Mostrando 1 a 1 de 1». |
| 0 resultados | «No hay libros con estos filtros» con «Limpiar filtros». |

En el primer intento, el caso del filtro se leyó antes de que llegara la respuesta de la Server Action. El script relee ahora hasta 15 s; no fue un fallo de la app. Convertir esta comprobación en un E2E permanente queda propuesto (§7).

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

El análisis completo está en [rendimiento/informe.md](rendimiento/informe.md). Se repitió el benchmark de G09 (`perf:local`, 100/1 000/10 000) en `scratch` y `perf:restore` (U-DAT-04).

- **Acciones:** entre 1,5 y 6 veces más rápidas que en G09 tras el cambio de modelo, el pool de 4 conexiones y una sola verificación de sesión por petición. Los 6 incumplimientos de acciones concurrentes de G09 desaparecen; el peor p95 presupuestado es 729 ms.
- **INP y CLS:** se resuelven el INP móvil (496 → 176 ms) y el CLS de Ajustes.
- **Regresión nueva:** el **CLS de Inicio en escritorio es 0,159** en los tres tamaños (presupuesto 0,1). Se propone como tarea de U-UX-01/U-EXP-03.
- **Restauración atómica de 10 000 con colección llena:** 1 977 → 4 233 ms. Dentro del presupuesto de 15 s y sin commits parciales.
- **Conexiones:** la app usa 4 y el perfil 10 de 100. Ninguna queda inactiva en transacción esperando cuota.
- **Cuota con dos procesos:** las plazas se separan ≥ 1 000 ms.
- **Aislamiento y red:** 828 comprobaciones sin violaciones y 0 salidas de red.
- **No se pudo repetir igual:** el perfil es `scratch` y no `test` (el coordinador reserva `test` para G16). La lectura completa de Ajustes ya no existe; la sustituyen `ajustes-recuentos` y la exportación por partes, sin presupuesto propio. El caudal de los workers de portadas no tiene escenario en `perf:local`.

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

### No se pudo verificar desde aquí

Todo lo remoto es **pendiente externo** y su dueño es Néstor. El detalle está en [entrega.md](../entrega.md#pendientes-externos-consolidados).

- **Accesos y servicios externos:** Google OAuth real y su renovación; HTTPS, cabeceras, CDN y caché del alojamiento; sonda de proveedores reales.
- **Destinos remotos:** preproducción (no existe) y producción; respaldo del proveedor y restauración remota.
- **Release y alertas:** ejecución real de los workflows en GitHub y artefacto de release del destino; alertas en la herramienta real.
- **Revalidación de G16 en el perfil `test`:** E2E en Chromium, Firefox y WebKit, a11y e integración completa. La ejecuta el coordinador y la anota en la matriz y en `entrega.md`.
- **Ensayos manuales:** lector de pantalla, Safari macOS/iOS, Edge y dispositivos móviles reales. Por esto UI-03 queda `pendiente`.
- **Linux nativo:** el stack solo se ensayó en Windows con Docker Desktop.

### Encontrado y fuera del scope de U-QA-05 (propuestas, sin cambios de código)

1. **CLS 0,159 en Inicio, escritorio:** regresión posterior a G09 (§4). Dueños: U-UX-01/U-EXP-03.
2. **`next dev` modifica `agents.md`:** Next 16.4.2 escribe un bloque de reglas cada vez que arranca. Hay que decidir entre `agentRules: false` en `next.config.mjs` o versionar el bloque. Mientras tanto, el README lo advierte.
3. **E2E permanente de los bordes 10/11 de UX-06:** convertir [paginacion.mjs](paginacion.mjs). Dueño: U-QA-02.
4. **Proxy sin timeout propio con GoTrue caído (~60 s, Kong):** residuo de U-QA-01 que sigue en `lib/supabase/proxy.ts`. Dueños: SEC-05/UX-04.
5. **`unidades.json` desfasado:**
   - U-EXP-07 y U-EXP-08 siguen `in-progress` aunque están integradas.
   - U-PRO-02/04 y U-UX-01/02 no tienen `evidence`.
   - Varios `pending` parecen resueltos: el `service_role` en Next (U-QA-01), «repetir con U-EXP-05/08» (U-OPS-04), el `fetch` directo a Open Library (U-DAT-03/05) y el recibo `--backup-receipt` (U-OPS-02/U-INF-07; este último, comprobado en §3).

   El registro es del coordinador; no se ha editado.
6. **`tests/e2e/flujos/pendientes.spec.ts`:** conserva `fixme` de unidades ya integradas (U-DAT-02/03/04/06/10, U-OPS-03, U-PRO-01/03/05, U-BIB-03/04). Las puertas los cuentan como «pendientes de unidades futuras».
7. **Generador de `tablas.md`** (`scripts/performance/lib/report.mjs`): enlaza `informe.md` en su propia carpeta. Cuando la salida es una subcarpeta, el enlace se rompe; se corrigieron los 9 casos existentes. Este informe incluye `rendimiento/informe.md`, así que el nuevo enlace sí resuelve.
8. **`docs/seguridad.md` § Pendientes 5 y 6:** siguen redactados como no hechos, aunque G13 y O15 los cubren en local. Hay que confirmarlo con U-OPS-04.

### Recursos Docker que quedan

Tras `pnpm db:local:down --profile scratch` (ver §6) quedan solo los recursos propios del perfil, conservados por diseño:
- la red `biblib-scratch-network`;
- los volúmenes `supabase_db_biblib-scratch` y `supabase_storage_biblib-scratch`, con la instalación limpia del head y el censo A/B.

Fuera de Git quedan los respaldos del ensayo en `.biblib/backups/` y el clon de instalación limpia en `.biblib/tmp/clean-install`. No se tocó ningún recurso ajeno: ni `biblib-local`, ni `biblib-test`, ni HolaERP.

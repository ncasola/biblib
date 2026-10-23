# U-INF-04 · Informe de implementación y ensayo

Fecha: 23-10-2026. Rama: `u-inf-04`, hija de `feature/spec-pendientes`, en el worktree `u-inf-03`. Ensayo formal: **2026-10-23T11:26:41.894Z → 11:27:38.021Z** (UTC). Entorno: Windows 11, Node 24.11.1, pnpm 10.32.1, Supabase CLI 2.117.0, Docker Desktop 29.4.3, drizzle-orm 0.45.2, postgres 3.4.9 y Postgres 17.6 de Supabase local.

## Entrega

| Archivo | Contenido |
| --- | --- |
| `scripts/db/journal-guard.mjs` | Validación offline del journal, hash idéntico a `readMigrationFiles` de drizzle-orm 0.45.2 (sha256 del texto en disco), variantes LF/CRLF y comparación fila a fila del ledger (hash, desconocidas, duplicadas y retroactivas). También resume el DDL sin ejecutarlo. |
| `scripts/db/objects-manifest.mjs` | Manifest dependiente del head y comprobado con `pg_catalog`/`information_schema`. Cubre RLS, políticas (comando, roles y expresión normalizada), grants de `authenticated`/`anon`, PK/FK/checks, índices, columnas `catalogue`/`version`, la función `rotate_book_version` y el trigger `books_rotate_version` (tgtype 23, habilitado, sin `WHEN`). Solo lee los prerrequisitos de Auth. |
| `scripts/db/target.mjs` | Helper compartido nuevo: rechazo de preprod/prod, prueba de propiedad (huella de `loadTarget` igual a la del registro de U-INF-03, contenedor Postgres registrado y en marcha), conexión administrativa dedicada y clasificación del destino. |
| `scripts/db/plan.mjs` | `db:plan:local --out`: plan versionado en `.biblib/plans/`, caducidad de 30 min y `planHash` sobre JSON canónico. También la validación del plan. |
| `scripts/db/migrate.mjs` | `db:status:local`, `db:migrate:local`, despachador `db:migrate`, bloqueo consultivo común, aplicación con el migrador de Drizzle, verificación posterior, recibo, `readAppliedHead` y `runLocalMigration` para el bootstrap. |
| `scripts/local-stack.mjs` | `status.head` con el head aplicado. La fase `migrate` del bootstrap invoca plan + migrate (`seed`/`verify` siguen pendientes). Ver el detalle de cambios más abajo. |
| `package.json` | `db:migrate` pasa a despachador. Se añaden al final `db:status:local`, `db:plan:local` y `db:migrate:local`. |
| `drizzle.config.ts` | Sin carga de `.env*` ni `dbCredentials`. Solo comandos offline y el mismo ledger `drizzle.__drizzle_migrations`. |
| `.gitattributes` | `drizzle/**/*.sql text eol=lf`, `drizzle/meta/*.json text eol=lf`. |
| `tests/scripts/migrations.test.mjs`, `tests/fixtures/migrations/objects-0002.json` | 24 pruebas sin Docker y 3 `[stack]`. El fixture son metadatos reales de catálogo capturados de scratch, sin datos de usuario. |
| `docs/operacion.md` | Sección «Migraciones». |

**Cambios en `scripts/local-stack.mjs` (mínimos).** `createContext` acepta `readHead` y `migrateLocal`, inyectables y cargados con `import()` dinámico. Un import estático producía un ciclo que bloqueaba el `await` de nivel superior; se detectó en el ensayo y se corrigió antes de los commits. `publicResult` recibe `head`. `status` (no `doctor`) consulta el head solo si Postgres propio está en marcha y el diagnóstico es correcto; un fallo deja `head: null` y un aviso. Bootstrap registra `migrate` `running` → `passed` con el head, o el código del runner si falla, y deja `phase: "seed"`.

**Bytes de migraciones.** El índice estaba en LF, pero la copia de trabajo de este checkout Windows estaba en **CRLF** (`git ls-files --eol`: `i/lf w/crlf`). El brief suponía LF en ambos. Con esa copia, Drizzle habría registrado otro hash. Tras añadir `.gitattributes` se volvieron a extraer solo `drizzle/` con Git: `i/lf w/lf attr/text eol=lf`, `git status` limpio y hashes de disco iguales a los del índice. `git diff` de `drizzle/*.sql` y `_journal.json` frente a `feature/spec-pendientes` está **vacío**. El hash CRLF del `0000` coincide con el que tenía la copia CRLF anterior: `b139ab5c…`.

## Validación

| Comando | Resultado |
| --- | --- |
| `pnpm lint` | exit 0, sin avisos |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | exit 0, 66/66 |
| `pnpm test:scripts` (scratch arrancado) | exit 0, **89/89**, con las 3 `[stack]` ejecutadas |
| `BIBLIB_SKIP_STACK_TESTS=1 pnpm test:scripts` | exit 0, 86/86 y la suite `[stack]` omitida |
| `pnpm test:db` | exit 0: migraciones, A/B, FK, predeterminada, integridad y rollback |
| `pnpm db:generate` (sin variables de base) | `No schema changes` |
| `pnpm db:migrate` | exit **2**, lista los comandos explícitos |

Después del ensayo solo cambió la proyección de comprobaciones en la salida de `plan` (commit `fix(db)`): se quita un campo interno `code` de las comprobaciones correctas. Se volvieron a ejecutar lint y `test:scripts` sin stack (86/86).

## Ensayo real sobre scratch

`pnpm db:local:up --profile scratch` (30,9 s; exit 0; aviso conocido de bindings fuera de loopback). Las salidas JSON se capturaron en memoria y se comprobó, antes de registrarlas, que no contenían JWT, URLs Postgres con credenciales, `service_role` ni `sb_secret_`. Las sentencias SQL manuales se ejecutaron solo en `supabase_db_biblib-scratch` mediante `docker exec … psql`, y se indican como tales.

**Punto de partida.** La base de scratch no tenía esquema `biblib` (status: `empty`). Durante el desarrollo se aplicó una vez `0000→0002` y después se devolvió la base a vacía para el ensayo formal con `DROP SCHEMA biblib CASCADE; DROP SCHEMA drizzle CASCADE`, SQL manual en scratch equivalente al reset que llegará con U-INF-06. **Incidente propio:** una primera versión de la prueba de fallo usaba un `CHECK` que no falla con la tabla vacía. Aplicó una `0003` de prueba en scratch (fila 4 del ledger, tabla `u_inf_04_probe` y restricción). Se revirtió a mano en una transacción, solo en scratch. La prueba usa ahora un fallo determinista (columna duplicada, 42701) y quedó cubierta por el reset previo al ensayo formal.

| Paso | Operación | Exit | Resultado |
| --- | --- | --- | --- |
| 1 | `status` | 0 | `empty`, 3 pendientes |
| 2 | SQL manual: `CREATE SCHEMA biblib` + tabla; `plan` y `status` | 5 / 5 | `adoption-required`: «adopción de historial necesaria», sin plan escrito. Después, `DROP SCHEMA biblib` |
| 3 | Planes A y B desde vacío; `migrate` A y B **simultáneos** | 0 / 6 | A aplicó `0000 → 0001 → 0002`. B, al releer bajo el bloqueo, encontró otro head: «no se aplica nada» |
| 4 | Ledger | — | **3 filas**: `1:b2f6e7bc…:1760000000000`, `2:585b45c9…:1792627200000`, `3:eb1e44f5…:1792678059187` |
| 5 | Repetir `plan` → `migrate` | 0 / 0 | `pending: []`, «sin cambios». Ledger idéntico y OIDs de tabla, trigger y función idénticos (`17599,17662,17661`): no se ejecutó DDL |
| 6 | Bloqueo consultivo retenido por otra sesión; `migrate` con espera de 2 s | **7** | «No se ha aplicado nada» |
| 7 | `--expect-project biblib-local` / `--expect-plan` erróneo / plan alterado | 3 / 6 / 6 | Rechazos antes de conectar |
| 8 | SQL manual: `DROP TRIGGER books_rotate_version`; `status` / `plan` / `migrate` con el plan vigente | 5 / 5 / 5 | `drift`: `trigger.books_rotate_version`. No reaplica migraciones y el ledger no cambia |
| 9 | SQL manual: hash de `0000` sustituido por su variante CRLF; `status`; hash restaurado | 5 | `reconciliation-required`: «Conciliación requerida (U-INF-07)…». No se reescribe |
| 10 | SQL manual: trigger recreado con el SQL exacto de `0002`; `status` | 0 | `up-to-date`, 41 comprobaciones correctas |
| 11 | `db:local:status` / `db:local:bootstrap` | 0 / 0 | `head: {tag: 0002_book_versions, applied: 3, expected: 3, state: up-to-date}`. Bootstrap: `migrate` `passed` («sin cambios»), `phase: seed` |
| 12 | `pnpm test:scripts` con stack | 0 | Drift de trigger y política en transacción revertida, bloqueo ocupado (7) y fallo intermedio (9): `previousHead 0002`, `failedChange 0003_u_inf_04_fallo`, «revertido: el ledger no avanzó», sin tabla de prueba |
| 13 | `pnpm db:local:down --profile scratch` | 0 | Servicios parados; red y volúmenes conservados |

Status con drift (real, saneado):

```json
{"code":5,"schemaVersion":1,"target":{"target":"local","profile":"scratch","project":"biblib-scratch","fingerprint":"ea260283d87954c1c405cb5ee4875867dd8b103c86084460f3a74244e06b13fa"},
 "state":"drift","appliedHead":{"tag":"0002_book_versions","when":1792678059187,"hash":"eb1e44f5d2a96cea8db8c39d1e4055758c0a0d0c0a8c220bd03b2b1be3a94a09"},"pending":[],
 "checks":[{"id":"manifest.drift","status":"fail","message":"Drift en 1 objeto(s) deliberado(s); no se corrige reaplicando migraciones antiguas: requiere corrección hacia delante revisada."},
           {"id":"trigger.books_rotate_version","status":"fail","message":"Falta el trigger books_rotate_version en biblib.books."}]}
```

Recibo de la migración A (real, saneado; 37 comprobaciones del manifest correctas):

```json
{"code":0,"kind":"migrate-receipt","planHash":"074b6ce9866090e31b95c8d64f2cc72f9f66e0e125e96cfabc31e06ffd2eb853","previousHead":null,
 "attempted":["0000_biblib_init","0001_library_integrity","0002_book_versions"],"failedChange":null,
 "result":"aplicado: 0000_biblib_init → 0001_library_integrity → 0002_book_versions","head":{"tag":"0002_book_versions"},"waitedForLock":false}
```

### Recursos

- **HolaERP:** las 21 líneas del inventario (`*holaerp*`: ID, nombre, creación, `StartedAt`, reinicios y estado de contenedores; redes; volúmenes con fecha) son **idénticas** antes y después (`diff` vacío).
- **Que deja este worker:** scratch parado; red `biblib-scratch-network` (`6da7397786e3`) y volúmenes `supabase_db_biblib-scratch` y `supabase_storage_biblib-scratch`, los mismos que había al empezar. La base de scratch queda **migrada a `0002`** (3 filas en el ledger, manifest correcto, trigger recreado igual que en `0002`) y sin datos de dominio. `test:db` eliminó su contenedor efímero. En `.biblib/` (ignorado) quedan los planes y recibos del ensayo y `u-inf-04-rehearsal.{mjs,json}`.

## Criterios de aceptación de U-INF-04

1. **Base nueva `0000→0001→0002` con una fila por migración; repetir no aplica DDL.** Pasos 3–5: 3 filas, y ledger y OIDs idénticos al repetir.
2. **SQL cambiado, fichero ausente, timestamp retroactivo o hash no reconocido bloquean antes de escribir.** Pruebas de journal y ledger. Plan con bytes cambiados → 6. Hash CRLF/desconocido → 5 (paso 9). El SQL con CRLF en disco se rechaza.
3. **Dos runners simultáneos.** Bloqueo consultivo común antes de crear el ledger: paso 3 (la segunda ejecución sale con 6 sin aplicar) y paso 6 (bloqueo ocupado → 7 acotado).
4. **Error intermedio revierte sin adelantar el ledger; informe con head anterior, cambio fallido y resultado.** Prueba `[stack]` (paso 12).
5. **Esquema sin historial → «adopción de historial necesaria».** Paso 2.
6. **Drift de trigger/política detectado y no corregido reaplicando.** Paso 8 y prueba `[stack]` de política. La recuperación se hizo solo en scratch (paso 10).
7. **Mismos tags y hashes en Windows y Linux.** El hash es sha256 de los bytes LF fijados por `.gitattributes` (`i/lf w/lf`), y la prueba lo compara con `readMigrationFiles` del Drizzle instalado. **Solo se ejecutó en Windows**: no se afirma un ensayo nativo Linux; la igualdad se apoya en bytes LF idénticos en ambas plataformas.

## Pendiente y fuera de scope

- Preprod/prod, descriptor remoto, recibo de respaldo y `db:adopt:<target>`: U-INF-07. Hoy salen con 2.
- `seed`/`verify` del bootstrap y reset: U-INF-05/06. U-INF-06 puede reutilizar `MIGRATION_LOCK_KEY` y `runLocalMigration`.
- Otras secciones de `docs/operacion.md` siguen describiendo el comportamiento anterior: «Conexión Postgres» y «Migraciones y recuperación» (`pnpm db:migrate`, carga de `.env`), «Generación offline» y `head: null`/`migrate` pendiente en «Ciclo de vida». La nueva sección declara que los sustituye; no se editaron para respetar la regla de secciones propias. El coordinador puede depurarlas al fusionar.
- La limitación de bindings fuera de loopback de U-INF-01 sigue abierta (aviso en `up`).

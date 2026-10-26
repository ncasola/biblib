# Promoción de migraciones a preproducción y producción · U-INF-07

**Estado (23-10-2026): preparada y ensayada solo en local.** Los comandos, contratos y guardas están implementados y probados contra Postgres efímeros que simulan el remoto (TLS autofirmado para `db.<ref>.supabase.co`) y contra el perfil local `scratch`. **No hay destino remoto autorizado:** nadie ha conectado estos comandos con un proyecto Supabase real, ni con preproducción ni con producción. La verificación real queda **pendiente de la autorización de Néstor** y de las condiciones abiertas del final. Evidencia: [validacion/2026-10-23/O08/inf-07](validacion/2026-10-23/O08/inf-07/informe.md).

Contrato de origen: [01 · Entorno y migraciones](spec-pendientes/01-entorno-y-migraciones.md), «Argumentos y códigos de salida» y «U-INF-07». Respaldo y restauración: [Recuperación](recuperacion.md) (U-OPS-02). Runner local: [Operación · Migraciones](operacion.md#migraciones).

## Qué no hace nunca

- No ejecuta `supabase link`, `db push`, `config push`, `migration up` ni `db reset --linked`. Drizzle es el único aplicador del esquema de negocio.
- No lee `.env`, `.env.local` ni archivos de credenciales: preprod/prod usan solo variables inyectadas por CI o por el gestor de credenciales en el proceso.
- No acepta una URL de destino como argumento, `--force`, `--linked`, `--db-url` ni flags reenviados. El sufijo del comando fija el objetivo.
- No crea, rellena ni «repara» objetos de `auth` o `storage`. Comprueba antes y después que no cambian.
- No marca migraciones como aplicadas sin equivalencia demostrada ni reescribe el ledger.
- No reasigna ni borra datos para que una migración pase: propone correcciones.

## Comandos

| Comando | Efecto |
| --- | --- |
| `pnpm db:status:<preprod\|prod> --expect-project <ref> [--json]` | Solo lectura: identidad, TLS, rol, permisos, versión, ledger, manifest de objetos, adopción derivada y revisión de datos. |
| `pnpm db:plan:<preprod\|prod> --out <plan.json> --expect-project <ref> [--json]` | Solo lectura: escribe en `.biblib/plans/` un plan `kind: migrate` o `kind: adopt-ledger`. No crea ledger ni objetos. |
| `pnpm db:migrate:<preprod\|prod> --plan <plan.json> --expect-project <ref> --expect-plan <sha256> --backup-receipt <recibo.json> [--json]` | Aplica exactamente los pendientes del plan vigente. |
| `pnpm db:adopt:<preprod\|prod> --plan <plan.json> --expect-project <ref> --expect-plan <sha256> --backup-receipt <recibo.json> [--json]` | Operación excepcional: escribe solo las filas del ledger de un esquema equivalente demostrado. No es un alias de migrate. |

`<ref>` es la referencia del proyecto Supabase (minúsculas y dígitos), no una URL ni una contraseña. Los planes caducan a los **30 minutos**. `db:backup:prod` sigue saliendo con **2**: el respaldo remoto real depende del plan del proveedor (ver «Condiciones abiertas»).

| Salida | Significado en estos comandos |
| --- | --- |
| 0 | Completado. |
| 2 | Argumentos malformados o incompletos: falta `--expect-project`/`--plan`/`--expect-plan`, `--force`, `--profile`, URL o flag no admitido, variables ausentes. |
| 3 | Identidad: referencia, URL pública de Auth, host, rol, base, pooler sin referencia o en modo transacción, **sin TLS `verify-full`**, certificado que no corresponde al host, réplica, rol sin permisos, plan o recibo de otro destino. |
| 4 | Postgres remoto anterior a 15. |
| 5 | Historial u objetos divergentes, drift, adopción requerida o no demostrable, datos incompatibles con `0001`/`0002`. |
| 6 | Plan caducado, alterado, de otro tipo/commit/journal o head; recibo ausente, alterado, caducado (más de 24 h), sin ensayo superado o de otro head/esquema. |
| 7 | Otro runner mantiene el bloqueo consultivo tras 30 s. |
| 8 | Conexión o servicio no disponible; prerrequisitos de plataforma (`auth.users`, `auth.uid()`, roles) ausentes. |
| 9 | Migración fallida: la transacción se revierte y el ledger no avanza. |
| 11 | Aplicado, pero la verificación posterior (ledger, manifest o esquemas de plataforma) falló. No se reaplica. |
| 130 | Interrupción: se cierra la conexión y la transacción se revierte. |

## Configuración inyectada del destino

Cada ejecución recibe en su entorno, y solo en él:

| Variable | Valor esperado |
| --- | --- |
| `BIBLIB_EXPECT_PROJECT_REF` | Referencia del proyecto. Debe coincidir con `--expect-project`. |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` (URL pública de Auth/API). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clave pública del proyecto (el runner no la usa para conectar; se valida su presencia como en el resto de objetivos). |
| `SUPABASE_DB_URL` | Conexión administrativa, sin parámetros: `postgresql://postgres:<credencial>@db.<ref>.supabase.co:5432/postgres` (directa) o `postgresql://postgres.<ref>:<credencial>@<región>.pooler.supabase.com:5432/postgres` (pooler en **modo sesión**). |
| `SUPABASE_DB_SSLMODE` | `verify-full`. Cualquier otro valor o su ausencia sale con **3**. |
| `SUPABASE_DB_SSLROOTCERT` | Opcional: ruta absoluta a la CA del proveedor (archivo regular, sin enlaces). Sin ella se usan las CA del sistema; la verificación del nombre se mantiene. |

### Archivo privado del destino (`.biblib/remote/<objetivo>.env`)

Para no inyectar las variables a mano, `db:status|plan|migrate|adopt:<preprod|prod>` cargan `.biblib/remote/<objetivo>.env` si existe (`scripts/db/remote-env.mjs`). Está bajo `.biblib/`, fuera de Git y del camino de carga de Next.

- **Generarlo desde Vercel:** `pnpm db:remote-env:prod` (o `:preprod`) ejecuta `vercel env pull` del entorno `production` (o `preview`) en una carpeta temporal y conserva solo lo necesario. Deriva `BIBLIB_EXPECT_PROJECT_REF` de la URL pública, fija `SUPABASE_DB_SSLMODE=verify-full` y, si la conexión de la aplicación es el pooler en modo transacción (6543), usa el modo sesión (5432) del mismo pooler con la misma credencial. Requiere el repo enlazado (`vercel link`). Las variables marcadas como sensibles en Vercel no se pueden descargar: en ese caso se escriben a mano en el archivo.
- **CA:** si existe `.biblib/remote/<objetivo>-ca.crt` (certificado descargado del panel de Supabase, Database → SSL), se usa como `SUPABASE_DB_SSLROOTCERT`. Una ruta relativa en el archivo se resuelve desde `.biblib/remote/`.
- **Reglas:** solo admite `BIBLIB_EXPECT_PROJECT_REF`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, `SUPABASE_DB_SSLMODE` y `SUPABASE_DB_SSLROOTCERT`; otra clave, una repetida, un enlace o (fuera de Windows) permisos distintos de 600 salen con error. Si la sesión ya inyecta alguna de esas variables, también: nunca se mezclan dos fuentes. `--expect-project <ref>` sigue siendo obligatorio como confirmación explícita del destino.

### Contrato de identidad remota

Antes de abrir ninguna conexión (`scripts/db/remote-preflight.mjs`, `describeRemote`):

1. El objetivo es `preprod` o `prod` y `--expect-project` coincide con `BIBLIB_EXPECT_PROJECT_REF`.
2. La URL pública de Auth es `https://<ref>.supabase.co` y la conexión administrativa es del mismo proyecto: host `db.<ref>.supabase.co` con rol `postgres`, o usuario `postgres.<ref>` del pooler. **Un pooler regional por sí solo no identifica el proyecto**: `postgres@<región>.pooler.supabase.com` sale con **3**. El pooler en modo transacción (6543) también: no conserva el bloqueo de sesión ni es apto para DDL.
3. Base `postgres`, credencial presente y TLS `verify-full`. El certificado se verifica contra `db.<ref>.supabase.co` (o el host del pooler); un certificado de otro nombre, autofirmado no confiable o un servidor sin TLS salen con **3** sin enviar consultas.
4. La huella del destino es `sha256` de `{target, project, host, port, database, user}`: no incluye credenciales ni depende del checkout.

Ya conectado, dentro de una transacción `read only` (`probeRemote`): la sesión usa TLS según el propio servidor (`pg_stat_ssl`), el rol es `postgres`, el destino es el primario, puede crear esquemas, pertenece a los propietarios de `biblib`/`drizzle` y de sus objetos y puede referenciar `auth.users`. Avisa si faltan los esquemas de plataforma o si el major no es el local (17); un major anterior a 15 sale con **4**.

## Procedimiento de promoción (preproducción primero)

Cada paso se ejecuta desde un checkout limpio en el commit aprobado, con las dependencias del lockfile. Preproducción y producción tienen planes, respaldos, recibos y registros **distintos**: nunca se reutiliza un plan o un recibo de otro destino (lo impiden la huella y `--expect-project`).

0. **Precondiciones.** Autorización explícita de Néstor para ese proyecto y esa ventana. CI verde en el commit: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:scripts`, `pnpm test:db` y `pnpm test:integration:local` (U-QA-01). La aplicación que exige `catalogue`, `version`, el trigger y las tablas de `0003`/`0004` no se publica antes que su esquema.
1. **Estado.** `pnpm db:status:preprod --expect-project <ref>`. Debe mostrar identidad, TLS y rol correctos. Si informa `adoption-required`, sigue la sección de adopción. `diverged`, `reconciliation-required` o `drift` detienen la promoción (**5**).
2. **Plan revisado.** `pnpm db:plan:preprod --out preprod.json --expect-project <ref>`. Revisa en el JSON: `descriptor`, `remote` (versión, rol), `appliedHead`, `pending`, `ddlSummary`, `risks`, `dataPreflight` y `planHash`. Todas las pendientes van en **una transacción**. `0001` añade restricciones sobre datos existentes y `0002`–`0004` bloquean `biblib.books` durante la transacción: planifica una ventana sin escrituras.
3. **Datos incompatibles (antes de `0001`/`0002`).** Si la revisión encuentra fichas con estantería de otro propietario, páginas fuera de 0–100000, títulos vacíos o demasiado largos, o estanterías con nombre fuera de 1–120, el plan sale con **5**, no se escribe y deja un listado restringido en `.biblib/plans/<plan>.corrections.json`: ID de fila, propietario seudonimizado y corrección propuesta, sin títulos ni ISBN. Los duplicados por ISBN o nombre normalizado son avisos que no bloquean. Las correcciones se revisan con su propietario y se aplican aparte, de forma explícita; después se repite el plan.
4. **Detener escrituras.** Para la aplicación o actívala en modo de solo lectura desde aquí hasta verificar.
5. **Respaldo y ensayo.** Respaldo administrativo del destino conforme a U-OPS-02 y restauración ensayada en una copia aislada, con su recibo (`receipt.json`, ver más abajo). El recibo debe ser de **este** destino y de su head actual, tener menos de 24 h y un ensayo superado.
6. **Plan vigente.** Si el plan del paso 2 caducó, genera otro y comprueba que pendientes y hashes son los revisados. Un plan nuevo con otros pendientes exige volver a revisar.
7. **Aplicación explícita.** `pnpm db:migrate:preprod --plan .biblib/plans/preprod.json --expect-project <ref> --expect-plan <sha256> --backup-receipt <ruta>/receipt.json`.
   - Antes de conectar: tipo de plan, hash, caducidad, proyecto, huella, commit, versión de Drizzle y bytes del journal; recibo (destino, head, alcance, cobertura, estrategia, archivos, ensayo y antigüedad).
   - Conectado: rol, TLS y permisos. Toma el **bloqueo consultivo común** (`MIGRATION_LOCK_KEY`) y relee ledger y manifest: si el head o los pendientes no son los del plan sale con **6**. Comprueba que el ledger y los hechos de catálogo siguen siendo los del respaldo (**6** si cambiaron) y toma la huella de `auth`/`storage`.
   - Aplica con el migrador de Drizzle en una transacción; verifica ledger, manifest completo y que `auth`/`storage` no cambiaron.
8. **Verificación.** `pnpm db:status:preprod --expect-project <ref>` → `up-to-date`, sin drift. En preproducción: sesiones de las cuentas de prueba A y B, aislamiento entre ambas y acciones de edición, importación y conflicto de versión. Conserva el registro de promoción.
9. **Abrir tráfico** solo con la autorización correspondiente.

**Producción:** repite los pasos 0–9 con `prod`, su referencia, su plan, su respaldo y su recibo, después de verificar preproducción con el mismo commit.

### Dos ejecuciones a la vez

Dos promociones con el mismo plan no aplican dos veces: la segunda espera el bloqueo (máximo 30 s, **7**) y, al obtenerlo, encuentra otro head y sale con **6** sin tocar nada. Repetir un plan ya aplicado también sale con **6**. Ensayado: una ejecución termina con 0 y la otra con 6, con una sola fila de ledger por migración.

## Adopción excepcional del historial

Para un destino con esquema `biblib` y sin ledger propio (aplicado a mano, con otra herramienta o con el historial en el `drizzle` compartido):

1. `db:status` informa `adoption-required` y si la adopción es demostrable. `db:plan` compara los metadatos del destino con cada prefijo del journal: tablas y columnas exactas (nombre, tipo, nulabilidad), RLS, políticas (comando, roles, expresión normalizada), grants, PK/FK/checks, índices, función `rotate_book_version` y triggers, y ausencia de objetos de migraciones posteriores. Coincidir solo en nombres de tablas no basta.
2. Si un único prefijo es equivalente, el plan es `kind: adopt-ledger`, con la evidencia por migración (comprobaciones superadas), las filas exactas del ledger (tag, hash y `created_at` en orden), la huella de los hechos y los pendientes que quedarían. Si no, sale con **5** y propone la conciliación: el prefijo más cercano y cada diferencia (por ejemplo, «falta el trigger `books_rotate_version`»), con dos opciones: corrección hacia delante revisada en una copia aislada, o restaurar el respaldo ensayado.
3. Respaldo y ensayo del destino tal como está (head vacío).
4. `pnpm db:adopt:<target> ... --backup-receipt <recibo>`. Bajo el bloqueo común relee el destino; exige que siga sin ledger y con los mismos hechos que el plan (**6** si cambiaron, **5** si ya no es equivalente). Solo crea `biblib_migrations.__drizzle_migrations` (ledger propio de BibLib; `drizzle.__drizzle_migrations` es de otra app del proyecto compartido) con la definición de Drizzle si falta y escribe sus filas; dentro de la misma transacción comprueba que el resultado es un historial coherente con el manifest. No ejecuta DDL de negocio ni acepta `--force`.
5. El head cambió: haz un **respaldo nuevo** del head adoptado y vuelve al paso 2 del procedimiento normal para los pendientes. Un plan `adopt-ledger` no sirve para `migrate` ni al revés.

Un ledger con hashes calculados sobre CRLF (`reconciliation-required`) no se adopta automáticamente: requiere documentar la equivalencia de bytes y una decisión explícita.

## Recibo de respaldo (`--backup-receipt`)

Documento `kind: biblib-backup-receipt` sellado (`receiptHash`). `pnpm db:backup:local` lo escribe junto al manifiesto (`.biblib/backups/<backupId>/receipt.json`) y `pnpm db:backup:local --receipt-of <carpeta>` lo reemite tras un `db:restore:verify` superado. Contiene:

- `backupId`, fechas, objetivo (`target`, `project`) y `fingerprint` del destino; commit.
- `migrations`: head, migraciones aplicadas, `ledgerHash` y hash del journal.
- `scope`: `schema`, `data`/`domain`, `history`/`ledger`, `auth`, `storage` y, en local, `mailpit`.
- `strategy`: cómo se cubren Auth (identidades; sesiones y tokens fuera), Storage (bytes con sha256) y la configuración (Auth/OAuth/SMTP/JWT y claves se reconfiguran desde el gestor de credenciales; nunca viajan en el respaldo).
- `objects`: huella de los hechos de catálogo y cobertura (`rls`, `policies`, `grants`, `constraints`, `indexes`, `functions`, `triggers`).
- `files`: inventario con rutas relativas a la raíz y sha256; `manifest` con su `contentHash`.
- `discardedStateHash`: la misma huella del estado que calcula el plan de `db:reset:local` (dominio, Auth, Storage, ledger y Mailpit). Así su `--backup-receipt` acredita exactamente el estado que se descarta.
- `restoreVerification`: informe del último ensayo superado con su sha256.

Un JSON de cuenta (`/settings`) no es un recibo. En la promoción, el recibo de otro destino sale con **3**; ausente, alterado, incompleto, de otro head, de más de 24 h o sin ensayo superado, con **6**. Bajo el bloqueo se exige además que el ledger y los hechos de catálogo del destino sean los del respaldo.

El recibo de un respaldo **local** solo es aceptable para `db:reset:local` después de ensayar su restauración en otro stack (el ensayo exige un destino vacío o recién reseteado). Con un único perfil disponible, el reset del mismo stack se hace con `--discard-local-data` y el respaldo previo se ensaya después, como en la evidencia.

## Registro de promoción

Cada intento que supera la lectura del plan deja `.biblib/promotions/<fecha>-<target>-<plan>-<id>.json` (fuera de Git): operación (`migrate` o `adopt-ledger`), destino redactado (proyecto, huella, host, base, rol, TLS), commit, `planHash`, head antes y después, migraciones intentadas, respaldo (`backupId`, `receiptHash`, fecha y ensayo), huella de `auth`/`storage` antes y después, resultado, código y fase. No contiene credenciales, URLs con usuario, tokens ni filas de bibliotecas. Conserva estos registros junto a la evidencia de la ventana.

## Escrituras posteriores al respaldo

El respaldo refleja el destino en su `createdAt`. Si hubiera que restaurarlo, **se pierde todo lo escrito después**: fichas, estanterías, importaciones confirmadas, revisiones de colección, altas y cambios de cuenta en Auth, objetos Storage y entradas de la caché/cuota de catálogo. Por eso:

- Las escrituras se detienen **antes** del respaldo (paso 4) y no se reabren hasta verificar (paso 8).
- La promoción comprueba que ledger y esquema no cambiaron desde el respaldo, pero **no** puede detectar escrituras de datos de la aplicación: detenerla es responsabilidad de la ventana.
- Si se restaurase, se aplican las supresiones de cuentas posteriores (U-OPS-03), se rotan los tokens de concurrencia (lo hace `db:restore:local`) y se decide qué escrituras se recuperan por otra vía antes de abrir tráfico.

## Ante un fallo

- **9 (migración fallida):** la transacción se revirtió y el ledger no avanzó. Corrige la causa con una migración o corrección revisada y genera un plan nuevo. No se repite el SQL a mano.
- **11 (verificación):** no reapliques. Diagnostica con `db:status`; decide corrección hacia delante o restauración ensayada.
- **5 (drift o adopción no demostrable):** sigue la conciliación propuesta. Nunca se reaplica una migración antigua ni se borra el ledger.
- **Restauración:** solo desde el respaldo ensayado, en el procedimiento de [Recuperación](recuperacion.md). Tras restaurar, `status` debe mostrar ledger, RLS, políticas, función y trigger coherentes antes de reintentar.
- No se degradan RLS ni se retiran restricciones para que arranque una versión anterior de la aplicación.

## Ensayo local

- `tests/scripts/promotion.test.mjs` (sin Docker): identidad, TLS, pooler, argumentos, planes de otro commit/tipo/destino, adopción con metadatos reales capturados de Supabase local (`tests/fixtures/migrations/objects-000{2,3,4}.json`) y drift, recibo aceptado por `db:reset:local` y rechazos del recibo en la promoción.
- `tests/scripts/promotion-stack.test.mjs` (`[stack]`, Docker): arranca un `postgres:17-alpine` propio, etiquetado `biblib.unit=u-inf-07-ensayo`, con certificado autofirmado para `db.<ref>.supabase.co` y el sustituto mínimo de Auth de `test:db`. El runner verifica el certificado contra ese nombre; solo la resolución del host se redirige a `127.0.0.1` mediante una dependencia que la CLI no expone. El respaldo del «remoto» y su ensayo de restauración usan un productor de recibos **solo de ensayo** (`tests/scripts/promotion-harness.mjs`). Cubre identidad/TLS/plan/recibo erróneos sin DDL, copia equivalente a `0000` con datos A/B, datos incompatibles, adopción de un esquema manual de `0002`, drift sin trigger, fallo transaccional, restauración y concurrencia. Se omite con `BIBLIB_SKIP_STACK_TESTS=1` o sin Docker. Con `BIBLIB_INF07_EVIDENCE=<carpeta>` deja la evidencia.
- En `scratch`, con las herramientas de U-OPS-02: respaldo con recibo, fallo (drift), reset, restauración y verificación con sesiones GoTrue reales de A y B.

## Condiciones abiertas antes de la primera promoción real

| Condición | Estado |
| --- | --- |
| Autorización de Néstor para cada proyecto y ventana | **Pendiente.** Sin ella no se ejecuta ningún comando remoto, tampoco `status`. |
| Identidad real | Producción: proyecto existente, referencia **no inspeccionada**. Preproducción: **no configurada**. Hay que fijar la referencia de cada una y comprobar que la URL pública y la conexión administrativa son del mismo proyecto. |
| Estado real de la base | **No inspeccionado.** Puede tener ledger de `drizzle-kit` (con o sin hash CRLF), un esquema manual sin ledger o datos incompatibles con `0001`. `status`/`plan` lo determinarán en solo lectura. |
| Plan del proveedor | **No se presupone PITR** ni la descarga de backups. Hay que saber qué respaldo ofrece el plan contratado, su retención y cómo se restaura en un proyecto aislado. Los backups de base no incluyen los bytes de Storage. |
| Respaldo remoto (`db:backup:prod`) | **Pendiente** (U-OPS-02 + proveedor): debe producir un recibo con este contrato. El productor del ensayo no es apto para producción. |
| Permisos del rol | En Supabase alojado, `postgres` no es superusuario: comprobar propiedad de `biblib`/`drizzle`, `CREATE` en la base y `REFERENCES` sobre `auth.users` (lo comprueba `status`). |
| Conectividad y TLS | La conexión directa puede ser solo IPv6 según el proyecto; el pooler en modo sesión es la alternativa IPv4. Fijar la CA del proveedor en `SUPABASE_DB_SSLROOTCERT` si las CA del sistema no la incluyen. |
| Versión de Postgres | Local 17; comprobar el major remoto (aviso si difiere) y ensayar en una copia de ese major. |
| Pruebas en preproducción | Sesiones A/B, edición, importación y conflicto de versión contra el destino real: pendientes de que exista preproducción. |
| Automatización (U-QA-04) | La CI conectará después este contrato; no es requisito para usar los comandos manualmente. |

## Aceptación de U-INF-07

| # | Criterio | Local (simulado) | Real |
| --- | --- | --- | --- |
| 1 | Sin ref, con host/rol incorrectos, plan de otro commit/head o respaldo no válido, `migrate` aborta antes de DDL | Demostrado (11 rechazos con 3/6, ledger y objetos sin cambios) | Pendiente |
| 2 | `plan` de solo lectura, sin ledger ni objetos; lista pendientes y deriva la adopción | Demostrado | Pendiente |
| 3 | Desde una copia equivalente a `0000`: conserva IDs/datos y aplica `0001`…`0004`; manifest de catálogo, FK, RLS y versión | Demostrado (datos A/B sintéticos) | Pendiente |
| 4 | Base modificada no se declara compatible ni se repara; adopción explícita distinta de migrar | Demostrado (drift sin trigger → 5; adopt solo ledger) | Pendiente |
| 5 | Usuarios A/B: aislamiento y sesiones válidas; edición/importación/conflicto en preproducción | Aislamiento con claims en el remoto simulado; sesiones GoTrue reales A/B en `scratch` tras restaurar | **Pendiente (requiere preproducción)** |
| 6 | Registro de promoción sin tokens; dos ejecuciones no aplican el mismo plan | Demostrado | Pendiente |
| 7 | Claims/rol locales a la transacción; `auth`/`storage` intactos | Demostrado (huella de plataforma igual antes/después) | Pendiente |
| 8 | Recuperación ensayada con esquema, RLS, trigger e historial coherentes; pérdida de escrituras conocida | Demostrado (remoto simulado y `scratch`) | Pendiente |

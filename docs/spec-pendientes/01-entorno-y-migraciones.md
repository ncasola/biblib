# Entorno local, migraciones y promoción de BibLib

**Estado: especificación propuesta, pendiente de implementación. Consulta de fuentes: 22 de octubre de 2026.** Este documento define siete unidades de trabajo. Las fases son orientativas; las olas y su secuencia conjunta se determinan en el índice del plan. No implica autorización para migrar una base remota ni fija fechas de entrega.

La [auditoría original](../auditoria-2026-10-22.md) describe problemas anteriores. El punto de partida efectivo está en [mejoras implementadas](../implementacion-2026-10-22.md) y [operación actual](../operacion.md). Se conservan las correcciones y las pruebas existentes; no se vuelven a presentar como trabajo pendiente.

## Situación comprobada y referencia consultada

| Tema | BibLib actual | Trabajo propuesto |
| --- | --- | --- |
| Infraestructura local | Pruebas con Postgres Docker efímero y un sustituto mínimo de Auth; smoke con Auth HTTP simulado. | Supabase local independiente: Postgres, GoTrue, Storage, Studio y Mailpit reales. Las suites rápidas actuales siguen siendo complementarias. |
| Esquema | Drizzle mantiene `lib/db/schema.ts`, SQL `0000`, `0001`, `0002`, journal y snapshots. `0002` incluye una función/trigger de versión escritos en SQL. | Mantener ese historial, con un único aplicador y comprobación explícita de los objetos SQL que no representa el snapshot de tablas. |
| Ejecución de migraciones | `db:migrate` invoca Drizzle Kit; `drizzle.config.ts` intenta cargar `.env.local` y `.env`. | Objetivos explícitos, planes previos, guardas de identidad y separación local/preproducción/producción. |
| Autenticación | Producto con Google; sesiones comprobadas por Supabase dentro de las acciones. | Fixtures con sesiones reales de GoTrue local, sin introducir un endpoint que acepte un usuario arbitrario. Google externo sigue siendo una comprobación conectada adicional. |
| Entornos | Variables Supabase consumidas por servidor y cliente; las públicas se incorporan al build. | Carga aislada de configuración y artefactos separados por objetivo. `NODE_ENV=production` no significa «base de producción». |
| Respaldo | Exportación de colecciones, fragmentación y guía administrativa; sin recuperación real del proveedor ensayada. | Contrato de respaldo/ensayo con `U-OPS-02`, obligatorio para la primera promoción remota. |

Se consultaron, solo mediante lectura, los siguientes archivos de `C:/Users/ncaso/Trabajo/Codigo/holaerp-web`:

- `supabase/config.toml`: `project_id = "holaerp"`; API 54321, Postgres 5432, shadow 54320, Studio 54323 y Mailpit 54324. Usa Postgres 17, Storage y Auth locales.
- `package.json`: dependencia Supabase CLI 2.117.0, comandos locales y wrappers de migración/seed por entorno.
- `.agents/skills/holaerp-local-database/references/local-database.md`: responsabilidad única de migraciones, servicios locales completos y fixtures con identidades reales.
- `apps/api/scripts/db-migrate.mjs`, `db-migration-journal-guard.mjs` y `scripts/db/local-sql-runner.mjs`: selección explícita de objetivo, acceso TCP y validación del journal.
- `scripts/db-local-rebuild.mjs`: camino antiguo para otro Postgres/volumen, distinto del flujo Supabase descrito en la guía. No se toma como receta de BibLib.

Se reutilizan las ideas de aislamiento, wrappers y validación; no se copian migraciones, secretos, tenants, esquemas, buckets ni excepciones del historial de HolaERP. Tampoco se adopta su base compartida ni sus comandos remotos de truncado/seed. No se han leído archivos `.env` reales, arrancado/parado servicios ni ejecutado migraciones o pruebas durante esta especificación.

## Decisiones comunes

### Un propietario del esquema y un historial de aplicación

**Drizzle será el único aplicador del esquema de negocio, tanto local como remoto.** La CLI de Supabase administra los servicios de plataforma. El flujo de BibLib no aplica SQL de negocio mediante `supabase db push`, `supabase migration up`, `db diff --apply` ni SQL repetido en `supabase/migrations`.

Se mantiene `drizzle/0000_biblib_init.sql`, `0001_library_integrity.sql` y `0002_book_versions.sql`, sin squash ni renumeración. Las migraciones nuevas se añaden al final; una corrección posterior no modifica una migración ya aplicada. El ledger canónico será `drizzle.__drizzle_migrations`, fijado explícitamente al configurar el runner y conservando el historial existente. Drizzle documenta la configuración del esquema y tabla de registro en su [referencia de migraciones](https://orm.drizzle.team/docs/drizzle-config-file#migrations).

`supabase/migrations/` permanece vacío de SQL de negocio. La configuración local deshabilita las migraciones de usuario y el seed automático del CLI; no deshabilita las migraciones internas que sus servicios necesitan para crear `auth` o `storage`. La forma prevista, que deberá validar la versión fijada de CLI, es:

```toml
[db.migrations]
enabled = false
schema_paths = []

[db.seed]
enabled = false
sql_paths = []
```

El seed de BibLib se ejecuta después del runner de Drizzle. No habrá una segunda copia de los SQL, ni un segundo ledger de negocio en `supabase_migrations.schema_migrations`. La separación importa porque [Supabase registra sus propias migraciones de usuario en esa tabla](https://supabase.com/docs/guides/deployment/database-migrations).

### Stack y puertos propuestos

La configuración inicial usará los comandos estables clásicos de Supabase y Docker. No activa el mecanismo experimental `supabase stack`: tiene otras reglas de identidad y flags, documentadas como experimentales por el proveedor en [múltiples proyectos locales](https://supabase.com/docs/guides/local-development/running-multiple-local-projects). Su adopción futura requeriría una decisión y ensayos propios, no una sustitución silenciosa del comportamiento.

| Servicio | BibLib principal propuesto | Referencia que se evita |
| --- | --- | --- |
| Identidad de proyecto | `biblib-local` | `holaerp` |
| Aplicación Next.js | `127.0.0.1:3147` | Puertos de desarrollo de los otros repositorios |
| Shadow de Postgres | 55320 | 54320 |
| API/Auth/REST/Storage | `127.0.0.1:55321` | 54321 |
| Postgres | `127.0.0.1:55322`, base `postgres` | 5432 y 54322 |
| Studio | `127.0.0.1:55323` | 54323 |
| Mailpit web | `127.0.0.1:55324` | 54324 |
| SMTP/POP de pruebas | 55325/55326, solo si se habilitan | 54325/54326 |
| Analytics | 55327 reservado; deshabilitado inicialmente | 54327 |
| Inspector de funciones | 55328 reservado; funciones deshabilitadas inicialmente | Puertos por defecto de otros stacks |
| Pooler | 55329 reservado; deshabilitado inicialmente | 54329 |

Son reservas de diseño, no puertos cuya disponibilidad se haya comprobado. `doctor` debe detectar ocupación y puertos excluidos antes de arrancar; no termina el proceso que los ocupa. Un worktree adicional o una suite completa usa otro identificador, red, bloque de puertos y directorio de estado registrados. Nunca se conecta al stack principal por coincidir su nombre.

La red Docker será propia, por ejemplo `biblib-local-network`, con etiquetas de propiedad y publicación en loopback. La [guía oficial de desarrollo local](https://supabase.com/docs/guides/local-development) muestra una red con `com.docker.network.bridge.host_binding_ipv4=127.0.0.1` y el flag `--network-id`; el adaptador verificará los bindings reales en Docker Desktop y Linux. Imprimir una URL con `127.0.0.1` no demuestra por sí solo que un puerto esté aislado de la LAN.

### Entornos, claves y builds

Los objetivos admitidos por los wrappers serán `local`, `test`, `preprod` y `prod`; ninguno se deduce del hostname por sí solo o de `NODE_ENV`. El nombre canónico propuesto es `BIBLIB_TARGET`. Su valor se valida antes de abrir conexiones o crear clientes SDK.

- **Local:** archivo `.env.local` generado con valores del stack de BibLib verificado. Si ya existe y no está identificado como local de BibLib, se aborta sin sobrescribirlo. La transición desde una configuración anterior requiere conservarla fuera del camino de carga local y preparar un cambio revisable, sin volcar sus valores en consola.
- **Test:** entorno explícito construido por el harness, sin leer `.env`, `.env.local` ni secretos de la máquina. Usa su stack efímero y fixtures.
- **Preprod/prod:** variables inyectadas por el gestor de secretos/CI y descriptor de identidad del proyecto; no se cargan archivos locales como fallback. Un archivo remoto local, si se adopta para operaciones manuales, debe elegirse explícitamente, estar excluido de Git y no ser leído nunca por `dev:local`.
- **Procesos hijos:** se retiran las variables heredadas relevantes de Supabase/Postgres y se inyectan exclusivamente las seleccionadas. También se controla `SUPABASE_WORKDIR` y cualquier selector experimental del CLI. Un proceso local no puede terminar usando una URL remota heredada.
- **Carga automática de archivos:** antes de invocar Next o Supabase se detectan los `.env` que esas herramientas podrían cargar para ese modo. Un archivo no acreditado como configuración del objetivo seleccionado provoca rechazo antes del arranque; no basta con limpiar `process.env` y dejar que el hijo recupere valores remotos desde disco. Los builds de test/CI pueden usar un workspace temporal sin esos archivos, como hace el smoke actual. La configuración local incluye valores explícitos para las opciones públicas opcionales, por ejemplo Analytics desactivado, para impedir un fallback heredado.
- **Cliente:** `NEXT_PUBLIC_SUPABASE_URL` y la clave pública pertenecen al objetivo del build. Cada artefacto conserva su huella de configuración pública; no se reutiliza un build hecho para otro proyecto cambiando solo las variables al arrancar.
- **Secretos de servidor:** `SUPABASE_DB_URL`, credenciales administrativas de fixtures, `OPEN_LIBRARY_CONTACT` y `GOOGLE_BOOKS_API_KEY` nunca tienen prefijo `NEXT_PUBLIC_`. La clave de Google Books es opcional y vacía en la plantilla; el setup no activa facturación ni exige una cuenta de pago.
- **Catálogos:** `BIBLIB_CATALOGUE_MODE=fixture|live` será una opción de servidor coordinada con `U-BIB-01`…`U-BIB-05`. Local y test usan `fixture` por defecto, sin claves ni Internet. Activar `live` será explícito; no altera la autenticación. Las credenciales reales de Google OAuth son otro concepto y no se reutilizan como clave bibliográfica.

Las plantillas contienen solo marcadores/valores locales de demostración. La regla actual `.env*` exige excepciones explícitas en `.gitignore` para las plantillas que se decida versionar. `.env.local`, salidas completas de `supabase status`, tokens, dumps y credenciales de fixtures permanecen privados. `status` nativo puede incluir claves, según la [referencia oficial](https://supabase.com/docs/reference/cli/supabase-status); el wrapper solo publica una proyección sin secretos.

## Catálogo de comandos propuesto

Todos son contratos pendientes de implementar mediante Node `.mjs`, con argumentos estructurados y soporte PowerShell/Windows y Linux. No dependen de `export`, `source`, `cp`, `rm`, concatenación de comandos de shell ni de un `pnpm` global concreto. Se ejecutan binarios fijados del repositorio; un fallo de CLI no se corrige instalando automáticamente otra versión.

| Comando propuesto | Efecto y objetivo |
| --- | --- |
| `pnpm db:local:doctor` | Solo lectura: versiones, Docker, puertos, propiedad, configuración y requisitos. No arranca servicios ni aplica SQL. |
| `pnpm db:local:status [--json]` | Solo lectura: estados, endpoints sin credenciales, perfil y head del esquema. |
| `pnpm db:local:up` | Arranca solo los servicios propios y espera salud; no migra ni siembra. |
| `pnpm db:local:down` | Para solo el stack propio y conserva datos/volúmenes. |
| `pnpm db:local:bootstrap` | Preflight → stack → configuración local → Drizzle → seed → verificación; informa la fase fallida y permite repetir sin destruir. |
| `pnpm db:generate` | Generación offline de SQL/snapshot, sin seleccionar ni conectar una base. |
| `pnpm db:status:local` / `:preprod` / `:prod` | Introspección del ledger y manifest de objetos, sin cambios. |
| `pnpm db:plan:local` / `:preprod` / `:prod` | Plan de solo lectura con identidad, hashes, pendientes, riesgos y condiciones para aplicar. |
| `pnpm db:migrate:local` | Aplica el plan válido al stack local cuya propiedad está probada. |
| `pnpm db:migrate:preprod` / `:prod` | Aplica exclusivamente un plan aprobado para ese proyecto, head y commit, con respaldo conforme a `U-OPS-02`. |
| `pnpm db:seed:local` | Crea/actualiza únicamente los fixtures reconocidos del stack local; no modifica libros añadidos por el desarrollador. |
| `pnpm db:reset:local` | Destrucción local explícita, con plan y confirmación del proyecto; vuelve a migrar/sembrar tras reconstruir. |
| `pnpm dev:local` / `build:local` / `start:local` | Ejecutan Next con configuración local verificada y directorio de build propio. |
| `pnpm test:db` | Mantiene la prueba SQL rápida con Postgres efímero y Auth mínimo. |
| `pnpm test:integration:local` | Suite con plataforma completa y GoTrue reales; implementada y medida por `U-QA-01`. Si se conserva `test:supabase:local`, será alias de esta misma suite, no otro runner. |
| `pnpm test:smoke` | Mantiene el smoke aislado actual; la ampliación a GoTrue real se coordina con `U-QA-01/02`. |

El comando ambiguo actual `db:migrate` debe dejar de elegir destino mediante archivos heredados: fallará indicando los comandos explícitos disponibles. No habrá `db:reset:prod`, `db:truncate:prod` ni `db:seed:prod` como atajos de desarrollo. La promoción de datos de referencia, si un producto futuro la necesita, tendrá su propio contrato revisado.

Los comandos de respaldo/restauración administrativa pertenecen a `U-OPS-02`; esta especificación define sus entradas obligatorias para promover, no duplica otro runner. El token `--yes` solo elimina una pregunta de consola cuando se suministra un plan/identidad válidos; nunca desactiva las guardas.

### Argumentos y códigos de salida de los wrappers

Los nombres siguientes son el contrato propuesto del wrapper de BibLib, no flags atribuidos al CLI de Supabase. El sufijo del comando fija el destino; no se permite reemplazarlo con una URL arbitraria ni con un flag reenviado al proceso hijo.

| Operación | Argumentos y comportamiento |
| --- | --- |
| `db:local:doctor`, `db:local:status` | `--profile <nombre>` opcional, perfil principal por defecto; `--json` produce únicamente datos saneados. |
| `db:local:up`, `db:local:down` | `--profile <nombre>`; down conserva volúmenes. Perfil inexistente/ajeno es error, no selección por coincidencia de puerto. |
| `db:local:bootstrap` | `--profile <nombre>`; coordina plan/migración local y seed idempotentes. Una fase completada se verifica antes de omitirla al continuar. |
| `db:status:<target>` | `--json` opcional; consulta historial y objetos sin modificar el ledger. |
| `db:plan:<target>` | `--out <ruta>` obligatorio; escribe un plan saneado de tipo `migrate` con destino, head, commit y hashes. Nunca aplica el SQL. |
| `db:migrate:<target>` | `--plan <ruta> --expect-project <id> --expect-plan <sha256>`; requiere correspondencia exacta de identidad, tipo de plan, head y bytes de migraciones. Preprod/prod añaden `--backup-receipt <ruta>` obligatorio. |
| `db:adopt:<target>` | Operación excepcional de INF07: mismos argumentos de identidad/plan y recibo de respaldo, pero plan de tipo `adopt-ledger` con equivalencia demostrada. No es un alias de migrate ni acepta `--force`. |
| `db:seed:local` | `--profile <nombre>`; `--scale 100\|1000\|10000` para fixtures de capacidad. Cambia solo entidades de su censo, nunca todas las filas de la cuenta. |
| `db:reset:local --dry-run` | `--profile <nombre> --out <ruta>`; plan de tipo `reset-local`, solo diagnóstico. Incluye alcance, cantidades y huella del estado descartable. |
| `db:reset:local --apply` | `--plan <ruta> --expect-project <id> --expect-plan <sha256>`, más `--backup-receipt <ruta>` o `--discard-local-data`. No admite `--linked`, `--all` ni una URL de destino externa. |
| `dev:local`, `build:local`, `start:local` | `--profile <nombre>`; el wrapper traduce únicamente opciones admitidas de aplicación. Start comprueba la huella pública del artefacto. |

`<target>` admite `local`, `preprod` y `prod`; test obtiene su contexto del harness aislado. `<id>` es la identidad de stack local o referencia remota esperada, no una contraseña. Los planes operativos se guardan fuera de Git, por ejemplo en `.biblib/plans/`, y caducan inicialmente a los 30 minutos. Un plan de reset también se invalida si cambia su inventario de datos/objetos desde la revisión; la implementación define esa huella sin almacenar su contenido. Un plan viejo o de otro tipo siempre requiere generar y revisar otro, nunca una omisión con `--yes`.

| Salida | Significado del wrapper |
| --- | --- |
| 0 | Operación o diagnóstico solicitado completado. |
| 2 | Argumentos, target o configuración incompletos/malformados. |
| 3 | Identidad/propiedad de destino o artefacto incorrecta. |
| 4 | Requisito local ausente: CLI, Docker, herramienta o versión. |
| 5 | Historial, hash u objetos DB divergentes; adopción requerida. |
| 6 | Plan caducado/no coincidente, autorización operativa o recibo requerido ausentes. |
| 7 | Bloqueo ocupado o concurrencia que exige reintento acotado. |
| 8 | Conexión/servicio no disponible o salud fallida. |
| 9 | Migración fallida, sin éxito ni avance de ledger anunciado. |
| 10 | Seed/bootstrap falló en una fase de datos de prueba. |
| 11 | Verificación posterior fallida. |
| 130 | Interrupción solicitada; se registra la fase y se limpian solo recursos propios. |

Los errores `--json` incluyen código estable, fase, objetivo saneado y correlación, sin SQL con datos ni secretos. Capturar un fallo y devolver 0 para facilitar CI queda prohibido. Los adaptadores traducen los exit codes nativos a estos códigos y conservan el diagnóstico técnico en un canal privado saneado.

## Unidades de implementación

### U-INF-01 · Stack Supabase propio y configuración reproducible

**Objetivo:** disponer de la plataforma local completa sin tocar HolaERP ni otros proyectos. **Fase:** F0. **Tamaño:** M. **Hallazgos:** SEC-01, SEC-04/05, QA-01/02, OPS-02.

**Alcance y archivos:** crear `supabase/config.toml`, inventario de puertos/servicios y perfil local; fijar la dependencia CLI y su lockfile en `package.json`/`pnpm-lock.yaml`; documentar los requisitos de Docker y los recursos. La versión 2.117.0 observada en HolaERP es una referencia, no una instalación ejecutada ni una garantía de compatibilidad. Se elegirá una versión estable exacta tras validar sus flags y plantilla, sin `latest`.

Configurar Postgres 17 como base de desarrollo actual, sujeto a comprobar compatibilidad con el major remoto antes de promover. Activar Auth, Storage, Studio y correo local; desactivar inicialmente Analytics, pooler y funciones no usadas. La API no expone el esquema `biblib` por añadirlo a `api.schemas`: las acciones siguen siendo la vía del dominio. Las políticas RLS permanecen necesarias aunque no se exponga ese esquema por REST.

**Contrato:** manifest versionado de perfil con `projectId`, raíz real del checkout, red, puertos y servicios habilitados; su estado local identifica los recursos realmente creados. El perfil adicional de worktree/test tiene identidad y puertos diferentes; el principal no se reutiliza por defecto. Los SQL de negocio no se copian a Supabase.

**Dependencias:** ninguna unidad de este plan; requiere el entorno Docker del desarrollador disponible cuando se implemente.

**Aceptación verificable:**

1. Con un proceso ajeno ocupando cualquiera de los puertos reservados, el preflight rechaza el arranque y explica el conflicto sin detenerlo.
2. HolaERP puede seguir ocupando 5432 y 54320–54329 durante el arranque/parada de BibLib; ninguno de sus contenedores, redes, volúmenes ni datos cambia.
3. Los bindings publicados de BibLib están en loopback; `doctor` detecta una configuración que publique interfaces externas.
4. Studio inspecciona la base propia; Auth, Storage y Mailpit responden en endpoints derivados del perfil, no de URLs remotas.
5. El CLI no ejecuta SQL de negocio ni seeds antes del wrapper Drizzle, y un reinicio conserva los datos.

**Pruebas:** configuración de puertos/perfiles y bindings; arranque con puerto ocupado; coexistencia de dos perfiles; parada que conserva recursos; comprobación de ausencia de migraciones duplicadas. Se integran después en `U-QA-01/04`.

**Riesgos:** diferencias de plantilla/flags entre versiones, consumo de Docker y rangos de puertos excluidos en Windows. La documentación distingue `[local_smtp]` de nombres antiguos como `[inbucket]`; la implementación usa la plantilla de la versión fijada y prueba su lectura, sin trasladar a producción la configuración local.

**Rollout y recuperación:** añadir primero configuración/doctor sin cambiar el desarrollo existente; habilitar el nuevo perfil voluntariamente tras sus pruebas. Si falla el arranque, conservar logs sin claves y parar únicamente los recursos creados por ese intento. No borrar datos ni «arreglar» otros stacks.

### U-INF-02 · Selección explícita de entorno y separación de artefactos

**Objetivo:** impedir mezclas de endpoints locales/remotos, incluidas las variables incorporadas al JavaScript. **Fase:** F0. **Tamaño:** M. **Hallazgos:** SEC-01/05, QA-01, OPS-02.

**Alcance y archivos:** crear `scripts/db/environment.mjs`, contratos/configuración de objetivos y plantillas sin secretos; ajustar `drizzle.config.ts`, `next.config.mjs`, `package.json`, `.gitignore` y la guía operativa. Separar la configuración de generación de SQL de la de aplicación de migraciones.

**Contrato:** `loadTarget("local"|"test"|"preprod"|"prod")` devuelve un contexto validado que se pasa a los procesos hijos y al cliente SQL. Contiene URLs y credenciales en memoria; su método de presentación solo entrega valores redacted. Un `TargetFingerprint` combina identificador lógico, referencia de proyecto, host/puerto/base y raíz del perfil, sin incluir contraseñas. Un artefacto de Next conserva objetivo y huella pública, nunca los secretos.

Los builds locales y remotos usan salidas separadas, por ejemplo `.next-local`, `.next-preprod` y `.next-prod`, o directorios temporales equivalentes. Un proceso `start:local` rechaza un artefacto con huella pública de otro proyecto. El SDK de fixtures de seed no se importa en componentes cliente. Los proveedores bibliográficos usan fixtures por defecto en local/test; la selección y las claves opcionales se coordinan con `U-BIB-01`…`U-BIB-05`.

**Dependencias:** U-INF-01.

**Aceptación verificable:**

1. Si el shell hereda URLs/credenciales remotas y existe un `.env` anterior, `dev:local`, seed y migración local usan exclusivamente el perfil local, o abortan antes de conectar.
2. Un `.env.local` no reconocido no se sobreescribe. El wrapper ofrece instrucciones de transición sin imprimir su contenido.
3. `db:generate` funciona sin credenciales de base; no intenta cargar `.env.local` ni abrir una conexión.
4. Ningún bundle cliente contiene credenciales de Postgres, clave administrativa de fixtures o `GOOGLE_BOOKS_API_KEY`.
5. El mismo código puede construirse con `NODE_ENV=production` contra el Supabase de test, conservando `BIBLIB_TARGET=test`.
6. Un build local no puede iniciarse como producción remota ni viceversa; la configuración seleccionada queda identificada sin mostrar secretos.
7. Sin claves de catálogos y con salida a Internet bloqueada, las pruebas locales de fichas obtienen resultados reproducibles del fixture; activar proveedores reales exige `live` explícito.

**Pruebas:** matrices de herencia/precedencia, hostname engañoso y targets ausentes; paths con espacios; inspección de artefactos y mensajes; construcción de dos objetivos distintos; fixture sin red. Los casos de CI pertenecen a `U-QA-04`.

**Riesgos:** carga implícita de `.env` por Next/CLI, valores públicos fijados al compilar y exposición accidental de `status` completo. No se mitiga copiando secretos remotos dentro de un archivo local ni haciendo un reemplazo textual del bundle.

**Rollout y recuperación:** mantener intacta la configuración privada existente hasta que su transición esté revisada; introducir wrappers y cambiar los scripts de forma coordinada. Ante un error, recuperar la configuración privada preservada y usar el artefacto correspondiente, sin mezclar bases para hacer que el arranque funcione.

### U-INF-03 · CLI Node de ciclo de vida, estado y diagnóstico

**Objetivo:** ofrecer comandos locales previsibles, portables y con propiedad verificable. **Fase:** F0. **Tamaño:** M. **Hallazgos:** QA-01/02, OPS-01/02.

**Alcance y archivos:** implementar `scripts/local-stack.mjs`, helpers de procesos/red/estado, entradas del catálogo de comandos, pruebas enfocadas y documentación. El adaptador invoca el CLI fijado desde una raíz explícita y una red propia; no confía en el directorio actual de una terminal.

**Contrato:** salida estructurada sin secretos con `schemaVersion`, objetivo, huella, endpoints públicos, servicios, head y comprobaciones `{id,status,message}`. Los errores distinguen argumentos, requisitos, objetivo incorrecto, salud y fase de bootstrap. `doctor` y `status` son de solo lectura. Los comandos mutables conservan un registro de los identificadores de recursos propios para limpiar exclusivamente lo que crearon.

El contrato de `bootstrap` coordina llamadas idempotentes a `up`, generación del entorno, runner y seed. No sustituye sus verificaciones ni oculta fallos. Esta unidad entrega el lifecycle y el contrato de coordinación; la integración ejecutable completa de bootstrap se entrega en U-INF-06, después del runner y seed. `down` no usa `--all`, `docker compose down` de otros proyectos ni borrado global de volúmenes.

**Dependencias:** U-INF-01 y U-INF-02. No depende de que U-INF-04/05 estén implementadas para entregar lifecycle/doctor; U-INF-06 conecta después el contrato de bootstrap.

**Aceptación verificable:**

1. `doctor` no arranca Docker, no crea contenedores y no altera esquema/datos; informa CLI ausente, motor parado, puertos ocupados, claves requeridas ausentes y manifest incoherente.
2. `status --json` es parseable y no contiene contraseña, URL con userinfo, JWT, clave administrativa ni cuerpo de una colección.
3. `up` sobre el mismo stack sano no crea un segundo proyecto; sobre un recurso con identidad ajena aborta.
4. Un fallo de salud no se convierte en éxito con `--ignore-health-check`. El comando devuelve una fase fallida y recursos pendientes propios.
5. Windows y Linux ejecutan los mismos argumentos y rutas, incluidas carpetas con espacios. No se usa una cadena de shell para ejecutar o borrar archivos.
6. Interrumpir el arranque deja un estado que puede diagnosticarse y continuarse; no modifica recursos de HolaERP ni de otra ejecución de pruebas.

**Pruebas:** procesos/CLI simulados, errores de salud, interrupciones, estado parcial, red ajena y rutas con espacios; ensayo de los mismos contratos con el stack real en `U-QA-01`.

**Riesgos:** flags distintos entre el modo clásico y experimental, nombres internos del CLI y procesos huérfanos. Los nombres se resuelven mediante estado y metadatos comprobados; no se codifica el nombre de un contenedor ajeno ni se fuerza el cierre de un proceso por ocupar un puerto.

**Rollout y recuperación:** introducir primero diagnóstico y comandos de lectura; después up/down. U-INF-06 habilita el bootstrap completo cuando sus componentes estén listos. Si un comando queda a medias, `doctor` informa sus recursos sin destruirlos. Los registros de estado dañados se reconstruyen mediante inspección y confirmación de propiedad, no borrando todo Docker.

### U-INF-04 · Runner Drizzle canónico, plan y control del historial

**Objetivo:** aplicar una sola vez el SQL correcto y detectar divergencia antes de una escritura. **Fase:** F0. **Tamaño:** M. **Hallazgos:** SEC-04, BE-02/05, QA-02, OPS-02.

**Alcance y archivos:** crear `scripts/db/migrate.mjs`, `plan.mjs`, guardas del journal y manifest de objetos deliberados; adaptar `drizzle.config.ts` y scripts. Añadir reglas de finales de línea en `.gitattributes` para SQL/meta y nuevas migraciones. Los archivos existentes y sus entradas aplicadas se preservan.

**Contrato de plan:** documento versionado con objetivo/huella, commit, head aplicado y esperado, tags/hashes, lista ordenada de pendientes, resumen de DDL, objetos esperados, riesgos, prerrequisitos y hash del propio plan. Se obtiene mediante consultas de solo lectura y validación del historial; no se ejecuta SQL pendiente para «averiguar si funciona». Un ensayo de aplicación se hace sobre un destino de prueba separado.

El runner valida entradas consecutivas del journal, timestamps estrictamente crecientes, archivos presentes, ausencia de entradas retroactivas y coincidencia de hashes de todas las filas aplicadas. No basta con comparar el último timestamp: el migrador instalado decide pendientes mediante ese límite. Las migraciones nuevas deben tener los mismos bytes LF en Windows/Linux; un hash legacy calculado sobre CRLF requiere una conciliación explícita documentada, nunca reescritura automática del ledger.

El aplicador usa conexión administrativa dedicada con cierre garantizado, timeouts y bloqueo de migración común a todos los runners. Mantiene el comportamiento transaccional de Drizzle para el conjunto actual, cuyos SQL son transaccionales. Un futuro SQL no transaccional obliga a una ampliación explícita del contrato; no se añade una excepción local distinta de producción ni se capturan errores para continuar marcando éxito.

El manifest comprueba, además de las tablas/snapshots: RLS habilitado, políticas y roles/grants; FK de propietario e índices/checks; `biblib.rotate_book_version` y el trigger `books_rotate_version`, incluyendo evento, momento, tabla, función y semántica de rotación. La comprobación usa metadatos y semántica normalizada, no una comparación de pretty-print de PostgreSQL. El runner de dominio no crea versiones falsas de `auth.users`, `auth.uid()` ni `authenticated` cuando GoTrue ya los proporciona.

**Dependencias:** U-INF-02 y U-INF-03.

**Aceptación verificable:**

1. Una base Supabase local nueva recibe `0000` → `0001` → `0002` por Drizzle y registra una única fila por migración; repetir el comando no vuelve a aplicar DDL.
2. Un cambio en un SQL aplicado, un fichero ausente, un timestamp retroactivo o un hash no reconocido bloquea la aplicación antes de modificar el destino.
3. Dos runners simultáneos no aplican el mismo SQL ni compiten por la creación del ledger; la segunda ejecución espera de forma acotada o falla con diagnóstico.
4. Un error intermedio revierte el conjunto transaccional sin adelantar el ledger. El informe diferencia head anterior, cambio fallido y resultado.
5. `plan` sobre un esquema de negocio presente sin historial no lo considera una base vacía: emite «adopción de historial necesaria».
6. Eliminar o alterar un trigger/política mediante SQL produce drift aunque `db:generate` no proponga una nueva tabla. No se corrige reaplicando una migración antigua.
7. El plan y el runner usan los mismos tags y hashes en una instalación limpia de Windows y Linux.

**Pruebas:** journal, hashes, CRLF legacy y drift de función/política; carrera de dos migradores; fallo SQL transaccional y reintento; base vacía frente a esquema manual. `U-QA-01` verifica la equivalencia en Supabase real; la prueba SQL rápida se conserva.

**Riesgos:** Drizzle no representa todos los objetos SQL de plataforma; reglas de final de línea que cambien hashes históricos; un ledger añadido manualmente que no refleje el esquema. Toda adopción pasa por U-INF-07 y conserva evidencia.

**Rollout y recuperación:** comenzar con `status/plan` sobre fixtures; sustituir el comando ambiguo solo tras pruebas. Si aparece divergencia, detener la aplicación de cambios y generar el diagnóstico. La recuperación del esquema usa corrección hacia delante o el respaldo ensayado; no se improvisa SQL inverso ni se borra el ledger para repetir DDL.

### U-INF-05 · Seed local con GoTrue, Storage y correo reales

**Objetivo:** desarrollar y probar sin depender de Google ni de una base remota, conservando autenticación y permisos reales. **Fase:** F0. **Tamaño:** M. **Hallazgos:** SEC-04/05, UX-03/04, QA-01, OPS-02.

**Alcance y archivos:** crear `scripts/db/seed-local.mjs`, censo de fixtures versionado sin credenciales reales, adaptador de sesión de pruebas y muestras locales de catálogo/activos; documentar el acceso y los límites offline. No introducir usuarios de producción ni fotos de la biblioteca personal en el seed.

**Contrato:** crear dos cuentas de prueba A/B por API administrativa de GoTrue local, con correos `@biblib.test` y metadatos de fixture. Crear sus bibliotecas mediante un seed de dominio acotado a esos usuarios y registrar los IDs reales devueltos por Auth. El seed es idempotente por identidad/scope de fixture; no depende de que `auth.users.id` acepte un UUID impuesto desde el cliente ni modifica usuarios fuera del censo.

La credencial administrativa solo reside en el proceso de seed y su archivo privado de trabajo. La API [admin.createUser](https://supabase.com/docs/reference/javascript/auth-admin-createuser) está destinada al servidor; no se entrega una clave administrativa al navegador. El harness obtiene la sesión por `signInWithPassword` de GoTrue local y usa el adaptador SSR para cookies: JWT y refresh reales, sin una bandera «usuario autenticado», tokens fabricados o un login oculto dentro de la app publicada. El acceso humano sin Google puede abrirse mediante ese harness/perfil local documentado, sin añadir un bypass al producto.

Se crea un bucket privado **solo de fixtures**, `biblib-test-assets`, con un objeto pequeño y determinista. El ensayo básico verifica rechazo anónimo y acceso mediante URL firmada emitida por un proceso de prueba autorizado. Las políticas/buckets definitivos de portadas y avatares pertenecen a `U-DAT-10` y su unidad de producto; este seed no los decide ni los crea en producción. Mailpit captura un correo de GoTrue dirigido a un fixture, sin SMTP remoto. Los catálogos de ISBN usan respuestas de prueba gratuitas, sin red ni API keys.

**Dependencias:** U-INF-03 y U-INF-04. Coordinación de contratos de proveedores con `U-BIB-01`…`U-BIB-05`; no bloquea el seed mínimo de libros manuales.

**Aceptación verificable:**

1. Repetir seed conserva exactamente A/B, sus fixtures identificados y los libros ajenos al seed. Un fallo parcial se puede continuar sin crear cuentas duplicadas.
2. A y B consiguen sesiones válidas de GoTrue local; el servidor valida `getUser` real, y un token inválido no recibe acceso.
3. Renovar la sesión, actualizar el nombre y cerrar sesión funcionan sin el servidor Auth simulado de la suite rápida.
4. Con Internet bloqueado, el recorrido manual y las respuestas de catálogo fixture siguen funcionando; ningún correo sale a un destinatario real.
5. El fixture Storage es privado, se puede obtener con firma y aparece en Studio. No se confunde esta comprobación con políticas definitivas de activos por propietario.
6. La clave administrativa y las credenciales no aparecen en Git, HTML, logs generales ni capturas; las pruebas muestran solo usuarios/datos ficticios.
7. El comando rechaza una URL de HolaERP, una URL remota y un stack local sin propiedad BibLib, incluso si responde correctamente.

**Pruebas:** seed repetido/interrumpido, censo existente, sesión real/expirada/revocada, Storage y Mailpit. La matriz completa A/B/RLS corresponde a `U-QA-01`.

**Riesgos:** tener datos en `auth.users` no equivale a una identidad utilizable por GoTrue; insertar solo filas SQL no cubre contraseñas/identidades. No se utiliza `tests/db/bootstrap.sql` en un Supabase completo. Google OAuth puede configurar su callback local, pero sigue contactando con Google y requiere credenciales/registro externo, según la [guía oficial de Google](https://supabase.com/docs/guides/auth/social-login/auth-google). No se promete que ese proveedor funcione 100 % offline.

**Rollout y recuperación:** añadir primero cuentas/bibliotecas de fixtures claramente identificadas. Ante una ejecución incompleta, conservar el censo/IDs y continuar, no vaciar `auth` o `public`. La eliminación de fixtures actúa solo sobre el scope registrado; reset completo usa U-INF-06.

### U-INF-06 · Reset local con propiedad comprobada y reconstrucción única

**Objetivo:** recuperar un entorno limpio sin arriesgar otra base local o remota. **Fase:** F0. **Tamaño:** M. **Hallazgos:** QA-02, OPS-02.

**Alcance y archivos:** implementar el subcomando reset en los wrappers y su plan/recibo, estado de propiedad y pruebas de rechazo. Integrar también el bootstrap no destructivo completo con el contrato de U-INF-03 y los componentes de U-INF-04/05; su recibo marca fases y permite continuar tras un fallo. No copiar el rebuild antiguo de HolaERP ni sus rutas/volúmenes.

**Contrato:** antes de reset se verifica raíz real, perfil, `project_id`, contenedor/volumen/red registrados y sus bindings; URL de loopback con el puerto exacto del perfil; y marcador de identidad del proyecto local. Este marcador pertenece a metadatos operativos locales, no autoriza la aplicación ni sustituye la identidad de Docker. Comprobar solo `localhost` es insuficiente porque HolaERP también es local y un túnel podría conducir a una base remota.

El plan identifica qué se pierde: dominio, sesiones/usuarios locales, objetos Storage y mensajes de Mailpit según alcance efectivo del mecanismo elegido. Requiere respaldo local opcionalmente generado conforme a `U-OPS-02`, o una renuncia explícita y registrada solo para datos locales descartables. La confirmación incluye el identificador del proyecto; `--yes` exige el mismo plan y huella, sin permitir cambiar el target.

El mecanismo preferido es el reset local de la plataforma con migraciones/seed de usuario desactivados, seguido por Drizzle y seed del wrapper. La implementación comprobará que el ledger y el esquema de negocio se reconstruyen juntos. Si la versión fijada no garantiza ese resultado, se usará una reconstrucción física acotada de ese stack, documentando también qué activos elimina, sin aplicar SQL de negocio desde Supabase. El CLI distingue resets locales y remotos en su [referencia de reset](https://supabase.com/docs/reference/cli/supabase-db-reset); el wrapper no acepta `--linked`, un `--db-url` arbitrario ni opciones remotas reenviadas.

**Dependencias:** U-INF-03, U-INF-04 y U-INF-05.

**Aceptación verificable:**

1. URL local con puerto 5432, marcador `holaerp`, raíz distinta, red ajena, túnel no acreditado o contenedor no registrado: rechazo antes de parar, borrar o ejecutar SQL.
2. Un reset válido elimina únicamente el estado local autorizado, ejecuta Drizzle una vez y vuelve a crear fixtures; nunca deja el ledger antiguo sobre un esquema vacío.
3. Se pueden volver a iniciar sesión A/B mediante GoTrue y utilizar Storage/Studio/Mailpit después de la reconstrucción.
4. Los recursos de otro stack permanecen intactos y con los mismos IDs/datos. No existe un camino que invoque `stop --all`, prune o borrado de volúmenes por patrón.
5. Una interrupción se detecta; el comando no informa éxito antes de terminar migración/seed/verificaciones. Puede continuarse desde una fase conocida.
6. Toda eliminación de directorios calcula y verifica la ruta absoluta dentro del workspace temporal/estado propio. No atraviesa junctions ni usa otro shell para borrar rutas enumeradas en PowerShell.

**Pruebas:** URL de HolaERP/remota/puerto ocupado, falsificación de marcador aislada, estado parcial y confirmación incorrecta; pérdida/conservación de Storage según el plan; reset interrumpido y repetido; conservación de otro perfil. Las pruebas son exclusivamente contra stacks descartables.

**Riesgos:** confundir «reset SQL» con borrado de objetos/volúmenes, y mezclar los flags de comandos clásicos/experimentales. El recibo informa los recursos afectados y la copia de recuperación si existe; no presupone que parar un contenedor sea un backup completo.

**Rollout y recuperación:** introducir tras probar bootstrap y migración. Ante un fallo, mantener los recursos ajenos y el respaldo local intactos, diagnosticar la fase y reconstruir solo el perfil autorizado. La recuperación de datos que se decidió conservar se ensaya conforme al procedimiento de `U-OPS-02`.

### U-INF-07 · Adopción y promoción de migraciones a preproducción/producción

**Objetivo:** llevar el esquema preparado a la base de destino con identidad, respaldo y estado previo comprobados. **Fase:** F1. **Tamaño:** L. **Hallazgos:** SEC-04/05, BE-01/02, QA-01/02, OPS-02.

**Alcance y archivos:** ampliar el runner con descriptores remotos, preflight, planes/recibos y adopción excepcional de historial; adaptar scripts y guía de promoción. La configuración Supabase local no se publica automáticamente mediante `config push`, ni se usa `link` como selección implícita del destino Drizzle. La política del alojamiento, monitorización y recuperación recurrente pertenecen a `U-OPS-01/02/04`.

**Contrato de identidad remota:** exigir `preprod|prod`, referencia esperada de proyecto y huella del plan; correspondencia comprobada entre URL pública Auth y conexión administrativa de migración; descriptor de host/base/rol y TLS verificado. Un pooler regional no identifica por sí solo el proyecto. `doctor/plan` consultan el destino de forma no destructiva y comprueban rol, permisos necesarios, versión y conexión; las migraciones usan conexión adecuada para DDL/bloqueo, no el rol limitado de una sesión de aplicación.

**Contrato de promoción:** commit y dependencias fijados; plan vigente; revisión de los SQL; pruebas requeridas de `U-QA-01` y checks de CI disponibles; respaldo previo y ensayo de restauración conforme a `U-OPS-02`; bloqueo operativo que impida escrituras durante cambios incompatibles; aplicación; manifest y pruebas posteriores; autorización para abrir el tráfico. `U-QA-04` automatiza después este contrato; no es un requisito circular para entregar el runner. La app que exige `catalogue`, `version` y trigger no se publica antes de su esquema compatible. Cambios futuros usarán expansión/contracción cuando se necesite compatibilidad entre dos versiones.

El recibo de respaldo mínimo entrega `backupId`, huella del objetivo, fecha, head de migraciones, hash/inventario de archivos, alcance de datos/esquema/historial y referencia del ensayo de restauración. Debe acreditar RLS, grants, constraints, índices, función/trigger de versión y estrategia para Auth/Storage/configuración. Un JSON de usuario no cumple ese contrato. Un dump SQL no incluye por sí solo los bytes de Storage ni toda la configuración de Auth; el [dump de la CLI](https://supabase.com/docs/reference/cli/supabase-db-dump) tiene exclusiones que el procedimiento administrativo debe tratar expresamente.

**Adopción excepcional del historial existente:**

1. Leer el ledger y el manifest del destino sin modificarlos. Determinar si está vacío, al día, pendiente, divergente o si hay un esquema manual sin trazabilidad.
2. En un esquema manual, producir evidencia de equivalencia por cada SQL realmente aplicado, incluidas políticas, función/trigger y restricciones. Coincidir solo en nombres de tablas no basta.
3. Si se puede demostrar equivalencia, preparar una operación separada y revisable de adopción del ledger con tags/hashes/orden exactos; escribir únicamente ese registro bajo bloqueo y con respaldo. No ejecutar DDL ya presente para rellenar el historial.
4. Si no se demuestra equivalencia, detener la promoción y especificar una conciliación/corrección hacia delante. No marcar todas las migraciones como aplicadas ni importar excepciones legacy de HolaERP.
5. Volver a generar el plan y ensayar la actualización sobre una copia aislada antes de cualquier aplicación real.

La revisión previa a `0001/0002` comprueba referencias entre propietarios, rangos de páginas y longitudes/títulos, duplicados por identificador normalizado y existencia de los objetos esperados. Una incompatibilidad produce listado seguro/restringido de correcciones propuestas; no se reasigna ni elimina información en silencio. El estado real de la base remota sigue sin inspeccionarse en esta especificación.

**Dependencias:** U-INF-02, U-INF-04, U-QA-01 y U-OPS-02 en su entrega mínima de backup/ensayo. La automatización de promoción se conecta con U-QA-04; la entrega mínima de OPS debe preceder a esta unidad aunque su operación recurrente se amplíe en F4.

**Aceptación verificable:**

1. Sin objetivo/ref esperados, con host/rol incorrectos, plan de otro commit/head o respaldo no válido, `migrate:prod` aborta antes de cualquier DDL.
2. `plan:prod` usa solo lectura, no crea ledger ni objetos; lista pendientes y deriva la necesidad de adopción cuando corresponde.
3. La primera actualización desde un fixture/copia equivalente a `0000` conserva IDs/datos y aplica `0001/0002`; el manifest verifica catálogo, FK por propietario, RLS y rotación de versión.
4. Una base parcialmente modificada no se declara compatible ni se repara automáticamente. La adopción del ledger es una operación explícita distinta de migrar.
5. Después de aplicar, usuarios A/B de prueba demuestran aislamiento y sesiones válidas; las acciones de edición/importación y conflicto funcionan en preproducción.
6. La promoción registra objetivo, commit, hash de plan, head antes/después, backup/ensayo y resultado sin tokens ni bibliotecas completas. Dos ejecuciones no aplican simultáneamente el mismo plan.
7. Una conexión de aplicación real conserva los claims/rol locales a la transacción; el runner administrativo no altera el esquema `auth`/`storage` de plataforma para facilitar las pruebas.
8. Existe una ruta de recuperación ensayada con esquema, RLS, trigger e historial coherentes. El equipo sabe qué escrituras posteriores al respaldo se perderían o tendrían que recuperar.

**Pruebas:** preflight con identidades erróneas, planes obsoletos, permisos insuficientes y respaldo ausente; adopción de SQL manual y rechazo de drift; actualización sobre copia; fallo transaccional; validación posterior y ensayo de restauración. `U-QA-01/04` aporta los ejecutores, `U-OPS-02` el respaldo/restore; esta unidad conecta sus contratos.

**Riesgos:** configuración externa aún desconocida, DDL que bloquee tráfico, restauración que deje historial incoherente y cambios remotos fuera del runner. No se presupone que el plan del proveedor incluya PITR ni que un backup descargado permita una restauración íntegra sin pasos adicionales.

**Rollout y recuperación:** primero diagnóstico y ensayo sobre preproducción/copia aislada; después aplicar con autorización concreta al proyecto real y una ventana/release compatibles. Ante un fallo, detener escrituras si hace falta, distinguir aplicación/esquema y decidir corrección hacia delante o restauración ensayada. No degradar RLS ni retirar restricciones para hacer que una versión antigua arranque.

## Dependencias para el plan conjunto

| Unidad | Predecesoras | Entrega consumida por otras áreas |
| --- | --- | --- |
| U-INF-01 | — | Identidad/puertos/servicios para todo el entorno local. |
| U-INF-02 | U-INF-01 | Contextos aislados para UI, proveedores, jobs y scripts. |
| U-INF-03 | U-INF-01/02 | Lifecycle/doctor y proyección segura de estado. |
| U-INF-04 | U-INF-02/03 | Plan/runner/hashes/manifest para U-QA-01, U-OPS-02 y nuevas migraciones DAT/PRO/BIB. |
| U-INF-05 | U-INF-03/04 | GoTrue/Storage/Mailpit/usuarios A/B para U-QA-01 y ensayos de U-DAT-10. |
| U-INF-06 | U-INF-03/04/05 | Reconstrucción descartable segura para onboarding y suites completas. |
| U-INF-07 | U-INF-02/04, U-QA-01, mínimo U-OPS-02 | Adopción/promoción remota; automatización consumida por U-QA-04. |

F0 habilita trabajo fiable sin Internet y sin tocar producción. F1 resuelve integridad/adopción del destino. F2/F3 incorporan UI/producto sobre esos contratos. F4 amplía observabilidad, pruebas de recuperación periódicas y mantenimiento. La entrega mínima de respaldo de `U-OPS-02` se necesita antes de la primera promoción; no puede posponerse hasta la operación recurrente de F4.

## Fuentes y decisiones que siguen abiertas

Las URLs oficiales se consultaron el **22-10-2026**. Los flags y nombres de configuración deben contrastarse de nuevo con la versión exacta del CLI al implementar; no se han probado aquí.

| Fuente | Uso en la especificación |
| --- | --- |
| [Supabase: desarrollo local](https://supabase.com/docs/guides/local-development) | Docker y aislamiento de red en loopback. |
| [Configuración del CLI](https://supabase.com/docs/guides/local-development/cli/config) | Identidad, puertos y servicios del stack. |
| [Comandos del CLI](https://supabase.com/docs/reference/cli/supabase-status) | Estado, formatos de salida y necesidad de no imprimir secretos. |
| [Reset local/remoto](https://supabase.com/docs/reference/cli/supabase-db-reset) | Guardas contra destinos remotos y flags destructivos. |
| [Migraciones Supabase](https://supabase.com/docs/guides/deployment/database-migrations) | Diferencia entre el historial Supabase y el ledger canónico Drizzle. |
| [Múltiples proyectos locales](https://supabase.com/docs/guides/local-development/running-multiple-local-projects) | Diferencias y carácter experimental del mecanismo `stack`. |
| [Auth admin.createUser](https://supabase.com/docs/reference/javascript/auth-admin-createuser) | Creación administrativa de fixtures en servidor. |
| [GoTrue/Mailpit](https://supabase.com/docs/guides/local-development/cli/testing-and-linting) | Verificación de correos locales sin entrega externa. |
| [Google OAuth local](https://supabase.com/docs/guides/auth/social-login/auth-google) | Callback local y dependencia de credenciales/proveedor externo. |
| [Drizzle: configuración de migraciones](https://orm.drizzle.team/docs/drizzle-config-file#migrations) | Ledger configurable y preservación del historial existente. |
| [Dump Supabase](https://supabase.com/docs/reference/cli/supabase-db-dump) | Límites de un volcado frente al respaldo administrativo completo. |

Quedan por resolver durante las unidades, sin inspeccionar secretos para redactar este plan: versión exacta del CLI y sus flags probados; disponibilidad efectiva del bloque de puertos; major/identidad/historial reales de los proyectos remotos; permisos y conexión administrativa; método/coste/alcance de backup y restauración disponibles en el proveedor; cómo conciliar cualquier hash histórico con finales de línea legacy; y decisión final de buckets/políticas de activos en `U-DAT-10`. Son condiciones de cierre verificables, no motivos para mezclar las bases o afirmar que lo local ya reproduce Google externo.

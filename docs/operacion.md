# Operación y recuperación de BibLib

Esta guía describe cómo preparar y comprobar un entorno, aplicar cambios de esquema y recuperar una colección. Los comandos de validación no equivalen a publicar ni autorizan una migración sobre una base de producción. Cada operación sobre datos reales debe corresponder al destino y alcance acordados.

## Entornos y variables

Usa Node.js 24, como indica `.nvmrc`, y pnpm 10.32.1. `pnpm install --frozen-lockfile` debe funcionar sin modificar `pnpm-lock.yaml`; si falla, corrige la discrepancia entre manifiesto y lockfile antes de desplegar. Mantén las decisiones de scripts de instalación de `pnpm-workspace.yaml`; no los habilites indiscriminadamente para resolver un fallo.

La aplicación necesita `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` y `SUPABASE_DB_URL`. El prefijo `NEXT_PUBLIC_` publica su valor en el navegador: nunca usarlo para credenciales administrativas ni para la URL privada de Postgres. `.env.local` es un archivo local, no una plantilla que deba versionarse. En el alojamiento, introduce los valores en su gestor de secretos.

`OPEN_LIBRARY_CONTACT` es opcional e identifica al responsable del despliegue ante Open Library. Configura un contacto real; si falta, se identifica la aplicación como `BibLib/1.0`. La caché y el control de frecuencia bibliográficos son por proceso, no una cuota global distribuida entre varias instancias.

Configura Google OAuth en Supabase y los callbacks del entorno correspondiente. Comprueba acceso directo a una ruta privada, regreso desde Google y cierre de sesión. No mezcles cookies ni bases de pruebas con una cuenta de producción.

## Conexión Postgres

Copia la conexión desde la sección **Connect** del proyecto correcto de Supabase. Para despliegues serverless suele corresponder el pooler en modo transacción; para un servidor persistente, conexión directa o pooler de sesión según su red. El modo transacción exige desactivar prepared statements y revisar el pipelining del cliente. Para migraciones y herramientas administrativas, utiliza una conexión directa o de sesión y exige TLS fuera de entornos locales aislados. Consulta las [opciones oficiales de conexión de Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres).

BibLib reutiliza el cliente por proceso, limita su pool a una conexión y establece usuario y rol dentro de cada transacción. El cliente desactiva prepared statements, ejecuta las consultas de cada transacción de forma secuencial y exige SSL fuera de localhost. El tamaño del pool debe ajustarse al número de instancias y al límite real del proyecto. El pooler del proveedor no elimina ese presupuesto; el rendimiento y la concurrencia deben medirse en el despliegue concreto.

Las migraciones ya no se aplican con `SUPABASE_DB_URL` leída de archivos: `drizzle.config.ts` es solo offline y el único aplicador es el runner de [Migraciones](#migraciones), con objetivo, plan e identidad explícitos. No imprimas la URL completa en consola ni en una incidencia.

## Validación antes de publicar

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:db
pnpm build
```

`pnpm test:import` permite ejecutar solo el grupo de importación. Las consultas externas se simulan en las pruebas unitarias y no utilizan ISBN de una biblioteca privada.

`pnpm test:db` ejecuta `scripts/test-database.mjs`: crea su propio contenedor Postgres 17, expone un puerto aleatorio únicamente en `127.0.0.1`, añade el sustituto mínimo de Supabase Auth y aplica las migraciones. Incluye datos anteriores a `0001` y comprueba su conservación, aislamiento A/B, rechazo de referencias entre propietarios, protección de la estantería predeterminada y rollback. El contenedor se elimina al finalizar, también si falla la prueba. Docker debe estar iniciado y tener acceso a `postgres:17-alpine`; la primera ejecución puede descargar la imagen.

Estas pruebas no comprueban Google OAuth real, configuración del alojamiento ni un Supabase productivo. Tras desplegar en un entorno de prueba, recorre alta, edición, movimiento, búsqueda, importación y exportación con cuentas de prueba. Comprueba móvil, teclado, ambos temas y mensajes de error; una compilación correcta no sustituye esos recorridos.

El workflow `.github/workflows/ci.yml` utiliza valores públicos ficticios de Supabase únicamente para construir la aplicación. No recibe `SUPABASE_DB_URL` ni secretos de Google; las pruebas SQL y de navegador crean su propio Docker. `test:smoke` requiere Chrome y un build temporal adicional con Auth simulado, y bloquea solicitudes externas. No contiene publicación ni migraciones remotas.

## Migraciones y recuperación

`pnpm db:generate` genera una propuesta SQL a partir del esquema, sin conexión. Revísala junto con el historial de Drizzle. `pnpm db:migrate` ya no modifica ninguna base: es un despachador que sale con 2 y lista los comandos explícitos. En local se usa `db:status:local` → `db:plan:local` → `db:migrate:local` (ver [Migraciones](#migraciones)).

**Preproducción y producción no tienen todavía comando de migración** (U-INF-07, fase F1). Hasta entonces no se aplica `0001`/`0002` a la base real. Cuando exista, el procedimiento conservará estos pasos previos a aplicar `0001_library_integrity.sql` y `0002_book_versions.sql`:

1. Identifica proyecto, entorno y versión de esquema. Confirma que la operación sobre esa base real está autorizada y acordada.
2. Exporta las colecciones afectadas desde BibLib y crea además un respaldo de la base que incluya esquema, datos e historial de migraciones mediante el procedimiento del proveedor. El JSON de un usuario no sustituye un respaldo administrativo.
3. Ensaya la recuperación de ese respaldo en un entorno aislado. Verifica que el plan del proveedor permite el tipo de restauración previsto; no presupongas que existe recuperación a un punto en el tiempo.
4. Revisa datos antiguos: ninguna relación libro–estantería puede cruzar propietarios; páginas entre 0 y 100000; títulos de libros entre 1 y 500 caracteres tras recorte; títulos de estanterías entre 1 y 120. Los casos incompatibles requieren una corrección explícita y revisable.
5. Ensaya la migración en una copia. Después coordina una ventana que evite escrituras concurrentes durante la operación real y valida el resultado antes de reabrir el uso.

La migración falla ante datos incompatibles. No los borra, trunca ni reasigna silenciosamente. Introduce `catalogue` con procedencia `import` y verificación falsa en los libros existentes; no acredita retrospectivamente una edición física.

`0002` asigna un UUID de versión a cada libro y añade un trigger que lo renueva en cada inserción o actualización, también mediante SQL. Los formularios y las operaciones individuales envían la versión que leyeron; una versión antigua produce un conflicto sin modificar la ficha. El formulario conserva el borrador hasta que el usuario decide cargar la versión actual. Restaurar el mismo ID no reutiliza el token anterior. El trigger es SQL deliberado: debe conservarse al revisar migraciones futuras aunque no aparezca como una tabla nueva en Drizzle.

Después, comprueba libros, estanterías, índices, FK compuesta, políticas RLS y funciones de la aplicación. Usa dos cuentas de prueba para verificar que no pueden consultar ni modificar datos ajenos, incluso en las vías de acceso directo que el despliegue tenga habilitadas.

No hay un comando de rollback automático para `0001`. Revertir únicamente la columna `catalogue` perdería procedencia y revertir la FK/políticas reduciría las garantías nuevas. Si el despliegue falla, detén nuevas escrituras, identifica si el problema es de aplicación o esquema y decide entre una corrección hacia delante o una restauración verificada del respaldo. La restauración administrativa debe incluir la coherencia del historial de migraciones y los datos escritos desde la copia. No ejecutes SQL inverso improvisado sobre producción.

## Restaurar una colección

Desde Ajustes, exporta una copia reciente y consérvala fuera del directorio publicado. El JSON contiene datos personales de la colección, sus identificadores y URL de imágenes; no incorpora los archivos de portada ni una copia de Google Auth.

Para restaurar un archivo dentro de los límites:

1. Selecciónalo y comprueba los libros, estanterías, duplicados y portadas ausentes que presenta la revisión.
2. Elige **fusionar** para añadir fichas conservando las existentes, o **reemplazar** para restaurar el contenido completo del archivo. El reemplazo requiere confirmación y conserva la estantería predeterminada local.
3. Espera el resultado. Un fallo del proveedor de portadas no impide importar la colección; las imágenes pendientes quedan con portada genérica.
4. Abre varias fichas y comprueba estado, ubicación, autores y procedencia. Exporta de nuevo para contrastar los datos definidos por el formato, teniendo en cuenta la normalización de ISBN y las posibles reasignaciones de IDs.

Cada archivo admite como máximo **8 MiB, 2000 libros y 200 estanterías**. Una colección puede crecer por varias fusiones y superar esos límites. La exportación divide automáticamente esa colección en partes JSON v1 importables, con una fecha común y un botón de descarga para cada parte. Descarga todas las partes y guárdalas juntas; los nombres incluyen fecha, hora y número de parte. Las estanterías compartidas se incluyen en las partes que las necesitan y las vacías también se conservan.

Si ya tienes un respaldo antiguo demasiado grande, conserva el original intacto y prepara partes válidas o vuelve a exportar la colección desde esta versión. Una parte debe incluir `formatVersion`, `exportedAt`, sus libros y todas las estanterías referenciadas por esos libros. Incluye también las estanterías vacías que quieras recuperar. Evita ISBN/IDs duplicados, conserva la misma representación de las estanterías compartidas y recalcula sus recuentos. Ajusta el tamaño por **bytes UTF-8**, no solo por número de libros. La exportación actual realiza estos pasos; el importador valida las referencias y recalcula los recuentos.

Ensaya las partes en una cuenta de prueba. Si necesitas sustituir la colección, importa la primera parte con **reemplazar** y las restantes con **fusionar**, comprobando el resultado de cada una. Fusionar todas las partes sobre una colección existente conserva también libros que no estén en el respaldo. Las estanterías compartidas se unen por nombre normalizado; revisa sus nombres antes de dividir. No descartes registros para hacer caber el archivo ni repitas reemplazar en cada parte, porque eliminarías lo importado anteriormente. Conserva los archivos y el registro de lo importado hasta verificar la colección resultante.

Preparar la revisión no consulta ningún catálogo y no espera portadas. Las portadas pendientes de los libros importados se buscan después, como una fase del trabajo persistente de importación (U-DAT-03, [U-BIB-05](#todos-los-flujos-por-el-orquestador-pruebas-medición-y-activación--u-bib-05)): pasos acotados, con el límite de cada catálogo, que sobreviven a recargar y cuyo fallo no revierte la importación. Si cierras la página durante una importación, consulta la colección antes de repetir; fusionar omite identificadores ya presentes, pero no deshace un reemplazo anterior.

Para recuperar portadas pendientes, usa **Ajustes → Portadas pendientes**. El recorrido procesa hasta 20 candidatos por petición, guarda las portadas encontradas y muestra revisados, recuperados, sin resultado y omitidos. Puedes pausar después del lote actual y continuar desde el siguiente mientras permanezcas en la página. Si sales, los cambios guardados permanecen; una nueva búsqueda revisa otra vez los candidatos sin portada. Se omiten ISBN inválidos y fichas modificadas o eliminadas durante la consulta. Un fallo del proveedor puede dejar resultados pendientes para otro intento; no significa que se haya confirmado la ausencia de portada. Una URL real en cualquiera de los tamaños excluye el libro de este recorrido, que no diagnostica enlaces de imágenes rotos. Para cambiar una portada existente usa el detalle o una URL HTTPS. El proveedor puede dejar de servir una imagen externa en el futuro.

## Privacidad y archivos personales

Las fotos de estanterías, los catálogos derivados, sus fuentes y las copias JSON/SQL pueden describir una biblioteca privada. Por petición del propietario, se versionan como semilla inicial de pruebas únicamente [biblioteca.json](../tests/fixtures/library/biblioteca.json) y [anadir-biblioteca.sql](../tests/fixtures/library/anadir-biblioteca.sql), con 111 libros. Las fotografías y el resto de materiales de esa importación se han eliminado. Esta semilla se carga manualmente en una cuenta de pruebas; no se ejecuta automáticamente ni se usa como respaldo de producción.

Antes de preparar un commit, revisa `git status --short` y usa rutas explícitas o `git add -p` para seleccionar código. Revisa `git diff --cached --stat` y `git diff --cached` antes de publicarlo. Evita `git add .` mientras convivan código y archivos personales. No cambies reglas globales de Git ni publiques las fotos para resolver esta separación: acuerda primero qué materiales pertenecen al repositorio.

Guarda los respaldos en una ubicación privada con controles de acceso y retención adecuados. Las portadas se solicitan al proveedor externo. Analytics está desactivado por defecto; solo se monta si configuras `NEXT_PUBLIC_ENABLE_ANALYTICS=true` antes del build. Revisa esos proveedores y la configuración del alojamiento conforme al uso real. Esta guía no afirma que el proyecto tenga una política legal, eliminación de cuenta o recuperación administrada ya configuradas.

## Stack Supabase local

BibLib tiene su propia configuración de Supabase local (U-INF-01), separada de cualquier otro proyecto de la máquina. Esta sección describe su configuración, perfiles y ensayos. Los wrappers `pnpm db:local:*` y `db:reset:local` están disponibles; las secciones siguientes describen su contrato vigente.

### Requisitos

- Docker Desktop con backend WSL2 (ensayado con 29.4.3 en Windows 11) o Docker Engine en Linux, en marcha.
- Supabase CLI **2.117.0**, fijada como dependencia de desarrollo. Usa siempre el binario del repositorio, `node_modules/.bin/supabase`, nunca uno global: otra versión puede cambiar la plantilla y los flags.
- Disco: unos 4 GB de imágenes (Postgres 17.6 ~1,3 GB, Studio ~1,2 GB, Storage ~0,8 GB, postgres-meta ~0,4 GB, Kong, GoTrue, PostgREST y Mailpit). Si otro proyecto usa la misma versión del CLI, las imágenes se comparten. Cada perfil arrancado crea sus volúmenes de datos.
- Memoria: el stack levanta 8 contenedores. Reserva al menos 4 GB a Docker, además de lo que consuman otros stacks.

### Configuración y perfiles

- `supabase/config.toml` es la configuración del perfil `main` (`project_id = "biblib-local"`). Parte de la plantilla de `supabase init` 2.117.0, que usa `[local_smtp]` para Mailpit (no `[inbucket]`). Usa Postgres 17 con Auth, Storage, Studio, Mailpit y REST. Realtime, Analytics, Edge Functions, pooler y vector buckets están desactivados.
- Migraciones y seed del CLI desactivados (`[db.migrations] enabled = false`, `[db.seed] enabled = false`). `supabase/migrations/` no contiene SQL. Drizzle es el único que aplica el esquema de negocio. Un stack recién arrancado no tiene el esquema `biblib`, el ledger `drizzle` ni `supabase_migrations`.
- `api.schemas` no incluye `biblib`: el dominio sigue pasando por Server Actions y RLS.
- `supabase/profiles.json` declara los perfiles:

| Perfil | `projectId` | Puertos | App | Red Docker | Uso |
| --- | --- | --- | --- | --- | --- |
| `main` | `biblib-local` | 55320–55329 | 3147 | `biblib-local-network` | Checkout principal. |
| `test` | `biblib-test` | 55330–55339 | 3148 | `biblib-test-network` | Integración local y CI. |
| `scratch` | `biblib-scratch` | 55340–55349 | 3149 | `biblib-scratch-network` | Worktrees y pruebas descartables. |

Dentro de cada bloque el orden es: shadow, API (Auth/REST/Storage), Postgres, Studio, Mailpit, SMTP, POP3, analytics, inspector y pooler. SMTP/POP3, analytics, inspector y pooler están reservados, pero no se publican. Ningún bloque se solapa con 5432 ni con 54320–54329 (HolaERP y los valores por defecto del CLI).

- `scripts/lib/profiles.mjs` (`loadProfiles`, `getProfile`, `profileWorkdir`, `profilePorts`, `profileNetwork`, `generateProfileWorkdir`, `checkPublishedBindings`) genera el workdir de cada perfil en `.biblib/stacks/<perfil>/supabase/config.toml`. Lo hace a partir de `supabase/config.toml` cambiando solo `project_id`, los puertos y la URL de la aplicación en Auth. Si el archivo base y el perfil `main` no coinciden, falla. El workdir de `main` también se genera, así el CLI nunca lee `supabase/.env` ni archivos del checkout.
- `.biblib/` (ignorado por Git) guarda la raíz real del checkout y su hash (`checkout.json`). También guarda el estado de cada perfil (`stacks/<perfil>/profile.json`): proyecto, red, puertos, hashes de la configuración y etiqueta `biblib.root`.
- `scripts/lib/exit-codes.mjs` define `EXIT` (0, 2–11, 130) y `BiblibError(code, phase, message)` para los wrappers.
- `pnpm test:scripts` comprueba los puertos, los bindings declarados, el workdir generado, que no haya migraciones ni seed de usuario y que `supabase/migrations` no tenga SQL. No necesita Docker.

### Ensayo manual (perfil `scratch`)

Hasta que existan los wrappers, este es el procedimiento ensayado. En un worktree solo se usa `scratch`.

```powershell
node scripts/lib/profiles.mjs generate scratch
node scripts/lib/profiles.mjs show scratch   # muestra la etiqueta biblib.root
docker network create --driver bridge --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 --label biblib.profile=scratch --label biblib.root=<etiqueta> biblib-scratch-network
node_modules/.bin/supabase start --workdir .biblib/stacks/scratch --network-id biblib-scratch-network
node_modules/.bin/supabase stop --workdir .biblib/stacks/scratch
```

`--workdir` y `--network-id` existen en 2.117.0. `stop`, sin `--all` ni `--no-backup`, para solo este proyecto y conserva los volúmenes `supabase_db_biblib-scratch` y `supabase_storage_biblib-scratch`. La red propia no se elimina. Nunca uses `supabase stop --all`, `--no-backup`, `docker system prune` ni borrados por patrón: pararían o borrarían stacks ajenos.

Resultado del ensayo del 23-10-2026 (Docker Desktop 29.4.3, Windows 11):

- `start` terminó en unos 32 s. Studio, GoTrue (`/auth/v1/health` → 200), Storage, REST y Mailpit respondieron en 127.0.0.1:55341/55343/55344.
- Postgres 17.6 sin esquemas `biblib`/`drizzle`, sin tablas en `public` y sin `supabase_migrations`.
- Los contenedores, IDs, `StartedAt`, reinicios, redes y volúmenes de HolaERP eran idénticos antes y después.
- **Los puertos se publicaron en `0.0.0.0` y `[::]`, no en `127.0.0.1`.**

### Limitación conocida: bindings fuera de loopback

Docker Desktop 29.4.3 **ignora** la opción de red `com.docker.network.bridge.host_binding_ipv4` cuando el contenedor publica un puerto sin IP. Supabase CLI 2.117.0 publica así, solo con `HostPort`, y no tiene ninguna opción ni variable para fijar la IP. Se reprodujo con un contenedor mínimo en la misma red: `-p 55349:6379` queda en `0.0.0.0`, y `-p 127.0.0.1:55349:6379` queda en `127.0.0.1`. El firewall de Windows tiene reglas «Docker Desktop Backend» que permiten la entrada en los perfiles Público y Privado. Por tanto, **el stack es alcanzable desde la red local** mientras está arrancado (HolaERP está en la misma situación). El criterio «bindings en 127.0.0.1» de U-INF-01/G01 **no se cumple** y queda pendiente de una decisión de Néstor. Mientras tanto, arranca el stack solo el tiempo necesario y páralo al terminar.

Alternativas. Ninguna se ha aplicado, porque cambian configuración global de la máquina:

**A · IP de publicación por defecto del daemon.** Es global para todos los contenedores, también HolaERP. Hay que reiniciar Docker, lo que para y vuelve a arrancar todos los contenedores, y los que publican sin IP pasan a escuchar solo en loopback. No se ha verificado que Docker Desktop 29.4.3 respete esta opción. En Docker Desktop → *Settings* → *Docker Engine*, añade la clave al JSON existente y pulsa *Apply & restart*:

```json
{
  "ip": "127.0.0.1"
}
```

Para comprobarlo, arranca `scratch` y ejecuta `docker inspect supabase_kong_biblib-scratch --format "{{json .NetworkSettings.Ports}}"`: el resultado debe mostrar solo `127.0.0.1`. Para revertir, quita la clave y reinicia Docker.

**B · Regla de firewall de Windows.** Requiere PowerShell como administrador. Es una regla de bloqueo, que prevalece sobre las reglas de permiso de Docker, y no afecta al tráfico loopback:

```powershell
New-NetFirewallRule -DisplayName "BibLib Supabase local (solo loopback)" -Direction Inbound -Action Block -Protocol TCP -LocalPort 55320-55349 -Profile Any
```

Compruébala desde otro equipo de la red con `Test-NetConnection <IP-del-equipo> -Port 55341`: debe fallar mientras `127.0.0.1:55341` sigue respondiendo. Para revertir: `Remove-NetFirewallRule -DisplayName "BibLib Supabase local (solo loopback)"`. Protege solo este equipo Windows, no Linux ni CI.

**C · Detección en `doctor`/`status` (U-INF-03).** Es la opción vigente. `checkPublishedBindings(perfil, contenedores)` recibe el `.NetworkSettings.Ports` de `docker inspect` de cada contenedor del perfil. Devuelve como `exposed` los bindings con IP distinta de `bindingCheck.allowedHostIps` (`127.0.0.1`, `::1`) y como `outOfBlock` los puertos fuera del bloque del perfil. `doctor` debe avisar o fallar con esa información. No corrige nada por su cuenta.

### Evolución del stack local

Esta lista describía el estado al cerrar U-INF-01. Ya están disponibles el ciclo de vida (`db:local:doctor|status|up|down`, U-INF-03), los objetivos y builds aislados (U-INF-02), el runner de migraciones (U-INF-04), los fixtures reales (U-INF-05) y el [reset y bootstrap completo](#reset-y-bootstrap) (U-INF-06). No borres volúmenes a mano por patrón.

## Observabilidad sin datos privados · U-OPS-01 (F0)

El servidor emite JSON por stdout/stderr para fallos de sesión, validación/commit/conflicto de importación, peticiones reales de Open Library y recuperación de portadas. [Alertas y contrato de privacidad](alertas.md) detalla eventos, lista blanca, límites, métricas propuestas y pruebas. La validación del archivo en el servidor produce `import.preview`; la revisión visual actual sigue siendo local al navegador y no genera una petición nueva.

`x-correlation-id` se valida (8–64 caracteres, formato acotado) y se mantiene con `AsyncLocalStorage`. La búsqueda `/api/books/search` devuelve esa cabecera también en errores, para localizar los eventos del servidor sin copiar consultas, ISBN ni títulos. Los logs no son un respaldo ni el estado de una operación.

Para apagar la emisión, establece `BIBLIB_TELEMETRY=off` en el proceso de servidor; el catálogo conserva sus resultados. `createLogger({ enabled: false })` permite desactivar un adaptador concreto. El saneado descarta campos privados y valores inválidos, y expone únicamente un contador local de descartes. Los fallos del sink no deben interrumpir la operación. `BIBLIB_TELEMETRY_SALT` es una sal secreta exclusiva de servidor para la primitiva HMAC `accountRef`; sin ella se omite el campo, nunca se sustituye por el ID original. Los puntos instrumentados en F0 no necesitan registrar cuentas.

No hay exportador, panel remoto ni alertas automáticas en F0. Se proponen 14 días de logs restringidos y 90 días de agregados sin cuentas/correlaciones; el alojamiento deberá configurar y verificar esa retención. Jobs, nuevos proveedores y fuentes métricas de DB/Storage se integrarán en las unidades siguientes. `pnpm test` ejecuta las pruebas de observabilidad con fallos simulados y sin red/base; también se comprueba el catálogo existente con `BIBLIB_TELEMETRY=off`.

## Objetivos y builds

U-INF-02 añade los contextos y wrappers descritos aquí; sustituye las notas anteriores que los indicaban pendientes. El lifecycle, el diagnóstico de propiedad y los bindings siguen correspondiendo a U-INF-03. Esta entrega no arranca servicios ni conecta con proyectos remotos.

`BIBLIB_TARGET` admite `local`, `test`, `preprod` y `prod`. Los wrappers exigen un objetivo válido antes de crear clientes y lo fijan en el proceso hijo. `NODE_ENV=production` indica optimización de Next, no selecciona una base de producción. El perfil por defecto es `main` salvo en `test`, que usa `test`; en un worktree selecciona `scratch` explícitamente.

| Comando | Contexto y artefacto |
| --- | --- |
| `pnpm dev:local --profile scratch` | Desarrollo con endpoints exactos del perfil y `.next-local`. |
| `pnpm build:local --profile scratch` | Compilación local optimizada en `.next-local`. |
| `pnpm start:local --profile scratch` | Comprueba la huella del build antes de servirlo en 127.0.0.1:3149. |
| `pnpm build:test` | Compilación con variables explícitas del harness en `.next-test`, sin archivos de entorno. |
| `pnpm check:bundle --dist-dir .next-test` | Inspección de todo el contenido de `.next-test/static`, sin imprimir coincidencias privadas. |

`scripts/next-target.mjs dev|build|start <objetivo> [--profile <perfil>]` también acepta `preprod` y `prod` con variables inyectadas e identidad esperada. No reenvía flags arbitrarios a Next. Las salidas son `.next-local`, `.next-test`, `.next-preprod` y `.next-prod`; sin `BIBLIB_TARGET`, los comandos existentes `pnpm build`, `pnpm dev` y `pnpm start` conservan `.next` y su comportamiento actual. Usa los wrappers para obtener las comprobaciones de aislamiento. Cada build correcto del wrapper escribe `biblib-target.json` con el objetivo, un hash público y el `BUILD_ID` de Next; un build fallido invalida la huella anterior. Start rechaza huellas ausentes, malformadas o de otro objetivo/proyecto, incluida una clave pública distinta. También rechaza un build posterior hecho directamente con Next que haya conservado un recibo anterior.

### Carga de configuración

`scripts/db/environment.mjs` exporta `loadTarget(target, { profile, env, cwd })`, `childEnv(ctx)`, `assertNoForeignEnvFiles(ctx, { mode })` y `writeLocalEnvFile(ctx)`. `cwd` identifica la raíz del checkout y por defecto es la del módulo. El contexto entrega `target`, `profile`, `fingerprint`, `publicFingerprint`, `env()` y `redacted()`; solo `env()` contiene credenciales, siempre en memoria. La huella de destino combina objetivo, proyecto, host, puerto, base y raíz real del perfil sin contraseñas. La huella pública vincula además URL, clave pública y opción de Analytics al artefacto; solo se persiste su hash.

- **Local:** ignora las variables del shell. Lee `.env.local` únicamente tras acreditar su primera línea `# biblib:generated target=local profile=<perfil> root=<sha256-raíz>`, o consulta `supabase status --output json` del workdir propio generado. Los endpoints deben coincidir exactamente con `127.0.0.1`, los puertos del perfil y la base `postgres`; `localhost` o un puerto ajeno no acreditan identidad. El estado nativo se captura en memoria y no se imprime.
- **Test:** `loadTarget` exige un objeto `env` construido por el harness; no admite el objeto global `process.env` como entrada implícita. El wrapper construye una lista cerrada a partir de las variables inyectadas por el harness. No lee `.env*` y rechaza los archivos que Next podría cargar.
- **Preprod/prod:** requieren URL pública, clave pública, `SUPABASE_DB_URL` y `BIBLIB_EXPECT_PROJECT_REF` inyectados. Se comprueba la correspondencia con el host Supabase del proyecto o el usuario del pooler; no se consulta el destino. No hay fallback a archivos locales. El preflight de identidad real, TLS, permisos y migraciones remotas llegará en U-INF-07.

`childEnv` elimina la herencia de Supabase/Postgres, `DATABASE_URL`, selectores del CLI, variables `BIBLIB_*` y claves/contactos de catálogos antes de inyectar el contexto. Fija `BIBLIB_TARGET`, `BIBLIB_PROFILE`, `BIBLIB_CATALOGUE_MODE` y `NEXT_PUBLIC_ENABLE_ANALYTICS=false` salvo selección explícita. Local/test usan `fixture` por defecto y dejan vacías las opciones de catálogo externo; `live` debe elegirse en la configuración del contexto. La interpretación del modo fixture por los proveedores pertenece a las unidades U-BIB; esta entrega publica la opción de servidor.

La comprobación de archivos cubre `.env`, `.env.local`, los archivos específicos de desarrollo/producción/test según el modo de Next y los `.env` de Supabase en checkout/workdir. Un archivo no acreditado produce salida 3 antes de invocar el hijo. El mensaje propone conservarlo fuera del camino de carga, por ejemplo `.biblib/remote/preprod.env`; no lee su cuerpo para mostrarlo, ni mueve ni borra archivos. Los archivos marcados también se validan contra una lista cerrada y el contexto elegido.

`.env.local.example` está versionado como referencia con URLs y contraseña de demostración locales y marcadores para la clave pública y el hash de raíz. No se copia directamente como configuración acreditada. Una vez preparado el stack propio, el lifecycle podrá usar `writeLocalEnvFile(loadTarget("local", { profile: "scratch" }))`; el helper escribe con permisos privados y aborta si encuentra un `.env.local` sin marcador de esa raíz/perfil. Nunca sobrescribe una configuración anterior no reconocida. Los secretos de servidor (`SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_BOOKS_API_KEY`, `OPEN_LIBRARY_CONTACT`) no llevan prefijo `NEXT_PUBLIC_`.

### Generación offline y verificación del bundle

`pnpm db:generate` selecciona la rama offline de `drizzle.config.ts`: no carga `.env.local` ni `.env`, no incluye `dbCredentials` y no abre conexiones. Debe funcionar incluso sin variables de base y mostrar `No schema changes` si no cambió el schema. `pnpm db:migrate` es ahora un despachador sin efectos (U-INF-04).

Un harness puede construir sin stack ni red inyectando placeholders en un checkout sin archivos privados:

```powershell
$env:BIBLIB_TARGET = "test"
$env:NODE_ENV = "production"
$env:NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:55331"
$env:NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-build-placeholder"
$env:SUPABASE_DB_URL = "postgresql://postgres:placeholder@127.0.0.1:55332/postgres"
pnpm build:test
pnpm check:bundle
```

`pnpm check:bundle` usa el directorio de `BIBLIB_TARGET`, o `.next` cuando no hay objetivo; `--dist-dir` permite elegirlo explícitamente. Busca URLs Postgres con credenciales, `service_role` (también dentro de JWT), `GOOGLE_BOOKS_API_KEY` y `SUPABASE_DB_URL`. Un hallazgo devuelve salida 11 sin mostrar el secreto; la ausencia de `static` devuelve 2. Es una comprobación del bundle generado, complementaria a mantener los módulos privados en el servidor.

`pnpm test:scripts` cubre herencia remota falsa, archivos no acreditados, targets inválidos, perfiles con rutas con espacios, huellas y rechazo de artefactos, sin Docker ni conexiones. En la validación U-INF-02, las 40 pruebas de scripts y las 50 de aplicación pasaron, al igual que lint/typecheck; `db:generate` sin variables de base informó `No schema changes`, el build test con placeholders dejó limpio su bundle de 29 archivos y `pnpm build` sin objetivo siguió construyendo en `.next`.

## Ciclo de vida del stack

U-INF-03 incorpora los siguientes wrappers y sustituye las indicaciones anteriores que los marcaban pendientes. No cambia la configuración global de Docker ni ejecuta migraciones o seed. Usa Node 24.11.1–24.x, pnpm **10.32.1** y Supabase CLI **2.117.0** instalado en este repositorio; no instala herramientas automáticamente.

```powershell
pnpm db:local:doctor --profile scratch
pnpm db:local:up --profile scratch
pnpm --silent db:local:status --profile scratch --json
pnpm db:local:down --profile scratch
pnpm db:local:bootstrap --profile scratch --json
```

Todos aceptan únicamente `--profile main|test|scratch` y `--json`. El perfil predeterminado es `main`; desde un worktree `up` y `bootstrap` exigen `scratch` o `test` (este último, para `test:integration:local`). Para consumir JSON usa `pnpm --silent` (suprime la cabecera propia de pnpm) o `node scripts/local-stack.mjs status --profile scratch --json`. El CLI usa la raíz del módulo, no el directorio actual de la terminal. Los procesos reciben argumentos separados, sin shell, con `--workdir` y `--network-id` explícitos y entorno limpiado por `childEnv`. Windows y Linux usan el entrypoint JS del paquete fijado que respalda `node_modules/.bin/supabase`.

`doctor` es de solo lectura: valida manifiesto/configuración, versiones fijadas frente a instaladas, motor Docker, identidad, archivos de entorno mediante `assertNoForeignEnvFiles`, puertos ocupados (incluidos los reservados) y rangos TCP excluidos de Windows. Detecta el PID con netstat/ss cuando está disponible y nunca termina al ocupante. No abre Docker Desktop, no genera workdirs, no modifica esquema ni consulta datos. Un `.env*` no acreditado produce salida 3 sin mostrar su contenido. No consulta `supabase status` ni carga credenciales para diagnosticar un stack parado.

`status` también es de solo lectura. Su contrato JSON es `{ schemaVersion: 1, target: "local", profile, fingerprint, endpoints, services: [{ name, status }], head: null, checks: [{ id, status, message }] }`. La huella coincide con la de `loadTarget` para ese perfil. Postgres se presenta como host/puerto/base, sin URL con usuario/contraseña; no aparecen claves, JWT, configuración de contenedores ni la salida nativa de Supabase. `head` es `null` con el stack parado o sin ledger; con U-INF-04 publica el head aplicado (ver Migraciones). Los servicios se proyectan desde su estado Docker; `running` indica que ese servicio no declara un HEALTHCHECK Docker.

`up` exige un preflight correcto, crea la red etiquetada si falta y arranca el proyecto con las comprobaciones de salud del CLI, sin `--ignore-health-check`. Comprueba además la salud Docker de todos los contenedores y HTTP de GoTrue, Storage, Studio (`/project/default`, evita la redirección normal de `/`) y Mailpit. Sobre el mismo stack sano verifica la salud y conserva los IDs, sin volver a ejecutar start. Un puerto ocupado por un proceso ajeno devuelve 8 con diagnóstico antes de crear red/contenedores; una herramienta ausente, versión incorrecta o puerto excluido devuelve 4.

La propiedad se registra en `.biblib/state/<perfil>.json`: huella, raíz real, proyecto, fase, red por ID, contenedores por ID y volúmenes por nombre/fecha de creación. La red exige etiquetas `biblib.profile` y `biblib.root`. Como Supabase CLI no admite etiquetas personalizadas para sus contenedores/volúmenes, estos exigen el ID registrado, etiqueta `com.supabase.cli.project` (o compose), y pertenencia a la red propia en los contenedores. Un nombre parecido, el puerto o la respuesta HTTP no acreditan propiedad. Un recurso sin registro, de otra raíz o con identidad cambiada aborta con **3**; no se adopta, borra ni renombra automáticamente. El directorio de estado/workdir no puede atravesar enlaces a otra raíz.

Los comandos mutables usan un bloqueo exclusivo por perfil: un lifecycle concurrente devuelve **7**. Si el proceso muere sin liberar el archivo `.biblib/state/<perfil>-lock.json`, comprueba manualmente que ese PID ya no existe antes de retirar únicamente ese bloqueo. Un registro dañado requiere recuperar la evidencia de propiedad; no lo soluciones borrando recursos por nombre. El estado local no se comparte entre checkouts: libera o transfiere explícitamente un perfil antes de reutilizar sus nombres desde otra raíz.

`down` verifica propiedad y configuración antes de invocar stop únicamente sobre ese workdir/proyecto. Conserva la red y todos los volúmenes, y comprueba que no quedan servicios propios activos. No usa `--all`, `--no-backup`, prune ni compose. Si falla la salud, se registra fase `stack`, estado `failed` y recursos pendientes; la salida es **8**, nunca un éxito parcial. SIGINT devuelve **130**, registra la fase y retira solo los contenedores/red creados por ese intento, tras comprobar IDs, etiquetas y red; conserva volúmenes y recursos preexistentes. El recibo indica `cleanup: pending` si no pudo terminar esa limpieza. El ejecutor aplica timeout y captura acotada/saneada; nunca publica stdout/stderr nativos del arranque.

Los bindings reales se revisan con `checkPublishedBindings`. Publicar fuera del bloque del perfil falla con **3**. Publicar en `0.0.0.0`/`::` genera **warn** con referencia a las alternativas **A/B** de «Limitación conocida: bindings fuera de loopback». El aviso no bloquea el lifecycle ni aplica cambios de daemon/firewall. Esa limitación de Docker Desktop sigue abierta.

### Bootstrap por fases

El orden es **preflight → stack → env → migrate → seed → verify**. Cada invocación revalida las fases ejecutables y actualiza `.biblib/state/<perfil>-bootstrap.json`, con `schemaVersion: 1`, raíz/huella/perfil/proyecto, `runId`, `phase`, estado global y `phases` por nombre. El flujo vigente ejecuta las seis fases y solo termina con estado global `passed` cuando verify pasa. Solo `main` llama a `writeLocalEnvFile(loadTarget("local", ...))` para generar `.env.local`; scratch/test registran expresamente que no se escribe archivo y consumen contexto explícito. Nunca se sobrescribe un archivo no acreditado.

`migrate` usa el runner Drizzle, `seed` el censo local y `verify` comprueba esquema, sesiones y servicios reales. Una fase fallida devuelve su código distinto de cero y queda `failed`/`interrupted`; repetir revalida el estado actual antes de omitir trabajo. La salida **0** acredita las seis fases completas (véase [Reset y bootstrap](#reset-y-bootstrap)).

Las pruebas de procesos/CLI/Docker simulados se ejecutan con `pnpm test:scripts`. El [informe U-INF-03](validacion/2026-10-23/O03/u-inf-03-informe.md) registra el ensayo real de scratch, la conservación de datos y la comparación de recursos HolaERP.

## Migraciones

U-INF-04 convierte a Drizzle en el único aplicador del esquema de negocio, con plan previo, guardas del historial y verificación de los objetos que el snapshot no representa. Esta sección sustituye, para el flujo local, las indicaciones anteriores de esta guía que mencionan `pnpm db:migrate` como comando que modifica la base, la carga de `.env.local`/`.env` desde `drizzle.config.ts` y el `head: null` o la fase `migrate` pendiente del lifecycle. Preproducción y producción **no están implementadas**: `plan`, `migrate` y `status` con `preprod`/`prod` salen con **2** y remiten a U-INF-07. No se usa `supabase db push`, `migration up` ni SQL en `supabase/migrations/`.

```powershell
pnpm db:local:up --profile scratch
pnpm db:status:local --profile scratch [--json]
pnpm db:plan:local --profile scratch --out scratch.json [--json]
pnpm db:migrate:local --plan .biblib/plans/scratch.json --expect-project biblib-scratch --expect-plan <sha256>
```

`pnpm db:migrate` es ahora un despachador: no aplica nada, no lee archivos de entorno y sale con **2** listando estos comandos. Drizzle Kit queda solo para operaciones offline (`generate`, `check`, `up`); `drizzle-kit migrate`, `push`, `pull` o `studio` fallan con un mensaje que remite a los wrappers. `drizzle.config.ts` declara el mismo ledger que el runner: `drizzle.__drizzle_migrations`.

### Journal, hashes y finales de línea

`scripts/db/journal-guard.mjs` valida, sin conectar, que el journal es de PostgreSQL con `idx` consecutivos desde 0, tags `NNNN_nombre`, `when` estrictamente creciente, `breakpoints`, ficheros presentes y ningún `.sql` fuera del journal. El hash se calcula **igual que `readMigrationFiles` de drizzle-orm 0.45.2**: sha256 del texto del fichero tal como está en disco, sin normalizar. Las pruebas comparan ambos cálculos.

Drizzle registra ese hash y decide los pendientes solo por el último `created_at`. Por eso la guarda también compara cada fila del ledger con su entrada, por `created_at = when`: hash distinto, fila desconocida o duplicada, y entradas **retroactivas** (sin aplicar pero anteriores al último `when` aplicado) devuelven **5** antes de escribir nada.

`.gitattributes` fija `eol=lf` para `drizzle/**/*.sql` y `drizzle/meta/*.json`, también para las migraciones nuevas. El índice ya estaba en LF y sus bytes no cambian; con `core.autocrlf=true`, la copia de trabajo de Windows estaba en **CRLF** antes de esta regla, y Drizzle habría registrado otro hash. Tras actualizar a esta versión, comprueba `git ls-files --eol drizzle` (`i/lf w/lf attr/text eol=lf`). Si la copia sigue en CRLF, vuelve a extraer solo esos ficheros con Git; no edites el SQL. Un SQL con CRLF en disco se rechaza con **5**.

Un ledger con un hash calculado sobre CRLF (base migrada desde un checkout Windows antiguo) se reconoce como `reconciliation-required` y **5**. El runner no reescribe el ledger. La conciliación es una adopción explícita de U-INF-07 que documenta la equivalencia de bytes.

### Plan

`db:plan:local` es de solo lectura: valida el journal, prueba la propiedad del perfil (registro de U-INF-03, contenedor Postgres registrado y en marcha, misma huella que `loadTarget`) y consulta el destino dentro de una transacción `read only`. Escribe un JSON en `.biblib/plans/` (ignorado por Git; `--out` no admite otra carpeta) con `schemaVersion`, `kind: "migrate"`, objetivo/perfil/proyecto, `fingerprint`, commit, versión de Drizzle, hash del journal, ledger, `appliedHead`, `expectedHead`, `migrations[{tag, when, hash, status}]`, `pending`, `ddlSummary` (operaciones derivadas del texto, sin ejecutarlo), `expectedObjects`, `risks`, `prerequisites`, `createdAt`, `expiresAt` (**30 minutos**) y `planHash`. Ese hash es el sha256 del JSON canónico del plan. El comando imprime la orden exacta de aplicación.

| Estado del destino | Plan |
| --- | --- |
| Sin `biblib` ni ledger | `empty`: todas pendientes. |
| `biblib` sin ledger o con ledger vacío | `adoption-required`, **5**: «adopción de historial necesaria». No se trata como base vacía. |
| Ledger coherente | `pending` o `up-to-date` (plan sin pendientes). |
| Hash/fila/entrada divergente | `diverged` o `reconciliation-required`, **5**. |
| Objetos aplicados distintos del manifest | `drift`, **5**. |
| Sin `auth.users`, `auth.uid()` o roles de Supabase | **8**: el runner no fabrica sustitutos. |

### Aplicación

`db:migrate:local` exige `--plan`, `--expect-project` y `--expect-plan`. No admite URLs, `--force` ni flags reenviados. Antes de conectar revalida el `planHash`, el tipo, la caducidad, el proyecto, el perfil, la huella, el commit, la versión de Drizzle y los bytes, tags y `when` de todas las migraciones (**3** si es otra identidad, **6** si el plan no corresponde).

Abre una conexión administrativa dedicada (`postgres`, una sola conexión, `connect_timeout` 10 s, `statement_timeout` 120 s, `lock_timeout` 15 s), con cierre garantizado. Adquiere el **bloqueo consultivo común** `pg_try_advisory_lock(7316290410462004)` (`MIGRATION_LOCK_KEY` en `scripts/db/migrate.mjs`), con espera acotada de 30 s. Si sigue ocupado sale con **7** sin aplicar nada; `BIBLIB_MIGRATE_LOCK_WAIT_MS` ajusta la espera. Ya bajo bloqueo relee ledger y manifest. Si el head o los pendientes no son los del plan (por ejemplo, otro runner terminó antes), sale con **6**. Ante drift sale con **5**.

Aplica con `drizzle-orm/postgres-js/migrator` y `migrationsSchema: "drizzle"`, `migrationsTable: "__drizzle_migrations"`. Todas las pendientes van en **una transacción**. Un error revierte el conjunto y el ledger no avanza: sale con **9** e informa head anterior, migración fallida, SQLSTATE y resultado, sin SQL ni datos. Después comprueba que el ledger llega al head esperado y verifica el manifest completo; si falla, sale con **11** y no se debe reaplicar. Cada ejecución deja un recibo junto al plan (`<plan>.receipt.json`). SIGINT cierra la conexión, con lo que la transacción se revierte, y devuelve **130**.

### Manifest de objetos deliberados

`scripts/db/objects-manifest.mjs` comprueba, con `pg_catalog`/`information_schema` y según el head aplicado, los objetos de `0000`→`0002`. Las expresiones se normalizan quitando espacios, paréntesis y casts; no se compara el pretty-print.

- RLS en `biblib.shelves` y `biblib.books`.
- Las 8 políticas `*_own`: comando, roles (`authenticated`), permisivas y expresión. En `0001` se exige `NOT is_default` en update/delete de estanterías. Una política no declarada es drift.
- Grants: `USAGE` en `biblib` y `SELECT/INSERT/UPDATE/DELETE` exactos para `authenticated`; ninguno para `anon`.
- PK, FK a `auth.users` con `ON DELETE CASCADE`, `books_owner_shelf_fk` compuesta con `RESTRICT` (y `books_shelf_fk` retirada), checks de estado, páginas y títulos, los 7 índices (unicidad, columnas y predicado) y las columnas `catalogue`/`version`.
- `biblib.rotate_book_version()`: `plpgsql`, `RETURNS trigger`, sin argumentos ni `SECURITY DEFINER`, `search_path=pg_catalog` y cuerpo normalizado `NEW.version := gen_random_uuid(); RETURN NEW`.
- Trigger `books_rotate_version`: `BEFORE INSERT OR UPDATE FOR EACH ROW` en `biblib.books`, sobre esa función, habilitado, sin `WHEN` ni lista de columnas.

El runner solo lee `auth.users`, `auth.uid()` y los roles como prerrequisitos. Nunca los crea.

### Estado, lifecycle y recuperación

`db:status:local` es de solo lectura (transacción `read only`). Muestra estado, head aplicado/esperado, pendientes y comprobaciones. Sale con **0** si el destino está vacío, pendiente o al día, y con **5** ante adopción, divergencia o drift. `pnpm db:local:status` publica ahora `head: { tag, applied, expected, state }` cuando el Postgres propio está en marcha y acreditado (`null` si está parado o sin ledger). `doctor` sigue sin consultar datos. La fase `migrate` de `db:local:bootstrap` ejecuta plan + migrate locales con este mismo contrato (`.biblib/plans/bootstrap-<perfil>-<runId>.json`) y propaga su código. `seed` y `verify` están conectados mediante U-INF-05/06; bootstrap devuelve 0 solo tras verificar ambos.

- **Drift** (por ejemplo, alguien borró el trigger): status/plan/migrate salen con **5** y no se reaplica una migración antigua. Corrige hacia delante con una migración nueva y revisada. Solo en un stack descartable puede recrearse el objeto con el mismo SQL de la migración y verificarlo con `db:status:local`.
- **Adopción o hash legacy**: detén la aplicación y sigue U-INF-07. No borres el ledger ni rellenes filas a mano.
- **Fallo 9**: corrige la causa (datos incompatibles, objeto previo), genera un plan nuevo y repite. El ledger no avanzó.
- **Bloqueo 7**: es un bloqueo de sesión de Postgres y se libera al cerrar la conexión del otro runner; no hay archivo residual que borrar.

`pnpm test:scripts` incluye `tests/scripts/migrations.test.mjs`: journal (idx, when, retroactivo, fichero ausente, huérfano, CRLF), hashes frente al Drizzle instalado, LF frente a CRLF legacy, adopción frente a base vacía, manifest con metadatos reales capturados de Supabase local, planes caducados, de otro proyecto, alterados o con otro hash, argumentos y despachador. Tres pruebas `[stack]` usan scratch si está arrancado y acreditado: drift en una transacción revertida, bloqueo ocupado (7) y fallo intermedio revertido (9). Se omiten con `BIBLIB_SKIP_STACK_TESTS=1`. El [informe U-INF-04](validacion/2026-10-23/O04/u-inf-04-informe.md) recoge el ensayo real sobre scratch.

## Fixtures y acceso local

U-INF-05 añade el seed de cuentas reales de GoTrue, sus bibliotecas, un objeto Storage privado y correo a Mailpit. Esta sección sustituye las indicaciones anteriores que marcaban `seed` como pendiente. `db:local:bootstrap` ejecuta **preflight → stack → env → migrate → seed → verify**; desde U-INF-06 su salida 0 acredita las seis fases completas.

```powershell
pnpm db:local:up --profile scratch
pnpm db:status:local --profile scratch
# Si hay pendientes: db:plan:local y db:migrate:local con su plan e identidad.
pnpm db:seed:local --profile scratch
pnpm --silent db:seed:local --profile scratch --json
pnpm dev:local --profile scratch
# En otra terminal:
pnpm db:local:login --profile scratch --as a
# Para la segunda cuenta: --as b, preferiblemente en otro perfil del navegador.
```

El comando de acceso muestra un enlace temporal servido por un proceso independiente en **127.0.0.1**, válido una sola vez durante dos minutos. Ábrelo en el navegador local: coloca las cookies SSR y redirige a `http://127.0.0.1:3149/` (`main`: 3147; `test`: 3148). Usa siempre `127.0.0.1`, también para abrir la app. El enlace concede acceso a la cuenta ficticia: no lo compartas ni lo adjuntes a informes. No contiene claves administrativas, contraseñas ni JWT. No añade rutas a Next ni requiere Google; el proceso temporal termina al usar el enlace o al caducar. El cierre de sesión de la aplicación usa GoTrue normalmente. Google OAuth sigue necesitando Internet y configuración externa.

`tests/integration/support/session.mjs` exporta `signInFixture("a"|"b", { profile })`. Devuelve `{ client, session, user, cookies(), resolved }`: `client.auth` permite validar `getUser`, actualizar metadatos, renovar y cerrar sesión; `cookies()` devuelve las últimas `{ name, value, options }` creadas por **@supabase/ssr**, incluidas fragmentación, renovación y eliminación. Para un navegador de pruebas usa su API de cookies con ese formato adaptado, sin registrar valores. La sesión procede de `signInWithPassword` contra GoTrue local; nunca se fabrican tokens ni se habilita un bypass en la aplicación.

El censo versionado `tests/fixtures/census.json` no contiene credenciales: fija `censusVersion`, `censusId`, A/B (`lector-a@biblib.test`, `lector-b@biblib.test`), metadato `biblib_fixture`, tres estanterías y cuatro libros por cuenta. Todos son ficticios; los ISBN de prueba no representan una biblioteca personal. Cada libro tiene `fixtureKey`, y el seed guarda ese marcador y `censusId` en su JSON `catalogue`, sin cambiar el schema ni el tipo público. Las estanterías adicionales y libros usan UUID derivados de **censo + user_id real + tipo + fixtureKey**: ese ID es la clave material de `ON CONFLICT (id)`. La estantería predeterminada usa el índice parcial existente por propietario. No se imponen UUID a Auth ni se toca su esquema por SQL.

El seed revalida `loadTarget`, huella, estado registrado y propiedad Docker mediante el mismo resolver que el runner antes de crear clientes o escribir. Solo admite `local` (el sufijo del comando lo selecciona si `BIBLIB_TARGET` está ausente); un `BIBLIB_TARGET` distinto, endpoints HolaERP/remotos, perfil sin registro o recursos de otra raíz dan **3**. Bajo el bloqueo del perfil y el bloqueo consultivo de migraciones comprueba ledger y manifest: pendientes dan **6** con instrucciones `db:plan:local`/`db:migrate:local`; divergencia/drift dan **5**. No migra automáticamente.

La clave administrativa local, los IDs reales de Auth y contraseñas aleatorias fuertes quedan únicamente en memoria y en **`.biblib/fixtures/<perfil>.json`**, ignorado por Git. El directorio y archivo se restringen a 0700/0600 en POSIX y con ACL sin herencia para el usuario actual y SYSTEM en Windows, antes de escribir secretos; se rechazan enlaces y registros de otra huella/censo. No copies ese archivo a `public`, HTML, logs, capturas o evidencias. La salida JSON del seed contiene solo identidad del perfil, cuentas ficticias, IDs, recuentos y estado de fases. No se deben imprimir respuestas nativas de Supabase o errores internos.

Se guardan contraseñas antes de crear/actualizar cuentas y se persisten los IDs devueltos inmediatamente. Un reintento recupera la ventana entre creación y guardado del ID mediante correo exacto + metadato de censo; una cuenta sin ese metadato, con otro ID registrado o ausente tras una reconstrucción se rechaza, sin adopción silenciosa. Ante fallo parcial, **10** identifica la fase (`auth`, `dominio`, `storage`, `correo` o `registro`); conserva el archivo privado y repite el comando. Las bibliotecas se actualizan en una transacción, solo en esos propietarios y fixtures; una colisión con un libro sin `fixtureKey` se rechaza. Los libros añadidos a mano sobreviven y el trigger SQL sigue rotando versiones. No hay `--remove` en esta entrega: no se borra ninguna cuenta ni biblioteca; el reset completo se hace con `db:reset:local` (U-INF-06).

El bucket **privado** `biblib-test-assets` contiene `fixtures/portada.webp`, con los bytes deterministas de `public/default-book-cover.webp`. Si el bucket reservado ya es público, el seed exige revisión en vez de adoptarlo. Se puede inspeccionar en Studio del perfil (`scratch`: `http://127.0.0.1:55343`). Esto verifica Storage local y no define los buckets ni las políticas definitivas de portadas/avatares (U-DAT-10). GoTrue solicita un correo de recuperación para A y Mailpit lo captura (`scratch`: `http://127.0.0.1:55344`); un reintento antes de 65 s conserva el recibo del envío para respetar el límite de GoTrue. Ningún destinatario pertenece a un dominio real ni se usa SMTP externo.

`tests/fixtures/catalogue/*.json` contiene respuestas de ISBN offline en formato Open Library; `lib/catalogue-fixtures.ts` ofrece `readCatalogueFixture(isbn)`, que devuelve una copia o `{}` sin red. **U-BIB conectará ese lector con el flujo de proveedores**: `BIBLIB_CATALOGUE_MODE=fixture` ya se propaga, pero esta entrega no cambia el proveedor actual. Las altas manuales y la lectura directa del catálogo fixture funcionan sin Internet; la búsqueda actual del producto aún usa Open Library.

`pnpm test:scripts` incluye simulaciones de censo, identidad ajena, ledger pendiente, reintentos, cuenta existente, preservación de fichas y SQL acotado. La prueba **[stack]** de `tests/scripts/seed.test.mjs` usa solo `scratch` en marcha y acreditado; con `BIBLIB_SKIP_STACK_TESTS=1` se omite. Comprueba seed repetido, libro manual sin marcador, versiones, sesiones A/B, token alterado, nombre, refresh/signOut/revocación, cookies SSR, rechazo anónimo Storage, descarga firmada determinista y correo en Mailpit. Deja un libro manual ficticio `manual-ensayo-o05` en A para comprobar su conservación. Al terminar el ensayo ejecuta `pnpm db:local:down --profile scratch`; se conservan red y volúmenes propios. La matriz completa de RLS A/B corresponde a U-QA-01.

### Formulario local

U-LOC-01 añade a `/login`, debajo del botón de Google, la sección **Acceso local de desarrollo**: correo, contraseña y «Entrar». Sirve para trabajar con las cuentas ficticias A/B sin Google ni enlaces temporales. Usa `signInWithPassword` contra el GoTrue del perfil local mediante el cliente SSR de la aplicación, así que las cookies son las reales y Google OAuth no cambia.

```powershell
pnpm db:local:up --profile scratch
pnpm db:seed:local --profile scratch
pnpm dev:local --profile scratch
# En otra terminal; solo funciona en una terminal interactiva:
pnpm db:local:credentials --as a --profile scratch
# Abre http://127.0.0.1:3149/login, escribe el correo y la contraseña mostrados y pulsa «Entrar».
```

`db:local:credentials --as a|b [--profile]` lee `.biblib/fixtures/<perfil>.json` (ver arriba) e imprime el correo y la contraseña de la cuenta ficticia **solo** si la salida es una terminal: rechaza una redirección a archivo o registro, no admite `--json` y avisa de que no debe copiarse a informes ni capturas. Exige el mismo perfil acreditado que `db:local:login`.

**Doble puerta.** Ambas son obligatorias:

1. **Build.** `childEnv` fija `NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN=1` solo para `local` y `test`, la fuerza a vacío en `preprod`/`prod` y descarta cualquier valor heredado. `next.config.mjs` la define siempre (`"1"` en local/test, `""` en el resto, también sin `BIBLIB_TARGET`): Next solo sustituye las variables `NEXT_PUBLIC_` definidas, y sin esa definición el formulario sobrevive en el bundle de un `pnpm build` sin objetivo. La página importa el formulario con `dynamic()` bajo esa condición, de modo que el compilador elimina el componente y su acción cuando no vale `"1"`.
2. **Servidor.** `signInWithLocalPasswordAction` devuelve `UNAUTHORIZED` («El acceso local no está disponible.») salvo que `BIBLIB_TARGET` sea `local` o `test` en el proceso **y** `NEXT_PUBLIC_SUPABASE_URL` sea exactamente `http://127.0.0.1:<puerto de API de un perfil de supabase/profiles.json>` (sin `localhost`, usuario, ruta ni consulta; el 54321 de HolaERP se rechaza). La comprobación va antes de validar la entrada y de crear el cliente.

**Qué hace y qué no.** Valida el correo (forma válida, hasta 254 caracteres) y la contraseña (1–128). Limita a 5 intentos fallidos por minuto y por proceso (el sexto responde `RATE_LIMITED` sin consultar GoTrue; un acceso correcto reinicia el contador y un fallo de red no cuenta). Todos los errores de credenciales dicen «Correo o contraseña incorrectos.», sin distinguir si el usuario existe. Tras el acceso redirige, con navegación completa, al destino de `?redirect=` validado con `getSafeRedirectPath` (el parámetro que ya usan el proxy y el login). No crea cuentas, no ofrece registro ni recuperación de contraseña, no acepta usuario por URL ni cabecera y no tiene atajos «Entrar como A/B». No sustituye las pruebas contra GoTrue real.

**Qué no protege.** No es una barrera frente a quien controle el proceso o las variables de un servidor local; su fin es que un build o despliegue remoto no pueda exponerlo ni usarlo. El límite de intentos es por proceso, no distribuido. En el stack local los puertos pueden estar publicados fuera de loopback (ver «Limitación conocida»); la contraseña de A/B solo vale en esa base ficticia.

**Verificación.** `pnpm check:bundle --dist-dir <directorio> --forbid-local-login` falla (**11**) si encuentra en `static` el literal del formulario (`biblib-local-password-form`, «Acceso local de desarrollo» o el nombre de la acción). Debe fallar en `.next-test` y pasar en `.next-prod` y `.next`. Las pruebas `[build]` de `pnpm test:scripts` compilan `test` y un `prod` simulado con placeholders (unos 25 s en total; `BIBLIB_SKIP_BUILD_TESTS=1` las omite). `pnpm test` cubre la guarda, la validación y el limitador.

## Reset y bootstrap

`pnpm db:reset:local` es destructivo y exige una revisión en dos pasos. Arranca primero el perfil propio: el dry-run consulta cantidades y huellas reales de Postgres y Mailpit, sin arrancar servicios ni modificar datos. En un worktree este wrapper solo reconstruye `scratch`.

```powershell
pnpm db:local:up --profile scratch
pnpm db:reset:local --dry-run --profile scratch --out .biblib/plans/reset-scratch.json
# Revisa el plan privado y usa exactamente el sha256 que imprime:
pnpm db:reset:local --apply --plan .biblib/plans/reset-scratch.json --expect-project biblib-scratch --expect-plan <sha256> --discard-local-data
pnpm db:local:bootstrap --profile scratch --json
pnpm db:local:down --profile scratch
```

El plan `kind: "reset-local"` vive exclusivamente en `.biblib/plans/`, caduca a los **30 minutos** y contiene raíz real, perfil, `projectId`, marcador operativo, huella del target, IDs de todos los contenedores/volúmenes/red, etiquetas, mounts y bindings exactos. Explicita lo que se elimina: dominio, usuarios/sesiones/tokens locales, metadatos y bytes de Storage, correo Mailpit, ledger y registro privado de fixtures; conserva la red del perfil, las imágenes, otros proyectos/perfiles y planes/recibos. Incluye cantidades por categoría y hashes de cada tabla de `biblib`, `auth`, `storage` y `drizzle`, calculados en Postgres sin devolver las filas; la huella conjunta incluye el inventario de Mailpit. Un cambio de datos, incluso con las mismas cantidades, o de recursos/bindings invalida el plan con **6**. Mantén detenidas las escrituras de la aplicación durante su revisión y aplicación.

`--apply` requiere `--expect-project` y `--expect-plan` exactos y una de dos autorizaciones excluyentes: `--discard-local-data`, que registra la renuncia para ese proyecto local, o `--backup-receipt <ruta>`. `main` tampoco admite confirmación genérica: siempre exige su identificador `biblib-local`. `--yes` solo es compatible con un apply ya completo; no elimina ninguna guarda. No se aceptan `--linked`, `--all`, `--db-url`, `--force` ni opciones reenviadas. Puerto 5432, URL remota/túnel sin contenedor publicado, raíz ajena, marcador `holaerp`, red adicional ajena, contenedor sin registro o volumen recreado con otra fecha producen **3**, antes de parar, borrar o consultar datos de ese destino. El marcador aislado no autoriza nada.

El adaptador de recibos locales exige `schemaVersion: 1`, `backupId`, `fingerprint`, `discardedStateHash` igual al plan, `createdAt` posterior al plan, `scope` con `domain`, `auth`, `storage`, `mailpit` y `ledger`, `restoreVerification.passed: true` y `files[{path, sha256}]`. Recibo y archivos deben permanecer dentro de `.biblib/` sin enlaces y sus hashes deben coincidir. Este wrapper **no genera respaldos ni ensaya su restauración**; el productor definitivo y su contrato de promoción se completan en U-OPS-02. Un JSON exportado de usuario no cumple este contrato. Para pruebas descartables se usa la renuncia explícita.

### Mecanismo y recuperación

Se revisó la [implementación exacta de reset de Supabase 2.117.0](https://github.com/supabase/cli/blob/v2.117.0/apps/cli/src/command-internal/db-bootstrap/recreate-local-database.ts) y su [composición local](https://github.com/supabase/cli/blob/v2.117.0/apps/cli/src/command-internal/db-bootstrap/reset-local-database.ts): en PG17 elimina y recrea el contenedor/volumen DB, de modo que ledger Drizzle, `biblib`, `auth` y metadatos Storage se reconstruyen juntos; reinicia Auth/Storage y recarga Kong, pero no elimina el volumen de bytes Storage ni el correo Mailpit. Las migraciones y el seed de usuario de Supabase siguen desactivados. Su secuencia interna no entrega recibos de IDs que permitan al wrapper continuar con propiedad comprobada tras cada eliminación.

La reconstrucción física del wrapper usa exclusivamente los IDs previamente registrados: para los contenedores acreditados, elimina cada uno por ID, comprueba otra vez propiedad y mounts y elimina cada volumen por su identificador exacto (Docker identifica los volúmenes locales por nombre, vinculado además a `createdAt`). Conserva la misma red propia. No usa patrones, eliminación forzada de volúmenes, `stop --all`, prune ni SQL inverso. Elimina el registro privado del censo y el recibo anterior de bootstrap solo después de destruir el estado autorizado, mediante Node y rutas absolutas comprobadas con `lstat`/`realpath`; rechaza symlinks y junctions en cualquier componente. Después ejecuta el mismo bootstrap público: plataforma fresca → Drizzle → seed → verify. Nunca conserva un ledger antiguo sobre un esquema vacío.

`.biblib/state/<perfil>-reset.json` registra autorización, hash del plan y fases `preflight`, `stop`, `destroy`, `local-state`, `bootstrap` y `verify`. El bloqueo del perfil cubre todo el reset y el bloqueo consultivo común impide competir con el runner antes de parar Postgres. Cada operación revalida los IDs restantes; solo admite que desaparezcan recursos del plan, nunca adopta reemplazos. SIGINT devuelve **130** y deja `interrupted`; una salida abrupta deja la fase `running`, que se reconoce como incompleta. Repite **la misma orden de apply**, con el mismo plan y autorización: continúa eliminaciones pendientes o vuelve al bootstrap no destructivo. Si la destrucción se autorizó dentro de los 30 minutos, su continuación puede terminar después de caducar el plan; un reset nuevo siempre requiere plan vigente. `up`/bootstrap independientes rechazan un reset incompleto con **6**. Un bloqueo residual por terminación forzada requiere acreditar que murió su PID antes de retirar ese archivo de bloqueo; no se recupera por antigüedad.

### Bootstrap completo e idempotente

`db:local:bootstrap` recorre **preflight → stack → env → migrate → seed → verify**. Repite las guardas y el plan/runner Drizzle, que no escribe DDL ni ledger cuando ya está al día. Antes de omitir seed verifica su censo/IDs/bibliotecas y Storage/Mailpit reales: así conserva versiones de libros, IDs y objetos en ejecuciones sucesivas. Si esos fixtures faltan, reejecuta el seed existente dentro de su scope. Un recibo previo por sí solo nunca acredita una fase. Las ejecuciones fallidas conservan `runId` y fase de continuación; todo se revalida al repetir.

`verify` comprueba head completo y manifest de objetos, censo de A/B y libros/estanterías, bucket privado y descarga firmada con bytes esperados, Mailpit accesible con correo del fixture y sesiones **reales** A/B con `signInFixture` de `tests/integration/support/session.mjs`, `getUser` y cookies SSR. Cierra solo las sesiones que crea. Studio forma parte de las comprobaciones de salud de stack. No publica contraseñas, claves, JWT ni URLs firmadas. Las verificaciones de sesión generan actividad normal de Auth y los recibos operativos se actualizan; la idempotencia se refiere a recursos, dominio, ledger y activos, no a esos registros de actividad. Un fallo de verify devuelve **11** y nunca éxito parcial. Tras parar/arrancar Mailpit su correo efímero puede faltar y requerir seed; GoTrue limita reenvíos durante 65 segundos.

`tests/scripts/reset.test.mjs` comprueba los rechazos, cambios sin cambio de cantidades, confinamiento de rutas/junctions, interrupción y continuación sin Docker. Su prueba `[stack]` revisa un plan real sin destruir; se omite con `BIBLIB_SKIP_STACK_TESTS=1`. El [ensayo destructivo O06](validacion/2026-10-23/O06/u-inf-06-informe.md), autorizado por el coordinador el 23-10-2026, completó reset físico, sesiones A/B, Storage/Mailpit, interrupción durante `destroy` y continuación, bootstrap doble sin cambios de dominio/ledger/activos y parada final. En Windows el harness entrega el evento SIGINT al handler real dentro de un proceso hijo; `child.kill("SIGINT")` terminaría el proceso sin entregar una señal POSIX. Los 10 contenedores de HolaERP de la línea base conservaron IDs, arranque, reinicios, puertos, redes y montajes; sus redes y volúmenes también permanecieron idénticos.

## Integración Supabase real · U-QA-01

`pnpm test:integration:local` ejecuta la suite `tests/integration/{auth,rls,storage}` contra los servicios reales del perfil **`test`** (`biblib-test`, puertos 55330–55339) y la app compilada para ese perfil en `127.0.0.1:3148`. Para identidad, cookies, permisos y Storage sustituye a los sustitutos de Auth de `test:db`/`test:smoke`. Esos dos comandos se conservan: son rápidos y no necesitan el stack.

```powershell
pnpm db:local:bootstrap --profile test   # o db:local:up + db:plan:local/db:migrate:local + db:seed:local, todos con --profile test
pnpm test:integration:local              # [--profile test] [--reuse-build]
pnpm db:local:down --profile test        # conserva red y volúmenes propios
```

Desde un worktree, `up`/`bootstrap` admiten `test` además de `scratch`. La suite está en `.mjs` y se ejecuta con `node --test`, como `tests/scripts` y los helpers de U-INF-05; no hay compilación TypeScript intermedia.

### Qué hace el runner

`tests/integration/run.mjs` no acepta URLs ni otros perfiles. Su secuencia es:

1. **Acredita el perfil** con `resolveSeedTarget("test")`: `loadTarget("local", { profile: "test" })`, registro `.biblib/state/test.json`, huella, propiedad Docker y servicios Postgres/GoTrue/Kong/Storage en marcha. Toma el bloqueo del perfil; otro lifecycle activo devuelve **7**.
2. **Comprueba ledger y fixtures.** Lee el ledger: con migraciones pendientes sale con **6** y con drift, con **5**. Exige el registro privado de fixtures A/B completo; si falta, sale con **10** (ejecuta `db:seed:local --profile test`). El runner no siembra, porque el seed vuelve a pedir el correo de GoTrue, limitado a 2 por hora.
3. **Prepara la ejecución.** Limpia los restos registrados de un run anterior y anota las cuentas de Auth.
4. **Compila y verifica el bundle.** Ejecuta `next-target build local --profile test` (`.next-local`), salvo con `--reuse-build`; `start` sigue validando la huella del build. Después pasa `check:bundle` sobre ese build: si encuentra material privado, sale con **11** antes de las pruebas.
5. **Arranca la app** con `next-target start local --profile test`. Si el puerto 3148 está ocupado, sale con **8** y no termina al ocupante.
6. **Ejecuta las pruebas** con `node --test --test-concurrency=1`. La caída simulada de servicios va sola, en un lote final.
7. **Cierra.** Comprueba que las cuentas de Auth son las mismas y todas `@biblib.test`, limpia lo creado por el run y detiene solo el árbol de procesos de la app que arrancó.

Las sesiones salen de `signInWithPassword` contra GoTrue, mediante `tests/integration/support/session.mjs`. Las cookies son las que escribe `@supabase/ssr`.

Las acciones de dominio se ejecutan **por HTTP contra la app real**, igual que desde el navegador: `POST` con la cabecera `Next-Action`, cuyo ID sale de `server-reference-manifest.json` del build, y las cookies del harness. Así se prueban el proxy, `getUser` real, `withRlsContext` y la conexión Postgres compartida de la app (`max: 1`). Invocar `lib/db` en el proceso de pruebas no cubriría cookies ni proxy. No se añaden endpoints ni bypass al producto.

### Qué cubre

| Archivo | Comprobaciones |
| --- | --- |
| `auth/sesion` | `getUser` de A/B; se rechaza un token con `sub` cambiado. Cookies `sb-127-auth-token` con `Path=/`, `SameSite=Lax` y codificación base64url. Renovación por el SDK. La redirección anónima conserva la consulta. `/login` devuelve a `/books?status=read&page=2` y rechaza un destino externo. El proxy renueva una sesión vencida y mantiene el destino. Las cookies partidas `.0/.1` del SDK funcionan en proxy y acciones. `signOut` vacía las cookies; se rechazan la copia antigua, su access token y su refresh, y la renovación revocada vuelve al acceso. Un cierre y una renovación concurrentes no dejan ninguna sesión válida. |
| `auth/cuentas` | Solo existen las cuentas A/B del censo, `@biblib.test`, sin identidades externas. Mailpit solo recibió correo para `@biblib.test`. |
| `auth/caida-servicios` | Se detiene el gateway propio (Kong del perfil), por el que pasan GoTrue y Storage. El proxy redirige con `error=session`, las acciones no devuelven datos y la API responde 401. El objeto firmado deja de servirse, pero la portada por defecto sigue disponible. Al recuperarlo, la sesión y la firma vuelven a funcionar. |
| `rls/acciones-ab` | Cada cuenta recibe solo su biblioteca. A manipula IDs de B: detalle, filtros, estado, edición, borrado, mover, mover en lote, alta en estantería ajena, renombrar o borrar estanterías ajenas y `/api/books/add`. Recibe `NOT_FOUND`/404 y B no cambia. El anónimo recibe 307 del proxy o 401 de la API. CRUD propio con rotación de versión, conflicto con versión antigua y portada por defecto. La predeterminada no se borra ni se renombra. En la conexión compartida, A→B→fallo de A→B no deja claims residuales. |
| `rls/conexion-reutilizada` | En una sola conexión, las sentencias de `withRlsContext` dejan tras commit o rollback el rol `postgres`, ningún claim y `auth.uid()` nulo, en el mismo backend. |
| `rls/sql-roles` | Rol `authenticated` con `request.jwt.claims` en SQL. Lectura, actualización, borrado, alta y relaciones cruzadas: 0 filas, `42501` o `23503`. Estantería predeterminada: 0 filas, `42501` y `23505`. `anon` sin acceso a `biblib` (`42501`). Trigger `books_rotate_version` en alta, cambio y versión forzada. Todo se revierte. |
| `rls/data-api` | PostgREST rechaza el perfil `biblib` (406 `PGRST106`) en lectura y escritura, para anónimo y para A. El esquema público no tiene esas tablas (404). `supabase-js` con `.schema("biblib")` no obtiene datos. GraphQL no las expone; hoy `pg_graphql` no está habilitado. |
| `storage/fixtures` | `biblib-test-assets` es privado: no leen el anónimo, la URL pública ni una sesión de A sin firma. La firma del proceso de prueba devuelve los bytes de `public/default-book-cover.webp`; se rechaza alterada, para otra ruta o caducada. Un objeto del run se sirve solo firmado y se elimina sin tocar el fixture. La app sirve la portada por defecto sin red ni sesión. |

`pnpm test:scripts` incluye `tests/scripts/integration-runner.test.mjs`, que no necesita Docker. Cubre argumentos, enmascarado de salida, orden de lotes, decodificación de respuestas de acciones, envejecimiento de cookies y limpieza acotada.

### Datos, limpieza y salida

- **Credencial administrativa local.** Solo la usan los procesos del runner y de las pruebas, para listar cuentas, firmar y limpiar. Procede del estado del perfil y del registro privado de U-INF-05 y nunca se imprime. `check:bundle` confirma que no llega al bundle de cliente. **Limitación heredada de U-INF-02:** el proceso servidor que lanza `start:local` recibe el entorno completo de `loadTarget`, que hoy incluye esa clave local aunque la app no la usa.
- **Recursos del run y limpieza.** Libros y estanterías llevan el título `[QA-01 <run>] …`. Los objetos van bajo `qa-01/<run>/` en `biblib-test-assets`. El metadato temporal `qa01_relleno` de B fuerza las cookies partidas. Todo se registra en `.biblib/integration/test-run.json` (ignorado por Git), solo con IDs, rutas y claves, sin sesiones. La limpieza borra por ID + propietario + marca. Si queda algo, sale con **10** y conserva el manifiesto, que el siguiente run limpia antes de empezar. No se tocan los fixtures A/B, `fixtures/portada.webp` ni los datos añadidos a mano.
- **Códigos de salida.**
  - **0**: correcto.
  - **2**: argumentos.
  - **3**: identidad (perfil sin registro, otra raíz o `BIBLIB_TARGET` distinto de `local`).
  - **5**/**6**: ledger.
  - **7**: bloqueo.
  - **8**: servicio o puerto.
  - **10**: fixtures ausentes o limpieza incompleta.
  - **11**: escenarios fallidos, bundle con secretos o cuentas cambiadas.
  - **130**: interrupción.

  Un fallo nombra su escenario con `✖`. La salida de las pruebas pasa por un filtro que oculta JWT, valores de cookie SSR, contraseñas de fixtures y claves conocidas. Las aserciones comparan identidades o booleanos, no tokens.
- **Registros.** `.biblib/integration/build.log` y `.biblib/integration/app.log`.
- **Duración y límites.** Una ejecución tarda unos 1,5 minutos con build y hace 8 inicios de sesión. GoTrue limita `sign_in_sign_ups` a 30 cada 5 minutos por IP: caben dos ejecuciones seguidas. Si una tercera inmediata recibe 429, espera 5 minutos.

### Qué no cubre

- **Google OAuth externo ni `/auth/callback`:** necesitan Internet y la configuración del proveedor. Se comprueban a mano en un entorno de pruebas.
- **Autorización por propietario de assets (U-DAT-10):** aquí solo se prueba el bucket de fixtures con las firmas del proceso de prueba. Las pruebas A/B de adjuntos, firma por propietario, reemplazo y limpieza se añadirán a `storage/` al integrar U-DAT-10.
- **Navegador real:** el `onError` de `<img>`, el JS de cliente y la accesibilidad corresponden a U-QA-02. Del fallback de portada se comprueba la parte de servidor: una ficha sin portada guarda `/default-book-cover.webp` sin consultar la red, y la app sirve ese archivo aunque Supabase no esté disponible.
- Alojamiento, cabeceras de despliegue, preproducción y producción.

Diferencia con las suites existentes:

| Suite | Auth | Datos | Necesita |
| --- | --- | --- | --- |
| `pnpm test:db` | Sustituto mínimo (`auth.uid()` simulado) | Postgres efímero en Docker | Docker |
| `pnpm test:smoke` | Simulado en un build temporal, con red externa bloqueada | Sustitutos de la app | Chrome |
| `pnpm test:integration:local` | GoTrue real, cookies `@supabase/ssr`, sesiones A/B | Postgres, PostgREST, Storage y Kong del perfil `test`; app compilada | Docker y perfil `test` preparado |

Evidencia del ensayo: [validacion/2026-10-23/O06/qa-01](validacion/2026-10-23/O06/qa-01/informe.md).

## Revisión de colección e importación en dos pasos · U-DAT-01

Un reemplazo confirmado sobre una revisión antigua ya no puede borrar libros añadidos o corregidos después. Cada cuenta tiene una **revisión de colección** (`biblib.library_state.revision`, UUID opaco emitido por el servidor). Cualquier escritura de libros o estanterías la rota dentro de su transacción. La importación se prepara contra una revisión concreta y solo se confirma si sigue vigente.

### Protocolo de revisión (guardas en la base)

Se eligieron **guardas DB** en lugar de confiar en la aplicación, porque deben cubrir también la SQL directa autorizada:

- `biblib.lock_library()` (`SECURITY DEFINER`, `search_path=pg_catalog`, sin argumentos): toma el propietario de `auth.uid()`, crea su fila si falta, la bloquea con `FOR UPDATE` y devuelve la revisión. Es el **bloqueo de colección** que sustituye al advisory lock anterior: todas las mutaciones de `app/actions` (libros, estado, portada, mover en lote, estanterías, recuperación de portadas, importación) lo toman antes de escribir, y `ensureDefaultShelf` también lo toma antes de crear la predeterminada. Sin sesión sale con `42501`. `anon` no puede ejecutarla.
- Triggers `books_rotate_library_revision` y `shelves_rotate_library_revision` (`AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW`) sobre `biblib.rotate_library_revision()` (`SECURITY DEFINER`, `search_path` fijo, no ejecutable por `authenticated`/`anon`). Rotan la revisión del propietario —y del anterior si cambia `user_id`— **una vez por transacción** (`rotated_xact = pg_current_xact_id()`), también con SQL administrativo. Conviven con `books_rotate_version`, que sigue protegiendo cada ficha.
- `authenticated` solo tiene `SELECT` sobre `library_state` (RLS por `auth.uid()`). No puede insertar, actualizar, borrar ni truncar la revisión, ni siquiera la suya. La Data API sigue sin exponer `biblib` (406 `PGRST106`).

La fila se crea en la migración para cada cuenta existente y de forma perezosa en la primera escritura o bloqueo de una cuenta nueva. Borrar la cuenta elimina su revisión por cascada sin recrearla. Orden de bloqueo: primero la colección y después las filas. Un escritor SQL externo que no tome `lock_library()` antes puede chocar con otro: Postgres aborta uno con `40P01` sin pérdidas y la app lo traduce a un error reintentable. `TRUNCATE` de las tablas de dominio no dispara triggers de fila; solo lo tiene el propietario y queda fuera del protocolo, igual que un backfill administrativo, que exige ventana coordinada.

### Importar: preparar, revisar y confirmar

| Acción | Contrato |
| --- | --- |
| `prepareImportAction(input, mode)` | Valida el archivo, busca portadas **fuera de cualquier transacción**, y bajo el bloqueo lee revisión y colección, calcula el plan y guarda la vista previa. Devuelve `{ previewId, revision, digest, expiresAt, plan }`. |
| `confirmImportAction({ previewId, expectedRevision, idempotencyKey })` | Bajo el bloqueo: clave → caducidad/reglas → revisión. Revalida la entrada almacenada, vuelve a derivar el plan (debe coincidir) y lo aplica. Devuelve `{ operationId, status: "committed", result, replayed }`. |

- **Plan privado** (`lib/import-plan.ts`): altas, conservados, sobrescritos, omitidos, reasignaciones de ID, eliminaciones y estanterías creadas/eliminadas. Es determinista: los IDs nuevos se derivan de la vista previa. La predeterminada nunca se borra ni se recrea.
- **Vista previa** (`biblib.import_previews`): entrada validada, plan, modo, versión de reglas (`IMPORT_RULES_VERSION`), hash SHA-256 de la entrada canónica y `expires_at`. Caduca a los **30 minutos**; `BIBLIB_IMPORT_PREVIEW_TTL_MINUTES` (servidor, 1–1440) lo ajusta. El tiempo de Postgres es la autoridad. Cada cuenta conserva como máximo 10. Las caducadas se purgan al día siguiente, al preparar otra.
- **Idempotencia** (`biblib.library_operations`): única por `(propietario, operación, clave)`. Guarda el hash de `{archivo, modo, reglas}` y el resultado durable. Repetir la misma clave devuelve el mismo `operationId` con `replayed: true`, aunque la revisión ya haya cambiado. Usar la misma clave con otro archivo o modo da `IDEMPOTENCY_CONFLICT` y no ejecuta nada. Una vista previa ya confirmada no admite otra clave. `authenticated` puede insertar y leer sus operaciones, pero no modificarlas ni borrarlas.
- **Errores**: `REVISION_CONFLICT` (409), `PREVIEW_EXPIRED` (410) e `IDEMPOTENCY_CONFLICT` (409). Llevan mensaje en español, `retryable: false` y el `correlationId` de `lib/observability`. Ninguno se resuelve forzando: no existe `force=true`. Una vista previa ajena o inexistente devuelve `NOT_FOUND`, sin confirmar su existencia. `httpStatusForDomainError` traduce los códigos en las rutas HTTP.
- **Ajustes**: al elegir el archivo se valida en local (errores inmediatos) y se prepara la revisión en el servidor. Cambiar de modo prepara otra. Ante `REVISION_CONFLICT` o `PREVIEW_EXPIRED` se conservan el archivo y el modo y se ofrece **Volver a revisar con los datos actuales**. Si se pierde la respuesta, se puede volver a confirmar con la misma clave sin duplicar.
- **Firma antigua**: `importLibraryDataAction(input, options)` se ha **retirado**. Su único consumidor era Ajustes, que ya usa el flujo nuevo. El formato de los backups no cambia.

### Migración `0003_library_revision` y recuperación

```powershell
pnpm db:status:local --profile test
pnpm db:plan:local --profile test --out dat01.json
pnpm db:migrate:local --plan .biblib/plans/dat01.json --expect-project biblib-test --expect-plan <sha256>
```

La migración crea las tres tablas con RLS, FK de propietario e índices, las funciones, los triggers y el backfill, en la misma transacción del runner. El manifest de objetos (`scripts/db/objects-manifest.mjs`) declara tablas, políticas, grants, funciones con su seguridad y permisos de ejecución, y triggers; `db:status:local` marca drift si alguien concede escritura en `library_state`, deshabilita un trigger o abre `lock_library` a `anon`. `tests/fixtures/migrations/objects-0003.json` contiene los metadatos reales tras `0003`.

Recuperación: desactivar los reemplazos nuevos en la interfaz y conservar las vistas previas para diagnóstico, sin rebajar la validación de versión ni de revisión. No hay rollback automático; retirar los triggers quitaría la garantía y se detectaría como drift. Corrige hacia delante con una migración nueva.

### Pruebas

- `pnpm test`: plan (fusionar, reemplazar, archivo vacío, determinismo, 111 registros sintéticos), decisión de confirmación, hash canónico, caducidad, `retryable`, `correlationId` y estados HTTP.
- `pnpm test:db`: `tests/db/revision.sql` aplica `0003` sobre datos previos y comprueba backfill, rotación única, aislamiento A/B, ausencia de escritura directa, vistas previas/operaciones, SQL administrativo, alta perezosa y borrado de cuenta.
- `pnpm test:integration:local`: grupo `tests/integration/import/`, contra Auth/PostgREST/app reales del perfil `test`:
  - Con dos sesiones de A, se prepara un reemplazo y después se añade un libro, se mueve, se cambia su estado o su portada, se renombra una estantería o se escribe por SQL directo. Cada caso termina en conflicto, no se borra nada y reintentar no lo aplica.
  - B no invalida la revisión de A.
  - La doble confirmación, secuencial y simultánea, produce un único resultado. La misma clave con otro modo o archivo da `IDEMPOTENCY_CONFLICT`.
  - Se comprueban la caducidad, que B no puede confirmar ni ver previews de A, y que nadie altera `library_state` por SQL ni por la Data API.
  - Se importan los 111 registros sintéticos.

  Ningún reemplazo se confirma sobre los fixtures A/B. Las vistas previas y operaciones del run se registran en el manifiesto y se limpian por ID + propietario.

Limitaciones: la suite no puede inyectar un proveedor lento en la app compilada (U-BIB). Lo que sí se prueba es una escritura entre la preparación, que incluye el enriquecimiento, y la confirmación. Los trabajos durables, el deshacer y la restauración multiparte siguen en U-DAT-02/03/04.

## Respaldo administrativo y restauración · U-OPS-02

U-OPS-02 añade el respaldo administrativo local, su restauración y la verificación del ensayo. El procedimiento completo, los tres productos de recuperación (JSON de cuenta, respaldo administrativo y objetos Storage), RPO/RTO, retención, responsable y el procedimiento remoto pendiente están en [Recuperación de BibLib](recuperacion.md). El JSON de «Restaurar una colección» sigue siendo una copia por cuenta: no sustituye a este respaldo.

```powershell
pnpm db:backup:local --profile scratch [--out <carpeta fuera de Git>] [--encrypt-key-file <clave externa>] [--json]
pnpm db:restore:local --backup .biblib/backups/<backupId> --profile scratch --expect-project biblib-scratch [--key-file <clave externa>]
pnpm db:restore:verify --backup .biblib/backups/<backupId> --profile scratch [--json]
```

- `db:backup:local` guarda en `.biblib/backups/<backupId>/` (ignorado por Git) el volcado de `biblib` y del ledger `drizzle` con snapshot exportado, los datos de identidad de Auth con `supabase db dump --local --data-only --schema auth` y los bytes Storage leídos por la API del perfil, más el recibo `backup.json` con hashes, alcance y exclusiones. Usa `docker exec` sobre el ID registrado del contenedor Postgres, sin credenciales en argv ni en la salida.
- `db:restore:local` solo restaura en un stack local propio, acreditado como reset y **vacío o recién reseteado**; antes de tocarlo valida archivos, clave e historial. Rota `books.version` (y `library_state.revision` si existe), invalida previews y leases y reasigna las credenciales de las cuentas fixture. No envía correo ni llama a proveedores.
- `db:restore:verify` comprueba objetos de esquema, ledger, cantidades, tokens rotados, muestra de fichas, sesiones A/B reales con RLS y objetos Storage por sha256, y escribe el informe de recuperación. Una discrepancia sale con **11**.
- `db:backup:prod` sale con **2**: pendiente de U-INF-07 y de un destino autorizado.

`pnpm test:scripts` incluye `tests/scripts/backup.test.mjs` (sin Docker). Ensayo real sobre scratch: [validacion/2026-10-23/O07/ops-02](validacion/2026-10-23/O07/ops-02/informe.md).

## Estructura compartida y retorno al catálogo · U-EXP-01

Cabecera, enlace «Saltar al contenido» y `<main id="main-content">` viven en `components/app-shell.tsx`, que usan una sola vez los layouts `app/books`, `app/shelves`, `app/profile` y `app/book`. Las páginas de esas rutas no pintan `Header` ni otro `<main>`; si necesitan menos ancho, envuelven su contenido en un `div` con `max-w-*`. El error de cada dominio (`error.tsx` con `components/route-error.tsx`) se muestra dentro de la misma estructura. `app/page.tsx` y `app/settings/page.tsx` conservan su propia cabecera hasta que se migren.

- **Títulos.** Cada ruta fija su título con `privateMetadata()` (`lib/route-metadata.ts`), siempre «Sección · BibLib» y `robots: { index: false, follow: false }`. La ficha usa `generateMetadata` en el módulo servidor (`app/book/[id]/page.tsx`): «Título del libro · BibLib»; si el libro no existe o el id no es válido, «Libro no encontrado · BibLib»; sin sesión o con el servicio caído, «Ficha del libro · BibLib», sin título. La lectura es `getBookDetailAction` con `cache` de React (solo dentro de la petición); no hay caché global de títulos.
- **Retorno.** Los enlaces de la tabla y la cuadrícula llevan `?from=<ruta del listado con sus filtros>#book-row-<id>`. `resolveBookReturnPath` (`lib/book-search.ts`, apoyada en `getSafeRedirectPath`) solo acepta rutas internas de la aplicación; el resto cae a `/books`. «Volver a libros» restaura filtros, orden, vista y página por URL; el listado muestra una vez la fila abierta y retira el fragmento. Un clic normal en el enlace anota el fragmento en la entrada actual del historial para que «Atrás» recupere la misma fila; cambiar filtros, orden, vista o página lo descarta, así que no se guardan coordenadas de scroll.
- **Recuperación.** Sin migración. Si el desplazamiento diera saltos, basta con quitar el `useEffect` de `components/books-table.tsx` que lee `parseBookRowAnchor` y la anotación `rememberOpenedBook`: el estado URL (`from`) sigue funcionando.
- **Pendiente para U-QA-02.** Recorrido manual en el navegador con sesión real (búsqueda filtrada → ficha → «Volver», Atrás/Adelante y recarga, ficha en otra pestaña, id inválido y cambio de cuenta sin filtración de datos). El acceso local `db:local:login` no se usó en esta unidad; la comprobación se hizo con un escenario temporal del smoke (Chrome real, Auth simulado) que no se incorpora a `scripts/smoke-app.mjs`.

## Cuota, caché y consultas en vuelo del catálogo · U-DAT-05

El gateway `lib/bibliographic-catalog/gateway.ts` coordina entre procesos, con Postgres, todas las consultas que el orquestador bibliográfico hace a proveedores. No elige fuentes ni fallback (eso es U-BIB) y no lo expone ninguna acción de cliente: el dueño llega de la sesión servidor (`options.userId`), nunca de un DTO.

- **Cuándo se usa.** Solo en `BIBLIB_CATALOGUE_MODE=live`. `lib/bibliographic-catalog/server.ts` abre una conexión propia de coordinación con `SUPABASE_DB_URL` (máximo 2 conexiones, `statement_timeout` 3 s, `lock_timeout` 2 s), separada de las transacciones de dominio, y entrega a los adaptadores su `fetch` coordinado. En `fixture` no hay red, cuota ni caché compartida.
- **Cuota (`quota.ts`).** Se reserva antes de cada petición HTTP real del adaptador, por proveedor y ámbito de credencial (`deployment` mientras no haya identificación acordada). Open Library: 1 petición/s por despliegue. BNE: su propio cubo, provisional a 1 cada 2 s hasta que U-BIB valide su política. Google Books no tiene política aprobada: el `fetch` coordinado rechaza su host y cualquier otro destino, sin enviar nada. Una búsqueda interactiva puede esperar hasta 2,5 s su plaza; un lote (importación, trabajos) solo toma una plaza libre de inmediato y, si no, espera fuera de la base, así no hace cola por delante de las búsquedas. Cada dueño tiene un tope de reservas activas por propósito (2 interactivas, 1 de lote). Tras un 429 se aplica un cooldown compartido según `Retry-After` (sin cabecera, 30 s; máximo 1 h).
- **Caché (`cache.ts`).** Solo se lee y escribe si la política publicada en `rights.ts` aprueba `cacheMetadata` y `persistMetadata` (y `previewCover` con TTL propio para portadas). La clave incluye proveedor, versión de política, ámbito, versión de schema del payload y clave canónica. Open Library: ficha 1 h y ausencia 5 min; el resto de proveedores no se cachea hasta tener TTL autorizado. Una caída, un timeout o un 429 nunca se guardan como ausencia. Al primer uso de cada proceso se retiran las entradas de versiones incompatibles (o todas, si la política está revocada). Una entrada malformada se descarta y se vuelve a consultar.
- **Consultas en vuelo.** Un solo proceso resuelve cada clave mientras dura su concesión (12 s); los demás esperan su publicación. Si la concesión caduca (worker muerto o tardío) otro la toma con un testigo de fencing mayor y la base rechaza la publicación del tardío.
- **Búsquedas de texto.** Van a `catalogue_private_cache`, por dueño y con la consulta reducida a un HMAC. Solo se cachean si existe `BIBLIB_CATALOGUE_CACHE_SECRET` (secreto de servidor de al menos 32 caracteres, nunca `NEXT_PUBLIC_`); sin él no se guardan.
- **Estados.** Se conservan `found | notFound | unavailable | rateLimited | disabled | misconfigured`. Esperar una reserva más de lo admisible es `rateLimited` con `retryAfterSeconds`, nunca `notFound`. Si Postgres no responde, el resultado es `unavailable` y no sale ninguna petición externa.

### Migración `0004_catalogue_coordination`

Añade en `biblib` `catalogue_cache`, `catalogue_inflight`, `catalogue_quota_buckets`, `catalogue_quota_reservations`, `catalogue_private_cache` y la secuencia `catalogue_fence_seq`, más las funciones `catalogue_reserve`, `catalogue_release`, `catalogue_begin`, `catalogue_complete`, `catalogue_private_get`, `catalogue_private_put` y `catalogue_invalidate`. Todas son `SECURITY DEFINER` con `search_path = pg_catalog`, sin `EXECUTE` para `anon` ni `authenticated`, y ninguna duerme: devuelven cuánto esperar. Las tablas compartidas tienen RLS sin políticas y ningún privilegio de cliente; `catalogue_private_cache` permite al dueño `SELECT`/`DELETE` de sus filas (`auth.uid()`). `biblib` sigue fuera de `api.schemas`, así que la Data API tampoco las expone. El manifest de objetos verifica tablas, permisos, restricciones, índices y el cuerpo normalizado de cada función (leído de la propia migración).

```powershell
pnpm db:plan:local --profile scratch --out dat05.json
pnpm db:migrate:local --plan .biblib/plans/dat05.json --expect-project biblib-scratch --expect-plan <sha256>
pnpm db:status:local --profile scratch   # sin drift
```

**Recuperación.** Las tablas solo contienen datos regenerables (caché, cuotas, reservas). Para desactivar la coordinación sin revertir la migración basta con volver a `fixture` o deshabilitar el proveedor; no hay que crear una segunda cuota local que duplique el límite. Una limpieza manual es `delete from biblib.catalogue_cache` (o `catalogue_invalidate`) con la conexión administrativa, nunca con un rol de cliente.

### Pruebas

- `pnpm test`: `tests/catalogue-gateway.test.ts` (store en memoria, reloj simulado, sin Docker).
- `pnpm test:db`: aplica `0004` en el contenedor aislado y ejecuta `tests/db/catalogue.sql` (reserva atómica, horizonte, tope por dueño, cooldown, fencing, caída nunca cacheada, invalidación, RLS A/B y funciones no ejecutables por `authenticated`).
- `pnpm test:integration:catalogue --profile scratch|test`: grupo `tests/integration/catalogue/` contra Postgres y GoTrue reales, sin compilar ni arrancar la app. Lanza procesos Node distintos con el gateway compilado y un `fetch` simulado que solo registra claves ficticias (ISBN sintéticos `979-0-0009…`); usa un ámbito de credencial propio por run y limpia sus filas. También corre dentro de `pnpm test:integration:local` (perfil `test`). Evidencia: [O08/dat-05](validacion/2026-10-23/O08/dat-05/informe.md).

## Adaptadores bibliográficos Open Library y BNE · U-BIB-02

En modo `live`, Open Library admite ISBN, título/autor y resolución limitada de ediciones. `OPEN_LIBRARY_CONTACT` añade la identificación `BibLib (<contacto>)`; sin contacto sigue `BibLib/1.0`. Todas las operaciones del adaptador comparten el límite conservador de una petición por segundo y respetan `Retry-After` sin reintentos automáticos. La fachada legacy `lib/open-library.ts` delega en este adaptador.

BNE permanece apagada por defecto: `BIBLIB_BNE_ENABLED=true` habilita SRU 1.2 en `https://catalogo.bne.es/view/sru/34BNE_INST` y solo en modo `live`. Consulta ISBN y título/autor, con máximo diez registros, 524288 bytes XML y 3,5 segundos por petición, además del deadline del orquestador. No se configura un endpoint alternativo en producción. Un fallo de BNE permite seguir con OL; para desactivarla basta devolver la bandera a `false`.

Los metadatos BNE tienen política CC0 con procedencia (URL de ficha y hora de recuperación); sus portadas permanecen deshabilitadas. Las cachés locales de ambos adaptadores son acotadas y conservan solo metadatos validados, nunca XML crudo ni imágenes. Hasta integrar U-DAT-05 esta limitación/caché es por instancia; no acredita una cuota global. `fixture` continúa sin llamadas externas. El mapeo MARC, fixtures, consultas públicas y validación están en [el informe O08](validacion/2026-10-23/O08/bib-02.md).

## E2E · U-QA-02

`pnpm test:e2e:local` recorre BibLib en un navegador real (Playwright 1.64.1, fijado en el lockfile) contra el stack Supabase del perfil **`test`** y la app compilada para ese perfil en `127.0.0.1:3148`, con catálogo `fixture`. A y B entran por el formulario «Acceso local de desarrollo» (U-LOC-01) contra GoTrue; no hay Auth simulado. Detalle de grupos, pendientes, hallazgos y correspondencia con el smoke: [tests/e2e/README.md](../tests/e2e/README.md).

```powershell
pnpm db:local:bootstrap --profile test                     # stack, migraciones y fixtures A/B
pnpm test:e2e:local                                        # Chromium con el Chrome del sistema (PR)
pnpm test:e2e:local --project firefox --project webkit     # cierre de ola
pnpm test:e2e:local:ui                                     # modo UI sobre el mismo stack
node tests/e2e/run.mjs --check-untargeted-build            # build sin objetivo sin acceso local
pnpm test:e2e:external                                     # opt-in con Open Library real; nunca en CI
pnpm db:local:down --profile test
```

Opciones de `test:e2e:local`: `--project chromium|firefox|webkit` (repetible), `--reuse-build`, `--grep <texto>` y, solo para depurar el cierre de un navegador, `--no-deps`. Firefox y WebKit se descargan una vez con `pnpm exec playwright install firefox webkit`; si la descarga falla, esos proyectos no se ejecutan y se dice así en la evidencia. Chromium usa `channel: "chrome"`: necesita Google Chrome instalado.

### Qué hace el runner

`tests/e2e/run.mjs` sigue la secuencia de `tests/integration/run.mjs` y reutiliza `tests/integration/lib/` (contexto, sesiones y procesos):

1. Acredita el perfil `test` (registro, huella, propiedad Docker, servicios), toma su bloqueo y exige ledger al día y fixtures A/B completos.
2. Limpia los restos registrados de un E2E anterior y anota las cuentas de Auth.
3. Compila `next-target build local --profile test` (salvo `--reuse-build`) y revisa el bundle de cliente.
4. Arranca la app con `next-target start local --profile test` y una precarga (`tests/e2e/lib/server-network-guard.mjs`) que bloquea y anota cualquier `fetch` del servidor fuera de loopback. Si el puerto 3148 está ocupado sale con **8** y no termina al ocupante.
5. Ejecuta Playwright: por navegador, `<n>-sesion` (A y B entran por el formulario y se guarda su sesión en `.biblib/e2e/state/`), `<n>-flujos` y `<n>` (cierre: renovación, cierre de sesión, A→B, destino externo y limitador).
6. Comprueba que el guard se cargó y no bloqueó ningún host, que las cuentas de Auth no cambiaron, limpia los datos del run y para solo el árbol de procesos que arrancó.

El resultado se acredita con `.biblib/e2e/resultados.json`: superados, fallos conocidos (`test.fail`, documentados), pendientes (`test.fixme`) y repeticiones. `retries` es 0; cualquier repetición o fallo inesperado sale con **11**. Informe HTML en `.biblib/e2e/report`, artefactos de fallo (captura y traza) en `.biblib/e2e/artefactos`, capturas de evidencia en `.biblib/e2e/capturas`, registros `build.log`/`app.log`. Todo bajo `.biblib/`, ignorado por Git y por ESLint. Los proyectos que escriben contraseñas no graban traza y la contraseña nunca forma parte del título de un paso.

### Qué cubre

Acceso (formulario local, ruta privada directa, destino interno, destinos externos, callback inválido, renovación real, cierre con copia de cookies revocada, cambio A→B sin restos, errores genéricos y limitador), catálogo (alta manual sin éxito antes de persistir y con borrador conservado ante un corte de red, ISBN equivalente ya catalogado, edición y conflicto de versión, eliminación), organización (predeterminada protegida, movimiento individual y en lote, recurso borrado en otra pestaña, selección tras error), consulta (tildes, ISBN-10/13, filtros URL, cero resultados, página que deja de existir y el retorno contextual de U-EXP-01), importación de U-DAT-01 (la revisión no escribe, conflicto tras cambiar la colección con archivo y modo conservados, fusión, confirmación repetida sin duplicar y reemplazo real con restauración), privacidad A/B y proveedores fixture (encontrado, no encontrado y fallo simulado en el servidor fixture con el alta manual conservada). En cada recorrido se exige: sin excepciones JS ni errores de hidratación o de consola no declarados, sin tráfico externo del navegador ni del servidor y solo datos ficticios. En Firefox/WebKit, las cancelaciones de peticiones de la app provocadas por una navegación de la prueba se toleran solo si coinciden con una petición abortada, y se anotan en el informe.

Los grupos de unidades futuras (Trabajos, Copias multipart, Proveedores BNE/Google, Producto y parte de Privacidad) son `test.fixme` con la unidad que los activará; aparecen como pendientes, nunca como superados.

### Datos, límites y recuperación

- Lo creado lleva `[QA-02 <run>]`; cada prueba borra lo suyo y el runner barre al final lo marcado de A/B y las vistas previas/operaciones de importación de A/B creadas durante el run. El reemplazo de la importación guarda antes una instantánea literal de la biblioteca de A en `.biblib/e2e/test-run.json` y la restaura; si el proceso se corta, el siguiente run la restaura antes de empezar. Si la limpieza falla, sale con **10** y conserva el manifiesto.
- GoTrue limita `sign_in_sign_ups` a 30 cada 5 minutos por IP y cada navegador hace 11 intentos: caben dos ejecuciones de Chromium seguidas. Antes de Firefox + WebKit o de `test:integration:local`, espera 5 minutos. El limitador del acceso local es por proceso; el recorrido espera 61 s a que se libere.
- `test:e2e:external` no arranca el stack: usa el servicio de catálogo en modo `live` con un ISBN público. Sin red falla con un mensaje explícito, distinto de «no encontrado».
- `--check-untargeted-build` compila sin `BIBLIB_TARGET` en una carpeta temporal (webpack, sin `.env`, con `NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN=1` heredada a propósito) y aplica `check-client-bundle --forbid-local-login`.
- `scripts/smoke-app.mjs` se conserva: la correspondencia escenario → recorrido y lo que queda solo en el smoke están en el README del E2E.
- Hallazgos abiertos que no corrige esta unidad (detalle en el README): la recuperación de portadas, «Buscar portada» y el enriquecimiento de la importación llaman a Open Library con `fetch` directo aunque el modo sea `fixture` (pendiente de U-BIB-05); un id de ficha que no es UUID responde 500 y muestra un error de conexión; cerrar sesión produce una petición RSC 404 inocua en `/login`.

Evidencia del ensayo: [validacion/2026-10-23/O07/qa-02](validacion/2026-10-23/O07/qa-02/informe.md).

## Promoción a preproducción y producción · U-INF-07

U-INF-07 habilita `status`, `plan` y `migrate` para `preprod`/`prod` y añade `db:adopt:<target>`. Esta sección sustituye la indicación de «Migraciones» según la cual esos objetivos salen con **2**. **No hay destino remoto autorizado:** los comandos están preparados y ensayados solo contra Postgres efímeros que simulan el remoto y contra `scratch`; la primera ejecución real requiere la autorización de Néstor. Procedimiento completo, condiciones abiertas y aceptación: [Promoción de migraciones](promocion.md).

```powershell
pnpm db:status:preprod --expect-project <ref> [--json]
pnpm db:plan:preprod --out preprod.json --expect-project <ref> [--json]
pnpm db:migrate:preprod --plan .biblib/plans/preprod.json --expect-project <ref> --expect-plan <sha256> --backup-receipt <recibo.json>
pnpm db:adopt:preprod --plan .biblib/plans/preprod.json --expect-project <ref> --expect-plan <sha256> --backup-receipt <recibo.json>
```

- Solo variables inyectadas (`BIBLIB_EXPECT_PROJECT_REF`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, `SUPABASE_DB_SSLMODE=verify-full`, opcionalmente `SUPABASE_DB_SSLROOTCERT`). Sin `.env`, `supabase link`, `db push` ni `config push`.
- Identidad antes de conectar: URL pública y conexión administrativa del mismo proyecto (`db.<ref>.supabase.co` con rol `postgres`, o `postgres.<ref>` en el pooler de sesión), base `postgres` y TLS verificado contra ese host. Sin TLS, **3**.
- `status` y `plan` usan una transacción `read only`: comprueban rol, permisos, versión, ledger y manifest, derivan la adopción y revisan los datos antes de `0001`/`0002` (listado restringido de correcciones, **5**).
- `migrate` exige plan `migrate` vigente y recibo de respaldo de ese destino y head con ensayo superado; aplica bajo el bloqueo consultivo común, verifica el manifest y que `auth`/`storage` no cambian, y deja un registro en `.biblib/promotions/`. `adopt` exige plan `adopt-ledger` y solo escribe el ledger; nunca acepta `--force`.
- `db:backup:local` escribe ahora `receipt.json` junto a `backup.json`, con alcance Mailpit (copia RAW de los mensajes, sin reinyectarlos), rutas relativas a la raíz y `discardedStateHash`. `db:backup:local --receipt-of <carpeta>` lo reemite tras `db:restore:verify`. Ese recibo es el que aceptan `db:reset:local --backup-receipt` y la promoción.

`pnpm test:scripts` incluye `tests/scripts/promotion.test.mjs` (sin Docker) y `tests/scripts/promotion-stack.test.mjs` (`[stack]`: Postgres efímero propio con TLS autofirmado; se omite con `BIBLIB_SKIP_STACK_TESTS=1`). Evidencia: [O08/inf-07](validacion/2026-10-23/O08/inf-07/informe.md).

## Google Books opcional · U-BIB-03

Google Books permanece apagado por defecto (`BIBLIB_GOOGLE_BOOKS_ENABLED=false`). Cada entorno exige una decisión manual independiente: desplegar el adaptador no lo activa. No hay código para contratar productos, activar facturación ni ampliar cuotas de pago. Sin flag el estado es `disabled`; en `live`, flag activo sin `GOOGLE_BOOKS_API_KEY` da `misconfigured` y cero peticiones. `fixture` prevalece sobre los flags y nunca consulta Google, incluso con una clave sintética.

Antes de permitir tráfico real, el responsable debe comprobar y registrar:

1. Proyecto y consola Google Cloud correctos, Books API habilitada, cuota disponible y límites por día/minuto aplicables al despliegue. El techo técnico de BibLib (una petición cada dos segundos, compartida mediante U-DAT-05, una reserva interactiva por cuenta) no demuestra una cuota del proveedor ni un presupuesto monetario.
2. Precio y coste previstos en ese proyecto, alertas/presupuesto y autorización para cualquier cargo. No se presupone tarifa gratuita garantizada; si no se confirma el coste, dejar Google apagado. Esta entrega no habilita billing ni ejecuta un canary real.
3. [Condiciones de Google Books](https://developers.google.com/books/terms), condiciones generales enlazadas y derechos de contenido; autorización separada o permiso escrito si se pretende cobrar por la aplicación. Facilitar contacto para solicitudes de retirada de contenido.
4. [Privacidad de Google Books](https://books.google.com/googlebooks/privacy.html) y [privacidad de Google](https://policies.google.com/privacy), además del aviso que exige Google sobre contenido enviado que podría hacerse público. Integrar `GoogleBooksNotice` junto al selector antes del primer uso, con su botón que deselecciona Google y permite seguir con OL/BNE/manual. El componente está preparado y probado, pero esta unidad no lo monta en páginas: la integración pertenece al flujo U-BIB-04/05 y debe estar terminada antes del opt-in de usuarios.
5. Key de servidor limitada a Books API y restringida por las IP de salida si la infraestructura lo permite; permisos mínimos en el gestor de secretos del entorno. No usar prefijo `NEXT_PUBLIC_`, pasar claves al navegador, añadir scopes a Google OAuth ni registrar URLs completas. Revisar que proxies, APM y trazas de fetch omitan la query: la clave viaja en ella. El adaptador no registra URL/cuerpo/error externo; `redactGoogleBooksUrl()` devuelve solo el endpoint sin query para cualquier diagnóstico futuro.
6. Procedimiento de rotación: crear una key nueva con las mismas restricciones, sustituirla en el gestor de secretos solo del entorno aprobado, reiniciar el servidor, verificar el estado y revocar la anterior en consola. Ante exposición, revocar la key afectada y desactivar primero el flag; nunca copiarla en informes, incidencias o comandos de diagnóstico.

Tras esas comprobaciones, configurar **en el gestor de secretos del servidor del entorno elegido** `BIBLIB_CATALOGUE_MODE=live`, `BIBLIB_GOOGLE_BOOKS_ENABLED=true` y `GOOGLE_BOOKS_API_KEY`. No hay activación automática por build ni fallback a una key de otro entorno. Para consultar únicamente el estado de configuración, ejecutar con el entorno ya inyectado:

```text
node scripts/catalogue-status.mjs
```

El diagnóstico es local al operador: no crea una acción, endpoint o página, no lee `.env*`, no imprime valores de variables ni claves y no abre conexiones. `ready` indica configuración presente; no certifica permisos de consola, coste ni aceptación de términos. `fixture` indica que no habrá tráfico externo.

Solo se envían el ISBN canónico o título/autor introducidos, además de los parámetros técnicos de API; no se envían identidad, notas, fotos, préstamos ni colección. La respuesta se valida con Zod y se acepta un match ISBN únicamente si un `industryIdentifiers` de tipo ISBN coincide tras normalizarlo. Cada operación consulta como máximo diez volúmenes, sin paginación ni reintentos automáticos, con máximo 1 MiB y 3,5 segundos incluyendo cola/cuerpo. Un 429 conserva `Retry-After`; 403/5xx son indisponibilidad, nunca ausencia de libro.

La política Google `2026-10-23.3` permite **solo preview temporal de portada** y deniega caché/retención de metadatos, persistencia, exportación, offline, rehosting y backup de assets. El adaptador no mantiene caché, los candidatos de metadatos carecen de `coverUrl` y `getCover` entrega por separado la URL HTTPS de imagen sin descargarla. La selección de preview no autoriza escribir `Book.cover`, exportar la imagen ni guardarla en caché permanente; la UI y futuros callers deben aplicar esta política. Hasta revisión legal separada, tampoco persistir/exportar metadatos Google. La coordinación compartida solo conserva claves operativas/reservas, sin payload de Google ni credenciales.

Para recuperar el flujo base, establecer `BIBLIB_GOOGLE_BOOKS_ENABLED=false` y reiniciar el proceso del entorno: Google queda sin peticiones y siguen disponibles OL, BNE según su propia bandera y el alta manual. No se reescriben libros guardados. Las pruebas usan fixtures sintéticos y fetch simulado; [evidencia O09](validacion/2026-10-23/O09/bib-03.md).

## Procedencia, revisión de candidatos y copias v2 · U-BIB-04

`BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED` vale `false` por defecto y se lee en el servidor en cada petición de `/books/add`. Con la bandera apagada, el alta funciona como antes y las acciones solo escriben procedencia v1. Las fichas que ya tienen `catalogue.schemaVersion: 2` no la pierden al editarlas. Con `true`, la búsqueda por ISBN consulta todas las fuentes del orquestador y muestra la revisión de candidatos: tarjetas con evidencia literal, combinación solo con ISBN exacto e idioma/formato compatibles, selección por campo, portada aparte y un resumen editable. Las acciones guardan la fuente de cada campo. Nada se escribe antes de confirmar.

Orden de activación: primero se despliegan los lectores (esta versión lee legacy, v1 y v2, y la procedencia v1 y v2) y después se activa la bandera en el perfil aceptado al cerrar O09. Para volver atrás basta con `BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED=false`: no se borra procedencia ni cambian las fichas guardadas. No se debe volver a una versión de BibLib anterior a U-BIB-04 con fichas v2 sin antes descargar una copia v2.

Ajustes exporta en formato 1 si no se pierde nada y en formato 2 si alguna ficha tiene procedencia BNE o por campo. La importación acepta los tres formatos y rechaza con explicación lo que el modelo actual no puede representar todavía, como varias copias por edición. Detalle de formatos, capacidades y rechazos en [formatos.md](formatos.md); validación en [el informe O09](validacion/2026-10-23/O09/bib-04.md). No requiere migración: `catalogue` es JSONB sin `CHECK` sobre su contenido.

## Trabajos persistentes de importación y portadas · U-DAT-03

La publicación de una importación y la búsqueda de portadas son **trabajos persistentes** en Postgres (`biblib.library_jobs` y `biblib.library_job_items`). Recargar o cerrar la página ya no pierde el progreso: Ajustes retoma el último trabajo de la cuenta y muestra lo confirmado en la base, con pausar, reanudar y cancelar.

### Modelo y protocolo

- **Trabajo**: `kind` (`import` | `covers`), `contract_version`, dueño, `idempotency_key` + `input_digest` (únicos por dueño y tipo), `expected_revision`, `state`, `phase` (`publish` → `covers` → `done`), `cursor`, `counts`, `next_attempt_at`, `lease_until`, `lease_token`, `fencing_number`, `expires_at` y `version`. Estados: `queued → running → waiting_retry/needs_review/paused → succeeded/partially_succeeded/failed/cancelled/expired`. La `version` que ve el cliente solo rota con pausa, reanudación, cancelación, revisión o final; alternar cola y ejecución no la cambia.
- **Elemento**: único por `(job_id, item_key, phase)`, con la versión del libro al crearlo (`target_version`), intentos, resultado durable y el fencing que lo confirmó. FK `(user_id, job_id)` con propietario.
- **Funciones** (`SECURITY DEFINER`, `search_path = pg_catalog`): `library_job_create` y `library_job_control` toman el dueño de `auth.uid()` (EXECUTE para `authenticated`); `library_job_claim` (con `FOR UPDATE SKIP LOCKED`), `library_job_renew`, `library_job_fence`, `account_is_active` y `account_set_state` solo las ejecuta la conexión del servidor. `authenticated` solo tiene `SELECT` de sus filas; la Data API sigue sin exponer `biblib`.
- **Fencing**: cada transacción de escritura del ejecutor empieza con `library_job_fence`, que bloquea la fila del trabajo y exige estado `running`, el mismo token y número de fencing, lease vigente (hora de la base) y cuenta activa. Las escrituras de dominio se hacen después con el rol `authenticated` y los claims del dueño de la fila reclamada. Un trabajador detenido más allá del lease, pausado, cancelado o de una cuenta bloqueada no escribe nada.
- **Ciclo de vida mínimo**: `biblib.account_lifecycle` (sin fila = activa). `select biblib.account_set_state('<uuid>', 'blocked')` desde la conexión administrativa expira los trabajos no terminados (`ACCOUNT_INACTIVE`) y ningún trabajador antiguo vuelve a escribir. U-OPS-03 completará la solicitud y la limpieza de cuenta.

### Ejecución acotada

- Hasta **20 elementos o 20 s por paso**; cada consulta externa con **8 s** como máximo (el orquestador aplica además su plazo de portada) y el presupuesto restante. Lease de **60 s**, renovado antes de consultar si quedan menos de 25 s.
- La publicación (`lib/import-publisher.ts`) es una transacción corta sin red: bloqueo de colección, CAS de revisión, mapeo de IDs, inserciones por lotes y resultado durable en `library_operations`. En la misma transacción se crean los elementos de portada de los libros insertados con portada genérica. Una portada pendiente no revierte una importación publicada.
- Las portadas pasan por el servicio bibliográfico U-BIB con el gateway U-DAT-05 en modo **lote** (`purpose: "batch"`). Fuera de `live` no hay red. Se omiten sin consultar los libros sin ISBN válido, cambiados (versión o preimagen) o con portada.
- **Reintentos**: backoff exponencial con jitter (5 s a 15 min) y 5 intentos por elemento. Un `Retry-After` se respeta como mínimo y detiene el paso; esperar cuota no consume intentos ni se trata como «sin portada». Una caída, un plazo o un JSON roto se reintentan; solo una ausencia confirmada es `not_found`.
- Caducidad: un trabajo activo caduca a los **7 días**; el resumen de uno terminado se conserva **30 días** (se purga al crear otro). Los trabajos no guardan el archivo: la entrada sigue en la vista previa de U-DAT-01.

### Acciones y ejecutor

| Acción | Contrato |
| --- | --- |
| `startImportJobAction({ previewId, idempotencyKey })` | Crea o recupera el trabajo de esa vista previa. Misma clave con otra entrada: `IDEMPOTENCY_CONFLICT`. |
| `startCoverJobAction({ scope: "missing", idempotencyKey })` | Un trabajo de portadas activo por cuenta (`JOB_CONFLICT` si ya hay uno). Ajustes lo inicia con `recoverMissingCoversAction`. |
| `getLibraryJobAction({ jobId })` / `listLibraryJobsAction()` | Vista con IDs técnicos y cantidades confirmadas, sin títulos ni ISBN. Un trabajo ajeno responde `NOT_FOUND`. |
| `pause/resume/cancelLibraryJobAction({ jobId, expectedVersion })` | Versión antigua o transición inválida: `JOB_CONFLICT` (409). Trabajo caducado: `JOB_EXPIRED` (410). Cancelar indica si llegó antes o después de publicar; durante la publicación espera a su commit. |

- `confirmImportAction` conserva su contrato de U-DAT-01 y publica a través de un trabajo: crea o recupera el de la clave, ejecuta en línea el paso de publicación y devuelve `committed` con `jobId`. Si otro trabajador lo tiene, devuelve `queued` con el trabajo. Repetir la clave tras perder la respuesta devuelve el mismo `operationId` con `replayed: true`. Un conflicto deja el trabajo en `needs_review` y nunca se aplica por reintento.
- **Ejecución**: tras responder, las acciones continúan los pasos vencidos con `after()` del servidor Next (hasta 55 s por disparo). Si el proceso cae, el lease caduca y otro disparo continúa. Para avanzar sin la página abierta existe la entrada interna `POST /api/internal/jobs/run`. Solo acepta `Authorization: Bearer <token>`, no lee cuerpo ni sesión y responde 401 a cualquier otra petición. El token es `BIBLIB_JOBS_RUNNER_SECRET` (al menos 32 caracteres) o, si falta, un HMAC derivado de `SUPABASE_DB_URL`. El scheduler de despliegue pertenece a F4.

```powershell
pnpm dev:local --profile scratch                 # o start:local, en otra terminal
pnpm jobs:run:local --profile scratch            # [--once] [--interval-ms 5000]; Ctrl+C para parar
```

`jobs:run:local` sale con **3** si la app rechaza el token y con **8** si la app no responde (`--once`); en bucle registra la caída y reintenta.

### Migración `0005_library_jobs`, rollout y recuperación

```powershell
pnpm db:plan:local --profile scratch --out dat03.json
pnpm db:migrate:local --plan .biblib/plans/dat03.json --expect-project biblib-scratch --expect-plan <sha256>
pnpm db:status:local --profile scratch   # 195 comprobaciones, sin drift
```

La migración crea las tres tablas con RLS, la secuencia de fencing, las funciones y los permisos. El manifest de objetos declara tablas, políticas, grants, restricciones (incluido `library_jobs_lease_check`: en ejecución siempre hay lease y fuera de ella nunca), índices y el cuerpo normalizado de cada función. `objects-0005.json` contiene los metadatos reales tras `0005`.

- **Rollout**: los estados que la página anterior tenía en memoria no se convierten en trabajos. Ajustes ofrece un recorrido nuevo de portadas que solo crea elementos para las portadas todavía genéricas. Orden: portadas primero, importación después.
- **Desactivar**: no llamar a la entrada interna y dejar de usar las acciones. Los leases caducan solos y los resultados siguen consultables. No borrar trabajos activos. Corregir hacia delante con una migración nueva.

### Pruebas

- `pnpm test`: `tests/library-jobs.test.ts`, que cubre transiciones, control, versión, backoff con jitter y `Retry-After`, clasificación de portadas (cuota, caída, plazo y ausencia), el paso de portadas con un repositorio en memoria y el token del ejecutor.
- `pnpm test:db`: `tests/db/jobs.sql` cubre el alta idempotente, A/B, los permisos de `authenticated`, la reclamación, el fencing, la expiración del lease, el control con versión, la cuenta bloqueada, la caducidad, los trabajos que fallan siempre, los elementos y el borrado en cascada.
- `pnpm test:integration:jobs --profile scratch|test [--reuse-build]`: grupo `tests/integration/jobs` contra la base, GoTrue y la app compilada del perfil. Ejecuta procesos Node con el worker compilado y fetch simulado (solo los ISBN sintéticos `979-0-0003…` tienen portada). Cubre dos trabajadores, caídas antes y después del commit, lease vencido, cancelación en cada fase, 429/503/JSON roto, cuenta bloqueada, recargar y continuar desde otra sesión, aislamiento A/B y entrada interna. También corre dentro de `pnpm test:integration:local`. Limpia por ID, dueño y marca `[DAT-03 <run>]`.
- `pnpm test:scripts`: `tests/scripts/jobs-runner.test.mjs` y las comprobaciones de drift de `0005` en `migrations.test.mjs`.

Evidencia: [validacion/2026-10-23/O09/dat-03](validacion/2026-10-23/O09/dat-03/informe.md).

## Rendimiento y capacidad · U-QA-03

`pnpm perf:local` mide la aplicación con datos de escala contra el stack real de un perfil (`test` o `scratch`) y la app compilada para ese perfil, con catálogo en fixture y sin llamadas externas (el proceso de la app lleva el guard de red de U-QA-02: cualquier salida fuera de loopback se bloquea y hace fallar la medición con **11**). La primera medición, previa a U-DAT-04, está en [validacion/rendimiento/2026-10-23](validacion/rendimiento/2026-10-23/informe.md). Se repite al cambiar el modelo de ejemplares (U-DAT-06) y al cerrar el producto.

```powershell
pnpm db:local:bootstrap --profile test                    # el stack y las cuentas A/B; perf:local no arranca ni para el stack
pnpm db:seed:local --profile test --scale 10000           # opcional: 100 | 1000 | 10000 libros en escala@biblib.test
pnpm perf:local --profile test --scale 1000               # contrato del coordinador; --scale 1000 y --profile test por defecto
pnpm perf:local --scale 100 --scale 1000 --scale 10000    # extensión: los tres tamaños en un proceso (reutiliza las sesiones)
pnpm perf:local --scenarios dashboard,listado-inicial,web --json
pnpm perf:local:cleanup --profile test                    # elimina escala@biblib.test y su biblioteca
pnpm db:local:down --profile test
```

**Contrato.** `perf:local [--profile test|scratch] [--scale 100|1000|10000] [--scenarios <lista>] [--out <dir>] [--json]`. `--out` es `docs/validacion/rendimiento/<fecha>/` por defecto. Con `--json` imprime en stdout `{ schemaVersion: 1, profile, scale, results: [{ scenario, p50, p95, budget, status }] }` (con varios `--scale`, `{ schemaVersion, profile, scales: [{ scale, results }] }`) y envía el progreso a stderr. `status` es `ok`, `over-budget` o `no-budget`; `unit` indica `ms` o `score` (CLS). Un presupuesto incumplido **no** cambia la salida: `0` si mide, `2` argumentos, `3` perfil sin registro o ajeno, `8` stack o puerto de la app no disponibles, `11` tráfico externo detectado o escenario de preparación fallido, `130` interrupción. `--scenarios` acepta nombres de acción (`dashboard`, `listado-inicial`, `listado-100-filas`, `listado-ultima-pagina`, `filtrado-estado-estanteria`, `ordenado-autor`, `ordenado-fecha`, `busqueda-local-texto`, `busqueda-local-isbn`, `detalle`, `estanterias`, `estanteria-3d-pagina-48`, `ajustes-recuentos`, `exportacion-servidor`, `preview-importacion-conservar|nuevos|reemplazo`) y pasos (`explain`, `indexes`, `isolation`, `web`, `quota`, `auth`); sin la opción se ejecuta todo. Extensiones: `--skip`, `--reuse-build`, `--web-runs 1-5` y `--cleanup`. Las entradas del contrato son las acciones (`listado-inicial`, con `@5` o `@10` para esas sesiones concurrentes), el SQL real de cada acción (`sql:<escenario>`) y los Web Vitals (`web:<perfil>:<pantalla>:lcp|inp|cls`).

**Datos.** `db:seed:local --scale N` crea la cuenta fixture `escala@biblib.test` (contraseña aleatoria en `.biblib/fixtures/<perfil>-escala.json`, mismo registro privado y ACL que A/B) y deja en ella exactamente N libros ficticios, de forma idempotente y acotada a ese propietario. No toca el censo A/B. El dataset es determinista (`scripts/performance/lib/dataset.mjs`): ISBN-13 válidos del rango 979-0, 15 % de fichas manuales, tildes y eñes, reparto de estados 40/30/22/8 % y estanterías de tamaño desigual (6, 13 y 41). Si la cuenta ya contiene el dataset, `perf:local` no lo vuelve a sembrar. La cuenta usa el metadato del censo, así que `test:integration:local` la acepta; `perf:local:cleanup` la elimina igualmente.

**Cómo se mide.**

- **Acción:** POST real de la Server Action con cookies SSR de sesiones reales de GoTrue (10 de escala, A y B; se abren una vez y se reutilizan; un registro de marcas de tiempo en `.biblib/performance/signins.json` respeta el límite de 30 accesos cada 5 minutos). Latencia de extremo a extremo, p50/p95.
- **SQL:** tiempo de ejecución real de las sentencias de la acción, por diferencia de `pg_stat_statements` antes y después de cada llamada (solo con 1 sesión), y `EXPLAIN (ANALYZE, BUFFERS)` de las consultas principales como `authenticated` con RLS real.
- **Auth:** duración de cada `GET /user` en el registro de GoTrue del perfil y número de llamadas por acción (el proxy y la acción llaman a `getUser()`), más el viaje de ida y vuelta cliente → Kong → GoTrue.
- **Pool:** conexiones `postgres.js` de la aplicación muestreadas cada 100 ms en `pg_stat_activity`.
- **Web Vitals:** Playwright con el Chrome del sistema en dos perfiles declarados: `escritorio-local` (1280×800, sin limitación) y `movil-cpu-x4` (390×844, táctil, CPU ×4 más lenta; solo con 10000). Frío = contexto nuevo con caché vacía; caliente = navegaciones posteriores. INP con gestos de solo lectura.
- **Cuota distribuida:** dos procesos Node independientes con el orquestador y el gateway compilados (el mismo código que la app) contra el Postgres del perfil, con un proveedor simulado. No son dos instancias de Next: una segunda necesitaría un puerto fuera de los reservados.

**Limitaciones.** Es un Postgres local de Docker con la configuración por defecto del stack (`shared_buffers` 128 MB) y con otros contenedores (HolaERP) en la misma máquina; las cifras comparan tamaños y versiones del propio producto, no son un SLA. El frío es el de la aplicación (proceso y conexión nuevos): no se vacía la caché de Postgres. La publicación atómica de staging y los workers de portadas no existen aún (U-DAT-04, U-DAT-03) y se miden en la repetición posterior. Los índices candidatos se miden en transacciones que se revierten; no hay migración.

## Sesión, exposición y cabeceras · U-OPS-04

Inventario completo, matriz y pendientes en [seguridad.md](seguridad.md). Resumen operativo:

- **Cabeceras:** `next.config.mjs` fija `nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin` y `Permissions-Policy` con `camera=()` en todo el sitio, y `Cache-Control: private, no-store` + `Vary: Cookie` fuera de los estáticos. `proxy.ts` publica la CSP en **Report-Only** con un nonce por petición. Para aplicar el nonce, todas las páginas se renderizan dinámicamente (`connection()` en `app/layout.tsx`).
- **`service_role` fuera de Next:** `scripts/next-target.mjs` usa `appEnv(ctx)` y entrega `SUPABASE_SERVICE_ROLE_KEY` vacía a `dev`, `build` y `start` (tampoco se carga desde `.env.local`). Seed, fixtures, copias y runners la obtienen de su propio `loadTarget`. `jobs:run:local` no la necesita. `pnpm dev` y `pnpm start` sin wrapper no aplican este filtro.
- `pnpm security:headers:local --profile scratch|test [--reuse-build] [--out archivo.json]`: compila con `build:local`, arranca `start:local` en el puerto del perfil, pide las rutas del inventario como anónimo y como A y compara las cabeceras efectivas con `scripts/security/headers-matrix.mjs`. Sale con 11 si alguna no coincide. El informe por defecto está en `.biblib/security/headers-<perfil>.json`, sin cookies, tokens ni cuerpos. No usa red externa.
- `pnpm test:integration:security --profile scratch|test [--reuse-build]`: grupo `tests/integration/security` (formulario local, renovación, cierre, callback PKCE real vía Mailpit, misma URL como A/B/anónimo, Data API, grants, `SECURITY DEFINER` y CSP en Chrome con el canal `chrome` de Playwright). Toma el bloqueo del perfil, exige ledger al día y fixtures A/B, y no termina a un ocupante del puerto. No forma parte de `test:integration:local`.
- **Recuperación:** ante una incompatibilidad de la CSP, se mantiene o vuelve a Report-Only. Nunca se desactiva RLS, la protección de rutas ni la validación del callback.

Evidencia: [validacion/2026-10-23/O09/ops-04](validacion/2026-10-23/O09/ops-04/informe.md).

## Búsqueda por título y autor · U-DAT-08

`BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED=true` muestra la sección «Buscar por título y autor» en Añadir libro. Con la bandera apagada también se rechazan las tres acciones nuevas; las fichas guardadas permanecen y sigue disponible la entrada manual. No hay migración ni dependencia nueva.

En `live`, configurar en el gestor de secretos del servidor `BIBLIB_CATALOGUE_CACHE_SECRET` (al menos 32 caracteres), la misma clave que usa la caché privada HMAC de U-DAT-05. Sin ella la búsqueda falla cerrada con un mensaje de configuración y sin consultar proveedores. Las claves de selección van cifradas y autenticadas por cuenta, caducan a los 15 minutos y funcionan entre instancias que compartan ese secreto. Rotarlo invalida las selecciones pendientes, sin cambiar libros guardados. El modo `fixture` emplea exclusivamente datos sintéticos offline y no requiere secretos reales.

`BIBLIB_BIBLIOGRAPHY_MAX_PAGE` limita las páginas de búsqueda y de ediciones: 20 por defecto y valores enteros de 1 a 100. Se admiten 10 o 20 resultados por fuente y página. Al no disponer de un total común fiable, una página llena ofrece la siguiente; una página vacía confirma el final. El texto solo se envía al pulsar Buscar. La caché privada incluye página, tamaño e idioma en su HMAC por dueño; ninguna respuesta incluye dueño, colección o información de aciertos de caché.

Open Library devuelve obras y permite consultar sus ediciones por un ID validado. La búsqueda solicita campos mínimos, nunca `fields=*`; un código de idioma de tres letras filtra con `language:...`, y uno de dos letras expresa preferencia mediante `lang`, según la [Search API](https://openlibrary.org/dev/docs/api/search). BNE conserva su CQL de título/autor y pagina por `startRecord`; veinte resultados requieren como máximo dos respuestas de diez bajo los mismos plazos y cuota. No se añade una capacidad de idioma a BNE. Google permanece apagado salvo su opt-in existente; sus metadatos continúan solo para consulta y no se pueden preparar para guardar.

Al elegir «No sé la edición» se revisa una ficha provisional sin ISBN: al guardarla recibe el identificador compatible `manual-<uuid>`. No se toma ningún ISBN de una obra ni se marca la verificación física por similitud. Las ediciones con varios ISBN distintos tampoco eligen el primero. `prepareCandidateLinkAction` solo prepara la revisión; si lleva una ficha destino exige UUID y versión actual, comprobados con sesión/RLS, y la escritura posterior debe usar el CAS de `updateBookAction`. El montaje de Añadir libro solo ofrece altas; no añade enlaces masivos.

Validación sin stack y limitaciones de la puerta integrada: [O10/dat-08](validacion/2026-10-23/O10/dat-08.md).

## Todos los flujos por el orquestador: pruebas, medición y activación · U-BIB-05

Los cuatro flujos bibliográficos consumen **solo** el orquestador de `lib/bibliographic-catalog` (con el gateway de U-DAT-05 en `live`). Ninguno hace `fetch` propio ni conoce un host de proveedor.

| Flujo | Entrada | Ruta |
| --- | --- | --- |
| Alta por ISBN | `/api/books/search`, `lookupIsbnAction`, `getCoverAction` | `bibliographicCatalog.lookupISBN` / `getCover` con el `userId` de la sesión. |
| Búsqueda por título y autor | acciones de U-DAT-08 | `bibliographicCatalog.searchTitleAuthor` (caché privada por dueño con HMAC). |
| Importación | `prepareImportAction` + `confirmImportAction` | La revisión **no consulta catálogos**. La publicación crea los elementos de portada de los libros insertados y el trabajo de portadas los resuelve después. |
| Recuperación de portadas | `recoverMissingCoversAction` y «Buscar portada» de la ficha | Trabajo persistente (`purpose: "batch"`) o, para una ficha, `getCover` interactivo fuera de cualquier transacción. |

- **Prueba estática** (`tests/bibliographic-catalog-egress.test.ts`): falla si `openlibrary.org` o `catalogo.bne.es` aparecen fuera de `lib/bibliographic-catalog/providers/` (los nombres de host viven en `providers/endpoints.ts`; `next.config.mjs` y `proxy.ts` pueden nombrar solo `covers.openlibrary.org` como host de imágenes) o si hay un `fetch` hacia un destino que no sea una ruta propia (`/api/…`) fuera del adaptador y del gateway. Comprueba además que la revisión de la importación no importa el catálogo.
- **Importación acotada y reanudable.** Pasos de hasta 20 libros o 20 s, una petición a la vez (nunca una por fila en paralelo), `Retry-After` respetado, pausa, reanudación y cancelación, y contadores confirmados (recuperadas, sin resultado, omitidas, reintentos). La fuente de cada portada consta en el resultado del elemento (`result.provider`), en la telemetría por proveedor (`cover.recovery`, `operation: cover.source`) y, con `BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED=true`, en la procedencia del campo `cover` (selección «sin verificar»). Una portada pendiente no bloquea la importación ni la revisión. Las consultas de lote no se agrupan en una petición multi-ISBN: cada ISBN pasa por el orquestador y su plaza de cuota, que es lo que acota el tráfico a Open Library.
- **Retención** (`lib/bibliographic-catalog/retention.ts`, derivada de `rights.ts`; desconocido = denegado). Open Library: fichas y portadas (la URL) pueden guardarse y exportarse con su atribución. BNE: solo metadatos CC0 con URL del registro y hora; sus imágenes nunca. Google: nada permanente, solo vista previa temporal; ninguna ficha ni portada suya llega a `Book`, a la exportación ni a la caché. La exportación contiene únicamente la biblioteca de la cuenta (con `catalogue` y procedencia por campo): nunca la caché sin seleccionar ni diagnósticos de proveedores. Un trabajo o una ficha **nunca** guardan una imagen que la política no permita, aunque sea la primera candidata. Las ediciones manuales no se borran.

### Fixtures de proveedor para pruebas y E2E

En `fixture` no hay red. `lib/bibliographic-catalog/providers/fixture.ts` reserva ISBN válidos fuera del censo A/B para ensayar cada resultado de una fuente:

| ISBN | Resultado |
| --- | --- |
| `9780000000040` | Open Library «no disponible» (5xx simulado). |
| `9780000000064` | Open Library 429 con `Retry-After`. |
| `9780000000071` | Open Library no responde hasta agotar su plazo (≈3,5 s). |
| `9780000000088` | Todas las fuentes con la cuota compartida agotada (espera de 1 h). |
| `9780000000095` | Open Library sin ficha y BNE con ficha («un proveedor vacío y otro disponible»). |

En `fixture`, BNE participa por defecto con su adaptador ficticio (`BIBLIB_BNE_ENABLED=false` lo apaga); en `live` sigue apagada salvo bandera. Una ficha solo-BNE lleva procedencia v2 y solo puede guardarse con `BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED=true`: activar BNE y la revisión juntos forma parte de la activación de F2.

### Benchmark con red simulada

```powershell
pnpm perf:catalogue [--build] [--out .biblib/performance/catalogue-bench.json] [--check]
```

Compila las pruebas si hace falta y ejecuta, en tiempo virtual (×10) y sin red, el orquestador, el adaptador de Open Library y el gateway reales con un simulador de proveedor. Para 1, 10 y 100 consultas concurrentes (cada una de una cuenta distinta) mide en cuatro fases —fría, caliente, con fallos (15 % de cuelgues y 10 % de 429) y sin respuesta— p50/p95, peticiones al proveedor, consultas atendidas sin salir (duplicados y aciertos de caché), claves deduplicadas en vuelo, limitadas, plazos agotados, cola máxima y entradas y bytes de caché. **No mide el rendimiento de ningún proveedor real ni de Internet**: las latencias son inventadas y deterministas. Con `--check` sale con 1 si alguna fase supera el límite de peticiones por segundo del proveedor, repite un ISBN ya resuelto, supera el plazo común o cuenta un fallo como «no encontrado». También lo ejecuta `pnpm test:scripts` (`tests/scripts/catalogue-bench.test.mjs`).

### Telemetría agregada por proveedor (operador)

```powershell
docker logs <app> 2>&1 | node scripts/catalogue-telemetry.mjs [--json]
node scripts/catalogue-telemetry.mjs --file registros.jsonl --json
```

Suma, desde los registros JSON de `lib/observability` (que ya no llevan ISBN, consultas, claves ni cuentas), por `open-library`, `bne` y `google-books`: consultas y resultado por fuente, latencia p50/p95, errores clasificados (`rate_limited`, `timeout`…), aciertos de caché, esperas de cuota omitidas, caídas de la coordinación y portadas recuperadas por fuente, más reintentos y fallos de trabajos. Solo muestra cantidades; las líneas no válidas se cuentan y no se reproducen. No abre red ni lee variables o archivos de configuración. Como los registros salen de cada instancia, el resumen de un despliegue con varias instancias exige reunir sus registros.

### Probe real opcional

`pnpm test:e2e:external` (`tests/e2e/externo/open-library.spec.ts`) consulta **un** ISBN público en Open Library y BNE reales (como mucho tres peticiones, Google apagado). No forma parte de la suite ni de CI y **solo debe ejecutarse con autorización de quien opera el despliegue**. Comprueba que cada fuente responde con ficha o sin ella y que el ISBN de la ficha es el consultado; una ausencia se anota («sin ficha») y no falla por un recuento esperado; una caída o un límite sí fallan, porque no son una ausencia.

### Pruebas

- `pnpm test`: `bibliographic-catalog-flows.test.ts` (recuperación acotada y reanudable sobre red simulada, cola y caché compartidas entre instancias, Google apagado con cero salidas, ni clave ni consulta privada en logs, resultados ni claves de caché, contrato por operación y estado), `bibliographic-catalog-retention.test.ts`, `bibliographic-catalog-egress.test.ts` y los existentes de contrato, adaptadores, Google y gateway.
- `pnpm test:scripts`: benchmark con `--check` y resumen de telemetría.
- `pnpm test:e2e:local`: `flujos/proveedores.spec.ts` (BNE disponible con Open Library vacía; 429, plazo agotado, 5xx y ausencia distinguidos por código HTTP y pantalla; cuota global agotada sin reintentos automáticos), `flujos/ajustes.spec.ts` (recuperación de portadas en fixture) y `flujos/importacion.spec.ts` (la revisión no consulta catálogos y las portadas se resuelven después).

### Activación y recuperación

1. **F1**: `fixture` para revisar contrato y UI. `live` con Open Library (limitador y gateway) y BNE con `BIBLIB_BNE_ENABLED=true` junto con `BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED=true`.
2. **F2**: Google solo con `BIBLIB_GOOGLE_BOOKS_ENABLED=true` y clave de servidor tras revisar cuota, coste y términos; su vista previa nunca se conserva.
3. **Recuperar**: volver a `fixture`, apagar un proveedor con su bandera o desactivar la revisión. Los datos de libros y los metadatos ya elegidos no se tocan; la entrada manual sigue disponible.

## Una verificación de sesión por petición y capacidad con varias sesiones · U-FIX-02

Tareas T3 y T4 de [U-QA-03](validacion/rendimiento/2026-10-23/informe.md#9-tareas-por-presupuesto-incumplido). Decisión de seguridad en [seguridad.md](seguridad.md#verificación-de-sesión-por-petición-u-fix-02); medición en [validacion/rendimiento/2026-10-23-fix-02](validacion/rendimiento/2026-10-23-fix-02/informe.md).

- **Sesión:** `proxy.ts` verifica con GoTrue y entrega a la acción de la misma petición una atestación firmada (`x-biblib-session-attestation`, clave aleatoria por proceso, ≤ 30 s, ligada a token, usuario y nonce). `getRequiredUserId()` la acepta junto con la verificación local del JWT; si falta o no valida (rutas `/api`, otro proceso), llama a `getUser()`. Una sesión cerrada sigue recibiendo 307 en páginas y acciones.
- **Pool:** `lib/db/client.ts` abre hasta **4** conexiones por proceso (antes 1). Presupuesto: 4 por réplica de la app más las del gateway del catálogo; con `max_connections = 100` del stack local sobra margen. La preparación RLS de cada transacción es una sola sentencia.
- **Inicio:** `getLibrarySummaryAction` comprueba la estantería predeterminada en la misma consulta de recuentos y solo llama a `ensureDefaultShelf` si falta.

```powershell
pnpm db:local:bootstrap --profile test
pnpm perf:t4 --profile test --scale 10000                     # experimento T4: variantes base, pool-2, pool-4, sin-getuser-accion, idas-minimas, sin-getuser
pnpm perf:t4 --variants base --label experimento-t4-despues   # solo el código actual
pnpm perf:local --profile test --scale 10000 --skip web --skip indexes --skip quota --skip explain --out docs/validacion/rendimiento/2026-10-23-fix-02/despues
pnpm perf:local:cleanup --profile test
pnpm db:local:down --profile test
```

**`perf:t4`.** `[--profile test|scratch] [--scale 100|1000|10000] [--variants <lista>] [--scenarios <lista>] [--concurrency 1,5,10] [--out <dir>] [--label <nombre>]`. Por cada variante reescribe los archivos que cambia (`scripts/performance/lib/t4-variants.mjs`), compila, **restaura el original antes de arrancar la app** y comprueba con `git diff` que el árbol quedó igual (si no, sale con 11). Las variantes que quitan llamadas a GoTrue son diagnósticas y nunca se integran. Si el código cambió y el ancla de una variante ya no existe, falla antes de compilar. Abre 10 sesiones una vez para todas las variantes (límite de GoTrue respetado con el registro de `perf:local`) y añade dos sondas: `GET /auth/v1/user` directo a Kong y `GET /login` (Next sin Auth ni Postgres). Salidas: 0, 2 argumentos, 3 perfil ajeno, 8 stack o puerto, 11 build, red externa o árbol sin restaurar, 130 interrupción. No lo ejecutes con cambios sin commitear en los archivos de las variantes.

## Versiones anteriores y deshacer recuperable · U-DAT-02

Antes de cada operación destructiva (reemplazar la biblioteca con una importación o restaurar una versión), BibLib guarda en Postgres la colección que se va a sustituir. Ajustes muestra el historial («Versiones anteriores») con fecha, motivo, cantidades y caducidad, y permite comparar una versión con la colección actual y restaurarla. Fusionar no es destructivo y no guarda nada.

### Modelo y protocolo

- **`biblib.library_snapshots`**: cabecera por versión con dueño, `source_operation_id` (la operación de `library_operations` que sustituyó ese estado), `reason` (`import.replace` | `snapshot.restore`), `captured_revision`, `schema_version` (1), `state` (`capturing` → `ready`), `counts` (`books`, `shelves`, `chunks`, `bytes`), `digest`, `version` (solo autoriza borrar esa versión), `expires_at` y `created_at`. Única por `(user_id, source_operation_id)`: una operación, una versión.
- **`biblib.library_snapshot_chunks`**: trozos de hasta **200 filas** de un tipo (`shelves` primero, en orden de creación; después `books`, por ID), cada uno con el sha256 de su JSON. El hash de la cabecera es `sha256("biblib.snapshot.v1|libros|estanterías|" + hashes de los trozos en orden)`: un trozo perdido, alterado o desordenado invalida la versión. No se guarda `books.version`: nunca se reutiliza un token de edición.
- **RLS y permisos**: `authenticated` solo tiene `SELECT` de sus filas (política `*_select_own`) y ninguna escritura directa. FK compuestas con propietario: trozos → versión (`ON DELETE CASCADE`), versión → operación (sin acción: purgar operaciones no borra versiones en silencio) e `import_previews.snapshot_id` → versión (`CASCADE`). Todo cuelga de `auth.users` en cascada.
- **Funciones** (`SECURITY DEFINER`, `search_path = pg_catalog`, dueño de `auth.uid()`):
  - `library_snapshot_capture(operación, motivo)` exige la operación registrada en **la misma transacción** (`created_at = now()`) y la cuenta activa (U-DAT-03). Toma el bloqueo de colección, retira las versiones vencidas del dueño, comprueba la cuota y el tamaño y escribe cabecera y trozos por conjuntos. Errores propios: `BS001` (cuota), `BS002` (cuenta bloqueada) y `BS003` (tamaño).
  - `library_snapshot_foreign_ids(versión)` devuelve los IDs de una versión propia que hoy usa otra cuenta, sin revelar su titular.
  - `library_snapshot_delete(versión, versión vista)` toma el bloqueo de colección (espera a una restauración en curso) y borra en cascada trozos y vistas previas de restauración.
  - `library_snapshot_purge_expired(límite)` retira versiones vencidas de todas las cuentas. Solo la ejecuta la conexión del servidor, para el mantenimiento de F4/U-OPS-03.

### Atomicidad

El publicador (`lib/import-publisher.ts`) registra la operación durable, captura la versión anterior y aplica el plan **en la misma transacción final**, bajo el bloqueo de colección y tras comprobar clave, caducidad y revisión. Si la captura falla (cuota, tamaño, cuenta o cualquier error), no se reemplaza nada y no queda ninguna versión: la transacción entera se revierte. Restaurar (`publishSnapshotRestore`) sigue el mismo orden y captura antes el estado que va a sustituir, así que una restauración también se puede deshacer.

### Acciones (`app/actions/library-snapshots.ts`, todas `ActionResult`)

| Acción | Contrato |
| --- | --- |
| `listLibrarySnapshotsAction({ cursor, limit })` | Versiones vigentes del dueño, de la más reciente a la más antigua, con cursor opaco (fecha con microsegundos + ID), hasta 20 por página, cuota (`used`/`limit`) y días de retención. |
| `previewSnapshotRestoreAction({ snapshotId })` | Crea una vista previa de U-DAT-01 (`import_previews` con `snapshot_id` y sin copiar el contenido) con la revisión actual, el plan de reemplazo y los títulos acotados que desaparecen y que vuelven. Una versión ajena, inexistente o incompleta responde `NOT_FOUND`; una vencida, `PREVIEW_EXPIRED`. |
| `restoreSnapshotAction({ previewId, expectedRevision, idempotencyKey })` | Bajo el bloqueo: clave (una repetición idéntica devuelve el mismo `operationId` con `replayed: true`), caducidad, revisión, versión vigente, hashes y plan derivado de nuevo. Conserva los IDs propios (también los de libros borrados después), reasigna e informa los que ocupa otra cuenta, mantiene la predeterminada actual, regenera las versiones de ficha y rota la revisión de colección. Si la colección cambió: `REVISION_CONFLICT`, sin aplicar nada; hay que volver a comparar. |
| `deleteLibrarySnapshotAction({ snapshotId, expectedVersion })` | Borrado explícito. Una versión antigua es `CONFLICT`; ajena o inexistente, `NOT_FOUND`. |

`confirmImportAction` no cambia de contrato: un reemplazo bloqueado por la cuota o el tamaño devuelve `LIMIT_EXCEEDED` (413, no reintentable) con un mensaje que explica cómo liberar espacio. Ajustes usa entonces una clave nueva, porque no se aplicó nada.

### Retención, cuota e inventario

- **30 días** por versión y **10 versiones vigentes por cuenta** (propuesta inicial; F4 fija la capacidad definitiva). Una versión guarda como mucho 10 000 libros y 1 000 estanterías. Con la cuota agotada se bloquea la operación destructiva: **ninguna versión vigente se borra para hacer sitio**, la persona decide cuál eliminar. Las vencidas no se listan ni se restauran, y se retiran al capturar la siguiente o con `library_snapshot_purge_expired`.
- Tamaño medido en scratch (fichas sintéticas con autoría, editorial y portadas): 111 libros ocupan 75 KiB en 2 trozos y se capturan en 13 ms; 10 000 libros, 6,6 MiB en 51 trozos y 393 ms dentro de la transacción de publicación ([medida](validacion/2026-10-23/O10/dat-02/18-tamano-captura.txt)). Con la cuota llena, una cuenta grande ocupa unos 66 MiB.
- **Inventario para U-OPS-03** (`SNAPSHOT_INVENTORY` en `lib/library-snapshots.ts`): `biblib.library_snapshots`, `biblib.library_snapshot_chunks` y las vistas previas con `snapshot_id`. Una cuenta bloqueada (`account_set_state(..., 'blocked')`) no puede capturar y, por tanto, tampoco reemplazar ni restaurar. Borrar la cuenta elimina en cascada sus versiones, trozos y operaciones. La limpieza integral la completa U-OPS-03.
- El respaldo portable (JSON de Ajustes) sigue incluyendo solo la colección activa. Exportar una versión anterior sería una acción aparte, todavía no implementada.

### Migración `0006_library_snapshots`, índices T8, rollout y recuperación

```powershell
pnpm db:plan:local --profile scratch --out dat02.json
pnpm db:migrate:local --plan .biblib/plans/dat02.json --expect-project biblib-scratch --expect-plan <sha256>
pnpm db:status:local --profile scratch   # 242 comprobaciones, sin drift
```

La migración crea las dos tablas con RLS, FK e índices, las cuatro funciones y sus permisos. También añade `import_previews.snapshot_id` (con `payload` opcional y la restricción «archivo o versión, nunca ambos»), el índice único `library_operations (user_id, id)` y el motivo `snapshot.restore`. Incluye además los índices de la **tarea T8** de U-QA-03:

| Índice | Consulta que lo usa (EXPLAIN como `authenticated` con RLS, 10 000 fichas) | p50 con / sin índice |
| --- | --- | --- |
| `books_user_title_idx (user_id, title, id)` | Colección, página 1 | 0,05 ms / 13,7 ms |
| `books_user_shelf_title_idx (user_id, shelf_id, title, id)` | Estantería 3D (48) | 0,10 ms / 3,0 ms |
| `books_user_created_idx (user_id, created_at DESC, id DESC)` | Inicio, «Añadidos recientemente» | 0,04 ms / 10,1 ms |

Los índices descendentes se declaran con `NULLS FIRST`, el orden por defecto de `ORDER BY … DESC`. Con el `DESC NULLS LAST` que Drizzle genera por defecto, el planificador no usaba el índice.

**Plan de retirada de los índices T8**: son aditivos y no los necesita ninguna restricción. Para retirarlos basta con una migración posterior con `DROP INDEX biblib.<índice>` (o `DROP INDEX CONCURRENTLY` fuera de transacción en producción), quitarlos de `lib/db/schema.ts` y del manifest de objetos y medir de nuevo con `docs/validacion/2026-10-23/O10/dat-02/explain-indices.mjs`, que simula esa retirada en una transacción revertida. `books_user_id_idx` se conserva durante la transición. Cada uno cuesta un 20–22 % de escritura masiva (U-QA-03 §6).

- **Rollout**: no se infiere historial anterior al despliegue. La primera sustitución tras desplegar captura el estado vigente. Desplegar primero captura y listado, y habilitar la restauración tras ensayarla en el entorno.
- **Desactivar**: ocultar la sección de Ajustes no borra versiones. La restauración administrativa sigue el respaldo de F4 ([recuperación](recuperacion.md)), no un SQL inverso improvisado. Correcciones siempre hacia delante, con una migración nueva.
- **Restore administrativo**: las versiones se restauran tal cual y se comprueba su integridad (ver [recuperación](recuperacion.md#versiones-anteriores-u-dat-02)).

### Ajustes

La sección «Versiones anteriores» muestra la cuota y, al agotarse, un aviso. Restaurar exige comparar con la colección actual y confirmar con una casilla; un conflicto obliga a comparar de nuevo y nunca se reintenta solo. Si se pierde la respuesta, confirmar otra vez con la misma clave devuelve el mismo resultado. Eliminar pide confirmación.

**Tarea T2 (CLS de Ajustes)**: los avisos de la página van en una región `aria-live` fija abajo, con botón para cerrarlos, y ya no desplazan el contenido. El estado de la última copia tiene espacio reservado y las partes de una copia dividida se ofrecen en un diálogo, que se puede volver a abrir con «Ver las N partes de la última copia».

### Pruebas

- `pnpm test`: `tests/library-snapshots.test.ts` cubre el plan de restauración (IDs propios, reasignación estable de IDs ajenos, predeterminada, comparación), la integridad (trozo alterado, perdido, desordenado o con cantidades distintas), el cursor, la clave de idempotencia y la traducción de `BS001`–`BS003`.
- `pnpm test:db`: `tests/db/snapshots.sql` cubre la captura en la transacción de su operación, los hashes, el aislamiento entre cuentas, los permisos mínimos, los IDs ocupados, el borrado con versión y las cascadas, la cuota sin borrado silencioso, la cuenta bloqueada y el límite de tamaño.
- `pnpm test:integration:snapshots --profile scratch|test [--reuse-build]`: grupo `tests/integration/snapshots` (también dentro de `pnpm test:integration:local`). Con sesiones GoTrue reales y la app compilada del perfil cubre:
  - una versión exacta por reemplazo;
  - que B no lista, descarga, compara, restaura ni borra la versión de A;
  - deshacer con IDs propios y versiones nuevas;
  - el conflicto de una segunda pestaña;
  - un fallo inyectado entre la captura y la publicación (en el publicador compilado, dentro de su transacción);
  - caducidad, cuota agotada, borrado durante la vista previa, respuesta perdida y cuenta bloqueada;
  - la comprobación de integridad del restore administrativo.

  La biblioteca de A se guarda en `.biblib/integration/` y se devuelve exacta, también tras una caída.
- `pnpm test:scripts`: drift de `0006` en `migrations.test.mjs` y el trato de las versiones en el restore (`snapshots-restore.test.mjs`).

Evidencia: [validacion/2026-10-23/O10/dat-02](validacion/2026-10-23/O10/dat-02/informe.md).

## Vistas guardadas y filtros reproducibles · U-EXP-02 (O10)

La colección mantiene su fuente de verdad en la URL: `q`, `status`, `shelf`, `sort`, `page`,
`view` y `pageSize` (10 por defecto, de 10 a 100; el enlace 3D conserva 48). El parseo limita
texto a 500 caracteres y reemplaza valores malformados por criterios seguros. Los cambios
de filtros y página crean entradas de historial; la canonización inicial y la corrección
de página fuera de rango sustituyen la entrada vigente. Atrás/Adelante restaura los controles.

«Vistas guardadas» permite guardar, aplicar, renombrar, sobrescribir y borrar, con confirmación
para las dos últimas. Ningún cambio se anuncia como guardado antes de la respuesta del servidor.
Un fallo conserva los filtros y el borrador. Aplicar consulta las estanterías vigentes, omite
las eliminadas y vuelve a página 1. Los cambios de filtros/página limpian la selección temporal;
el fallo de un movimiento conserva esa selección.

### Contrato, cuotas y aislamiento

`SavedBookView = { id, name, filters, updatedAt, version }`; `filters` solo admite
`{ q?, status, shelf, sort, view, pageSize }`. Zod valida lecturas y escrituras; no se guardan
páginas, selección, libros ni consultas SQL. Las cinco acciones de `app/actions/saved-views.ts`
devuelven `ActionResult`. Renombrar, sobrescribir y borrar exigen `expectedVersion`; un token
anterior devuelve `CONFLICT` y una vista ajena/inexistente, `NOT_FOUND`.

`0007_saved_views` añade `biblib.saved_book_views` con propietario FK a `auth.users`, RLS para
las cuatro operaciones, índice `(user_id, updated_at DESC)` y unicidad `(user_id, lower(name))`.
Se evita así tener dos accesos indistinguibles por mayúsculas en una misma cuenta; no se
fusionan nombres de usuarios diferentes ni se eliminan acentos. El servidor recorta el nombre
y exige de 1 a 80 caracteres; la base también limita y exige el nombre recortado.

La cuota de 100 se comprueba en servidor y en un trigger de base que serializa las altas por
cuenta con un bloqueo consultivo. El trigger impide transferir filas y rota la versión en cada
escritura. Una función de validación JSON y un CHECK impiden introducir criterios no admitidos
también por SQL. Ninguna de estas operaciones modifica `library_state` ni toma el bloqueo de
colección. La Data API sigue sin exponer el esquema `biblib`.

### Ejecutar, desplegar y recuperar

```powershell
pnpm db:local:bootstrap --profile scratch
pnpm db:status:local --profile scratch
pnpm test:integration:views --profile scratch  # también acepta test; --reuse-build opcional
pnpm db:local:down --profile scratch
```

El grupo `views` también está incluido en `test:integration:local` (perfil test). Usa GoTrue,
acciones HTTP, Postgres y Chrome reales; cubre A/B, SQL, Data API, versiones, nombres, JSON,
cuota con dos conexiones para el último hueco, estantería borrada, errores de red, confirmación
y navegación. `tests/saved-views.test.ts` cubre el contrato puro y
`tests/e2e/flujos/vistas.spec.ts` incorpora el CRUD a la suite E2E del coordinador.

Desplegar primero la migración aditiva y después la aplicación. Para retirar la interfaz,
ocultar el panel conserva las filas, los filtros URL y el catálogo. No ejecutar un DROP durante
la recuperación: las preferencias viajan en el respaldo administrativo, como se detalla en
[recuperación](recuperacion.md#vistas-guardadas-u-exp-02). El JSON portable de cuenta sigue
incluyendo libros y estanterías.

Evidencia: [O10/exp-02](validacion/2026-10-23/O10/exp-02/informe.md).

## Accesibilidad y reflujo · U-EXP-03 (O11)

```powershell
pnpm db:local:bootstrap --profile test
pnpm test:a11y:local
pnpm test:a11y:local --project firefox --project webkit --reuse-build
pnpm test:e2e:local --reuse-build
node tests/accessibility/performance.mjs antes
node tests/accessibility/performance.mjs despues
pnpm perf:local:cleanup --profile test
pnpm db:local:down --profile test
```

La suite reutiliza las guardas, sesiones por formulario local, bloqueo de red y limpieza del
runner E2E. `@axe-core/playwright@4.11.1` está fijado; no admite violaciones serious/critical ni
excluye reglas. Prueba claro/oscuro, las rutas principales, teclado, contención/retorno de foco,
alertas únicas, orden de tabla, movimiento reducido, 320/375/768/1440 px y viewport equivalente
a zoom 200/400 %. Los proyectos de cierre se ejecutan después de los flujos para que revocar
la sesión no invalide las pruebas restantes. Sin `--reuse-build` compila el perfil test.

El ensayo T6 recompila y reutiliza el perfil móvil original de U-QA-03 (390×844, DPR 3,
táctil, CPU×4, sin limitación de red), dataset de 10 000 libros/41 estanterías, dos contextos
por pantalla y los mismos gestos. Guarda INP/LCP/CLS y agregados de trace sin argumentos,
URLs, credenciales ni trace crudo. No compara una muestra actual directamente con los 496 ms
históricos como si fueran ejecuciones simultáneas.

Resultados, límites y excepciones: [accesibilidad.md](accesibilidad.md) y
[evidencia O11](validacion/2026-10-24/O11/exp-03/). Los ensayos con NVDA/Narrator, VoiceOver,
Safari/iOS, Edge y zoom nativo están pendientes en
[manual.md](../tests/accessibility/manual.md); los motores Playwright no los sustituyen.
No se certifica WCAG. Los cambios CSS/semánticos no requieren migración; una regresión se
revierte en el componente afectado conservando los indicadores de foco.

## Restauración por partes con staging y publicación atómica · U-DAT-04

Una copia grande se descarga en varias partes (cada una importable por sí sola) más un manifiesto `bundleVersion: 1` ([formato](formatos.md#conjunto-de-partes-bundleversion-1)). «Restaurar una copia por partes», en Ajustes, sube todas las partes a un staging privado, las comprueba juntas y sustituye la colección en **una sola transacción**: nunca queda una restauración a medias. La importación de un archivo suelto (U-DAT-01) no cambia.

### Sesión y staging (migración `0008_restore_sessions`)

| Tabla | Contenido |
| --- | --- |
| `biblib.import_sessions` | Dueño, `state` (`receiving` → `validated` → `prepared` → `committed`, o `rejected`), `source` (`manifest` o `loose`), manifest validado y su sha256 (hash global), revisión base, versión de reglas, partes, bytes recibidos, totales, vista previa (`preview_id`, revisión, caducidad y plan), `operation_id`, `version` y `expires_at` (7 días). |
| `biblib.import_session_parts` | Parte esperada: `part_id` estable, posición, tamaño y sha256 exactos, número de trozos de 256 KiB y recuentos comprobados. |
| `biblib.import_session_chunks` | Trozos de los bytes originales (`bytea`, hasta 256 KiB). Postgres comprueba que `octet_length(bytes) = byte_length` y que `sha256 = encode(sha256(bytes), 'hex')`. |
| `biblib.import_session_rows` | Libros y estanterías validados y normalizados, con clave estable `(sesión, tipo, ID de origen)`. |

- **RLS de propietario** en las cuatro tablas y FK compuestas con `user_id` (trozo → parte → sesión → `auth.users`, en cascada). `authenticated` gestiona sus sesiones y partes; trozos y filas solo admiten `SELECT`, `INSERT` y `DELETE`: nunca se modifican. `anon` no tiene ningún privilegio y la Data API no expone `biblib` (406).
- **Guarda `biblib.guard_import_staging()`** (`BEFORE INSERT` en trozos y filas, error `BR001`): solo entran en una sesión propia que siga en `receiving` y no haya caducado. Lo validado o preparado ya no cambia.
- **`biblib.import_session_purge_expired(límite)`**: retira por lotes las sesiones caducadas con todo su staging. Solo la ejecuta el servidor (mantenimiento F4/U-OPS-03).
- **Operación durable `restore.commit`** en `library_operations`.
- **Inventario para U-OPS-03**: `RESTORE_SESSION_INVENTORY` en `lib/import-staging.ts`.

### Flujo y contratos (`app/actions/restore-sessions.ts`, todas `ActionResult`)

| Acción | Contrato |
| --- | --- |
| `beginRestoreSessionAction({ manifest } \| { parts: [{ byteLength, sha256 }] })` | Abre la sesión. Con manifiesto, este fija orden, hashes, tamaños y cantidades. Con partes sueltas (asistente para v1/v2 sin manifiesto) solo se fijan tamaños y hashes, y el manifiesto lo genera el servidor al validarlas. Antes de aceptar ningún byte rechaza: duplicados y manifiestos incoherentes (`MANIFEST_MISMATCH`, 422), y más de 10 000 libros, 1 000 estanterías, 80 MiB, 50 partes, 8 MiB por parte o 3 sesiones abiertas (`LIMIT_EXCEEDED`, 413). |
| `uploadRestorePartAction({ sessionId, partId, ordinal, total, sha256, chunk: Blob })` | Un trozo de los bytes originales, por FormData/Blob (nunca base64). El servidor mide el tamaño real (≤ 256 KiB y exactamente el que corresponde a esa posición), la posición, el total y el hash antes de guardar. Repetir un trozo idéntico devuelve `replayed: true` sin cambiar nada; otro contenido en la misma posición es `CONFLICT`. Un trozo nunca autoriza ni publica nada. |
| `validateRestoreSessionAction({ sessionId })` | Reconstruye cada parte en orden y comprueba tamaño y sha256 sobre los bytes exactos. La decodifica, comprueba formato y cantidades frente al manifiesto, la valida con el lector común (legacy, v1 o v2) y deja sus filas en staging, **una transacción por parte**. Después comprueba el conjunto: sin libros repetidos (ID o ISBN), estanterías compartidas con el mismo ID y atributos, sin dos estanterías con el mismo nombre, una sola predeterminada, totales del manifiesto y límites. Un fallo rechaza la sesión, libera el staging y no toca la colección. Faltar partes no rechaza: se pueden completar. |
| `prepareRestoreSessionAction({ sessionId })` | Bajo el bloqueo de colección, plan de reemplazo (U-DAT-01) frente a la colección actual. Se conserva la predeterminada propia y los IDs reconocidos (por ISBN o identificador), se reasigna e informa lo demás, y se devuelven títulos acotados de lo que desaparece. Se puede repetir: cada vista previa nueva sustituye a la anterior. |
| `commitRestoreSessionAction({ sessionId, previewId, expectedRevision, idempotencyKey })` | Publica en una transacción (ver abajo). Devuelve `operationId`, resultado, `replayed` y la versión anterior capturada. `REVISION_CONFLICT` y `PREVIEW_EXPIRED` conservan el staging y exigen revisar de nuevo; nunca hay `force`. |
| `listRestoreSessionsAction()` / `discardRestoreSessionAction({ sessionId })` | Restauraciones a medias (hasta 3) para continuar (volviendo a seleccionar los mismos archivos: los trozos recibidos no se repiten) o descartar. Una sesión ajena o inexistente responde siempre `NOT_FOUND`. |

### Publicación atómica medida

`publishRestoreSession` (`lib/import-staging.ts`) hace todo en la transacción final, sin red:

1. `lock_timeout` de **1 s** y bloqueo de colección (`lock_library`).
2. Decisión por clave, caducidad, reglas y revisión (`decideConfirmation` de U-DAT-01).
3. Operación durable.
4. Versión anterior del estado sustituido (U-DAT-02, motivo `import.replace`). Con la cuota llena o una colección de más de 10 000 libros da `LIMIT_EXCEEDED` sin aplicar nada.
5. `DELETE` de libros y estanterías no predeterminadas del dueño.
6. `INSERT … SELECT` de estanterías desde el plan e `INSERT … SELECT` de libros uniendo el plan con `import_session_rows`, comprobando la cantidad insertada.
7. Sesión `committed`.

Cada sentencia lleva `statement_timeout` = mín(**5 s**, presupuesto restante), y el presupuesto total es **15 s** (`BIBLIB_RESTORE_COMMIT_BUDGET_MS`, de 1 000 a 60 000; lo fija F4). Si algo falla o no cabe, se revierte todo: colección, versiones de ficha, revisión, versión anterior, operación y estado de la sesión. El staging queda intacto y la misma clave puede reintentarse; un timeout o un bloqueo ocupado son `PROVIDER_UNAVAILABLE` reintentables. Después de publicar, el staging se libera en otra transacción.

Medición en scratch (`pnpm perf:restore --profile scratch`, 3 repeticiones, Postgres con índices, triggers y RLS como `authenticated`; la publicación se mide en una transacción revertida; [resultados](validacion/2026-10-24/O11/dat-04/medicion-restauracion.json)):

| Libros | Partes · trozos · bytes | Validación | Preparación | Publicación con la colección actual pequeña (p50 / máx.) | Publicación con la colección llena (p50 / máx.) |
| --- | --- | --- | --- | --- | --- |
| 100 | 1 · 1 · 46 KiB | 60 ms | 25 ms | 52 / 57 ms | 57 / 109 ms |
| 1 000 | 1 · 2 · 443 KiB | 174 ms | 49 ms | 124 / 126 ms | 247 / 255 ms |
| 10 000 | 5 · 20 · 4,3 MiB | 1 359 ms | 326 ms | 1 343 / 1 401 ms | 1 977 / 2 081 ms |

Con 10 000 libros y la colección llena, la captura de la versión anterior cuesta unos 360 ms y la sustitución (`DELETE` + `INSERT … SELECT`) unos 1,6 s. La sentencia más larga queda por debajo de 1,7 s: cabe en los 5 s por sentencia y en el presupuesto de 15 s sin cambiar de diseño. **No se justifica un ADR de generaciones o puntero activo.**

### Exportación por partes en el servidor (tarea T1 de U-QA-03)

- Ajustes ya no lee la colección al abrirse: `getLibraryCountsAction` devuelve solo recuentos. Se retiró `getLibraryDataAction`, la lectura completa sin límite.
- `prepareLibraryExportAction` genera en el servidor las partes y el manifiesto (`buildBackupSet`) y devuelve solo el manifiesto y los enlaces.
- Cada parte se descarga de `GET /api/library/export?revision&exportedAt&set&part&sha256`, que la genera de nuevo para esa revisión y fecha. Si la colección cambió o los bytes no coinciden con el hash, responde 409 sin descargar nada. El navegador no materializa ninguna ficha.
- La revisión de una importación pide con `getBookTitlesAction` solo los títulos de las primeras 50 fichas que se eliminarían.

### Despliegue, desactivación y recuperación

1. Desplegar la migración (aditiva, salvo la corrección hacia delante de `saved_book_views_name_check` de 0007) y después la aplicación.
2. La publicación está activa por defecto. `BIBLIB_RESTORE_SESSIONS_PUBLISH=false` la desactiva: deja subir, validar y revisar, pero confirmar responde `CONFLICT` sin tocar la colección.
3. Desactivar el flujo conserva las descargas por partes y los datos actuales. Las sesiones abandonadas caducan a los 7 días y se retiran al abrir otra o con la purga del servidor.
4. Una restauración publicada se deshace desde «Versiones anteriores». El respaldo administrativo restaura el staging tal cual y comprueba sus trozos ([recuperación](recuperacion.md#restauraciones-por-partes-u-dat-04)).

```powershell
pnpm db:plan:local --profile scratch --out dat04.json
pnpm db:migrate:local --plan .biblib/plans/dat04.json --expect-project biblib-scratch --expect-plan <sha256>
pnpm db:status:local --profile scratch       # 326 comprobaciones, sin drift
pnpm test:integration:restore --profile scratch [--reuse-build]
pnpm perf:restore --profile scratch [--scale 100|1000|10000] [--repeat 1-5] [--out <archivo>]
```

### Pruebas

- `pnpm test`: `tests/restore-sets.test.ts` (manifiesto, límites, copia de 2001 libros con hashes de bytes exactos y generación determinista, 111 fichas legacy, v2, presupuesto y errores).
- `pnpm test:db`: `tests/db/restore-sessions.sql` (RLS E/F, hash y tamaño de trozos en Postgres, inmutabilidad, guarda, `restore.commit`, purga y cascadas).
- `pnpm test:scripts`: drift de 0008 (`migrations.test.mjs`), restore administrativo y argumentos (`restore-sessions.test.mjs`).
- `pnpm test:integration:restore --profile scratch|test`: grupo `tests/integration/restore`, también en `test:integration:local`. Con sesiones GoTrue reales, trozos en multipart y el publicador compilado cubre:
  - 2001 libros en dos partes con observadores concurrentes;
  - partes ausentes, duplicadas, corruptas o de otro conjunto, y totales falsos;
  - estanterías vacías, compartidas y contradictorias;
  - error en la última sentencia, `statement_timeout`, presupuesto total y `lock_timeout`;
  - idempotencia de trozos y commit;
  - CAS con otra pestaña;
  - A/B por acciones, SQL y Data API;
  - límites;
  - las 111 fichas legacy;
  - el restore administrativo.

Evidencia: [O11/dat-04](validacion/2026-10-24/O11/dat-04/informe.md).

## Portadas privadas · U-DAT-10 (O11)

Una ficha puede mostrar una **copia privada** de su portada en lugar de la URL externa: una imagen propia subida por la persona o, cuando la política del proveedor lo permita, una copia de la portada del catálogo. La imagen se valida, se convierte a WebP sin metadatos, se guarda en el bucket privado `biblib-covers` y se sirve solo a su dueño desde el propio origen (`/api/covers/<asset>`). Las URL originales se conservan en la ficha: son las que se editan y exportan, y vuelven a mostrarse si se quita la copia.

### Modelo y migración (`0009_cover_assets`)

- `biblib.cover_assets`: `user_id`, `id`, `storage_key` (`<dueño>/<asset>/<intento>.webp`), `sha256`, `mime`, `width`, `height`, `bytes`, `state` (`quarantine` → `ready`; `restored` tras un restore administrativo), `source_kind` (`upload` o `provider`), `source_ref` (clave validada, nunca una URL), `rights_policy_version`, `attribution`, `expires_at` (caducidad de la cuarentena o de la licencia), `version`, `created_at`. RLS de lectura propia; ninguna escritura directa de `authenticated`.
- `books.cover_asset_id` con FK `(user_id, cover_asset_id)` y la guarda `BA001` (solo un asset propio `ready` con licencia vigente). **U-DAT-06** la trasladará a la edición o el ejemplar; las versiones anteriores ya guardan `cover_asset_id` en su contenido.
- Funciones `biblib.cover_asset_*` (dueño de `auth.uid()`, `search_path` fijo): reservar, solicitar, autorizar un intento, registrar (solo con el objeto ya presente en Storage y del tamaño declarado), descartar y revalidar. Las de purga y la de restore solo las ejecuta el servidor.
- Bucket privado `biblib-covers` (5 MiB, solo `image/webp`) y políticas `biblib_covers_*` de `storage.objects`, instaladas por `biblib.cover_storage_install()`:
  - leer y firmar, solo el dueño;
  - subir, solo el intento autorizado de un asset en cuarentena vigente, con la cuenta activa y, si lo adquiere un trabajo, con su lease vigente y el mismo número de fencing;
  - retirar, nunca el objeto registrado de un asset utilizable;
  - nada para `anon` ni actualizaciones.
- `library_jobs` admite `kind = 'cover_asset'` y la fase `asset`. `library_job_claim` no reclama adquisiciones para el ejecutor sin sesión.
- La migración no toca `supabase/migrations` ni el bucket fixture `biblib-test-assets`.

```powershell
pnpm db:plan:local --profile scratch --out dat10.json
pnpm db:migrate:local --plan .biblib/plans/dat10.json --expect-project biblib-scratch --expect-plan <sha256>
pnpm db:status:local --profile scratch       # 377 comprobaciones (incluye bucket y políticas de Storage), sin drift
```

### Acciones (`app/actions/book-cover-assets.ts`, todas `ActionResult`)

| Acción | Qué hace |
| --- | --- |
| `getBookCoverAssetsAction(bookId)` | Estado de la portada privada, cuota usada y si se puede subir o copiar (lo decide el servidor). |
| `beginOwnCoverUploadAction(FormData{entityId, mime, bytes, file})` | Valida el archivo, lo reencodifica y lo guarda en cuarentena → `ready`. No cambia la portada visible. La misma imagen del mismo dueño se reutiliza. |
| `attachCoverAssetAction({assetId, entityId, expectedVersion})` / `detachCoverAssetAction` | Adjunta o quita la copia con la versión de la ficha (`CONFLICT` si cambió). |
| `requestProviderCoverAssetAction({entityId, expectedVersion, providerCoverKey, idempotencyKey})` | Comprueba los derechos vigentes **antes** de crear nada o de cualquier red, crea el trabajo y lo ejecuta en la misma petición. Al terminar adjunta solo si la ficha conserva la versión. |
| `getCoverAssetJobAction` / `cancelCoverAssetJobAction` | Continúa un paso pendiente con la sesión del dueño o lo cancela; cancelar impide registrar o adjuntar un resultado tardío. |

Errores: `ASSET_REJECTED` (422, con motivo: tipo, firma, marcado, políglota, píxeles, tamaño, destino o derechos), `LIMIT_EXCEEDED` (5 subidas en cuarentena, 500 imágenes o 200 MiB por cuenta), `PROVIDER_UNAVAILABLE`, `CONFLICT` y `UNAUTHORIZED` con la cuenta bloqueada.

### Red, archivo y presupuesto

- **Sin proxy de URL.** La única entrada es una clave de proveedor (`open-library:id:123`); el servidor la convierte en `https://<host fijo>/b/<tipo>/<valor>-L.jpg`. Hosts fijos: solo Open Library; BNE no publica imágenes y Google no autoriza copiarlas.
- **Política de red** (`lib/assets/fetch-policy.ts`):
  - resuelve una vez y exige que todas las direcciones sean públicas (loopback, privadas, CGNAT, link-local y metadatos cloud, IPv4 mapeada o compatible, NAT64, 6to4, ULA, multicast y documentación bloqueadas);
  - fija la IP para la conexión (sin DNS rebinding) y valida el certificado con el nombre del host;
  - sin redirecciones, solo puerto 443, 5 MiB contados en streaming (un `Content-Length` grande corta antes; uno pequeño no se cree) y 8 s en total.
- **Modo `fixture`:** cero red; la adquisición usa una imagen ficticia determinista por clave.
- **Archivo** (`lib/assets/image-validation.ts`): firma JPEG, PNG o WebP antes de decodificar nada; rechazo de SVG, HTML y XML en cualquier parte del archivo, de datos tras el final de la imagen (políglotas) y de animaciones; dimensiones y 10 megapíxeles por cabecera; decodificación real con `sharp` (`limitInputPixels`, `failOn: "error"`); reencodificación a WebP (máximo 1200×1800, calidad 82) sin EXIF, XMP ni ICC. Un tipo declarado distinto de la firma es `MIME_MISMATCH`.
- **Presupuesto medido** ([medición](validacion/2026-10-24/O11/dat-10/medicion-decodificacion.json), sharp 0.35.5 y libvips 8.18.7, 5 repeticiones): portada 600×900 JPEG, 69 ms; PNG 1600×2400, 273 ms; JPEG de 10 MP, 178 ms; WebP de 10 MP, 310 ms. El plazo de decodificación es de 5 s y el de la acción, 15 s.
- **`next/image`** sigue con `images.unoptimized: true`: las portadas privadas ya llegan reencodificadas y el optimizador no podría pedir la ruta autenticada sin cookies. `sharp` está compilado (`allowBuilds`), así que activar la optimización es solo cambiar `next.config.mjs` si algún día se quiere.

### Activar la copia de portadas de un proveedor

Hoy **ninguna** política publicada concede `rehostCover` (`lib/bibliographic-catalog/rights.ts`, U-BIB-04): Open Library declara que las imágenes conservan los derechos de sus titulares, BNE no aporta imágenes y Google solo permite una vista previa temporal. Por eso la interfaz solo ofrece «Subir portada propia» y oculta «Guardar copia privada». Decisión del coordinador del 24-10-2026. Para activarla con un proveedor:

1. Revisar y documentar su licencia de imágenes.
2. Cambiar en `rights.ts` `rehostCover` (y, si procede, `backupAsset`, `offlineUse` y `coverTtlSeconds`) **con una versión nueva** de la política. Los assets guardan `rights_policy_version`.
3. Si permite respaldarlas, añadirlo a `BACKUP_ASSET_PROVIDERS` en `scripts/lib/backup-db.mjs`. `tests/cover-assets.test.ts` exige que la lista coincida con `rights.ts`.
4. Repetir `pnpm test:integration:assets`. Las pruebas ya ejercitan la adquisición con una política inyectada solo en pruebas.

Google nunca puede guardarse: lo impide un `CHECK` de 0009 además de su política.

### Despliegue por etapas y desactivación

`BIBLIB_COVER_ASSETS` (servidor):

| Valor | Efecto |
| --- | --- |
| `full` (por defecto) | Subidas y adquisiciones (si la política lo permite). |
| `uploads` | Solo subidas propias y adjuntos. |
| `off` | Detiene subidas y adquisiciones; las portadas privadas existentes se siguen leyendo, y las fichas pueden volver a su URL original. |

Orden de despliegue: migración, después aplicación con `uploads`, y `full` solo tras activar un proveedor. No se descargan de golpe las URL existentes.

### Vida útil y purga

- Una subida que no termina queda en cuarentena 15 minutos y una adquisición 1 día; después caducan.
- Un asset sin fichas ni versiones anteriores que lo citen se purga tras 24 h de gracia. Una licencia vencida deja de servirse; la purga devuelve la ficha a su URL original y retira el objeto. Un objeto subido sin registrar (caída entre subir y registrar) es huérfano y también se purga: nunca queda un enlace roto confirmado.
- Las acciones de adjuntar y quitar purgan lo del propio dueño con su sesión. La purga global la hace un script **fuera del proceso Next**, porque la app no tiene la credencial administrativa:

```powershell
pnpm assets:purge:local --profile scratch [--limit 1-1000] [--grace-seconds 0-2592000] [--json]
```

Solo imprime cantidades. El scheduler de F4 lo sustituirá. El borrado de cuenta (U-OPS-03) deberá retirar filas y objetos: `account_set_state(…, 'blocked')` ya impide subir, registrar o reclamar, y caduca los trabajos.

### Respaldo y restore administrativos

- `db:backup:local` copia los objetos de `biblib-covers` como el resto de Storage, con sha256, y añade `assets` al manifiesto: asset, dueño, clave, sha256, tamaño y estado. Cada objeto copiado se comprueba contra su asset; si no coincide, el respaldo no se guarda. Nunca se respalda una URL firmada.
- Las copias de proveedores sin `backupAsset` se excluyen y quedan declaradas en `exclusions`. Google nunca entra.
- `db:restore:local` hace cuatro cosas:
  - admite el bucket vacío que crea 0009 tras el reset;
  - reinstala las políticas de Storage (`drop schema biblib cascade` las retira);
  - retira los assets excluidos, cuyas fichas vuelven a su URL;
  - deja los demás en `restored` y caduca las cuarentenas.
- La ruta de lectura revalida cada asset restaurado la primera vez que lo abre su dueño: sha256, imagen válida y derechos vigentes. Si lo supera vuelve a `ready`; si no, se descarta.
- `db:restore:verify` compara la tabla por claves y los assets por su manifiesto.

### Pruebas

- `pnpm test`: `tests/cover-assets.test.ts` (claves, derechos, política de red con DNS y transporte simulados, validación de imágenes con sharp y coherencia de `BACKUP_ASSET_PROVIDERS`).
- `pnpm test:db`: `tests/db/cover-assets.sql`, con el sustituto de Storage de `bootstrap.sql`.
- `pnpm test:scripts`: drift de 0009 (`migrations.test.mjs`), respaldo, restore, verify, purga y argumentos (`cover-assets.test.mjs`).
- `pnpm test:integration:assets --profile scratch|test [--reuse-build]`: grupo `tests/integration/assets`, también en `test:integration:local`. Usa Postgres, GoTrue, Storage y la app compilada reales, y la red siempre simulada.

Evidencia: [O11/dat-10](validacion/2026-10-24/O11/dat-10/informe.md).

## Obra, edición y ejemplar con ISBN opcional · U-DAT-06 (O12)

Separa la ficha plana `books` en **obras** (`biblib.works`), **ediciones** (`biblib.editions`) y **ejemplares** (`biblib.copies`), todo privado por cuenta. Especificación: [02 · U-DAT-06](spec-pendientes/02-datos-importacion-y-catalogacion.md#u-dat-06--obra-edición-y-ejemplar-con-isbn-opcional). Evidencia: [O12/dat-06](validacion/2026-10-24/O12/dat-06/informe.md).

### Modelo

| Entidad | Contiene | Claves e índices |
| --- | --- | --- |
| Obra | Título. Solo existe con evidencia explícita (archivo v2 o decisión de la persona); la migración no deduce ninguna. Sin ediciones se retira. | PK, `(user_id, id)` único. |
| Edición | ISBN-13 canónico **opcional** (`isbn13`, null si no hay), título, subtítulo, autoría y editoriales (con su orden), fecha, páginas, idioma, identificadores externos, procedencia (`catalogue`, sin la comprobación física), portada (URL y asset privado) y `search_text` generado. Sin ejemplares se retira. | `(user_id, isbn13)` único donde no es nulo; `(user_id, title, id)`; FK con dueño a obra (`SET NULL (work_id)`) y a portada. |
| Ejemplar | Estado, estantería, comprobación física (`edition_verification`: `isbnVerified`, `checkedAt`, `evidenceRefs`) e identificador legacy (`manual-…` u otro valor que no es ISBN). Conserva el ID de la ficha: `/book/[id]` es el ejemplar. | `(user_id, legacy_identifier)` único; `(user_id, edition_id)`, `(user_id, shelf_id)`, `(user_id, created_at desc, id desc)`; FK con dueño a edición (`RESTRICT`) y a estantería. |

Decisiones:

- **Portada en la edición.** URL y asset privado (U-DAT-10) describen la edición, como el resto de sus datos bibliográficos. Una foto de un ejemplar concreto (estado, dedicatoria) es de F3 y llegará con su contrato; no se añade una columna de portada al ejemplar sin él.
- **Comprobación física en el ejemplar.** `isbnVerified` sigue significando que una persona comprobó el ISBN en *ese* ejemplar: una copia nueva de una edición ya comprobada empieza en `false`. Ni un proveedor ni el checksum lo activan. `Book.catalogue.isbnVerified` del DTO plano se deriva del ejemplar.
- **Toda edición tiene al menos un ejemplar** (restricción diferida `editions_require_copy`); al retirar o mover el último, la poda por sentencia retira la edición y, si queda sin ediciones, la obra.
- **RLS** en las tres tablas con `user_id = (select auth.uid())` (un InitPlan por consulta) y FK que incluyen al dueño: una referencia a datos de otra cuenta falla aunque se conozca el UUID ([seguridad](seguridad.md#roles-y-grants)).
- **Versiones y revisión.** Obras, ediciones y ejemplares tienen su token (`rotate_book_version`) y rotan la revisión de colección (`rotate_library_revision`).

### Vista plana `books` y DTO

`biblib.books` es desde 0011 una **vista** (`security_invoker`) de un ejemplar con su edición y su obra, con las columnas de la tabla anterior más las del modelo. Es el modelo de lectura de la aplicación: lista, filtra, ordena y busca sobre ella; las escrituras van a `copies`, `editions` y `works`.

- `version`: token plano, `md5(copia || edición)`. Cambia con cualquiera de los dos; protege las operaciones de una ficha pero **no autoriza por sí solo** cambiar una edición compartida.
- `isbn`: ISBN-13 de la edición o identificador legacy del ejemplar (compatibilidad); `isbn13` y `legacy_identifier` por separado.
- Sus triggers INSTEAD OF mantienen compatibles los scripts y pruebas SQL que escribían `books` (alta = edición + ejemplar; baja = ejemplar). Cambiar datos bibliográficos de una edición compartida por esta vía se rechaza (`BM003`): lo hace el contrato de edición.
- El DTO `Book` (`lib/types.ts`) es un ejemplar: `isbn` es ISBN-13 o `null`, y lleva `legacyIdentifier`, `copyVersion`, `edition` (`id`, `version`, número de ejemplares en la ficha, obra, idioma, identificadores) y `verification` (fecha y evidencias). La aplicación no selecciona de la vista el recuento de ejemplares (solo la ficha lo pide) ni la procedencia plana (la recompone el mapper).

### Contratos (`app/actions/editions.ts`, todos `ActionResult`)

| Acción | Entrada | Comportamiento |
| --- | --- | --- |
| `createEditionAction` | `{ isbn13: null \| string, …, placement: { shelfId }, idempotencyKey }` | Edición nueva con su primer ejemplar. Con un ISBN-13 que la cuenta ya tiene responde `CONFLICT` («ya existe»): la interfaz ofrece **abrir el ejemplar** o **añadir otro**, nunca lo hace sola. |
| `createCopyAction` | `{ editionId, placement: { shelfId }, status, idempotencyKey }` | Un ejemplar más de una edición propia, sin verificar. Una edición o estantería de otra cuenta responde `NOT_FOUND`. |
| `updateEditionAction` | `{ editionId, expectedVersion, …, confirmCopies, idempotencyKey? }` | Cambia la edición con su versión. Si la comparten varios ejemplares exige `confirmCopies` igual al número vigente; si no, `EDITION_SHARED` (409) con ese número. Devuelve cuántos ejemplares cambiaron. Un ISBN que ya tiene otra edición es un conflicto (se fusionan, no se repite). |
| `mergeEditionsAction` | `{ sourceIds, targetId, expectedVersions, expectedRevision, idempotencyKey }` | Pasa los ejemplares a la edición de destino (con su estado, estantería y comprobación) y retira las vacías; el destino adopta ISBN-13, obra o portada solo si no tenía y no hay dos distintos. Devuelve el mapeo explícito. ISBN u obras distintas se rechazan. |

Todas toman el bloqueo de colección; las idempotentes guardan su resultado en `library_operations` (`copy.create`, `edition.create`, `edition.update`, `edition.merge`): repetir con la misma entrada recupera el resultado, con otra entrada es `IDEMPOTENCY_CONFLICT`. Altas concurrentes del mismo ISBN no duplican (bloqueo + índice único).

En la interfaz: el alta manual usa `createEditionAction`; la ficha muestra los ejemplares de su edición, permite **añadir otro ejemplar**, editar solo la edición (confirmando cuántos ejemplares cambian) y, para un ejemplar en conflicto de la migración, **unirlo** a la edición equivalente con `mergeEditionsAction`. El editor plano (`updateBookAction`) guarda ejemplar y edición con sus versiones y pide la misma confirmación.

### Migraciones `0010` y `0011` (expandir → backfill → comparar → cambiar)

Dos migraciones porque el patrón lo exige: `0010` es compatible con la aplicación anterior y deja un punto de comparación antes de cambiar escritores; `0011` hace el cambio. Se pueden aplicar juntas (el runner las aplica en una transacción) o por separado.

| Paso | `0010_works_editions_copies` | `0011_copies_cutover` |
| --- | --- | --- |
| Esquema | Crea obras, ediciones, ejemplares e informe (`model_migration_report`) con RLS, FK, índices, triggers y `biblib.isbn13_normalize` (mismo cálculo que `normalizeIsbn`). | Congela `books` (bloqueo), la renombra `books_legacy` (sin triggers, políticas, privilegios de cliente ni FK a estanterías/portadas) y crea la vista `books`. Amplía las operaciones idempotentes. |
| Datos | Backfill: cada ficha conserva su ID como ejemplar **y** como edición, sin obra. `manual-…` y valores no ISBN van a `legacy_identifier`; ISBN válido a `isbn13` canónico. Entre fichas equivalentes (ISBN-10/13 del mismo ISBN-13) gana la forma canónica, luego la más antigua; las demás quedan sin ISBN-13 con su texto original y una fila `conflict`. | Agrupa en la edición canónica solo las equivalencias con **todos** los campos bibliográficos idénticos (`grouped` en el informe); el resto sigue en conflicto, para revisarlo o unirlo. Ninguna fila se descarta. |
| Ventana | Sincroniza `books` → modelo mientras la aplicación anterior escriba `books`. | Retira la sincronización. Las funciones que leían o escribían `books` (versiones anteriores, IDs ocupados, revalidación y purga de portadas) pasan a ejemplares y ediciones. Rota las revisiones (las vistas previas antiguas se vuelven a preparar). |
| Comparación | `biblib.model_compare(null)`: ficha a ficha (ID, dueño, identificador o su ISBN-13 equivalente, datos, portadas, estado, estantería, alta, procedencia y comprobación). Una diferencia revierte la migración. | La misma comparación contra `books_legacy`; una diferencia revierte. |

Informe y comparación (solo servidor, sin títulos ni ISBN en los resúmenes):

```sql
select biblib.model_compare(null);                               -- recuentos y hasta 20 IDs distintos
select migration, kind, count(*) from biblib.model_migration_report group by 1, 2;
select details from biblib.model_migration_report where kind = 'summary';   -- por cuenta
```

Cada dueño lee sus filas del informe (RLS): las de `conflict` citan el ejemplar que conservó el ISBN-13 y el texto original.

**`0012_model_account_deletion`.** Pasa la poda de ediciones y obras huérfanas a `SECURITY DEFINER` (search_path fijo, sin `EXECUTE` para clientes). Con 0011, borrar una cuenta desde Auth fallaba: la cascada a `copies` dispara la poda con el rol de Auth, que no tiene `USAGE` en `biblib`. Se encontró al limpiar la cuenta de escala de `perf:local`; `tests/db/model.sql` documenta el fallo con 0011 y `tests/db/model-account-deletion.sql` la cascada completa con 0012. Se aplica con 0010/0011 o después, y no cambia datos.

**Despliegue.** Respaldo ensayado (`db:backup:local` → `db:restore:verify`) → plan/migrate de `0010` con la aplicación anterior → `model_compare` y revisión del informe → aplicación nueva + `0011` y `0012`. Antes de `0011`, volver atrás es no seguir: la aplicación anterior funciona sobre `0010`. **Después de admitir varias copias o libros sin ISBN no se promete volver al escritor antiguo**: si algo falla, detener escrituras y corregir hacia delante o restaurar el respaldo ensayado (el de `0009` se restaura con su head y se repite la migración; ver [recuperación](recuperacion.md#obra-edición-y-ejemplar-u-dat-06)).

**Retirada de `books_legacy` (F4).** Se conserva sin uso durante la ventana de verificación de F4: hasta que producción haya pasado al menos un ciclo de respaldo → restauración → verificación con el modelo nuevo y 30 días sin incidencias. Su retirada es una migración de F4 que, tras comprobar `model_compare` y archivar el informe, ejecuta `DROP TABLE biblib.books_legacy` y sustituye `model_compare` por una versión sin ella (o la retira). Mientras exista, se respalda y se borra en cascada con la cuenta (FK a `auth.users`). U-OPS-03 debe incluir `works`, `editions`, `copies`, `model_migration_report` y `books_legacy` en su inventario (todas cuelgan de `auth.users` con `ON DELETE CASCADE`).

### Formatos, versiones anteriores y restauración

- **v2** con capacidad completa (varias copias por edición, obras, evidencias, identificadores e idioma) y `requiredCapabilities`; **v1** solo sin pérdida; el lector v1/legacy crea un ejemplar por fila ([formatos](formatos.md#payload-portable-formatversion-2)). Reglas de importación versión 2: las vistas previas anteriores caducan (`PREVIEW_EXPIRED`).
- **Versiones anteriores** `schema_version: 2` (un ejemplar con su edición por entrada); las de versión 1 se restauran como el backfill.
- **Vista previa de importación**: guarda el payload v2 cuando la forma legacy perdería algo (al confirmar se vuelve a leer).
- **Restauración por partes**: una edición con copias en varias partes debe traer los mismos datos en todas; la publicación crea obras, ediciones y ejemplares por conjuntos.
- **Respaldo administrativo**: rota los tokens de ejemplares, ediciones y obras; la muestra excluye los tokens de la vista.

### Rendimiento: tareas T5 y T7

Medido con `perf:local --profile scratch --scale 10000` (10 000 fichas, 41 estanterías, sesiones reales) antes (head 0009) y después (head 0011, mismo dataset migrado). Resultados completos en la [evidencia](validacion/2026-10-24/O12/dat-06/informe.md#rendimiento); 0 medidas fuera de presupuesto en ambas.

| Acción (c=1) | Antes p95 acción / SQL | Después p95 acción / SQL |
| --- | --- | --- |
| Búsqueda local por texto | 172.9 / 103.7 ms | 105.3 / 30.4 ms |
| Búsqueda local por ISBN parcial | 210.0 / 141.6 ms | 97.0 / 29.4 ms |
| Consulta por ISBN exacto (alta, `consulta-isbn-alta`) | 85.9 / 8.36 ms | 66.7 / 0.13 ms |
| Ordenar por autor / fecha | 119.7 / 17.5 · 111.4 / 31.1 ms | 119.8 / 16.3 · 96.3 / 25.5 ms |
| Última página | 119.0 / 46.5 ms | 97.3 / 25.5 ms |
| Listado de 100 filas | 79.7 / 2.2 ms | 93.3 / 13.8 ms |
| Exportación en el servidor | 492.9 / 101.8 ms | 737.2 / 156.1 ms |
| Vista previa de importación (conservar / nuevos / reemplazo) | 242.9 · 297.4 · 307.1 ms | 299.7 · 410.5 · 367.5 ms |

- **T7 (igualdad de ISBN indexada).** `findBookByIsbn` y `getBookByIsbnAction` comparan `isbn13 = $1` con el índice parcial `(user_id, isbn13)`, en vez de normalizar `books.isbn` fila a fila: SQL p95 8.36 → 0.13 ms.
- **T5 (texto de búsqueda).** Adoptada la columna generada `editions.search_text` (título, subtítulo, autoría, editoriales e ISBN sin acentos ni mayúsculas), calculada al escribir: la búsqueda por texto pasa de 103.7 a 30.4 ms de SQL. **Trigramas evaluados y no adoptados**: un GIN `gin_trgm_ops` sobre `search_text` (1.8 MiB con 10 000 ediciones) no mejora la búsqueda (recuento p95 14.5 → 12.5 ms, ISBN exacto 14.6 → 17.6 ms; el planificador lo usa pero la colección por cuenta es pequeña) y encarece la escritura masiva un 22 % (282 → 343 ms). Se revisará si una cuenta supera el límite de escala.
- **Coste del modelo.** La vista une ejemplar, edición, estantería y obra: los recuentos y páginas cortas cuestan unos milisegundos más de SQL, y las lecturas completas (exportación, vista previa) entre un 20 y un 50 % más con una petición, y la exportación con 5 simultáneas, más del doble (p95 1.9 → 4.7 s); todo dentro de presupuesto. Es el primer candidato si F4 necesita bajar la exportación (leer las tablas sin la vista). Dos decisiones lo contienen: la RLS evalúa `auth.uid()` una vez por consulta (InitPlan) y el listado ordena y pagina solo IDs antes de leer las filas de la página. En la exportación ese segundo paso no ahorraba nada (lee todas las filas) y se descartó.

### Pruebas

- `pnpm test`: formatos v2 completos, reglas de importación 2, versiones anteriores v1/v2 y validación sin ISBN inventado.
- `pnpm test:db`: `tests/db/model-legacy.sql` (estado de 0009 con 111 fichas sintéticas y equivalencias), `model-expand.sql` (backfill, informe, comparación, sincronización, RLS, FK, unicidad, poda) y `model.sql` (vista, agrupación, `books_legacy`, edición compartida, versiones anteriores, portadas).
- `pnpm test:scripts`: metadatos reales de 0010 y 0011 y drift del modelo (`migrations.test.mjs`).
- `pnpm test:integration:model --profile scratch|test [--reuse-build]`: grupo `tests/integration/model`, también en `test:integration:local`.
- Ensayo de migración con datos: `docs/validacion/2026-10-24/O12/dat-06/ensayo-modelo.mjs cargar|comprobar|retirar`.

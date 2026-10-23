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

La consulta de portadas durante una importación tiene un presupuesto total de 20 segundos y no es una cola persistente. Si cierras la página durante una importación, consulta la colección antes de repetir; fusionar omite identificadores ya presentes, pero no deshace un reemplazo anterior.

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

## Adaptadores bibliográficos Open Library y BNE · U-BIB-02

En modo `live`, Open Library admite ISBN, título/autor y resolución limitada de ediciones. `OPEN_LIBRARY_CONTACT` añade la identificación `BibLib (<contacto>)`; sin contacto sigue `BibLib/1.0`. Todas las operaciones del adaptador comparten el límite conservador de una petición por segundo y respetan `Retry-After` sin reintentos automáticos. La fachada legacy `lib/open-library.ts` delega en este adaptador.

BNE permanece apagada por defecto: `BIBLIB_BNE_ENABLED=true` habilita SRU 1.2 en `https://catalogo.bne.es/view/sru/34BNE_INST` y solo en modo `live`. Consulta ISBN y título/autor, con máximo diez registros, 524288 bytes XML y 3,5 segundos por petición, además del deadline del orquestador. No se configura un endpoint alternativo en producción. Un fallo de BNE permite seguir con OL; para desactivarla basta devolver la bandera a `false`.

Los metadatos BNE tienen política CC0 con procedencia (URL de ficha y hora de recuperación); sus portadas permanecen deshabilitadas. Las cachés locales de ambos adaptadores son acotadas y conservan solo metadatos validados, nunca XML crudo ni imágenes. Hasta integrar U-DAT-05 esta limitación/caché es por instancia; no acredita una cuota global. `fixture` continúa sin llamadas externas. El mapeo MARC, fixtures, consultas públicas y validación están en [el informe O08](validacion/2026-10-23/O08/bib-02.md).

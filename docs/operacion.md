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

Drizzle usa `SUPABASE_DB_URL` también para migrar. `drizzle.config.ts` carga `.env.local` y después `.env`, cuando existen, mediante la API de entorno de Node 24. Los valores ya presentes en el entorno tienen prioridad. Comprueba el destino antes de ejecutar `pnpm db:migrate`; cargar la variable no demuestra que apunte a la base adecuada. No imprimas la URL completa en consola ni en una incidencia.

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

`pnpm db:generate` genera una propuesta SQL a partir del esquema. Revísala junto con el historial de Drizzle. `pnpm db:migrate` modifica la base indicada por `SUPABASE_DB_URL`; no debe ejecutarse automáticamente desde una instalación, build o script de pruebas.

Antes de aplicar `0001_library_integrity.sql` y `0002_book_versions.sql`:

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

BibLib tiene su propia configuración de Supabase local (U-INF-01), separada de cualquier otro proyecto de la máquina. Esta sección describe lo que existe hoy: configuración, perfiles y cómo se ensayó. Los comandos `pnpm db:local:*` todavía **no existen**; llegan con U-INF-02/U-INF-03 (olas O02/O03).

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

### Qué no hace todavía

- No hay `pnpm db:local:doctor|status|up|down|bootstrap` (U-INF-03): la red, el workdir y el arranque se preparan a mano como arriba. No se comprueban automáticamente puertos ocupados ni bindings.
- No hay selección de objetivo `BIBLIB_TARGET` ni `.env.local` generado para el stack (U-INF-02). La aplicación no se conecta todavía a este stack.
- No se aplican migraciones Drizzle (U-INF-04) ni seed/fixtures de GoTrue y Storage (U-INF-05). `db:migrate` y `drizzle.config.ts` no cambian.
- No hay reset (U-INF-06). Para descartar los datos de `scratch` hará falta ese flujo; no borres volúmenes a mano por patrón.

## Observabilidad sin datos privados · U-OPS-01 (F0)

El servidor emite JSON por stdout/stderr para fallos de sesión, validación/commit/conflicto de importación, peticiones reales de Open Library y recuperación de portadas. [Alertas y contrato de privacidad](alertas.md) detalla eventos, lista blanca, límites, métricas propuestas y pruebas. La validación del archivo en el servidor produce `import.preview`; la revisión visual actual sigue siendo local al navegador y no genera una petición nueva.

`x-correlation-id` se valida (8–64 caracteres, formato acotado) y se mantiene con `AsyncLocalStorage`. La búsqueda `/api/books/search` devuelve esa cabecera también en errores, para localizar los eventos del servidor sin copiar consultas, ISBN ni títulos. Los logs no son un respaldo ni el estado de una operación.

Para apagar la emisión, establece `BIBLIB_TELEMETRY=off` en el proceso de servidor; el catálogo conserva sus resultados. `createLogger({ enabled: false })` permite desactivar un adaptador concreto. El saneado descarta campos privados y valores inválidos, y expone únicamente un contador local de descartes. Los fallos del sink no deben interrumpir la operación. `BIBLIB_TELEMETRY_SALT` es una sal secreta exclusiva de servidor para la primitiva HMAC `accountRef`; sin ella se omite el campo, nunca se sustituye por el ID original. Los puntos instrumentados en F0 no necesitan registrar cuentas.

No hay exportador, panel remoto ni alertas automáticas en F0. Se proponen 14 días de logs restringidos y 90 días de agregados sin cuentas/correlaciones; el alojamiento deberá configurar y verificar esa retención. Jobs, nuevos proveedores y fuentes métricas de DB/Storage se integrarán en las unidades siguientes. `pnpm test` ejecuta las pruebas de observabilidad con fallos simulados y sin red/base; también se comprueba el catálogo existente con `BIBLIB_TELEMETRY=off`.

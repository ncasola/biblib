# Recuperación de BibLib · U-OPS-02

**Estado:** entrega mínima local (ola O07, 23-10-2026). Respaldo administrativo, restauración y verificación ensayados en el perfil `scratch` ([evidencia](validacion/2026-10-23/O07/ops-02/informe.md)). El procedimiento remoto está **pendiente** de U-INF-07 y de conocer el plan del proveedor.

**Responsable de recuperar el servicio:** Néstor. Decide cuándo restaurar, qué escrituras posteriores al respaldo se dan por perdidas y cuándo se abre el tráfico.

## Tres productos distintos

| Producto | Qué contiene | Qué no contiene | Uso |
| --- | --- | --- | --- |
| **JSON de cuenta** (`/settings`, exportar) | Catálogo y estanterías de la cuenta que lo descarga. | Auth, otras cuentas, historial de migraciones, bytes de imágenes, RLS ni grants. | Portabilidad y copia personal. **No sirve como respaldo administrativo.** |
| **Respaldo administrativo** (`db:backup:local`, carpeta `db/`) | Esquema y datos de `biblib` (tablas, RLS, políticas, grants, FK, índices, función y trigger de versión), historial `drizzle.__drizzle_migrations` y datos de identidad de Auth. | Bytes de Storage, sesiones/tokens, configuración de Auth/OAuth/SMTP/JWT, Mailpit, secretos. | Recuperar el servicio completo en un stack aislado compatible. |
| **Copia de objetos Storage** (`db:backup:local`, carpeta `storage/`) | Bytes de cada objeto, con inventario de bucket, nombre, tamaño, tipo y sha256, y la configuración de cada bucket. | Políticas internas del esquema `storage` (las crea la plataforma). | Recuperar portadas y archivos. Un dump de base **no** incluye estos bytes ([Supabase](https://supabase.com/docs/guides/platform/backups)). |

`db:backup:local` produce los productos 2 y 3 en la misma carpeta, con inventarios separados y una marca de consistencia común: así no se combinan una base y unos objetos de momentos incompatibles. Pueden conservarse o rotarse por separado, pero solo restauran juntos.

## Objetivos y conservación (propuestos)

- **RPO 24 h** y **RTO 4 h** para la colección, sujetos al plan del proveedor y al ensayo. El ensayo local midió 15 s de recuperación (restore + verify) para una colección de prueba; no es representativo de producción.
- **Retención:** 7 copias diarias y 4 semanales como punto de partida. La retención definitiva y la capacidad se registran antes de activar automatización (P2).
- Un respaldo previo a una migración se conserva hasta aceptar esa versión **y** su recuperación.
- Solo una restauración terminada y verificada valida una copia: el recibo enlaza su último ensayo superado.

## Procedimiento local

```powershell
pnpm db:local:up --profile scratch
pnpm db:backup:local --profile scratch [--out <carpeta fuera de Git>] [--encrypt-key-file <clave externa>] [--json]
# Destino aislado: vacío o recién reseteado (aquí, el propio scratch).
pnpm db:reset:local --dry-run --profile scratch --out reset-scratch.json
pnpm db:reset:local --apply --plan .biblib/plans/reset-scratch.json --expect-project biblib-scratch --expect-plan <sha256> --discard-local-data
pnpm db:restore:local --backup .biblib/backups/<backupId> --profile scratch --expect-project biblib-scratch [--key-file <clave externa>]
pnpm db:restore:verify --backup .biblib/backups/<backupId> --profile scratch
pnpm db:local:down --profile scratch
```

`pnpm db:backup:prod` es solo un contrato: sale con **2** («pendiente de U-INF-07 y de un destino autorizado») sin conectar con nada.

### Respaldo (`db:backup:local`)

1. Revalida el objetivo local como el seed: `loadTarget`, registro del checkout, contenedores propios en marcha (DB, Auth, Kong, Storage) y la misma guarda de identidad que `db:reset:local` (rechaza 5432, HolaERP, raíz o red ajenas, bindings fuera del perfil, túneles). Un `BIBLIB_TARGET` distinto de `local` sale con **3**.
2. Toma el bloqueo del perfil y el bloqueo consultivo de migraciones. Exige ledger y manifest al día (**5** ante divergencia o drift; **6** sin esquema migrado).
3. En una transacción `repeatable read read only`: lee hechos de catálogo, cantidades y hashes por tabla, huellas de tokens, muestra de fichas, cuentas A/B del censo e inventario Storage; exporta el snapshot y ejecuta `pg_dump --schema biblib --schema drizzle --snapshot` con `docker exec` sobre el **ID registrado** del contenedor Postgres. La conexión es por loopback dentro del contenedor: no hay contraseñas en argv, entorno ni registros.
4. Auth: `supabase db dump --local --data-only --schema auth` del CLI fijado (2.117.0) y del workdir del perfil, excluyendo todo salvo `users`, `identities`, `mfa_factors` y `webauthn_credentials`. Es el procedimiento soportado por el proveedor; no se recrean tablas de la plataforma. El CLI ejecuta su `pg_dump` en un contenedor transitorio con la red del host (sin `--network-id`), que no se conecta a la red del perfil.
5. Storage: descarga cada objeto por la API del perfil con la clave local `service_role`, que solo vive en memoria.
6. Repite la marca de estado (hash de todas las tablas del alcance). Si cambió, sale con **7** sin guardar nada: detén la aplicación y repite.
7. Escribe `db/`, `storage/` y `backup.json` en `.biblib/backups/<backupId>/` (o en `--out`, que debe estar bajo `.biblib/` o fuera del repositorio). Si algo falla, borra solo la carpeta que creó.

### Recibo (`backup.json`)

Contiene `backupId`, fecha de inicio y fin, huella del objetivo (perfil, proyecto, `fingerprint`, raíz), commit, versiones del CLI/pg_dump/Drizzle, head y migraciones aplicadas con sus hashes, hash del journal y del ledger, alcance (`schema`, `data`, `history`, `auth`, `storage`) y exclusiones con su motivo, método de consistencia y marca, cantidades y hashes por tabla, hechos de catálogo, huellas `sha256(id:token)` de los tokens de concurrencia, una muestra de fichas por hash, las cuentas A/B del censo con sus cantidades, el inventario Storage y el inventario de archivos con `sha256` (en disco y en claro). `contentHash` sella todo lo anterior; un cambio se rechaza con **11**. `restoreVerification` referencia el último ensayo superado (informe, sha256, destino y duración); `lastRehearsal`, el último intento.

No contiene contraseñas, claves, JWT, URLs con credenciales ni filas completas.

### Cifrado

`--encrypt-key-file` cifra cada archivo con AES-256-GCM autenticado (cabecera `BIBLIBENC1`, IV aleatorio, tag). La clave son 32 bytes (binario, hex o base64) en un archivo **fuera** de la carpeta de respaldos y fuera de las rutas versionables (dentro del repositorio solo se admite bajo `.biblib/`). El recibo guarda solo la huella de la clave. Custodia propuesta: Néstor la conserva en un gestor de secretos separado del almacenamiento de las copias. Sin la clave no hay restauración: `db:restore:local` sale con **6** antes de tocar el destino. Esta entrega cifra en memoria: adecuada para colecciones locales, no para volúmenes grandes.

### Restauración (`db:restore:local`)

1. Antes de mirar el destino: valida el recibo y **todos** los archivos con su sha256 (**11** si falta un objeto o uno cambió), la clave (**6** si falta o no corresponde) y que el historial respaldado sea un prefijo exacto del journal de este checkout (**5**).
2. Solo un stack local propio y acreditado: `--profile` y `--expect-project` exactos (**3** si no coinciden), la misma guarda de identidad que reset y, desde un worktree, solo `scratch`. No admite URLs, `--linked`, `--db-url` ni flags reenviados (**2**).
3. Destino vacío o recién reseteado: solo puede contener las cuentas, fichas y el objeto del censo que recrea `db:reset:local`. Cualquier otro dato sale con **6**.
4. Fases registradas en `.biblib/state/<perfil>-restore.json`: `clear` (retira `biblib`/`drizzle` y elimina las cuentas fixture por la API admin de GoTrue), `auth` y `domain` (cada volcado por stdin a `psql --single-transaction` dentro del contenedor registrado), `storage` (buckets y objetos por API; retira el fixture ajeno al respaldo), `rotate` y `fixtures`.
5. **Rotación antes de abrir tráfico:** `books.version` se regenera para todas las fichas; si existe, `library_state.revision` también. Se eliminan previews (`*_preview(s)`), se vencen leases (`lease_until`, `lease_token`, `fencing_number`) y las tablas de idempotencia se señalan para revisión manual. Se comprueba que una escritura condicional con una versión del respaldo (una pestaña anterior) afecta 0 filas.
6. **Credenciales de fixtures:** las contraseñas no viajan en el respaldo. Tras restaurar Auth se reasignan, por la API admin de GoTrue, las del registro privado del destino (o nuevas aleatorias) a las cuentas del censo, conservando sus IDs restaurados. Las cuentas que no son del censo conservan sus credenciales restauradas; sus sesiones no se restauran.
7. No envía correo ni llama a proveedores externos. Un fallo a mitad deja el destino incompleto: reconstrúyelo con `db:reset:local` y repite. **Nunca limpies el origen** para resolver un restore fallido.

#### Versiones anteriores (U-DAT-02)

`biblib.library_snapshots` y `biblib.library_snapshot_chunks` son **datos de la cuenta**: el historial con el que cada persona puede deshacer un reemplazo. Se tratan así, de forma explícita (`SNAPSHOT_TABLES` en `scripts/db/restore-local.mjs`):

- **Se respaldan y se restauran tal cual** con el volcado de dominio. No son tablas derivadas, así que un destino que ya tenga versiones no está vacío y el restore sale con **6**.
- **No se rotan**: su `version` solo autoriza borrar esa misma versión y nunca escribir datos de la colección. Restaurar una versión exige una vista previa nueva contra la revisión de colección, que sí se rota. Su caducidad (`expires_at`) sigue corriendo desde la captura original. Las vistas previas de restauración caen con las demás previews.
- **Se comprueba su integridad** en la fase `rotate`: el sha256 de cada trozo y el hash final de cada versión, en Postgres. Si alguno no cuadra, el respaldo está dañado o alterado y el restore sale con **11**. Las versiones vencidas o sin completar se informan en `review` (sin IDs) para decidir; ninguna de las dos se lista ni se restaura.
- `db:restore:verify` las compara por cantidad, claves y contenido como el resto del dominio.

Ensayo con una versión real (backup → reset → restore → verify): [O10/dat-02](validacion/2026-10-23/O10/dat-02/informe.md).

#### Vistas guardadas (U-EXP-02)

`biblib.saved_book_views` contiene preferencias privadas de la cuenta y es dato restaurable
(`SAVED_VIEW_TABLES` en `scripts/db/restore-local.mjs`), nunca caché derivada. El volcado de dominio
incluye nombres, filtros, fechas y versiones; `db:restore:verify` compara sus claves y contenido.
Un destino con vistas existentes no está vacío: el restore lo rechaza con **6** antes de escribir.
Su versión controla solo el cambio de la vista y se conserva al restaurar; no autoriza escrituras
de colección. Tras una recuperación, recargar la lista antes de editar vistas desde una pestaña
que ya estuviera abierta. El JSON portable actual de Ajustes sigue conteniendo solo libros y
estanterías; para conservar vistas hay que usar el respaldo administrativo.

Desactivar el panel de vistas conserva tanto sus filas como la navegación por parámetros URL.
La migración `0007_saved_views` es aditiva; la recuperación no elimina la tabla ni sus datos.

#### Restauraciones por partes (U-DAT-04)

`biblib.import_sessions`, `import_session_parts`, `import_session_chunks` e `import_session_rows` son el staging privado de las restauraciones por partes (`RESTORE_SESSION_TABLES` en `scripts/db/restore-local.mjs`). Contienen los bytes de copias subidas por la persona, así que son **datos de la cuenta**, no caché:

- **Se respaldan y se restauran tal cual** con el volcado de dominio. Un destino con sesiones no está vacío y el restore sale con **6**.
- **Se comprueba cada trozo** en la fase `rotate`: tamaño y sha256 de sus bytes, en Postgres. Un trozo que no cuadra indica un respaldo dañado o alterado y el restore sale con **11**. Las restricciones de 0008 ya lo exigen al cargar el volcado.
- **Una sesión sin publicar no se aplica sola.** Su vista previa cita una revisión de colección, y la rotación del restore la invalida: confirmarla da `REVISION_CONFLICT` y hay que revisar de nuevo. El restore informa de cuántas hay en `review`, sin IDs. Caducan a los 7 días (`import_session_purge_expired` desde el servidor) o se descartan desde Ajustes.
- Una restauración publicada ya está en la colección y en «Versiones anteriores» (U-DAT-02); su sesión solo guarda el resumen, sin staging.

Desactivar la publicación (`BIBLIB_RESTORE_SESSIONS_PUBLISH=false`) deja validar y revisar, conserva las descargas por partes y no toca la colección. Una restauración ya publicada se deshace desde «Versiones anteriores» o con el respaldo administrativo, nunca con SQL inverso.

#### Portadas privadas (U-DAT-10)

`biblib.cover_assets` y los objetos del bucket privado `biblib-covers` son **datos de la cuenta**:

- **Respaldo.** Los objetos se copian con su sha256, y el manifiesto `assets` (asset, dueño, clave, hash, tamaño) se comprueba contra ellos. Si no coinciden, el respaldo no se guarda. Las copias de proveedores sin `backupAsset` se excluyen y quedan declaradas (Google nunca entra).
- **Destino.** Tras el reset, 0009 crea el bucket vacío: no cuenta como dato ajeno. Un objeto en él sí.
- **Fase `rotate`.** Hace tres cosas:
  - reinstala las políticas `biblib_covers_*` de `storage.objects` con `biblib.cover_storage_install()`, porque `drop schema biblib cascade` las retira;
  - retira los assets excluidos, cuyas fichas vuelven a su URL original;
  - pasa los demás a `restored` y caduca las subidas a medias.

  El restore informa en `review` de cuántas portadas quedan en revisión.
- **Revalidación con el dueño.** Una portada restaurada no se sirve hasta que su dueño la abre. Entonces el servidor comprueba sha256, imagen válida y derechos vigentes: si los supera vuelve a `ready`; si no, se descarta y la ficha recupera su URL.
- **`db:restore:verify`** compara `cover_assets` por claves y las portadas por el manifiesto (clave, hash, tamaño, dueño, en revisión), además de los objetos de Storage con su sha256.

En una restauración remota (U-INF-07), tras cargar el volcado de dominio, hay que ejecutar `select biblib.cover_storage_install()` antes de abrir tráfico, como hace el ensayo de promoción.

#### Obra, edición y ejemplar (U-DAT-06)

Desde 0011 la colección vive en `biblib.works`, `biblib.editions` y `biblib.copies`; `biblib.books` es la vista plana y `biblib.books_legacy` la copia congelada anterior al cambio (se respalda y restaura como cualquier tabla mientras dure su ventana).

- **Destino.** Tras un reset, el censo de fixtures vive en ediciones y ejemplares; se clasifica por la vista plana como libros de fixture. Una obra en el destino es un dato ajeno.
- **Fase `rotate`.** Rota los tokens de ejemplares, ediciones y obras (la vista deriva de ellos su token plano) y comprueba que una escritura con el token anterior ya no aplica. `books_legacy` no se rota: nadie la escribe.
- **Comparación.** `db:restore:verify` compara las tablas por contenido sin esos tokens. La muestra de fichas lee la vista sin sus tres tokens.
- **Vistas previas y trabajos.** Restore borra las vistas previas y caduca los leases a propósito (fase `rotate`), pero `db:restore:verify` aún los compara por contenido: un respaldo con vistas previas o trabajos en curso da `table.biblib.import_previews`/`library_jobs` distintos. Es anterior a U-DAT-06 (lo vio el primer ciclo de 0012 con restos de pruebas); ensayar con esas tablas vacías hasta que verify descuente `invalidated` del recibo.
- **Respaldo de 0009 sobre la versión nueva.** Se restaura con su head (0009) y después se aplican 0010 y 0011 con `db:plan:local`/`db:migrate:local`: es el ensayo de [O12/dat-06](validacion/2026-10-24/O12/dat-06/informe.md).

**Recuperación del cambio de modelo.** Hasta aplicar 0011 la aplicación anterior sigue funcionando sobre 0010 (la sincronización mantiene el modelo al día) y `biblib.model_compare(null)` informa de cualquier diferencia. Después de 0011 no se promete volver al escritor anterior: con varias copias por edición o libros sin ISBN, `books` ya no puede representarlos. Si algo falla, se detienen las escrituras y se corrige hacia delante o se restaura el respaldo ensayado (el de antes del cambio, con su head, y se repite la migración).

#### Supresiones de cuentas al restaurar (U-OPS-03)

Un respaldo anterior a una eliminación de cuenta contiene esa cuenta entera. Restore la retira **antes de terminar y de abrir el destino** (fase `suppress`, tras `rotate`), con las supresiones que conoce: las marcas de `biblib.account_deletions` que trae el propio respaldo (también solicitudes a medias), el registro privado del perfil (`.biblib/state/<perfil>-suppressions.json`, que mantienen `account:deletions:local` y `db:backup:local` y que sobrevive a `db:reset:local`) y, si se indica, `--suppressions <registro.json>` exportado de otro entorno. Para cada cuenta que vuelve: retira sus objetos de Storage, borra su identidad con la API admin de GoTrue (la cascada de `auth.users` retira sus filas) y deja su marca `completed` con `account_deletion_suppress`. Si queda cualquier resto, falla con **11** y el destino no se abre. El recibo guarda solo cantidades y los hechos de las tablas que cambian; nunca IDs.

- **Respaldo anterior a 0013.** Las identidades se retiran igual; la marca no se puede escribir hasta migrar (el recibo lo avisa en `review`) y el registro del perfil la conserva.
- **Otro entorno.** Restaurar en un perfil una copia de otro exige su registro: `--suppressions .biblib/state/<perfil de origen>-suppressions.json`. En producción (U-INF-07) el registro es parte del procedimiento: se exporta con cada respaldo y se aplica a cualquier copia anterior.
- **Trabajos y eliminaciones en ejecución en el respaldo.** La fase `rotate` los reanuda como reintento (`waiting_retry`, sin lease, fencing nuevo): un trabajador los reclama de nuevo tras el restore y revalida la cuenta.

Ensayo G12 en scratch: [O12/ops-03](validacion/2026-10-25/O12/ops-03/informe.md).

### Verificación (`db:restore:verify`)

Comprueba los archivos del respaldo; que hay un restore completado de ese respaldo; el ledger idéntico; el manifest de objetos de U-INF-04 (RLS, políticas, grants, FK, índices, columnas, función y trigger de versión) y los hechos de catálogo idénticos al origen; cantidades, claves y contenido por tabla (dominio y ledger completos salvo el token rotado; Auth y Storage por cantidad y claves); que ningún token coincide con el respaldo; la muestra de fichas; sesiones GoTrue reales de A y B con `tests/integration/support/session.mjs`, sus IDs restaurados y RLS con sus claims (solo ven lo suyo, actualizar lo ajeno afecta 0 filas); buckets y cada objeto Storage con su sha256. Con supresiones (U-OPS-03), las tablas que cambió la fase `suppress` se comparan con los hechos que registró tras aplicarla, los tokens y la muestra descuentan lo suprimido, los objetos de esas cuentas no se esperan y `suppressions.applied` comprueba que ninguna cuenta suprimida tiene identidad, filas ni objetos. Escribe el informe en `<respaldo>/rehearsals/` con duración del restore, de la verificación y total, discrepancias y la ventana de datos perdidos, y lo enlaza desde el recibo. Cualquier discrepancia sale con **11**.

| Código | Significado en estos comandos |
| --- | --- |
| 0 | Completado y, en verify, sin discrepancias. |
| 2 | Argumentos no admitidos, `db:backup:prod` o clave con formato incorrecto. |
| 3 | Identidad ajena: proyecto, perfil, worktree, `BIBLIB_TARGET`, recurso o ruta. |
| 5 | Historial divergente o drift. |
| 6 | Falta la clave, no corresponde, destino no vacío o perfil sin esquema. |
| 7 | Escrituras durante el respaldo o bloqueo ocupado. |
| 8 | Docker, pg_dump, psql, GoTrue o Storage no completaron la operación. |
| 11 | Respaldo incompleto o alterado, o verificación con discrepancias. |
| 130 | Interrupción. |

## Antes de abrir tráfico tras una restauración

1. Ejecutar `db:restore:verify` sin discrepancias.
2. Comprobar que la fase `suppress` aplicó las supresiones de cuentas posteriores al respaldo (U-OPS-03): `suppressions.applied` en verify. Si el respaldo viene de otro entorno, repetir el restore con su registro (`--suppressions`).
3. Registrar qué escrituras posteriores a `createdAt` del recibo se pierden o se recuperan por otra vía.
4. Revisar la lista `review` de la rotación y decidir qué trabajos pueden reanudarse.
5. Migraciones pendientes tras restaurar (respaldo de un head anterior): `db:plan:local` y `db:migrate:local`.

## Procedimiento remoto (pendiente)

No implementado. Depende de U-INF-07 (descriptor remoto, identidad comprobada, promoción) y de conocer el plan contratado:

- No presuponer PITR ni la descarga de un tipo de backup no contratado. Identificar primero qué ofrece el proveedor y su retención.
- Los backups de base de Supabase no incluyen los bytes de Storage: la copia de objetos se planifica y ensaya aparte.
- La restauración remota se ensaya en un proyecto aislado compatible, nunca en el de origen ni en un stack de otro proyecto por ser `localhost`.
- No se ofrecen `truncate:prod` ni `seed:prod` como comandos ordinarios.

## Limitaciones conocidas

- Volcados, cifrado y objetos se procesan en memoria (límite de 512 MiB por volcado): suficiente en local, no para producción.
- Mailpit no se respalda. El recibo de este comando no satisface todavía el adaptador `--backup-receipt` de `db:reset:local` (exige alcance `mailpit`, rutas relativas a la raíz y el `discardedStateHash` de su plan): su integración queda para U-INF-06/07.
- La invalidación de tablas futuras (previews, leases, idempotencia) se detecta por nombre/columnas. Cada unidad que cree una tabla de ese tipo debe ampliar `rotateRestoredTokens` (`scripts/lib/backup-db.mjs`) y su prueba.
- La aplicación debe estar detenida durante el respaldo; la marca de estado detecta escrituras, pero no las impide.

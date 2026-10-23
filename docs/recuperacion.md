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

### Verificación (`db:restore:verify`)

Comprueba los archivos del respaldo; que hay un restore completado de ese respaldo; el ledger idéntico; el manifest de objetos de U-INF-04 (RLS, políticas, grants, FK, índices, columnas, función y trigger de versión) y los hechos de catálogo idénticos al origen; cantidades, claves y contenido por tabla (dominio y ledger completos salvo el token rotado; Auth y Storage por cantidad y claves); que ningún token coincide con el respaldo; la muestra de fichas; sesiones GoTrue reales de A y B con `tests/integration/support/session.mjs`, sus IDs restaurados y RLS con sus claims (solo ven lo suyo, actualizar lo ajeno afecta 0 filas); buckets y cada objeto Storage con su sha256. Escribe el informe en `<respaldo>/rehearsals/` con duración del restore, de la verificación y total, discrepancias y la ventana de datos perdidos, y lo enlaza desde el recibo. Cualquier discrepancia sale con **11**.

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
2. Aplicar las supresiones de cuentas posteriores al respaldo (U-OPS-03).
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

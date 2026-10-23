# U-INF-06 · Implementación preparada; ensayo destructivo pendiente

Fecha: 23-10-2026. Rama: `u-inf-06`. Raíz: `C:/Users/ncaso/orca/workspaces/biblib/u-inf-03`.

**Resultado de la tarea: incompleto.** El reset físico está implementado y cubierto por pruebas sin Docker, pero no se ejecutó su destrucción real ni el ensayo SIGINT sobre Docker. Falta la decisión del coordinador sobre el mecanismo propuesto, solicitada en `msg_760a3ada7708` y reanudada tras tres esperas de diez minutos sin respuesta; también se enviaron escalación y estado por Orca. No se da por cerrada U-INF-06 ni la puerta G06.

## Cambios entregados

- `scripts/db/reset-local.mjs` y `db:reset:local`: parser cerrado, planes `reset-local` con caducidad de 30 minutos, raíz/proyecto/perfil/IDs/bindings/mounts, cantidades y huella de todas las tablas descartables y todas las páginas de Mailpit. Apply exige identidad/hash y renuncia local o recibo de respaldo verificado.
- Rechazo previo de 5432, remoto, marcador HolaERP, raíz/red/volumen ajenos, túnel sin binding Docker y contenedores no registrados. La eliminación física preparada usa IDs registrados exactos y revalida el inventario antes de cada mutación. Conserva la red y nunca usa patrones ni borrado forzado de volúmenes.
- Recibo por fases y continuación del mismo plan/autorización; interrupción simulada con 130 y protección frente a reemplazos de volumen. `up`/bootstrap independientes rechazan un reset incompleto.
- `scripts/lib/local-path.mjs`: rutas absolutas dentro de `.biblib/`, `lstat`/`realpath` y rechazo de symlinks/junctions, también antes de comenzar las eliminaciones. Inventario Docker ampliado con mounts, sin inspeccionar variables, comandos o logs de contenedores.
- `scripts/db/verify-local.mjs` y bootstrap completo: runner Drizzle, seed existente y verificación de head/manifest/censo, sesiones GoTrue A/B con el helper SSR existente, bucket privado/descarga firmada y Mailpit con correo ficticio. Antes de omitir seed se comprueban sus efectos actuales: se conservan las versiones de los libros en el segundo bootstrap.
- Documentación operativa actualizada y harness destructivo preparado en `ensayo.mjs`. No se ha ejecutado ese harness; debe reservarse scratch y resolver primero la decisión siguiente.

Commits de implementación:

1. `be760ed` — `feat(db): incorpora reset local protegido y bootstrap verificable`.
2. `ce9881c` — `fix(db): incluye todo Mailpit en la huella del reset`.
3. `1dd68db` — `fix(db): respeta los permisos de plataforma al bloquear el reset`.

## Decisión pendiente y comprobación de la CLI

La fuente de la versión instalada **2.117.0** confirma que el reset local PG17 sustituye contenedor y volumen Postgres: ledger Drizzle y esquema de dominio se reconstruyen juntos, además de Auth y los metadatos Storage. Reinicia los servicios satélite, pero conserva el volumen de bytes Storage y los mensajes Mailpit. No aporta recibos por recurso para recuperar una interrupción entre sus eliminaciones/recreaciones. Las URLs exactas y hashes de los tres archivos revisados se conservan en `cli-source-review.json`; no se copió su código completo.

El encargo prefiere reset nativo y condiciona la alternativa física a sus garantías. Puesto que la CLI sí reconstruye ledger/esquema juntos, se pidió al coordinador confirmar la alternativa física por su alcance completo de Storage/correo y su continuación por IDs sin adopción de reemplazos. **No se interpretó la falta de respuesta como autorización.** El coordinador debe aceptar esa elección o pedir la variante nativa que preserve explícitamente los bytes/correo en el plan.

Durante una prueba real no destructiva se detectó SQLSTATE `42501`: el rol local `postgres` no puede hacer `LOCK TABLE` sobre las tablas protegidas de Auth/Storage. La implementación conserva el bloqueo consultivo común y los locks de dominio/ledger, sin modificar permisos ni tablas de plataforma. El reensayo alcanzó el rechazo de respaldo ausente (**6**), liberó los bloqueos y mantuvo el mismo inventario Docker (`real-lock-and-backup-rejection.json`).

## Validaciones ejecutadas

Resultados finales en `checks.json`, con fecha, duración y códigos reales:

| Comando | Resultado |
| --- | --- |
| `pnpm lint` | 0, sin avisos. |
| `pnpm typecheck` | 0. |
| `pnpm test` | 0; 66/66. |
| `pnpm test:db` | 0; Postgres efímero propio eliminado al terminar. |
| `pnpm test:scripts` | 0; **119/119**, sin skips y con scratch real. |

También se ejecutó `BIBLIB_SKIP_STACK_TESTS=1 pnpm test:scripts` antes de añadir las últimas tres pruebas: 111 pasadas, 2 omitidas, 0 fallos (113 pruebas contabilizadas; el grupo de migraciones de stack completo se omite en ese modo).

Las pruebas nuevas cubren argumentos peligrosos, 5432/remoto/HolaERP, raíz y red ajenas, marcador aislado, contenedor sin registro, montajes compartidos, cambios de datos con las mismas cantidades, páginas adicionales de Mailpit, plan alterado/caducado, confirmación equivocada, respaldo incompleto/alterado, rutas externas y junctions reales de Windows, interrupción/continuación simuladas y fallo de verify/bootstrap sin éxito anticipado.

Ensayos reales ejecutados:

- `db:local:up --profile scratch` y bootstrap completo con A/B, manifest, Storage firmado, Studio sano y Mailpit.
- Dos bootstraps consecutivos con `seed.unchanged: true`: los hashes de dominio, ledger y Storage, incluidas versiones de libros, permanecen idénticos (`bootstrap-prereset-proof.json`). La verificación genera actividad normal de Auth y nuevos recibos; no se afirma que esos registros de actividad no cambien.
- Dry-run real con cantidades y rechazo de proyecto incorrecto (**3**) y hash incorrecto (**6**), sin cambio de inventario Docker (`real-preflight-rejections.json`).
- Rechazo de recibo ausente (**6**) después de adquirir locks reales, sin destrucción.
- `db:local:down --profile scratch`: todos sus servicios quedan parados (`down-result.json`).

## Aceptación y trabajo restante

| Criterio de U-INF-06 | Evidencia disponible | Falta |
| --- | --- | --- |
| 1 · Rechazos de identidad | Pruebas sin Docker; rechazos reales 3/6. | Ensayo destructivo no necesario para estos rechazos; validar mecanismo decidido. |
| 2 · Reconstrucción única y fixtures | Código y pruebas simuladas; runner/seed reutilizados. | **Apply destructivo real**, reemplazo de IDs/volúmenes y ledger de 3 filas posterior. |
| 3 · Sesiones/Storage/Studio/Mailpit después | Bootstrap real sobre el stack existente. | Repetir **después de reset real**. |
| 4 · Conservación de otro stack | 11 contenedores HolaERP con mismos IDs, StartedAt, reinicios, estado, puertos, redes y mounts; redes/volúmenes iguales. | Repetir comparación al ejecutar el reset real. No se consultaron datos de HolaERP por SQL. |
| 5 · Interrupción/continuación | Simulación sin Docker y recibos de fase. | **SIGINT y continuación reales** del reset. |
| 6 · Confinamiento de rutas | Pruebas de rutas externas y junctions reales de Windows. | Sin pendiente de código detectado. |

Una vez decidida la alternativa física, el harness preparado ejecuta dry-run → apply descartando → comprobación de ledger/fixtures/IDs → evento SIGINT al handler real en proceso hijo Windows durante `destroy` → continuación → bootstrap doble → down. El método de señal está explicado en su código: usa `process.emit("SIGINT")`, porque `child.kill("SIGINT")` en Windows fuerza terminación en lugar de entregar una señal POSIX. No se presenta ese harness como ya ejecutado.

## Coexistencia y recursos que quedan

`holaerp-comparison.json` compara la línea base con el final; **11 contenedores intactos** y redes/volúmenes iguales. Se normalizó únicamente el orden de las etiquetas de las salidas `docker ... ls` al comparar. El inventario de identidad se obtuvo con una lista blanca sin secretos. No se usó el perfil `test` ni se modificó `tests/integration/**`.

Scratch queda parado, sin contenedores, con estos recursos registrados conservados (`resources-left.json`):

- Red `biblib-scratch-network`, ID `6da7397786e3b33fb372d7b587d9eea41376f390462853725139085946f66797`.
- Volumen `supabase_db_biblib-scratch`, `createdAt: 2026-10-23T10:52:22Z`.
- Volumen `supabase_storage_biblib-scratch`, `createdAt: 2026-10-23T10:52:38Z`.

No se cambiaron runner, seed, lockfile, permisos de plataforma ni configuración global de Docker. El cambio paralelo anunciado de U-QA-01 en la guarda de worktree de `local-stack.mjs` y su prueba debe conservarse al fusionar: esta rama no modificó esa guarda. El productor definitivo de respaldos pertenece a U-OPS-02; el adaptador local actual no genera ni restaura respaldos.

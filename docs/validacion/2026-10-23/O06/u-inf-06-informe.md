# U-INF-06 · Reset local y bootstrap verificados

Fecha: 23-10-2026. Rama: `u-inf-06`. Raíz: `C:/Users/ncaso/orca/workspaces/biblib/u-inf-03`.

**Resultado: completado.** El coordinador autorizó la reconstrucción física acotada en `msg_833c65e92917`, resolviendo la consulta del intento anterior. Se ejecutó el harness `ensayo.mjs`: dry-run → apply con renuncia local → verificación → interrupción durante destroy → continuación → dos bootstraps → down.

## Implementación

- `scripts/db/reset-local.mjs` y `db:reset:local`: argumentos cerrados, plan `reset-local` de 30 minutos con raíz/perfil/proyecto, IDs, mounts, bindings, cantidades y hashes sin filas de dominio/Auth/Storage/ledger ni contenido de correo. La huella incluye todas las páginas de Mailpit.
- Apply exige proyecto/hash y renuncia explícita o recibo local completo de respaldo con restauración comprobada y archivos verificados. No genera ni restaura backups: corresponde a U-OPS-02.
- Identidad Docker y registro del checkout obligatorios antes de consultar datos o mutar recursos; rechaza 5432, remoto, HolaERP, raíz/red ajenas, túnel sin binding, marcador aislado, contenedor sin registrar y volúmenes reemplazados.
- Destrucción por IDs exactos registrados, con `createdAt` de volúmenes y nueva comprobación antes de cada operación. Conserva la red propia. No hay patrones, prune, stop global ni borrado forzado de volúmenes.
- `scripts/lib/local-path.mjs` confina eliminaciones a rutas absolutas en `.biblib/`, con `lstat`/`realpath` y rechazo de enlaces/junctions incluso dentro del árbol eliminado.
- Recibo de reset con fases, autorización y huella; SIGINT deja estado interrumpido y código 130. La continuación usa el mismo plan y autorización, sin adoptar recursos nuevos. Bootstrap independiente rechaza un reset incompleto.
- Bootstrap recorre preflight → stack → env → migrate → seed → verify. Drizzle, seed y helpers SSR existentes se reutilizan; verify valida head/manifest, fixtures, sesiones A/B, cookies, bucket privado/descarga firmada y Mailpit. El segundo bootstrap verifica antes de omitir seed, conservando versiones de libros.

La implementación y pruebas del intento inicial están en `be760ed`, `ce9881c` y `1dd68db`. El reintento completa la evidencia real y conserva el merge `9b707b5`, incluida la guarda scratch+test para up/bootstrap y ambos scripts de O06.

## Mecanismo autorizado

La fuente exacta de Supabase CLI 2.117.0 confirma que su reset PG17 recrea contenedor/volumen DB: ledger Drizzle, dominio, Auth y metadatos Storage se reconstruyen juntos. Conserva bytes del volumen Storage y correo Mailpit y no entrega recibos por recurso para continuar entre eliminaciones. Referencias y hashes en `cli-source-review.json`.

El coordinador autorizó por escrito la reconstrucción física preparada para abarcar también bytes de Storage y Mailpit y recuperar por IDs comprobados. El plan muestra expresamente esa pérdida. Las migraciones/seed de usuario de Supabase permanecen desactivados; el runner Drizzle reconstruye negocio y ledger conjuntamente tras arrancar una plataforma fresca.

El rol local postgres no permite LOCK TABLE sobre tablas protegidas de Auth/Storage. Se conserva el bloqueo consultivo común y los locks de dominio/ledger, sin cambiar permisos; deben detenerse las escrituras de la app al revisar/aplicar el plan. La prueba real de respaldo ausente llegó al rechazo 6 tras adquirir esos locks y mantuvo Docker intacto (`real-lock-and-backup-rejection.json`).

## Ensayo destructivo real

| Comprobación | Resultado y evidencia |
| --- | --- |
| Primer reset | Exit 0, todas las fases pasadas; `reset-first-result.json`, `reset-first-receipt.json`. |
| Sustitución acotada | Todos los IDs de contenedores y fechas de creación de ambos volúmenes cambiaron; red conservada; `physical-rebuild-proof.json`. |
| Reconstrucción | Ledger 3 filas, 2 usuarios, 8 libros, 6 estanterías, 1 bucket/objeto privado y 1 correo; `physical-rebuild-proof.json`. |
| Servicios después | Manifest y head 0002 correctos; A/B signIn/getUser/cookies SSR válidos, descarga firmada con bytes deterministas, Mailpit accesible y correo recibido; verify en ambos recibos de reset. Studio pasa health del stack. |
| Interrupción | Evento SIGINT al handler real en hijo Windows durante destroy, exit 130 y recibo interrupted; `sigint-proof.json`, `reset-interrupted-receipt.json`. |
| Continuación | Mismo plan y autorización, resumed true, migrate/seed/verify pasados; `reset-resumed-result.json`, `reset-resumed-receipt.json`. |
| Bootstrap doble | Ambos exit 0, seed.unchanged true, mismos recursos y hashes de dominio/ledger/Storage, incluidas versiones; `bootstrap-first-result.json`, `bootstrap-second-result.json`, `bootstrap-idempotence.json`. |
| Parada | Scratch sin contenedores, red/volúmenes propios conservados; `down-result.json`, `resources-left.json`. |

En Windows `child.kill("SIGINT")` fuerza terminación en vez de entregar una señal POSIX. El harness usa `process.emit("SIGINT")` dentro de un proceso hijo que ejecuta el handler real del CLI; no simula Docker ni su destrucción. No se ha ensayado corte eléctrico/terminación forzada con recuperación del bloqueo residual.

La idempotencia se refiere a dominio, ledger, activos y recursos: la verificación crea/cierra sesiones reales y actualiza recibos operativos. Los hashes conjuntos antes y después son `f3ccaadea5d2c504c5401ae402995ae64f73495ce8062e6ea2e8ffa06f66a5ee`.

## Validación y aceptación

Los cinco comandos obligatorios se volvieron a ejecutar en este reintento; sus códigos, duración y resumen están en `checks.json`. Todos salieron con 0: lint, typecheck, 66/66 unitarias, test:db y **125/125 en test:scripts sin omisiones**, con scratch en marcha. Después se paró scratch y se volvió a comprobar HolaERP idéntico.

Las pruebas sin Docker cubren 5432/remoto/HolaERP, raíz/red ajenas, marcador aislado, contenedor sin registro, montajes compartidos, cambios sin variación de cantidades, Mailpit paginado, planes alterados/caducados, confirmación incorrecta, respaldo inválido, rutas externas/junctions y fallo/interrupción/continuación sin éxito prematuro.

| Criterio U-INF-06 | Evidencia |
| --- | --- |
| 1 · Rechazo previo de identidad | `tests/scripts/reset.test.mjs`, `real-preflight-rejections.json`. |
| 2 · Reconstrucción única coherente | Primer reset y continuación reales, IDs/createdAt nuevos y ledger 3 filas. |
| 3 · Servicios/identidades después | Verify real en ambos resets y bootstraps. |
| 4 · Conservación de otro stack | Comparación de la línea base actual de HolaERP antes/después. |
| 5 · Interrupción/continuación | SIGINT durante destroy, 130, recibo interrupted y recuperación exitosa. |
| 6 · Rutas confinadas | Pruebas de ruta externa y junction real de Windows, eliminación mediante Node. |

## Coexistencia y recursos conservados

`holaerp-reset-before.json` y `holaerp-reset-after.json` comparan la línea base de este reintento: **10 contenedores** con los mismos IDs, StartedAt, reinicios, estado, puertos, redes y montajes, más redes/volúmenes idénticos. `holaerp-comparison.json` confirma la comparación tras el ensayo destructivo. El intento inicial registró 11 contenedores; sus archivos históricos `holaerp-identity-*.jsonl` se conservan y no se presentan como la línea base del reintento. No se consultaron datos de HolaERP por SQL ni se imprimieron variables, comandos o logs de sus contenedores.

Scratch queda parado y conserva:

- Red `biblib-scratch-network`, ID `6da7397786e3b33fb372d7b587d9eea41376f390462853725139085946f66797`.
- Volumen `supabase_db_biblib-scratch`, creado `2026-10-23T12:44:16Z`.
- Volumen `supabase_storage_biblib-scratch`, creado `2026-10-23T12:44:33Z`.

No se levantó test ni se modificó `tests/integration/**`, runner, seed, lockfile, permisos de plataforma o configuración Docker. El test de seed real conserva su libro manual ficticio como en U-INF-05; no procede de datos personales. La matriz U-QA-01 ya está integrada y se conserva. No quedan conflictos ni trabajo de U-INF-06 pendiente; generación/restauración de respaldos sigue en U-OPS-02.

# U-EXP-02 · Vistas guardadas y filtros reproducibles

Estado: implementación registrada en `u-exp-02`; aceptación bloqueada por la plataforma
local. La unidad no supera la puerta de O10 y se informa con resultado fallido; los comandos
interrumpidos o no ejecutados no cuentan como aprobados.

## Implementación

- `0007_saved_views`: tabla privada con FK de propietario, RLS de las cuatro operaciones,
  índice por propietario/actualización y nombres únicos sin distinguir mayúsculas dentro de
  una cuenta. Evita entradas indistinguibles; los acentos y los nombres de otras cuentas se
  conservan. CHECK de nombre de 1–80 caracteres y validación de JSON en base.
- Límite de 100 en servidor y trigger, con bloqueo consultivo por cuenta para las altas
  simultáneas. El trigger impide transferir filas y rota su versión. Ninguna operación de
  vistas modifica la revisión de colección.
- Cinco acciones con `ActionResult`, Zod al leer y escribir y CAS para renombrar,
  sobrescribir y borrar (`CONFLICT` si cambia la versión; `NOT_FOUND` si no está disponible).
  Los filtros solo contienen `q?`, `status`, `shelf`, `sort`, `view` y `pageSize`.
- Panel accesible con controles nativos/Radix en español para guardar, aplicar, renombrar,
  sobrescribir y borrar. Los cambios se anuncian tras confirmación; fallos de red conservan
  filtros y borrador. Aplicar consulta estanterías actuales y empieza en página 1.
- URL como fuente de verdad; saneamiento de parámetros y soporte de `pageSize` de 10 a 100,
  incluido el enlace 3D de 48. Los cambios crean historial, Atrás/Adelante restaura controles,
  y cambiar filtros/página limpia selección. Un fallo al mover conserva la selección.
- Las vistas son datos de usuario restaurables, no caché. El dump administrativo las
  incluye con sus fechas y versiones; un destino con vistas no está vacío. La exportación
  portable actual sigue siendo de libros y estanterías.

## Pruebas incorporadas

- `tests/saved-views.test.ts`: parseo, serialización, parámetros malformados, criterios
  permitidos, nombres y omisión de una estantería eliminada sin modificar la vista.
- `tests/integration/views/`: acciones HTTP con GoTrue A/B, SQL autenticado, Data API,
  cuota con dos conexiones reales para el último hueco, nombres/JSON y conflictos. Chrome
  recorre persistencia, Atrás/Adelante, selección, error de red, estantería borrada y borrado
  confirmado. Runner `pnpm test:integration:views --profile scratch|test`; también en SUITES
  de `test:integration:local`.
- `tests/e2e/flujos/vistas.spec.ts`: CRUD de vistas en la suite E2E del perfil test.
- `tests/scripts/saved-views.test.mjs`: contrato del runner, destino con preferencias y drift
  del trigger, función JSON, políticas e índices, incluyendo expresión y dirección.
- `test:db` incorpora la migración 0007. El sustituto de plataforma crea también `anon`,
  necesario para probar los permisos de la nueva migración.
- El inspector conserva el formato de índices de los hechos sellados de respaldos 0000–0006;
  solo la nueva tabla añade la definición necesaria para detectar drift. Hay una regresión
  que compara el resultado con la captura real de 0006.

## Evidencia obtenida

| Comprobación | Resultado observado |
| --- | --- |
| `db:local:bootstrap --profile scratch --json` | Correcto: actualización 0006→0007, head 8/8, seed y verificación real de Auth/Storage/Mailpit. |
| `inspectObjects` + `verifyManifest` en scratch | 261 comprobaciones, 0 fallos; metadatos reales en `tests/fixtures/migrations/objects-0007.json`. |
| Primera ejecución de `pnpm test` | 321/322; única expectativa antigua del enlace 3D, ajustada para incluir `pageSize`. Las cinco pruebas nuevas de contrato pasaron en esa ejecución. |
| Primera ejecución de `pnpm typecheck` | Detectó la inferencia de un campo de actualización; corregida usando el esquema específico de cada operación. |
| Primera ejecución de `pnpm lint` | Detectó un setState directo en un efecto; corregido usando la clave de petición en los eventos de URL/aplicación. |
| Integración `views`, dos intentos | Bloqueada antes de ejecutar casos: consulta de estado local, salidas 11 y 8. |
| `node tests/scripts/saved-views.test.mjs` tras los cambios finales | Correcto: 4 pruebas, 4 aprobadas, 0 fallos; incluye compatibilidad de respaldos, contrato del runner, restauración y drift. Ejecución directa sin el proceso hijo del runner general; no sustituye `pnpm test:scripts`. |
| Repetición acotada de `pnpm lint` | Interrumpida por tiempo; 283,4 s reales. |
| Repetición acotada de `pnpm typecheck` | Interrumpida por tiempo; 250,3 s reales; `next typegen` sí terminó. |
| Repetición acotada de `pnpm test` | Interrumpida por tiempo; 190 s reales. |
| `pnpm test:scripts --test-concurrency=1` | El controlador agotó la espera tras 214,5 s reales; el log muestra 20 archivos fallidos y 0 aprobados, sin diagnóstico adicional (`test failed`). Se omitieron pruebas de stack/build mediante sus banderas documentadas; no equivale a la suite completa. |
| `pnpm build` | Interrumpida por tiempo; 252,8 s reales. Turbopack registra `node process exited before we could connect to it` y `0xc0000142` al crear un proceso para CSS. |
| `pnpm test:smoke` | Interrumpida por tiempo; 219,8 s reales. |
| Migración desde vacío/reset | Pendiente; no se ejecuta una operación destructiva sin poder acreditar la plataforma. |
| `pnpm test:db` y estado final sin drift | Bloqueados por Docker; no se acreditan. El manifest inicial correcto no sustituye estas puertas. |
| `db:local:down --profile scratch --json` | Falló en preflight, salida 4: no pudo consultar la versión fijada de pnpm. |
| CLI Supabase local 2.117.0, parada solo de este workdir | Falló al listar contenedores: Docker API v1.54, HTTP 500. |
| Recuperación con comprobación de identidad/propiedad | Salida 8; `parada-acreditada.json` tiene `stopped: false`. No se pudo completar el inventario; no se ejecutó ninguna parada sin acreditar propiedad. |
| Comparación final de HolaERP | La consulta acotada falló; `inventario-final.json` indica `verified: false`. No se acredita identidad final; no se ejecutaron mutaciones de HolaERP. |

El diagnóstico y las acciones concretas durante el bloqueo están en
[incidencia-plataforma.md](incidencia-plataforma.md). Los servicios de scratch llegaron a
figurar no saludables, Docker y los comandos de versión dejaron de responder con normalidad,
y el wrapper de parada falló en preflight. No se reinició Docker ni se terminaron procesos
que ocupaban puertos.

`resultados-acotados.json` contiene los resultados reales del controlador; su salida 0 solo
significa que registró las seis ejecuciones, no que estas pasaran. Los tiempos superan los
120 s de espera nominal por la demora del propio host al lanzar y terminar los procesos.
No se atribuyen los subprocesos fallidos de `test:scripts` a defectos concretos sin una
ejecución capaz de aportar diagnósticos; la suite sigue pendiente.

## Commits y alcance

- `7c9bf46`: persistencia, esquema, migración, manifest, acciones, contrato y recuperación.
- `8081be4`: panel, URL/historial, runners e integración, E2E y operación.
- `7a4e62a`: adaptaciones mínimas de regresión y runner SQL. Archivos auxiliares fuera de la
  lista principal de propiedad, aislados en este commit: `tests/book-search.test.ts`,
  `tests/shelf-viewer-3d.test.ts`, `tests/scripts/migrations.test.mjs`,
  `scripts/test-database.mjs` y `tests/db/bootstrap.sql`.
- `4cae1a8`: mensajes de fallos de red en español.
- `bd7a3ab`: foco de teclado después de respuestas y límite de búsqueda; navegación del
  panel con Enter y runner sin compilación auxiliar innecesaria.
- `e1f56ef`: preservación del formato de hechos de respaldos anteriores a 0007, con
  regresión centrada aprobada.

Los textos de fallos de transporte se han revisado para no mostrar mensajes técnicos en
inglés. No hay push, PR, cambios remotos ni cambios en los recursos de otros perfiles.

## Despliegue y recuperación

Aplicar primero 0007 y después la aplicación. Retirar el panel conserva sus filas y los
filtros URL; no eliminar la tabla durante una reversión de interfaz. Las preferencias se
recuperan con el respaldo administrativo conforme a `docs/recuperacion.md`.

Antes de aceptar la unidad quedan: grupo `views` real en scratch, reset desde vacío,
`test:db`, regresión completa sin fallos, build, smoke, comprobación de drift y parada propia
acreditada con el inventario final de redes/volúmenes y comparación de HolaERP.

## Recursos y cierre seguro

Último inventario válido: red `biblib-scratch-network` y volúmenes
`supabase_db_biblib-scratch`, `supabase_storage_biblib-scratch`, conservados. Los ocho
contenedores conocidos son `supabase_{studio,pg_meta,storage,rest,inbucket,auth,kong,db}_biblib-scratch`;
los que tienen healthcheck figuraban no saludables. El estado físico final de los
contenedores no pudo consultarse (`inventario-final.json`, `scratch.verified: false`):
no se afirma que estén detenidos.
No se han borrado volúmenes/redes ni se ha modificado el registro permanente del perfil.

Los intentos propios de parada terminaron; no se deja una orden de parada pendiente que
pueda actuar más tarde. `detener-scratch.mjs` es una evidencia de recuperación limitada al
root y huella registrados, requiere `--apply` y rechaza identidad ajena. No sustituye la
parada canónica, que deberá repetirse cuando Docker responda.

Para continuar: recuperar externamente el motor sin tocar HolaERP desde este worktree,
comprobar propiedad de scratch, repetir las puertas pendientes y ejecutar finalmente
`pnpm db:local:down --profile scratch`. No se ha cambiado el perfil test ni se ha solicitado
un reinicio global; no hay push ni PR.

# U-DAT-09 · CSV con mapeo explícito y revisión reutilizable

25 de octubre de 2026 · O13 · worktree `u-dat-09`.

## Entrega y alcance

Fase 1: parser/mapeo/normalización puros, fixtures y contratos, en `f4cafa0` y `d1e5a12`; [evidencia original](fase-1.md). Fase 2: integración de `feature/spec-pendientes` en `52a2d39`, contrato definitivo de 0014, acciones/staging/CAS (`6c78dfc`), interfaz de Ajustes (`18c230a`), integración/E2E (`2afc11d`), política explícita para ISBN repetidos dentro del CSV (`10d11e6`), cupo de previews compartido con JSON (`f32c3a1`) y consentimiento para enriquecer portadas (`0d72b8f`). No se cambian schema, migraciones aplicadas ni `components/book-form.tsx`.

La persona selecciona separador y archivo, asigna todas las columnas —incluido ignorar— y guarda el mapeo. Puede editar la tabla visible de estados, el separador de autores/editoriales y las reglas para celdas vacías. Después revisa las altas, omisiones y eliminaciones y confirma. Ninguna fórmula, SQL o contenido de celda se interpreta como código.

## Persistencia y publicación

- `beginCsvImportAction`: abre o recupera la sesión del mismo archivo/separador. Máximo 3 CSV abiertos por cuenta, caducidad de 24 horas; las sesiones CSV no consumen el cupo de restauraciones por partes.
- `inspectCsvAction`: trozos Blob de 256 KiB, orden y tamaño comprobados, sha256 por trozo y sha256 del archivo completo. Se ensamblan los bytes antes de decodificar UTF-8; repetir un trozo idéntico no crea filas, y otro contenido en la misma posición es conflicto.
- `setCsvMappingAction`: compara token y versión de mapeo, guarda el shape de 0014 y su hash y sustituye los registros inmutables con la sesión en `receiving`. Las claves durables definitivas son **`csv:<ordinal>`**; el ID canónico de origen añade el namespace de sesión. Una corrección conserva esas claves e IDs y caduca la preview anterior.
- `prepareCsvImportAction`: normaliza fuera de la transacción, vuelve a comprobar el token bajo bloqueo y almacena la salida v2 validada por el lector JSON. El digest vincula archivo, mapeo, versión, modo, política y omisiones. Una preparación idéntica sobre la misma revisión recupera la preview; asignar IDs con la semilla de sesión los conserva al volver a revisar.
- La confirmación es **`confirmImportAction`**, con el trabajo y el publicador existentes de JSON. El publicador deriva de nuevo el plan bajo el bloqueo/CAS y comprueba que la sesión y su mapeo siguen vinculados a esa preview. Publicación, resultado idempotente y marca `committed` de la sesión comparten la transacción. Un reemplazo captura la versión anterior y conserva la predeterminada.
- `import_sessions` de 0008 tiene `version`, pero no trigger de rotación: las acciones CSV renuevan explícitamente ese UUID en cada cambio. Dos editores con tokens distintos no sobrescriben un mapeo sin conflicto.

Los registros de staging conservan el contenido privado y sus códigos/campos de incidencia, sin muestras en `issues`. Una fila con U+0000 se conserva codificada en ese JSON de staging y en sus bytes originales, y requiere corrección u omisión explícita: JSONB no admite el carácter nulo. La respuesta privada acota muestras a 120 puntos Unicode y devuelve hasta 200 incidencias con el recuento completo; la interfaz presenta hasta 100 y el informe descargable incluye todas. El resumen persistente por registro tiene como máximo 50 códigos y marca `MORE_ISSUES` si procede; el informe se reconstruye íntegro desde el archivo privado.

Los bytes y registros permiten reanudar revisión e informes mientras la sesión vive. La caducidad a las 24 horas impide el acceso; la purga física ocurre al iniciar otra sesión de esa cuenta o con la función administrativa existente de purga. Cancelar solo descarta staging. El cupo y la retención de vistas previas se comparten con JSON (10 previews). El inventario de eliminación de cuenta y el respaldo de 0014 ya incluyen estas tablas y `csv_mapping_profiles`.

## Omisiones, copias y seguridad

Por defecto cualquier error bloquea. El modo parcial necesita una elección explícita y enumera los ordinales/códigos omitidos en la preview durable. La estructura truncada, las comillas mal formadas, las cabeceras duplicadas y los límites globales siguen bloqueando. El informe CSV escapa fórmulas al descargar, sin anteponer apóstrofos al dato de dominio.

«Omitir existente» conserva ejemplares ya presentes y enumera también repeticiones de ISBN dentro del lote; «Añadir otra copia» permite una copia por registro, reutiliza la edición existente al fusionar y conserva su bibliografía. El nuevo ejemplar recibe estado/estantería de la fila y comprobación física falsa; otra copia ya verificada conserva su indicador. En reemplazo la elección controla las repeticiones del archivo. Los libros sin ISBN no reciben un ISBN ni identificador manual inventado: su exportación usa v2. Los JSON existentes conservan su política anterior, incluidas las copias declaradas en v2.

El dueño sale siempre de la sesión autenticada. Lectura, acciones, informes y perfiles filtran propietario y usan RLS; no hay parámetros de dueño ni URLs arbitrarias de proveedor. La inspección y la preparación no consultan catálogos. Los perfiles se guardan solo al pulsar su botón explícito, sin muestras, con nombre, versión y límite de 20 por cuenta.

El CSV tampoco consulta catálogos después de publicar por defecto: la casilla **«Buscar portadas después de importar»** empieza desactivada y su elección queda vinculada al digest. `PublishOutcome.skipCoverRecovery` evita sembrar elementos de portada en el trabajo cuando no se solicitó enriquecimiento; es una guardia de una línea en `lib/jobs/worker.ts`, sin cambiar la recuperación automática de JSON. La integración entregada comprueba cero elementos con un CSV que contiene ISBN válido sin consentimiento y el camino opt-in del mismo trabajo.

## Validación local

| Comprobación | Resultado y evidencia |
| --- | --- |
| `pnpm lint` | Exit 0, [log](fase-2-lint.txt) |
| `pnpm typecheck` | Exit 0, [log](fase-2-typecheck.txt) |
| `pnpm test` | 413/413, exit 0, [log](fase-2-test.txt) |
| `BIBLIB_SKIP_STACK_TESTS=1 pnpm test:scripts` | 254 pasan, 2 omisiones explícitas de stack, exit 0, [log](fase-2-test-scripts.txt) |
| `pnpm build` | Exit 0 con el código final, [log](fase-2-build.txt) |
| `pnpm test:db` | Exit 0 hasta 0014 y `product.sql`, [log final](fase-2-test-db.txt); incidencia previa resuelta en el fixture, detallada debajo. |
| `pnpm test:smoke --artifacts=docs/validacion/2026-10-25/O13/dat-09/smoke` | 12 grupos pasan con el código final, exit 0, [log](fase-2-smoke.txt), [reporte](smoke/report.json). |

Sin levantar perfiles Supabase, leer secretos ni tocar bases remotas. `test:db` y smoke usan únicamente sus contenedores efímeros propios y los retiran al cerrar. No se han tocado recursos de HolaERP ni los perfiles del coordinador. Recursos propios restantes: **ningún contenedor, red o volumen**; [comprobación Docker](recursos-docker.txt).

### Corrección mínima de un fixture previo, fuera del alcance funcional CSV

`test:db` falló dos veces, también sin compilaciones concurrentes, antes de 0014: `tests/db/catalogue.sql` exigía `waitMs` entre 990–1000 y 1990–2000. `catalogue_reserve` usa `clock_timestamp()` y resta el tiempo real entre llamadas; esos márgenes suponen que la primera llamada y sus aserciones duran menos de 10 ms. Se conservan la [primera ejecución](fase-2-test-db-intento-1.txt) y la [segunda](fase-2-test-db-intento-2.txt).

Se consultó al coordinador (`msg_6658403ad126`) y, tras más de diez minutos sin respuesta, se aplicó la regla común literal del encargo para archivos ajenos: corrección mínima, commit separado y explicación en el informe. **`4f86f4f`** cambia solo ese fixture: comprueba que los turnos persistidos están separados al menos un segundo y que `waitMs` cae entre los límites calculados con timestamps de antes/después de la llamada. No modifica 0004 ni la cuota, no añade sleeps y no elimina aserciones de intervalo, horizonte o aislamiento. La repetición completa de `test:db` pasó.

## Integración entregada para el coordinador

Por la instrucción explícita de fase 2 **no se ejecuta stack en este worktree**. Se entrega `pnpm test:integration:csv --profile scratch|test [--reuse-build]`, agregado a `SUITES`, con cuentas desechables, GoTrue real, RSC/HTTP y limpieza por dueño. Sus 7 escenarios cubren:

1. BOM/Unicode/comillas/saltos, conservación de registros, staging sin publicación, omisión de repetidos, confirmación e idempotencia.
2. Remap, hash distinto, claves/IDs estables y rechazo de preview/token anteriores.
3. Conflicto de colección, anónimo, aislamiento A/B por acciones/RLS e informes/perfiles.
4. Páginas negativas, estado desconocido y checksum inválido; bloqueo por defecto, omisión explícita, informe escapado y recuperación tras publicar.
5. «Omitir existente» frente a «otra copia», con edición/bibliografía conservadas.
6. Trozos fuera de orden, UTF-8 multibyte partido, replay, hash corrupto e inmutabilidad.
7. Cabeceras duplicadas, truncamiento, rechazo del modo parcial y límite propio de sesiones.

`tests/e2e/flujos/csv.spec.ts` añade 3 recorridos: mapeo/errores/informe/omisión, cambio en otra pestaña y remap, y elección explícita de otra copia con comprobación física independiente. La ejecución real de estos escenarios y sus capturas está asignada al coordinador en `test`; el smoke local general no se presenta como prueba de Auth/Storage reales ni de esos recorridos CSV. G13 necesita esa ejecución integrada antes de cerrarse.

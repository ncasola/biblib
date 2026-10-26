# U-DAT-09 · Fase 1 · CSV puro y contrato previo a 0014

Fecha: 25 de octubre de 2026. Worktree: `u-dat-09`, rama hija de `feature/spec-pendientes`.

## Entregado

- `lib/csv-import/parser.ts`: CSV UTF-8 estricto con BOM, coma/punto y coma/tabulador explícitos, campos entrecomillados, comillas escapadas, CR/LF/CRLF y saltos dentro de campos. Los ordinales cuentan registros de datos desde 1; la cabecera usa 0. Conserva registros vacíos, cortos y truncados para revisión. Las cabeceras vacías o duplicadas (trim, NFC, minúsculas) bloquean la salida.
- `mapping.ts`: cada columna por índice recibe un destino explícito, incluido ignorar; título obligatorio y destinos únicos. Los autores/editoriales solo se dividen con el separador elegido. La tabla visible de estados es parte de las reglas; un estado desconocido produce `UNKNOWN_STATUS`, nunca un estado leído por defecto.
- `normalization.ts`: claves de origen estables `csv:<sessionId>:<ordinal>`, SHA-256 de bytes originales, mapeo versionado y digest conjunto. Corregir el mapeo cambia el digest, conservando claves de origen. No usa reloj, UUID aleatorio, red, SQL ni persistencia. La fecha del adaptador v2 es una constante; no representa una exportación del usuario.
- Un registro válido produce un ejemplar con ISBN opcional, portada fallback y comprobación física falsa. ISBN-10/13 se valida con `normalizeIsbn`. Un ISBN repetido solo comparte edición cuando `editionFingerprint` coincide; una discrepancia bloquea con incidencia. No elige aún «otra copia» u «omitir existente» contra la biblioteca activa.
- `contracts.ts`: entradas/salidas TypeScript de `inspectCsvAction`, `setCsvMappingAction` y `prepareCsvImportAction`, incluidos upload por trozos, token de versión, hashes, política de duplicados y omisiones explícitas. Son tipos, sin acciones ficticias ejecutables. Se ajustarán al contrato definitivo de O13-D antes de conectar persistencia.
- Fixtures sintéticos y 21 pruebas CSV, incluidos ida/vuelta con 200 registros generados por cada separador, Unicode, datos hostiles, fórmulas y compatibilidad JSON v1/v2. Las fórmulas y SQL quedan como texto literal; únicamente el escritor de informes CSV antepone apóstrofo al representar celdas peligrosas.

## Límites y conservación

8 MiB se mide en bytes UTF-8 y se rechaza antes de decodificar un archivo excesivo; 2000 registros y 256 columnas. No hay autodetección de codificación ni separador. El límite adicional de columnas acota entradas hostiles; se comunica como incidencia, nunca recortando el conjunto sin aviso. Al exceder límites, `complete=false`, hay una incidencia bloqueante y no hay salida importable; el número total no se infiere de una lectura parcial.

Campos iguales al lector JSON: título 500, nombre de autor/editorial 200, 30 autores, 20 editoriales, ISBN 100, fecha editorial 100, estantería 120, hasta 200 estanterías, páginas enteras 0–100000. La salida pasa de nuevo por `createBackupV2` y `parseLibraryImport`, incluido el límite de bytes del payload canónico. Los errores llevan código, campo, ordinal y muestra privada de hasta 120 puntos Unicode; las muestras nunca se registran en telemetría. Las listas se recorren con reserva acotada, evitando crear millones de objetos con separadores repetidos.

Cualquier incidencia deja `library=null` y `payload=null`; las filas y sus incidencias se conservan para revisión. La fase 1 no implementa el modo parcial: la futura elección explícita deberá enumerar omisiones en preview e informe durable. Las filas válidas de un archivo con errores no autorizan escrituras.

## Decisión de parser

Se buscó `csv`, `papaparse`, `csv-parse` y `fast-csv` en `pnpm-lock.yaml`: no existe un parser CSV instalado. No se propone ni incorpora una dependencia nueva, ni se cambia el lockfile. Se utiliza una máquina de estados (`start/plain/quoted/closed`) con pruebas de comillas, saltos, truncamientos y límites; no un parser basado en separar por comas. Trabaja con un archivo completo acotado en memoria. El transporte por trozos y su ensamblado pertenecerán al staging; no se decodifica cada trozo por separado ni se promete streaming de archivos arbitrarios.

## Validación ejecutada

| Comando | Resultado | Evidencia |
| --- | --- | --- |
| `pnpm lint` | Exit 0 | [lint](fase-1-lint.txt) |
| `pnpm typecheck` | Exit 0 | [typecheck](fase-1-typecheck.txt) |
| `pnpm test` | 389/389, incluidas 21 CSV, exit 0 | [unitarias](fase-1-test.txt) |
| `BIBLIB_SKIP_STACK_TESTS=1 pnpm test:scripts` | 249 pasan, 2 requieren stack y se omiten, exit 0 | [scripts](fase-1-test-scripts.txt) |

Sin stack, migraciones, secretos, llamadas externas ni recursos Docker creados o modificados. No hay redes ni volúmenes propios de esta fase que dejar activos. No se ha ejecutado build, smoke o integración en esta fase: no hay interfaz/persistencia CSV conectadas y la aceptación completa sigue pendiente.

## Pendiente de fase 2

Esperar aviso del coordinador y `docs/spec-pendientes/contratos-o13.md`; fusionar `feature/spec-pendientes`, adaptar las claves/hashes al contrato publicado, conectar acciones al staging y al CAS/revisión reutilizados, UI en español, informes y política explícita de duplicados. Integración/Auth/RLS/Storage, invalidación de previews al remapear, retries durables y publicación atómica requieren el contrato y el perfil asignado. Ejecutar todos los checks finales, build y smoke, y completar la evidencia G13 antes de emitir `worker_done`.

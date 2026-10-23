# Observabilidad y alertas de BibLib · U-OPS-01

Estado F0, 23-10-2026: primitivas e instrumentación local. Se escribe una línea JSON por evento en stdout (información) o stderr (`result=error`). **No existen exportador, almacenamiento de logs propio, panel remoto, evaluador de alertas ni notificaciones automáticas.** Las alertas de este documento son propuestas con umbrales iniciales; no están activadas. La verificación del alojamiento y del disparo remoto corresponde a U-QA-04 y al cierre operativo posterior.

## Contrato y privacidad

`lib/observability/events.ts` cierra el catálogo: `auth.failure`, `db.operation`, `import.preview`, `import.commit`, `import.conflict`, `job.started`, `job.retried`, `job.failed`, `provider.request`, `cover.recovery`, `storage.upload`, `storage.delete`, `account.deletion`, `migration.completed`.

Un registro tiene `event`, `level`, `timestamp` UTC y `fields`. Solo se aceptan estos campos de operación:

| Campo | Valor admitido |
| --- | --- |
| `operation`, `result`, `errorCode`, `provider` | Etiquetas técnicas de hasta 80 caracteres; sin espacios, mensajes ni texto libre. |
| `durationMs` | Número finito no negativo. |
| `batch`, `attempt` | Entero no negativo; `batch` es cantidad, nunca contenido ni ID de archivo. |
| `httpStatus` | Entero entre 100 y 599. |
| `correlationId` | Token de 8–64 caracteres alfanuméricos, guion o guion bajo, empezando por alfanumérico. Se rechazan cabeceras múltiples, espacios, saltos de línea y prefijos conocidos de claves. |
| `accountRef` | `acct_` seguido del HMAC-SHA256 hexadecimal completo del ID de cuenta. |

Los campos adicionales se descartan y se cuentan en `logger.droppedFields`; el contador solo vive en memoria y no conserva sus nombres ni valores. También se cuentan valores con tipo/formato inválido. No se registra el objeto original ni una copia de los descartes. El saneado rechaza URLs completas (incluidas DB, userinfo, query y fragmento), JWT, Bearer, pares de credenciales y formatos conocidos de claves; las etiquetas se validan después. Nunca pasar mensajes de errores, `Request`, respuestas, objetos de libros ni parámetros de búsqueda como etiquetas.

Quedan excluidos títulos, autores, ISBN de búsquedas, notas, prestatarios, fotos, contenido o nombres de archivos, cookies, JWT, claves e IDs de usuario en claro. `accountRef(userId)` usa exclusivamente `BIBLIB_TELEMETRY_SALT` de servidor; sin sal o con sal vacía devuelve `undefined` y el campo se omite. La instrumentación F0 no necesita adjuntar cuentas y no las registra. Una sal nueva cambia los seudónimos; no guardar la sal junto a los logs ni publicarla mediante `NEXT_PUBLIC_*`. El seudónimo sigue siendo dato restringido y no se incluye en agregados.

`server.ts` contiene el límite `server-only` para la aplicación, el logger compartido y los adaptadores de Next. Los núcleos Node (`logger`, `correlation`, `pseudonym`) se mantienen comprobables con `node --test`, sin cargar el marcador de React; no deben importarse desde componentes cliente. Los módulos compartidos con el navegador solo importan `events`/`emitter` y reciben un emisor opcional; por defecto no emiten nada.

## Puntos instrumentados en F0

| Punto | Eventos y alcance |
| --- | --- |
| `lib/server-user.ts` | Fallo devuelto, sesión ausente o excepción de Auth: códigos estáticos `AUTH_FAILED`, `AUTH_NO_USER`, `AUTH_UNAVAILABLE`. Conserva el error y resultado anteriores. |
| `lib/library-import.ts` y `app/actions/library.ts` | `import.preview` al validar en el servidor, `import.commit` después de terminar la operación (éxito o fallo), `import.conflict` si el commit arroja `CONFLICT`. Duplicados omitidos al fusionar no son conflictos. |
| `lib/open-library.ts`, `lib/api-client.ts` | `provider.request` por petición real; no se añaden eventos por aciertos de caché ni por consultas que comparten una petición en vuelo. No contiene URL ni ISBN. |
| Enriquecimiento de portadas de `lib/library-import.ts` | `provider.request` por lote con duración, cantidad, estado y clasificación del fallo. Sigue devolviendo fallback ante fallos. |
| `app/actions/cover-recovery.ts`, `lib/cover-recovery.ts` | Duración/resultado de `cover.batch` y cantidades por resultado `cover.outcome` después del commit: `recovered`, `unavailable`, `skipped`. El cursor no se registra. |
| Recuperación individual en `app/actions/books.ts` | Duración y resultado de `cover.refresh`, con su petición de proveedor. |

La revisión visual del JSON vive actualmente en el cliente: no hay endpoint de preview ni envío de telemetría desde el navegador. `import.preview` representa la misma validación cuando se reejecuta en el servidor al confirmar; no mide selección de archivos ni revisiones abandonadas. No se añade un refactor o ruta nueva para cubrirlas.

En las acciones instrumentadas, `withActionCorrelation` lee `x-correlation-id` validada o genera un UUID y mantiene el contexto con `AsyncLocalStorage`. Las anidaciones heredan el contexto salvo ID explícito y las peticiones concurrentes quedan aisladas. `/api/books/search` devuelve el ID en la cabecera de respuesta tanto en éxito como en fallo; sus eventos de Auth y proveedor comparten ese ID. `correlationHeaders` permite propagarlo en una copia de cabeceras. No se añade un ID al resultado de dominio de las Server Actions ni se transmite el seudónimo a Open Library. Una consulta compartida en vuelo se atribuye a la petición que inició la red.

Clasificación: HTTP 429 → `rate_limited`, 404 → `not_found`, 5xx → `upstream_error`, timeout/abort → `timeout`, error de transporte → `network`; JSON/contrato inválido → `upstream_error`. Un timeout al leer un cuerpo 200 conserva `timeout`. Una respuesta válida vacía sigue teniendo resultado de petición `ok`; la ausencia bibliográfica se conserva como `null` en el dominio. La clasificación no cambia respuestas, caché, reintentos ni mensajes al usuario.

`db.operation`, jobs, Storage, eliminación de cuentas y migraciones están reservados en el catálogo, sin instrumentación nueva en F0. Los jobs y proveedores nuevos se instrumentarán al implementarlos en F1; las métricas de conexiones/bloqueos requieren fuentes adicionales. No hay métricas completas de todas las operaciones de base ni instrumentación de callbacks/refresh OAuth fuera de `getRequiredUserId`.

## Métricas propuestas

Derivables de eventos actuales: conteos y p50/p95 de duración por operación/proveedor/resultado, tasa de fallo de peticiones reales por proveedor, conteos de 429/404/5xx/timeout/red, fallos de sesión, fallos/conflictos de importación, proporción de portadas recuperadas entre recuperadas y no disponibles, y descartes de campos por proceso mediante un futuro adaptador. El denominador de latencia/error de proveedor excluye caché y rechazos locales anteriores a la petición; un 404 se cuenta aparte y no se suma a indisponibilidad.

Pendientes de fuente/exportador: conexiones activas y presupuesto del pool, esperas/bloqueos SQL, profundidad y edad de cola, leases vencidos, reintentos por trabajo, cuota restante si el proveedor la expone, cobertura global de portadas, objetos huérfanos y fallos de limpieza de cuentas. La proporción recuperada en un lote no demuestra la cobertura global ni la ausencia definitiva de una portada.

Agregación propuesta solo por entorno, evento, operación, proveedor, resultado y código técnico; nunca por ISBN, cuenta, correlación, ruta ni contenido. La etiqueta de entorno la aportará el colector, no se amplía la lista blanca. Excluir también `accountRef` y `correlationId` de series y alertas para evitar cardinalidad y rastreo privados.

## Alertas propuestas (aún sin activar)

Todas tienen responsable **Néstor**. La clave de deduplicación incluye entorno y el identificador de alerta; añadir proveedor/operación solo donde se indica. Emitir una apertura, actualizar mientras persista y cerrar tras dos ventanas sanas; el intervalo de deduplicación limita recordatorios. Los disparos siguientes se realizan con fixtures sintéticos y un futuro evaluador local, nunca provocando fallos reales en proveedores o cuentas de producción.

| Alerta | Umbral inicial y ventana | Responsable | Acción | Deduplicación | Cómo dispararla en prueba |
| --- | --- | --- | --- | --- | --- |
| Auth degradada | ≥10 `auth.failure` en 5 min. | Néstor | Revisar salud/configuración de Auth y cookies; seguir una correlación sin inspeccionar tokens. | `auth`, 15 min. | Alimentar 10 fallos sintéticos `AUTH_UNAVAILABLE` fechados en 5 min. |
| Proveedor indisponible | >20% `upstream_error`/`timeout`/`network` en 5 min, ≥20 peticiones. | Néstor | Consultar estado del proveedor y mantener fallback/reintento explícito. | `provider-error` + proveedor, 15 min. | Simular 5 respuestas 503 y 15 éxitos; verificar que 404 no incrementa el numerador. |
| Cuota limitada | ≥3 `rate_limited` en 5 min. | Néstor | Reducir concurrencia, respetar límites y revisar futuros reintentos; no etiquetar como inexistencia. | `provider-quota` + proveedor, 15 min. | Simular tres HTTP 429 y contrastar tres 404 sin disparo. |
| Latencia de operación | p95 >8 s en 10 min, ≥20 operaciones con duración. | Néstor | Revisar proveedor/SQL de esa operación; medir antes de cambiar presupuestos. | `latency` + operación/proveedor, 30 min. | Alimentar 20 eventos de 9 s para una operación. |
| Importación fallida | ≥3 commits con `result=error` en 10 min, excluyendo `INVALID_INPUT`, `UNAUTHORIZED`, `CONFLICT`. | Néstor | Revisar transacción y disponibilidad de base sin volcar el archivo. | `import-failure`, 15 min. | Inyectar tres commits `PROVIDER_UNAVAILABLE`. |
| Conflictos frecuentes | ≥5 `import.conflict` en 10 min. | Néstor | Investigar concurrencia; pedir nueva revisión y conservar datos actuales. | `import-conflict`, 30 min. | Inyectar cinco `CONFLICT` mediante el observador de commits. |
| Baja recuperación de portadas | <10% recuperadas entre `recovered+unavailable` en 30 min, ≥50 candidatas evaluadas. | Néstor | Contrastar fallos de proveedor; mantener genéricas y reintentar después. | `cover-recovery`, 60 min. | Alimentar contadores de 1 recuperada y 49 no disponibles; omitir `skipped`. |
| Filtro de privacidad activado | Aumento de `droppedFields` ≥1 en 5 min (fuente pendiente). | Néstor | Corregir el llamador para enviar solo campos técnicos; no conservar el valor rechazado. | `privacy-filter` + operación si está disponible, 60 min. | Emitir un campo `title` sintético y observar solo el aumento del contador. |
| Pool/bloqueos SQL (futura) | Conexiones >80% del presupuesto durante 5 min o bloqueo >5 s en 5 min. | Néstor | Revisar pool por instancias y transacciones, sin registrar SQL/DSN. | `db-pressure`, 15 min. | Fuente simulada con 9 de 10 conexiones o una espera de 6 s. |
| Cola/leases (F1) | Edad más antigua >5 min o ≥1 lease vencido durante 5 min. | Néstor | Revisar ejecutor y recuperación idempotente; no usar logs como estado del trabajo. | `queue-stalled`, 15 min. | Reloj/cola de prueba con job de 6 min y lease expirado. |
| Trabajo agotado (F1) | ≥1 `job.failed` definitivo en 5 min o ≥3 reintentos por trabajo en 10 min. | Néstor | Consultar estado privado del trabajo y causa técnica; reanudar según contrato. | `job-failure` + operación, 15 min; el evaluador necesitará estado privado para el conteo por job. | Fixtures de un fallo terminal o cuatro intentos del mismo job, sin exponer su payload. |
| Storage/limpieza (futura) | ≥3 fallos upload/delete en 10 min, ≥1 cuenta pendiente de limpieza >24 h o ≥10 objetos huérfanos en un barrido diario. | Néstor | Revisar permisos/inventario y reintentar la limpieza; no declarar eliminación completa. | `storage-cleanup` + operación, 60 min. | Simular tres 503, una solicitud de 25 h o un inventario de 10 huérfanos. |
| Migración fallida (futura) | ≥1 finalización con `result=error` en una ejecución. | Néstor | Detener promoción y revisar plan/historial según el runner; no ejecutar SQL inverso. | `migration-failure` + operación, 60 min. | Resultado sintético fallido del futuro adaptador del runner, sin conectar a DB. |

## Retención y acceso propuestos

Logs operativos: **14 días**, acceso restringido a operación autorizada y borrado automático al vencer. Agregados sin cuenta ni correlación: **90 días**. El alojamiento deberá aplicar y verificar estos plazos antes de activar exportación; stdout/stderr por sí solos no configuran ni garantizan retención. Revisar también copias y retención propia del proveedor de alojamiento. No incorporar logs de cuentas reales a Git, capturas públicas, incidencias ni fixtures.

## Verificación y apagado

`pnpm test` compila y ejecuta `tests/observability.test.ts`: prueba lista blanca, saneado, contador de descartes, no-op, aislamiento/anidación, cabeceras, HMAC, salida JSON y un fallo Open Library 429 correlacionado sin ISBN/título. Incluye 404, 5xx, cuerpo 200 con timeout, validación de importación, conflicto y fallback de portadas. Las consultas son simuladas y no requieren red ni base.

Para comprobar el catálogo con la telemetría apagada en PowerShell, establece únicamente la variable no secreta `$env:BIBLIB_TELEMETRY='off'` y ejecuta `pnpm test`. Las pruebas del logger fuerzan su configuración de prueba y la restauran; las pruebas existentes de catálogo siguen con `off`. No cargar archivos de entorno para estas comprobaciones.

`createLogger({ enabled: false })` o `BIBLIB_TELEMETRY=off` convierten la emisión en no-op, sin tocar el sink ni los contadores. La variable manda incluso sobre `enabled:true` y se consulta al emitir para poder desactivar un logger ya creado. Excepciones síncronas de sinks o emisores inyectados se aíslan; los resultados y errores de dominio se conservan. Para recuperar una entrega futura, apagar el exportador/telemetría y mantener el comportamiento de catálogo; nunca reconstruir el estado de jobs desde logs.

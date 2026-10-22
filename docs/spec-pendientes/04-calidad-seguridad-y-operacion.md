# Unidades de calidad, seguridad y operación

Estado: **especificación propuesta; no implementada por este documento**. Fecha de referencia: 22 de octubre de 2026. Los comandos nuevos son contratos a construir. No suponen que exista ya un servicio de monitorización, una copia administrativa ni un despliegue de pruebas.

La asignación de fases, olas y dependencias canónicas está en [el plan de ejecución](05-fases-olas-y-trazabilidad.md). Este documento completa los pendientes de QA-01/02, OPS-01/02 y las verificaciones de SEC/BE/FE que requieren servicios reales.

## Límites y criterios compartidos

1. Mantener las 50 pruebas unitarias y los recorridos existentes como referencia, sin convertir su número en objetivo de cobertura. Añadir pruebas por comportamiento y riesgo.
2. Conservar `test:db` y `test:smoke` rápidos mientras aporten diagnóstico. Diferenciar sus sustitutos de Auth de una ejecución contra GoTrue y Storage reales en el stack local.
3. Las pruebas privadas crean usuarios ficticios A y B y un contexto anónimo. No utilizan fotografías, catálogos, tokens o copias personales del desarrollador.
4. Toda tabla privada nueva tiene propietario, RLS, índices de propietario y FK que impiden enlazar recursos de otra cuenta. Los workers administrativos no convierten una entrada del navegador en un `user_id` de confianza.
5. Las nuevas herramientas de QA se fijan en lockfile. Instalar Playwright o un analizador de accesibilidad exige una utilidad concreta; no añadir otra plataforma si basta con la existente.
6. Ejecutar comprobaciones apropiadas a cada cambio. Las suites completas corresponden al cierre de una ola, CI o una integración de riesgo; no repetirlas después de cada edición documental o ajuste de texto.
7. Una prueba automatizada aprobada no certifica accesibilidad integral, seguridad del alojamiento ni recuperación operativa.

## U-QA-01 · Integración con Supabase local real

**Objetivo y prioridad:** P1, verificar identidad, cookies y permisos con los servicios que se usarán en el despliegue. Esfuerzo M.

**Entrada:** U-INF-01, U-INF-04 y U-INF-05. Auth, Postgres, Storage y correo local deben estar sanos. No exige una cuenta ni credenciales de producción.

**Entregables y archivos propuestos:** `tests/integration/auth/`, `tests/integration/rls/`, `tests/integration/storage/`, utilidades de fixtures y limpieza; comando `pnpm test:integration:local`. El runner recibe el manifiesto de su stack, comprueba su propiedad y obtiene sesiones a través de GoTrue. Las credenciales administrativas locales solo están en el proceso de preparación, nunca en el bundle de Next.

**Trabajo por pasos:**

1. Crear A y B por API administrativa local; iniciar sesión por un mecanismo de prueba admitido por GoTrue. Registrar los IDs del fixture en un manifiesto local privado.
2. Verificar `getUser`, renovación, cierre de sesión, cookies SSR y redirección de vuelta a una ruta con consulta. Probar cookies partidas cuando el SDK las produzca.
3. Ejecutar las acciones de dominio como A/B. Comprobar ausencia de claims residuales al reutilizar la conexión Postgres y al fallar una transacción.
4. Intentar lectura, actualización, borrado y relaciones cruzadas mediante las vías que estén habilitadas. Si `biblib` no se expone por Data API, exigir rechazo; probar además RLS con rol autenticado directamente en SQL.
5. Comprobar el bucket de fixtures privado, rechazo de lectura anónima y lectura con firma emitida por el proceso de prueba. Esto verifica Storage real, no las políticas definitivas por cuenta. Las pruebas A/B de adjuntos, firma por propietario, reemplazo y limpieza se añaden al integrar U-DAT-10 y vuelven a ejecutarse con esta suite.
6. Limpiar únicamente los usuarios y objetos creados por ese run. Conservar evidencia mínima si una limpieza falla, sin volcar sesiones.

**Aceptación verificable:** A no puede acceder a los recursos de B manipulando IDs o rutas; anónimo no obtiene datos; una renovación válida mantiene el destino y una revocada vuelve al acceso; cerrar sesión elimina la vista privada; Storage de fixtures rechaza lectura anónima y se prueba su acceso firmado; la autorización por propietario de assets se acepta con U-DAT-10 y se incorpora después a esta suite; el fallback de portada funciona sin red; no se crean usuarios reales. Un fallo deja código de salida distinto de cero y reporta el escenario, no un token.

**Pruebas:** fixture idempotente, caída de Auth/Storage, cierre y renovación concurrentes, sesión caducada y conexión reutilizada A→B→sin claims. Añadir pruebas del trigger de versión y de las nuevas tablas al introducir cada unidad de datos.

**Decisión técnica:** usar el SDK contra servicios reales para identidad/Storage; las aserciones estructurales SQL pueden seguir usando el runner actual o pgTAP. Supabase documenta ambas vías de prueba; pgTAP no sustituye las pruebas HTTP de cookies. [Referencia oficial](https://supabase.com/docs/guides/database/testing).

**Salida y recuperación:** suite repetible sin intervención, reporte de capacidades realmente probadas y limpieza de recursos propios. Si se desactiva temporalmente una prueba, exige incidencia, responsable y caducidad; no se marca como superada.

## U-QA-02 · E2E, fallos de red y compatibilidad de navegador

**Objetivo y prioridad:** P1, ampliar el smoke existente sin depender de Google u Open Library para cada ejecución. Esfuerzo L.

**Entrada:** U-QA-01. Cada función nueva incorpora sus propios escenarios antes de considerarse terminada. La revisión visual y de lector corresponde también a U-EXP-03.

**Entregables:** `tests/e2e/`, fixtures del proveedor, informe y capturas de datos ficticios; scripts `test:e2e:local`, `test:e2e:local:ui` y `test:e2e:external`. El último es una comprobación opcional y explícita con servicios externos, separada de CI de PR.

**Cobertura mínima:**

| Grupo | Comportamiento verificable |
| --- | --- |
| Acceso | Ruta privada directa, destino interno conservado, callback inválido, renovación, cierre y cambio de cuenta. |
| Catálogo | Alta manual/ISBN, dos copias cuando el nuevo modelo lo permita, revisión, edición y conflicto con borrador conservado. |
| Organización | Predeterminada protegida, movimiento individual/lote, recurso borrado por otra pestaña y selección tras error. |
| Consulta | Tildes, ISBN-10/13, filtros URL, atrás/adelante, cero resultados y página posterior que deja de existir. |
| Importación | Preview sin escrituras, colección modificada tras preview, fusión, reemplazo, fallo de publicación y deshacer con conflictos. |
| Trabajos | Cerrar/reabrir navegador, worker interrumpido, lease vencido, pausa, cancelación y reintento idempotente. |
| Copias | Archivo v1, formato nuevo, partes fuera de orden, parte repetida/ausente/alterada y restauración sin pérdida de IDs definidos. |
| Proveedores | Un proveedor vacío, otro disponible; 429/timeout/5xx; edición discrepante; clave ausente; presupuesto global agotado. |
| Privacidad | Datos de A invisibles al entrar como B, objetos privados, borrado de cuenta y copia offline bloqueada. |
| Producto | Notas, lectura, préstamos, ubicación, serie y etiquetas se incorporan al terminar sus unidades. |

**Plataformas:** Chromium para PR; Firefox y WebKit en el cierre de ola y en ejecución programada. Playwright dispone de proyectos de navegador para esa matriz; WebKit automatizado no equivale a una prueba real de Safari/iOS. [Referencia oficial](https://playwright.dev/docs/browsers).

**Aceptación:** no excepciones JS ni hidratación en los recorridos; fallo de red conserva formularios y selección cuando sean recuperables; no éxito antes de persistencia; sin tráfico externo en modo fixture; capturas sin datos personales; los fallos son reproducibles por nombre de escenario. Los reintentos no convierten pruebas inestables en verdes silenciosos: se registra toda repetición.

**Recuperación:** conservar el smoke actual hasta que la nueva suite pruebe lo mismo; migrarlo por escenarios, sin retirar cobertura durante la transición. El runner detiene solo procesos/stack propios y nunca libera puertos matando procesos ajenos.

## U-QA-03 · Rendimiento y capacidad medidos

**Objetivo y prioridad:** P2, decidir índices, paginación y límites de trabajo con datos. Esfuerzo M; BE-01/02/03/04 y FE-02.

**Entrada:** stack local reproducible y fixtures de escala. Una primera medición precede a U-DAT-04; se repite al cambiar el modelo de ejemplares y al cerrar producto.

**Entregables:** `scripts/performance/`, datasets sintéticos deterministas de 100, 1000 y 10000 ejemplares, manifiesto de hardware/CPU/RAM asignados a Docker/versiones, `docs/validacion/rendimiento/` y consultas `EXPLAIN (ANALYZE, BUFFERS)` sin contenido privado.

**Escenarios:** dashboard, listado inicial/filtrado/ordenado, detalle, búsqueda local, estanterías, página 3D, exportación por partes, preview, publicación de staging y dos workers de portadas. Medir frío/caliente, 1/5/10 sesiones y dos procesos de aplicación cuando se compruebe la cuota distribuida. No saturar proveedores públicos: todos los ensayos de volumen usan fixtures.

**Objetivos iniciales de diseño, pendientes de medir:**

| Medida | Presupuesto propuesto |
| --- | --- |
| Consulta paginada y resumen, 10000 ejemplares, caliente, 1 sesión | p95 SQL ≤500 ms; ≤100 filas en una página de colección. |
| Acción de listado, incluida autorización local | p95 ≤1000 ms; registrar por separado Auth y DB. |
| Publicación atómica de staging | Bloqueo de la colección ≤5 s; ningún acceso a red dentro de la transacción. |
| Paso de worker | Trabajo acotado y lease renovable; no reservar una conexión mientras espera una cuota externa. |
| UI de tabla/3D | No renderizar los 10000 registros; 3D ≤48 por página; la impresión pagina su propia lectura. |
| Interacción cliente | Registrar LCP, INP y CLS por pantalla; objetivos iniciales 2,5 s / 200 ms / 0,1 en el perfil de medición acordado. |

Estos son criterios propuestos de BibLib, no resultados observados ni un SLA. La ola de infraestructura fija un perfil reproducible y registra ajustes justificados antes de usar los umbrales como puerta de entrega. No reducir calidad de datos ni dividir una publicación atómica para ocultar un tiempo excesivo.

**Aceptación:** resultados antes/después, ausencia de consultas sin límite en navegación ordinaria, conexiones dentro del presupuesto del pool, aislamiento de cuentas bajo carga y explicación de cada índice añadido. Un presupuesto incumplido abre una tarea concreta; no se solventa aumentando indefinidamente memoria o timeout.

**Recuperación:** cambios de índice aditivos y plan de retirada medido. Mantener el índice anterior durante la transición cuando sea necesario; consultas anteriores compatibles hasta terminar la ola.

## U-QA-04 · CI y artefactos identificados por destino

**Objetivo y prioridad:** P1, que la instalación, base y aplicación probadas correspondan al commit, migraciones y configuración de lo que se publica. Esfuerzo M.

**Entregables:** ampliar `.github/workflows/ci.yml`; workflows separados para validación y promoción; versión fijada del CLI; caché de imágenes/herramientas; artefactos de planes, checksums y pruebas; documentación `docs/operacion/entornos.md`.

**Reglas de ejecución:**

1. PR: frozen lockfile, lint, tipos, unitarias y build; stack Supabase aislado para migraciones, integración y Chromium. Sin secretos de producción.
2. Programado/cierre de ola: navegadores adicionales, accesibilidad automática, upgrade desde el esquema anterior, escala y reconstrucción desde cero.
3. Preproducción: commit y hash de migraciones fijados; build inmutable específico del proyecto con su huella pública; plan contra el destino permitido; respaldo/restauración ensayados; aplicar expansión, desplegar aplicación compatible, comprobar y aceptar ese artefacto para ese destino.
4. Producción: job independiente y entorno protegido; el comando de aplicación exige destino y hash del plan revisado. La autorización puede proceder del mecanismo de release acordado; no inventar una nueva secuencia de preguntas si ya existe autorización para ese release. Se construye un artefacto de producción desde el mismo commit y lockfile, con los valores públicos de ese proyecto, y se verifica su huella antes de publicarlo. No se reutiliza el binario de preproducción cambiando variables en runtime: `NEXT_PUBLIC_*` queda incorporado al build. Solo se promociona el mismo binario entre réplicas o etapas que compartan exactamente el objetivo público.
5. No ejecutar migraciones desde `build`, instalación, arranque de cada réplica o PR. No compartir estado `.temp` del CLI ni conexiones entre jobs locales y remotos.

**Contratos:** plan identificado por hash y commit, autorizado mediante el proceso de release; reporte de migración con estado anterior/posterior y sin secretos; estado de la puerta de cada ola; código de salida no cero si el hash, destino o historial no coincide. No utilizar un «dry run» que ejecute y luego intente deshacer DDL como sustituto de una planificación real.

**Aceptación:** pipeline bloquea error de tipo, migración alterada, referencia entre usuarios y E2E fallido; el job de PR no puede alcanzar producción; cancelar una ejecución limpia recursos propios; un release identifica exactamente el artefacto y migraciones desplegados. CI remoto debe ejecutarse de verdad para cerrar esta unidad.

**Dependencias:** U-INF-03/04 para validación; U-INF-07 y U-OPS-02 para promoción remota. La parte de PR se entrega primero y no espera a toda la ampliación de producto.

**Recuperación:** detener promoción si falla una puerta; mantener versión anterior de aplicación compatible con esquema expandido. Si hubo escrituras nuevas, elegir corrección hacia delante o restauración ensayada con su pérdida de datos evaluada; no aplicar SQL inverso improvisado.

## U-QA-05 · Cierre verificable de la auditoría

**Objetivo y prioridad:** P2, cerrar por evidencia y evitar que «implementado» signifique «desplegado y probado». Esfuerzo S por cierre de fase.

**Entregables:** matriz de los 35 hallazgos, cada uno con estado `implementado-local`, `verificado-preproduccion`, `verificado-produccion`, `pendiente` o `diferido-con-decision`; enlace a unidad y evidencia/fecha/commit. Mantener la auditoría original como documento histórico.

**Trabajo:** comparar criterios originales y código final; repetir únicamente las verificaciones relevantes; comprobar contratos, instrucciones y scripts desde una instalación limpia; registrar condiciones externas pendientes y decisiones expresas de alcance. Las ampliaciones de producto tienen aceptación propia y no deben presentarse como vulnerabilidades de seguridad.

**Aceptación:** todos los hallazgos tienen dueño y estado explicable; ninguna casilla remota se cierra con un mock local; la decisión 3D queda como alcance documentado; no quedan enlaces rotos a evidencia; se puede reproducir una instalación y una restauración siguiendo documentos. El cierre total exige que las unidades incluidas estén aceptadas y que lo diferido tenga motivo visible.

**Recuperación:** reabrir un hallazgo si la evidencia queda invalidada por un cambio. No borrar pruebas o el historial para presentar una auditoría como cerrada.

## U-OPS-01 · Diagnóstico, métricas y alertas sin contenido bibliográfico

**Objetivo y prioridad:** P2, localizar fallos de Auth, base, importación y proveedores. Esfuerzo M.

**Entregables:** `lib/observability/`, adaptador de logging, IDs de correlación, panel operativo y documento de alertas. Elegir salida estructurada estándar antes de añadir un servicio de pago; un adaptador permite conectar el alojamiento existente.

**Eventos mínimos:** `auth.failure`, `db.operation`, `import.preview/commit/conflict`, `job.started/retried/failed`, `provider.request`, `cover.recovery`, `storage.upload/delete`, `account.deletion` y `migration.completed`. Campos permitidos: operación, duración, resultado, código de error, proveedor, lote, intento y correlación. ID de cuenta solo seudonimizado cuando sea necesario para diagnóstico autorizado.

**Datos excluidos:** título, autores, ISBN de búsquedas privadas, notas, prestatarios, fotos, contenido de archivos, JWT, cookies, claves, URL de DB o querystring con credenciales. La agregación del proveedor no publica la lista de búsquedas de una cuenta.

**Métricas y respuesta:** latencia/error por acción, conexiones, bloqueos, profundidad/edad de cola, leases vencidos, cuotas, cobertura de portadas, objetos huérfanos y fallos de limpieza. Cada alerta define umbral inicial, ventana, responsable, acción, deduplicación y prueba de disparo; no prometer que una alerta existe solo por tener un `console.error`.

**Aceptación:** error inducido en local se correlaciona de UI a operación sin filtrar datos; un 429 se distingue de un 404 y de 5xx; telemetría deshabilitada no afecta al catálogo; herramientas de producción verificadas con un fallo de prueba controlado. Retención inicial propuesta: 14 días para logs operativos, agregados de 90 días sin datos de cuenta; ajustar al alojamiento y documentar.

**Dependencias:** las primitivas se diseñan en F0/F1; instrumentar jobs/proveedores al implementarlos. Cierre remoto junto a U-QA-04. Recuperación: apagar exportador y conservar comportamiento de dominio; no usar telemetría como fuente del estado de trabajos.

## U-OPS-02 · Respaldo administrativo y restauración ensayada

**Objetivo y prioridad:** P1 para migración remota; P2 para automatización periódica. Esfuerzo L.

**Tres productos distintos:** exportación JSON de una cuenta; respaldo administrativo de esquema/datos/historial; copia de objetos de Storage. Un JSON de catálogo no contiene Auth ni bytes de imágenes. Los backups de base de Supabase no incluyen los archivos guardados por Storage; planificar su copia y restauración separadas. [Referencia oficial](https://supabase.com/docs/guides/platform/backups).

**Entregables:** scripts propuestos `db:backup:local`, `db:backup:prod`, `db:restore:local`, `db:restore:verify`; procedimiento de recuperación remota; manifiesto de versión, fecha, commit, hash de migraciones, hashes de archivos y alcance; inventario de buckets/objetos y política de conservación. Los scripts no imprimirán credenciales ni copiarán secretos de OAuth al repo.

**Procedimiento detallado:**

1. Identificar origen/destino y capacidad real del plan del proveedor; no presuponer PITR ni descarga de un tipo de backup no contratado.
2. Obtener una copia coherente de los esquemas propios y del historial. Para Auth y esquemas gestionados, usar un procedimiento soportado por el proveedor, no recrear arbitrariamente sus tablas.
3. Capturar manifiesto de objetos por versión/hash y separar credenciales/configuración externa. Evitar respaldos DB/objetos de momentos incompatibles mediante ventana o marcas verificables.
4. Cifrar el respaldo, guardarlo fuera del repo y del directorio publicado; las claves de recuperación se administran fuera de ese mismo archivo.
5. Restaurar en un proyecto o stack aislado compatible, sin enviar correo ni llamar proveedores externos; no apuntar un restore a un stack de otro proyecto por ser `localhost`.
6. Validar tablas, índices, FK, RLS, grants, funciones y trigger de versión; probar acceso de A/B, cantidades, objetos y una muestra de fichas.
7. Aplicar las supresiones de cuentas posteriores al backup antes de abrir el entorno restaurado a usuarios. Registrar qué cambios posteriores se perderían. Además, invalidar previews/idempotencias de operaciones no publicadas y leases restaurados, rotar revisiones de colección y tokens de ficha/edición/copia antes de abrir tráfico, y decidir explícitamente qué jobs pueden reanudarse. Un restore físico o un dump puede conservar tokens antiguos; no se supone que haya ejecutado los triggers. Probar que una pestaña y un worker anteriores al respaldo no consiguen escribir con esas versiones.
8. Emitir reporte de recuperación con duración y discrepancias. Solo una restauración terminada valida la copia.

**Objetivos propuestos:** RPO inicial de 24 h y RTO de 4 h para la colección, sujetos al plan y al ensayo. Conservar 7 copias diarias y 4 semanales como punto de partida; retención definitiva y capacidad se registran antes de activar automatización. Un backup previo a migración se conserva hasta aceptar esa versión y su recuperación.

**Aceptación:** una copia de prueba restaura metadatos y objetos, aislamiento de dos cuentas y versiones nuevas tras su rotación explícita; falta de una imagen o de una clave de recuperación se detecta y falla el ensayo; ningún secreto entra en Git; existe un responsable de recuperar el servicio. La copia mínima ensayada es dependencia de U-INF-07, sin esperar a terminar el resto del producto.

**Recuperación:** el propio procedimiento debe poder reintentarse sobre un destino vacío nuevo; nunca «limpiar» el proyecto de origen para solucionar un restore fallido. No ofrecer `truncate:prod` o `seed:prod` de demo como comandos ordinarios de BibLib.

## U-OPS-03 · Eliminación de cuenta y retención de datos

**Objetivo y prioridad:** P2, un flujo operativo de privacidad que abarque base, Storage, trabajos y copias. Esfuerzo L.

**Entrada:** identidad real local, jobs persistentes, inventario de tablas y objetos y política de respaldo. El diseño se fija antes de crear nuevas funciones privadas; el ensayo final incluye todos sus datos.

**Flujo propuesto:**

1. Página de cuenta muestra alcance y opción de exportar; la eliminación exige sesión reciente y confirmación explícita. Se confirma sobre la cuenta autenticada, nunca sobre un `userId` enviado como autoridad por el cliente.
2. Crear una solicitud idempotente, marcar la cuenta en eliminación e impedir nuevas escrituras/trabajos; volver a solicitar devuelve el mismo estado.
3. Revocar sesiones mediante el mecanismo de Auth soportado; las acciones de dominio comprueban el estado bloqueado mientras un JWT previamente emitido aún pueda existir. Las políticas de escritura de tablas y Storage también deben exigir cuenta activa, mediante una comprobación protegida que el cliente no pueda reactivar. Un control solo en UI o en el worker no satisface este requisito. Las funciones administrativas de limpieza tienen permisos mínimos y no se exponen como una alternativa de escritura al navegador.
4. Worker elimina objetos y datos asociados por pasos reintentables: avatares, fotos, portadas privadas, notas, préstamos, jobs, snapshots, staging y ajustes. Las FK no pueden borrar datos de otra cuenta.
5. Eliminar identidad Auth al finalizar la limpieza que la necesite. No afirmar finalización si Storage sigue pendiente; error visible y reintentable desde operación.
6. Mantener únicamente una marca técnica mínima de supresión y estado operativo durante el plazo definido, protegida del acceso del usuario eliminado y sin contenido bibliográfico. Esa marca permite filtrar cuentas suprimidas al restaurar un backup anterior.
7. Explicar la conservación temporal de copias y su expiración; la eliminación no equivale a borrar instantáneamente cada copia administrativa histórica. La política debe resolver esta diferencia antes de ofrecer el flujo.

**Contratos propuestos:** `requestAccountDeletionAction({ confirmation, operationKey })`, consulta de estado y worker. Nueva tabla privada de solicitudes/estado, con acceso administrativo mínimo; no exponer errores de limpieza ni rutas de otros usuarios.

**Aceptación:** A solo solicita la propia eliminación; doble clic es idempotente; worker interrumpido continúa sin recrear datos; se comprueba ausencia de recursos y bloqueo de JWT antiguo; una restauración no resucita silenciosamente la cuenta; B permanece intacto. La copia offline se bloquea o purga al reconectar y se informa del límite de revocación sin red.

**Pruebas:** éxito, sesión antigua, Storage caído, job en vuelo, referencia en préstamo, cuenta con varios ejemplares y reintento. En local usar usuarios y objetos desechables. Despliegue gradual solo tras ensayo completo; recuperación consiste en reintentar limpieza, no prometer «deshacer» una supresión ya ejecutada.

## U-OPS-04 · Sesión, exposición de datos y cabeceras en el alojamiento

**Objetivo y prioridad:** P1 para validar el acceso real; P2 para endurecimiento adicional. Esfuerzo M.

**Entregables:** inventario de rutas públicas/privadas, schemas expuestos por Data API, roles/grants y matriz de caché/cabeceras. Configuración coherente entre `next.config.mjs`, proveedor de alojamiento, Supabase local/preproducción/producción.

**Trabajo:**

- Mantener `biblib` fuera de Data API si ningún consumidor lo necesita; acceso de dominio mediante acciones. Si se habilita una vía, declararla y probar sus permisos; no añadir `biblib` a `api.schemas` para facilitar un test.
- Probar cookies SSR en HTTPS, refresh, cierre, callbacks permitidos y fallo de Google real con cuenta de prueba. Comprobar que cookies, HTML autenticado y acciones no quedan en caché compartida del CDN ni del service worker.
- Revisar CSP mediante modo de reporte antes de enforcement, con nonces/estilo requeridos por Next y hosts concretos de imágenes/proveedores. No bloquear autenticación, imágenes o carga de scripts por implantar una lista genérica.
- La cámara sigue prohibida globalmente salvo las rutas donde U-EXP-05 la habilite para `self`; micrófono y geolocalización continúan innecesarios. CSP/Permissions-Policy se comprueban en HTTP real.
- Mantener secretos administrativos solo servidor y procesos de migración/worker; impedir empaquetado o exposición por variables públicas. Revisar URL de retorno, validación de entrada y límites tras introducir nuevos endpoints.
- En local, fixture de proveedor y acceso de desarrollo solo con stack propio y entorno local explícito. Un hostname o `NODE_ENV=development` por sí solos no autorizan un bypass.

**Aceptación:** acceso/refresh/logout real probado; sin datos de A en respuestas de B ni en caché compartida; schema no expuesto accidentalmente; cabeceras efectivas coinciden con el inventario; CSP no produce roturas no explicadas; escáner funciona solo donde se habilita. No se presenta como un pentest exhaustivo.

**Dependencias:** infraestructura para pruebas; U-BIB para hosts; U-EXP-05 para cámara; U-EXP-08 para offline. La prueba inicial de sesión puede entregarse antes de esas funciones, y se repite solo el área afectada al integrarlas.

**Recuperación:** CSP vuelve a reporte ante incompatibilidad; retirar una capacidad opcional no cambia la autorización de datos. No desactivar RLS, protección de rutas o validación de callback para resolver una incidencia.

## U-OPS-05 · Mantenimiento y retirada del prototipo restante

**Objetivo y prioridad:** P3 para limpieza, P1 para responder a un aviso que afecte al despliegue. Esfuerzo S por revisión.

**Entregables:** política de actualización y lockfile, revisión de componentes opcionales y rutas de Auth, inventario de dependencias y scripts, guía de contribución actualizada y selección de archivos privados para Git.

**Trabajo:** retirar o redirigir `signup`/`forgot-password` si el acceso publicado sigue siendo Google; eliminar métodos de Auth deshabilitados cuando no tengan consumidores; revisar `public/data.json` y envoltorios no usados sin confundirlos con fixtures de prueba. No retirar componentes solo por no aparecer en una ruta si tienen consumidores indirectos.

**Actualizaciones:** propuestas periódicas fijadas, revisión de advisories oficiales, instalación congelada y verificación del área afectada. Mantener decisiones de scripts de instalación de pnpm y documentar peers opcionales pendientes. No introducir versiones `latest` como estado permanente.

**Archivos personales:** decidir explícitamente qué `imports/`, fotos y resultados deben quedar locales; reglas de ignorado específicas y revisión de staging. No borrar, mover ni publicar las fotos del usuario como parte de una limpieza técnica.

**Aceptación:** no enlaces a funciones de acceso inexistentes, ninguna dependencia retirada rompe build/imports, scripts nuevos descritos y sin comandos remotos ambiguos, fotos fuera de una publicación accidental y ningún secreto en evidencias. Una actualización se valida en preproducción antes de atribuirle efecto al despliegue real.

**Recuperación:** revertir la actualización o retirada concreta con lockfile consistente; no modificar el historial de migraciones ya aplicado para recuperar una dependencia.

## Evidencia que exige una entrega

Cada ola adjunta: commit/hashes, comandos y entorno usados, datos ficticios/volumen, resultado, limitaciones, migraciones aplicadas, compatibilidad anterior y procedimiento de recuperación. Capturas y reportes se guardan bajo `docs/validacion/<fecha>/<ola>/`; artefactos con datos personales permanecen privados y se enlazan solo desde un registro restringido.

Fuentes técnicas externas consultadas el 22 de octubre de 2026. Las especificaciones y presupuestos de BibLib son decisiones propuestas de este plan; no se atribuyen como garantías del proveedor.

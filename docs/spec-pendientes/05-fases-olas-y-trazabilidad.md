# Fases, olas, dependencias y cierre de la auditoría

Estado: **plan propuesto**. La numeración determina orden lógico, no calendario. El inventario canónico está en [unidades.json](unidades.json); cada unidad enlaza su contrato detallado. Las referencias a una fase o integración futura no añaden dependencias implícitas por encima del registro.

## Planificación y propiedad

Hay 45 unidades. O00 prepara la ejecución; O01–O16 entregan unidades. Se permiten hasta tres carriles de trabajo más coordinación en la capacidad actual, dentro del máximo de cinco solicitado. Una ola con seis o siete unidades no implica seis o siete agentes: cada carril procesa varias entregas secuenciales y el coordinador integra las dependencias.

**Carril D — Datos e infraestructura:** configuración Supabase, schema, journal/snapshots, runner, RLS, publicador y backfill. Tiene un único propietario de migraciones en cada integración.

**Carril S — Servicios:** acciones, jobs, adaptadores, cuotas y contratos. Integra un contrato antes de que UI lo consuma; no crea una segunda conexión o un segundo gateway por comodidad.

**Carril E — Experiencia y evidencia:** formularios, navegación, pruebas, escenarios y documentación. Usa fixtures del contrato; una integración se cierra contra servicios reales cuando corresponda.

El trabajo se puede iniciar antes en forma de diseño o fixtures, pero una unidad solo se acepta cuando sus dependencias obligatorias están disponibles. Revisar colisiones en `package.json`, lockfile, schema, migraciones, tipos, Settings y BookForm. Las pruebas concurrentes usan perfiles de stack separados o escenarios coordinados; nunca resetean el stack manual del desarrollador.

### Cadencia de una ola

1. **Preparar:** comprobar dependencias, estado real, decisión de datos y propiedad de archivos; generar el plan de migración cuando aplique.
2. **Construir:** cambios pequeños revisables; contratos y primitivas antes de consumidores; controles de permisos antes de habilitar escritura.
3. **Integrar:** migrar un stack aislado desde vacío y desde la versión anterior; ejecutar pruebas del riesgo cambiado y el recorrido conjunto.
4. **Revisar:** aceptación funcional, errores/concurrencia, accesibilidad, compatibilidad, retención/eliminación y capacidad.
5. **Registrar:** evidencia, limitaciones, hash/commit, estado por entorno y procedimiento de recuperación. Una incidencia bloqueante mantiene la puerta abierta.

La documentación no obliga a una pregunta humana en cada paso reversible. Las operaciones remotas se ejecutan con la autorización de release y el mecanismo de destino/plan acordados; redactar este plan no equivale a ejecutar esas operaciones.

## F0 · Base local reproducible

### O00 · Inventario, decisiones y contratos de arranque

**Objetivo:** comenzar sin modificar ni interpretar por intuición el entorno privado existente.

**Trabajo concreto:**

- Registrar commit/estado de trabajo de partida, archivos personales sin seguimiento y versión del esquema esperado. No añadir fotos/imports a Git ni leer secretos para completar un inventario.
- Confirmar Docker y recursos, bloque de puertos propio, sistema Windows/Linux y coexistencia con HolaERP. La comprobación es de diagnóstico; no parar otros servicios.
- Elegir y fijar una versión estable exacta de Supabase CLI compatible con la plantilla/flags usados. La referencia observada es 2.117.0; justificar una versión distinta y actualizar la ficha de decisiones.
- Aprobar técnicamente un único historial Drizzle y los contratos `TargetFingerprint`, plan de migración, manifiesto de fixtures y códigos de salida.
- Crear fixtures sintéticos iniciales de dos cuentas, estados, ediciones ambiguas y 111 fichas legacy; no versionar el catálogo real.
- Identificar responsable de preproducción/producción, worker y respaldo. Si aún no hay destino remoto, registrar «no configurado»; no sustituirlo por una URL inventada.
- Registrar disponibilidad de Google Books como condición opcional; las fuentes OL+BNE y el modo fixture no dependen de esa decisión externa.

**Salida:** ficha de decisiones y contratos revisables, matriz de variables sin valores secretos y backlog asignado. **No cierra ninguna unidad de implementación.**

**Recuperación:** ninguna operación destructiva; conservar el inventario privado fuera de los artefactos públicos cuando incluya identificadores sensibles.

### O01 · Servicios y mantenimiento independiente

**Unidades:** U-INF-01, U-OPS-05.

**Carriles:** D define configuración/CLI/red/puertos; E revisa prototipo y dependencias sin tocar la configuración de D. S puede preparar fixtures y contratos, sin marcarlos terminados.

**Entregables:** Supabase propio declarativo, lockfile fijado, inventario de recursos y limpieza revisada de rutas/componentes realmente sin uso.

**Puerta G01:** el perfil no contiene SQL de negocio duplicado; se comprueba que no reutiliza recursos de HolaERP. Toda retirada tiene búsqueda de consumidores y comprobación apropiada. El arranque del stack se ensaya al disponer del wrapper de O03.

**Recuperación:** desactivar el nuevo perfil; revertir una retirada puntual. No eliminar el historial o los datos locales para corregir una configuración.

### O02 · Selección de objetivo y builds

**Unidad:** U-INF-02.

**Secuencia:** contexto `local/test/preprod/prod` → carga de variables controlada → huella pública/servidor → wrappers de Next/generación. La configuración existente se preserva antes de preparar su transición.

**Puerta G02:** un shell con variables remotas heredadas no consigue que un comando local conecte al remoto. Dos builds de objetivos distintos se identifican y no son intercambiables. No se publica ninguna credencial administrativa en JavaScript.

**Recuperación:** conservar artefacto y configuración correspondientes a cada destino; no «reparar» un build local inyectándole credenciales de producción al arrancar.

### O03 · Ciclo de vida y diagnóstico

**Unidades:** U-INF-03, U-OPS-01.

**Carriles:** D implementa lifecycle/status/doctor; S introduce contratos de observabilidad sin payload privado. E prepara escenarios de puerto ocupado, fallo de salud y limpieza de recursos propios.

**Puerta G03:** up/down/status respetan propiedad y preservan volúmenes; se muestran diagnósticos sin claves; un fallo se puede seguir por correlación. No se reclama todavía bootstrap completo antes de migrador/seed.

**Recuperación:** parar exclusivamente recursos creados por el run; apagar exportador de telemetría sin alterar el dominio.

### O04 · Un aplicador de migraciones

**Unidad:** U-INF-04.

**Secuencia:** estado/ledger → manifest de SQL y objetos manuales → plan de solo lectura → runner protegido → verificación posterior. Generar SQL no abre conexiones remotas.

**Puerta G04:** en una base Supabase local vacía se aplica la cadena canónica una sola vez; repetir no altera datos ni ledger; detectar SQL cambiado, historial desconocido y falta de trigger. Las pruebas incluyen los hashes/saltos de línea legacy previstos; no se modifica un SQL aplicado para hacer coincidir el hash.

**Recuperación:** detener aplicación ante divergencia; presentar diagnóstico/adopción revisable. No usar un nuevo squash o un segundo ledger para ocultarla.

### O05 · Usuarios y archivos de prueba reales

**Unidad:** U-INF-05.

**Entregables:** A/B creados por API local de Auth, sesiones reales, archivos privados, correo local y catálogos fixture. Proporcionar la receta de acceso manual local para desarrollar, sin usuario impuesto por una query o cabecera.

**Puerta G05:** repetir seed no borra libros manuales del desarrollador ni duplica fixtures; GoTrue emite/valida tokens; Storage de fixtures es privado, rechaza lectura anónima y permite lectura con firma de prueba. Las políticas definitivas de assets por cuenta se entregan en U-DAT-10; F0 no se atribuye esa cobertura. Funciona con proveedores externos bloqueados.

**Recuperación:** limpieza por manifiesto de fixtures; credenciales locales fuera del repo; no borrar todas las cuentas de Auth como atajo.

### O06 · Reconstrucción y primera integración completa

**Unidades:** U-INF-06, U-QA-01.

**Carriles:** D integra bootstrap/reset; E ejecuta integración GoTrue/Postgres/Storage; S verifica que rutas/actions usan los mismos contratos del producto y no un bypass de pruebas.

**Puerta G06 — salida F0:** clon/configuración limpia → bootstrap → migraciones → seed → acceso local → CRUD/aislamiento. Reset solo acepta stack propio, plan e identidad; negaciones a remoto/HolaERP se prueban sin destruirlos. Ningún test necesita `.env` real. El informe distingue esta suite de los smokes con Auth simulado.

**Recuperación:** reconstruir únicamente el perfil efímero; si falla la prueba, conservar evidencia y no inferir que la base manual debe vaciarse.

## F1 · Integridad, proveedores y recuperación

### O07 · Revisiones, contratos y base de validación remota

**Unidades:** U-DAT-01, U-BIB-01, U-EXP-01, U-QA-02, U-OPS-02.

**Orden de integración y carriles:**

- D: revisión de colección y protocolo de bloqueo; después, helpers de respaldo/restauración. No escribir ambos cambios de schema simultáneamente.
- S: contrato/orquestador neutral de catálogos con fixtures, límites y estados parciales; mantiene entrada manual.
- E: retorno contextual/títulos y migración progresiva del smoke a E2E reproducible. Amplía pruebas cuando D/S integren sus contratos.

**Puerta G07:** una preview antigua no reemplaza cambios posteriores; B no invalida A; doble confirmación es idempotente. Orquestador no confunde timeout con ausencia y respeta el deadline. Volver del detalle conserva consulta y posición definida. Existe una copia administrativa de prueba restaurada, con RLS/trigger y objetos validados. La implementación de respaldo remoto queda disponible para obtener/ensayar la copia del destino antes de su mutación.

**Recuperación:** suspender nuevos reemplazos si falla CAS; conservar borradores/previews; no volver a una firma antigua que permita saltarse la revisión. Mantener el smoke anterior hasta sustituir su cobertura.

### O08 · Dos fuentes base, cuota global y adopción remota

**Unidades:** U-BIB-02, U-DAT-05, U-EXP-04, U-INF-07.

**Carriles:** S integra Open Library/BNE y coordinación entre procesos contra interfaces de O07; D prepara diagnóstico/adopción y migración remota; E valida 3D táctil/teclado y su alternativa 2D. DAT05 y BIB02 son independientes hasta la integración: ambos consumen BIB01; no dependen circularmente uno del otro.

**Puerta G08:** cuotas/caché compartidas probadas con dos procesos; BNE XML seguro y Open Library dentro de sus límites; un fallo de catálogo mantiene alta manual. Visor sin promesas de giro/zoom, máximo 48 y acceso 2D. La promoción remota identifica historia/destino, dispone de respaldo ensayado y aplica solo el plan vigente autorizado; si falta autorización o destino, la entrega queda preparada y su comprobación remota sigue pendiente, sin fingir que local la completó.

**Recuperación:** apagar un proveedor individual; parar trabajos antes de cambiar su limitador; no abrir exposición REST ni desactivar RLS para facilitar una migración.

### O09 · Trabajos, procedencia y entrega controlada

**Unidades:** U-DAT-03, U-BIB-03, U-BIB-04, U-QA-03, U-QA-04, U-OPS-04.

**Secuencia y paralelismo:**

- D/S integran jobs/leases, estado durable y políticas de provider; luego procedencia ampliada y selección revisable.
- E mide la base de rendimiento y automatiza la matriz local; el pipeline/promoción se integra al estar listo el destino de O08.
- El adaptador Google puede desarrollarse con fixtures en otro carril; permanece apagado si no se ha comprobado configuración/coste/uso permitido. No bloquea OL+BNE.
- Sesión/cabeceras/exposición se prueban en local y en el entorno remoto disponible; la CSP empieza en reporte si necesita ajuste.

**Puerta G09:** dos workers no publican un item dos veces; lease antiguo no escribe; recargar recupera resultado. La procedencia por campo conserva valores manuales y `isbnVerified` humano. Benchmark 100/1000/10000 produce cifras y perfil. CI remoto de PR se ejecuta sin secretos remotos; release usa artefacto y plan identificados. Google apagado emite cero llamadas y no expone key; habilitación real queda condicionada y visible.

**Recuperación:** detener reclamaciones, conservar cola y consultar estados; volver a UI anterior compatible sin borrar procedencia. Si la medición excede presupuesto, abrir optimización antes de la publicación conjunta de O11.

### O10 · Deshacer, buscar sin ISBN y vistas

**Unidades:** U-DAT-02, U-DAT-08, U-BIB-05, U-EXP-02.

**Carriles:** D entrega captura/publicador recuperable y restauración de snapshot; S integra los cuatro flujos bibliográficos y título/autor; E añade vistas guardadas y estados de recuperación. El publicador base de snapshots no necesita el manifest multipart futuro: O11 lo reutiliza, evitando el ciclo DAT02↔DAT04.

**Puerta G10 — salida F1:** reemplazo genera snapshot coherente o no ocurre; restaurar snapshot antiguo exige nueva revisión. Cierre/reapertura recupera trabajos. Alta/importación/portadas/búsqueda usan un único orquestador y presupuesto global. Título/autor muestra candidatos de edición, no marca ISBN físico por similitud. Vistas privadas restauran filtros y descartan selección temporal.

**Recuperación:** desactivar restauración sin eliminar snapshots; permitir consulta/exportación; una fuente caída no impide guardar una ficha manual.

## F2 · Modelo y experiencia completos

### O11 · Restauración conjunta, assets y accesibilidad

**Unidades:** U-DAT-04, U-DAT-10, U-EXP-03.

**Carriles:** D posee staging/publicación; S assets/Storage y políticas de adquisición; E revisión de contraste, foco, tamaños, zoom y lectores. Coordinar migraciones y acceso a los mismos formularios.

**Puerta G11:** conjunto de 2001 registros publica todo o nada; faltan/alteran partes → cero cambios activos; snapshots/IDs/predeterminada coherentes. Bench de hasta 10000 cumple presupuesto o rechaza sin commits parciales. Assets bloquean SSRF, XML/SVG/archivos inválidos y accesos ajenos; los bytes se validan antes de adjuntar. Recorridos a 320/375/768/1440 px, teclado, zoom y ambos temas con evidencia manual/automática.

**Recuperación:** conservar staging y colección anterior; no usar URLs firmadas como único backup; apagar adquisición remota conservando fallback y lectura de assets existentes.

### O12 · Ejemplares y ciclo de vida de cuenta

**Unidades:** U-DAT-06, U-OPS-03.

**Carriles:** D es único propietario del cambio obra/edición/copia y backfill; S implementa supresión/retención como mecanismo extensible; E prepara pruebas de compatibilidad y mensajes para edición que afecta a varias copias. El inventario de limpieza se amplía al incorporar cada entidad nueva; no presupone que las funciones de O13–O15 existan ya.

**Puerta G12:** 111 fichas sintéticas conservan IDs/ubicación/estado/fuentes; ISBN-10/13 equivalentes no descartan filas; dos copias comparten edición y conservan estado independiente; sin ISBN se usa `null`. Ida/vuelta v2 sin pérdidas. Solicitud de borrado propia, idempotente y reintentable; JWT antiguo y worker vencido no recrean datos; backup restaurado aplica supresiones antes de abrir el servicio.

**Recuperación:** expand/backfill/comparar/cambiar escritores; mantener legacy durante ventana definida. Después de admitir varias copias no se promete volver al escritor antiguo sin pérdida: detener escrituras y usar corrección o restauración ensayada.

## F2/F3 · Revisión y funciones de colección

### O13 · Revisión, entradas externas y primera ampliación de producto

**Unidades:** U-DAT-07, U-DAT-09, U-EXP-05, U-EXP-06, U-PRO-01, U-PRO-03, U-PRO-05.

**Orden recomendado dentro de la ola:**

1. D publica un lote revisado de tablas/contratos de producto —tags/notas, ubicaciones, series— y adapta v2, limpieza y permisos. No generar tres heads de Drizzle independientes.
2. S implementa revisión/CSV y sus planes; puede iniciar fixtures y parseo mientras se prepara el schema, pero integra publicación después del contrato definitivo.
3. E integra formularios y selección/escáner/avatar por grupos; no editar simultáneamente BookForm desde varias unidades. Otro carril toma una unidad libre cuando termine la anterior.

**Puerta G13:** bandeja paginada resuelve incidencias conservando evidencia; acciones masivas tienen preview/versiones. CSV maneja comillas/Unicode/mapeo, no ejecuta fórmulas y no pierde filas silenciosamente. Cámara pide permiso tras acción, cumple cabeceras y permite manual; añadir otra copia es explícito. Avatar privado persiste y su fallo conserva el anterior. Notas/tags/rating pertenecen a copia; ubicación física no cambia estantería lógica; serie describe edición y orden exacto. Todos los datos nuevos entran en export/restore y eliminación.

**Recuperación:** flags por función, sin borrar datos para retirar UI. Preservar mapeos y staging del CSV; ningún rollback descarta la copia adicional o el asset de otro usuario.

### O14 · Lectura y préstamos

**Unidades:** U-PRO-02, U-PRO-04.

**Carriles:** D/S fijan ciclos, entradas, fechas e índice de préstamo activo; E implementa controles y estadísticas basadas en datos reales. Compartir un patrón de concurrencia no significa mezclar préstamo y lectura en un mismo estado.

**Puerta G14:** relectura crea ciclo sin perder historia; sesión/progreso no inventa fechas legacy; total de páginas desconocido no genera porcentaje falso. Un préstamo activo por copia, devoluciones y fechas civiles correctas; ningún recordatorio se anuncia como enviado. RLS, reintentos, formato v2, snapshots y supresión cubren ambas funciones.

**Recuperación:** ocultar widgets manteniendo datos exportables; no convertir todos los libros «leídos» antiguos en una sesión terminada hoy para recuperar una estadística.

### O15 · Impresión y consulta offline explícita

**Unidades:** U-EXP-07, U-EXP-08.

**Carriles:** E entrega impresión/presentación; S define snapshot de lectura y política de proveedor/clave; D revisa formato/exportación y límites. Esta ola llega después de conocer las secciones de producto que una copia de lectura debe conservar o excluir explícitamente.

**Puerta G15 — salida F3:** impresión coincide con filtros y funciona A4/Carta sin controles o fondos ilegibles. Offline es opt-in, solo lectura, por cuenta, con antigüedad visible, desbloqueo y bloqueo por expiración; A no aparece como B; logout/reconexión purgan según contrato. El worker no cachea rutas autenticadas o acciones genéricamente ni los datos de una fuente cuya política no lo permita. Sin consentimiento solo hay shell estático.

**Recuperación:** publicar worker de limpieza de la versión anterior y apagar snapshots; mantener acceso online. No prometer revocar un dispositivo desconectado ni proteger contra XSS solo por cifrar IndexedDB.

## F4 · Entrega y cierre con evidencia

### O16 · Revalidación final y auditoría

**Unidad:** U-QA-05, con revalidación de las unidades integradas.

**Lista de entrega:**

1. Instalación limpia, reconstrucción local, migración desde versión previa y adopción remota cuando proceda; comparar catálogo de objetos DB, no solo snapshot de tablas.
2. Suite de integración y E2E relevante con navegadores; lector/zoom/móvil/ambos temas; ausencia de errores JS/hidratación y éxitos falsos.
3. Benchmark final y comparación con G09, incluyendo cambio de modelo, restauración, conexiones, workers y límites globales.
4. Google OAuth y renovación reales, cabeceras/caché del alojamiento y checks externos de proveedores habilitados, con presupuesto mínimo y sin catálogo privado como test público.
5. Ensayo de respaldo administrativo y Storage de la versión final; borrado de cuenta y no resurrección al restaurar.
6. Release del mismo commit/lockfile/migraciones, con artefacto inmutable específico del destino y su configuración pública verificada; diagnóstico de errores y alertas probadas; plan de recuperación y responsable.
7. Matriz de los 35 hallazgos con evidencia por entorno. Google opcional apagado o 3D libre diferido se documentan como decisiones, no como pruebas superadas de funciones que no existen.

**Puerta G16:** ninguna obligación de entrega queda disfrazada como «probada» por estar implementada. Los pendientes externos o diferidos se listan con alcance y responsable. Cierre de código y cierre de despliegue son estados diferentes.

## Trazabilidad completa de la auditoría

«Base corregida» significa trabajo existente que debe conservarse, no repetirlo. El estado final solo se actualiza al aportar evidencia nueva. Todas las filas incluyen sus comprobaciones de cierre bajo U-QA-05.

| Hallazgo | Punto de partida | Pendiente y unidades |
| --- | --- | --- |
| SEC-01 | Dependencias/instalación normalizadas localmente. | Objetivos/build reproducibles, CI/despliegue y mantenimiento: U-INF-01/02, U-QA-04, U-OPS-05. |
| SEC-02 | Callback interno validado. | Ensayo Google/destinos reales, cabeceras y regresión: U-QA-01/02, U-OPS-04. |
| SEC-03 | Validadores y errores de dominio compartidos. | Extenderlos a cada contrato nuevo y probar superficies reales: U-OPS-04, U-QA-01/02 y aceptación de todas las unidades de escritura. |
| SEC-04 | FK compuesta y RLS ensayadas con Auth mínimo. | Servicios/permisos reales, adopción y migración de destino: U-INF-04/07, U-QA-01, U-OPS-04. |
| SEC-05 | Rutas/cookies corregidas y probadas con sustituto de Auth. | GoTrue/Google/refresh reales, eliminación y offline: U-INF-05, U-QA-01/02, U-OPS-03/04, U-EXP-08. |
| BE-01 | Pool único, TLS y transacciones tipadas. | Presupuesto de conexiones y latencias medidos: U-QA-03, U-OPS-01. |
| BE-02 | Predeterminada idempotente y versión de ficha. | CAS de colección, concurrencia real y jobs: U-DAT-01/03, U-QA-01/03. |
| BE-03 | Lecturas específicas y paginación. | Escala 100/1000/10000, queries/índices y rendimiento remoto: U-QA-03, U-OPS-01; mantener consultas acotadas en funciones nuevas. |
| BE-04 | Open Library validado, caché/límite por proceso. | Varios proveedores, cuota/caché global, búsqueda textual: U-BIB-01…05, U-DAT-05/08. |
| BE-05 | Identidad/utilidades internas `server-only`. | Conservar regla en workers/acciones nuevas y verificar exposición: U-DAT-03, U-QA-01, U-OPS-04. |
| BE-06 | Recurso persistido y `ActionResult`. | Extender estados de trabajos/proveedores y probar errores reales sin filtrar detalles: U-DAT-03, U-BIB-01/05, U-QA-02, U-OPS-04. |
| IMP-01 | Revisión/fusión/reemplazo confirmado y copia disponible. | Confirmación vigente, deshacer y restauración conjunta: U-DAT-01/02/04. |
| IMP-02 | Límites/lotes y recuperación de portadas en la página. | Jobs durables, publicación conjunta y cuota entre instancias: U-DAT-03/04/05. |
| IMP-03 | v1/legacy e IDs definidos, exportación fragmentada. | Manifest, formatos nuevos completos, restore y backups administrativos: U-DAT-02/04/06/09, U-OPS-02. |
| IMP-04 | ISBN canónico y procedencia básica. | ISBN nullable, obra/edición/copia, evidencia y selección multifuente: U-DAT-06/07, U-BIB-04. |
| UX-01 | Editor completo existente. | Revisión central y campos/funciones personales: U-DAT-07, U-PRO-01/02/04; mantener conflictos por versión. |
| UX-02 | Estanterías conectadas y movimientos múltiples. | Ubicación física diferenciada: U-PRO-03; regresión A/B con U-QA-01/02. |
| UX-03 | Nombre real y cámara ficticia retirada. | Avatar privado y limpieza: U-EXP-06, U-DAT-10, U-OPS-03. |
| UX-04 | Estados pendientes/error y errores serializados. | Desconexión, jobs/resultados durables y no pérdida de borrador: U-DAT-01/03, U-QA-02. |
| UX-05 | Catálogo/filtros URL y búsqueda normalizada. | Retorno/scroll, vistas, revisión y catálogos sin ISBN: U-EXP-01/02, U-DAT-07/08; impresión U-EXP-07. |
| UX-06 | Recuentos y cero resultados corregidos. | Conservar regresiones 0/1/10/11 y filtros desde página posterior: U-QA-02; vistas U-EXP-02. |
| UX-07 | Predeterminada protegida en UI/DB. | Conservar y verificar con roles reales y nuevas restauraciones: U-QA-01/02, U-DAT-04/06. |
| UX-08 | Alta revisable, duplicado y alternativa manual. | Consecutiva/escáner, otros proveedores y copias explícitas: U-EXP-05, U-BIB-01…05, U-DAT-06/08. |
| UX-09 | 3D honesto, enlaces, teclado y páginas. | Verificación táctil/2D/estados: U-EXP-04; rotación/zoom libre quedan expresamente fuera. |
| UI-01 | Dashboard/jerarquía y móvil mejorados. | Revisión integral y nuevas funciones/impresión: U-EXP-01/03/07, U-PRO-02. |
| UI-02 | Tokens/paleta corregidos y muestras medidas. | Contraste de estados/transparencias/foco real: U-EXP-03. |
| UI-03 | Semántica/etiquetas/teclado básicos corregidos. | Lector, zoom, móviles y nuevas interacciones: U-EXP-03/04/05, U-QA-02. |
| FE-01 | Tema global y smoke sin hidratación. | Otros navegadores, nuevas rutas y PWA: U-QA-02, U-EXP-03/08. |
| FE-02 | BookCover/fallback/recuperación. | Optimización/copia permitida y ciclo de assets: U-DAT-10, U-EXP-06, U-QA-03. |
| FE-03 | Navegación activa, títulos por sección y error boundary. | Estructura compartida si reduce duplicación, título individual, retorno y vistas: U-EXP-01/02. |
| FE-04 | Persistencia antigua y dependencias principales retiradas. | Rutas Auth/envueltos/datos de prototipo restantes: U-OPS-05. |
| QA-01 | Tipos/build obligatorios, tests y CI definidos. | Supabase real, E2E ampliado y CI remoto: U-INF-05/06, U-QA-01/02/04. |
| QA-02 | Migraciones/RLS y snapshots locales preparados. | Runner canónico, drift SQL manual, actualización/adopción y destino real: U-INF-04/07, U-QA-01/04. |
| OPS-01 | Logs privados retirados y errores básicos medidos. | Correlación, métricas, capacidad y alertas verificadas: U-OPS-01, U-QA-03/04. |
| OPS-02 | Guía/JSON y Analytics opt-in. | Respaldo completo, Storage, supresión, retención y operación: U-OPS-02/03/04, U-DAT-10, U-EXP-08. |

## Ampliaciones nuevas: cobertura sin confundirlas con defectos

| Petición o función | Unidad de entrega |
| --- | --- |
| Supabase completo local y acceso de desarrollo | U-INF-01…06, U-QA-01. |
| Scripts de migración local/preproducción/producción | U-INF-04/07; CI U-QA-04; backup U-OPS-02. |
| Varios proveedores ISBN gratuitos | U-BIB-01/02/04/05; Google opcional U-BIB-03. |
| Búsqueda título/autor y revisión de ediciones | U-DAT-07/08, U-BIB-04. |
| Escáner y altas seguidas | U-EXP-05. |
| Notas, etiquetas y valoración | U-PRO-01. |
| Progreso, sesiones, relecturas y estadísticas | U-PRO-02. |
| Ubicación por mueble/balda/posición y fotos | U-PRO-03. |
| Préstamos | U-PRO-04. |
| Series y volúmenes | U-PRO-05. |
| CSV y mapeo | U-DAT-09. |
| Vistas guardadas y catálogo imprimible | U-EXP-02/07. |
| PWA y consulta offline | U-EXP-08. |
| Avatar propio | U-EXP-06. |

## Condiciones que pueden bloquear una entrega

| Condición | Detección | Trabajo que puede avanzar | Criterio para desbloquear |
| --- | --- | --- | --- |
| Docker/recursos/puertos no disponibles | O00 y doctor | Contratos, fixtures y UI sin servicios. | Perfil propio saludable, sin parar servicios ajenos. |
| Historial remoto desconocido o drift | INF07/status/plan | Todas las pruebas locales. | Diagnóstico/adopción revisados, objetos e historial coherentes y respaldo ensayado. |
| Sin autorización/destino remoto | O00 y promoción | Código, scripts y ensayo local completo. | Operación autorizada sobre proyecto/plan concretos; no inferir autorización del paso del tiempo. |
| Publicación de 10000 excede presupuesto | QA03/DAT04 | Staging, revisión y exportación; mejorar SQL/índices. | Medida dentro del presupuesto o ADR de escala completo; no commits parciales ocultos. |
| Google sin condiciones verificadas | BIB03 | OL+BNE, fixture y alta manual. | Configuración, cuota/coste y uso permitido comprobados; permanece deshabilitado mientras tanto. |
| Imágenes sin permiso de copia o procesador soportado | DAT10 | URLs permitidas y fallback. | Política por fuente y validación de archivo/red probadas. |
| Dispositivo/lector no disponible | EXP03/QA02 | Pruebas automatizadas y otros recorridos. | Evidencia manual del dispositivo/lector requerido o limitación expresamente documentada; no afirmar prueba inexistente. |

Los pendientes externos no se esconden en un «todo correcto». El estado del registro comienza en `planned`; se actualizará por entregas con evidencia, no por la mera existencia de esta documentación.

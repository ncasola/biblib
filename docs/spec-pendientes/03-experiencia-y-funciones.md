# Especificación pendiente: experiencia y funciones

Documento de producto para completar BibLib sin cambiar su identidad de biblioteca vintage en español. La auditoría de 22 de octubre de 2026 es la referencia de defectos y riesgos; este documento distingue lo que ya existe en el repositorio del trabajo que sigue pendiente. No sustituye las decisiones de fase y ola del coordinador.

## Estado de partida

El repositorio ya incluye edición de la ficha, asignación y movimiento en lote, filtros de catálogo en URL (`q`, `status`, `shelf`, `sort`, `page`, `view`), paginación del servidor, búsqueda normalizada, estados de error/reintento, metadatos estáticos por algunas rutas y una vista 3D por páginas. No duplicar esos contratos: ampliar sus límites indicados abajo. El alta por ISBN ya permite revisar datos y elegir estado/estantería, y ofrece entrada manual con el ISBN; falta la captura por cámara y el flujo consecutivo. El perfil persiste el nombre, pero la foto visible sigue siendo la de Google. El proyecto tiene manifiesto PWA, no una experiencia offline. No se encuentran notas, etiquetas, valoraciones, progreso por página, sesiones, ubicaciones físicas, préstamos ni series.

La auditoría también documenta consultas que presentaban fallos como biblioteca vacía, falta de accesibilidad y contraste por verificar; parte de esos problemas ya se ha corregido en el trabajo actual. Los criterios siguientes exigen verificar el estado integrado al iniciar cada unidad, en vez de volver a implementar correcciones ya presentes.

## Convenciones comunes

- Todos los textos y mensajes de producto son español natural. Se conservan el logo, crema, rojo, oliva, amarillo como acento y las formas cálidas de BibLib; no se propone rediseño total ni funciones sociales.
- **Esfuerzo:** XS < media jornada; S de media a dos jornadas; M de tres a cinco; L de seis a diez. Son rangos orientativos de una persona y deben ajustarse tras revisar el estado real.
- Las lecturas y escrituras privadas se autorizan por `user_id` en el servidor y RLS. Los ejemplos de contrato son esquemas conceptuales, no migraciones listas para ejecutar.
- Cada unidad ejecuta verificaciones proporcionales al cambio: lint/tipos del alcance y pruebas enfocadas, junto con las pruebas de regresión afectadas. No ejecutar la suite completa por unidad sin motivo; reservarla para integración y puertas de publicación. Para cambios de datos, probar tanto migración vacía como actualización desde el esquema anterior en una base aislada.
- Los cambios reversibles se despliegan con bandera o ruta de acceso gradual cuando se indique. La recuperación consiste en desactivar la función y conservar los datos; no borrar campos nuevos durante rollback.
- Tras U-DAT-06, notas/tags/valoración, ciclos/entradas de lectura, ubicación y préstamos pertenecen a la copia; serie pertenece a la edición. El backup JSON v2 extiende estos datos. JSON v1 no genera valores históricos, préstamos, sesiones ni ubicaciones que no estaban presentes.

## Experiencia de uso

### U-EXP-01 · Estructura compartida, título por libro y vuelta al catálogo

**Objetivo.** Hacer predecible la navegación entre inicio, colección, ficha y ajustes, y devolver a la persona al mismo contexto tras abrir un libro.

**Alcance.** Revisar los layouts existentes antes de extraer uno compartido. Centralizar solo los elementos realmente comunes (cabecera, salto al contenido, ancho y manejo de carga/error); mantener componentes interactivos como islas cliente y no convertir todas las rutas en cliente. Añadir metadatos dinámicos a la ficha (`título del libro · BibLib`) y título fijo en cada ruta existente. Conservar en el enlace al detalle el estado de colección y restaurar filtros, página, vista y posición de scroll al volver. El desplazamiento debe respetar el comportamiento del App Router y no guardar coordenadas obsoletas al cambiar filtros.

**Archivos y contratos propuestos.** `app/layout.tsx`, layouts de dominio (`app/books/layout.tsx`, `app/shelves/layout.tsx`, `app/profile/layout.tsx`, `app/settings/layout.tsx`, `app/book/layout.tsx`), `app/book/[id]/page.tsx`, `components/header.tsx`, `components/books-table.tsx`, `lib/book-search.ts`. Contrato: `generateMetadata({ params })` obtiene el título con `getBookDetailAction`; los enlaces desde catálogo llevan una URL de retorno interna validada (o conservan la query actual), sin aceptar destinos externos. La ruta actual es cliente: separar primero `page.tsx` servidor de un `BookDetailsScreen` cliente y exportar `generateMetadata` únicamente desde el módulo servidor. Reutilizar la lectura autenticada con alcance de petición, sin una caché global de títulos privados; una respuesta sin sesión no incluye el título. Declarar no indexables las rutas privadas.

**Dependencias/modelo.** No requiere tabla nueva. Depende de detalle específico y autorización ya existentes. No cachear metadatos privados entre cuentas.

**Criterios de aceptación.** La pestaña del navegador muestra el título real de cada libro y un fallback español para libro inexistente; abrir detalle desde tabla o cuadrícula y usar «Volver» recupera filtros, vista, página y fila visible; abrir una URL directa sigue funcionando; la cabecera y el contenido no se duplican en el árbol accesible.

**Pruebas locales.** Navegar desde una búsqueda filtrada a un detalle y volver con botón, atrás/adelante y recarga; abrir un detalle en otra pestaña; comprobar título en DOM y metadata; probar un ID inválido y el cambio de cuenta sin filtración de datos.

**Despliegue/recuperación.** Sin migración. Activar el retorno contextual por ruta; si causa saltos de scroll, retirar el almacenamiento de coordenadas y conservar solo el estado URL, que es recuperable.

**Esfuerzo: S.**

### U-EXP-02 · Filtros reproducibles y vistas guardadas

**Objetivo.** Mantener una búsqueda compartible y permitir volver a consultas frecuentes sin ampliar la descarga de biblioteca.

**Alcance.** Mantener como fuente de verdad los filtros URL actuales, validar parámetros al leerlos y normalizar texto/ISBN en un único helper. Añadir vistas guardadas con nombre y una selección explícita «Guardar vista actual»; guardar solo filtros admitidos, orden, modo tabla/cuadrícula y tamaño de página, nunca selección temporal ni datos de libros. Una vista guardada puede sobrescribirse, renombrarse y eliminarse. La selección en lote sigue limitada a la página actual y se limpia al cambiar filtros/página; un fallo de movimiento conserva la selección.

**Archivos y contratos propuestos.** `components/books-table.tsx`, `lib/book-search.ts`, `app/actions/library.ts`, `app/actions/saved-views.ts` (nuevo), rutas de colección. `SavedBookView = { id, name, filters: { q?, status, shelf, sort, view, pageSize }, updatedAt }`; al aplicar, la página empieza en 1 y se omiten IDs de estantería que ya no existan. No almacenar query arbitraria ni criterios SQL.

**Dependencias/modelo.** Tabla `saved_book_views(id, user_id, name, filters jsonb, created_at, updated_at)` con RLS por usuario y validación de esquema al leer/escribir; máximo 100 vistas guardadas por cuenta y nombre de hasta 80 caracteres. Depende de colección paginada y permisos. Las URLs existentes siguen sirviendo sin iniciar sesión solo si la ruta ya es pública; ningún dato de biblioteca se expone por ello.

**Criterios de aceptación.** Recargar y compartir URL reproduce los mismos resultados; una vista guardada restaura los filtros vigentes sin selección anterior; parámetros desconocidos/malformados caen a valores seguros; dos usuarios nunca ven las vistas del otro; guardar o borrar muestra resultado solo tras respuesta confirmada.

**Pruebas locales.** Tests puros de parseo/serialización; prueba de persistencia con usuarios A/B; navegación atrás/adelante; borrado de una estantería usada por una vista; error de red al guardar sin perder los filtros actuales.

**Despliegue/recuperación.** Tabla nueva opcional y aditiva; migración reversible conservando export de datos. Puede lanzarse primero a un usuario de prueba. Desactivar el panel no altera los parámetros URL ni la biblioteca.

**Esfuerzo: M.**

### U-EXP-03 · Accesibilidad y adaptación de pantalla verificadas

**Objetivo.** Asegurar que las tareas principales sean legibles y operables con teclado, lector de pantalla, zoom y tamaños pequeños.

**Alcance.** Medir colores de texto, foco, controles y estados en los temas claro/oscuro, incluidos fondos translúcidos; normal ≥4,5:1 y texto grande ≥3:1. Revisar landmarks, orden de foco, nombres/estados, tablas ordenables, mensajes pendientes/error, diálogos, avisos y enlaces. Mantener foco visible, objetivo táctil cómodo y movimiento reducido. Validar desbordamiento, reflujo y acciones principales en anchos CSS de 320, 375, 768 y 1440 px; incluir zoom del navegador al 200 % y 400 % (el contenido equivalente a 320 px no debe requerir desplazamiento horizontal salvo una región tabular claramente identificada). Probar Chrome, Edge, Firefox y Safari; al menos un lector de pantalla de escritorio y VoiceOver móvil.

**Archivos y contratos propuestos.** `app/globals.css`, `components/header.tsx`, `components/books-table.tsx`, formularios, detalle, modales, `components/shelf-viewer-3d.tsx`. Lista compartida de escenarios manuales bajo `tests/accessibility/` o documentación QA; no certificar WCAG sin evaluación completa.

**Dependencias/modelo.** Sin cambios de dominio. Requiere navegadores/dispositivos de prueba y revisar los tokens integrados; las herramientas automáticas complementan, no sustituyen, la prueba manual.

**Criterios de aceptación.** Se completan alta, búsqueda, movimiento, edición y cierre de sesión solo con teclado; el foco no desaparece ni queda detrás de cabecera fija; errores se anuncian una vez; contraste cumple en combinaciones visibles; no hay scroll horizontal inesperado a los cuatro anchos ni animación no esencial con `prefers-reduced-motion: reduce`.

**Pruebas locales.** Axe/Lighthouse como detección, seguida de recorridos manuales en tamaños y temas indicados; teclado sin ratón; zoom; lector de pantalla en diálogo, filtros, tabla y errores; comprobar botones táctiles y controles nativos en Safari iOS.

**Despliegue/recuperación.** Cambios CSS/semánticos incrementales. Si una corrección rompe el foco o un control, revertir el componente puntual; nunca retirar indicadores de foco como solución visual.

**Esfuerzo: M.**

### U-EXP-04 · Vista 3D: decisión de interacción y alternativa equivalente

**Objetivo.** Mantener el visor como representación opcional de la colección sin prometer controles que no existen ni penalizar accesibilidad o rendimiento.

**Decisión final.** No implementar en esta etapa rotación libre de cámara, gestos de giro ni zoom táctil. La escena CSS paginada permanece estática; se navega por estantería y páginas, y cada lomo es un enlace real a su ficha. La alternativa 2D de tabla/cuadrícula es la vista equivalente y preferente para selección, búsqueda y tareas por lote. No mostrar ayuda que anuncie arrastre, clic derecho o zoom. Reabrir la decisión solo con evidencia de uso que justifique su coste y una propuesta accesible equivalente.

**Alcance.** Conservar el límite de 48 libros por página, alturas de lomo acotadas, nombres accesibles, fallback con título y ajuste táctil. Evitar que las dimensiones de libros inicien acciones por hover. Ofrecer enlace visible a la colección 2D y anunciar estantería/página actual; probar toque y teclado. Respetar movimiento reducido en transiciones decorativas.

**Archivos y contratos propuestos.** `app/shelves/3d/page.tsx`, `components/shelf-viewer-3d.tsx`, `components/books-table.tsx`, CSS compartido. Contrato de listado: estantería, página y máximo 48; no introducir datos de todo el catálogo en el cliente.

**Dependencias/modelo.** Lectura paginada y recuentos actuales por estantería; no requiere motor 3D nuevo ni migración.

**Criterios de aceptación.** Un teléfono puede seleccionar estantería, pasar página y abrir ficha con toque; cada libro se enfoca y activa con teclado; carga/fallo/vacío no parecen la misma escena; la alternativa 2D contiene los mismos libros de esa selección; no hay promesa de rotación/zoom en textos ni gestos accidentales.

**Pruebas locales.** Móvil táctil y emulación a 320/375 px, teclado, lector de pantalla, reducción de movimiento, estantería vacía y más de 48 libros; comparar IDs entre la página 3D y la tabla filtrada.

**Despliegue/recuperación.** Sin migración; el acceso 2D permanece disponible. Desactivar la ruta 3D si se rompe sin afectar al catálogo.

**Esfuerzo: S.**

### U-EXP-05 · Alta consecutiva y captura ISBN por cámara

**Objetivo.** Acelerar el alta de libros físicos conservando revisión bibliográfica y una ruta manual siempre disponible.

**Alcance.** Tras guardar con éxito, ofrecer «Guardar y añadir otro»: reiniciar el formulario y conservar una estantería/estado elegidos como valor por defecto de la sesión de alta, con confirmación de que se guardó el libro anterior. Evitar repetir una petición o añadir un ISBN ya existente. Añadir botón explícito para cámara que solicite permiso en ese momento, busque EAN/ISBN y muestre el código reconocido para confirmación antes de consultar el catálogo. El usuario puede parar la cámara. Si HTTPS, permiso o detector no están disponibles, la entrada manual sigue completa y visible; no bloquear acceso por cámara.

**Archivos y contratos propuestos.** `app/books/add/page.tsx`, `components/search-book-form.tsx`, `components/book-search-result.tsx`, `components/book-form.tsx`, `components/manual-book-form.tsx`, validación ISBN existente. Contrato UI de captura: `onDetected(value: string)`, validar checksum/longitud antes de buscar; nunca enviar la imagen a un servicio externo.

**Dependencias/modelo.** Alta y detección de duplicado ya existentes; requiere HTTPS en despliegue, permiso del navegador y comprobar disponibilidad real de BarcodeDetector o elegir biblioteca pequeña mantenida. La política actual envía `Permissions-Policy: camera=()` a todas las rutas: el escáner requiere sustituirla por una política de mínimo privilegio que autorice solo el origen de BibLib en la ruta de alta, manteniendo cámara denegada en el resto. Sin tabla adicional.

**Criterios de aceptación.** La cámara solo se abre tras acción del usuario; la persona confirma el código; denegar permiso no impide alta manual; tras primer guardado se informa éxito y quedan campos limpios para el siguiente; error conserva campos; duplicado lleva a la ficha existente sin crear otro libro.

**Pruebas locales.** Simular detector compatible/no compatible, permiso denegado, lectura inválida, ISBN válido con guiones, timeout de Open Library, duplicado y doble toque en guardar; hacer una alta manual después de denegar cámara.

**Despliegue/recuperación.** Cámara detrás de bandera de capacidad y tras cambiar/verificar `Permissions-Policy`; apagarla sin afectar al formulario ISBN/manual. No persistir fotogramas.

**Esfuerzo: M.**

### U-EXP-06 · Avatar personal separado de Google

**Objetivo.** Permitir una imagen propia en el perfil sin alterar la identidad de acceso ni la foto mantenida por Google.

**Alcance.** Mostrar la imagen personalizada si existe y, en su ausencia, la de Google o iniciales. Permitir cargar, previsualizar, reemplazar y quitar la imagen propia; recortar de forma simple; indicar tipo/tamaño admitido y mantener el correo como dato informativo de Google. No modificar la metadata OAuth para guardar una imagen privada.

**Archivos y contratos propuestos.** `app/profile/page.tsx`, `components/header.tsx`, componente nuevo `components/profile-avatar-form.tsx`, `lib/auth-context.tsx`, acciones de perfil/almacenamiento. Campo de perfil `avatar_path?: string`; URL firmada o endpoint autenticado de lectura. Storage path `{user_id}/avatar/{asset_id}`.

**Dependencias/modelo.** Bucket privado Supabase Storage con política de lectura/escritura por usuario, cuota, MIME raster permitido y tamaño máximo explícito; RLS para metadata `profiles.avatar_path`. Depende de definir eliminación de objetos sustituidos y purga al borrar cuenta.

**Criterios de aceptación.** Tras recargar aparece el avatar propio en perfil/cabecera; quitarlo vuelve al avatar Google/fallback; un usuario no puede leer ni sustituir el de otro con ID o ruta manipulada; fallo de carga conserva imagen previa y no simula éxito.

**Pruebas locales.** Subir formato admitido, formato no admitido, imagen grande, fallo de red, reemplazo, borrado y dos usuarios; probar menú móvil y alternativo de lector de pantalla.

**Despliegue/recuperación.** Bucket y columna aditivos. Activar carga solo tras políticas probadas; ante fallo se oculta el editor y se conserva fallback Google, sin borrar avatares existentes.

**Esfuerzo: M.**

### U-EXP-07 · Catálogo imprimible

**Objetivo.** Producir una copia en papel legible del catálogo seleccionado, sin diseñar un sistema de publicaciones aparte.

**Alcance.** Acción «Imprimir catálogo» desde resultados y estantería. Respetar filtros actuales o estantería elegida; permitir elegir campos útiles (título, autor, ISBN, estado, ubicación y notas cuando existan) y excluir portada por defecto para ahorrar tinta. Incluir título de impresión, fecha local y numeración; ocultar navegación, botones, decoraciones oscuras y controles. La impresión debe tener alternativa texto si el navegador ignora colores.

**Archivos y contratos propuestos.** `components/books-table.tsx`, página `/books/print` o vista imprimible aislada, `app/globals.css` (`@media print`), layout de impresión. Consultar páginas de listado respetando límites; nunca cargar toda la biblioteca con una consulta sin límite.

**Dependencias/modelo.** Filtros/listado actuales; los campos futuros son opcionales. No requiere almacenamiento adicional ni generar PDF servidor en primera versión.

**Criterios de aceptación.** Vista previa incluye exactamente resultados filtrados y recuento correcto; no imprime controles; el texto no se corta en papel A4/Carta ni depende del color; cancelación de diálogo no modifica filtros.

**Pruebas locales.** Chrome/Edge y Firefox print preview, A4 y carta, colección vacía, más de una página, título largo, tabla/cuadrícula y filtro de estantería; comparar IDs impresos con la consulta.

**Despliegue/recuperación.** Sin migración; quitar la acción o estilos de impresión no afecta al listado.

**Esfuerzo: S.**

### U-EXP-08 · PWA con consulta offline de solo lectura

**Objetivo.** Habilitar acceso limitado sin red con separación de cuenta y sin convertir el navegador en una segunda fuente de escrituras.

**Decisión de privacidad.** No cachear respuestas privadas en Cache Storage ni permitir acceso offline por defecto. La primera versión solo ofrece shell estático; la copia de libros es una opción explícita «Guardar copia de lectura en este dispositivo». Guardar un snapshot cifrado por cuenta en IndexedDB con una clave aleatoria persistida y envuelta mediante primitivas Web Crypto y un esquema/KDF revisado; no diseñar criptografía propia. Pedir el secreto local de desbloqueo (PIN/frase configurado en ese dispositivo) para abrir el snapshot tras reiniciar el navegador. El cifrado local reduce exposición de datos en reposo, pero no protege frente a XSS ejecutado mientras la copia está desbloqueada. Fijar un vencimiento corto desde la última validación online; alcanzado ese TTL, bloquear el snapshot y requerir autenticación online antes de volver a abrirlo. Un cierre de sesión online borra la clave y los datos locales de esa cuenta. Un dispositivo desconectado no puede recibir una revocación remota instantánea: no prometer borrado ni invalidación en ese dispositivo antes de que vuelva a conectarse o venza el TTL. Nunca sincronizar cambios offline.

**Alcance.** Service worker versionado para recursos estáticos; controlar actualización y modo sin conexión. Offline no muestra funciones que aparenten guardar cambios. Cache privada limitada por cuota y antigüedad, sin imágenes remotas salvo decisión de presupuesto. Indicador claro de «Copia del …», cuenta y fecha; cambio de cuenta invalida la vista anterior.

**Archivos y contratos propuestos.** `public/manifest.webmanifest`, worker nuevo bajo `public/`, `app/layout.tsx`, `lib/auth-context.tsx`, servicio `lib/offline-library.ts`, ajuste de usuario/dispositivo para habilitar/quitar copia. No cachear Server Actions, `/api`, callback OAuth ni respuestas HTML autenticadas.

**Dependencias/modelo.** IndexedDB y Web Crypto disponibles; definir longitud/KDF del secreto, TTL y recuperación de clave antes de habilitarlo. La clave envuelta permanece en el dispositivo hasta cierre de sesión o borrado/purga explícitos; el vencimiento bloquea el acceso, sin exigir borrado inmediato; no se sincroniza con Supabase. Revisión de `Cache-Control` en alojamiento. Datos privados siguen autorizados en servidor; la copia offline es explícitamente un riesgo del dispositivo compartido.

**Criterios de aceptación.** Sin consentimiento no hay snapshot privado; el PIN/frase abre solo la copia de esa cuenta en ese dispositivo; offline solo permite lectura hasta el TTL indicado; vencer el TTL bloquea hasta una nueva autenticación online, sin exigir borrado inmediato; el cierre de sesión mientras hay conexión borra copia/clave; no se afirma que revocación remota llegue a un dispositivo aislado; no hay acciones pendientes por sincronizar; corrupción de caché ofrece borrar/volver a descargar.

**Pruebas locales.** Dos cuentas en mismo navegador, cierre de sesión, expiración, renovación, desconexión durante navegación, dispositivo compartido, quota exceeded, actualización del worker y borrado manual de datos del sitio.

**Despliegue/recuperación.** Lanzamiento opt-in por bandera. Ante incidente, desactivar snapshot y publicar worker que borra bases/caches de versión anterior; conservar acceso online. No activar almacenamiento offline antes de revisar el flujo de expulsión y expiración en dispositivos compartidos.

**Esfuerzo: L.**

## Funciones de biblioteca

### U-PRO-01 · Notas, etiquetas y valoración personal

**Objetivo.** Añadir contexto personal útil para recordar por qué se guardó o cómo se valoró un libro.

**Alcance.** Notas privadas editables por copia, hasta 4.000 caracteres; valoración entera opcional de 1 a 5 o `null`; hasta 20 tags por copia, cada uno de hasta 40 caracteres. Las etiquetas describen temas/preferencias y no reemplazan estantería ni ubicación física. Filtros de varias etiquetas usan OR por defecto y ofrecen AND como opción explícita. Incluir esos campos en filtros/listado solo después de crear el modelo de obras/ediciones/copias de U-DAT-06.

**Archivos y contratos propuestos.** Detalle de copia, `components/book-form.tsx`, `components/books-table.tsx`, acciones por `copyId` y `app/actions/tags.ts` (nuevo), validación y backup JSON v2. Ejemplo de DTO: `{ copyId, notes?: string, rating?: 1|2|3|4|5|null, tagIds: string[] }`.

**Dependencias/modelo.** Depende de U-DAT-06 y sus tablas/contratos de copias. No añadir columnas `notes` o `rating` a `books` legacy después de migrar el catálogo a obras/ediciones/copias. Crear `tags(id,user_id,name,normalized_name)` y asociación por `copy_id`, con FK compuestas, unicidad por cuenta y RLS.

**Criterios de aceptación.** Campos opcionales no bloquean alta/importación vieja; etiqueta duplicada por mayúsculas/acentos no se duplica; nota/valoración son privadas; borrar una etiqueta no borra el libro; export e import conservan campos y migración de versión anterior los deja vacíos.

**Pruebas locales.** CRUD, límites, Unicode, duplicados simultáneos, usuario cruzado, importación/exportación, edición concurrente y filtros por tag; teclado para estrellas con equivalente textual.

**Despliegue/recuperación.** Columnas/tablas aditivas y campos opcionales. Habilitar lectura antes de mostrar formularios; rollback oculta edición y conserva datos.

**Esfuerzo: M.**

### U-PRO-02 · Sesiones, progreso, relecturas y estadísticas honestas

**Objetivo.** Registrar actividad real de lectura sin inferir páginas o hábitos que la persona nunca informó.

**Alcance.** Distinguir estado actual del libro, ciclo de lectura y sesión/progreso real. `reading_cycles` representa cada lectura o relectura; `reading_entries` registra sesiones reales y cambios de progreso dentro de un ciclo. No llamar «sesión» al ciclo. Relectura crea ciclo nuevo sin sobrescribir ciclos anteriores. Estadísticas muestran periodo, fuente y denominador. Si solo existe estado `read` legado, no convertirlo en fecha ni sesión ficticia ni usar la fecha actual para completar datos retroactivos.

**Archivos y contratos propuestos.** Detalle de copia, formulario/acciones de lectura, resumen del inicio y panel de progreso. Contratos conceptuales separados `reading_cycles(id,user_id,copy_id,started_at,finished_at,status,cycle_number)` y `reading_entries(id,user_id,cycle_id,occurred_at,page_from,page_to,note)`; eventos no se calculan a partir de `updated_at` salvo que se etiqueten como estimación. Backup JSON v2 extiende ciclos y entradas; JSON v1 se importa sin fechas/sesiones inventadas.

**Dependencias/modelo.** Depende de U-DAT-06, tablas por usuario y FK compuestas a copia/propietario; reglas para un ciclo activo por copia y transacciones para iniciar/cerrar; revisar concurrencia en dos dispositivos. Guardar timestamps en UTC y presentar en zona del usuario. Decidir qué hacer con total de páginas desconocido: permitir registro sin porcentaje y ocultar el indicador.

**Criterios de aceptación.** No se acepta página negativa ni superior al total conocido; relectura crea ciclo; progreso y finalización son reversibles con confirmación; dashboard cuenta solo sesiones registradas y etiqueta el periodo; libros legados siguen con estado actual y no aparecen con fecha inventada.

**Pruebas locales.** Iniciar/pausar/finalizar ciclos y registrar entradas, interrupción de red, dos dispositivos, copia sin páginas, relectura, husos horarios, fechas cruzadas y estadísticas sin datos; comprobar que la migración de lectura legacy no inventa fecha; probar cálculo con fixture de cero y varios ciclos.

**Despliegue/recuperación.** Tabla aditiva, no migrar `read` a sesiones. Activación gradual con opción de desactivar widgets; datos registrados permanecen intactos.

**Esfuerzo: L.**

### U-PRO-03 · Ubicación física y plan de fotografías

**Objetivo.** Encontrar el ejemplar físico sin confundir agrupación lógica, mueble y estante visual.

**Alcance.** Modelar ubicación física como complemento: mueble (estantería, caja, armario), balda y posición opcional; no usar `shelf_id` actual como posición física. Desde ficha se cambia ubicación y se muestra ruta legible; desde estantería física se filtra su contenido. La posición puede ser manual y no se renumera silenciosamente al mover otros libros. Plan de fotos: enlazar imagen general del mueble o foto de referencia, no exigir foto por libro; vista previa, eliminar y reemplazar sin alterar portadas.

**Archivos y contratos propuestos.** Ficha de copia, catálogo, pantalla nueva `/locations`, formularios y acciones `app/actions/locations.ts` (nuevo). Contrato: `PhysicalLocation { id, name, kind, parentId?, photoPath? }`, relación `copy_locations(user_id,copy_id,location_id,shelf_label?,position?)`. Extender backup JSON v2 con ubicaciones; backup JSON v1 importa sin inventar datos.

**Dependencias/modelo.** Depende de U-DAT-06, RLS y FK usuario en árbol y asociación; una ubicación actual por copia, historial explícito solo si se pide. Fotos en bucket privado Supabase Storage por usuario; límites, formatos, compresión, retención y purga deben definirse antes. No añadir coordenadas GPS ni metadatos EXIF.

**Criterios de aceptación.** La estantería lógica sigue funcionando sin ubicación física; cambiar una ubicación no altera colección ni estado; una ubicación vacía se puede conservar; la foto no es pública ni viaja a Open Library; JSON antiguo importa con ubicación vacía.

**Pruebas locales.** Árbol padre/hijo, ciclos, borrar ubicación ocupada, asignar/mover libro, usuario cruzado, foto inválida, EXIF eliminado, reemplazo y restauración de exportación.

**Despliegue/recuperación.** Esquema y bucket aditivos; primera fase puede lanzarse sin fotos. Desactivar gestión sin perder metadatos; purga separada y auditada de objetos al eliminar ubicación/cuenta.

**Esfuerzo: L.**

### U-PRO-04 · Préstamos con datos mínimos y privacidad

**Objetivo.** Recordar qué ejemplar está prestado y cuándo se espera su devolución, sin construir una libreta de contactos.

**Alcance.** Registrar préstamo activo, nombre corto o alias manual de la persona, fecha de salida, vencimiento opcional, fecha de devolución y nota opcional. No solicitar correo, teléfono, dirección ni enviar mensajes. Una ficha muestra historial; estado de préstamo es independiente de `read/reading/unread`.

**Archivos y contratos propuestos.** Ficha de copia, listado «Prestados», resumen y acciones `app/actions/loans.ts` (nuevo). Modelo conceptual `loans(id,user_id,copy_id,borrower_label,loaned_on DATE,due_on DATE,returned_on DATE,note)`; un préstamo activo por copia y cuenta, índice filtrado. Extender backup JSON v2; al importar JSON v1 no inventar préstamos.

**Dependencias/modelo.** Depende de U-DAT-06, privacidad de datos de terceros, RLS, FK compuesta a copia y retención del historial; definir eliminación de préstamo y exportación. Las fechas que el usuario introduce solo como fecha civil se guardan como `DATE` local sin conversión UTC; timestamps de eventos se guardan UTC.

**Criterios de aceptación.** Prestar no cambia estado de lectura; devolución cierra el préstamo y permite uno nuevo; las fechas ausentes se expresan como «sin fecha acordada»; el sistema nunca afirma que envió recordatorio; no se revela al usuario de otra cuenta.

**Pruebas locales.** Préstamo, devolución, préstamo sucesivo, duplicado concurrente, fecha/huso, libro borrado, permisos A/B y exportación/importación.

**Despliegue/recuperación.** Tabla opcional y aditiva; activación independiente de edición bibliográfica. Si se retira el flujo, mantener datos exportables y no borrar historial automáticamente.

**Esfuerzo: M.**

### U-PRO-05 · Series y orden de volúmenes

**Objetivo.** Agrupar ediciones de libros en una serie sin convertir series completas en un único libro ni asumir el orden por título.

**Alcance.** Permitir crear/editar una serie privada con título y descripción opcional; vincular cada edición a cero o una serie y guardar posición `NUMERIC` opcional, etiqueta de volumen opcional y nota de orden. Permitir ediciones independientes, series incompletas y orden desconocido; no derivar identidad de serie del ISBN.

**Archivos y contratos propuestos.** Ficha de edición, catálogo/filtrado, rutas `/series` y `/series/[id]`, `app/actions/series.ts` (nuevo), backup JSON v2 extendido. DTO `SeriesEdition { seriesId, editionId, position?: string, volumeLabel?: string }`; representar `NUMERIC` sin flotantes con redondeos inconsistentes y no usar ISBN como ID de serie.

**Dependencias/modelo.** Depende de U-DAT-06 y la entidad privada de serie acordada en ese contrato; `series_editions(user_id,series_id,edition_id,position NUMERIC,volume_label)` con FKs del mismo propietario y posición no negativa; definir unicidad de edición por serie y colación de orden. No asumir serie compartida globalmente a partir de ISBN.

**Criterios de aceptación.** Un libro no perteneciente a serie conserva la ficha igual; orden desconocido aparece como tal, nunca se infiere de publicación; mover o borrar una serie no borra libros; otro usuario no puede enlazar sus libros; importación vieja queda sin serie.

**Pruebas locales.** Crear serie, añadir/mover/quitar volumen, orden 1/1.5/2, título repetido en otra cuenta, borrar serie, datos faltantes, exportación y permisos.

**Despliegue/recuperación.** Modelo aditivo, serie oculta si se desactiva UI. Mantener relación y exportación al retroceder versión.

**Esfuerzo: M.**

## Exclusiones explícitas

No se propone feed, comunidad, comentarios públicos, recomendaciones sociales, seguimiento de amistades ni rediseño integral. No se propone cámara siempre activa, lectura online obligatoria para el alta manual, control 3D libre ni sincronización de escrituras offline. Cada función personal permanece privada por cuenta y puede omitirse sin degradar el catálogo base.

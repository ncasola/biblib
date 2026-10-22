# Auditoría de BibLib — 22 de octubre de 2026

BibLib tiene una base adecuada para una biblioteca personal: identidad visual reconocible, autenticación con Google, acciones de servidor, separación por usuario con RLS y un catálogo sencillo. La mejora con mayor retorno es completar y hacer fiables los flujos existentes: editar, organizar, buscar, importar y recuperarse de errores. Después conviene ampliar las funciones de lectura y catalogación.

Este documento contiene **35 hallazgos priorizados**, propuestas de producto y un orden de ejecución. Es una auditoría; las correcciones propuestas aquí todavía no se han aplicado. Se conserva el trabajo anterior de importación y obtención de portadas.

## Alcance y método

- Revisión de las rutas de aplicación, componentes de dominio, autenticación, API de libros, acciones, esquema, migración, estilos, configuración y pruebas.
- Comprobación HTTP local de acceso sin sesión y callback OAuth. Navegador Chrome sin sesión, en producción local, a 375 y 1440 píxeles.
- Ejecución de `pnpm lint`, `pnpm test:import`, `pnpm exec tsc --noEmit`, `pnpm list next react react-dom --depth 0` y `pnpm audit --prod --json`.
- Consulta de documentación oficial y avisos de seguridad de los mantenedores para interpretar los resultados.
- Revisión del manifiesto de acciones del build existente para distinguir una función exportada de un endpoint realmente emitido.

No se ha iniciado sesión con Google, modificado la colección ni ejecutado migraciones. Los flujos privados se han revisado en código. No se han medido Core Web Vitals, carga concurrente ni consultas en producción. Los riesgos que dependen del despliegue, de la exposición de Supabase o de concurrencia se indican expresamente; no equivalen a una explotación demostrada.

Las referencias `archivo:línea` corresponden al estado del repositorio durante esta auditoría.

## Resultado de las comprobaciones

| Comprobación | Resultado | Interpretación |
| --- | --- | --- |
| Lint | Pasa | No detecta los errores de tipos ni los problemas de flujo descritos aquí. |
| Pruebas de importación | 9 de 9 pasan | Cubren validación y enriquecimiento de portadas; no ejercitan escrituras reales ni RLS. |
| TypeScript global | Falla | Errores en `components/ui/chart.tsx` y `lib/db/client.ts`. |
| Build disponible | Ejecutable; omite validar tipos | `ignoreBuildErrors: true` permite compilar con errores. El build se había generado en la fase anterior. |
| Versiones instaladas | Next 16.0.8; React y React DOM 19.2.1 | No coinciden con el lockfile: Next 16.2.12 y React/React DOM 19.2.8. |
| Auditoría de producción del lockfile | 12 avisos: 3 críticos, 5 altos, 3 moderados, 1 bajo | Son avisos de dependencias, con condiciones de aplicación diferentes. No son 12 vulnerabilidades explotables demostradas en BibLib. |
| `/books` sin sesión | HTTP 307 a `/login?redirect=%2Fbooks` | Protección de navegación presente. |
| `/` y `/book/<uuid>` sin sesión | HTTP 200 | Falta coherencia de navegación; las acciones siguen comprobando la sesión. |
| Callback con `next=https://example.com` | HTTP 307 a `https://example.com/` | Redirección externa no validada, reproducida sin código OAuth. |
| Navegador | Error React 418 en la secuencia de navegación | Incompatibilidad entre HTML del servidor y cliente; véase FE-01. |
| Inicio sin sesión | Contadores a cero | La falta de autorización se presenta como biblioteca vacía. |
| Inicio a 375/1440 px | Sin desbordamiento horizontal en esas comprobaciones | No permite concluir lo mismo sobre las pantallas privadas. |
| Inicio, DOM | 3 botones dentro de enlaces; 2 botones sin nombre accesible | Defectos de semántica y accesibilidad comprobados. |
| Tema oscuro | Clase `dark`, pero `color-scheme: light` | Los controles nativos conservan el esquema claro. |

Capturas de la comprobación: [inicio oscuro](auditoria-2026-10-22/inicio-oscuro.png) y [acceso en móvil](auditoria-2026-10-22/acceso-movil.png). El inicio se capturó sin sesión: sus ceros no representan una colección real.

## Prioridades y esfuerzo

- **P0:** resolver primero cuando se cumpla la condición de exposición indicada.
- **P1:** siguiente bloque de trabajo: seguridad, confianza en los datos y tareas principales.
- **P2:** mejora importante una vez estabilizados los flujos principales.
- **P3:** mantenimiento o ampliación de menor urgencia.

Esfuerzo orientativo para una persona familiarizada con el proyecto: **XS** menos de media jornada; **S** media a dos jornadas; **M** tres a cinco jornadas; **L** seis a diez jornadas. Incluye validación básica. Las estimaciones se solapan y no deben sumarse como presupuesto cerrado.

## Seguridad y autenticación

### SEC-01 · Dependencias desactualizadas y entorno no reproducible

**P0 si el servidor afectado se expone en Windows; P1 para normalizar y actualizar el conjunto · S–M · Confirmado, exposición condicionada.**

`package.json` y `pnpm-lock.yaml` declaran versiones distintas de las instaladas. La aplicación local se está ejecutando con Next 16.0.8 y React 19.2.1, mientras que la auditoría del lockfile analiza Next 16.2.12 y React 19.2.8. Por tanto, las pruebas actuales no validan exactamente lo que instalaría un despliegue limpio.

El registro devuelve tres avisos críticos de Next. Su alcance requiere distinguir:

| Aviso | Aplicación a BibLib |
| --- | --- |
| [Ejecución remota en servidores Windows](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36) | El desarrollo se realiza en Windows y las versiones observadas están en el rango afectado. Hay que confirmar el sistema del servidor publicado; no se ha intentado explotar. El mantenedor indica corrección en 16.3.3. |
| [Optimización de AVIF](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4) | `images.unoptimized: true` reduce la superficie de la función afectada. Debe revisarse antes de activar optimización. |
| [Generación `next/og` con SVG no confiable](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j) | No se ha encontrado uso de `ImageResponse`/`next/og` en la aplicación. No se identifica un flujo explotable de ese aviso en el código revisado. |

También hay avisos en `sharp`, `source-map-js`, `nanoid` y otros de Next. Por ejemplo, el [aviso de SSRF en optimización](https://github.com/vercel/next.js/security/advisories/GHSA-cjq9-62q9-8jv4) exige patrones remotos, ausentes en esta configuración. El [aviso de `sharp`/librsvg](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w) tiene condiciones de plataforma y procesamiento de imágenes específicas.

**Aplicar:** fijar versión de Node y pnpm; actualizar las dependencias afectadas y revisar los overrides; instalar de manera reproducible con lockfile congelado; repetir tipos, pruebas y build sobre esa instalación. Los avisos obtenidos señalan correcciones de Next hasta 16.3.8 y de `sharp` hasta 0.35.5; verificar de nuevo los rangos al ejecutar la actualización. Evitar `latest` en dependencias directas. Respetar la configuración explícita de scripts de instalación al revisar `sharp`.

**Cierre:** el entorno instalado coincide con el lockfile y los avisos pendientes tienen resolución o una justificación de alcance registrada.

**Evidencia:** `package.json`, `pnpm-lock.yaml:138`, `pnpm-workspace.yaml`, `next.config.mjs:7`; salidas de `pnpm list` y `pnpm audit`.

### SEC-02 · Redirección abierta en el callback de acceso

**P1 · XS–S · Reproducido.**

El callback pasa `next` directamente a `new URL(next, url.origin)`. Una URL absoluta o una ruta que cambie de origen permite salir a otro sitio. El endpoint redirige incluso sin código OAuth y tampoco comprueba el error de intercambio de sesión. Esto permite construir enlaces de BibLib que terminan en una web ajena; no demuestra robo de la sesión de Google.

**Aplicar:** resolver el destino y exigir exactamente el origen de BibLib y una ruta interna admisible. Ante ausencia/error de código, presentar un error de acceso con reintento. Conservar el destino interno original cuando el acceso funcione.

**Cierre:** destinos externos, incluidos los que comienzan por `//`, no producen redirecciones fuera de BibLib; un código inválido no simula éxito.

**Evidencia:** `app/auth/callback/route.ts:7`, `:11`, `:14`. Petición local sin cookies: `/auth/callback?next=https://example.com` → 307 externo.

### SEC-03 · Validación de entrada desigual en las operaciones de dominio

**P1 · M · Confirmado en código.**

La importación ya valida con Zod, pero el alta, el cambio de estado y varias operaciones de estanterías confían en tipos TypeScript o en la validación HTML. Estos tipos no validan solicitudes en ejecución. Se pueden enviar títulos vacíos, páginas negativas, estructuras inesperadas o identificadores inválidos; algunas entradas fallarán tarde en Postgres y otras pueden persistirse.

**Aplicar:** contratos de entrada compartidos para alta, edición, estado y estanterías: UUID, longitudes, campos recortados, páginas no negativas, autores, estado y URL de portada. Separar el DTO de creación del objeto `Book` completo. Traducir conflictos de unicidad y recursos inexistentes a errores de dominio claros.

**Cierre:** las entradas incorrectas se rechazan antes de escribir y producen mensajes de campo en español; los duplicados concurrentes no acaban en un error genérico.

**Evidencia:** `app/actions/books.ts:26`, `:55`, `:73`; `app/actions/shelves.ts:23`, `:39`, `:78`; `app/api/books/add/route.ts:7`. [Criterio oficial de Next sobre validar entradas y autorizar acciones](https://nextjs.org/docs/app/guides/data-security).

### SEC-04 · La relación libro–estantería no impone el mismo propietario en la base de datos

**P1 · M · Deficiencia de esquema confirmada; acceso directo no comprobado.**

La FK enlaza únicamente `books.shelf_id` con `shelves.id`. Las políticas verifican el propietario de cada fila, pero no que la estantería referenciada pertenezca al dueño del libro. Las acciones de alta y movimiento sí comprueban la pertenencia, lo cual protege esos flujos. Si el esquema se expone mediante otra vía con los permisos `authenticated` concedidos, la base no impide por sí sola una referencia entre usuarios. Las [comprobaciones de integridad referencial no quedan limitadas por RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

**Aplicar:** FK compuesta `(user_id, shelf_id)` → `(user_id, id)` con la restricción única correspondiente; revisar los permisos necesarios y la exposición real del esquema en Supabase. Si la estantería predeterminada debe ser inmutable por cualquier vía, reforzar también esa regla en la base.

**Cierre:** pruebas con usuarios A y B demuestran que A no puede crear ni mover un libro a una estantería de B, incluso accediendo directamente con el rol autenticado. No se afirma que A pueda leer la biblioteca de B con el código actual.

**Evidencia:** `lib/db/schema.ts:68`, `:85`; `drizzle/0000_biblib_init.sql:38`, `:114`.

### SEC-05 · Protección de rutas y renovación de sesión incompletas

**P1 · S–M · Rutas reproducidas; renovación pendiente de prueba autenticada.**

`/` y `/book/[id]` no están en las rutas protegidas. Esto produce experiencias distintas para un visitante: unas rutas llevan al acceso y otras muestran una colección vacía o «libro no encontrado». Las acciones conservan su comprobación de usuario. Además, el adaptador del proxy escribe cookies en la respuesta inicial, pero las respuestas de redirección se construyen aparte; no se propagan explícitamente esas cookies ni se actualiza la solicitud en `setAll`.

**Aplicar:** layout autenticado coherente, manteniendo la autorización dentro de cada acción. Si `/` debe ser pública, convertirla en una presentación pública real. Ajustar la propagación de cookies y errores de sesión siguiendo el flujo SSR de Supabase.

**Cierre:** acceso directo, sesión caducada, renovación y vuelta desde Google conservan destino y sesión sin mostrar datos vacíos falsos ni entrar en bucles.

**Evidencia:** `proxy.ts:6`, `:24`, `:32`; `lib/supabase/proxy.ts:17`; `app/book/[id]/page.tsx:27`.

## Backend y acceso a datos

### BE-01 · Un pool de Postgres nuevo en cada operación

**P1 · S · Confirmado en código; impacto bajo carga no medido.**

`getDb()` crea un cliente `postgres()` cada vez que se llama a `withRlsContext`. No hay reutilización ni cierre explícito. `max: 1` limita cada pool individual, no la suma de pools. Una carga de biblioteca ya usa operaciones separadas para asegurar la estantería y leer los datos.

**Aplicar:** cliente/pool reutilizable por proceso, adaptado al despliegue y al pooler de Supabase. Mantener claims y rol locales a cada transacción; tipar el callback como transacción real, eliminando el cast incompatible.

**Cierre:** repetir lecturas no hace crecer sin control el número de conexiones; los contextos de dos usuarios nunca se mezclan.

**Evidencia:** `lib/db/client.ts:6`, `:12`, `:24`, `:34`; `app/actions/library.ts:75`.

### BE-02 · Creación de la estantería predeterminada con carrera de concurrencia

**P1 · S · Riesgo deducido del patrón de código.**

La función consulta si existe y después inserta. Dos primeras solicitudes simultáneas pueden intentar crearla y una fallar por el índice único. El índice evita duplicados, pero la operación completa no es idempotente frente a esa carrera.

**Aplicar:** inserción con resolución explícita de conflicto y lectura del resultado; considerar también el nombre «Predeterminada» cuando ya exista una estantería personalizada con ese título.

**Cierre:** varias solicitudes simultáneas para un usuario nuevo terminan correctamente y dejan una única estantería predeterminada.

**Evidencia:** `app/actions/library.ts:24`, `:27`, `:36`; `lib/db/schema.ts:22`.

### BE-03 · Cada pantalla recibe la colección completa

**P2 · M · Confirmado; degradación a gran escala no medida.**

Inicio, detalle, estanterías, búsqueda y ajustes llaman a la misma lectura completa. El detalle descarga todos los libros para buscar uno; las estadísticas se calculan después de enviarlos al navegador. Los recuentos de estanterías filtran repetidamente los libros, con trabajo proporcional a estanterías × libros. Con 111 libros puede ser aceptable, pero la arquitectura no acota el trabajo al crecer.

**Aplicar:** lecturas específicas de detalle, resumen, estanterías y listado paginado con filtros. Agregaciones SQL para recuentos, selección de columnas necesaria y orden estable. Usar carga inicial en servidor e islas interactivas donde ayude. No compartir caché de datos privados entre usuarios.

**Cierre:** el detalle consulta un libro; el resumen devuelve agregados; el listado tiene límites y conserva una ordenación determinista. Medir con 100, 1.000 y 10.000 libros antes de añadir índices o virtualización.

**Evidencia:** `app/actions/library.ts:73`, `:101`; `app/book/[id]/page.tsx:27`; `app/books/search/page.tsx:186`.

### BE-04 · Open Library confunde «sin resultados» con caída del proveedor

**P1 · S–M · Confirmado en código.**

La búsqueda individual carece de timeout y validación de respuesta en ejecución. Un 429, 500, JSON incorrecto o error de red acaba como `null`, que el endpoint convierte en 404 «Libro no encontrado». El saneamiento borra caracteres arbitrarios, no verifica el checksum y elimina una `x` minúscula válida de ISBN-10. El enriquecimiento de importación ya tiene mejores defensas, pero existe lógica duplicada.

**Aplicar:** adaptador común con normalización de ISBN, validación de respuesta, timeout, límites de uso, caché del resultado bibliográfico y errores separados: ISBN inválido, sin ficha, cuota y proveedor no disponible. Revisar la política de uso del proveedor al implementar la limitación. El endpoint de búsqueda es público: limitar abuso aunque se decida mantenerlo público.

**Cierre:** un 429 no se comunica como libro inexistente; las peticiones tienen duración acotada; la misma entrada se interpreta igual al buscar e importar.

**Evidencia:** `lib/api-client.ts:16`, `:20`, `:24`, `:69`; `app/api/books/search/route.ts:16`; `lib/library-import.ts:56`.

### BE-05 · Utilidad interna de identidad dentro de un módulo de acciones

**P2 · S · Riesgo de diseño; endpoint no observado en el build revisado.**

`ensureDefaultShelf(userId)` se exporta desde un archivo `"use server"` y construye un contexto RLS a partir del argumento, sin autenticar dentro de esa función. Hoy sus llamadas observadas proceden de otras acciones que obtienen el usuario de la sesión. Además, no figura en el manifiesto de acciones emitido revisado. Por ello no se clasifica como un acceso entre usuarios demostrado. Su ubicación facilita que una futura referencia desde cliente la convierta accidentalmente en una acción insegura.

**Aplicar:** mover la utilidad a un módulo interno `server-only`, centralizar la obtención de identidad y reservar los módulos de acciones para entradas autenticadas y validadas.

**Cierre:** ninguna entrada pública acepta un `userId` para decidir el contexto de autorización. [Next recomienda tratar las acciones como entradas de red y comprobar su autorización](https://nextjs.org/docs/app/guides/data-security).

**Evidencia:** `app/actions/library.ts:24`; `.next/server/server-reference-manifest.json`; importaciones desde `app/actions/books.ts` y `shelves.ts`.

### BE-06 · Contratos de escritura y errores HTTP poco precisos

**P2 · S–M · Confirmado en código.**

Las escrituras devuelven `void`, incluso cuando un `UPDATE` no afecta a ninguna fila. `/api/books/add` devuelve el objeto enviado, cuyo identificador no es necesariamente el generado por Postgres; salvo el duplicado, convierte los fallos en 500 y puede incluir el mensaje técnico original.

**Aplicar:** resultados de dominio con recurso/ID persistido, códigos de error y comprobación de filas afectadas. Traducir a HTTP 400/401/404/409/500 según corresponda. Mantener la API alternativa solo si tiene consumidores, reutilizando el mismo servicio de dominio.

**Cierre:** no hay éxitos silenciosos para recursos inexistentes; el ID devuelto abre el libro creado; los errores internos no se presentan sin filtrar.

**Evidencia:** `app/actions/books.ts:26`, `:73`; `app/actions/shelves.ts:39`; `app/api/books/add/route.ts:9`.

## Importación, exportación y calidad bibliográfica

### IMP-01 · Sustitución de colección sin revisión previa ni recuperación integrada

**P1 · M · Confirmado en código.**

Seleccionar un JSON válido dispara directamente la sustitución de libros y estanterías personalizadas. Hay un aviso escrito, pero no una revisión concreta de qué se elimina ni una confirmación posterior al análisis. Incluso una colección vacía válida puede sustituir la existente. La escritura ya es transaccional, lo cual evita pérdidas parciales por un fallo SQL; no evita sustituir datos por un archivo equivocado.

**Aplicar:** asistente «seleccionar → validar → revisar → confirmar → resultado». Mostrar cantidades, errores, duplicados y cambios. Ofrecer «añadir/fusionar» y «reemplazar» con reglas explícitas. Facilitar copia previa y una restauración verificable.

**Cierre:** elegir un archivo no escribe nada; se puede cancelar tras revisar; reemplazar informa del número de libros actuales afectados y de los que quedarán.

**Evidencia:** `app/settings/page.tsx:48`, `:57`, `:153`; `app/actions/library.ts:114`.

### IMP-02 · Importación larga sin límites de aplicación ni trabajo reanudable

**P1 · M–L · Confirmado; límites del alojamiento sin comprobar.**

Se lee todo el archivo en memoria; no hay límite explícito de archivo, libros o longitud de campos. Las portadas se consultan dentro de la misma solicitud y cada libro se inserta por separado. Los lotes y timeout ya limitan cada consulta externa, pero no la duración total. Ante caída del proveedor se conserva la importación con fallback, sin informar cuántas portadas se recuperaron ni por qué se detuvo la búsqueda.

**Aplicar:** límites documentados, inserciones por lotes y resumen `importados / omitidos / portadas encontradas / pendientes`. Para colecciones que excedan el presupuesto de tiempo del despliegue, usar trabajo persistente con estado, reintento e idempotencia. No hace falta una cola externa compleja para la colección pequeña antes de medir.

**Cierre:** archivos fuera de límite se rechazan antes de procesarlos; la interfaz diferencia importación completada de enriquecimiento parcial; recargar no duplica una operación reintentada.

**Evidencia:** `app/settings/page.tsx:56`; `app/actions/library.ts:111`, `:139`; `lib/library-import.ts:71`, `:105`.

### IMP-03 · Copia de seguridad sin versión y restauración que cambia identificadores

**P2 · M · Confirmado en código.**

El JSON no tiene `formatVersion`, fecha de exportación ni reglas de migración. Importar regenera los IDs de libros y estanterías personalizadas; los enlaces guardados pueden dejar de funcionar. La estantería predeterminada local se conserva y su nombre no se restaura. Una estantería importada personalizada con el mismo nombre puede chocar con su índice único. Las referencias a estanterías inexistentes se envían silenciosamente a la predeterminada.

**Aplicar:** formato versionado y migraciones, validación de referencias y advertencias por reasignación. Definir si restaurar conserva IDs seguros dentro del mismo usuario, cómo se importan copias de otro usuario y qué ocurre con la estantería predeterminada. Exportar desde una lectura reciente, no solo desde el estado cargado al entrar en ajustes.

**Cierre:** pruebas de ida y vuelta preservan los datos definidos por el formato; cualquier cambio de IDs o estantería queda explicado; una referencia rota no se corrige silenciosamente.

**Evidencia:** `lib/types.ts:39`; `app/settings/page.tsx:30`; `app/actions/library.ts:118`, `:125`, `:140`.

### IMP-04 · ISBN usado a la vez como identificador interno y dato de edición

**P1 para normalización y procedencia; P2 para ampliar el modelo · M–L · Confirmado en código.**

El campo obligatorio `isbn` contiene también identificadores `manual-...`. La unicidad compara el texto exacto: un ISBN con guiones y otro sin ellos se consideran distintos, al igual que ISBN-10 y su equivalente ISBN-13. Tampoco se representa si el ISBN identifica la edición física o es una referencia provisional. Esto importa especialmente para los libros obtenidos de las fotos: una ficha pública de la misma obra no garantiza la misma edición.

**Aplicar:** mantener un ID interno independiente, ISBN opcional y normalizado, y procedencia/estado de verificación de la ficha. Distinguir obra, edición y ejemplar de forma gradual; decidir explícitamente si se permiten varias copias de la misma edición. La portada bibliográfica no debe presentarse como confirmación de la edición física.

**Cierre:** las variantes de un ISBN no duplican accidentalmente una edición; los libros sin ISBN no necesitan simularlo; los datos provisionales siguen identificados como tales después de importar y exportar.

**Evidencia:** `lib/db/schema.ts:57`, `:75`; `components/manual-book-form.tsx:32`; `lib/library-import.ts:39`; artefactos de procedencia en `imports/biblioteca-fotos-2026-10-22/`.

## UX y funcionalidades existentes

### UX-01 · Falta edición bibliográfica completa

**P1 · M · Ausencia confirmada en rutas y acciones revisadas.**

El detalle permite cambiar estado y eliminar, pero no corregir título, autor, ISBN, editorial, páginas o portada. Una catalogación a partir de fotos necesita correcciones posteriores.

**Aplicar y verificar:** formulario de edición con datos actuales, validación, portada sustituible y control de cambios concurrentes. Guardar una corrección debe conservar ID, estantería y estado. No usar eliminar y volver a crear como proceso de edición.

**Evidencia:** `app/book/[id]/page.tsx:42`, `:54`; `app/actions/books.ts`.

### UX-02 · Organizar libros en estanterías no está conectado a la interfaz

**P1 · M · Confirmado por búsqueda de usos.**

Existe `moveBookShelfAction`, pero no tiene llamadas desde la interfaz. El alta manual deja la estantería vacía para usar la predeterminada; el alta por ISBN tampoco permite elegirla. El detalle solo muestra su nombre y las tarjetas de estantería no abren un listado filtrado.

**Aplicar y verificar:** selector de estantería en alta y detalle, tarjetas que abran la colección filtrada y selección múltiple para mover libros. Debe ser posible crear una estantería, asignarle un libro y comprobar su contenido sin importar JSON.

**Evidencia:** `app/actions/shelves.ts:78`; `components/manual-book-form.tsx:46`; `app/book/[id]/page.tsx`; `components/shelf-card.tsx`.

### UX-03 · El perfil comunica un guardado inexistente

**P1 · S–M · Confirmado en código.**

El envío espera un segundo y muestra «Perfil actualizado correctamente», sin persistir nombre ni correo. El botón de cámara no tiene acción. Los campos se inicializan antes de que termine la carga de usuario y no se sincronizan después, por lo que también pueden aparecer vacíos.

**Aplicar y verificar:** persistir el nombre mediante el mecanismo real de perfil y mostrar el correo de Google como dato informativo salvo que se implemente un cambio de identidad. Implementar el avatar o retirar temporalmente ese control. Tras recargar, el valor guardado debe mantenerse; el éxito solo aparece después de confirmar la escritura.

**Evidencia:** `app/profile/page.tsx:17`, `:27`, `:66`, `:101`.

### UX-04 · Errores presentados como colección vacía y mutaciones sin feedback fiable

**P1 · M · Confirmado; inicio reproducido sin sesión.**

Varias cargas capturan cualquier fallo y muestran cero libros. El detalle puede mostrar «no encontrado» por un error de red o autorización. Crear/renombrar estanterías y algunas operaciones del detalle carecen de captura y estado pendiente; el diálogo de renombrado se cierra sin esperar el resultado. Los errores de alta alternan entre `alert` genérico y mensajes del servidor.

**Aplicar y verificar:** separar carga, vacío, sin resultados, sin sesión, recurso ausente y error recuperable. Botón de reintento, mensajes junto al control, bloqueo de doble envío y cierre del diálogo solo tras éxito. Una caída de red debe conservar los datos visibles y el texto introducido.

**Evidencia:** `app/page.tsx:23`; `app/books/page.tsx:24`; `app/shelves/page.tsx:40`; `components/shelf-card.tsx:21`; `app/book/[id]/page.tsx:35`.

### UX-05 · Dos experiencias de búsqueda con capacidades diferentes

**P1 · M · Confirmado en código.**

La tabla busca por título y autor; la búsqueda avanzada añade ISBN y estado, pero no tiene un acceso principal claro en la navegación. El botón con lupa de esa pantalla no ejecuta ninguna acción: los resultados cambian al escribir. Los filtros viven en memoria y se pierden al navegar; no hay búsqueda sin tildes ni limpieza conjunta de filtros. Fechas bibliográficas libres se ordenan con `new Date()`, que puede producir resultados inválidos.

**Aplicar y verificar:** una colección con vistas tabla/cuadrícula y filtros compartidos en URL (`q`, estado, estantería, orden y página). Búsqueda normalizada en español e ISBN, acción «Limpiar filtros», fecha parcial representada con precisión explícita. Volver desde un detalle debe recuperar consulta y posición.

**Evidencia:** `components/books-table.tsx:124`; `app/books/search/page.tsx:18`, `:73`, `:115`; `components/header.tsx`.

### UX-06 · Recuento de paginación incorrecto al filtrar

**P1 · S · Deducible directamente del cálculo; pendiente de interacción autenticada.**

El extremo final usa el tamaño anterior al filtro de texto, mientras que el total usa las filas filtradas. Con 111 libros y una coincidencia puede indicar «Mostrando 1 a 10 de 1». Sin coincidencias, el inicio sigue siendo 1 y no hay fila explicativa de ausencia de resultados.

**Aplicar y verificar:** calcular inicio/final con el total filtrado y las filas de la página real. Mostrar «0 resultados» y una acción para limpiar. Probar 0, 1, 10 y 11 resultados y un filtro aplicado desde una página posterior.

**Evidencia:** `components/books-table.tsx:216`, `:219`, `:221`.

### UX-07 · Renombrar la estantería predeterminada parece disponible, pero no hace nada

**P2 · XS–S · Confirmado en código.**

La tarjeta muestra «Renombrar» también para la predeterminada; la acción filtra `isDefault = false`, no modifica filas y devuelve éxito sin resultado. El diálogo se cierra igualmente.

**Aplicar y verificar:** decidir si el nombre es editable. Si no lo es, ocultar esa acción con explicación breve; si lo es, permitir renombrar conservando la protección contra eliminación. Nunca simular un guardado sin filas afectadas.

**Evidencia:** `components/shelf-card.tsx:49`, `:85`; `app/actions/shelves.ts:53`.

### UX-08 · Alta por ISBN con poca capacidad de revisión y continuidad

**P2 · M · Confirmado en código.**

El resultado se añade directamente con estado «Por leer», sin elegir estado/estantería ni corregir la ficha. Tras tres segundos, el botón vuelve a permitir añadir el mismo libro. Ante ausencia de ficha, no se ofrece transferir el ISBN al formulario manual. Hay textos «Try» en inglés y el parseo de autores por comas no representa bien todos los nombres.

**Aplicar y verificar:** revisar y editar la ficha antes de guardar, elegir destino/estado, detectar duplicado con enlace al existente y ofrecer «Guardar y añadir otro». Precompletar el alta manual si falla la búsqueda. Autores como entradas separadas. Mantener todo el texto en español.

**Evidencia:** `components/book-search-result.tsx:17`, `:25`; `lib/api-client.ts:60`; `components/manual-book-form.tsx:35`; `app/books/add/page.tsx`.

### UX-09 · Vista 3D con controles anunciados ausentes y acceso limitado

**P2 · M · Confirmado en código.**

La ayuda promete arrastrar, zoom y desplazamiento con clic derecho, pero el visor solo implementa hover. Los libros parecen pulsables y no abren el detalle; no se pueden enfocar por teclado y el tooltip depende del ratón. Se fijan seis libros por balda y alturas sin máximo según páginas, lo que requiere validación en móvil. Las imágenes de fondo no tienen recuperación de error y el fallback no muestra título porque la URL genérica es una cadena no vacía.

**Aplicar y verificar:** alinear la ayuda con funciones reales; enlaces accesibles al detalle, interacción táctil y teclado, alturas acotadas y composición responsiva. Mantener una vista 2D equivalente. Implementar rotación/zoom solo si aportan valor frente a mejorar selección y legibilidad.

**Evidencia:** `app/shelves/3d/page.tsx:88`; `components/shelf-viewer-3d.tsx:14`, `:34`, `:62`, `:79`, `:89`.

## UI, accesibilidad y frontend

### UI-01 · Jerarquía visual poco orientada al uso frecuente

**P2 · M · Propuesta de diseño basada en las pantallas y el código.**

El inicio dedica gran parte del espacio a bienvenida y tarjetas de navegación, sin enseñar lecturas actuales o libros recientes. El mismo nivel de sombras, bordes, blur y escala se aplica a muchos elementos, de modo que las acciones compiten. La cabecera de estanterías mantiene título y botón en una fila sin adaptación explícita a móvil; debe verificarse con nombres largos y zoom.

**Aplicar:** conservar crema, rojo, oliva, logo y formas redondeadas; usar una acción primaria por pantalla, superficies más tranquilas para los datos, espaciado y tipografía compartidos. Inicio con «Continuar leyendo», últimas altas y acceso a buscar/agregar. En móvil, filtros compactos, tarjetas legibles y acciones principales accesibles sin desplazamiento excesivo.

**Cierre:** recorridos de añadir, encontrar y mover un libro funcionan a 320/375/768 px y con zoom; el contenido principal tiene prioridad sobre decoración.

**Evidencia:** captura de inicio; `app/page.tsx`; `app/shelves/page.tsx:75`; `app/books/page.tsx`.

### UI-02 · Tokens de color incompletos y contraste por verificar

**P1 para legibilidad; P2 para unificar el sistema · S–M · Tokens ausentes confirmados; contraste no medido integralmente.**

Se usan `bg-surface`, `text-foreground-light` y `hover:text-primary-dark` sin tokens correspondientes en `globals.css`. Algunos colores vintage se mantienen iguales en claro/oscuro; marrón y morado se perciben débiles en el inicio oscuro. Los títulos usan un degradado que incluye amarillo, y hay texto amarillo en avisos claros. Las variables OKLCH tampoco son equivalencias literales de los HEX documentados en `agents.md`.

**Aplicar:** tokens semánticos completos para superficies, texto secundario, acciones y estados; variantes específicas por tema; reservar el amarillo para acentos o combinarlo con texto oscuro. Usar texto sólido donde el degradado comprometa lectura. Medir combinaciones reales sobre transparencias, no solo muestras de paleta.

**Cierre:** texto normal con contraste mínimo 4,5:1 y texto grande 3:1, según [WCAG 2.2, contraste mínimo](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). No se asigna aquí una certificación de conformidad.

**Evidencia:** `app/globals.css:6`, `:92`, `:157`; usos en tabla, formularios y detalle; captura de inicio oscuro.

### UI-03 · Nombres accesibles, teclado y semántica incompletos

**P1 · M · Parte reproducida en DOM; resto confirmado en código.**

Faltan nombres accesibles en tema, menú móvil y paginación. El menú móvil no declara expansión/relación con el panel. Varias etiquetas no están asociadas a controles. Los encabezados ordenables de tabla responden al clic sobre `<th>`, sin botón de teclado ni `aria-sort`. Hay botones dentro de enlaces. El visor depende del hover y los mensajes finales no se anuncian consistentemente. Las animaciones propias no incluyen una adaptación explícita a movimiento reducido.

**Aplicar y verificar:** `aria-label`, `aria-expanded`, asociación de etiquetas, botones de orden reales, enlaces sin controles anidados, foco visible y regiones de estado/error. Usar `Button asChild` cuando la acción sea navegar. Añadir salto al contenido y respetar movimiento reducido.

**Cierre:** completar los flujos principales solo con teclado; comprobar foco en diálogos, anuncios de error y nombres de controles con lector de pantalla. Automatizar comprobaciones de accesibilidad como complemento a esa revisión.

**Evidencia:** `components/header.tsx:66`, `:116`; `components/books-table.tsx:90`, `:183`, `:232`; `app/books/search/page.tsx:107`; DOM del inicio.

### FE-01 · Hidratación y tema inconsistentes

**P1 · S–M · Error y `color-scheme` reproducidos; causa exacta pendiente de aislar.**

El navegador registra React 418, que significa [fallo de hidratación entre servidor y cliente](https://react.dev/errors/418). El hook usa valores distintos durante el render del servidor y del navegador (`typeof window`, preferencia del sistema y `localStorage`), e inmediatamente decide qué icono renderizar. También hay HTML interactivo anidado que conviene corregir. El hook aplica `.dark`, mientras que `color-scheme: dark` depende de un atributo `data-theme` que no se establece. El acceso no monta `Header`, de modo que en una entrada directa tampoco inicializa el tema global desde ese hook.

**Aplicar:** un único proveedor de tema en el layout, con inicialización anterior al pintado y render inicial estable. Reutilizar la dependencia de tema ya existente si encaja. Unificar selector CSS y esquema nativo. Aislar el error en desarrollo después de normalizar las dependencias.

**Cierre:** cargar directamente acceso e inicio en ambos temas no genera error de hidratación ni destello visible; `color-scheme` coincide con el tema y se conserva al navegar.

**Evidencia:** `hooks/use-theme.ts:6`, `:7`, `:15`; `app/globals.css:139`; `app/layout.tsx:33`; registro de Chrome.

### FE-02 · Tratamiento de portadas y coste de imágenes

**P2 · M · Configuración y composición confirmadas; coste no medido.**

La optimización de Next está desactivada globalmente. Hay varias implementaciones del fallback y la cuadrícula recorta portadas verticales en cajas anchas de altura fija con `object-cover`. El visor usa imágenes de fondo sin las mismas garantías. Las URLs externas siguen dependiendo de la disponibilidad del proveedor: recuperar una URL no equivale a almacenar una copia de la imagen.

**Aplicar:** componente `BookCover` compartido, proporción de portada consistente y `object-contain` cuando se necesite mostrarla completa. Evaluar caché/optimización tras actualizar dependencias y definir hosts permitidos y presupuesto de almacenamiento. Añadir reemplazo manual y «Buscar portada» para libros ya guardados; mostrar claramente la falta de portada.

**Cierre:** una URL rota presenta el fallback una sola vez; las portadas no pierden título por recorte; la carga visible usa tamaños adecuados y carga diferida.

**Evidencia:** `next.config.mjs:7`; `app/books/search/page.tsx:188`; `components/shelf-viewer-3d.tsx:79`; `lib/book-covers.ts`.

### FE-03 · Estado de navegación y estructura repetidos por pantalla

**P2 · M · Confirmado en código.**

Cada página monta su cabecera y replica carga/errores; el menú móvil no se cierra explícitamente al elegir una ruta ni muestra ruta activa. La autenticación llega después del primer render. Los metadatos son globales («BibLib») incluso en el detalle, y no hay límites de error específicos en las rutas revisadas.

**Aplicar y verificar:** layout compartido con navegación activa, título por pantalla, manejo de error y carga consistente; mantener filtros y selección en URL. Respetar el estado real de carga de sesión en los componentes dependientes del usuario. Evitar meter toda la aplicación en un único componente cliente.

**Evidencia:** `components/header.tsx:25`; `lib/auth-context.tsx:53`; `app/layout.tsx:7`; páginas de dominio.

### FE-04 · Restos de prototipo y dependencias sin uso de dominio

**P3 · S · Confirmado en las referencias buscadas.**

`lib/storage.ts` conserva persistencia de datos de dominio en `localStorage` y carga de `/data.json`, pero no se han encontrado consumidores actuales. El visor 3D usa CSS y no se ha encontrado uso de la dependencia `three`. También quedan envoltorios y pantallas de autenticación que no aportan funcionalidad al acceso exclusivo con Google.

**Aplicar y verificar:** retirar código y dependencias sin consumidores tras comprobar imports y build. Eliminar los caminos antiguos de persistencia para evitar que se reintroduzca una segunda fuente de datos. Revisar los componentes UI genéricos que generan errores aunque no se utilicen en pantallas.

**Evidencia:** `lib/storage.ts`; `public/data.json`; `package.json`; `components/theme-provider.tsx`; rutas `signup` y `forgot-password`.

## Calidad, base de datos y operación

### QA-01 · La puerta de calidad permite publicar errores de tipos

**P1 · M · Reproducido.**

`ignoreBuildErrors: true` oculta errores de Recharts y del tipo de transacción. No se han encontrado workflows de CI en el repositorio. Las nueve pruebas nuevas son útiles, pero no cubren aislamiento de usuarios, escrituras, OAuth ni recorridos completos.

**Aplicar:** corregir tipos, retirar la omisión, script `typecheck` y CI con instalación congelada, lint, tipos, pruebas y build. Añadir pruebas de integración de RLS con dos usuarios y E2E de los recorridos de mayor riesgo. Usar una base de pruebas aislada.

**Cierre:** una regresión de tipos bloquea el build; las pruebas verifican restauración transaccional, restricciones entre usuarios, duplicados y edición/organización. No aumentar cobertura con pruebas que solo repitan detalles internos.

**Evidencia:** `next.config.mjs:4`; `components/ui/chart.tsx:109`; `lib/db/client.ts:34`; `tests/library-import.test.ts`.

### QA-02 · Esquema y migraciones necesitan una comprobación de equivalencia

**P2 · M · Diferencia confirmada; estado de base desplegada no inspeccionado.**

El esquema declara `books_user_id_id_unique`, ausente en la migración inicial. Hay políticas y activación explícita de RLS en SQL, pero no una prueba que garantice que una instalación nueva, el schema code-first y la base existente coinciden. Faltan restricciones de base para páginas no negativas y texto obligatorio no vacío. La configuración de migración depende de que el entorno proporcione la URL; Next no ejecuta esa CLI.

**Aplicar y verificar:** probar migraciones desde una base vacía y actualización desde la versión anterior, verificar índices/FK/políticas y añadir restricciones de integridad. Documentar la carga de variables de la CLI sin incluir secretos. Medir consultas antes de crear índices de búsqueda o estado.

**Evidencia:** `lib/db/schema.ts:62`, `:76`; `drizzle/0000_biblib_init.sql`; `drizzle.config.ts:8`; `drizzle/meta/_journal.json`.

### OPS-01 · Diagnóstico con logs de depuración y sin medición de operaciones clave

**P2 · S–M · Confirmado en código; herramientas del alojamiento no inspeccionadas.**

La búsqueda registra respuestas y objetos completos con prefijo `[v0]`, mientras que muchos fallos solo llegan a `console.error`. No se observa instrumentación de duración de consultas, fallos de importación, cuotas o tasa de portadas recuperadas. Esto dificulta distinguir un problema de datos de uno del proveedor o la base.

**Aplicar y verificar:** logs estructurados con operación, duración, resultado e identificador de correlación, sin tokens ni contenido completo de bibliotecas. Monitorizar errores de servidor, uso de conexiones y latencia. Medir el frontend en el despliegue real, con separación de datos privados y telemetría.

**Evidencia:** `lib/api-client.ts:19`, `:39`, `:65`; `components/books-table.tsx:106`; `app/layout.tsx:34`.

### OPS-02 · Recuperación, privacidad y archivos personales sin política explícita en el repo

**P2 · M · Falta de documentación/flujo observada; configuración externa desconocida.**

Existe exportación manual, pero no un procedimiento probado de recuperación ni eliminación de cuenta desde la aplicación. Hay Analytics y portadas externas. Las fotos personales y sus catálogos están actualmente sin seguimiento en Git; una subida indiscriminada del directorio podría incluirlos.

**Aplicar y verificar:** documentar retención, proveedores de imágenes/telemetría y tratamiento de datos personales; decidir qué artefactos de biblioteca deben versionarse y cuáles quedar locales. Definir eliminación de cuenta y datos asociados. Documentar y ensayar la restauración desde backup en un entorno aislado. Revisar cabeceras de seguridad y caché de páginas privadas en el alojamiento real; no se afirma que falten allí por no estar en `next.config`.

**Cierre:** se puede exportar, restaurar y solicitar/eliminar la cuenta según la política elegida; una revisión de Git evita publicar fotos por accidente. La existencia de respaldos del proveedor se verifica, no se presupone.

**Evidencia:** `app/settings/page.tsx`; `app/layout.tsx`; `.gitignore`; estado actual de archivos personales sin seguimiento.

## Funcionalidades nuevas recomendadas

Estas son oportunidades de producto, no defectos de seguridad. Su prioridad sigue el uso de una biblioteca personal física y la colección catalogada desde fotografías.

| Función | Beneficio | Prioridad | Esfuerzo y dependencias |
| --- | --- | --- | --- |
| Edición, ubicación y acciones por lotes | Corregir fichas y organizar una colección de más de cien libros con pocas operaciones. | P1 | M; UX-01/02 y validación. |
| Panel de revisión bibliográfica | Mostrar «ISBN provisional», «edición confirmada», «sin portada» y fuente; resolver dudas de las fotos. | P1 | M; IMP-04. |
| Actualizar portadas de libros existentes | Recuperar las pendientes después de una caída sin volver a importar toda la colección. | P1/P2 | M; adaptador y edición. |
| Escáner de código de barras | Añadir libros desde el móvil y validar mejor la edición física. Siempre con entrada manual alternativa. | P2 | M; HTTPS/cámara, validación y compatibilidad por comprobar. |
| Notas, valoración y etiquetas | Hacer útil el catálogo durante y después de leer; separar categorías de ubicación física. | P2 | M; modelo y edición. |
| Progreso y sesiones de lectura | Página actual, fechas de inicio/fin, relecturas y estadísticas con datos reales. | P2 | M–L; modelo específico. Hoy se guarda estado, no progreso por página. |
| Ubicación física por mueble/balda/posición | Encontrar el ejemplar real; conservar la relación con las fotos y no depender de etiquetas temáticas. | P2 | M; decidir relación con estanterías. |
| Préstamos | A quién se prestó un ejemplar, fecha y devolución. | P2 | M; ejemplares y privacidad de contactos. |
| Series y volúmenes | Ordenar sagas y tomos sin confundir obras completas con volúmenes individuales. | P2 | M; obra/edición/ejemplar gradual. |
| CSV y mapeo de columnas | Migrar desde otras herramientas sin preparar el JSON propio. | P2 | M; primero el asistente seguro de importación. |
| Vistas guardadas y colección imprimible | Consultas frecuentes y catálogo útil fuera de la app. | P2/P3 | S–M; filtros en URL. |
| PWA y consulta sin conexión | Acceso cómodo desde el móvil con reglas claras para datos privados y cierre de sesión. | P3 | L; no basta con el manifest actual. Priorizar consulta antes de sincronización de escrituras. |

No priorizaría todavía un sistema de recomendaciones complejo, una red social, un rediseño total ni un motor 3D nuevo. La edición, ubicación, importación segura y revisión de fichas aportan más al uso actual.

## Propuesta de experiencia objetivo

| Pantalla | Comportamiento recomendado |
| --- | --- |
| Inicio | Lecturas en curso, últimas incorporaciones, pendientes de revisar y acceso directo a buscar/agregar. |
| Colección | Buscador único, filtros combinables, tabla/cuadrícula, selección múltiple, cantidades correctas y estado conservado en URL. |
| Alta | ISBN/código de barras o título; revisar edición, datos, portada, estado y estantería antes de guardar. |
| Detalle | Editar ficha, cambiar ubicación, gestionar lectura, notas/préstamo y procedencia visible cuando sea provisional. |
| Estanterías | Ver contenido con un clic, recuentos consistentes y acciones claras sobre la predeterminada. |
| Vista 3D | Exploración opcional con navegación al detalle, teclado/táctil y alternativa 2D equivalente. |
| Importación | Previsualización, comparación, modo fusionar/reemplazar, confirmación y resultado persistente con pendientes de portada. |
| Perfil | Datos que realmente se guardan, cuenta Google identificada y acciones de privacidad/exportación accesibles. |

## Orden de ejecución propuesto

### Bloque 1 — Base fiable antes de ampliar producto

1. Normalizar instalación y actualizar dependencias afectadas (SEC-01).
2. Corregir callback, tipos y errores de hidratación (SEC-02, QA-01, FE-01).
3. Reutilizar conexiones, hacer idempotente la predeterminada y validar escrituras (BE-01/02, SEC-03).
4. Verificar integridad y RLS con dos usuarios; corregir relación de propietario (SEC-04/05).
5. Corregir el perfil ficticio, la paginación y los éxitos silenciosos (UX-03/06/07, BE-06).

**Salida verificable:** instalación reproducible; build con tipos; acceso coherente; ninguna acción de interfaz declara un guardado ficticio; pruebas de aislamiento y errores básicos.

### Bloque 2 — Catálogo cómodo y seguro

1. Edición completa y asignación de estantería desde alta/detalle (UX-01/02/08).
2. Colección unificada, filtros en URL y acciones por lotes (UX-05).
3. Importación con revisión, confirmación, límites y resumen de portadas (IMP-01/02).
4. Identificadores normalizados y procedencia provisional conservada (IMP-03/04).
5. Estados de error/pending y accesibilidad básica en los mismos flujos (UX-04, UI-03).

**Salida verificable:** catalogar, corregir, encontrar y mover un libro sin manipular JSON; añadir una colección sin sustituirla accidentalmente.

### Bloque 3 — Consistencia visual y rendimiento medido

1. Tokens y contraste claro/oscuro, componente de portada y layout común (UI-01/02, FE-02/03).
2. Consultas específicas y paginación, con medición antes/después (BE-03).
3. Visor 3D honesto y accesible; retirar restos de prototipo (UX-09, FE-04).
4. Observabilidad, migraciones comprobadas y ensayo de restauración (QA-02, OPS-01/02).

**Salida verificable:** recorridos completos en móvil, teclado y ambos temas; métricas de carga reales y recuperación documentada.

### Bloque 4 — Funciones de lectura y colección física

Escáner, revisión de ediciones, etiquetas/notas, progreso, ubicación por balda y préstamos, según uso real. Introducir trabajo en segundo plano o consulta offline cuando los límites medidos lo justifiquen.

## Validación mínima que debe acompañar las mejoras

- Usuario A nunca lee ni modifica libros/estanterías de B; tampoco puede enlazar filas a estanterías ajenas.
- Acceso directo, OAuth inválido, sesión caducada y cierre de sesión funcionan sin redirecciones externas ni falsos estados vacíos.
- Alta, edición y movimiento conservan datos y muestran errores recuperables; una solicitud repetida no duplica operaciones.
- Importar un archivo inválido no modifica nada; un fallo SQL revierte la sustitución; la caída de Open Library no impide importar y queda reflejada en el resultado.
- Exportar/restaurar cumple el contrato versionado, incluida la estantería predeterminada y los identificadores definidos.
- Búsqueda con tildes/ISBN, cero resultados, paginación y vuelta desde detalle mantienen coherencia.
- Recorridos con teclado, lector de pantalla, móvil, zoom y movimiento reducido; contraste medido en ambos temas.
- Instalación limpia, tipos, lint, pruebas y build obligatorios; métricas y pruebas de recuperación en entorno separado antes de publicar.

## Qué conviene conservar

- Next.js, Supabase y Drizzle son suficientes para la siguiente etapa; los hallazgos no justifican cambiar el stack.
- Autorización dentro de las acciones, filtros por propietario y transacciones con rol/claims locales constituyen una base útil que se debe probar y reforzar.
- La eliminación de estanterías ya mueve sus libros en la misma transacción y protege la predeterminada en el flujo de aplicación.
- La importación mejorada ya valida el JSON, consulta portadas por lotes, conserva portadas existentes y usa fallback ante errores del proveedor; su sustitución de datos ya es atómica.
- La identidad vintage y la vista 3D pueden mantenerse mientras se mejora legibilidad, consistencia y utilidad diaria.

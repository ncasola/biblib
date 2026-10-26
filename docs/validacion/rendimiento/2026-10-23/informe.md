# U-QA-03 · Primera medición de rendimiento y capacidad (ola O09)

**Fecha:** 23 de octubre de 2026 · **Rama:** `u-qa-03` · **Perfil:** `test` (`biblib-test`) · **Estado:** medición completa de los escenarios que existen hoy; la publicación de staging y los workers de portadas quedan para la repetición posterior a U-DAT-03/04.

Es la medición de referencia **previa a U-DAT-04**. Se repetirá al cambiar el modelo de ejemplares (U-DAT-06) y al cerrar el producto, con el mismo comando y los mismos datasets. Los presupuestos son los **propuestos** en [04](../../../spec-pendientes/04-calidad-seguridad-y-operacion.md#u-qa-03--rendimiento-y-capacidad-medidos); no son un SLA ni resultados observados de un entorno publicado.

Los datos brutos están en esta carpeta: [`tablas.md`](tablas.md) (todas las tablas), `resultados-<tamaño>.json`, `contrato.json` (salida de `perf:local --json`), `explain-<tamaño>.txt`, `auth.json`, `cuota.json` y [`manifiesto.json`](manifiesto.json).

## 1. Resumen

- **SQL no es el límite.** Con 10 000 ejemplares, el SQL real de una acción de listado suma **p95 21 ms** y el del resumen del inicio **p95 22 ms** (presupuesto: p95 ≤ 500 ms). La consulta más cara (búsqueda local por ISBN) tarda 124 ms.
- **La acción de listado cumple con 1, 5 y 10 sesiones:** p95 229 ms, 185 ms y 372 ms (presupuesto 1 000 ms). El 65–75 % del p50 con una sola sesión son **dos llamadas a Auth** (`getUser()` en el proxy y otra en la acción): ~45–50 ms cada una en GoTrue.
- **Incumplimientos concretos** (cada uno es una tarea en [§9](#9-tareas-por-presupuesto-incumplido)): Ajustes lee la colección completa al abrirse (10 000 fichas, 6,7 MiB); con 5–10 sesiones concurrentes superan 1 s la búsqueda local, el listado de 100 filas y el inicio; la exportación de Ajustes provoca un CLS de 0,17 (escritorio) y 0,58 (móvil emulado); en el perfil móvil con CPU ×4, INP 496 ms en Estanterías y 216 ms en la ficha.
- **Aislamiento:** 0 violaciones en 760 comprobaciones bajo carga de 10 sesiones (A y B no ven datos de la cuenta de escala ni entre sí, y viceversa).
- **Cuota con dos procesos:** las plazas reservadas por Postgres quedan separadas ≥ 1 000 ms; ninguna conexión permanece en transacción mientras se espera la cuota (transacción más larga 125 ms).
- **Índices:** ninguno es necesario para cumplir hoy. La ordenación y la búsqueda crecen de forma lineal con el tamaño (12 ms → 34–49 ms por consulta a 10 000); se dejan **tres índices propuestos y medidos** para la siguiente ola ([§6](#6-índices-propuestos-y-medidos)).
- **Sin llamadas externas:** el guard de red del servidor y el del navegador registraron 0 salidas en los tres tamaños.

## 2. Entorno y método

**Hardware y versiones** ([manifiesto](manifiesto.json)): AMD Ryzen 5 3600 (6 núcleos, 12 lógicos), 47,9 GiB de RAM, Windows 11; Docker Desktop 29.4.3 con **12 CPU y 19,5 GiB** asignados; PostgreSQL 17.6 (`shared_buffers` 160 MiB, `effective_cache_size` 160 MiB, `jit` activado, `max_connections` 100), GoTrue v2.196.0, PostgREST 16.2, Storage 1.72.1; Node 24.11.1, pnpm 10.32.1, Next 16.4.2 (build de producción, Turbopack), React 19.3.1, Playwright 1.64.1 con Chrome 155.0.8059.85.

**Condiciones de ruido.** La máquina de medición es de desarrollo: durante la ejecución había **18 contenedores ajenos** en marcha (HolaERP y los stacks de otros worktrees), el Postgres usa la configuración por defecto del stack local y no se aisló la CPU. Las cifras sirven para comparar tamaños y versiones del propio producto; la dispersión entre ejecuciones es apreciable (p. ej. el p50 de `GET /user` en GoTrue fue de 85–97 ms en la ejecución de 100 y 1 000 ejemplares y de 50 ms en la de 10 000). Por eso las conclusiones se apoyan en órdenes de magnitud y en el reparto Auth/DB, no en diferencias de pocos milisegundos.

**Datos.** Cuenta fixture `escala@biblib.test` (separada del censo A/B, que no se ha tocado) con 100, 1 000 y 10 000 ejemplares sintéticos y deterministas (`scripts/performance/lib/dataset.mjs`, `db:seed:local --scale N`). ISBN-13 válidos del rango 979-0 (ningún ISBN real), 15 % de fichas manuales, tildes y eñes, estados 40/30/22/8 %, 6/13/41 estanterías con reparto desigual (la mayor tiene 1 534 libros a 10 000). Huellas: 100 → `8235428f06b9`, 1 000 → `6343ab435b44`, 10 000 → `6e9b3738de18`.

**Cómo se mide cada cosa.**

| Medida | Mecanismo |
| --- | --- |
| Acción p50/p95 | POST real de la Server Action (cabecera `Next-Action`) contra `next start`, con cookies SSR de sesiones reales de GoTrue. 60 repeticiones con 1 sesión, 20 por sesión con 5 y 15 por sesión con 10 (más 3 de calentamiento). Latencia hasta el último byte. |
| SQL | Diferencia de `pg_stat_statements` (tiempo de ejecución de todas las sentencias de la acción) antes y después de cada llamada, solo con 1 sesión, más `EXPLAIN (ANALYZE, BUFFERS)` como `authenticated` con RLS real (30 ejecuciones). |
| Auth | Duración de cada `GET /user` en el registro de GoTrue y nº de llamadas por acción (2,04–2,1), más el viaje cliente → Kong → GoTrue ([`auth.json`](auth.json)). |
| Filas por página | Filas de la respuesta de cada acción y filas por llamada de cada sentencia. |
| Pool | `pg_stat_activity` cada 100 ms (`application_name = 'postgres.js'`). |
| Frío / caliente | Frío: primera llamada de cada acción tras **arrancar la app** (proceso y conexión nuevos); no se vacía la caché de Postgres. Web: contexto de navegador nuevo con caché vacía. Caliente: llamadas posteriores / navegaciones siguientes. |
| LCP, INP, CLS | Playwright + Chrome, PerformanceObserver (`largest-contentful-paint`, `event` con `interactionId`, `layout-shift`). Perfiles declarados: `escritorio-local` (1280×800, sin limitación; 3 contextos por pantalla) y `movil-cpu-x4` (390×844 táctil, CPU ×4 más lenta, sin limitación de red; 2 contextos, solo con 10 000). Mediana de los contextos; el INP es el peor de los gestos de solo lectura. |
| Sesiones | 10 sesiones de la cuenta de escala + A + B, abiertas **una vez** (12 accesos de los 30 por 5 min) y reutilizadas en los tres tamaños. |
| Cuota distribuida | Dos procesos Node independientes con el orquestador y el gateway compilados (el código de la app) contra el Postgres del perfil y un proveedor simulado. No son dos instancias de Next: una segunda necesitaría un puerto fuera de los reservados. |

## 3. Resultados por tamaño (acciones, caliente)

Acción p50 / p95 en ms con 1 sesión; entre paréntesis, el SQL real de la acción (p95). Todas las filas y las de 5 y 10 sesiones están en [`tablas.md`](tablas.md).

| Escenario | 100 | 1 000 | 10 000 |
| --- | --- | --- | --- |
| Inicio (resumen) | 140 / 197 (6,5) | 128 / 148 (3,7) | 142 / 167 (21,5) |
| Listado inicial (10 filas) | 223 / 474 (0,4) | 191 / 232 (2,1) | 135 / 229 (21,0) |
| Listado de 100 filas | — | — | 139 / 167 (18,8) |
| Última página | — | — | 147 / 164 (38,5) |
| Filtro estado + estantería | — | — | 110 / 118 (2,5) |
| Orden por autor / por fecha | — | — | 175 / 242 (18,5) · 142 / 177 (30,3) |
| Búsqueda local (texto) | 188 / 273 (1,5) | 198 / 248 (12,9) | 221 / 312 (160) |
| Búsqueda local (ISBN) | — | — | 215 / 256 (124) |
| Ficha | — | — | 107 / 129 (0,1) |
| Estanterías | — | — | 124 / 147 (8,7) |
| Estantería 3D (48) | — | — | 117 / 201 (5,4) |
| Lectura completa de Ajustes | 121 / 148 | 243 / 291 | **524 / 576** (6,7 MiB) |
| Preview de importación (2 000 fichas, «nuevos») | 159 / 228 | 231 / 266 | 363 / 403 (57) |

La variación entre 100 y 10 000 en las filas de 10 filas es menor que el ruido de Auth. Lo que sí crece con el tamaño es el SQL de las consultas que recorren la colección de la cuenta: página 1 por título **0,25 → 1,15 → 12,4 ms**, última página **0,30 → 1,9 → 34 ms**, búsqueda **0,8 → 5,1 → 49 ms** (EXPLAIN, ejecución p50). El crecimiento es aproximadamente lineal en los tres tamaños; **extrapolando** (no medido) a 100 000 filas una cuenta alcanzaría ~125 ms, ~340 ms y ~490 ms respectivamente, es decir, el presupuesto de SQL de 500 ms empezaría a estar en riesgo para búsqueda y última página por encima de ~100 000 ejemplares por cuenta. U-DAT-06 puede acercarse a ese orden si cada copia es una fila.

**Frío (primera llamada tras arrancar la app, 10 000):** inicio 263 ms, listado 151 ms, búsqueda 211 ms, lectura completa 498 ms; el sobrecoste respecto a caliente es de 10–120 ms (conexión nueva con `idle_timeout` de 20 s, carga de módulos, y la consulta de tipos de postgres.js). Con `idle_timeout: 20`, una cuenta inactiva más de 20 s paga una conexión nueva en su siguiente acción.

**Concurrencia (10 000, listado inicial):** p50/p95 135/229 ms (1 sesión), 166/185 ms (5), 338/372 ms (10). El SQL no explica el aumento (≤ 21 ms por acción) ni lo hace la duración de `GET /user` dentro de GoTrue (50 → 55 ms p50), pero el viaje cliente → Kong → GoTrue sí se duplica (p50 52 → 97 ms) y el pool de la app es de **una conexión** (máximo observado 1; 7 conexiones abiertas en total de 100). La causa exacta (cola en el proceso de Next, en Kong/GoTrue o el pool) no queda aislada por esta medición: ver T4.

## 4. EXPLAIN de las consultas principales

[`explain-100.txt`](explain-100.txt), [`explain-1000.txt`](explain-1000.txt) y [`explain-10000.txt`](explain-10000.txt) contienen `EXPLAIN (ANALYZE, BUFFERS)` de las 20 consultas, ejecutadas como `authenticated` con claims (RLS real) y con los UUID sustituidos; [`tablas.md`](tablas.md) resume tiempo de ejecución/planificación y nodos. Hallazgos:

- La política RLS se resuelve a un `One-Time Filter` (no hay evaluación por fila): el aislamiento no añade coste visible.
- Con 10 000 filas, listado, orden y búsqueda hacen `Seq Scan` de las fichas de la cuenta + `top-N heapsort`; a esta escala el planificador prefiere el recorrido secuencial frente a `books_user_id_idx`. La consulta de recuento usa `Index Only Scan`.
- `jit` no se activa (coste bajo el umbral).
- El `LIKE '%texto%'` con `translate(lower(...))` recorre todas las fichas (49 ms); no hay índice que lo ayude hoy ([§6](#6-índices-propuestos-y-medidos)).
- Las consultas sin `LIMIT` de la aplicación se listan en [§8](#8-navegación-ordinaria-y-consultas-sin-límite).

## 5. Comparación con los presupuestos propuestos (10 000 ejemplares)

Tabla generada por el harness; se amplía con las filas no cubiertas por un presupuesto de 04.

| Medida | Presupuesto propuesto | Medido | Resultado |
| --- | --- | --- | --- |
| Consulta paginada y resumen, caliente, 1 sesión | p95 SQL ≤ 500 ms | 21,0 ms (listado) + 21,5 ms (resumen) = 42,6 ms | Cumple |
| Filas por página de colección | ≤ 100 | 100 (página máxima admitida) | Cumple |
| Acción de listado incl. autorización local, 1 sesión | p95 ≤ 1 000 ms; Auth y DB por separado | 229 ms = Auth GoTrue 2 × ~50 ms (p95 65) + SQL 21 ms + resto | Cumple |
| Acción de listado con 5 / 10 sesiones | p95 ≤ 1 000 ms | 185 ms / 372 ms | Cumple |
| Dashboard con 10 sesiones | p95 ≤ 1 000 ms | 1 265 ms (p50 544 ms; 836 ms a 1 000 ejemplares) | **No cumple** |
| Búsqueda local con 5 / 10 sesiones | p95 ≤ 1 000 ms | 1 055 ms / 1 278 ms (ISBN: 659 / 1 222 ms) | **No cumple** |
| Listado de 100 filas con 10 sesiones | p95 ≤ 1 000 ms | 1 479 ms (con 5: 622 ms) | **No cumple** |
| Publicación atómica de staging | bloqueo ≤ 5 s; sin red dentro | — | **Pendiente** (U-DAT-04) |
| Paso de worker | acotado, lease renovable, sin conexión retenida durante la espera de cuota | 0 conexiones «idle in transaction»; transacción más larga 125 ms; 2 conexiones máx. con 2 procesos | Cumple (en el gateway; los workers de portadas no existen aún) |
| UI de tabla: no renderizar los 10 000 | ≤ 100 por página | 10 filas (100 como máximo) | Cumple |
| UI 3D | ≤ 48 por página | 48 | Cumple |
| Impresión pagina su lectura | — | No hay impresión paginada en la app | Sin objeto hoy |
| Navegación ordinaria sin consultas sin límite | [§8](#8-navegación-ordinaria-y-consultas-sin-límite) | `/settings` lee las 10 000 fichas al abrirse | **No cumple** |
| LCP ≤ 2,5 s · INP ≤ 200 ms · CLS ≤ 0,1, escritorio | por pantalla | LCP 160–628 ms, INP 16–56 ms, CLS 0,001; **Ajustes: CLS 0,169** al terminar la exportación | **No cumple** (solo Ajustes) |
| Ídem, móvil (CPU ×4) | por pantalla | LCP 426–2 336 ms; INP 80–496 ms; **Estanterías INP 496 ms, ficha INP 216 ms; Ajustes CLS 0,579** | **No cumple** (3 pantallas) |

El CLS de Ajustes es de **carga 0,001**; el desplazamiento aparece al terminar la exportación, cuando la lista de las 5 partes se inserta más de 500 ms después del clic (1,4 s en escritorio, 3,3 s en móvil) y empuja el contenido. LCP de Ajustes no refleja la lectura de 6,7 MiB porque el elemento mayor es un texto estático (el contador «datos listos» no se pudo capturar en esa pantalla: ver limitaciones).

## 6. Índices propuestos y medidos

Ninguno se crea ahora: esta ola ya tiene migración (U-DAT-03). Cada candidato se midió en una transacción que se revierte, con `ANALYZE` posterior, como `authenticated` con RLS, 30 ejecuciones por consulta (ejecución p50 / p95, 10 000 ejemplares); el coste de escritura es insertar 2 000 fichas (línea base sin índice: 137,6 ms). Todos son aditivos; la retirada es `DROP INDEX` y se conserva el índice anterior durante la transición.

| # | Índice propuesto | Consulta | Antes | Después | Tamaño | Escritura (2 000 filas) | Propuesta |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `books_user_title_idx (user_id, title, id)` | Listado página 1 | 11,1 / 12,3 | 0,05 / 0,09 | 864 KiB | +20 % (165,5 ms) | **Adoptar** en la siguiente ola. La última página no mejora (32 → 32 ms): sigue siendo un recorrido completo. |
| 2 | `books_user_shelf_title_idx (user_id, shelf_id, title, id)` | Vista 3D | 3,0 / 3,3 | 0,14 / 0,20 | 1 040 KiB | +22 % (168,3 ms) | Adoptar si la vista 3D y el filtro por estantería siguen siendo ordinarios. |
| 3 | `books_user_created_idx (user_id, created_at desc, id desc)` | «Añadidos recientemente» | 11,9 / 15,3 | 0,04 / 0,09 | 592 KiB | +22 % (168,0 ms) | **Adoptar** (la consulta del inicio). |
| 4 | `books_user_status_updated_idx (user_id, status, updated_at desc, id)` | «Leyendo ahora» | 5,0 / 5,3 | 0,06 / 0,10 | 680 KiB | +28 % (176,4 ms) | Opcional; el recuento por estado no mejora (5,9 → 5,8 ms). |
| 5 | `books_user_shelf_idx (user_id, shelf_id)` | Estanterías con recuento | 9,4 / 11,4 | 8,9 / 10,4 | 96 KiB | +17 % (161,6 ms) | **Rechazar:** sin mejora material. |
| 6 | `books_search_trgm_idx` (GIN `pg_trgm` sobre la expresión de búsqueda) | Búsqueda local | 52–88 / 61–101 | 50–79 / 54–134 (el recuento empeora) | 1 848 KiB | +83 % (252,0 ms) | **Rechazar por ahora:** el planificador no lo usa a 10 000 y duplica casi el coste de escritura. Revisar cerca de 100 000 filas por cuenta o con una columna generada de búsqueda (la expresión actual pasa la comprobación de inmutabilidad). |

Resultados con 100 y 1 000 ejemplares en [`resultados-100.json`](resultados-100.json) y [`resultados-1000.json`](resultados-1000.json): el beneficio crece con el tamaño (a 1 000 la mejora absoluta es de ~1 ms). Mientras las cifras de §5 se cumplan, la decisión de añadir 1–3 es de higiene (evitar el crecimiento lineal) y no de presupuesto; cada uno cuesta 17–28 % de escritura masiva.

## 7. Cuota distribuida, aislamiento y conexiones

**Cuota (dos procesos, catálogo en fixture, [`cuota.json`](cuota.json)).** Dos procesos × 6 ISBN distintos → 12 peticiones simuladas; **plazas reservadas por Postgres separadas 1 000 ms como mínimo** (la garantía del gateway). La separación observada entre las llamadas fue de 991 ms como mínimo en la ejecución final (hasta 68 ms de jitter de planificación del proceso en otra ejecución con más ruido): es temporización del sistema operativo, no una reserva adelantada. Latencia por consulta incluyendo la espera de su plaza: p50 ~2 s. **Caché compartida:** 6 consultas repetidas desde el otro proceso → 0 peticiones, p50 3 ms (p95 47 ms). **Consulta en vuelo:** el mismo ISBN pedido a la vez por los dos procesos → 1 petición. **Conexiones:** como máximo 2 simultáneas entre los dos procesos, 0 en «idle in transaction» y transacción más larga de 125 ms: durante la espera de una plaza no se retiene conexión.

**Aislamiento bajo carga** (10 sesiones de escala en bucle mientras A y B consultan sus colecciones y las de la cuenta de escala por ID, filtro por estantería ajena, exportación y estanterías): 189 / 210 / 361 comprobaciones a 100 / 1 000 / 10 000, **0 violaciones**. Ninguna respuesta contenía una ficha o estantería de otro propietario y las lecturas cruzadas devolvieron «no encontrado».

**Conexiones.** El pool de la aplicación es de 1 conexión por proceso (`lib/db/client.ts`): máximo 1 observado, 7 conexiones abiertas de las 100 permitidas al terminar la carga (Storage, PostgREST, pg_cron, pg_net y las de la medición). No hay presión sobre `max_connections`; con N réplicas, el presupuesto es N conexiones más las del gateway del catálogo (hasta 2 por proceso en modo `live`).

## 8. Navegación ordinaria y consultas sin límite

Criterio aplicado: una sentencia que devuelve filas, no es un agregado y no lleva `LIMIT`, y que crece con la colección. Evidencia: filas por llamada de cada sentencia en `pg_stat_statements` ([`resultados-10000.json`](resultados-10000.json), `sentencias`) y revisión del código de cada pantalla.

| Pantalla / acción | Resultado |
| --- | --- |
| Inicio, Colección (10 y 100 filas, última página, filtros, orden, búsqueda), Ficha, Estanterías, 3D (48) | **Con límite** (≤ 100 filas por consulta; los recuentos y agregados devuelven 1 fila). `getShelvesAction` devuelve una fila por estantería (41 a 10 000) sin `LIMIT`: acotada por el número de estanterías, no de libros. |
| **Ajustes (`/settings`) al abrirse** | **Sin límite:** `getLibraryDataAction` lee todas las fichas (10 000 filas, 109 ms de SQL, 6,7 MiB de respuesta, ~520 ms de acción) cada vez que se abre y otra vez tras cada revisión de importación. |
| Añadir / editar libro (`getBookByIsbnAction`, `assertUniqueIsbn`) | Leen todos los ISBN de la cuenta en cada alta, edición o búsqueda (1,6 ms con 10 000: índice solo; memoria O(n) por petición). Revisado en el código; no se ejecutó como escenario. |
| Preview de importación | Lee `id` + `isbn` de toda la cuenta dos veces (4,8 y 8,2 ms): es el plan de fusión y no es navegación ordinaria. |

## 9. Tareas por presupuesto incumplido

No se compensa subiendo `bodySizeLimit`, memoria, timeouts ni el pool sin medir.

| # | Tarea | Evidencia | Propietaria sugerida |
| --- | --- | --- | --- |
| T1 | **Ajustes no debe leer la colección completa al abrirse.** Cargar solo recuentos; la exportación pasa a leer por partes en el servidor y a cerrar la copia sin materializar 10 000 fichas en el cliente. | §8; 6,7 MiB; export 1,4 s (escritorio) y 3,3 s con 366 ms de tareas largas (móvil) | U-DAT-04 |
| T2 | **CLS de Ajustes:** reservar el espacio de la lista de partes (o mostrarla sin empujar el contenido) y usar una región `aria-live`. | CLS 0,169 / 0,579 tras exportar | U-EXP |
| T3 | **Una sola verificación de sesión por petición.** El proxy y la acción llaman cada una a `getUser()` (2,04–2,1 llamadas por acción, ~45–50 ms de GoTrue cada una). Evaluar `getClaims()` con verificación local del JWT o pasar el resultado del proxy a la acción; exige decidir el tratamiento de revocación inmediata. | §3: el 65–75 % del p50 de una acción con 1 sesión | U-OPS-04 / U-INF |
| T4 | **Latencia con 5–10 sesiones.** Aislar la causa del aumento (cola del proceso de Next, Kong/GoTrue o el pool de 1 conexión) con un experimento controlado (pool 2 y 4; T3) antes de cambiar nada; reducir las idas y vueltas del inicio (4 consultas + `ensureDefaultShelf` por acción). Superan 1 s: inicio@10, búsqueda@5 y @10, listado 100 filas@10. | §5 | U-DAT-03 |
| T5 | **Búsqueda local:** a 10 000 cuesta 105–160 ms de SQL por llamada. No se propone índice hoy ([§6](#6-índices-propuestos-y-medidos)); corregir T3/T4 primero y repetir. Si U-DAT-06 multiplica las filas, evaluar columna de búsqueda generada + trigramas. | §3, §6 | U-DAT-06 |
| T6 | **Móvil con CPU ×4:** Estanterías (diálogo «Nueva estantería») INP 496 ms, ficha INP 216 ms y LCP 2 336 ms. Confirmar primero el perfil de medición acordado y, si se mantiene, perfilar el diálogo. | §5 | U-EXP-03 |
| T7 | **Lectura de ISBN por cuenta** en alta/edición/búsqueda por ISBN: sustituir el recorrido completo por una comprobación por igualdad indexada sobre el identificador normalizado. | §8 | U-DAT-06 |
| T8 | **Índices 1–3** de §6 en la migración de la siguiente ola, con su plan de retirada. | §6 | Siguiente ola de esquema |

## 10. Pendiente para la repetición posterior a U-DAT-03/04

- **Publicación atómica de staging** (bloqueo ≤ 5 s, sin red dentro de la transacción): no existe aún (U-DAT-04).
- **Workers de portadas** (paso acotado, lease renovable, sin conexión retenida mientras esperan una cuota): no existen aún (U-DAT-03); la medición de §7 cubre el gateway de cuota, no un worker.
- Dos instancias reales de Next con `BIBLIB_CATALOGUE_MODE=live` contra un proveedor simulado: requiere un segundo puerto de aplicación reservado.
- Frío de Postgres (reinicio del contenedor entre mediciones) y un perfil de medición de red (3G/4G) si se acuerda uno.

## 11. Limitaciones

- Postgres y GoTrue locales en Docker Desktop, con otros stacks en marcha: los valores absolutos no son predicciones del alojamiento definitivo.
- El frío es el de la aplicación; no se vació la caché de Postgres ni la del sistema operativo.
- `datosListosMs` de Ajustes no se capturó (la respuesta de 6,7 MiB no se contabiliza como acción terminada en el seguimiento de peticiones del navegador); se informa el tiempo hasta la copia lista (`exportMs`).
- La variabilidad entre ejecuciones es alta en Auth (§2); los p95 con 5–10 sesiones y pocas iteraciones (15–20 por sesión) tienen menos precisión que los de 1 sesión (60).
- En modo `replace`, la preparación de importación consulta Open Library aunque el modo sea `fixture` si las fichas llevan portada genérica (hallazgo ya abierto de U-QA-02/U-BIB-05). La medición envía portadas con URL para no provocar esa salida; el guard del servidor registró 0 llamadas.
- Los gestos de «Página siguiente/anterior» de la vista 3D no existen con 100 ejemplares (una sola página); el INP de esa pantalla a 100 no es comparable.

## 12. Reproducción y recursos

```powershell
pnpm db:local:bootstrap --profile test
pnpm perf:local --scale 100 --scale 1000 --scale 10000      # tablas, EXPLAIN, índices, web, cuota, aislamiento
pnpm perf:local:cleanup --profile test                      # retira escala@biblib.test
pnpm db:local:down --profile test
```

Los resultados de esta carpeta proceden de tres ejecuciones del mismo código sobre el mismo stack: 1 000 + 10 000 (sesiones compartidas), 100 y la cuota (repetida al corregir cómo se informa su jitter). `contrato.json` reúne los tres tamaños. Un fallo en la primera pasada (la actualización administrativa de la cuenta de escala revocaba las sesiones abiertas al cambiar de tamaño) se corrigió antes de las ejecuciones finales: el seed ya no modifica una cuenta intacta.

**Recursos Docker que quedan** (propios del perfil `test`, no se eliminan): red `biblib-test-network`, volúmenes `supabase_db_biblib-test` y `supabase_storage_biblib-test` y, parados, los contenedores `supabase_*_biblib-test`. La cuenta de escala y su biblioteca se retiran al terminar con `perf:local:cleanup`. No se ha tocado ningún recurso de HolaERP ni de otros perfiles. Estado local no versionado: `.biblib/performance/` (logs y registro de accesos sin tokens) y `.biblib/fixtures/test-escala.json` (contraseña de la cuenta de escala, retirado por la limpieza).

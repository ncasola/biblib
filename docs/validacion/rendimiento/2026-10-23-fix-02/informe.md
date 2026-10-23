# U-FIX-02 · Una verificación de sesión por petición y latencia con varias sesiones (ola O10)

**Fecha:** 23 de octubre de 2026 · **Rama:** `u-fix-02` · **Perfil:** `test` (`biblib-test`) · **Datos:** cuenta de escala con 10 000 ejemplares (`biblib-escala-v1`, huella `6e9b3738de18`) · **Origen:** tareas T3 y T4 de [U-QA-03](../2026-10-23/informe.md#9-tareas-por-presupuesto-incumplido).

Decisión de seguridad completa en [seguridad.md](../../../seguridad.md#verificación-de-sesión-por-petición-u-fix-02). Comandos en [operacion.md](../../../operacion.md#una-verificación-de-sesión-por-petición-y-capacidad-con-varias-sesiones--u-fix-02).

## 1. Resumen

- **Causa de T4 aislada: el pool de una conexión.** Sin ninguna llamada a GoTrue, la búsqueda con 10 sesiones sigue en 1 352 ms de p50 (126 ms con una sesión) y el rendimiento se queda en ~7,5 peticiones/s con cualquier número de sesiones: las acciones hacen cola en la única conexión de Postgres. La cola propia de Next es pequeña (`GET /login` 47 ms de p50 con 10 en paralelo) y GoTrue no limita mientras el pool sea 1.
- **T3: la 2.ª llamada a GoTrue cuesta ~45–50 ms por acción con una sesión.** Quitarla bajó el listado de 100 filas de 139 a 88 ms de p50, sin efecto con 10 sesiones mientras el pool sea 1.
- **Las idas y vueltas no son la causa:** pasar de 10 a 6 sentencias por resumen no cambia nada medible (151 → 158 ms, dentro del ruido). Se aplica igualmente (sin coste), sin atribuirle ganancia.
- **Cambios:** atestación firmada del proxy (una llamada a GoTrue por petición, revocación inmediata intacta), pool de **4** conexiones, preparación RLS en 1 sentencia y `ensureDefaultShelf` solo cuando falta la predeterminada.
- **Resultado (`perf:local --scale 10000`):** con una sesión, el p50 baja en 11 de los 12 escenarios de navegación, entre un 5 % y un 64 % (inicio 140 → 85 ms, listado 195 → 81 ms, ficha 115 → 69 ms); el listado de 100 filas no cambió en esa pasada y bajó de 139 a 88 ms en el experimento controlado. Con 10 sesiones, **todas las acciones de navegación quedan por debajo de 1 s de p95**: inicio 753 → 303 ms, búsqueda 2 154 → 712 ms, búsqueda por ISBN 1 329 → 669 ms, listado de 100 filas 753 → 307 ms. Las llamadas a GoTrue por acción pasan de 2,03–2,1 a 1,01–1,05. `perf:local` informa **0 medidas fuera de presupuesto** (antes, 3).
- **Seguridad:** `test:integration:security` 23/23 (4 pruebas nuevas de revocación y atestación), `test:integration:local` 77/77 + 1/1, aislamiento bajo carga 0 violaciones en 572 comprobaciones.

## 2. Entorno y método

Mismo hardware, stack y harness que U-QA-03 ([manifiesto antes](antes/manifiesto.json), [después](despues/manifiesto.json)): Ryzen 5 3600, Docker Desktop con 12 CPU, PostgreSQL 17.6 con `max_connections` 100, GoTrue v2.196.0, Next 16.4.2 (`next start`, build de producción), Node 24.11.1. Durante la medición había 10 contenedores ajenos en marcha (HolaERP). Sesiones reales de GoTrue abiertas una vez por ejecución (10 de la cuenta de escala; `perf:local` añade A y B): 44 accesos en total en las cuatro mediciones, siempre dentro del límite de 30 cada 5 minutos gracias al registro compartido de `perf:local`.

**Experimento T4 (`pnpm perf:t4`).** Seis builds que difieren en **una sola cosa** respecto al código medido (`scripts/performance/lib/t4-variants.mjs`). El runner reescribe los archivos de la variante, compila, restaura el original antes de arrancar la app y comprueba con `git diff` que el árbol quedó igual. Cada build se mide con los mismos escenarios de `perf:local` (`dashboard`, `listado-100-filas`, `busqueda-local-texto`) con 1, 5 y 10 sesiones (60, 20 y 15 llamadas por sesión, más 3 de calentamiento). Añade dos sondas: `GET /auth/v1/user` directo a Kong (lo que hace `getUser()`) y `GET /login` sin cookies (página pública: Next sin GoTrue ni Postgres).

| Variante | Factor que cambia | ¿Se integra? |
| --- | --- | --- |
| `base` | Ninguno (commit `6ea13dd`) | — |
| `pool-2` / `pool-4` | `max` de postgres.js en `lib/db/client.ts`: 2 / 4 | `pool-4`, sí |
| `sin-getuser-accion` | La acción lee la sesión de la cookie que el proxy ya verificó (simula T3) | No: diagnóstica. T3 se implementa con atestación firmada |
| `idas-minimas` | Preparación RLS 3 → 1 sentencia; resumen sin `ensureDefaultShelf` ni recuento aparte | Sí (equivalente) |
| `sin-getuser` | Ni el proxy ni la acción llaman a GoTrue: solo Next + Postgres | No: diagnóstica |

Datos brutos: [`experimento-t4.json`](experimento-t4.json) y su tabla [`experimento-t4.md`](experimento-t4.md); repetición de `base` con el código final: [`experimento-t4-despues.json`](experimento-t4-despues.json) ([tabla](experimento-t4-despues.md)).

**Antes y después (`perf:local`).** `pnpm perf:local --profile test --scale 10000 --skip web --skip indexes --skip quota --skip explain` sobre el commit previo a los cambios ([`antes/`](antes/tablas.md)) y sobre el final ([`despues/`](despues/tablas.md)). Se omiten Web Vitals, índices, cuota y EXPLAIN: no dependen de la sesión ni del pool y ya están en U-QA-03.

## 3. Experimento T4

Acción p50 / p95 en ms; entre paréntesis, peticiones por segundo del conjunto.

| Variante | Inicio @1 | Inicio @5 | Inicio @10 | Listado 100 @1 | Listado 100 @10 | Búsqueda @1 | Búsqueda @5 | Búsqueda @10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `base` | 151 / 167 | 267 / 407 | 566 / 638 (17) | 139 / 158 | 482 / 578 (20) | 242 / 318 | 659 / 689 | 1 333 / 1 478 (7,4) |
| `pool-2` | 147 / 169 | 209 / 236 | 375 / 425 (26) | 136 / 155 | 437 / 626 (22) | 259 / 306 | 400 / 478 | 865 / 1 185 (10,9) |
| `pool-4` | 150 / 171 | 206 / 258 | 398 / 542 (24) | 144 / 163 | 408 / 580 (23) | 251 / 292 | 448 / 643 | 619 / 1 179 (14,7) |
| `sin-getuser-accion` | 109 / 134 | 261 / 329 | 511 / 604 (19) | 88 / 112 | 353 / 374 (28) | 179 / 198 | 656 / 819 | 1 271 / 1 339 (7,8) |
| `idas-minimas` | 158 / 180 | 275 / 399 | 531 / 627 (18) | 145 / 174 | 445 / 570 (22) | 251 / 346 | 691 / 759 | 1 410 / 1 708 (6,9) |
| `sin-getuser` (diagnóstica) | 44 / 53 | 209 / 232 | 421 / 442 (24) | 32 / 40 | 323 / 374 (31) | 126 / 140 | 642 / 697 | 1 352 / 1 687 (7,1) |
| **Final** (`base` después) | 105 / 141 | 171 / 218 | 279 / 352 (35) | 88 / 102 | 244 / 324 (39) | 195 / 243 | 260 / 319 | 546 / 672 (17,8) |

Sondas (p50 / p95 en ms):

| Sonda | 1 en paralelo | 5 | 10 |
| --- | --- | --- | --- |
| `GET /login` (Next sin GoTrue ni Postgres), rango de las 6 builds | 7–10 / 12–17 | 26–39 / 35–57 | 46–76 / 60–128 |
| `GET /auth/v1/user` directo a Kong, inicio / final del experimento | 51 / 62 · 57 / 68 | 74 / 96 · 90 / 117 | 121 / 150 · 176 / 250 |
| Duración de `GET /user` dentro de GoTrue (registro), `base` → `pool-4`, búsqueda @10 | — | — | 50 / 90 → 113 / 272 |

**Lectura.**

1. **Pool (causa principal de T4).** Con una conexión, el rendimiento de cada escenario es casi constante entre 1, 5 y 10 sesiones en la búsqueda (3,9 → 7,5 → 7,4 peticiones/s): el servidor es la conexión, y con 10 sesiones cada acción espera a las otras nueve. La variante `sin-getuser` lo confirma: sin GoTrue, la búsqueda @10 tarda lo mismo que en `base` (1 352 frente a 1 333 ms) y el inicio @10 es ≈ 10 × su tiempo con una sesión (421 ≈ 10 × 44 ms). Con 2 y 4 conexiones la búsqueda @10 baja a 865 y 619 ms de p50 y el rendimiento sube a 10,9 y 14,7 peticiones/s.
2. **GoTrue/Kong (siguiente límite).** Mientras el pool es 1, GoTrue no se satura (50 → 61 ms dentro de GoTrue con 10 sesiones). Al ensanchar el pool llegan más peticiones a la vez y GoTrue pasa a ser el cuello: 113 / 272 ms por llamada con `pool-4` en la búsqueda @10, y el viaje directo a Kong llega a 121–176 ms de p50 con 10 en paralelo. Por eso el p95 de la búsqueda @10 con `pool-4` (1 179 ms) solo baja del presupuesto al combinarlo con T3: la mitad de llamadas a GoTrue (final: 672 ms).
3. **Cola de Next.** `GET /login` con 10 en paralelo cuesta 46–76 ms de p50: Next añade decenas de milisegundos con 10 sesiones, no cientos.
4. **T3 con una sesión.** Quitar la 2.ª llamada ahorra 42 ms (inicio), 51 ms (listado 100) y 63 ms (búsqueda) de p50: una llamada a GoTrue (~50 ms) por acción, como estimó U-QA-03.
5. **Idas y vueltas.** `idas-minimas` no mejora ningún escenario: cada sentencia de preparación cuesta < 1 ms en local y no es la causa. Se aplica porque no cambia resultados y reduce el tiempo que cada acción retiene una conexión, pero sin atribuirle ganancia.

**Decisión de pool: 4 por proceso.** 4 rinde mejor que 2 en búsqueda @10 (619 frente a 865 ms de p50) y deja el resto igual. El presupuesto pasa de 1 a 4 conexiones por réplica de la app (más las del gateway del catálogo, hasta 2 por proceso en `live`). Con `max_connections` = 100 y 7–11 conexiones abiertas en total durante la carga, sobra margen; con un pooler en el alojamiento, el límite real será el del pooler. No se probó un pool mayor: con 4, el cuello ya es GoTrue.

## 4. Antes y después (`perf:local`, 10 000 ejemplares)

Acción p50 / p95 en ms. Todas las filas, SQL, filas, bytes y pool en [`antes/tablas.md`](antes/tablas.md) y [`despues/tablas.md`](despues/tablas.md).

| Escenario | 1 sesión, antes → después | 5 sesiones | 10 sesiones | Llamadas a GoTrue por acción |
| --- | --- | --- | --- | --- |
| Inicio (resumen) | 140 / 166 → **85 / 99** | 285 / 625 → 129 / 171 | 562 / 753 → **239 / 303** | 2,1 → 1,05 |
| Listado inicial (10) | 195 / 219 → **81 / 95** | 271 / 365 → 141 / 164 | 531 / 686 → 318 / 479 | 2,1 → 1,05 |
| Listado de 100 filas | 142 / 173 → 142 / 203 ¹ | 253 / 347 → 170 / 212 | 545 / 753 → **239 / 307** | 2,1 → 1,03 |
| Última página | 165 / 188 → 106 / 130 | 330 / 505 → 173 / 227 | 626 / 721 → 289 / 432 | 2,1 → 1,05 |
| Filtro estado + estantería | 120 / 142 → 77 / 100 | 223 / 311 → 120 / 153 | 446 / 644 → 189 / 258 | 2,1 → 1,05 |
| Orden por autor | 258 / 619 → 94 / 128 | 365 / 481 → 160 / 205 | 889 / 2 109 → 258 / 343 | 2,1 → 1,05 |
| Orden por fecha | 180 / 276 → 100 / 122 | 340 / 755 → 157 / 207 | 665 / 914 → 268 / 350 | 2,05 → 1,05 |
| Búsqueda local (texto) | 262 / 291 → 216 / 352 | 705 / 797 → 263 / 310 | 1 296 / 2 154 → **594 / 712** | 2,07 → 1,03 |
| Búsqueda local (ISBN) | 218 / 246 → 208 / 263 | 638 / 819 → 289 / 361 | 1 227 / 1 329 → **459 / 669** | 2,07 → 1,05 |
| Ficha | 115 / 130 → 69 / 84 | 163 / 197 → 125 / 157 | 286 / 425 → 245 / 372 | 2,1 → 1,05 |
| Estanterías | 120 / 144 → 76 / 87 | 202 / 338 → 148 / 208 | 442 / 631 → 227 / 350 | 2,1 → 1,05 |
| Estantería 3D (48) | 126 / 198 → 78 / 100 | 205 / 278 → 137 / 187 | 457 / 784 → 228 / 300 | 2,08 → 1,05 |
| Lectura completa de Ajustes | 530 / 594 → 484 / 548 | 1 619 / 2 157 → 1 543 / 2 133 | 3 375 / 3 902 → 2 776 / 3 994 | 2,0 → 1,08 |
| Preview de importación (nuevos) | 356 / 368 → 324 / 339 | 1 031 / 1 434 → 936 / 1 461 | 1 842 / 2 342 → 1 973 / 2 602 | 2,2 → 1,1 |

¹ El listado de 100 filas con una sesión no mejoró en esta ejecución de `perf:local` (142 ms, el tercer escenario tras arrancar). En el experimento controlado, con el mismo código final, bajó de 139 a **88 ms** ([`experimento-t4-despues.json`](experimento-t4-despues.json)); lo atribuimos a ruido de esa pasada, igual que la dispersión de Auth que ya describía U-QA-03.

- **Presupuesto de 1 s (acciones de navegación, 5 y 10 sesiones):** antes lo superaban la búsqueda @10 (2 154 ms), la búsqueda por ISBN @10 (1 329 ms) y el orden por autor @10 (2 109 ms); ahora el máximo es la búsqueda de texto @10 con **712 ms**. El contrato de `perf:local` pasa de 3 a **0** medidas `over-budget`.
- **SQL:** sin cambios materiales (listado 15 ms, búsqueda 110–124 ms de p50 con una sesión). La búsqueda sigue siendo la consulta más cara (T5 de U-QA-03).
- **Pool:** máximo observado 4 conexiones de la app; 11 abiertas en total al terminar la carga, de 100 permitidas.
- **Aislamiento bajo carga:** 572 comprobaciones, 0 violaciones (antes 348, 0).
- **Sin red externa:** el guard del servidor registró 0 salidas en las cuatro ejecuciones.

**Fuera del presupuesto de navegación (no cambian con esta unidad).** La lectura completa de Ajustes (2,8–4 s con 10 sesiones, 6,7 MiB) y los previews de importación (1,7–2,6 s @10) siguen por encima de 1 s con 5–10 sesiones: son cargas pesadas sin presupuesto de acción en el contrato y dominadas por serializar miles de fichas en el servidor, no por la sesión ni el pool. Su corrección es T1 de U-QA-03 (U-DAT-04: Ajustes sin leer la colección completa).

## 5. Seguridad (resumen; detalle en seguridad.md)

| Comprobación | Resultado |
| --- | --- |
| `pnpm test:integration:security --profile test` | 23/23. Nuevas en `revocacion.test.mjs`: escritura con sesión viva (control) y sin la atestación en la respuesta; **token revocado sin escritura** por acción (307), también con una atestación fabricada por el cliente; por `/api/books/add` (fuera del proxy: 401, con y sin cabecera fabricada); una atestación fabricada no cambia el usuario (B con la cabecera de A escribe en B). |
| `pnpm test:integration:local` (incluye `auth/sesion`: acción de lectura con una sesión cerrada → 307) | 77/77 y 1/1 (caída de servicios). |
| `pnpm test` (`tests/session-attestation.test.ts`) | Cabecera falsificada, de otro proceso, de otro token o usuario, caducada (> 30 s), futura y reutilizada en otra petición: rechazadas. Memo por petición: una verificación por petición y token; nunca compartida entre peticiones ni entre usuarios; un rechazo no contamina la siguiente petición. |
| `set_config('role', 'authenticated', true)` | Vuelve a `postgres` sin claims tras commit y tras rollback (comprobado en el Postgres del perfil). |

## 6. Limitaciones

- Máquina de desarrollo con otros stacks en marcha; la dispersión entre ejecuciones es apreciable (sobre todo Auth y los p95 con 15–20 llamadas por sesión). Las conclusiones se apoyan en el rendimiento por variante y en órdenes de magnitud.
- Kong/GoTrue y Postgres corren en el mismo Docker Desktop que la app y el generador de carga: la contención de CPU entre ellos forma parte de lo medido.
- La ganancia de T3 depende de que el proxy y la acción compartan proceso (`next start`, proxy en runtime Node: confirmado con 1,01–1,05 llamadas por acción). Si el alojamiento los separa, la acción vuelve a `getUser()` y a dos llamadas por petición, con la misma seguridad.
- Con 4 conexiones el siguiente límite es GoTrue (~50 ms por llamada local, más con concurrencia). Un GoTrue remoto puede tener otra latencia; repetir en preproducción.

## 7. Recursos

Al terminar: `pnpm perf:local:cleanup --profile test` (retira `escala@biblib.test` y su biblioteca) y `pnpm db:local:down --profile test`. Quedan, propios del perfil `test`: la red `biblib-test-network`, los volúmenes `supabase_db_biblib-test` y `supabase_storage_biblib-test` y los contenedores `supabase_*_biblib-test` parados. No se ha tocado ningún recurso de HolaERP ni de otros perfiles. Estado local no versionado: `.biblib/performance/` (logs y registro de accesos, sin tokens).

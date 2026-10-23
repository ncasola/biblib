# U-BIB-05 · Pruebas, medición y activación segura en todos los flujos (O10)

Rama `u-bib-05`, worktree hijo de `feature/spec-pendientes` (base `9a64364`). Sin schema, sin dependencias nuevas, sin Docker ni stack: la verificación con stack real (E2E de proveedores y `test:smoke`) queda **pendiente de ejecución por el coordinador** (ver «Pendiente»). No se ejecutó ninguna consulta real a proveedores ni el probe externo.

## Resultado en una frase

Los cuatro flujos (alta por ISBN, búsqueda por título y autor, importación y recuperación de portadas) consumen solo el orquestador; el último `fetch` directo a Open Library (`enrichImportedBookCovers`, usado por la revisión de la importación y por «Buscar portada») desapareció y una prueba estática impide reabrirlo.

## Qué cambia

**Un solo camino**
- `lib/library-import.ts`: se elimina `enrichImportedBookCovers` y todo su `fetch`/presupuesto propio. `prepareImportAction` **no consulta catálogos**: guarda la vista previa sin esperar portadas (`coversFound = 0`, `coversPending` = libros nuevos con portada genérica) y la publicación ya sembraba los elementos de portada de los libros insertados, que resuelve el trabajo de U-DAT-03 con el gateway en modo lote. La portada pendiente no bloquea ni revierte la importación. Ajustes dice ahora que las portadas se buscan después.
- `app/actions/books.ts` («Buscar portada» de la ficha): usa `bibliographicCatalog.getCover` (interactivo, con el `userId` de la sesión) **antes** de abrir la transacción, clasifica con `classifyCoverLookup` y distingue límite (`RATE_LIMITED`), caída (`PROVIDER_UNAVAILABLE`) y ausencia (`NOT_FOUND`); la procedencia del campo `cover` usa la fuente real y su URL de registro.
- `lib/bibliographic-catalog/providers/endpoints.ts` (nuevo): único sitio fuera del código de red de los adaptadores con `openlibrary.org` / `catalogo.bne.es`. `quota.ts`, `rights.ts`, `normalize.ts`, `marcxml.ts` y `lib/open-library.ts` lo importan (diff mínimo, sin cambio de comportamiento).
- `tests/bibliographic-catalog-egress.test.ts`: falla si esos hosts aparecen fuera de `providers/` (`next.config.mjs` y `proxy.ts` solo pueden nombrar `covers.openlibrary.org` como host de imágenes), si hay un `fetch` hacia algo que no sea una ruta propia fuera del adaptador y el gateway, si la revisión de la importación importa el catálogo o si un flujo crea un adaptador propio. La propia prueba comprueba con datos sintéticos que detecta cada violación.

**Importación y recuperación acotadas, reanudables y con fuente**
- El worker ya limitaba pasos (20 elementos/20 s), pausa/cancelación, `Retry-After` y contadores. U-BIB-05 añade: la **fuente de cada portada** (`result.provider` del elemento, telemetría `cover.recovery` por proveedor y, con `BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED=true`, procedencia del campo `cover` con selección «sin verificar» en `applyRecoveredCovers`), y un punto de inyección `applyCovers`/`reviewEnabled` en `WorkerDeps` para probar el flujo sin base.
- `tests/bibliographic-catalog-flows.test.ts` ejecuta el **servicio real** (orquestador, adaptador OL, gateway y un store en memoria extraído a `tests/support/catalogue-memory-store.ts`) con una red simulada: 45 libros en ≥3 pasos de ≤20, 47 peticiones (45 + las dos que se reintentan), concurrencia máxima 1, separación ≥1 s, ninguna petición durante el `Retry-After` de 40 s, pausa sin peticiones y reanudación sin repetir lo revisado, libro cambiado durante la búsqueda intacto.

**Retención** (`lib/bibliographic-catalog/retention.ts`, derivada de `rights.ts`; desconocido = denegado)
- Open Library: fichas y portadas (URL) conservables y exportables con su atribución. BNE: solo metadatos CC0 con URL de registro y hora; **sus imágenes nunca**. Google: nada permanente.
- `classifyCoverLookup` (trabajos), la ruta `/api/books/search` y `lib/api-client.ts` descartan lo no retenible: antes el trabajo habría guardado la primera imagen con `imageUrl`, aunque fuera una vista previa de Google o una imagen de BNE (hoy apagadas o sin capacidad, pero era una vía abierta al activarlas). La ruta devolvía además `candidates[0]` aunque fuera Google.
- La exportación se prueba: conserva `source`, URL, `recordId`, `retrievedAt` y selección por campo de OL y BNE (v2; el v1 rechaza BNE en lugar de degradarla), rechaza Google en la importación y no contiene caché, candidatos ni diagnósticos; los módulos de export/lectura no importan el catálogo ni tocan las tablas de coordinación.

**Medición y operación**
- `scripts/performance/catalogue-bench.mjs` (`pnpm perf:catalogue [--check]`): red simulada en tiempo virtual ×10. No existía `perf:local` en esta base (U-QA-03 aún no integrada y su `scripts/performance/` usa otros nombres), así que es un archivo propio. Resultados abajo.
- `scripts/catalogue-telemetry.mjs` (`pnpm catalogue:telemetry`): resumen de operador por proveedor desde los registros JSON (solo cantidades; sin red ni lectura de configuración).
- Probe real opcional (`pnpm test:e2e:external`): un ISBN público en Open Library y BNE, como mucho 3 peticiones, Google apagado; una ausencia se anota y no falla, una caída o un límite sí. **No ejecutado.**

**Fixtures y E2E** (`providers/fixture.ts`, más dos líneas en `config.ts` y `registry.ts`)
- Adaptador fixture parametrizado (`open-library` | `bne`) y cinco ISBN reservados, fuera del censo: `…0040` 5xx, `…0064` 429, `…0071` sin respuesta hasta el plazo, `…0088` cuota global agotada, `…0095` solo BNE.
- Activados en `flujos/proveedores.spec.ts`: proveedor vacío y otro disponible; 429/plazo/5xx/ausencia distinguidos por código HTTP (429, 503, 503, 404) y pantalla; cuota global agotada sin reintentos automáticos y con alta manual. En `ajustes.spec.ts` la recuperación de portadas en fixture (antes `fixme`) y en `importacion.spec.ts` «la revisión no consulta catálogos y las portadas se resuelven después». `pendientes.spec.ts` conserva solo «edición discrepante» (U-BIB-04) y «clave de Google ausente» (U-BIB-03).

## Criterios de aceptación de U-BIB-05

| Criterio | Evidencia |
| --- | --- |
| Los cuatro flujos consumen solo el orquestador; sin fetch directo ni duplicado a OL en componentes o jobs | `bibliographic-catalog-egress.test.ts` (4 pruebas); `grep` sin coincidencias fuera de `providers/`. |
| Topes por proveedor y deadline en cada ejecución | Pasos de 20/20 s, plazos 8 s/3,5 s/4 s (contrato de orquestador), cuota del gateway; `flows` (45 libros) y benchmark. |
| Open Library nunca recibe tráfico masivo; solicitudes concurrentes por consulta acotadas | Benchmark `--check`: ≤2 peticiones por segundo virtual con 100 consultas concurrentes y concurrencia máxima ≤2 al proveedor; el resto es `rateLimited`. |
| Tests por defecto sin red ni foto personal | La suite no hace llamadas (`fixture`/mocks); prueba de «solo ISBN o texto, sin cuerpo ni cabeceras de usuario». |
| Google apagado hasta revisión de cuota/precio/términos; clave solo de servidor | `flows`: cero salidas a Google con clave presente en los cuatro flujos; clave y consulta privada ausentes de logs, resultados y claves de caché; suites existentes de U-BIB-03. |
| Una fuente caída no bloquea guardar manual ni convierte fallo en inexistencia | Contrato por operación y estado (4 operaciones × 6 estados), `fixtures reservados`, E2E de proveedores (sin ejecutar con stack). |
| Contrato completo, 429 respetuoso, cola compartida, caché hit/expiración/invalidación, parcial | `flows` + `catalogue-gateway` + `bibliographic-catalog*` existentes. |
| Importación y recuperación limitadas y reanudables; fuente de cada portada | `flows` (3 pruebas) + `library-jobs`. |
| Retención / export | `bibliographic-catalog-retention.test.ts` (8 pruebas). |
| Benchmark 1/10/100 con p50/p95, deduplicación, cola, timeout y tamaño de caché | `pnpm perf:catalogue`; `tests/scripts/catalogue-bench.test.mjs`. |

## Benchmark con red simulada (tiempo virtual ×10; no mide rendimiento externo)

| Concurrentes | Fase | p50 ms | p95 ms | Peticiones al proveedor | Sin salir | Claves deduplicadas | Aciertos caché | Limitadas | Plazos agotados | Cola máx. | Entradas / bytes de caché |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | fría | 313 | 313 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 1 / 394 |
| 1 | caliente | 3 | 3 | 0 | 1 | 0 | 1 | 0 | 0 | 1 | 1 / 394 |
| 1 | sin respuesta | 3568 | 3568 | 1 | 0 | 0 | 0 | 0 | 1 | 1 | 0 / 0 |
| 10 | fría | 303 | 1563 | 2 | 8 | 5 | 2 | 6 | 0 | 1 | 2 / 788 |
| 10 | caliente | 7 | 924 | 1 | 9 | 5 | 7 | 4 | 0 | 1 | 3 / 1182 |
| 10 | sin respuesta | 11 | 3569 | 2 | 8 | 0 | 0 | 8 | 2 | 2 | 0 / 0 |
| 100 | fría | 293 | 333 | 2 | 98 | 50 | 2 | 96 | 0 | 1 | 2 / 788 |
| 100 | caliente | 82 | 335 | 1 | 99 | 50 | 7 | 94 | 0 | 1 | 3 / 1182 |
| 100 | sin respuesta | 71 | 77 | 2 | 98 | 0 | 0 | 98 | 2 | 2 | 0 / 0 |

Lectura: la mitad de las consultas repite ISBN y esas se deduplican en vuelo o salen de la caché; con 10 o 100 cuentas distintas simultáneas solo caben ~2 peticiones por plaza de cuota y el resto devuelve `rateLimited` con espera (no «no encontrado»); un proveedor mudo se corta a los 3,5 s virtuales con `incomplete`. La latencia p50 de las fases con muchas consultas limitadas refleja respuestas rápidas de «espera», no el servicio de una ficha. (Se omite la fase «con fallos» de la tabla; está en `--out`.)

## Resultados reales

| Comprobación | Resultado |
| --- | --- |
| `pnpm lint` | Correcto, sin advertencias. |
| `pnpm typecheck` | Correcto (incluye `tests/e2e`). |
| `pnpm test` | **272 pasadas, 0 fallos, 0 omitidas** (base 250; −9 pruebas retiradas junto con `enrichImportedBookCovers`, +31 nuevas). |
| `pnpm test:scripts` | **193 pasadas, 0 fallos, 2 omitidas** (por ausencia de stack acreditado), 195 declaradas. |
| `pnpm build` | Correcto con `BIBLIB_TARGET=test` y variables públicas de relleno (`NEXT_PUBLIC_SUPABASE_*` ficticias, `SUPABASE_DB_URL` ficticia); `pnpm build` a secas falla en este worktree por falta de variables públicas de Supabase en `lib/supabase/client.ts` (no hay `.env` y no se lee ninguno); no depende de este cambio. |
| `pnpm check:bundle` | Bundle cliente limpio (40 archivos). |
| `playwright test --list` | 56 pruebas en 11 archivos, títulos únicos; las nuevas tipadas y sin lint. |
| `pnpm test:e2e:local`, `pnpm test:smoke`, `pnpm test:integration:jobs` | **No ejecutados** (necesitan Docker/stack; el coordinador no respondió a la pregunta en 10 min y se aplicó la opción conservadora). |

## Decisiones y hallazgos

1. **BNE ficticia por defecto en `fixture`** (`config.ts`: la bandera `BIBLIB_BNE_ENABLED` vale `true` si el modo es `fixture`; `registry.ts`: adaptador BNE ficticio). El runner E2E elimina todo `BIBLIB_*` del entorno de la app, así que no hay otra forma de que el E2E vea dos fuentes sin tocar `scripts/db/environment.mjs` (U-INF-02). En `live` nada cambia (BNE apagada por defecto). Es el único cambio de comportamiento en `config.ts`.
2. **Ficha solo-BNE con la revisión apagada**: la ruta legacy devuelve la ficha con procedencia v2 y `catalogueForCreate` rechaza guardarla («La revisión bibliográfica no está activada»). Es el diseño actual de U-BIB-04, pero hace que BNE sin `BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED` dé una experiencia rota. Se documenta que se activan juntas; el E2E solo comprueba que se muestra y que encontrar no guarda. Decisión de producto pendiente si se quiere otro comportamiento.
3. **Consultas de lote sin agrupar**: cada ISBN pasa por el orquestador y su plaza de cuota (nada de multi-ISBN `bibkeys`). Acota el tráfico y mantiene un único camino; el coste es ≈1 libro/s por despliegue en importaciones grandes (2000 libros ≈ 33 min de trabajo en segundo plano). Un `getCovers(isbns[])` sería un incremento aparte con contrato propio.
4. **La fuente de cada portada solo consta en la ficha con la revisión activa**; con ella apagada queda en el resultado del elemento y la telemetría. La vista del trabajo no resume portadas por fuente (sin cambio de schema ni de DTO).
5. **Regla estática y U-OPS-04**: si U-OPS-04 nombra `covers.openlibrary.org` en CSP fuera de `next.config.mjs` o `proxy.ts`, la prueba de salidas fallará al integrarlas y habrá que ampliar su lista (`IMAGE_HOST_CONFIGURATION`). Lo mismo si U-DAT-08 añade en `app/books/add/**` un `fetch` hacia una URL absoluta.
6. La prueba `tests/book-detail-not-found.test.ts` (U-FIX-01) necesitó un stub de `@/lib/bibliographic-catalog/server` porque `app/actions/books.ts` ahora importa el catálogo; `tests/catalogue-gateway.test.ts` (U-DAT-05) pasó a importar el store en memoria de `tests/support`. Ambos cambios son mecánicos.
7. No se tocó `app/books/add/**` ni `app/actions/bibliography.ts`, ni `scripts/performance/**` de U-QA-03 (solo se añadió `catalogue-bench.mjs`; `package.json` añade `perf:catalogue` y `catalogue:telemetry` al final del bloque, a conciliar con `perf:local` de U-QA-03).

## Pendiente (para el coordinador)

- Con el perfil `test` libre: `pnpm test:e2e:local` (esperado: las 3 pruebas nuevas de proveedores, la de Ajustes y la de importación en verde; Chromium), y `pnpm test:integration:jobs --profile test` porque `applyRecoveredCovers`, `classifyCoverLookup` y `WorkerDeps` cambiaron.
- `pnpm test:smoke` (levanta su propio contenedor efímero `biblib-smoke-*` y Chrome; no usa perfiles).
- Decidir si se autoriza el probe externo (`pnpm test:e2e:external`, un ISBN, ≤3 peticiones).
- Recursos Docker que deja este worktree: ninguno (no se levantó ningún stack ni contenedor).

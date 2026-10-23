# U-BIB-04 · Procedencia, conflictos y elección de candidato

Rama `u-bib-04`, hija de `feature/spec-pendientes` (`b2339ea`). Worktree propio sin perfiles Supabase. Docker solo se usó para el contenedor efímero de `pnpm test:smoke`. **Sin migración:** `catalogue` es JSONB sin `CHECK` sobre su contenido, así que no hizo falta preguntar a U-DAT-03.

## Entrega

| Área | Archivos | Resumen |
| --- | --- | --- |
| Modelo de procedencia | `lib/types.ts`, `lib/catalogue-provenance.ts` | `FieldProvenance`, `CatalogueAttributionV2` (`catalogue.schemaVersion: 2`, `fields` por campo). Lectores v1/v2, `isbnChecksumValid` derivado al leer y nunca persistido, `isbnVerified=false` sin valor legacy. Las fuentes desconocidas y `google-books` se rechazan con explicación y nunca se convierten en `manual`. |
| Writers | `app/actions/books.ts` (solo `catalogue`), `lib/book-validation.ts`* | Alta: v2 solo con `BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED=true`; si no, v1 como hoy y una v2 se rechaza sin recortarla. Edición: la procedencia se recalcula en el servidor desde la ficha bloqueada y versionada; los campos cambiados pasan a `manual` y una ficha v2 no la pierde si se apaga la bandera. Portada recuperada: actualiza `fields.cover`. |
| Formato portable v2 | `lib/backup-v2.ts`, `lib/library-import.ts`, `lib/library-export.ts`, `app/settings/page.tsx`* | Payload canónico con `works=[]`, y edición y copia con `id = book.id` (contrato U-DAT-06). Verificación física en la copia y fuentes por campo en la edición. `requiredCapabilities` declaradas y lector con capacidades. Rechaza con explicación varias copias por edición, obras, secciones o campos desconocidos. El export v1 solo se ofrece sin pérdida; con BNE o `fields`, v2. Partes v2 independientes con los mismos límites. |
| Mapeo de candidatos | `lib/bibliographic-catalog/normalize.ts`, `lib/bibliography-review.ts` | Candidato y portada → `FieldProvenance` (Google → `null`). Valores agrupados por campo, evidencia literal sin porcentajes, regla de combinación y combinación que respeta lo manual. `candidateToLegacyBook` atribuye BNE con su fuente real. |
| UI de alta | `app/books/add/page.tsx` (servidor, lee la bandera), `app/books/add/add-book-screen.tsx`, `components/bibliography-review.tsx`, `components/book-search-result.tsx` | Con la bandera: tarjetas por candidato, «Combinar campos compatibles», selección campo por campo, portada aparte con fallback, resumen editable con estantería y estado, «Completar manualmente». Los resultados tardíos se descartan. Sin la bandera la pantalla es la misma; un resultado BNE avisa antes de guardarse como entrada manual. |
| Detalle y edición | `components/catalogue-provenance-details.tsx`, `components/book-details-screen.tsx`, `components/book-form.tsx` | Fuente principal, comprobación humana separada del dígito de control y procedencia por campo. El formulario conserva la procedencia cargada y avisa del efecto de editar. |
| Documentación | `docs/formatos.md`, sección propia en `docs/operacion.md` | v1, legacy, v2, `bundleVersion` reservado, `catalogue.schemaVersion`, capacidades y qué se rechaza y por qué. |

\* Archivos fuera de la propiedad de la unidad, **autorizados por el coordinador** (`orca orchestration ask`), cada uno en su propio commit: `177b40c` (`book-validation.ts` importa el schema de `catalogue` v1|v2) y `fc7e16b` (Ajustes usa `exportLibraryBackup()` y muestra el formato elegido; la importación con vista previa y confirmación de U-DAT-01 no cambia).

## Criterios de aceptación de 06 · U-BIB-04

| Criterio | Evidencia |
| --- | --- |
| Los formularios no escriben antes de confirmar | La revisión solo llama a `addBookAction` desde el envío del resumen. Combinar, elegir y escribir solo cambian estado local. Los resultados de búsquedas anteriores se descartan por número de petición. |
| No se sobrescriben campos manuales ni verificados | `combineCompatibleFields` y «Tomar los campos de esta ficha» omiten los campos escritos y lo anuncian. En la edición, los cambios pasan a `manual` y los `manually-verified` sin cambios se conservan (`tests/bibliography-review.test.ts`, `tests/catalogue-provenance.test.ts`). |
| Un conflicto visible conserva cada valor y su fuente | Cada campo con varios valores muestra cada opción con sus fuentes («2009 — Open Library» / «2011 — BNE»). El resumen indica la procedencia del valor elegido y el detalle la persiste por campo. |
| Combinar solo con ISBN exacto y señales compatibles | `combinability`: ISBN canónico exacto en todas las fichas e idioma y formato no incompatibles. El año distinto no bloquea, pero queda como conflicto. Si no se cumple, se explica el motivo y solo queda la selección por campo. |
| Ni el proveedor ni el checksum marcan `isbnVerified` | `buildReviewedCatalogue`, `normalizeCatalogue`, `bookToEditionAndCopy` y `readCatalogueView`, con pruebas en las tres suites. Solo la casilla «He comprobado…» lo activa, y solo con un ISBN válido. |
| Sin valor legacy, `false` | Pruebas de `parseLibraryImport` (fixture de 111) y de `readCatalogueView`. |
| Los metadatos legacy se leen igual | Las pruebas existentes de `library-import` siguen pasando. Legacy y v1 del fixture dan el mismo resultado. |
| Un export antiguo sigue importando | `los exports antiguos v1 y legacy {books, shelves} siguen importando igual` y la ida y vuelta v1→v2→v1. |
| El enum de fuente no clasifica Google por defecto | `google-books` se rechaza al importar y al guardar, como fuente y como campo. En el detalle aparece como «Fuente no reconocida». Google no es seleccionable y sus portadas no se guardan. |

## Pruebas pedidas en la tarea

| Caso | Prueba |
| --- | --- |
| Conflictos por título, autor, fecha, idioma, formato e ISBN | `tests/bibliography-review.test.ts` (evidencia y motivos de no combinar). |
| Selección por campo y por portada | Opciones por campo con sus fuentes y portada de un proveedor distinto del resto (`coverProvenance`, `buildReviewedCatalogue`). |
| Edición concurrente con `Book.version` y revisión de colección | `tests/catalogue-provenance.test.ts`: la versión antigua da `CONFLICT`, la nueva parte de la procedencia vigente y un cambio solo de procedencia caduca una vista previa (`REVISION_CONFLICT`). El trigger de revisión de U-DAT-01 rota con cualquier escritura en `books`. |
| Ida y vuelta v1→v2→v1 sin pérdida y v2→v2 | `tests/backup-v2.test.ts` con `tests/fixtures/import/sintetico-111.json` (111 copias, IDs iguales, mismo plan de U-DAT-01). |
| Lector que rechaza lo no representable | 12 casos con mensaje explicativo (varias copias, obras, capacidades, secciones y campos desconocidos…). |
| Accesibilidad (roles y labels) | `tests/bibliography-review-a11y.test.ts`. No había infraestructura de pruebas de componente: `tests/support/tsx-loader.mjs` transpila TSX con TypeScript, resuelve `@/` y sustituye `next/image` y `next/link`. Renderiza con `react-dom/server` y comprueba que cada `input`, `select` y `textarea` tiene una etiqueta asociada, la sección con nombre, `article` con `aria-labelledby` y su `h4`, listas de estado y de evidencia con `aria-label`, `fieldset`/`legend` por campo y por portada, región `role="status"`, `role="alert"` en errores y enlaces externos con aviso para lector. El árbol volcado durante la revisión tenía h2 › h3 (Fichas candidatas, Combinar o elegir, Resumen) › h4 por ficha, 5 grupos de radio, portada con 2 opciones y 10 controles etiquetados en el resumen. La navegación con teclado usa solo controles nativos (radios, casillas, `select`, botones). |

## Resultados de validación (23-10-2026, ejecutados en el worktree)

| Comando | Resultado |
| --- | --- |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **207/207** (180 antes de la unidad, 27 nuevas) |
| `pnpm test:scripts` | 150 pasan, 0 fallan, 2 omitidas `[stack]` porque `scratch` no está arrancado |
| `pnpm build` con los placeholders de CI (`NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co`, `NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-public-placeholder`) | Compila. `/books/add` pasa de estática a dinámica (ƒ) porque lee la bandera en cada petición. |
| `pnpm test:smoke` | exit 0, **12/12** comprobaciones, incluidas alta, edición y verificación de ISBN, exportación versionada, importación en dos pasos y exportación de 2001 libros en dos partes. Con la bandera apagada, la UI actual sigue igual. |

**Recursos Docker:** el smoke creó y eliminó su contenedor `biblib-smoke-*` (`--rm`, etiqueta `biblib.test=smoke`). `docker ps` antes y después es idéntico y no quedan redes ni volúmenes de esta unidad. No se arrancó ningún perfil Supabase ni se tocó HolaERP.

## Límites y pendientes

1. **El flujo con la bandera activa no se probó en un navegador real.** El smoke se ejecuta con la bandera apagada y no había perfil de stack disponible. El HTML inicial se verifica con la prueba de componente y la lógica con pruebas puras. Queda propuesto un E2E en `tests/e2e/**` (U-QA-02) con `BIBLIB_CATALOGUE_MODE=fixture` y `BIBLIB_BIBLIOGRAPHY_REVIEW_ENABLED=true`. En modo fixture solo hay candidatos de Open Library; las tarjetas BNE se prueban con candidatos sintéticos.
2. **Portadas de Google en la ruta legacy.** `app/api/books/search/route.ts` (fuera de mi propiedad) usa `getCover(...).candidates[0].imageUrl` sin mirar el proveedor. Hoy Google está apagado y U-BIB-03 garantiza que no devuelve `coverUrl` en candidatos, pero conviene filtrar `provider !== "google-books"` en esa ruta (U-BIB-03/U-BIB-05). La revisión nueva ya lo excluye.
3. **Idioma y formato** se muestran y se comparan, pero no se persisten: `Book` no tiene esas columnas y añadirlas exige una migración (U-DAT-06).
4. **`manually-verified` por campo:** lectores, writers y export lo conservan, pero la UI aún no ofrece marcar un campo como comprobado en el ejemplar (bandeja de U-DAT-07).
5. **Compatibilidad hacia atrás:** las versiones anteriores a U-BIB-04 rechazan `formatVersion: 2`. Por eso se mantiene el export v1 cuando no pierde nada y no conviene revertir el despliegue con fichas v2 sin descargar antes una copia v2.
6. El lector legacy/v1 sigue ignorando claves desconocidas de nivel libro, como antes (por ejemplo `version`). El lector v2 es estricto. El manifest `bundleVersion: 1` queda reservado para U-DAT-04.

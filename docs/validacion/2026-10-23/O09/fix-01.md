# U-FIX-01 · Fixture sin tráfico externo y ficha 404

23-10-2026 · Rama `u-fix-01`, hija de `feature/spec-pendientes` · Sin stack Supabase ni operaciones remotas.

## Corrección y puntos de salida

| Camino encontrado | Resultado |
| --- | --- |
| `lib/library-import.ts` → `enrichImportedBookCovers` → `fetch https://openlibrary.org/api/books` | Guarda con `readCatalogConfig()`: en fixture devuelve los libros preparados sin consultar ni modificar portadas existentes. Los fixtures actuales no ofrecen portada fuente, así que conserva `/default-book-cover.webp` donde falta. Incluye el modo fixture predeterminado de local/test. |
| Recuperación de lotes y «Buscar portada» (`app/actions/cover-recovery.ts`, `app/actions/books.ts`) | Ambos llaman al mismo enriquecimiento protegido: en fixture no buscan en Internet ni publican una portada nueva. No se cambia su lógica de publicación. |
| `lib/api-client.ts` → `createOpenLibraryClient` → adaptador live | `searchBookByISBN` delega en `bibliographicCatalog.lookupISBN/getCover`, conserva los errores tipados y transforma el resultado a `Book`. Descarta Google del resultado guardable. |
| `/api/books/search` → primer candidato de portada | Filtra `google-books` y selecciona la primera portada persistible; si solo hay Google, devuelve fallback local. Esta ruta no escribe en la base. |

El lote **live** conserva su implementación y límites previos: 20 ISBN por petición, separación mínima de 1 s, timeout de 8 s y presupuesto global de 20 s. Su migración completa al gateway/cuota sigue siendo U-BIB-05; no cambian firmas públicas, parser, plan ni publicación de la importación. La guarda mínima evita importar `server-only` desde `library-import.ts`, que también consumen Ajustes y la exportación en cliente.

La página de ficha valida UUID antes de llamar al lector y activa `notFound()` tanto para ID inválido como para UUID ausente. El lector valida antes de Auth/DB y devuelve `null` para ID inválido. El límite específico muestra «Libro no encontrado», enlace a `/books`, título «Libro no encontrado · BibLib» y `robots` privado; una caída real conserva la clasificación de indisponibilidad.

## Evidencia ejecutada

| Comando | Resultado final |
| --- | --- |
| `pnpm lint` | Código 0. |
| `pnpm typecheck` | Código 0. |
| `pnpm test` | **232/232**, sin omitidas. |
| Nuevas regresiones, incluidas en `pnpm test` | **5/5**: importación/recuperación/búsqueda fixture con espía global `fetch` que lanza y **0 llamadas**; filtro Google; página 404; lector antes de Auth/DB; contenido y metadata del límite 404. |
| `BIBLIB_SKIP_STACK_TESTS=1 pnpm test:scripts` | **174 superadas, 2 omitidas, 0 fallidas**; también compila los builds test/prod con placeholders. Las dos omitidas necesitan stack y quedan fuera de esta unidad. |
| `pnpm build` | Código 0, con `NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co` y `NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-public-placeholder`; sin archivos privados de entorno en el worktree. |
| `pnpm test:smoke` | Código 0, **12 grupos superados**, build temporal, Chrome, Auth simulado y Postgres efímero propio. Artefactos locales: `C:/Users/ncaso/AppData/Local/Temp/biblib-smoke-results-1792780117033`. |
| Sonda HTTP de ficha con la infraestructura del smoke | Código 0: sesión ficticia en Chrome, `/book/no-es-un-uuid` y `/book/99999999-9999-4999-8999-999999999999` responden **HTTP 404**, título «Libro no encontrado · BibLib», enlace «Volver a la colección» y ningún mensaje de conexión; registro externo vacío. Sonda temporal sin modificar `scripts/smoke-app.mjs`; artefactos en `C:/Users/ncaso/AppData/Local/Temp/biblib-smoke-results-1792780357158`. |

Durante la preparación se corrigió un error de tipado del hook `beforeEach` que hizo fallar el primer intento de test/typecheck y uno de los builds de scripts; la tabla recoge las repeticiones finales completas. También se retiró una importación de schema Drizzle desde el harness CommonJS para evitar mezclar tipos import/require: las fronteras DB siguen inyectadas y no se modifica el schema.

## Coordinación, límites y recursos

El coordinador autorizó explícitamente los ajustes mínimos de `tests/library-import.test.ts` y `tests/observability.test.ts` para seleccionar `live` en las simulaciones previas, sin cambiar sus aserciones; van en commit aislado. También autorizó `app/book/[id]/not-found.tsx` y el contenedor propio del smoke. `app/actions/books.ts` solo cambia su lector `getBookDetailAction`.

No se arrancó ningún perfil Supabase ni se tocaron recursos ajenos. El smoke retira su contenedor `biblib-smoke-<uuid>` y sus volúmenes anónimos; la comprobación posterior `docker ps -a --filter label=biblib.test=smoke` no devuelve recursos. No se crean redes ni volúmenes persistentes propios, y no quedan recursos Docker de esta unidad.

Queda para el coordinador integrar y actualizar el E2E de U-QA-02 que marca el ID inválido como fallo conocido; no se modifica ese archivo compartido. El enrutado live completo de lotes y su cuota son U-BIB-05, y no se reparan aquí datos de censos de otros perfiles.

Commits de implementación: `721f6a2` (selección live en tests existentes) y `d5cbd7f` (corrección y regresiones). El informe se versiona en un commit documental posterior.

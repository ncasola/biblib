# U-PRO-05 · Series y orden de volúmenes

Implementación del 25 de octubre de 2026 en `u-pro-05`, hijo de `feature/spec-pendientes`. Sin schema ni migraciones (usa las tablas `series` y `series_editions` de `0014`), sin dependencias nuevas y sin perfiles Supabase desde este worktree.

Commits (en orden): `81bedb9` acciones, `5a19562` rutas, `817a636` sección de la ficha, `39b279d` filtro del catálogo, `ffb87cf` pruebas unitarias, `1e90721` grupo de integración `series`, `9595fba` E2E, `f18f631` matriz de cabeceras; el commit documental posterior añade esta evidencia y la sección de `docs/operacion.md`.

## Entrega

- **`app/actions/series.ts`**: `listSeriesAction`, `getSeriesAction`, `getEditionSeriesAction`, `createSeriesAction`, `updateSeriesAction`, `deleteSeriesAction`, `linkEditionToSeriesAction`, `moveSeriesVolumeAction` y `unlinkEditionFromSeriesAction`. Dueño de la sesión, bloqueo de colección, `version` por registro (`CONFLICT`), edición o serie ajena → «no disponible» (misma respuesta que un identificador inexistente). La posición sale y entra como texto decimal (`SERIES_POSITION_PATTERN`, `trim_scale(...)::text`); nunca `float`. Borrar la serie retira vínculos y conserva ediciones y ejemplares. Validación y DTO compartidos en `lib/series.ts`.
- **`/series` y `/series/[id]`**: listado con alta, detalle con edición, borrado confirmado, orden exacto 1, 1.5, 2, volúmenes de orden desconocido al final y mostrados como «Orden desconocido» (nunca se infiere de la fecha ni del título), mover/cambiar y quitar cada volumen. Una serie incompleta o vacía es válida. Entrada «Series» en la navegación y ruta protegida.
- **Ficha (`components/edition-series-panel.tsx`)**: sección propia «Serie» para vincular, cambiar y quitar; sin serie, una línea y un botón. `BookForm` no se toca.
- **Catálogo**: filtro «Serie» en `/books` y `/books/search` (`?series=<uuid>`), aditivo: sin serie, ni la URL ni los filtros cambian; el selector solo aparece si la cuenta tiene series.

## Verificación ejecutada

| Comando | Resultado y evidencia |
| --- | --- |
| `pnpm lint` | Exit 0, sin avisos: `lint.log`. |
| `pnpm typecheck` | Exit 0; compila también el E2E nuevo: `typecheck.log`. |
| `pnpm test` | Exit 0; 393/393, sin omitidas (6 pruebas nuevas en `tests/series.test.ts` y la ruta `/series` en `auth-navigation`): `unit.log`. |
| `BIBLIB_SKIP_STACK_TESTS=1 pnpm test:scripts` | Exit 0; 252 superadas, 2 de stack omitidas, 0 fallos (254): `scripts.log`. Una primera ejecución falló solo porque la matriz de cabeceras no incluía `/series`; se añadió y quedó en verde. |
| `pnpm test:db` | Exit 0 (incluye la comprobación de series con `NUMERIC` exacta, una por edición y del mismo dueño): `test-db.log`. Contenedor propio, retirado al terminar. |
| `pnpm build` | Exit 0, con valores públicos/DB ficticios en loopback puerto 9 (sin archivos de entorno ni conexión); aparecen `/series` y `/series/[id]`: `build.log`. |
| `pnpm check:bundle --forbid-local-login` | Exit 0: `bundle.log`. |
| `pnpm test:smoke --artifacts=…/pro-05/smoke` | Exit 0, 12 comprobaciones, Auth simulado y Postgres efímero propio, sin tráfico externo: `smoke.log`, `smoke/report.json` y capturas (la navegación ya muestra «Series»). Se omiten las descargas JSON voluminosas del fixture. No sustituye GoTrue/Storage reales. |

## Integración pendiente del coordinador (no ejecutada aquí: «sin stack»)

- **Grupo `series`** (`pnpm test:integration:series --profile test|scratch`; registrado en `SUITES` y, por tanto, en `test:integration:local`): `tests/integration/series/volumenes.test.mjs` (crear; vincular 1, 1.5, 2 y sin posición; rechazo de «01.50», negativos y texto; conflicto de versión; mover entre series; quitar sin borrar edición ni ejemplar; editar y borrar serie; filtro del catálogo), `permisos.test.mjs` (título repetido en otra cuenta, B contra series, ediciones y vínculos de A por acción y por SQL con claims de B, anónimo) e `ida-vuelta.test.mjs` (exportación v2, reemplazo, versión anterior, otra cuenta, archivo v1 sin series). **Compilan (`node --check`) y su ejecución de argumentos se verificó (`--bogus` → exit 2); no se han ejecutado contra Postgres/GoTrue reales.** Reutilizan el harness del grupo `product` (`tests/integration/series/lib/context.mjs`).
- **E2E** `tests/e2e/flujos/series.spec.ts` (4 recorridos: crear y vincular con orden 1, 1.5, 2 y desconocido, mover y quitar; ficha sin serie y posición inválida; borrar la serie conservando libros; filtro por serie con URL): compila, **sin ejecutar**. Ejecutar con `pnpm test:e2e:local --grep series`. Los selectores no se han podido probar contra la app real: si algún texto no coincide, es un ajuste de la prueba, no de la función.
- `pnpm security:headers:local --profile test` con la matriz ampliada (`/series`, `/series/:libroA`), y revisión manual de teclado/lector de pantalla en `/series` y la sección de la ficha.

## Ajustes compartidos (mínimos y aditivos)

`components/book-details-screen.tsx` (importar y renderizar la sección; el encargo asigna la ficha), `components/header.tsx` (entrada «Series»), `lib/auth-navigation.ts` y `tests/auth-navigation.test.ts` (ruta protegida), `lib/book-search.ts`, `app/actions/library.ts` y `components/books-table.tsx` (filtro), `tests/integration/run.mjs` (`SUITES`), `package.json` (script `test:integration:series` al final), `scripts/security/headers-matrix.mjs` (rutas) y `tests/e2e/lib/e2e-manifest.mjs` (una línea que limpia series marcadas `[QA-02 …]`). Posibles conflictos de fusión triviales con U-PRO-01/03 en la navegación, `SUITES`, `package.json`, `books-table.tsx` y `book-details-screen.tsx`.

## Fuera de alcance / decisiones

- Sin schema, sin cambios a v2, snapshots, restore ni eliminación de cuenta: ya cubren `series` y `series_editions` (lote D). Los datos de series entran en la exportación v2 y se comprobará en el grupo `series`.
- La posición acepta la coma decimal al escribir («1,5» → «1.5») y rechaza ceros a la izquierda («01.50»), como fija `SERIES_POSITION_PATTERN`.
- El orden de los resultados del catálogo con el filtro por serie sigue siendo el del catálogo (título por defecto); el orden por volumen está en `/series/[id]`.

## Recursos

No se arrancó ni paró ningún perfil Supabase. `test:db` y `test:smoke` crearon y retiraron sus propios Postgres efímeros: no dejan contenedores, redes ni volúmenes propios. Los contenedores `supabase_*_biblib-test` y HolaERP que están en marcha no son de este worktree y no se tocaron. Sin push ni PR; árbol final commiteado.

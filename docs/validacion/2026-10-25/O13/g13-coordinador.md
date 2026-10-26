# Puerta G13 · Coordinador (O13 completa, cierre de F2)

**Fecha:** 25 de octubre de 2026 · **Commit:** `9f05efd` en `feature/spec-pendientes` (head `0014_product_batch_o13`) · **Run de Orca:** `run_a30695704f5a`.

O13 integra:
- El lote de schema único **O13-D** (`0014` más [contratos-o13](../../../spec-pendientes/contratos-o13.md)).
- Las unidades **U-EXP-05**, **U-PRO-05**, **U-DAT-07**, **U-EXP-06**, **U-PRO-01**, **U-DAT-09** y **U-PRO-03**.
- La corrección **O13-FIX** de los fallos encontrados al ejecutar por primera vez en el stack real los grupos que se escribieron sin stack.

El árbol de `9f05efd` es idéntico al de `519c1d0` (`git diff` vacío), que es el commit validado en el perfil `test`.

| Comprobación | Resultado |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | correctos |
| `pnpm test` | 460/460 |
| `pnpm test:scripts` | 269 superadas, 2 omitidas porque requieren `scratch` |
| `pnpm test:db`, `pnpm build`, `pnpm check:bundle --forbid-local-login` y `pnpm test:smoke` | correctos |
| `db:local:bootstrap --profile test` | `passed`, head `0014_product_batch_o13` |
| `pnpm test:integration:local` (19 grupos, entre ellos `product`, `series`, `review`, `media`, `personal`, `csv` y `locations`) | 231/231 en **dos** pasadas seguidas, sin datos residuales |
| `pnpm test:integration:media --profile test` (build propio con `BIBLIB_PRIVATE_MEDIA_UPLOADS=1`) | 5/5 |
| `pnpm test:integration:security --profile test` | 23/23 |
| `pnpm test:e2e:local` (Chromium) | 63 superados, 0 fallidos, 19 `fixme` de unidades futuras |

La evidencia de cada unidad está en `docs/validacion/2026-10-25/O13/{d,exp-05,pro-05,dat-07,exp-06,pro-01,dat-09,pro-03,fix}/`.

## Criterios de G13

- **Revisión (U-DAT-07):**
  - La bandeja paginada resuelve incidencias y conserva la evidencia.
  - Las acciones masivas, de hasta 50, tienen preview y versión.
  - Ninguna selección automática acredita `physically_checked`.
- **CSV (U-DAT-09):**
  - Maneja BOM, Unicode, comillas y saltos de línea entre comillas, con mapeo explícito.
  - Las fórmulas no se ejecutan y el informe las escapa.
  - Los errores por fila bloquean por defecto. Omitirlos exige una elección explícita, con plan e informe.
  - Un reintento no duplica filas.
- **Cámara (U-EXP-05):**
  - Pide permiso solo tras una acción del usuario.
  - `Permissions-Policy` vale `camera=(self)` solo en `/books/add`.
  - El alta manual sigue disponible, y añadir otra copia es explícito.
- **Avatar (U-EXP-06):** es privado (WebP sin EXIF, `biblib-media`), persiste y, si falla, conserva el anterior.
- **Notas, tags y rating (U-PRO-01):** son del ejemplar.
- **Ubicación física (U-PRO-03):** no cambia la estantería lógica.
- **Series (U-PRO-05):** describen la edición, con orden exacto.
- **Datos nuevos:** todos entran en v2, versiones anteriores, respaldo y restauración, y eliminación de cuenta (O13-D y grupo `product`).

## Incidencias resueltas por el coordinador

- **Merge U-PRO-01 sobre U-PRO-05:** el coordinador combinó a mano el filtro por serie y el de etiquetas en `components/books-table.tsx`, `lib/book-search.ts` y `app/actions/library.ts`. O13-FIX revisó la combinación y añadió una prueba de integración que usa los dos filtros juntos.
- **`lib/media/server.ts`:** lo crearon U-EXP-06 y, en versión mínima, U-PRO-03. U-PRO-03 se concilió con la API de U-EXP-06.
- **Mensajes de rechazo de imágenes:** citaban los límites y la palabra «portada». Ahora usan los límites de cada tipo (`26305d0`).
- **O13-FIX:**
  - **Harness de integración:** no admitía las referencias de React en las respuestas de acciones.
  - **Error real en CSV:** al rehacer el mapeo se escribía en `import_previews` sin permiso.
  - **Pruebas de series:** no estaban aisladas.
  - **Carrera en el E2E de etiquetas.**

## Decisión anotada

Repetir la fusión de un archivo de **otra** cuenta crea una serie (o ubicación) vacía nueva en vez de reutilizarla. Así lo fija el contrato: solo se reutilizan por ID las propias, y no se duplican volúmenes. El coordinador acepta este comportamiento. Evitar los contenedores vacíos duplicados queda como mejora opcional.

## Incidencia de entorno

HolaERP se detuvo de forma ordenada (exit 0) hacia las 21:29 UTC. Ninguna orden del coordinador ni de los workers lo detiene: solo las pruebas de caída paran el gateway del propio perfil `test`. No se ha vuelto a arrancar; queda pendiente de que Néstor lo confirme.

# Evidencia O13-FIX · fallos de la puerta G13 en el stack real

Rama `o13-fix` (worktree `stack-test`, perfil `test` en head `0014`), sobre `feature/spec-pendientes` en `26305d0`. Salidas reales, sin secretos. Las cuentas son desechables `@biblib.test`.

## Fallos y causa

| # | Fallo G13 | Causa | Corrección | Commit |
| --- | --- | --- | --- | --- |
| 1a | `csv/importacion.test.mjs`: 5 pruebas, «tipo no admitido por el harness» | React Flight deduplica un objeto repetido con una referencia de ruta (`$1:value:omittedRows`): `prepareCsvImport` devuelve `omittedRows` en la raíz y en `plan.csv`. El harness solo resolvía `$<fila>`. | Harness ampliado de forma aditiva (`tests/integration/lib/app.mjs`): la ruta se recorre sobre el JSON sin resolver. Hay un caso nuevo en `tests/scripts/integration-runner.test.mjs`. | `10622d2` |
| 1b | 2 de esas pruebas, tras 1a: `PROVIDER_UNAVAILABLE` al rehacer el mapeo o la revisión | **Error real de la acción.** `setCsvMapping` y `prepareCsvImport` hacían `UPDATE import_previews SET expires_at = now()`, pero `authenticated` solo tiene SELECT/INSERT/DELETE en esa tabla (0003): `permission denied`. | Se retiran los dos `UPDATE` (`lib/csv-import/staging.ts`). Ya invalida la sesión: confirmar una vista previa CSV cuyo `previewId` o hashes no coinciden con la sesión da `PREVIEW_EXPIRED` en `import-publisher`. Sin cambios de schema. | `0c3b889` |
| 2a | `series/volumenes.test.mjs:60`: `shelves_user_id_title_unique (…, Principal)` | La prueba llamaba otra vez a `ctx.library(a.id)` para la misma cuenta, lo que duplicaba su estantería predeterminada. | El ejemplar extra se inserta en la estantería ya creada. | `309881a` |
| 2b | `series/volumenes.test.mjs:141`: 2 frente a 3 | Consecuencia de 2a: el volumen sin posición nunca se vinculaba. | Ninguna aparte de 2a. | — |
| 2c | `series/ida-vuelta.test.mjs:78`: «repetir la fusión no duplica series» | La expectativa contradice el contrato (`contratos-o13`, «Formato v2» → «Fusión»): solo se reutilizan por ID las series **propias**. La serie de A llega a B con un ID nuevo en cada fusión. La 2.ª fusión crea una serie vacía (ninguna edición es nueva) y no toca volúmenes ni vínculos. Las ubicaciones se comportan igual. | Pregunta al coordinador (`msg_11f6eca83f85`), sin respuesta en 2 × 10 min. Se aplica la **opción conservadora**: el código y el contrato no cambian, y la prueba afirma lo que el contrato garantiza (no se duplican volúmenes ni se hereda el ID). | `053231b` |
| 3 | E2E `csv.spec.ts:63`: «Revisión CSV preparada…» en lugar de «Mapeo guardado» | Mismo error real que 1b: guardar el mapeo con una revisión ya preparada fallaba y el aviso anterior seguía en pantalla. No es una regresión de la UI ni de la prueba. | Corregido por `0c3b889`. | `0c3b889` |
| 4 | E2E `personal.spec.ts:46`: no aparece el botón «Filtros» en escritorio | Carrera en la prueba: `isVisible()` no espera, y antes de la primera carga `BooksTable` muestra `LoadingState` sin el panel. En escritorio la prueba buscaba entonces el botón móvil. El merge `215113d` está bien: serie y etiquetas se combinan en `listBooksAction`. | `await expect(filters).toBeAttached()` antes de decidir. Una aserción nueva de integración cubre serie + etiquetas a la vez. | `44ac014`, `c752ee5` |

## Aceptación (ejecuciones reales)

| Comprobación | Resultado | Archivo |
| --- | --- | --- |
| `pnpm test:integration:local`, 1.ª pasada | 231/231 y caída de servicios 1/1 | `integracion-1.log` |
| `pnpm test:integration:local`, 2.ª pasada, sin datos residuales | 231/231 y 1/1; «Cuentas de Auth sin cambios… Limpieza del run completa» | `integracion-2.log` |
| `pnpm test:integration:media --profile test` | 5/5 | `media.log` |
| `pnpm test:integration:security --profile test` | 23/23 | `security.log` |
| `pnpm test:e2e:local` | 63 superados, 0 fallidos y 19 omitidos (pendientes por unidad) | `e2e.log` |
| `pnpm lint` / `pnpm typecheck` | OK / OK | `lint.log`, `typecheck.log` |
| `pnpm test` | 460/460 | `unit.log` |
| `pnpm test:scripts` | 269 superadas, 0 fallidas y 2 omitidas (necesitan el perfil `scratch`) | `scripts.log` |
| `pnpm build` / `pnpm test:smoke` | OK / `ok: true` | `build.log`, `smoke.log` |
| `pnpm db:local:down --profile test` | Perfil parado; volúmenes conservados | `test-down.txt`, `recursos-docker.txt` |

## Recursos y observaciones

- Quedan del perfil `test` la red `biblib-test-network` y los volúmenes `supabase_db_biblib-test` y `supabase_storage_biblib-test`, conservados como prevé el wrapper.
- **HolaERP** aparece detenido: todos sus servicios salieron a la vez a las 21:29:09 UTC, como con un `supabase stop`. Hacia las 21:42 UTC se arrancó el perfil `main` (`biblib-local`). Este run no actúa sobre recursos ajenos: la única parada de contenedores es la de `auth/caida-servicios`, que detiene el Kong de `biblib-test` por ID tras verificar la propiedad. No se ha tocado nada de HolaERP. Conviene que el coordinador confirme quién lo paró.
- Posible mejora de producto (fuera de scope): en una fusión, no crear series ni ubicaciones ajenas que no reciban ningún elemento nuevo. Así no aparecerían duplicados vacíos al repetir la importación del archivo de otra cuenta.

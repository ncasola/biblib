# U-DAT-05 · Cuota, caché y deduplicación del proveedor entre instancias (O08)

**Fecha:** 23-10-2026 · **Rama:** `u-dat-05` (worktree `u-inf-03`) · **Perfil:** `scratch` (Postgres 17.6) · **Agente:** Claude (Opus).

## Qué se entrega

| Pieza | Archivos |
| --- | --- |
| Tablas y funciones internas | `lib/db/schema.ts`, `drizzle/0004_catalogue_coordination.sql` (+ journal y snapshot) |
| Manifest de objetos | `scripts/db/objects-manifest.mjs`, `tests/fixtures/migrations/objects-0004.json` |
| Gateway | `lib/bibliographic-catalog/{gateway,cache,quota}.ts` |
| Cableado | `orchestrator.ts` (opción `gateway` y clave por operación), `server.ts` (gateway en modo live), `registry.ts` (reenvía `gateway`, una opción) |
| Pruebas | `tests/catalogue-gateway.test.ts`, `tests/db/catalogue.sql`, `tests/integration/catalogue/**`, `tests/scripts/catalogue-runner.test.mjs`, `tests/scripts/migrations.test.mjs` |
| Operación | sección «Cuota, caché y consultas en vuelo del catálogo · U-DAT-05» en `docs/operacion.md`; script `test:integration:catalogue` |

## Aceptación de 02 → U-DAT-05

| Criterio | Evidencia |
| --- | --- |
| Dos procesos Node distintos, mismo ISBN y proveedor: una consulta en vuelo, resultado equivalente, sin referencias privadas | `coordinacion.test.mjs` «dos procesos…»: 1 llamada al `fetch` simulado entre ambos, candidatos idénticos, fila compartida sin IDs de A ni B, TTL 3600 s |
| ISBN distintos desde búsqueda, importación y portada respetan el intervalo global | «ISBN distintos…»: 3 procesos (búsqueda interactiva, lote con `bind({ purpose: "batch" })`, portada) → 5 peticiones OL separadas ≥ 1 s |
| OL y BNE no consumen la misma reserva | «OL y BNE…»: BNE sale sin esperar a OL; cubos `bne` 2000 ms y `open-library` 1000 ms |
| Google deshabilitado/ausente no recibe peticiones ni crea caché | Unitaria «Google deshabilitado…»: `fetch` rechaza el host, 0 peticiones, 0 llamadas al store, 0 filas |
| 429 con `Retry-After` | «429…»: cooldown compartido de 3 s; otro proceso responde `rateLimited` sin red; nada se cachea; tras el cooldown, `found` |
| Worker muerto tras reservar | «worker muerto…»: proceso terminado con 137 tras concesión y reserva; el heredero espera la caducidad y consulta una vez; la plaza consumida mantiene el intervalo |
| Carrera de caducidad (fencing) | «carrera de caducidad…»: el tardío (concesión de 500 ms, respuesta a 1,8 s) no sobrescribe la entrada reciente; `test:db` comprueba `stale` del testigo antiguo |
| Caché malformada | «caché malformada…»: se descarta, se consulta una vez y se reescribe con testigo mayor |
| Cambio de schema/licencia | «cambio de política o de schema…»: entradas de otra versión no se reutilizan y se retiran; política que deniega no escribe y retira las existentes |
| Caída de Postgres sin ráfaga externa | «Postgres no disponible…»: `unavailable`, 0 peticiones (proceso con URL a un puerto cerrado); unitaria equivalente |
| Política que deniega persistencia impide escribir | Unitarias «una política que deniega…» y «política: …» (`persistMetadata` también se exige) |
| A no inspecciona ni manipula cuota/caché privada de B (SQL `authenticated` y Data API) | `aislamiento.test.mjs`: 42501 en tablas, secuencia y las 7 funciones para `authenticated` y `anon`; RLS de la caché privada (A ve y purga solo lo suyo, no inserta ni actualiza, borrar lo de B afecta 0 filas); PostgREST 406/PGRST106 y RPC rechazado con el JWT real de A |
| Mock con claves ficticias, red real prohibida | ISBN sintéticos `979-0-0009…`; `fetch` simulado; el `fetch` coordinado rechaza todo host sin política |
| Cuota agotada → espera durable o error recuperable | Espera de lote fuera de la base; si excede su plazo, `rateLimited` + `retryAfterSeconds` (nunca `notFound`) |

## Ejecuciones (salidas en esta carpeta)

| Paso | Resultado |
| --- | --- |
| `db:status:local --profile scratch` antes | `pending` (head 0003) · [01](01-status-antes-0003.txt) |
| `db:plan:local` / `db:migrate:local` 0003→0004 | Aplicada; la verificación inicial falló (11) solo por el orden de `conkey` de tres CHECK en el manifest, corregido sin tocar la base · [02](02-plan-0003-0004.txt), [03](03-migrate-0003-0004.txt) |
| `db:status:local` tras 0004 | `up-to-date`, 142 comprobaciones, sin drift · [04](04-status-tras-0004.txt) |
| Grupo catalogue en scratch (0003→0004) | 14/14 · [05](05-integracion-catalogue-scratch.txt) |
| `db:reset:local` plan + `--discard-local-data` | Reset y bootstrap desde vacío (0000→0004), seed y verify reales · [06](06-reset-dry-run.txt), [07](07-reset-apply-desde-vacio.txt) |
| `db:status:local` tras reset | `up-to-date`, 142 comprobaciones, sin drift · [08](08-status-tras-reset.txt) |
| `pnpm test:integration:catalogue --profile scratch` tras reset | 14/14 · [09](09-integracion-catalogue-tras-reset.txt) |
| `pnpm lint` · `pnpm typecheck` | 0 · 0 · [10](10-lint.txt), [11](11-typecheck.txt) |
| `pnpm test` | 144/144 · [12](12-test.txt) |
| `pnpm test:scripts` | 155/155 (incluye pruebas `[stack]` sobre scratch y el fallo simulado movido a 0005) · [13](13-test-scripts.txt) |
| `pnpm test:db` | 0000→0004 + `catalogue.sql` correctos · [14](14-test-db.txt) |
| `db:local:down --profile scratch` | Parado, volúmenes conservados · [15](15-local-down.txt) |

El perfil `test` pertenece a U-QA-02 en esta ola y no se ha usado: el grupo `catalogue` está registrado en `pnpm test:integration:local` y admite `--profile test`, pero no se ha ejecutado allí.

## Hallazgos

- **jsonb en postgres.js.** Un `JSON.stringify(...)` con `::jsonb` se guardaba como escalar JSON y la restricción `jsonb_typeof = 'array'` rechazaba la publicación. Las unitarias (store en memoria) no lo veían; la integración real sí. Corregido con `sql.json` (commit `fix(bibliografia)`).
- **Caché local del adaptador OL.** `lib/open-library.ts` mantiene su propia caché e intervalo en memoria. Con el gateway no duplica el límite (la cuota se reserva en el `fetch` real), pero es redundante; su retirada corresponde a U-BIB-02/U-BIB-05.
- **Caminos sin gateway.** `lib/library-import.ts` (`enrichImportedBookCovers`) hace `fetch` directo por lotes a OL con intervalo local, y `lib/api-client.ts` (sin consumidores) crea otro cliente OL. Quedan fuera del alcance de esta unidad; el gateway ofrece `bind({ owner, purpose: "batch" })` para enrutarlos (U-BIB-05 / U-DAT-03).
- **Propósito.** El orquestador marca sus llamadas como interactivas; `LookupOptions` (de `types.ts`, U-BIB) no tiene aún un campo para lote o trabajo.

## Recursos Docker que quedan

Perfil `scratch` parado: red `biblib-scratch-network` y volúmenes `supabase_db_biblib-scratch` y `supabase_storage_biblib-scratch` (conservados, como exige el wrapper). HolaERP sin cambios: mismos IDs de contenedor, `StartedAt`, reinicios, puertos, redes y volúmenes antes y después.

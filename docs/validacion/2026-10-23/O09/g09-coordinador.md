# Puerta G09

**Fecha:** 23 de octubre de 2026 · **Commit:** `7e9a1dd` en `feature/spec-pendientes` · **Coordinador:** Run de Orca `run_0513502ec5ee`.

| Comprobación | Resultado |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | correctos |
| `pnpm test` | 293/293 |
| `BIBLIB_SKIP_STACK_TESTS=1 pnpm test:scripts` | 209 superadas, 4 omitidas con motivo |
| `pnpm test:db` | correcto (`0000→0005`) |
| `pnpm build` y `check:bundle --forbid-local-login` | correctos; todas las rutas dinámicas (U-OPS-04) |
| `pnpm test:smoke` | correcto |
| `db:local:bootstrap --profile test` | `passed`, head `0005_library_jobs` (6/6) |
| `pnpm test:integration:local` (incluye `jobs`) | 78/78 |
| `pnpm test:integration:security --profile test` | 19/19 |
| `pnpm test:integration:jobs --profile scratch` | 19/19 |
| `pnpm test:e2e:local` (Chromium) | 39 superados, 0 fallos conocidos, 19 `fixme` de unidades futuras, 0 repeticiones |

## G09

- **Trabajos:** dos workers no publican un elemento dos veces, un lease antiguo no escribe y recargar recupera el resultado (grupo `jobs`).
- **Procedencia por campo:** conserva los valores manuales y el `isbnVerified` humano (U-BIB-04, flag apagado por defecto).
- **Benchmark 100/1000/10000:** cifras y perfil en `docs/validacion/rendimiento/2026-10-23/`, con 8 tareas derivadas (T1–T8).
- **Google:** apagado no hace ninguna llamada ni expone la clave (U-BIB-03 y U-FIX-01).
- **CI de PR sin secretos remotos:** preparado y validado localmente. Su **ejecución real en GitHub queda pendiente** del push y la PR, a decisión de Néstor (U-QA-04).
- **Release con artefacto y plan identificados:** workflow de promoción preparado y desactivado (U-QA-04 y U-INF-07).
- **Sesión, cabeceras y exposición:** verificadas en local. HTTPS real y alojamiento quedan **pendientes** (U-OPS-04).

## Correcciones de integración del coordinador

- Egress test (U-BIB-05): admite el host de imágenes de la CSP y las respuestas simuladas del benchmark.
- `fixture-egress` (U-FIX-01): adaptado a la recuperación de portadas por trabajos (U-DAT-03).
- Fixture de catálogo: combinadas la búsqueda por título y autor (U-DAT-08) y el BNE ficticio (U-BIB-05).
- E2E: los 404 reales de fichas inexistentes o ajenas (U-FIX-01) se toleran solo en los recorridos que los esperan.
- Integración de `jobs`: la invalidación por cuenta bloqueada cuenta todos los trabajos activos de A.

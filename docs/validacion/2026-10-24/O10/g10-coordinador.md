# Puerta G10 · salida de F1

**Fecha:** 24 de octubre de 2026 · **Commit:** `99615e6` en `feature/spec-pendientes` · **Coordinador:** Run de Orca `run_0513502ec5ee`.

## Validación del código integrado

| Comprobación | Resultado |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | correctos |
| `pnpm test` | 322/322 |
| `BIBLIB_SKIP_STACK_TESTS=1 pnpm test:scripts` | 223 superadas, 4 omitidas con motivo |
| `pnpm test:db` | correcto (`0000→0007`) |
| `pnpm build` y `check:bundle --forbid-local-login` | correctos |
| `pnpm test:smoke` | correcto |
| `db:reset:local --apply --discard-local-data --profile scratch` | `0000→0007` desde vacío, verify A/B, Storage y Mailpit en `passed` |
| `test:integration:{views,snapshots,jobs} --profile scratch` | 5/5, 10/10 y 19/19 |
| `db:local:bootstrap --profile test` | `passed`, head `0007_saved_views` (8/8) |
| `pnpm test:integration:local` (perfil `test`) | 93/93 |
| `pnpm test:integration:security --profile test` | 23/23 |
| `pnpm test:e2e:local` (Chromium) | 40 superados, 0 fallos conocidos, 19 `fixme` de unidades futuras, 0 repeticiones |
| HolaERP | sus 11 contenedores, idénticos antes y después |

## G10

- **Reemplazo y snapshot:** un reemplazo genera un snapshot coherente o no ocurre. Restaurar un snapshot antiguo exige revisión nueva (grupo `snapshots`, U-DAT-02).
- **Trabajos:** cerrar y reabrir recupera los trabajos (grupo `jobs`, U-DAT-03).
- **Un solo orquestador:** alta, importación, portadas y búsqueda pasan por él, con presupuesto global y una prueba estática de salidas (U-BIB-05 y U-DAT-05).
- **Búsqueda por título y autor:** muestra candidatos de edición y no marca el ISBN físico por similitud (U-DAT-08).
- **Vistas privadas:** restauran los filtros y descartan la selección temporal (U-EXP-02).

## Incidencias de la puerta

- Docker Desktop se degradó durante la validación de U-EXP-02: contenedores en estado «unhealthy» y `docker` sin responder. Néstor lo reinició el 24-10 y la validación se repitió completa.
- Ajustes del coordinador durante la integración:
  - `tests/integration/views` comprueba que un filtro nulo lo rechaza `NOT NULL` (23502).
  - `tests/integration/security` permite las tres funciones `SECURITY DEFINER` de `0006`, tras revisarlas: `search_path` fijo, dueño tomado de `auth.uid()`, sin `PUBLIC` ni `anon`.
- El terminal del worker de U-EXP-02 quedó en `release_unknown` tras el reinicio. No afecta al código.

## Pendiente fuera de F1 (decisión de Néstor)

Push y PR para ejecutar el CI real; bindings de Docker en loopback (A/B); `.env` del checkout principal; destino y autorización para preprod y prod (U-INF-07); HTTPS, CDN y Google OAuth reales (U-OPS-04).

# Puerta G14 · Coordinador (O14 completa y rediseño)

**Fecha:** 26 de octubre de 2026 · **Commit:** `1e951dc` en `feature/spec-pendientes` (head `0015_reading_and_loans`) · **Run de Orca:** `run_a30695704f5a`.

O14 integra:
- El lote de schema único **O14-D** (`0015` más [contratos-o14](../../../spec-pendientes/contratos-o14.md)).
- Las unidades **U-PRO-02** (lectura) y **U-PRO-04** (préstamos).
- El rediseño ([07](../../../spec-pendientes/07-rediseno.md)), aprobado por el usuario en paralelo con O14: **U-UX-01**, sistema visual «Biblioteca nocturna», y **U-UX-02**, estantería 3D CSS realista.

Validación en el perfil `test` (worktree `stack-test`, rama `g14`, avance rápido a `1e951dc`). El árbol de `1e951dc` es idéntico al de `9e4acf4` (`u-pro-04-stack`, mismo hash de árbol `127a173`). En ese commit, durante su turno de stack, U-PRO-04 ejecutó el E2E completo y la accesibilidad sobre este mismo código.

| Comprobación | Resultado |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | correctos |
| `pnpm test` | 494/494 |
| `pnpm test:scripts` | 272 superadas, 2 omitidas porque requieren `scratch` |
| `pnpm test:db`, `pnpm build`, `pnpm check:bundle --forbid-local-login` y `pnpm test:smoke` | correctos |
| `pnpm test:integration:local` (incluye `reading-loans` y `loans`) | 289/289 en **dos** pasadas seguidas, sin datos residuales |
| `pnpm test:integration:reading --profile test` | 28/28 |
| `pnpm test:integration:media --profile test` | 5/5 |
| `pnpm test:integration:security --profile test` | 24/24 |
| `pnpm test:e2e:local` (Chromium, árbol idéntico) | 74 superados, 0 fallidos, 18 pendientes de unidades futuras o captura optativa ([registro](pro-04/e2e-completo.log)) |
| `pnpm test:a11y:local` (árbol idéntico) | 10/10 ([registro](pro-04/a11y-completo.log)) |
| E2E de lectura (`--grep "lectura:"`, coordinador, antes de U-PRO-04) | 4/4 |

La evidencia de cada unidad está en `docs/validacion/2026-10-26/O14/{d,pro-02,pro-04}/` y `docs/validacion/2026-10-26/UX/{ux-01,ux-02}/`.

## Criterios de G14

- **Relectura (U-PRO-02):** crea un ciclo nuevo y conserva intacto el anterior (integración `reading` y E2E).
- **Sin fechas legado:** un libro marcado `read` sin lecturas registradas no recibe fecha. Las sesiones y el progreso no inventan fechas.
- **Total de páginas desconocido:** sin total no hay barra ni porcentaje (`readingProgress`, E2E).
- **Préstamos (U-PRO-04):**
  - Hay un préstamo activo por ejemplar, con duplicado concurrente rechazado.
  - El préstamo sucesivo conserva el historial.
  - La devolución lleva versión.
- **Fechas civiles:** se comprueban con husos extremos (Kiritimati, Los Ángeles, Madrid y UTC). Los vencidos se calculan con `civilDateInZone`.
- **Recordatorios:** nunca se anuncian como enviados (`LOAN_REMINDERS_SENT = false`).
- **Préstamo y lectura:** prestar no cambia el estado de lectura.
- **Datos nuevos:** entran en v2, respaldo y restauración, y eliminación de cuenta (O14-D, grupo `reading-loans`).
- **Rediseño:**
  - **Contraste AA:** comprobado en ambos temas, con un mínimo de 5,16:1 en claro y 5,23:1 en oscuro.
  - **axe:** 0 violaciones en la vista 3D, también con un libro sacado.
  - **Desbordamiento:** sin scroll horizontal a 320, 375, 768 y 1440 px.
  - **Movimiento:** se respeta `prefers-reduced-motion`.

## Incidencias resueltas

- **Build en el checkout principal:** el `.env.local` generado para `main` incluía `BIBLIB_CATALOGUE_MODE=fixture`, que un `pnpm build` sin objetivo rechaza. El generador ya no escribe el modo deducido (`7c804e4`).
- **Codex sin cuota:** U-PRO-04 se quedó sin cuota antes de escribir código y se reanudó al restablecerse.
- **Panel móvil de U-UX-02:** tapaba el libro sacado. Se cambió a un panel compacto. Los E2E pulsan la cara visible del lomo.
- **Ficha a 768 px con préstamo activo:** desbordaba en horizontal. Se corrigió con `sm:flex-wrap` en un commit aislado (`b5a1eba`).

## Decisiones anotadas

- **Cifras del inicio:** el titular y las tarjetas «Leyendo»/«Leídos» del inicio cuentan el estado actual del libro, no las lecturas registradas. «Seguir leyendo» usa ciclos abiertos. Pueden no coincidir, por ejemplo «0 Leyendo» con dos libros en «Seguir leyendo». Unificarlas es una decisión de diseño pendiente del usuario.
- **Evidencia de O11:** `tests/accessibility/audit.spec.ts` reescribe los JSON de evidencia de O11 en cada ejecución. Se revierten a mano. Hacer configurable la carpeta de salida queda como mejora.
- **Navegadores:** Firefox y WebKit no se ejecutaron en esta ola. Solo Chromium.

# Puerta G16 · Coordinador (O16 completa, cierre de F4)

**Fecha:** 26 de octubre de 2026
**Commit validado:** `5a5adfe` (O16-FIX integrada). Las correcciones de las pruebas E2E se integraron después en `78326f8` (O16-XB).
**Migraciones:** head `0015_reading_and_loans`; O16 no añade ninguna.
**Run de Orca:** `run_a30695704f5a`.

O16 consta de:
- **U-QA-05:** matriz de 35 hallazgos, instalación limpia, migración desde la versión previa, respaldo y restauración, benchmark y entrega.
- **O16-FIX:** CLS de Inicio, `agentRules`, E2E de paginación, timeout del proxy, `fixme`, enlaces y `seguridad.md`.
- **O16-XB:** E2E en Firefox y WebKit.

**Dónde se validó:** en el perfil `test`, worktree `stack-test`, sobre la rama `g16`, que coincide con `5a5adfe`. Registros en `.biblib/g16/` (worktree).

| Comprobación (`5a5adfe`) | Resultado |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | correctos |
| `pnpm test` | 525/525 |
| `pnpm test:scripts` | 277 superadas, 2 omitidas (requieren `scratch`) |
| `pnpm test:db`, `build`, `check:bundle --forbid-local-login`, `test:smoke`, `docs:links` | correctos |
| `pnpm test:integration:local --profile test` | 291/291 en **dos** pasadas seguidas |
| `test:integration:media` / `security` / `reading` | 5/5 · 24/24 · 28/28 |
| `pnpm security:headers:local --profile test --reuse-build` | 55/55 según la matriz |
| `pnpm test:e2e:local` Chromium | todos los recorridos superados |
| `pnpm test:e2e:local` Firefox + WebKit | **48 fallidos** (6 + 42), 194 superados, 11 omitidos, 14 sin ejecutar |
| `pnpm test:a11y:local` | 10/10 |

## Firefox y WebKit (O16-XB)

Los 48 fallos se analizan en el [informe de O16-XB](xb/informe.md). **Ninguno era un defecto del producto.** Las causas:
- **WebKit perdía la sesión de A.** El service worker impedía que `route()` simulara el logout global, de modo que la prueba revocaba la sesión compartida. Corrección: WebKit bloquea los service workers salvo en las pruebas offline.
- **Restos de préstamos en la cuenta A.** Obligaban a exportar en v2. Corrección: limpieza y precondición explícita.
- **Diferencias de motor de Playwright en Windows.** Están documentadas y tienen omisiones acotadas:
  - Firefox no deja que el worker atienda navegaciones con `setOffline`.
  - El WebKit de Windows no comprueba la integridad de AES-KW.
  - WebKit no tiene pila multimedia.
  - En WebKit, Tab no enfoca enlaces.

Validación de O16-XB:
- **Cada navegador por separado** quedó en verde: Chromium 85/85, Firefox 82/82 y WebKit 79 más las 9 pruebas tocadas.
- **Dos runs completos** con los tres navegadores sacaron intermitencias de carga (5 y 2), que se corrigieron.
- **El tercer run completo** lo interrumpió el usuario por falta de memoria en el equipo. **El usuario dio por buenos los runs realizados.**
- **Al integrar `o16-xb`**, el coordinador ejecutó lint, typecheck, `test` (525/525) y la prueba del runner E2E (8/8).

## Criterios de G16

- **Matriz de los 35 hallazgos:** 34 `implementado-local` y 1 `pendiente`: UI-03, la prueba manual con lector de pantalla ([matriz](matriz-auditoria.md)).
- **Entrega:** separa el cierre de código (alcanzado) del de despliegue (pendiente, responsable: usuario) ([entrega](entrega.md)).
- **Cierre de código:**
  - integración y seguridad en verde;
  - cabeceras al 100 %;
  - E2E en los tres motores, con las omisiones inventariadas;
  - accesibilidad automática en verde.
- **Higiene de evidencia:** el E2E ya no reescribe evidencia ya commiteada (`6d3f857`).

## Incidencias

- **El E2E reescribía evidencia de O11, O14 y O15.** El coordinador la restauró antes de crear `o16-xb`. Corregido en O16-XB.
- **Memoria del equipo:** con los tres navegadores, el run completo agota la memoria disponible. El usuario lo paró de forma manual.
  - El coordinador terminó los procesos de Next, Playwright y Firefox que quedaron del worktree `u-qa-01`.
  - **Recomendación:** ejecutar Firefox y WebKit por separado (`--project firefox`, `--project webkit`) o en CI nocturno.

## Decisiones anotadas

- **G16 aceptada por decisión del usuario** sin el tercer run completo de los tres navegadores.
- **Intermitencia abierta:** `offline:318` en Chromium (activación del worker publicado, 1 de 7 ejecuciones). Tiene diagnóstico añadido y se deja como pendiente.
- **Sin probar:** Safari real (AES-KW), lector de pantalla y dispositivos reales. Son pendientes externos del usuario.
- **Pendientes de U-QA-05 y G15 que siguen vigentes:**
  - las cifras del inicio «Leyendo» y «Seguir leyendo»;
  - los parámetros de la copia offline antes de activar `BIBLIB_OFFLINE_SNAPSHOT`;
  - la reproducción de la contención de `test:scripts` en `scratch`.

# Puerta G15 · Coordinador (O15 completa, cierre de F3)

**Fecha:** 26 de octubre de 2026 · **Commit:** `07f7dcf` en `feature/spec-pendientes` (head `0015_reading_and_loans`, O15 no añade migraciones) · **Run de Orca:** `run_a30695704f5a`.

O15 integra dos unidades:
- **U-EXP-07**, catálogo imprimible.
- **U-EXP-08**, PWA y copia de lectura offline opt-in. Su contrato es [contratos-o15](../../../spec-pendientes/contratos-o15.md).

**Dónde se validó:** en el perfil `test` (worktree `stack-test`, rama `g15`, avance rápido a `07f7dcf`). El árbol de `07f7dcf` es idéntico al de `51a2cdf` (`u-exp-07-stack`, árbol `535cfa8`). En ese commit, U-EXP-07 ejecutó durante su turno de stack el E2E completo y la accesibilidad sobre este mismo código.

| Comprobación | Resultado |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | correctos |
| `pnpm test` | 521/521 |
| `pnpm test:scripts` | 273 superadas, 2 omitidas porque requieren `scratch` |
| `pnpm test:db`, `pnpm build`, `pnpm check:bundle --forbid-local-login` y `pnpm test:smoke` | correctos |
| `pnpm test:integration:local` | 289/289 en **dos** pasadas seguidas, sin datos residuales |
| `pnpm test:integration:reading` / `media` / `security` (`--profile test`) | 28/28 · 5/5 · 24/24 |
| `pnpm security:headers:local --profile test --reuse-build` (coordinador) | 55/55 respuestas según la matriz, incluidas `/books/print`, `/offline` y `/sw.js` |
| `pnpm test:e2e:local` (Chromium, árbol idéntico) | 85 superados, 0 fallidos, 17 omisiones heredadas ([registro](exp-07/e2e-completo.log)) |
| `pnpm test:a11y:local` (árbol idéntico) | 10/10 ([registro](exp-07/accesibilidad.log)) |
| E2E de impresión | 6/6 ([registro](exp-07/impresion.log)) |
| E2E offline en el turno de U-EXP-08 | 7/7, dentro del E2E completo de 81 ([registro](exp-08/e2e-chromium-completo.log)) |

La evidencia de cada unidad está en `docs/validacion/2026-10-26/O15/{exp-07,exp-08}/`.

## Criterios de G15

### Impresión (U-EXP-07)
- **Contenido:** la vista `/books/print` imprime exactamente los resultados filtrados, con el recuento correcto. Las pruebas comparan los IDs impresos con la consulta.
- **Consulta acotada:** se hace por páginas y con un máximo imprimible.
- **Papel:**
  - Funciona en A4 y Carta ([PDF A4](exp-07/catalogo-A4.pdf), [PDF Carta](exp-07/catalogo-Letter.pdf)).
  - No imprime controles ni navegación.
  - El estado sale como texto y no depende del color.
  - Las filas no se parten.
- **Cancelar el diálogo** no cambia los filtros.

### Copia offline (U-EXP-08)
- **Activación:**
  - La copia es opt-in, detrás de `BIBLIB_OFFLINE_SNAPSHOT` (apagada por defecto). Sin consentimiento solo hay shell estático.
  - Es de solo lectura, sin escrituras encoladas ni sincronización.
- **Por cuenta:**
  - IndexedDB con nombre derivado de un hash de la cuenta.
  - AES-GCM con AAD de la cuenta.
  - Los datos de la cuenta A no aparecen en la sesión de B (E2E).
- **Desbloqueo y expiración:**
  - PIN o frase con PBKDF2-SHA-256 a 600 000 iteraciones, que envuelve con AES-KW la clave AES-GCM.
  - Tras 10 intentos fallidos la copia se borra. El contador se guarda antes de cada intento.
  - TTL de 7 días con bloqueo.
  - La antigüedad y la cuenta enmascarada son visibles.
- **Purga:** el cierre de sesión con conexión borra la clave y los datos de la cuenta.
- **Contenido excluido:**
  - alias y fechas de préstamo (solo «Prestado»);
  - anotaciones;
  - historial de lectura;
  - imágenes.
- **Service worker:**
  - Solo cachea `/_next/static`, iconos, manifiesto y la página `/offline`, pedida sin cookies.
  - Las respuestas de navegación autenticadas, RSC, Server Actions, `/api` y `/auth` nunca entran en caché.
  - Cada versión borra las cachés anteriores.
  - Hay un modo de limpieza para recuperación.
- **Textos:** no se promete revocar la copia en un dispositivo desconectado ni proteger frente a XSS.

## Incidencias resueltas

- **Cuotas:**
  - OpenCode se quedó sin cuota en U-EXP-07 antes de escribir código. La unidad pasó a Codex, según la regla del usuario.
  - Codex tuvo errores de capacidad pasajeros, y se reanudó.
- **Bandera de la copia offline:** `scripts/next-target.mjs` no pasaba `BIBLIB_OFFLINE_SNAPSHOT` al proceso de Next. Se corrigió con prueba en `e1f2164`.

## Decisiones anotadas

- **Parámetros de la copia offline:** PIN de 6 dígitos o frase de 8 caracteres, PBKDF2 a 600 000 iteraciones, TTL de 7 días, 10 intentos y sin recuperación del PIN. Los fijó el coordinador. El usuario puede revisarlos antes de activar la bandera.
- **Sin probar:** Firefox, WebKit, el diálogo nativo de impresión, dispositivos reales y la purga por `SIGNED_OUT` con una sesión revocada en remoto. Quedan para U-QA-05 y la verificación manual.

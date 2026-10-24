# Puerta G11

**Fecha:** 24 de octubre de 2026 · **Commit:** `dafbfc2` en `feature/spec-pendientes` (head `0009_cover_assets`) · **Coordinador:** Run de Orca `run_a30695704f5a`.

| Comprobación | Resultado |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | correctos |
| `pnpm test` | 348/348 |
| `pnpm test:scripts` (completo, incluida la suite `[stack]` de promoción) | 246 superadas, 4 omitidas con motivo (build con `.env` privado y `scratch` parado) |
| `pnpm test:db` | correcto (`0000→0009`) |
| `pnpm build`, `check:bundle --forbid-local-login` y `sharp 0.35.5` | correctos |
| `pnpm test:smoke` | correcto |
| `db:local:bootstrap --profile test` | `passed`, head `0009_cover_assets` (10/10) |
| `pnpm test:integration:local` (perfil `test`) | 114/114 |
| `pnpm test:integration:security --profile test` | 23/23 |
| `pnpm test:e2e:local` (Chromium) | 40 superados, 0 fallos conocidos, 19 `fixme` de unidades futuras, 0 repeticiones |

## G11

- **Restauración multipart (U-DAT-04):** un conjunto de 2001 registros se publica entero o no se publica; si faltan o se alteran partes, no cambia nada activo. Snapshots, IDs y estantería predeterminada quedan coherentes. Con 10 000 libros se publica en 1,3–2,0 s o se rechaza sin commits parciales (grupo `restore`, 11/11).
- **Assets (U-DAT-10):**
  - Bloquean SSRF (redirecciones, localhost, redes privadas, DNS rebinding), XML/SVG, archivos políglotas, bombas de descompresión y tamaños falseados.
  - Los bytes se decodifican con `sharp` y se reencodifican antes de adjuntarlos.
  - B no lee ni firma los assets de A.
  - El ensayo backup → reset → restore → verify con una portada privada real se supera.
- **Accesibilidad (U-EXP-03):**
  - axe 30/30 en Chromium, Firefox y WebKit, con teclado, contraste medido, anchos de 320, 375, 768 y 1440 px, zoom del 200 % y del 400 % y ambos temas.
  - INP móvil de Estanterías: de 496 a 136 ms.

## Pendientes visibles

- **Accesibilidad:** ensayos manuales con lector de pantalla de escritorio, VoiceOver, Safari/iOS y Edge (`tests/accessibility/manual.md`). No se certifica WCAG.
- **Copias de portadas de proveedores:** «Guardar copia privada» queda oculto porque ningún proveedor concede `rehostCover`. Activarlo exige revisar la licencia de cada proveedor.
- **Correcciones de integración durante la ola:**
  - Rol `anon` idempotente en el harness de promoción.
  - CHECK de vistas reescrito como conjunción plana en `0008`.
  - `getLibraryDataAction` retirada y pruebas adaptadas a acciones acotadas.

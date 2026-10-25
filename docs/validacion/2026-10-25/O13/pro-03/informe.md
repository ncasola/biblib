# Informe O13 · paso 2 · U-PRO-03 · Ubicación física y fotografías privadas

**Fecha:** 25-10-2026 · **Rama:** `u-pro-03` (worktree `stack-test`) · **Perfil:** `test` (head `0014`) · **Contrato:** [contratos-o13 → U-PRO-03](../../../../spec-pendientes/contratos-o13.md) · **Operación:** [docs/operacion.md → U-PRO-03](../../../../operacion.md#ubicación-física-y-fotos-de-referencia--u-pro-03-o13).

## Qué se entrega

- **`/locations`** (`app/locations/`, `components/location-manager.tsx`, `components/location-photo.tsx`): árbol mueble → balda (habitación, estantería, armario, caja, balda u otra), crear dentro de otra, renombrar/cambiar tipo y mover con versión, borrar (vacía directamente; ocupada solo con la elección explícita «Pasar contenido y borrar»), contenido filtrable por título/autor y estado, con o sin las ubicaciones interiores, y foto de referencia con vista previa. Enlace «Ubicaciones» en la navegación; ruta protegida.
- **Acciones** `app/actions/locations.ts` (todas `ActionResult`): BL001 → «no puede quedar dentro de sí misma…», BL002 → «como máximo 8 niveles, contando las que contiene…», BP001 → `LIMIT_EXCEEDED`, 23503 → `NOT_FOUND`, BD001 → `ACCOUNT_INACTIVE`. Ninguna toca `copies.shelf_id`, el estado ni la versión de la ficha.
- **Ficha** (`components/copy-location-section.tsx`, sección propia; `BookForm` intacto, una línea en `book-details-screen.tsx`): asignar o mover con la versión de `copy_locations`, `shelf_label`, posición manual (compartirla se avisa, nunca se renumera), ruta legible y quitarla. Sin ubicaciones la ficha funciona igual.
- **Fotos** (`kind = location`): `lib/media/server.ts` (**creado mínimo por U-PRO-03**, ver «Pendientes») y `lib/media/images.ts`; reencodificación a WebP ≤ 2048 px con `sharp`, sin EXIF/GPS/XMP/ICC; la anterior solo se suelta tras registrar y citar la nueva; la sustituida se descarta salvo que la cite una versión anterior; lectura autenticada `GET /api/locations/<id>/photo` (sha256 verificado, `private, no-store`, CSP `sandbox`). Nunca URL pública ni proveedor externo.
- **Pruebas:** `tests/locations.test.ts` (14), grupo de integración `tests/integration/locations` (24, registrado en `SUITES` y `pnpm test:integration:locations`), `tests/scripts/locations-runner.test.mjs` (2), E2E `tests/e2e/flujos/ubicaciones.spec.ts` (2). La matriz `scripts/security/headers-matrix.mjs` incluye `/locations` y la ruta de la foto.

## Aceptación de U-PRO-03 (03) y puerta G13

| Criterio | Evidencia |
| --- | --- |
| La estantería lógica sigue funcionando sin ubicación física | `ejemplar` «sin ubicación física la ficha… responden igual»; E2E `organizacion` completo en verde. |
| Cambiar una ubicación no altera colección ni estado | `ejemplar` y `arbol` comparan `copies.shelf_id`, `status`, `version` y la versión plana antes/después; E2E comprueba `shelf_id`/`status`. |
| Una ubicación vacía se conserva | `arbol` «una ubicación vacía se conserva»; exportación v2 lleva la caja vacía. |
| La foto no es pública ni viaja a Open Library | `fotos`: URL pública ≠ 200, 401 sin sesión; `aislamiento`: B recibe 404 y no descarga ni firma el objeto de A; la foto no sale del servidor salvo por su ruta autenticada (E2E: guard de red sin salidas externas). |
| JSON antiguo importa con ubicación vacía | `ida-vuelta` «un JSON antiguo (v1)…». |
| Pruebas locales de 03 | Árbol padre/hijo, ciclos (BL001), niveles (BL002, también moviendo un subárbol), borrar ocupada, asignar/mover, usuario cruzado, foto inválida (SVG, texto, tipo distinto, truncada, > 5 MiB), **EXIF eliminado comprobado en los bytes guardados** (sin marcador, sin bloque `Exif`, sin `GPS`), sustitución, export → import v2 conserva ubicación y foto, cuenta en eliminación. |
| Todos los datos nuevos en export/restore y eliminación | Cubierto por 0014 (lote D) y comprobado de nuevo: `ida-vuelta` (v2 y reemplazo), grupo `product` (versión anterior, eliminación). U-PRO-03 no añade datos fuera del contrato. |

## Resultados (ejecutados en esta sesión)

| Comando | Resultado | Log |
| --- | --- | --- |
| `pnpm lint` | Correcto | `lint.log` |
| `pnpm typecheck` | Correcto | `typecheck.log` |
| `pnpm test` | 401/401 | `test.log` |
| `pnpm test:scripts` | 262 correctas, 2 omitidas, 0 fallos (repetición) | `test-scripts.log` |
| `pnpm test:scripts` (primer intento) | 1 fallo **intermitente ajeno**: `promotion-stack` «identidad errónea…» (TLS/respaldo simulados). Aislado pasó 8/8 y la repetición completa, 0 fallos | `test-scripts-intento1.log` |
| `pnpm test:db` | Correcto | `test-db.log` |
| `pnpm build` | Correcto (rutas `/locations` y `/api/locations/[locationId]/photo`) | `build.log` |
| `pnpm test:smoke` | Correcto | `test-smoke.log` |
| `pnpm test:integration:locations --profile test` | 24/24 | `grupo-locations.log` |
| `pnpm test:integration:product --profile test --reuse-build` | 17/17 | `grupo-product.log` |
| `pnpm test:integration:security --profile test --reuse-build` | 23/23 | `grupo-security.log` |
| `pnpm test:e2e:local --grep "ubicaciones:"` | 2/2 (+ sesiones A/B) | `e2e-ubicaciones-chromium.log` |
| `pnpm test:e2e:local` (Chromium completo) | 50 correctos, 19 omitidos (`fixme` previos), 0 fallos | `e2e-chromium-completo.log` |
| `pnpm db:local:down --profile test` | Correcto | `stack-down.txt` |

Resumen de códigos de salida: `resumen-comandos.txt`. Recursos Docker que quedan: `recursos-restantes.txt` (red `biblib-test-network` y volúmenes `supabase_db_biblib-test` y `supabase_storage_biblib-test`, conservados a propósito; ningún contenedor del perfil en marcha; HolaERP no se tocó).

## Hallazgos durante la unidad

1. **El primer E2E de la foto falló a medias** (carrera al comprobar la carga de la imagen) y su limpieza no retiraba una ubicación con foto: quedó una ubicación y su imagen en la cuenta A del censo. Se retiró con el harness (`update`/`delete` como `postgres` y Storage administrativo local, solo filas y objetos de la marca `[QA-02 …]`); se comprobó que A/B quedan sin ubicaciones ni assets `location`. La prueba espera ahora la carga con `expect.poll` y limpia por la acción real (que retira foto y objeto).
2. **`media_asset_discard` no mira las versiones anteriores** (la purga sí). La acción comprueba `library_snapshot_chunks` antes de descartar una foto sustituida para no romper una restauración posterior (`ida-vuelta` lo cubre).
3. **Matriz de cabeceras:** `tests/scripts/security-exposure.test.mjs` exige cubrir toda ruta de `app/`; se añadieron `/locations` y `/api/locations/:id/photo` (anónimo → 401 JSON privado).

## Pendientes y conflictos para el coordinador

> **Actualización (conciliación con U-EXP-06):** tras integrar `feature/spec-pendientes`, la foto de ubicación usa la API canónica de `lib/media/server.ts` y se lee por `/api/media/:id`. El helper mínimo y la ruta `/api/locations/:id/photo` se retiraron, y la purga la cubre `pnpm media:purge:local`. Detalle y resultados en [concilia/informe.md](concilia/informe.md). Los dos primeros puntos de esta lista quedan resueltos.

- **`lib/media/server.ts` lo crea U-PRO-03** (U-EXP-06 aún no estaba integrado): `beginUpload`, `upload`, `register`, `discard`, `signedUrl`, más `storeImage`, `readImage`, `mediaStorage` y la reexportación de `normalizeMedia` (`lib/media/images.ts`). Conciliar con el de U-EXP-06 al integrar.
- **Script de purga de `biblib-media`** (sobre `media_asset_purge_candidates`/`_confirm`): no se crea aquí para no duplicar el de U-EXP-06 (pregunta sin respuesta en 10 min; opción conservadora). Los objetos que no se pudieran retirar con la sesión del dueño quedan como candidatos de esa purga.
- **Archivos compartidos tocados (aditivos):** `components/book-details-screen.tsx` (+2 líneas), `components/header.tsx` (enlace), `lib/auth-navigation.ts` (`/locations` protegida), `tests/integration/run.mjs` (SUITES), `package.json` (script al final), `scripts/security/headers-matrix.mjs`, `docs/operacion.md` (sección propia).
- **Fuera de scope:** el mensaje «Ubicación actualizada.» al mover de **estantería lógica** en la ficha puede confundirse con la ubicación física; convendría «Estantería actualizada.» (lo espera `tests/e2e/flujos/organizacion.spec.ts`). `/locations` no está en el recorrido de accesibilidad de U-EXP-03 (`tests/accessibility`).

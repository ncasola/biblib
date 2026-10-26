# U-QA-02 · E2E, fallos de red y compatibilidad de navegador (O07, base)

Rama `u-qa-02` (desde `feature/spec-pendientes` en `43ba28f`), worktree `u-qa-01`, perfil `test` (`biblib-test`, 55330–55339, app 3148). Fecha: 23-10-2026. Operación: [operacion.md § E2E](../../../../operacion.md#e2e--u-qa-02); detalle de grupos, pendientes, hallazgos y correspondencia del smoke: [tests/e2e/README.md](../../../../../tests/e2e/README.md).

## Qué se entrega

| Pieza | Archivos |
| --- | --- |
| Herramienta fijada | `@playwright/test` **1.64.1** exacta (`package.json`, `pnpm-lock.yaml`); `playwright.config.ts`, sin reintentos. |
| Runner | `tests/e2e/run.mjs`: acredita el perfil como `tests/integration/run.mjs`, compila/revisa bundle, arranca la app con guard de red (`tests/e2e/lib/server-network-guard.mjs`), ejecuta Playwright, limpia (`tests/e2e/lib/e2e-manifest.mjs`) y para solo lo que arrancó. Helpers comunes extraídos a `tests/integration/lib/process.mjs` (sin tocar `support/`). |
| Recorridos | `tests/e2e/sesion.setup.ts`, `tests/e2e/flujos/*.spec.ts`, `tests/e2e/cierre/acceso-sesion.spec.ts`, `tests/e2e/externo/open-library.spec.ts`; fixtures en `tests/e2e/lib/fixtures.ts`. |
| Scripts | `test:e2e:local`, `test:e2e:local:ui`, `test:e2e:external` (añadidos al final). |
| Fixtures de catálogo (autorizado por el coordinador) | `tests/fixtures/catalogue/9780000000033.json` + `lib/catalogue-fixtures.ts`; `lib/bibliographic-catalog/providers/fixture.ts` reserva `9780000000040` → `unavailable`; prueba en `tests/bibliographic-catalog-providers.test.ts`. Solo modo fixture. |
| Pruebas del runner | `tests/scripts/e2e-runner.test.mjs` (sin Docker). |
| Compartidos | `.gitignore` (anexado), `eslint.config.mjs` (ignora `.biblib/**`: el informe HTML de Playwright vive ahí), `docs/operacion.md` (sección propia). |

## Aceptación → evidencia

| Criterio | Resultado real |
| --- | --- |
| `pnpm test:e2e:local` en verde en Chromium dos veces seguidas, sin reintentos ocultos | [chromium-run-1.txt](chromium-run-1.txt) y [chromium-run-2.txt](chromium-run-2.txt) (código final, `3d7f693`): **33 superados, 1 fallo conocido (`test.fail`), 23 pendientes (`fixme`), 0 fallidos, 0 repeticiones** en cada uno (`retries: 0`; el runner lee `resultados.json` y falla ante cualquier repetición). Antes, un intento con el código anterior falló en el cierre por un `500 POST /books` intermitente: [chromium-intento-500-cierre.txt](chromium-intento-500-cierre.txt) (ver hallazgo 4); el siguiente pasó ([chromium-intento-siguiente-verde.txt](chromium-intento-siguiente-verde.txt)). |
| Firefox/WebKit ejecutados si se pudieron instalar | `pnpm exec playwright install firefox webkit` descargó Firefox 157.0 (build 1555) y WebKit 27.2 (build 2370). Ambos ejecutados con su resultado real: [firefox-webkit.txt](firefox-webkit.txt) — ver tabla de navegadores. Las dos primeras ejecuciones fallaron por cancelaciones de peticiones al navegar sin tolerancia (Firefox/WebKit) y por la correlación inicial de WebKit; se corrigió el guard, no las aserciones. |
| Sesión A/B por el formulario local nuevo (U-LOC-01) contra GoTrue | `sesion.setup.ts` (A y B) y `cierre`: entra, respeta `?redirect=` interno, sustituye `https://…`, `//…` y `/\…` por el inicio, errores genéricos idénticos para cuenta existente e inexistente, contraseña vaciada tras el error, el 6.º intento en el minuto se bloquea incluso con la contraseña correcta y se libera pasado el minuto. **No se encontró ningún fallo de U-LOC-01.** |
| El build sin objetivo no contiene el acceso local | [build-sin-objetivo.txt](build-sin-objetivo.txt): `--check-untargeted-build` (sin `BIBLIB_TARGET`, sin `.env`, con `NEXT_PUBLIC_BIBLIB_LOCAL_LOGIN=1` heredada a propósito) → 67 archivos sin el formulario; control negativo: `.next-local` (perfil test) sí lo contiene y sale con 11. |
| Sin excepciones JS ni hidratación; sin tráfico externo; capturas ficticias | Guard por prueba (`pageerror`, `console` error, `context.route`) y guard del servidor; el runner exige «guard activo» y 0 hosts. Capturas en [capturas/](capturas/) (solo censo A/B y fichas `[QA-02 …]`). |
| Migración del smoke | `scripts/smoke-app.mjs` se conserva. Correspondencia en el README del E2E; queda solo en el smoke «recuperación de portadas sin HTTP externo» (hallazgo 1). |
| lint, typecheck, `pnpm test`, `pnpm test:scripts`, `pnpm test:integration:local` | [lint.txt](lint.txt) 0 · [typecheck.txt](typecheck.txt) 0 · [test.txt](test.txt) 132/132 · [test-scripts.txt](test-scripts.txt) 152 ok, 2 omitidas (`[stack]` de `scratch`, no arrancado) · [integracion.txt](integracion.txt) 45 escenarios superados, 0 fallidos. |
| `test:e2e:external` | [externo-open-library.txt](externo-open-library.txt): 1 superado (ISBN público 9780140328721 encontrado en Open Library live). Node imprime al salir del worker `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (libuv en Windows) sin afectar al resultado. |
| Al terminar, `pnpm db:local:down --profile test` | [down.txt](down.txt), [recursos-finales.txt](recursos-finales.txt); HolaERP antes/después: [holaerp-antes.txt](holaerp-antes.txt), [holaerp-despues.txt](holaerp-despues.txt). |

## Navegadores

| Navegador | Resultado |
| --- | --- |
| Chromium (Chrome 155 del sistema, `channel: "chrome"`) | 2 runs seguidos: 33 ✓, 1 fallo conocido, 23 fixme, 0 ✗. |
| Firefox 157.0 (Playwright) | En la misma ejecución que WebKit, código final: 33 ✓, 1 fallo conocido, 23 fixme, 0 ✗; 4 cancelaciones al navegar toleradas y anotadas. |
| WebKit 27.2 (Playwright) | 33 ✓, 1 fallo conocido, 23 fixme, 0 ✗; 7 cancelaciones al navegar toleradas y anotadas. Total de [firefox-webkit.txt](firefox-webkit.txt): 66 ✓, 2 conocidos, 46 fixme, 0 ✗, 0 repeticiones. |

En Firefox/WebKit, las peticiones de la app canceladas por una navegación de la prueba producen «Error loading …: Load failed» o, en WebKit, un rechazo «due to access control checks». Se toleran solo esas firmas, sobre la propia app y en los 3 s posteriores al inicio de una navegación, y se anotan en el informe HTML como «cancelación al navegar». WebKit automatizado no equivale a Safari/iOS real.

## Hallazgos (descritos, no corregidos en esta unidad)

1. **Open Library fuera del modo fixture.** Recuperación de portadas, «Buscar portada» y enriquecimiento de importación llaman a `https://openlibrary.org/api/books` con `fetch` directo (`lib/library-import.ts`), ignorando `BIBLIB_CATALOGUE_MODE=fixture`. En el primer ensayo el guard del servidor no estaba activo (su variable llevaba prefijo `BIBLIB_` y `childEnv` la descartaba); el servidor salió a Internet y guardó portadas reales en «La isla de papel» y «El reloj de las mareas» de A. Se restauraron por SQL a `/default-book-cover.webp` en el perfil `test`, se corrigió el guard y ahora el runner exige verlo activo. El recorrido queda `fixme` hasta U-BIB-05.
2. **Id de ficha inválido.** `/book/no-es-un-uuid` titula «Libro no encontrado · BibLib» pero la acción responde 500 y la pantalla dice «No se pudo cargar el libro. Comprueba la conexión…». Marcado `test.fail` (fallo conocido) en Chromium, Firefox y WebKit.
3. **404 RSC al cerrar sesión.** `Header` hace `router.replace("/login")` + `router.refresh()`; el refresco de la página privada se redirige a `/login?redirect=…` y esa petición RSC responde 404 (la pantalla termina bien). Admitido solo en las pruebas que cierran sesión.
4. **500 intermitente al cerrar sesión con una acción en curso.** Visto una vez en Chromium (cierre, página `/books`): una acción de servidor que llega tras revocar la sesión responde 500 en lugar de un error tipado. El recorrido espera ahora a que la página quede en reposo antes de cerrar sesión, y el guard muestra una línea temporal (marcas de paso, respuestas ≥400, consola) si reaparece.

## Datos, sesiones y recursos

- Cuentas de Auth sin cambios en todos los runs (2, `@biblib.test`). Datos marcados `[QA-02 <run>]` limpiados por prueba y por run; la biblioteca de A se restaura tras el reemplazo real (instantánea en `.biblib/e2e/test-run.json`).
- Inicios de sesión GoTrue por navegador: 11 (`sign_in_sign_ups` = 30/5 min); entre Chromium ×2, Firefox+WebKit e integración se esperó a que se recuperara el cupo.
- Sesiones, contraseñas y trazas quedan en `.biblib/` (ignorado); las salidas guardadas aquí se revisaron sin JWT, cookies, claves ni contraseñas.

## Pendiente / fuera de alcance

- Grupos `fixme`: Trabajos (U-DAT-03), Copias multipart (U-DAT-04), deshacer (U-DAT-02), modelo de ejemplares (U-DAT-06), BNE/Google/cuota (U-BIB-02/03/04, U-DAT-05), objetos privados/borrado/offline (U-DAT-10, U-OPS-03, U-EXP-08), Producto (U-PRO-01…05) y recuperación de portadas (U-BIB-05).
- Ejecución programada y CI (U-QA-04); revisión visual y de lector (U-EXP-03).

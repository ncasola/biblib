# E2E de BibLib (U-QA-02)

Recorridos de navegador con Playwright contra el stack Supabase real del perfil **`test`** y la app compilada para ese perfil (`127.0.0.1:3148`, catálogo `fixture`). Las sesiones son reales: A y B entran por el formulario «Acceso local de desarrollo» de U-LOC-01 contra GoTrue. Ejecución y alcance operativo: [docs/operacion.md → E2E](../../docs/operacion.md#e2e--u-qa-02).

```powershell
pnpm db:local:bootstrap --profile test      # o up + migrate + seed del perfil test
pnpm test:e2e:local                         # Chromium (Chrome del sistema), como en PR
pnpm test:e2e:local --project firefox --project webkit   # cierre de ola
pnpm test:e2e:local:ui                      # modo UI de Playwright sobre el mismo stack
node tests/e2e/run.mjs --check-untargeted-build          # el build sin objetivo no lleva el acceso local
pnpm test:e2e:external                      # opt-in: Open Library real, fuera de CI
pnpm db:local:down --profile test
```

## Estructura

| Ruta | Qué hace |
| --- | --- |
| `run.mjs` | Runner. Acredita el perfil igual que `tests/integration/run.mjs` (reutiliza `tests/integration/lib/`), comprueba ledger y fixtures, compila y revisa el bundle, arranca la app con un guard de red en el servidor, ejecuta Playwright, limpia y para solo lo que arrancó. |
| `../../playwright.config.ts` | Proyectos por navegador: `<n>-sesion` → `<n>-flujos` → `<n>` (cierre). `--project <n>` ejecuta los tres en orden. Sin reintentos (`retries: 0`). |
| `sesion.setup.ts` | A y B entran por el formulario local; la sesión (cookies SSR reales) se guarda en `.biblib/e2e/state/` y se borra al terminar. |
| `flujos/*.spec.ts` | Grupos con cobertura real en O07 y esqueletos `test.fixme` de unidades futuras. |
| `cierre/acceso-sesion.spec.ts` | Escenarios que revocan sesiones o agotan el limitador; van al final de cada navegador. |
| `externo/open-library.spec.ts` | Comprobación opt-in con Open Library live. |
| `lib/fixtures.ts` | Contexto acreditado, credenciales (solo en el proceso de pruebas), vigilancia de red/consola y datos marcados. |
| `lib/server-network-guard.mjs` | Precarga del proceso de la app: bloquea y anota cualquier `fetch` fuera de loopback. |
| `lib/e2e-manifest.mjs` | Inicio del run, instantáneas de la biblioteca de A y limpieza acotada. |
| `lib/untargeted-bundle.mjs` | Build sin `BIBLIB_TARGET` en carpeta temporal y revisión `--forbid-local-login`. |

## Criterios transversales en cada recorrido

- **Sin excepciones JS ni errores de hidratación:** cada página escucha `pageerror` y `console` de tipo `error`. Un error de consola esperado (p. ej. el 404 de un ISBN sin ficha) se admite explícitamente en esa prueba con `guard.allowConsole(...)`. En Firefox y WebKit, las peticiones de la app que una navegación de la prueba cancela (prefetch RSC, cargas en curso) aparecen como «Error loading …: Load failed» o, en WebKit, como rechazo «due to access control checks»; solo se toleran si coinciden con una petición realmente abortada (`requestfailed`) y quedan anotadas como «cancelación al navegar» en el informe HTML.
- **Sin tráfico externo:** el navegador solo puede hablar con la app y con el GoTrue/Storage del perfil (`context.route`); el servidor corre en modo `fixture` y con el guard de red. El runner exige que el guard conste como cargado y que no haya bloqueado ningún host.
- **Sin éxito antes de persistir:** el alta retiene la respuesta del servidor ya persistida y comprueba que la pantalla no anuncia éxito hasta recibirla; un corte de red conserva el borrador.
- **Capturas y datos ficticios:** solo cuentas `@biblib.test` y fichas del censo o marcadas `[QA-02 <run>]`. Las contraseñas se escriben sin pasar por títulos de pasos ni trazas (los proyectos de sesión y cierre no graban traza).
- **Reproducible por nombre:** cada recorrido tiene un título único; `--grep` filtra (los proyectos de sesión se ejecutan siempre como dependencia).

## Datos y limpieza

- Fichas y estanterías creadas por el E2E llevan `[QA-02 <run>]` y un fragmento por prueba; cada prueba borra las suyas al terminar y el runner barre al final todo lo marcado de A/B, más las vistas previas y operaciones de importación de A/B creadas desde el inicio del run.
- El reemplazo real de la importación hace antes una instantánea literal de la biblioteca de A, la anota en `.biblib/e2e/test-run.json` y la restaura al acabar (también el runner siguiente si el proceso se cortó).
- El nombre de perfil de A se devuelve al del censo con la API administrativa local.
- No se crean ni borran cuentas: el runner compara las cuentas de Auth antes y después.

## Grupos y escenarios

| Grupo | Archivo | Escenarios |
| --- | --- | --- |
| Acceso | `flujos/acceso.spec.ts`, `cierre/acceso-sesion.spec.ts`, `sesion.setup.ts` | Formulario local A/B; ruta privada directa → `/login?redirect=`; destino interno conservado al entrar; destinos externos (`https://`, `//`, `/\`) → inicio; callback OAuth inválido; renovación real de una sesión vencida; cierre y copia de cookies revocada; cambio A→B sin restos en cookies, `localStorage` ni `sessionStorage`; errores genéricos y limitador (5 fallos → bloqueo, liberación al minuto); cabeceras `nosniff`/`DENY`. |
| Catálogo | `flujos/catalogo.spec.ts` | Alta manual con corte de red (borrador conservado) y respuesta retenida (sin éxito antes de persistir); ISBN-10 con guiones ya catalogado; edición completa con conflicto de versión, borrador conservado y recarga explícita; eliminación confirmada. |
| Organización | `flujos/organizacion.spec.ts` | Predeterminada protegida; movimiento individual y estado; lote; ficha borrada en otra pestaña; estantería borrada en otra pestaña; selección conservada tras un error de lote. |
| Consulta | `flujos/consulta.spec.ts` | Tildes y mayúsculas; ISBN-10/13 con y sin guiones; cero resultados; filtros de la URL; página que deja de existir; retorno contextual de U-EXP-01 (filtros, página, vista, fila visible y enfocada, Atrás/Adelante, título «<título> · BibLib», ficha sin contexto y ficha inexistente). |
| Importación | `flujos/importacion.spec.ts` | Exportación v1 (con verificación de ISBN); la revisión no escribe; colección cambiada en otra pestaña → conflicto sin borrar y archivo/modo conservados; fusión; confirmación repetida tras perder la respuesta sin duplicar; reemplazo real con restauración; importar libros con ISBN: la revisión no consulta catálogos y el trabajo resuelve las portadas después (U-BIB-05). |
| Privacidad | `flujos/privacidad.spec.ts`, `cierre/…` | B no ve fichas de A en listado, búsqueda, filtro por estantería de A, ficha directa, título ni exportación. |
| Proveedores | `flujos/proveedores.spec.ts` | Fixture «encontrado» con revisión antes de guardar; «no encontrado» con alta manual y el ISBN conservado; fallo del proveedor simulado en el servidor fixture que conserva el alta manual. U-BIB-05: un proveedor vacío (Open Library) y otro disponible (BNE ficticio); 429, plazo agotado, 5xx y ausencia distinguidos por código HTTP y pantalla; cuota global agotada sin reintentos automáticos. Los ISBN reservados están en `lib/bibliographic-catalog/providers/fixture.ts`. |
| Presentación | `flujos/presentacion.spec.ts` | Acceso móvil con tema oscuro, inicio sin botones anidados, colección móvil sin desbordamiento. |
| Ajustes | `flujos/ajustes.spec.ts` | Recuperación de portadas en fixture sin red ni cambios en las fichas (U-BIB-05); exportación en dos partes (2001 fichas); nombre de perfil guardado en GoTrue. |

### Pendientes (`test.fixme`, se activan con su unidad)

| Grupo | Unidad |
| --- | --- |
| Dos copias de una edición / libro sin ISBN como ejemplar | U-DAT-06 |
| Fallo de publicación sin datos parciales; copias v1 + formato nuevo; partes fuera de orden, repetidas, ausentes o alteradas; restauración sin pérdida de IDs | U-DAT-04 |
| Deshacer con conflictos | U-DAT-02 |
| Trabajos: cerrar/reabrir, worker interrumpido, lease vencido, pausa, cancelación, reintento | U-DAT-03 |
| Proveedores: edición discrepante entre fuentes; clave de Google Books ausente (en fixture Google está siempre «configurado»: lo cubren las pruebas unitarias) | U-BIB-04, U-BIB-03 |
| Objetos privados por propietario; borrado de cuenta; copia offline bloqueada | U-DAT-10, U-OPS-03, U-EXP-08 |
| Producto: notas, lectura, préstamos, ubicación, series | U-PRO-01…05 |

### Hallazgos abiertos (no se corrigen en U-QA-02)

1. **Llamadas a Open Library fuera del catálogo en modo `fixture`.** La recuperación de portadas, «Buscar portada» y el enriquecimiento de la importación usan `fetch` directo a `https://openlibrary.org/api/books` (`lib/library-import.ts`), sin pasar por `BIBLIB_CATALOGUE_MODE`. En el primer ensayo (antes de corregir el guard) el servidor salió a Internet y guardó portadas reales en dos fichas del censo de A, que se restauraron por SQL. **Resuelto en U-BIB-05 (23-10-2026):** los cuatro flujos pasan por el orquestador, la revisión de la importación ya no consulta catálogos y el recorrido de Ajustes está activo; una prueba estática impide reabrir un camino directo.
2. **Id de ficha inválido.** `/book/no-es-un-uuid` titula «Libro no encontrado · BibLib», pero la acción responde 500 y la pantalla dice «No se pudo cargar el libro. Comprueba la conexión…». Prueba marcada `test.fail` (fallo conocido): avisará cuando se corrija.
3. **404 RSC al cerrar sesión.** `Header` hace `router.replace("/login")` + `router.refresh()`; el refresco pasa por el proxy, que lo redirige a `/login?redirect=…`, y esa petición RSC responde 404 (la pantalla acaba bien en `/login`). Se admite solo en las pruebas que cierran sesión (`SIGN_OUT_RSC_404`).

## Correspondencia con `scripts/smoke-app.mjs`

El smoke se conserva (rápido, Auth simulado, Postgres efímero) hasta que todos sus escenarios tengan equivalente E2E.

| Escenario del smoke | Equivalente E2E |
| --- | --- |
| Proxy protege inicio/detalle; callback rechaza destinos externos y conserva error OAuth (`nosniff`) | `acceso › una ruta privada directa…`, `acceso › un callback OAuth inválido…` |
| Login móvil y tema oscuro, sin errores de hidratación | `presentacion › acceso en móvil con tema oscuro…` |
| Inicio privado con datos de Postgres aislado; sin botones anidados | `presentacion › inicio y colección sin botones anidados…` |
| Conflicto concurrente conserva borrador y DB, permite recarga explícita | `catalogo › edición: el conflicto de versión…` |
| Alta, edición completa, autores con coma, verificación ISBN, ubicación y estado | `catalogo › alta manual…`, `catalogo › edición…`, `organizacion › movimiento individual y cambio de estado…` |
| ISBN-10 con guiones detecta libro existente y conserva enlace | `catalogo › un ISBN-10 con guiones…` |
| Exportación descarga JSON versionado con datos actuales y verificación ISBN | `importacion › la exportación descarga un JSON v1…` |
| Importación: revisión sin escrituras, confirmación y fusión aditiva | `importacion › la revisión no escribe…`, `importacion › fusionar…` |
| Eliminación confirmada sin afectar otros libros | `catalogo › eliminar exige confirmación…` |
| Exportación de 2001 libros en dos partes importables | `ajustes › una colección de más de 2000 fichas…` |
| Perfil guarda nombre en Auth y muestra confirmación real | `ajustes › el perfil guarda el nombre en GoTrue…` |
| Colección móvil sin desbordamiento; sin excepciones JS | `presentacion › …`; guard de cada recorrido |
| Recuperación de portadas omite manuales sin ISBN y no realiza HTTP externo | `ajustes › la recuperación de portadas termina en modo fixture sin salir a la red ni modificar fichas` (U-BIB-05). El smoke conserva su propia comprobación. |

## Límites conocidos

- GoTrue limita `sign_in_sign_ups` a 30 cada 5 minutos por IP. Cada navegador hace 11 intentos (2 de sesión, 3 de cierre, 5 fallidos del limitador y 1 tras liberarlo): caben dos ejecuciones de Chromium seguidas; antes de Firefox + WebKit, o de `test:integration:local`, espera 5 minutos.
- El limitador del acceso local es por proceso: el recorrido espera 61 s a que se libere para no contaminar al navegador siguiente.
- WebKit automatizado no equivale a Safari/iOS real. Firefox y WebKit se descargan con `pnpm exec playwright install firefox webkit` (en `%LOCALAPPDATA%\ms-playwright`).
- WebKit no aplica `route()` a las peticiones de una página controlada por un service worker, así que su proyecto bloquea los workers (`serviceWorkers: "block"`) y solo `offline.spec.ts` los permite. Sin eso, el logout simulado llegaba a GoTrue y revocaba la sesión guardada de A, y los cortes de red simulados y el guard dejaban de aplicarse (G16).
- Limitaciones de motor en Windows, con sus omisiones inventariadas en el [informe O16-XB](../../docs/validacion/2026-10-26/O16/xb/informe.md): Firefox no deja que el worker atienda navegaciones con `setOffline` (tres pruebas offline omitidas solo en Firefox); el WebKit de Playwright no comprueba la integridad de AES-KW (se omite solo el paso del PIN incorrecto, detectado con una sonda), no trae `mediaDevices`/`MediaStream` (la cámara simulada los crea) y lleva Tab a los enlaces solo con Opción+Tab, como Safari.
- Las pruebas que guardan evidencia (préstamos, impresión y accesibilidad) escriben en `.biblib/e2e/evidencia/<fecha>/<ola>/<unidad>`. Para publicarla en `docs/validacion` hay que pedirlo: `BIBLIB_E2E_EVIDENCE_DIR=docs/validacion`. Un run normal deja el árbol limpio.
- Las pruebas que exportan en v1 comprueban antes que A no tenga datos que exijan v2 (`v2Residue`). Los libros que crea una prueba deben llevar su `data.slug(...)` en el título: la limpieza borra por él.
- La revisión visual y de lector corresponde a U-EXP-03; aquí solo se comprueban desbordamiento y estructura básica.

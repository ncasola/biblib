# O16-XB · E2E en Firefox y WebKit

Fecha: 26 de octubre de 2026. Rama `o16-xb` desde `feature/spec-pendientes` (`5a5adfe`), worktree propietario del perfil `test` (ya levantado; no se ha parado). Solo servicios locales y las cuentas sintéticas A/B; no se ha leído ningún archivo de entorno ni se ha operado sobre destinos remotos. No se modifican `unidades.json`, `matriz-auditoria.md` ni `entrega.md`.

Punto de partida: la puerta G16 con `--project chromium --project firefox --project webkit` dio 194 superados, **48 fallidos** (6 Firefox, 42 WebKit), 11 omitidos y 14 sin ejecutar. Los artefactos de G16 ya no estaban (un run posterior vació `.biblib/e2e/artefactos`): cada causa se ha reproducido aquí con el registro `.biblib/g16/e2e.log`, ejecuciones acotadas y sondas en los tres motores.

## Resultado

**Cada navegador por separado queda en verde:** Chromium 85/85, Firefox 82/82 y WebKit 79, más las 9 pruebas tocadas. Las omisiones están justificadas en el inventario.

**Run completo de los tres navegadores:**
- Hubo dos runs con intermitencias, que se corrigieron (§9).
- El tercer run de cierre lo **interrumpió el usuario** a las 12:25, porque el equipo se estaba quedando sin memoria. El usuario **dio por buenos los runs** realizados (decisión anotada en el acta G16).
- Queda abierta una intermitencia en Chromium (`offline:318`, 1 de 7).

**Ningún fallo era un defecto del producto.** Las 48 caídas vienen de cinco problemas de las pruebas y de cuatro diferencias de motor de Playwright en Windows. No se ha cambiado código de la aplicación ni la semántica de seguridad: el cierre de sesión sigue siendo `scope: "global"`.

## Causas

### 1. WebKit perdía la sesión de A (35 fallos)

- **Síntoma:** desde `organizacion.spec.ts`, todo WebKit acababa en «Acceso · BibLib» y caía por tiempo.
- **Causa:** WebKit no aplica `page.route`/`context.route` a las peticiones de una página controlada por un service worker. Aunque `public/sw.js` no responde las peticiones a otros orígenes, sí pasan por su evento `fetch`. El simulacro de `offline: el cierre de sesión…` no interceptaba `POST /auth/v1/logout?scope=global`, que llegaba a GoTrue (0 llamadas al manejador, respuesta 204 real). Así revocaba todas las sesiones de A, también la del `storageState` compartido de WebKit.
- **Por qué no ocurría en Chromium ni en Firefox:** allí `route()` sí ve esas peticiones. Además, el resto de los proyectos ya había pasado o inicia su propia sesión.
- **Mismo origen:** tampoco se aplicaban los cortes de red simulados (`route.abort("failed")`) de `alta-consecutiva:40`, `catalogo:11` y `avatar:5`. En WebKit, el guard de «sin tráfico externo» quedaba sin efecto.
- **Corrección** (`2bb7eb7`): el proyecto `webkit` bloquea los service workers (`serviceWorkers: "block"`, recomendación de Playwright para usar `route`) y `offline.spec.ts` los vuelve a permitir.
- **Prueba de cierre de sesión:** se ejecuta sin worker solo en WebKit, porque la purga de la copia la hace la página y no el worker. En todos los motores exige además que el logout se haya simulado (`logouts === 1`), para que una revocación real falle en su origen y no 30 pruebas después.

### 2. `formatVersion: 2` en Firefox y WebKit (4 fallos)

- **Causa:** las tres pruebas de `prestamos.spec.ts` creaban libros con títulos sin el `data.slug(...)` de la prueba. La limpieza del fixture `data` borra por marca + slug, así que quedaban en A tres ejemplares con préstamos. Como los préstamos exigen v2, desde el segundo proyecto la exportación salía en v2.
- **Cómo se localizó:** un diagnóstico temporal contó, tras cada prueba de Chromium, los datos de A que exigen v2. Solo préstamos dejaba restos: copias 4→7 y préstamos 0→3.
- **Corrección** (`6536a10`): los títulos llevan el slug, y la limpieza se lleva el ejemplar y sus préstamos.
- **Precondición explícita:** `ajustes:30` e `importacion:48` comprueban antes con `v2Residue(stack, "a")` que A no tiene datos que exijan v2. Si otra prueba deja restos, el fallo dice cuáles (`{"préstamos": 3}`) en lugar de un `formatVersion` inesperado. No se acepta 1 o 2 a ciegas.

### 3. Offline en Firefox: `NS_ERROR_OFFLINE` (3 omisiones justificadas)

- **Causa:** con `context.setOffline(true)` de Playwright, que equivale al modo «Trabajar sin conexión», Firefox no deja que el worker atienda ninguna navegación.
- **Comprobaciones:** con el worker activo y controlando la página, fallan `page.goto("/books")` (`NS_ERROR_OFFLINE`) y `location.assign("/books")`; `location.assign("/offline")` muestra «Problem loading page».
- **Alternativa descartada:** cortar el servidor con `context.route` no sirve, porque las peticiones del propio worker no pasan por `route` y la navegación respondió 200. Abrir `/offline` con red tampoco, porque la validación con conexión renovaría el TTL que prueba `offline:241`.
- **Decisión** (`2877f34`): `test.skip(browserName === "firefox", …)` solo en las tres pruebas que navegan sin red, con el motivo. Siguen cubiertas en Chromium y WebKit. Las demás pruebas offline se ejecutan en Firefox.

### 4. Offline en WebKit: «copia dañada» (2 fallos, omisión parcial)

- **Sonda:** misma página, PBKDF2 → AES-KW, `wrapKey` con la clave buena y `unwrapKey` con otra.

  | Motor | `unwrapKey` con clave equivocada | Con el texto envuelto alterado |
  | --- | --- | --- |
  | WebKit 27.2 (Playwright, Windows) | **aceptada** | **aceptada** |
  | Chrome 155 | `OperationError` | `OperationError` |
  | Firefox 157 | `OperationError` | `OperationError` |

- **Lectura:** este WebKit no aplica la comprobación de integridad de RFC 3394. Con un PIN incorrecto se desenvuelve una clave basura, AES-GCM falla al descifrar y la app muestra, con razón, «copia dañada». Es un defecto del motor de prueba, no de `lib/offline-library.ts`, que sigue la especificación WebCrypto. No se ha podido comprobar en un Safari real.
- **Por qué no se toca el producto:** cambiar el formato de la copia, por ejemplo con un verificador de clave, cambiaría el formato persistido sin un defecto de producto que lo justifique.
- **Decisión** (`2877f34`): `aesKwRejectsWrongKey()` sondea el motor en la propia página. Solo si no detecta la clave equivocada, se omite el paso del PIN incorrecto y se anota como «omisión parcial». El resto de la prueba se ejecuta: activar, abrir sin red con el PIN correcto, aislamiento A/B, bloquear y renovar. Si Playwright corrige el motor, el paso vuelve solo.
- **Ajuste adicional** (`409e584`): WebKit registra la carga fallida sin red como «Failed to load resource: WebKit encountered an internal error», el equivalente de `net::ERR_INTERNET_DISCONNECTED`. Se admite solo en las pruebas que cortan la red y solo sobre `/offline` y `/auth/v1/token`.

### 5. Cámara en WebKit (3 fallos)

- **Causa:** el WebKit de Playwright para Windows se compila sin pila multimedia: no tiene `navigator.mediaDevices`, `MediaStream` ni `BarcodeDetector`. El simulacro hacía `Object.defineProperty(navigator.mediaDevices, …)` y fallaba con «Properties can only be defined on Objects».
- **Producto:** en este motor detecta bien la ausencia de cámara. «cámara no compatible mantiene visible el formulario» ya pasaba.
- **Corrección** (`ab13fee`): `cameraShim` crea `mediaDevices` y `MediaStream` solo si faltan, y deja que `srcObject` guarde el flujo simulado. En Chromium y Firefox no cambia nada. Se sigue simulando solo la capacidad física, como antes.

### 6. Alta y avatar con corte de red en WebKit (3 fallos)

`route.abort("failed")` no llegaba a la Server Action por la causa 1. Con el worker bloqueado, las tres pruebas pasan con la alerta «No se pudo guardar el libro» y el borrador conservado. **No hay defecto de producto:** el error de red de la Server Action se trata en WebKit igual que en los otros motores.

### 7. Foco en la estantería 3D con WebKit (1 fallo, omisión parcial)

- **Causa:** Safari no lleva Tab a los enlaces (`tabsToLinks` está desactivado por defecto).
- **Experimento:** en este WebKit no llegan al enlace ni Tab, ni Alt+Tab, ni Meta+Tab, ni Control+Alt+Tab. Tab salta «Abrir ficha» y enfoca «Devolver a la balda», el control siguiente del panel.
- **Decisión** (`4f61fe2`, corregido en `d5f59de`): en WebKit se comprueba que Tab entra en el panel por ese control y se anota la omisión del foco en el enlace, que sigue probado en Chromium y Firefox. Escape y «Devolver a la balda» se comprueban en los tres.

### 8. Ubicaciones en Firefox: `NS_BINDING_ABORTED` (1 fallo)

- **Causa:** crear una ubicación la selecciona con `router.replace(?ubicacion=<id>)`. La prueba hacía `page.goto` antes de que terminara: Firefox cancelaba la carga RSC («Failed to fetch RSC payload… Falling back to browser navigation») y la navegación completa de la app abortaba la de la prueba.
- **Corrección** (`9c2b58b`): `createLocation` espera a que la URL cambie a la nueva ubicación. Es una carrera de la prueba, no un defecto: un usuario no navega en ese milisegundo, y si lo hiciera la app recae en una navegación completa.

### 9. Intermitencias de los runs completos de cierre

Tras las correcciones anteriores, cada navegador por separado quedó en verde: Chromium 85/85, Firefox 82/82 y WebKit 79 + 9 de las pruebas tocadas. Los runs completos de los tres navegadores sacaron fallos que no aparecen al ejecutar cada navegador solo:

- **Run completo 1** (29,1 min, 5 fallos):
  - **Entorno:** el equipo iba lento. Las mismas pruebas tardaron el doble que en los runs sueltos (privacidad: 55,9 s frente a 6,5 s) y, en WebKit, un `click` esperó 42 s a que el botón quedara estable aunque el servidor respondía en menos de 1 s.
  - **Fallos:**
    - `proveedores:12` y `prestamos:95` en WebKit, por tiempo.
    - `csv:94` en WebKit: el mapeo no apareció en 10 s.
    - `organizacion:58` en Firefox: el clic en «Eliminar libro» llegó antes de hidratar y el diálogo nunca se abrió.
    - `offline:318` en Chromium: el worker publicado se instaló, pero no se activó en 30 s; ninguna petición quedó pendiente en la traza. Pasó 3 de 3 veces aislado (6,5 s).
  - **Resultado:** ninguno se repitió en el run 2.
- **Run completo 2** (17,8 min, 2 fallos nuevos):
  - `offline:212` en WebKit: «internal error» sin red sobre `/settings`, una acción en curso al cortar la red.
  - El cierre `acceso-sesion:14` en Firefox: el worker atendía la carga de dos logos de `/login` y la cancelación por la navegación de la prueba aparece como «A ServiceWorker intercepted the request and encountered an unexpected error».

Correcciones:

- **Firefox, carga del worker cancelada** (`a51d795`): esa firma se tolera como las demás cancelaciones al navegar. Solo vale en el origen de la app y en los 3 s posteriores a una navegación, y queda anotada.
- **WebKit, carga sin red** (`0e6a996`): el «internal error» sin red se admite en cualquier ruta de la app, como `ERR_INTERNET_DISCONNECTED` en Chromium, y solo en las pruebas que cortan la red. Los otros orígenes ya los bloquea el guard.
- **Firefox, clic antes de hidratar** (`f43858a`): `organizacion:58` espera a que la segunda pestaña quede en reposo antes de pulsar.
- **Chromium, activación del worker** (`0e6a996`): `offline:318` no cambia lo que comprueba. Si vuelve a fallar, su mensaje mostrará el estado de los workers activo, en espera e instalando, para diagnosticarlo. No he encontrado su causa: queda como intermitencia abierta (1 de 7 ejecuciones en Chromium).

## Tabla de los 48 fallos de G16

Tipos: **test**, la prueba era incorrecta (aislamiento, espera o simulacro); **motor**, diferencia documentada de Playwright corregida en la prueba sin debilitarla; **omisión**, no se puede probar en ese motor (inventario abajo). Ninguno es de tipo **producto**.

| # | Proyecto | Prueba | Causa | Tipo | Commit | Resultado final |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | firefox | ajustes:30 exportación en dos partes | §2 préstamos sin limpiar | test | `6536a10` | corregido, verde en el run de Firefox |
| 2 | firefox | importacion:48 exportación v1 | §2 | test | `6536a10` | corregido, verde en el run de Firefox |
| 3 | firefox | offline:119 activar y consultar sin conexión | §3 `NS_ERROR_OFFLINE` | omisión | `2877f34` | omitida en Firefox; pasa en Chromium y WebKit |
| 4 | firefox | offline:181 A y B no ven la copia del otro | §3 | omisión | `2877f34` | omitida en Firefox; pasa en Chromium y WebKit |
| 5 | firefox | offline:241 TTL vencido | §3 | omisión | `2877f34` | omitida en Firefox; pasa en Chromium y WebKit |
| 6 | firefox | ubicaciones:41 mueble, balda y ficha | §8 carrera de navegación | test | `9c2b58b` | corregido, verde en el run de Firefox |
| 7 | webkit | ajustes:30 exportación en dos partes | §2 | test | `6536a10` | corregido, verde en el run de WebKit |
| 8 | webkit | alta-consecutiva:40 error conserva borrador | §1/§6 `route` sin efecto con worker | motor | `2bb7eb7` | corregido, verde en el run de WebKit |
| 9 | webkit | alta-consecutiva:90 cámara denegada | §5 sin `mediaDevices` | motor | `ab13fee` | corregido, verde en el run de WebKit |
| 10 | webkit | alta-consecutiva:118 checksum inválido | §5 | motor | `ab13fee` | corregido, verde en el run de WebKit |
| 11 | webkit | alta-consecutiva:158 detener cámara | §5 | motor | `ab13fee` | corregido, verde en el run de WebKit |
| 12 | webkit | avatar:5 avatar privado | §1/§6 | motor | `2bb7eb7` | corregido, verde en el run de WebKit |
| 13 | webkit | catalogo:11 fallo de red en alta manual | §1/§6 | motor | `2bb7eb7` | corregido, verde en el run de WebKit |
| 14 | webkit | estanteria-3d:89 teclado | §7 Tab no enfoca enlaces | motor + omisión parcial | `4f61fe2`, `d5f59de` | corregido, verde en el run de WebKit (foco en el enlace no probado en WebKit) |
| 15 | webkit | importacion:48 exportación v1 | §2 | test | `6536a10` | corregido, verde en el run de WebKit |
| 16 | webkit | offline:119 activar y consultar | §4 AES-KW sin integridad | motor + omisión parcial | `2877f34`, `409e584` | corregido, verde en el run de WebKit (sin el paso del PIN incorrecto) |
| 17 | webkit | offline:181 A y B | §4 | motor + omisión parcial | `2877f34`, `409e584` | corregido, verde en el run de WebKit (sin los pasos de secreto incorrecto) |
| 18 | webkit | offline:241 TTL vencido | §1 sesión revocada | test | `2bb7eb7`, `409e584` | corregido, verde en el run de WebKit |
| 19 | webkit | offline:270 versión nueva del worker | §1 | test | `2bb7eb7` | corregido, verde en el run de WebKit |
| 20–25 | webkit | organizacion:15, 24, 41, 58, 81, 102 | §1 | test | `2bb7eb7` | corregido, verde en el run de WebKit |
| 26 | webkit | paginacion:5 | §1 | test | `2bb7eb7` | corregido, verde en el run de WebKit |
| 27–30 | webkit | personal:3, 27, 46, 71 | §1 | test | `2bb7eb7` | corregido, verde en el run de WebKit |
| 31 | webkit | presentacion:20 móvil con sesión | §1 | test | `2bb7eb7` | corregido, verde en el run de WebKit |
| 32–34 | webkit | prestamos:15, 74, 90 | §1 | test | `2bb7eb7` | corregido, verde en el run de WebKit |
| 35–40 | webkit | proveedores:12, 30, 45, 78, 93, 124 | §1 (401 en `/api/books/search`) | test | `2bb7eb7` | corregido, verde en el run de WebKit |
| 41 | webkit | revision:6 bandeja de revisión | §1 | test | `2bb7eb7` | corregido, verde en el run de WebKit |
| 42–45 | webkit | series:31, 79, 109, 132 | §1 | test | `2bb7eb7` | corregido, verde en el run de WebKit |
| 46–47 | webkit | ubicaciones:41, 105 | §1 | test | `2bb7eb7` | corregido, verde en el run de WebKit |
| 48 | webkit | vistas:3 vistas guardadas | §1 | test | `2bb7eb7` | corregido, verde en el run de WebKit |

Las líneas son las de G16; tras los cambios algunas pruebas se han desplazado unas líneas, pero conservan su título.

## Inventario de omisiones

| Proyecto | Prueba | Alcance | Motivo |
| --- | --- | --- | --- |
| firefox | `offline: activar con PIN y consultar sin conexión…` | prueba completa | §3: Firefox con `setOffline` no deja que el worker atienda navegaciones (`NS_ERROR_OFFLINE`). |
| firefox | `offline: A y B en el mismo navegador no ven la copia del otro` | prueba completa | §3 |
| firefox | `offline: un TTL vencido bloquea la copia…` | prueba completa | §3; abrir `/offline` con red renovaría el TTL. |
| webkit | `offline: activar con PIN…` | paso «PIN incorrecto → Te quedan 9 intentos» | §4: AES-KW sin comprobación de integridad; se decide en tiempo de ejecución con una sonda. |
| webkit | `offline: A y B…` | dos pasos de secreto de la otra cuenta | §4 |
| webkit | `estantería 3D con teclado…` | foco en «Abrir ficha» con Tab | §7: se comprueba que Tab entra en el panel por «Devolver a la balda». |

Omisiones ya existentes, sin cambios:

- `offline: borrar los datos del sitio…` solo en Chromium, porque usa CDP.
- `capturas U-UX-02`, solo con `UX02_CAPTURAS=1`.
- Los dos `fixme` de `pendientes.spec.ts`, de U-BIB-04 y U-BIB-03.

No hay omisiones en bloque por proyecto ni para tapar fallos de sesión o datos.

## Higiene de evidencia

- **Problema:** cada E2E completo reescribía evidencia publicada de O14 (`pro-04/*-axe.json`) y O15 (`exp-07/*.pdf|png`), y creaba archivos `firefox-*` y `webkit-*`. `test:a11y:local` hacía lo mismo con O11 (`exp-03/*.json|png`).
- **Ubicación nueva** (`6d3f857`): esas pruebas escriben con `evidenceDir("<fecha>/<ola>/<unidad>")` en `.biblib/e2e/evidencia/…`, que Git ignora.
- **Publicación deliberada:** solo con `BIBLIB_E2E_EVIDENCE_DIR=docs/validacion` se escribe allí.
- **Reenvío de la variable:** el runner la reenvía con `evidenceEnvironment()`, porque el entorno hijo no hereda `BIBLIB_*`. Tiene prueba en `tests/scripts/e2e-runner.test.mjs`.
- **Fuera del cambio:** `tests/accessibility/evidence.mjs` y `performance.mjs` siguen escribiendo en O11, porque son comandos explícitos de publicación.
- **Lo que comprueban las pruebas no cambia.**

Comprobado: tras los runs de esta unidad, `git status` no muestra cambios en `docs/validacion/` ajenos a este informe.

## Validación

- **Runs por navegador:** Chromium 85/85, Firefox 82/82 y WebKit 79 + 9 (§9).
- **Runs completos:** dos, con 5 y 2 intermitencias corregidas. El tercero se interrumpió por memoria, a petición del usuario.
- **Comprobaciones del coordinador al integrar:** `pnpm lint`, `typecheck`, `test` y `test:scripts`.

## Recursos y alcance

- **Docker:** no se ha levantado ni parado nada. El perfil `test` (`biblib-test`, 55330–55339) sigue levantado como estaba, con su red y sus volúmenes. No se ha usado `scratch` ni se ha tocado HolaERP.
- **Archivos tocados:** `playwright.config.ts`, `tests/e2e/**`, `tests/accessibility/{audit,contrast,keyboard}.spec.ts`, `tests/scripts/e2e-runner.test.mjs`, `tests/e2e/README.md`, una sección propia en `docs/operacion.md` y este informe. No se ha cambiado código de la aplicación.
- **Fuera del alcance:**
  - `tests/accessibility/playwright.config.ts` no bloquea los workers en WebKit. `test:a11y:local` solo ejecuta Chromium por defecto; si se ejecuta en WebKit, conviene aplicar el mismo bloqueo.
  - Comprobar AES-KW en un Safari real requiere un equipo macOS o iOS.

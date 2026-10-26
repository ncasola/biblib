# U-UX-01 · Sistema visual «Biblioteca nocturna» · Informe

**Fecha:** 25–26 de octubre de 2026 · **Rama:** `u-ux-01` (worktree `stack-test`) · **Perfil:** `test` (head `0014`) · **Spec:** [07 · Rediseño](../../../../spec-pendientes/07-rediseno.md) · **Referencia:** `docs/diseno/prototipo/direccion-a.dc.html` (Dirección A aprobada).

## Resumen

La app adopta la Dirección A en los dos temas: fondo de tinta cálida con luz de lámpara, tarjetas de nogal con sombras por capas, latón como acento, crema como texto y el rojo de acción del prototipo. Los titulares van en Fraunces y el texto en Inter, ambas autoalojadas. Es un cambio solo de presentación: no se tocan acciones, datos ni rutas, y se mantienen roles, nombres accesibles, `id` y textos que usan las pruebas. La única prueba modificada es la de contraste, que ahora mide las clases nuevas (ver «Pruebas modificadas»).

## Qué se ha hecho (por capa y commit)

| Capa | Commit | Contenido |
| --- | --- | --- |
| Evidencia previa | `2fed383` | `tests/visual/` (Playwright con el runner E2E) y capturas «antes». |
| Tokens | `ed4bb19` | `app/globals.css`: paleta oscura y crema, latón, enlaces, estados de lectura, elevación (`--elev-1…4`, que redefinen `shadow-*`), radios y las utilidades `surface-card`, `eyebrow`, `link-quiet` y `.status-chip`. La sección del visor 3D no se toca. |
| Tipografía | `f83fd86` | `app/fonts.ts` con `next/font/local` y woff2 en `app/fonts/` (con sus licencias OFL). |
| Marca | `f83fd86`, `0759706` | Favicon con `logo-mark.png`, `themeColor` por tema y manifiesto con los colores nuevos (ver «Marca»). |
| Estructura | `c02b78f` | Cabecera con logo y «BibLib» en Fraunces, navegación en píldoras con estado activo, búsqueda rápida, «Añadir libro» y menú móvil. |
| Componentes | `483611d`, `0fc70b1` | Botón, tarjeta, campo, selector, tabla, pestañas, menú, diálogos, insignia, chip de estado, estrellas, `PageHeader`, carga, error y «Libro no encontrado». |
| Pantallas | `c9fa171` … `fb46060` | Inicio y acceso; colección, búsqueda y alta; ficha; estanterías; series y ubicaciones; revisión; ajustes y perfil. |
| Documentación | `9c17d0e` | `AGENTS.md`: «Filosofía de diseño» y «Convenciones de estilo». |
| Pruebas | `370aa9c`, `13d7a70` | Contraste con las clases nuevas y capturas complementarias. |
| Accesibilidad | `472facd` | `/login` con `<main>`: corrige dos avisos moderados de axe que ya existían. |

### Tokens y contraste

Se conservan todos los nombres de shadcn (`--background`, `--card`, `--primary`…). Además se añaden `--brass`, `--brass-light`, `--brass-text`, `--walnut`, `--heading`, `--link`, `--primary-text`, `--status-*`, `--elev-*`, `--card-sheen` y `--page-glow`.

Las variables `--vintage-*` se mantienen porque las usan ~70 clases y la prueba de contraste. Se reajustaron a la paleta nueva: el rojo pasa a ser el de acción y el amarillo, el latón. Los usos con color a mano se retiraron: `text-white` sobre rojo, `bg-vintage-yellow text-black`, `hover:scale` y sombras de color.

| Tema | Mínimo medido (prueba de contraste, 43 muestras) |
| --- | --- |
| Claro | Primario en hover: 5,16:1 (umbral 4,5) |
| Oscuro | Primario: 5,23:1 (umbral 4,5) |

- **Foco y bordes de control:** `--ring` y `--control-border` frente a fondo, tarjeta, superficie y campo dan como mínimo 3,95:1 en claro y 4,36:1 en oscuro (umbral 3).
- **Estado deshabilitado:** WCAG 1.4.3 lo exime, así que no se fuerza AA. Para que siga siendo legible, la opacidad pasa del 50 % al 60 %. Medido sobre el botón primario encima de una tarjeta, queda en 3,5:1 en oscuro y 2,8:1 en claro.
- **Evidencia:** `a11y/chromium-flujos-contraste.json`.

### Tipografía: por qué `next/font/local` y no `@fontsource-variable`

Se descartó `@fontsource-variable` por cuatro motivos:

- **Sin dependencias ni lockfile:** no añade paquetes ni toca `pnpm-lock.yaml`, que también comparten O14-D y U-UX-02 en esta ola.
- **Mejor carga:** `next/font` precarga las dos fuentes y genera una reserva con métricas ajustadas (Times New Roman / Arial), lo que reduce el CLS. El CSS de fontsource no hace ninguna de las dos cosas.
- **Solo lo necesario:** se versionan dos archivos de 67 KB (Fraunces latín con ejes `opsz`+`wght`) y 48 KB (Inter latín `wght`). Cubren el español completo. Los glifos fuera del subconjunto latino usan la reserva del sistema.
- **Procedencia comprobable:** los archivos salen de `@fontsource-variable/fraunces@5.3.0` y `@fontsource-variable/inter@5.3.0`, descargados con `npm pack` (OFL 1.1; las licencias están en `app/fonts/OFL-*.txt`).
  - SHA-256 de Fraunces: `7234ed86…d783`.
  - SHA-256 de Inter: `3100e775…4c62`.

**Comprobación sin red:** `pnpm build` sirve las fuentes desde `.next/static/media/*.woff2`. En `.next/static` y `.next/server` no aparece `fonts.googleapis` ni `fonts.gstatic`. La CSP (`font-src 'self' data:`) no cambia.

### Marca

- **Cabecera:** `logo-mark.png` (solo el personaje) junto a «BibLib» en Fraunces.
- **Acceso:** `logo-transparent.png` en claro y `logo-dark.png` en oscuro. Ambas imágenes conservan `alt="BibLib Logo"`; la del otro tema no se muestra (`display: none`).
- **Favicon y atajo:** antes usaban `logo.png`, con fondo blanco y tamaños declarados que no eran los reales; ahora usan `logo-mark.png` (361×361).
- **Icono de iOS (`apple`):** sigue siendo `logo.png` con fondo blanco, porque iOS rellena la transparencia de negro. Se corrige su tamaño declarado a 500×500.
- **Manifiesto:**
  - `logo-transparent.png` con `purpose: any` y `logo.png` con `purpose: maskable`.
  - Fondo `#f5eddd` y tema `#16110d`.
  - `viewport.themeColor` cambia según el tema del sistema.

### Componentes base

| Componente | Cambios |
| --- | --- |
| Botones | Mínimo 44 px, radio de 12 px y peso 600. El primario lleva brillo interior y sombra. `motion-safe:active:translate-y-px`. Deshabilitado al 60 %. |
| Tarjetas | `surface-card`: brillo superior, borde fino, radio de 20 px y `--elev-2`. |
| Campos y selectores | `bg-input` y borde de control; los `<select>` y `textarea` nativos se unificaron. |
| Tablas | Cabecera en superficie, filas con hover en acento y contenedor con radio. |
| Diálogos | Fondo `popover`, radio de 20 px, sombra `--elev-4`, velo cálido y títulos en Fraunces. Las animaciones de tw-animate se anulan con movimiento reducido. |
| Estados | Chips de estado (`BookStatusBadge` → `.status-chip[data-status]`); «prestado» queda definido para O14. Estrellas decorativas (`RatingStars`, `aria-hidden`; los textos «N de 5 estrellas» y «Valoración: N de 5» no cambian). |
| Avisos | Confirmaciones con borde izquierdo verde. El aviso flotante de Ajustes (el «toast» de la app) pasa a `popover` con sombra. |
| Vacío, carga, error y paginación | Vacíos con borde discontinuo; `LoadingState`, `RouteError`, `app/error.tsx` y «Libro no encontrado» rediseñados. La paginación usa los botones `outline` nuevos. |

### Pantallas

- **Inicio:** como en el prototipo, con hero, titular, estadísticas, «Seguir leyendo», estanterías, últimas incorporaciones y bandeja de revisión.
  - **Titular:** se construye con recuentos reales («4 libros y una lectura a medias.»).
  - **Estadísticas:** cuatro tarjetas con datos reales (libros, leyendo, por leer y leídos).
  - **«Seguir leyendo»:** portadas reales; a cada tarjeta le falta la barra de progreso (ver huecos O14).
  - **Estanterías:** tarjetas con lomos decorativos que enlazan a `/books?shelf=<id>`. Los lomos son deterministas y solo reflejan cuántos libros hay, hasta 18.
  - **Revisión de fichas:** bloque **sin cifras**. El recuento exigiría `listReviewIssuesAction`, que regenera incidencias (escribe) en la primera página; no se llama desde el inicio.
  - **Huecos preparados para O14, sin cifras inventadas:** la tarjeta «Prestados» y el progreso de lectura, marcados con comentarios en `app/page.tsx`.
  - **Datos:** solo se leen `getLibrarySummaryAction` y `getShelvesAction`, que ya existían.
- **Colección y búsqueda avanzada:** `PageHeader`, tarjeta contenedora, tabla, cuadrícula con elevación al pasar el puntero, chips, etiquetas en píldora y vistas guardadas como panel anidado.
- **Alta (ISBN, manual y escáner):** antetítulo y titular nuevos, tarjetas `surface-card` y controles unificados. Los flujos no cambian.
- **Ficha:**
  - Portada fija en escritorio, antetítulo «Ficha del libro» y chip de estado con la estantería.
  - Metadatos con etiquetas en versalitas.
  - Ejemplar, notas (con cita en latón), etiquetas, valoración, ubicación y serie como tarjetas `surface-card`.
- **Estanterías:** tarjetas con lomos (componente `ShelfSpines`, compartido con el inicio) y la insignia «Predeterminada» en latón. Las tarjetas conservan `div.rounded-2xl`, que usa el selector de la prueba de organización.
- **Series, ubicaciones, revisión, ajustes (importación CSV/JSON, exportación y versiones), perfil (avatar y eliminación de cuenta) y acceso:** cabeceras nuevas, tarjetas, controles y avisos del sistema. El motivo de revisión pasa de amarillo con texto negro (contraste bajo en claro) a latón con tinta (7,6:1).

### Decisiones sobre los textos visibles

- **No cambia ningún texto que usen las pruebas.** El prototipo llama «Colección» a «Libros» y añade «Revisión» a la navegación; se mantiene «Libros» y la navegación de seis entradas, porque esas etiquetas son parte del contrato de los E2E y de la navegación.
- **Textos nuevos, solo en elementos añadidos:**
  - antetítulos («Tu biblioteca», «Colección», «Organización», «Ficha del libro»…);
  - titular y bloques del inicio («Seguir leyendo», «Estanterías», «Revisión de fichas», «Abrir la bandeja», «Abrir en 3D», «Gestionar estanterías», «Ver todo»);
  - búsqueda de la cabecera («Buscar en la colección»);
  - atajo «Añadir libro» de la cabecera.
- **Por qué no chocan con las pruebas:**
  - **«Añadir libro» frente a «Agregar libro»:** el atajo de la cabecera usa el nombre del prototipo. Así no colisiona con `getByRole("link", { name: "Agregar libro", exact: true })` del E2E de alta consecutiva.
  - **Búsqueda de la cabecera:** es `type="search"`, con otro nombre accesible. No interfiere con el textbox «Buscar por título, autor o ISBN» de la colección y no se muestra en `/books*`.
  - **Menú móvil:** «Inicio» sigue siendo el primer enlace tras el botón (lo exige la prueba de diálogos).
- **La navegación de escritorio aparece desde `lg`** (antes `md`). Entre 768 y 1023 px se usa el menú móvil para que la cabecera no se desborde. El menú de cuenta sigue visible desde `md`.

## Pruebas modificadas

- **`tests/accessibility/contrast.spec.ts`:**
  - **Retiradas:** las muestras de los chips de estado con clases Tailwind (`bg-green-100 text-green-800`…), que ya no usa la app.
  - **Añadidas:** los chips reales (`.status-chip[data-status]`, incluido «prestado») y las clases nuevas: navegación activa (`bg-foreground text-background`), hover de navegación, enlaces, latón, texto secundario, pestaña inactiva y menú.
  - **Sin cambios:** el resto de muestras, los umbrales y las aserciones.
- **`tests/visual/` (nuevo):** solo genera evidencia; no forma parte de la aceptación.

## Resultados (ejecutados en esta rama)

| Comprobación | Resultado |
| --- | --- |
| `pnpm lint` | 0 errores |
| `pnpm typecheck` | Correcto |
| `pnpm test` | 460/460 |
| `pnpm test:scripts` | 269 superadas y 2 omitidas, que necesitan el stack `scratch` en marcha (no es de esta unidad); 0 fallidas |
| `pnpm build` | Correcto (fuentes en `.next/static/media`, sin referencias a Google) |
| `pnpm check:bundle --dist-dir .next --forbid-local-login` | Correcto (52 archivos, sin formulario local) |
| `pnpm test:smoke` | 12/12 escenarios |
| `pnpm test:e2e:local` (Chromium) | 63 superados, 19 pendientes `fixme` (ya existentes, de unidades futuras), 0 fallidos y 0 repeticiones; sin tráfico externo |
| `pnpm test:a11y:local` (grupo de U-EXP-03) | 10/10: axe en claro y oscuro con 0 serious/critical en las 14 vistas y diálogos por tema; contraste; reflujo a 320, 375, 768 y 1440 px y zoom de 200 y 400 % sin scroll horizontal; foco, menú móvil y movimiento reducido; teclado |
| axe en `/login` tras `472facd` | 0 violaciones de cualquier nivel en claro y oscuro (antes: 2 moderadas ya existentes) |
| `pnpm test:integration:local` | 232 escenarios superados, 0 fallidos |

**Orden de ejecución:**

- Al cierre se repitieron `lint`, `typecheck`, `test`, `build` y `check:bundle` sobre el último commit.
- El grupo completo de accesibilidad, el E2E y la integración se ejecutaron antes de `472facd`, que solo convierte el contenedor del acceso en `<main>`.
- Tras ese commit volvieron a pasar la auditoría del acceso en los dos temas y el flujo de sesión por formulario (setup del E2E en las ejecuciones de capturas y de accesibilidad).

**Evidencia:** el JSON de axe, contraste y reflujo, y las capturas de 320 px y del diálogo, están en [`a11y/`](a11y/). Se copiaron desde la ruta fija de U-EXP-03 (`docs/validacion/2026-10-24/O11/exp-03/`), que se restauró sin cambios. Los avisos moderados o menores que quedan, si los hay, están en esos JSON.

## Capturas

Se tomaron con Playwright contra la app del perfil `test`, solo con datos ficticios del censo (cuenta A, `@biblib.test`).

| Carpeta | Contenido |
| --- | --- |
| [`capturas/antes/`](capturas/antes/) | 20 JPEG: inicio, colección, ficha, estanterías y acceso a 1440 y 375 px, en claro y oscuro. |
| [`capturas/despues/`](capturas/despues/) | Las mismas 20 y 28 complementarias (`extra-*`: alta, búsqueda, revisión, series, ubicaciones, ajustes y perfil). |

Para regenerarlas: `UX_CAPTURE_PHASE=antes|despues node tests/visual/run.mjs` (con el stack `test` en marcha).

## Fuera de alcance, conflictos y pendientes

- **Visor 3D:** no se ha tocado `components/shelf-viewer-3d.tsx`, `app/shelves/3d/**` ni `viewer-contract.ts`. En `app/globals.css` se reescribió solo la parte de tokens, que va antes del bloque «Visor 3D de estantería (U-EXP-04)»; ese bloque queda igual. Si U-UX-02 edita ese bloque, la fusión debería ser automática. Hasta entonces, `/shelves/3d` hereda los tokens y la cabecera nuevos con su escena actual.
- **Lockfile:** sin dependencias nuevas; `package.json` y `pnpm-lock.yaml` no cambian.
- **O14:** quedan preparados los huecos «Prestados» y el progreso de lectura del inicio, y el chip «prestado» (`data-status="loaned"`, AA medido). Hay que conectarlos cuando existan datos reales.
- **Revisión en el inicio:** mostrar el número de fichas pendientes requiere un recuento de solo lectura (hoy no existe sin regenerar incidencias). Se propone para una unidad de datos.
- **Firefox y WebKit:** no se ejecutaron (no se pedían para esta unidad); el cierre de ola los cubre.
- **Recursos Docker:** al terminar se ejecutó `pnpm db:local:down --profile test`. Se conservan la red `biblib-test-network` y los volúmenes propios del perfil `test`. No se tocó `scratch`, `main` ni HolaERP.

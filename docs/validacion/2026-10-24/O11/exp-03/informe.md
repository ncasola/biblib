# U-EXP-03 · Evidencia O11

Implementación y validación automática completadas en el perfil exclusivo `test` de este worktree, sin base remota, datos ficticios y sin modificar recursos de HolaERP. Accesibilidad completa: 30 superadas; regresión E2E: 40 superadas y 19 pendientes heredadas; ambas sin fallos ni repeticiones. El último ajuste del anuncio de error de renombrado se volvió a comprobar con nueve escenarios enfocados en los tres motores. No se certifica WCAG y los ensayos manuales no ejecutados permanecen pendientes.

## Cambios y evidencia

- Contraste de texto, bordes y foco; rojo de marca `#DC2626` separado de su variante de texto, amarillo con texto oscuro y hover oscuro legible. Se conservan crema, oliva, morado, marrón y superficies translúcidas.
- Contorno de foco de 3 px, margen de desplazamiento bajo la cabecera, enlaces con `tabIndex=0`, objetivos de botón de al menos 44 px y casillas de 24 px con etiquetas. Edición devuelve el foco al disparador y el movimiento en lote a un control estable.
- Tabla en región identificada/enfocable, `aria-sort` comprobado en ambos sentidos; diálogos con cierre en español, altura acotada y scroll interno; error de borrado en un único anunciador. Sin animaciones/transiciones con movimiento reducido.
- Nueva suite sobre el runner E2E y sus sesiones reales por formulario, fixture de datos ficticios y guard de red: páginas claras/oscuras, teclado, 320/375/768/1440 px y zoom equivalente a 200/400 %. Solo una dependencia directa nueva, `@axe-core/playwright@4.11.1`.

La definición y las excepciones están en [accesibilidad.md](../../../../accesibilidad.md); los pasos manuales, en [manual.md](../../../../../tests/accessibility/manual.md). Los JSON `*-light-*.json` y `*-dark-*.json` conservan resultados axe e incompletos; `*-contraste.json`, `*-reflujo.json`, `*-foco-movimiento-errores.json` y `*-teclado.json` acreditan las comprobaciones adicionales. Las capturas contienen únicamente datos ficticios. No se publican `storageState`, cookies, contraseñas ni traces con material de sesión.

## T6 · Perfil móvil de U-QA-03

Se importa el perfil original: Chrome estable, 390×844 CSS, DPR 3, táctil, CPU×4 y sin limitación de red, 10 000 libros/41 estanterías y dos contextos nuevos por pantalla. Cada contexto realiza navegación fría, caliente y caliente con los gestos originales. Se comprueba que no faltan gestos, no hay errores de consola y no hay tráfico externo. Entorno en [manifiesto.json](manifiesto.json), medidas en [t6-antes.json](t6-antes.json) y [t6-despues.json](t6-despues.json).

| Pantalla / métrica | Antes de esta unidad | Código final |
| --- | ---: | ---: |
| Estanterías, INP mediano | 216 ms | 136 ms |
| Estanterías, peor muestra INP | 232 ms | 136 ms |
| Estanterías, LCP frío mediano | 1 152 ms | 1 142 ms |
| Ficha, INP mediano | 104 ms | 124 ms |
| Ficha, peor muestra INP | 104 ms | 128 ms |
| Ficha, LCP frío mediano | 1 382 ms | 1 424 ms |
| CLS con gestos, ambas pantallas | 0 | 0 |

El diálogo baja un 37 % de INP mediano y todas sus muestras finales quedan por debajo de 200 ms. Los 496 ms del [informe anterior](../../../rendimiento/2026-10-23/informe.md) no se reprodujeron en el estado integrado inicial; no se atribuye a este cambio toda la diferencia con aquella medición histórica. No se afirma una mejora de ficha. Una [repetición previa](t6-repeticion-previa.json), antes de corregir el anuncio de error de renombrado, registró 144/176 ms en estanterías y 176/208 ms en ficha (mediana/peor): se conserva para mostrar la dispersión. Las cifras de dos contextos, con Docker/otros servicios en el mismo equipo, no son un percentil de campo ni un SLA.

El trace agregado del gesto aislado registra un mayor `EventDispatch` de 170,6 ms antes y 93,1 ms después, y un mayor `UpdateLayoutTree` de 36,1 y 20,7 ms. Son spans inclusivos, no tiempos sumables entre categorías. La corrección separa el estado del diálogo del listado, evita rerenderizar sus 41 tarjetas al abrir/escribir, pospone layout/pintura fuera de pantalla con `content-visibility:auto`, retira un blur redundante sobre tarjetas opacas y evita escalado de entrada del modal. El DOM y el árbol accesible se conservan. [t6-intermedio.json](t6-intermedio.json) registra el paso con aislamiento del estado antes de optimizar tarjetas; el antes/final usa el mismo dataset.

## Contraste y reflujo

Mínimos de las combinaciones medidas: texto 4,77:1 en claro y 4,71:1 en oscuro; foco/bordes de control 3,72:1 y 4,15:1. Incluye tarjeta al 80 %, estados de botón, colores de lectura, placeholder, error y bordes computados de controles, con composición alfa sRGB. Se verifica además el hover real en ficha. El contexto modal se explica en la documentación: el fondo inactivo bajo overlay se había medido como página activa antes de abrir, y se audita después el diálogo activo con todas las reglas.

Zoom emulado con referencia de 1280×1024: viewport CSS de 640×512 para 200 % y 320×256 para 400 %. Se comprueba que los controles enfocados del diálogo siguen dentro de su zona desplazable. No equivale al zoom nativo del navegador, que continúa en la lista manual. El scroll horizontal se limita a la región de tabla; no se oculta el desbordamiento del documento para hacer pasar la prueba.

## Comprobaciones y pendientes

[comprobaciones.json](comprobaciones.json): lint, typecheck, 322/322 unitarias, build y smoke (12 grupos), salida 0. Scripts: 233 superadas y dos omitidas por no estar disponible/acreditado `scratch`; los ocho ensayos de promoción sí se ejecutaron, sin `BIBLIB_SKIP_STACK_TESTS`.

`pnpm test:a11y:local --project chromium --project firefox --project webkit --reuse-build`: **30/30**, sin omisiones, fallos ni repeticiones, en [a11y.json](a11y.json). [axe-resumen.json](axe-resumen.json): 84 análisis, 72 contextos de página y 12 de modal, cero serious/critical; se conservan los moderate e incompletos para revisión. Tras el último ajuste del aviso de renombrado, [a11y-renombrado.json](a11y-renombrado.json) registra **9/9** (seis accesos de preparación y tres escenarios ampliados de diálogos). La suite completa y la repetición enfocada se registran por separado con fechas y alcance.

`pnpm test:e2e:local --reuse-build`: **40 superadas, 19 fixme heredados, cero fallos y cero repeticiones**, en [e2e.json](e2e.json). Los fixme corresponden a otras unidades; no se han activado ni dado por superados aquí. El aviso de renombrado se corrigió después de esta regresión general y queda cubierto por la repetición enfocada anterior.

NVDA/Narrator, VoiceOver móvil, Safari/iOS, Safari/macOS, Edge interactivo, Firefox interactivo y zoom nativo: **pendientes**, con pasos exactos en el manual. Playwright Chromium/Firefox/WebKit no los sustituye. Login conserva los moderate `landmark-one-main` y `region` por carecer de `main`; fuera de la propiedad de esta ola, se entrega al coordinador. Los avisos CSP Report-Only de Firefox/WebKit quedan documentados para U-OPS-04 sin aplicar ni debilitar la política. Ajustes y restauración/exportación no se modificaron ni se incluyen en la auditoría axe de esta unidad, por propiedad de U-DAT-04; la regresión E2E general sí conserva sus escenarios existentes.

Un ensayo de navegador falló al consultar la propiedad Docker mientras otras comprobaciones creaban/eliminaban contenedores efímeros; se repitió separado, sin desactivar guardas ni añadir reintentos automáticos. Los resultados finales exigen cero repeticiones dentro del run.

## Estado final y recursos

La cuenta de escala y sus 10 000 libros se retiraron con `pnpm perf:local:cleanup --profile test`. `pnpm db:local:down --profile test` terminó con salida 0; Postgres, Auth, REST, Storage, Studio y Mailpit quedaron parados. [recursos-docker.json](recursos-docker.json) acredita cero contenedores `test` activos y conserva únicamente la red `biblib-test-network` y los volúmenes `supabase_db_biblib-test` y `supabase_storage_biblib-test`. No se levantó `scratch` ni se modificaron recursos de HolaERP.

## Incidencia adicional autorizada: promoción/restauración

El coordinador autorizó el 24-10-2026 una corrección aislada de `tests/scripts/promotion-harness.mjs`: creación idempotente de `anon`, ya presente en `tests/db/bootstrap.sql`. Commit `281536a`. La primera ejecución completa de `pnpm test:scripts` canceló los ocho casos de promoción por el rol duplicado; tras ese cambio pasaron siete y el caso 7 detectó una diferencia de representación del check de vistas guardadas.

Antes de corregirla, un ensayo con **dos Postgres efímeros propios**, migraciones hasta `0007`, datos sintéticos, `pg_dump` y restauración identificó **una única diferencia**, en `constraints`, objeto `biblib.saved_book_views.saved_book_views_name_check`:

Antes del dump, `pg_get_constraintdef` devuelve:

```sql
CHECK ((((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 80)) AND (name = btrim(name))))
```

Después de restaurar el mismo dump devuelve:

```sql
CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 80) AND (name = btrim(name))))
```

Son los mismos tres predicados conjuntivos, con una agrupación redundante diferente; nombre, tabla, tipo, validación, columnas y restantes hechos son idénticos. El ledger y el manifest pasan. El coordinador autorizó normalizar **solo** esta representación concreta, sin excluir objetos ni relajar diferencias semánticas. La comparación conservará todos los checks/grants/políticas/índices y cualquier otra diferencia textual.

Se conserva como representación canónica la que produce la migración, para mantener las huellas de los respaldos ya creados directamente desde ella; solo se transforma la cadena exacta producida tras restaurar. No se aplica un borrado general de paréntesis.

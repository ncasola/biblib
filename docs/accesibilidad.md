# Accesibilidad de BibLib · U-EXP-03

Evaluación incremental del 24 de octubre de 2026, sin certificación WCAG. Evidencia en [O11/exp-03](validacion/2026-10-24/O11/exp-03/); pasos de lectores, dispositivos y navegadores reales en [manual.md](../tests/accessibility/manual.md). Los pendientes manuales son explícitos y no se consideran superados por ejecutar Playwright.

## Reproducción

```powershell
pnpm db:local:bootstrap --profile test
pnpm test:a11y:local
pnpm test:a11y:local --project firefox --project webkit --reuse-build
pnpm test:e2e:local --reuse-build
node tests/accessibility/performance.mjs antes
# Aplicar la corrección que se quiere comparar; cada medición recompila.
node tests/accessibility/performance.mjs despues
pnpm perf:local:cleanup --profile test
pnpm db:local:down --profile test
```

`test:a11y:local` usa el mismo runner E2E: acredita perfil/ledger/bundle, inicia la app compilada, bloquea tráfico externo, obtiene sesiones por el formulario local y limpia los datos marcados del run. Solo añade una configuración de Playwright con `@axe-core/playwright@4.11.1` fijado; no introduce accesos alternativos a la app. Los informes de axe incluyen todas las reglas por defecto; `serious`/`critical` fallan la suite. También se conservan `minor`, `moderate` e incompletos para revisión. Las páginas se analizan completas y los modales dentro de su contexto activo, como se justifica abajo.

## Cobertura y método

La detección cubre inicio, colección en tabla/cuadrícula, búsqueda avanzada, alta ISBN/manual, ficha, edición, confirmación de borrado, estanterías, Nueva estantería, 3D, perfil y login con error OAuth en ambos temas. Chromium es Chrome instalado en el equipo; Firefox y WebKit son los motores distribuidos por Playwright 1.64.1. Ninguno equivale a una prueba con NVDA, Narrator o VoiceOver; WebKit tampoco equivale al Safari de iOS/macOS.

El recorrido de teclado usa Tab/Shift+Tab, flechas, Espacio, Enter y escritura; no usa clics, `focus()`, `fill()` ni `selectOption()` para completar las acciones de producto. Comprueba alta, búsqueda, selección y movimiento en lote, edición y cierre de sesión; foco inicial/retorno en edición y diálogos; contención del foco; menú móvil con Escape; orden accesible de tabla; un único nodo de alerta ante ISBN inválido y conflicto de borrado. Que exista un único nodo vivo no demuestra por sí solo la locución de un lector real.

El reflujo recorre las rutas y estados a 320, 375, 768 y 1440 píxeles CSS en ambos temas, sin ocultar overflow del documento. La única excepción permitida es la tabla dentro de una región con nombre y `tabIndex=0`. El zoom se emula reduciendo el viewport CSS de referencia 1280×1024 a 640×512 (200 %) y 320×256 (400 %); verifica layout/reflujo, no rasterización ni interfaz nativa de zoom del navegador. DPR no se usa como zoom. Se comprueban diálogos en pantalla baja y movimiento reducido con `emulateMedia`.

El contraste se calcula en sRGB con luminancia relativa y composición alfa real de colores CSS computados, incluidos `bg-card/80`, primario al 90 %, secundario al 80 %, destructivo al 90 %, selección, error, placeholder y navegación activa. Para superficies uniformes, el desenfoque no cambia el color compuesto. Axe examina también el login, pero deja incompletos de contraste sobre su degradado: no se presentan como aprobados ni como una medición punto a punto de imágenes/gradientes arbitrarios. El umbral automatizado es 4,5:1 para todo el texto de muestra (también los títulos grandes) y 3:1 para borde de controles y contorno de foco sobre fondo, tarjeta, superficie y entrada. El rojo de marca `#DC2626` se conserva y el texto usa un rojo más oscuro en claro y más luminoso en oscuro; el amarillo de acento lleva texto oscuro.

## Límites y excepciones

No se desactiva ninguna regla axe ni se admite una violación serious/critical. Los resultados incompletos requieren revisión manual; no cuentan como una aprobación automática. Los textos y adornos de lomos 3D están ocultos al árbol accesible y cada enlace expone título/autor/estado mediante su nombre, con alternativa 2D visible; la lectura visual minúscula en la representación decorativa no sustituye a la ficha.

El resumen de 84 auditorías conserva 24 apariciones de `color-contrast` incompleto (solapamiento de la escena 3D, flecha decorativa de orden, descripción del diálogo y degradado de login) y 12 de `aria-valid-attr-value` (disparadores Radix cerrados cuyo `aria-controls` apunta al diálogo aún sin montar). Se verifica automáticamente el diálogo abierto; revisar esos nodos con lector y contraste visual sigue pendiente. No se cuenta un resultado incompleto como una violación inexistente ni como un cumplimiento demostrado.

**Contexto de modales.** La ficha y las estanterías se analizan completas antes de abrir el diálogo; después axe analiza el `dialog`/`alertdialog` activo con todas sus reglas. El fondo `aria-hidden` y bloqueado por el modal se excluye de esa segunda medición: el overlay atenúa contenido inactivo. WebKit detectó 1,84:1 en el disparador «Eliminar libro» del fondo, con transición de hover y overlay; no era el botón del diálogo. La revisión también corrigió el hover oscuro de botones outline/ghost y lo verifica con el puntero real sobre la ficha activa. Se conserva evidencia de la página activa y del modal; la contención/retorno de foco se prueba aparte y el JSON identifica su alcance.

La pantalla de login heredada carece de landmark `main`; axe informa `landmark-one-main` y `region` con impacto moderate. Está fuera de la propiedad de edición de esta ola y se entrega al coordinador para corregir la estructura, sin excluir las reglas ni convertir esos resultados en una aprobación del marcado. Los resultados JSON conservan los nodos exactos.

Dos excepciones estrechas del **guard de consola**, independientes de axe y anotadas en Playwright, permiten ejecutar los motores con la CSP informativa de U-OPS-04: WebKit avisa de `Report-Only` sin `report-to`; Firefox informa de un `eval` del runtime propio `/_next/static/chunks/` que una futura CSP aplicada rechazaría. Se admiten solo las firmas concretas de aviso Report-Only de cada motor y origen local; las excepciones JavaScript, CSP aplicada, otros orígenes y demás errores siguen fallando. Son pendientes de U-OPS-04 antes de aplicar CSP; no se añade `unsafe-eval` ni se cambia la política. WebKit 27.2 también resolvía `fill()` de Correo dejando longitud cero: el helper E2E escribe teclas reales y conserva el formulario y GoTrue reales.

En este WebKit de Windows, Tab omitía enlaces sin `tabIndex` y sí recorría los declarados con cero, comprobado con una página mínima aislada. Los enlaces de acción/navegación de los componentes revisados declaran `tabIndex=0`, conservando semántica de enlace y orden del DOM, sin índices positivos ni llamadas de foco desde la prueba. Apple documenta una [preferencia de WebKit para tabular enlaces](https://developer.apple.com/documentation/webkit/wkpreferences/tabfocuseslinks); esto no acredita la configuración ni la experiencia del Safari real pendiente. Al desaparecer la barra de movimiento en lote, el foco vuelve a seleccionar página (o al buscador si el filtro queda vacío).

Los controles deshabilitados conservan su estado semántico y pueden tener menor contraste visual; son componentes inactivos, excepción de contraste de WCAG, y no se usan para comunicar por sí solos errores o instrucciones. El foco no aparece en controles deshabilitados. La auditoría no cubre todos los estados posibles de proveedores externos ni Google OAuth real.

`app/settings/page.tsx`, las acciones, el schema y los componentes de restauración/exportación pertenecen a U-DAT-04 en esta ola. No se modifican aquí; cualquier hallazgo de Ajustes se entrega al coordinador en el informe de evidencia.

Los ensayos manuales de NVDA/Narrator, Edge interactivo, Firefox interactivo, Safari/macOS y Safari/iOS con VoiceOver permanecen **pendientes** hasta su ejecución real. No se certifica WCAG.

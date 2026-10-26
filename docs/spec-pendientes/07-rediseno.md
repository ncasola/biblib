# Rediseño visual y estantería 3D

**Versión:** 1.0 · **Fecha:** 25 de octubre de 2026 · **Origen:** petición de Néstor: «ahora se ve plano y soso; quiero un nuevo diseño» y «la estantería 3D no se ve como una estantería 3D de verdad».

Esta petición cambia dos exclusiones de [03](03-experiencia-y-funciones.md):

- **«Rediseño integral»:** pasa a estar en alcance.
- **U-EXP-04:** «no requiere motor 3D nuevo». La escena 3D se rehace, pero sigue **sin dependencias**: CSS 3D y un poco de JS.

Se mantienen sus contratos:
- la alternativa 2D visible;
- teclado y lector de pantalla;
- reducción de movimiento;
- el máximo de 48 libros por página;
- ningún dato de todo el catálogo en el cliente.

**Prototipo aprobado:** el lienzo «BibLib · Rediseño», con los artboards «Estantería 3D nueva» y «Dirección A · Biblioteca nocturna». Fuentes del prototipo: `docs/diseno/prototipo/` (formato `.dc.html` del lienzo; referencia visual, no código de la app).

## Decisiones de Néstor (25-10-2026)

- **Dirección A · Biblioteca nocturna:**
  - Fondo oscuro cálido, nogal y latón.
  - Tipografías Fraunces (titulares) e Inter (texto).
  - Rojo de acción y acentos de estado.
  - El tema claro es la versión crema de la misma dirección, no otra dirección distinta.
- **Estantería 3D en CSS 3D, sin dependencias:**
  - Un mueble con fondo, laterales, cornisa, zócalo y baldas con grosor.
  - Libros como cajas con lomo, tapas y canto de páginas.
  - El libro asoma al pasar el puntero o el foco.
  - Al seleccionarlo, sale de la balda y gira para enseñar la portada, junto a una ficha lateral.
- **Ejecución en paralelo con O14.**
- **Logo:** las variantes sin fondo (`public/logo-transparent.png`), para oscuro (`public/logo-dark.png`) y solo el personaje (`public/logo-mark.png`) se generan con `scripts/brand/logo-variants.mjs` (`29bde61`).

## Unidades

| Unidad | Alcance | Ola |
| --- | --- | --- |
| **U-UX-01** Sistema visual «Biblioteca nocturna» | Tokens de color, tipografía y espaciado en ambos temas; fuentes autoalojadas; cabecera y navegación; tarjetas, botones, formularios, tablas, diálogos y estados vacíos; todas las pantallas; `AGENTS.md` actualizado | O14 (en paralelo) |
| **U-UX-02** Estantería 3D realista | `components/shelf-viewer-3d.tsx` y `/shelves/3d` según el prototipo, con selección accesible, retorno contextual y alternativa 2D | O14 (en paralelo) |

## Aceptación común

- **Accesibilidad:** contraste AA en ambos temas. El grupo de accesibilidad (`tests/accessibility/`, U-EXP-03) sin violaciones serious ni critical.
- **Responsivo y movimiento:** 320, 375, 768 y 1440 px sin scroll horizontal; `prefers-reduced-motion` respetado.
- **Comportamiento:** los nombres accesibles y los roles de los E2E solo cambian cuando cambia la interacción, y en ese caso se actualiza la prueba correspondiente.
- **Build sin red:** ninguna fuente ni recurso se carga de terceros en tiempo de ejecución.
- **Comprobaciones:** `pnpm lint`, `typecheck`, `test`, `test:scripts`, `build`, `test:smoke`, `test:e2e:local` y la integración en verde.

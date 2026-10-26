# U-EXP-04 · Vista 3D accesible y alternativa equivalente

Fecha: 23-10-2026. Rama: `u-exp-04`, basada en `feature/spec-pendientes` (`51c228b`). Se revisó y completó el trabajo parcial del worker anterior.

## Implementación

- Escena CSS estática: se retiraron la ayuda de arrastre/clic derecho/zoom y las transformaciones por hover. Se conservaron y ampliaron los enlaces reales existentes de cada libro. La interacción consiste en elegir estantería, cambiar de página y abrir la ficha.
- Cada libro es un enlace de Next que genera un `<a href="/book/...">` real, con nombre accesible (título, autoría y acción), foco visible y anchura táctil de 44 px. `buildBookDetailHref` valida `?from=` mediante el contrato de U-EXP-01. El retorno conserva estantería, página y ancla del libro; se recupera el foco del lomo tras cargar su página.
- La URL de `/shelves/3d` conserva `shelf` y `page`; se interpreta también al volver con atrás/adelante. Una estantería inexistente cae a la primera disponible y las páginas fuera de rango se corrigen con la respuesta del servidor. Las respuestas obsoletas se descartan al cambiar la selección.
- Se mantiene `listBooksAction` con filtro por estantería, orden `title`, máximo 48 y paginación del servidor. El visor también recorta defensivamente a 48 libros. No se descarga el catálogo completo. Alturas entre 125 y 220 px, con repisas que permiten envolver los libros en pantallas estrechas.
- «Ver en la colección» genera `/books?shelf=<uuid>&page=<n>&pageSize=48` (omite página 1). El cambio mínimo de `components/books-table.tsx` permite ese tamaño validado, lo usa en consulta/recuentos y lo conserva en el retorno desde la ficha. Ambas vistas usan los mismos filtros, orden y tamaño de página.
- `aria-live="polite"`, atómico, anuncia estantería y página; una estantería vacía se anuncia sin numeración ficticia. Carga, error con reintento y vacío son ramas distintas de la escena normal. El error no conserva una escena que pueda confundirse con resultados actuales.
- Las portadas ausentes o que fallen muestran el fallback `/default-book-cover.webp` y un título visible. Se mantiene el nombre accesible aunque exista portada. La paleta vintage usa tinta clara/oscura según luminancia; los fallbacks usan los tokens de tarjeta de cada tema.
- La entrada decorativa se anima solo con `prefers-reduced-motion: no-preference`; se conserva la regla global existente de reducción del movimiento. En `app/globals.css` solo se añadió el bloque propio del visor, sin cambiar tokens.

## Validación ejecutada

| Comando | Resultado real |
| --- | --- |
| `pnpm lint` | Exit 0. |
| `pnpm typecheck` | Exit 0; generación de rutas y TypeScript correctos. |
| `pnpm test` | Exit 0; 142 pruebas, 142 correctas, 0 fallos. Incluye 11 pruebas nuevas del visor. |
| `pnpm test:scripts` | Exit 0; resumen del runner: 147 pruebas, 145 correctas, 2 omitidas, 0 fallos. Las pruebas que necesitan un stack acreditado se omiten; no se arrancó `scratch`. |
| `pnpm build` | Exit 0; Next.js 16.4.2, Turbopack, ruta `/shelves/3d` generada. `BIBLIB_TARGET=test`, `BIBLIB_PROFILE=test`, modo bibliográfico `fixture`, Analytics apagado y placeholders de CI en loopback (API 55331, DB 55332); salida `.next-test`. No se leyeron archivos privados de entorno. |
| `pnpm test:smoke` | Exit 0; los 12 grupos existentes pasan, incluido móvil/oscuro del login y exportación de 2001 libros. **El harness actual no visita `/shelves/3d`**; este resultado no acredita el recorrido del visor. |
| `git diff --check` | Sin errores de espacios. |

Las pruebas puras comprueban los límites 0/1/47/48/49/96/97, corrección de página, recorte defensivo del visor, generación/lectura de URLs, igualdad de la consulta 3D con la selección 2D y de sus IDs en tres páginas de una estantería de 97 libros, alturas, repisas, nombre accesible, fallback, contraste ≥4,5:1 en la paleta y retorno validado con ancla. Esa equivalencia prueba el contrato puro; no sustituye una comparación en navegador con datos reales.

Artefactos del smoke existentes en esta máquina: `C:\Users\ncaso\AppData\Local\Temp\biblib-smoke-results-1792774204381` (fuera de Git; solo fixtures ficticios). No se incorporaron capturas ni datos personales al repositorio.

## Recursos y límites

No se modificaron schema, migraciones, proveedores bibliográficos, dependencias, lockfile ni `tests/e2e/**`. No se conectó a producción ni se alteraron recursos de HolaERP. El coordinador autorizó expresamente el Postgres efímero del harness smoke (`biblib-smoke-<uuid>`) como excepción al trabajo sin Docker; el harness ejecutó su limpieza y la consulta final por etiqueta `biblib.test=smoke` no devolvió contenedores. No se dejan contenedores, redes ni volúmenes creados por esta unidad; no se levantó ningún perfil Supabase.

## Recorrido pendiente para U-QA-02 / U-EXP-03

1. Emular dispositivo táctil a 320 y 375 px, en claro y oscuro, con una estantería vacía y otra de al menos 97 libros. Tocar una estantería y «Siguiente», abrir un libro y volver; comprobar página, foco y ancla, también con atrás/adelante y recarga.
2. Repetir solo con Tab/Mayús+Tab/Enter, revisar foco visible y comprobar que cada lomo sigue siendo un enlace real abrible en otra pestaña. Verificar el anuncio de estantería/página con lector de pantalla y los estados de carga, fallo y reintento con red demorada/interrumpida.
3. Comparar los IDs del DOM y de las peticiones de las páginas 1, 2 y 3 del visor con «Ver en la colección», comprobando `pageSize=48`, orden y retorno desde la ficha 2D.
4. Forzar fallo de una portada y título largo; comprobar título fallback, reflujo y objetivos táctiles. Activar movimiento reducido y comprobar que no hay entrada decorativa ni gestos de giro/zoom de escena. Medir contraste renderizado y foco en ambos temas; las pruebas de luminancia de la paleta no certifican todos los píxeles de la interfaz.

La implementación está preparada para integrar; estos recorridos de navegador/dispositivo quedan explícitamente pendientes y no se presentan como ejecutados.

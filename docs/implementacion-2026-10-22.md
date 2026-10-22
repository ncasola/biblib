# Mejoras aplicadas a BibLib — 22 de octubre de 2026

Trabajo coordinado con tres subagentes simultáneos como máximo, uno de ellos Luna para tareas de interfaz acotadas. Se han integrado cambios de seguridad, datos, catalogación, importación e interfaz sobre el repositorio existente. Por petición del propietario, se conservan únicamente el JSON y el SQL de 111 libros como semilla en `tests/fixtures/library/`; se han eliminado las fotografías y los materiales intermedios de importación.

La [auditoría original](auditoria-2026-10-22.md) describe el estado anterior. Este documento distingue las correcciones implementadas de las ampliaciones y verificaciones externas que siguen pendientes.

## Cambios de uso diario

- Alta manual y por ISBN con ficha revisable, autores/editoriales por filas, estado y estantería antes de guardar.
- Edición completa desde el detalle, cambio de ubicación, actualización de portada y eliminación confirmada.
- Protección frente a fichas desactualizadas: las operaciones individuales comprueban una versión renovada por Postgres; el editor conserva el borrador ante conflictos y ofrece recarga explícita.
- Identificación de ISBN-10/13 equivalentes, detección de duplicados y enlace al libro ya catalogado.
- Procedencia bibliográfica y verificación explícita de la edición física. La portada no acredita esa verificación.
- Colección en tabla/cuadrícula, filtros en URL, búsqueda sin tildes y por ISBN, paginación real en servidor y movimiento por lotes.
- Importación con revisión sin escrituras, fusión inicial por defecto, confirmación de reemplazo, copia reciente, formato versionado y resultado de portadas.
- Exportación dividida automáticamente en partes importables según bytes UTF-8, libros y estanterías, incluidas las vacías; descarga individual e instrucciones de restauración.
- Recuperación de portadas pendientes desde Ajustes, con progreso por lotes, pausa y continuación en la página; revalidación de versión, ISBN y portada antes de guardar.
- Inicio con lecturas en curso e incorporaciones recientes; perfil con persistencia real en Auth.
- Tema global, enlaces y controles accesibles, colores de texto para ambos temas y movimiento reducido. Filtros de colección plegables en móvil.
- Vista 3D con enlaces al detalle, teclado, alturas limitadas y páginas de hasta 48 libros; ayuda coherente con sus funciones reales.

## Correspondencia con la auditoría

| Hallazgos | Implementado | Alcance pendiente |
| --- | --- | --- |
| SEC-01 | Next 16.4.2, React/React DOM 19.3.1, lockfile coherente, pnpm fijado, overrides de paquetes afectados y eliminación de dependencias sin uso. | Mantener actualizaciones y comprobar el despliegue real. Los avisos de peers de un binding WASM opcional de ESLint no impiden los checks locales. |
| SEC-02 | Destinos internos validados, callback con redirección relativa y error OAuth visible. | Ensayo con Google real en el entorno publicado. |
| SEC-03 | Validación runtime compartida, límites de campos, UUID, estado, páginas, ISBN y portada HTTPS. | Ampliar los contratos si se introducen nuevas funciones. |
| SEC-04 | FK compuesta de propietario, RLS reforzado para predeterminada y pruebas de dos usuarios. | Aplicar la migración revisada a la base de destino. |
| SEC-05 | Inicio y detalle protegidos, destino con consulta conservado y cookies renovadas propagadas. | Renovación real de sesión con Supabase/Google del despliegue. |
| BE-01 | Cliente Postgres reutilizado, pool limitado, timeout, TLS remoto y transacciones tipadas. | Medir conexiones y latencia bajo carga del alojamiento. |
| BE-02 | Inserción de predeterminada con resolución de conflicto; bloqueo de escrituras por usuario. Token de versión por libro y escrituras individuales condicionales, con borrador conservado ante conflicto. | Monitorizar la concurrencia real. El reemplazo completo de una colección sigue siendo una operación confirmada sobre el estado existente al ejecutarse, sin comparación con la revisión anterior. |
| BE-03 | Agregados para inicio/estanterías, detalle individual y listados paginados con orden estable. Exportación/importación usan la lectura completa cuando necesitan comparar o respaldar la colección. | Pruebas de rendimiento con colecciones grandes y métricas en producción. |
| BE-04 | ISBN canónico, schema de proveedor, timeout, caché acotada, deduplicación, control de frecuencia y errores 400/404/429/503. Búsqueda autenticada. | Caché y cuota globales si se despliega en varias instancias; la implementación actual es por proceso. |
| BE-05 | Utilidades de identidad y base en módulos internos `server-only`; ninguna acción toma un propietario del cliente. | Mantener esta regla en nuevas acciones. |
| BE-06 | Libro persistido en la respuesta, filas afectadas comprobadas y errores esperados serializados como `ActionResult`. | API adicional solo cuando existan consumidores que la necesiten. |
| IMP-01 | Selección → validación → revisión → modo → confirmación → resultado, con fusión por defecto y copia previa disponible. | Recuperación automática de versiones anteriores o deshacer persistente. |
| IMP-02 | Límites de 8 MiB/2000 libros/200 estanterías por archivo, inserciones por lotes, presupuesto de portadas de 20 s y resumen. Recuperación posterior de portadas por lotes con pausa y progreso. | Cola persistente/reanudación tras cerrar la página y transacción única para restaurar varios archivos. No se presenta el flujo actual como trabajo en segundo plano. |
| IMP-03 | Formato v1 con fecha, compatibilidad legacy, referencias validadas y conservación de IDs reconocidos de la misma cuenta. Fragmentación automática de exportaciones grandes y snapshots de Drizzle incorporados. | Restauración conjunta de todas las partes sin selección y confirmación individuales. |
| IMP-04 | ISBN normalizado y procedencia/verificación persistidas e incluidas en exportación. | Modelo separado de obra, edición y ejemplar; ISBN nullable independiente del identificador manual legacy. |
| UX-01/02 | Edición, ubicación en alta/detalle, tarjetas con contenido filtrado y movimientos múltiples. | Nuevas funciones de colección física del roadmap. |
| UX-03 | Nombre guardado en Supabase Auth, correo informativo de Google y retirada de cámara ficticia. | Avatar propio si se decide implementarlo. |
| UX-04 | Errores recuperables, estados pendientes y mensajes de mutación en español incluso en producción. | Pruebas adicionales de desconexión y sesiones reales. |
| UX-05/06 | Catálogo compartido, filtros/vista/página en URL, totales correctos y cero resultados explícito. | Conservar posición exacta de scroll y vistas guardadas. |
| UX-07/08 | Predeterminada protegida en UI/base; alta revisable, enlace de duplicado y alternativa manual. | Alta consecutiva optimizada según uso real. |
| UX-09 | Visor accesible con enlaces, páginas y ayuda honesta. | Rotación/zoom reales solo si aportan valor; no se anuncian como disponibles. |
| UI-01/02/03 | Jerarquía de inicio, tokens completos, contraste de paleta revisado, etiquetas, teclado, ordenación semántica y movimiento reducido. | Revisión exhaustiva con lector de pantalla, zoom y todos los estados de contraste. No es una certificación WCAG. |
| FE-01 | Tema global con render estable; navegador sin errores de hidratación en el recorrido aislado. | Comprobar navegadores adicionales. |
| FE-02 | Componente compartido de portada sin recorte, fallback, recuperación individual y recorrido de pendientes por lotes. | Optimización/copia de imágenes: sigue `unoptimized` y se respeta la política existente de scripts de `sharp`. |
| FE-03 | Navegación activa, títulos por sección, filtros persistidos y límite de error de ruta. | Extraer una estructura común adicional si reduce duplicación sin aumentar el estado cliente. |
| FE-04 | Retirada persistencia antigua de dominio en localStorage y dependencias `three`/TanStack sin consumidores. | Revisar componentes UI opcionales antes de añadir funciones. |
| QA-01/02 | Tipos obligatorios, adaptadores UI compatibles, CI, pruebas unitarias, migraciones/RLS y navegador aislado. `db:generate` comprueba que no quedan cambios de schema por generar. | Ejecutar CI remoto y validar actualización sobre una copia del proyecto Supabase real. |
| OPS-01 | Eliminados logs bibliográficos completos; errores de base y mutaciones con registros sin contenido privado. | Alertas, trazas, Core Web Vitals y objetivos de rendimiento en el alojamiento. |
| OPS-02 | Guía de respaldo/restauración y archivos privados; Analytics desactivado salvo habilitación explícita. | Eliminación de cuenta, política de retención y ensayo administrativo del backup real del proveedor. |

## Validación

| Comprobación local | Resultado |
| --- | --- |
| Instalación con lockfile congelado | Correcta. |
| Lint | Correcto, sin errores. |
| TypeScript | Correcto; la compilación ya no omite los errores. |
| Pruebas unitarias | 50/50 correctas. |
| Postgres 17 aislado | Migraciones, RLS, integridad y rollback correctos. |
| Build de producción | Correcto con Next 16.4.2. |
| Auditoría de dependencias de producción | Sin vulnerabilidades conocidas en la consulta realizada. |
| Navegador aislado | 12 grupos correctos, incluidos conflicto de edición, descarga JSON, exportación de 2001 libros en dos partes y recuperación sin ISBN sin peticiones externas. |

Los comandos reproducibles están en el README. Las pruebas SQL crean su propio Postgres Docker y no usan `.env.local`. El navegador construye una aplicación temporal sin `.env`, con Auth simulado y base efímera; bloquea solicitudes externas. Su informe y capturas de datos ficticios están en [validación de navegador](validacion-2026-10-22/navegador.json).

La continuación dispone de un [informe actualizado de 12 grupos](validacion-2026-10-22/continuacion/navegador.json), capturas de [exportación por partes](validacion-2026-10-22/continuacion/exportacion-partes.png), [recuperación de portadas](validacion-2026-10-22/continuacion/portadas-pendientes.png) y [colección móvil](validacion-2026-10-22/continuacion/coleccion-movil.png). La prueba descarga los dos JSON, verifica 2001 IDs únicos, referencias a estanterías, recuentos y límites; incluye estanterías vacías. La consulta con respuestas de portadas y las carreras con cambios manuales se verifican mediante pruebas unitarias simuladas; el recorrido de navegador no consulta Open Library real.

- Pruebas unitarias: validación bibliográfica, importación, proveedor simulado, navegación segura, filtros y transporte de errores de dominio.
- Pruebas SQL: actualización desde datos legacy, aislamiento de dos usuarios, referencias ajenas, predeterminada, restricciones, rollback, contexto de transacción, invalidación de versiones y restauración del mismo ID sin reutilizar tokens.
- Navegador: acceso, callback seguro, tema oscuro/móvil, alta, edición, estado, ubicación, duplicados ISBN, revisión y fusión de importación, eliminación confirmada y perfil persistido en Auth de prueba.
- Contrastes de texto comprobados sobre fondos de paleta: claro mínimo 4,96:1; oscuro mínimo 5,59:1 entre las muestras revisadas. Los botones principales revisados superan 7:1. Las transparencias y estados de todo el producto requieren una revisión completa adicional.

## Antes de usar este código con la base existente

La aplicación espera `catalogue` y las restricciones de `drizzle/0001_library_integrity.sql`, además de `version` y el trigger de `drizzle/0002_book_versions.sql`. Ambas migraciones se han preparado y ensayado en un contenedor; **no se han aplicado a Supabase real**. Revisar datos anteriores, preparar respaldo y aplicar los SQL pendientes mediante el procedimiento de [operación](operacion.md#migraciones-y-recuperación) antes de publicar esta versión.

No se ha cargado la biblioteca personal en una cuenta ni publicado el sitio. Escáner, notas, progreso por páginas, préstamos, series y consulta offline siguen como ampliaciones de producto del roadmap.

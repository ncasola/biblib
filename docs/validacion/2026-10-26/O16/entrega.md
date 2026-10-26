# Lista de entrega de O16 · U-QA-05

**Fecha:** 26 de octubre de 2026 · **Rama:** `u-qa-05` · **Fuente:** [05 · O16](../../../spec-pendientes/05-fases-olas-y-trazabilidad.md#o16--revalidación-final-y-auditoría) y [Puerta G16](../../../spec-pendientes/05-fases-olas-y-trazabilidad.md).

**Etiquetas:**
- **hecho localmente**, con evidencia;
- **pendiente externo**, con alcance y responsable;
- **diferido con decisión**.

Un punto puede tener partes con etiquetas distintas: cada parte figura por separado. El coordinador ejecuta en el perfil `test` la revalidación E2E, a11y e integración completa de G16 y anota aquí sus resultados ([§ Revalidación del coordinador](#revalidación-del-coordinador-perfil-test)).

## Estados de cierre

| Cierre | Estado | Qué significa |
| --- | --- | --- |
| **Cierre de código (local)** | **Alcanzado**, con un ensayo manual pendiente (lector de pantalla, UI-03). Revalidación del coordinador en `test` anotada ([G16](g16-coordinador.md)). | Los 35 hallazgos tienen implementación verificada con servicios reales locales y evidencia enlazada ([matriz](matriz-auditoria.md)). Instalación limpia, migración desde la versión previa, respaldo y restauración, y benchmark repetidos en `scratch` ([informe](qa-05/informe.md)). |
| **Cierre de despliegue (remoto)** | **Pendiente.** | No existe preproducción. Producción no se ha inspeccionado ni tocado. Nada remoto se ha verificado y ninguna casilla remota se marca con un mock. Responsable: Néstor (usuario). |

## Puntos 1–7

| # | Punto de la lista | Parte | Etiqueta | Evidencia o alcance | Responsable |
| --- | --- | --- | --- | --- | --- |
| 1 | Instalación limpia, reconstrucción local, migración desde la versión previa y adopción remota; comparar el catálogo de objetos DB, no solo las tablas. | Instalación limpia (`pnpm install --frozen-lockfile` en un clon nuevo), lint, tipos, `test` y `test:scripts` | **hecho localmente** | [qa-05/00-install-limpio.log](qa-05/00-install-limpio.log), [informe §1](qa-05/informe.md#1-instalación-limpia) | U-QA-05 |
| | | Reconstrucción desde volúmenes vacíos (`db:reset:local` → bootstrap completo, head `0015`) | **hecho localmente** | [qa-05/04-reset-apply.txt](qa-05/04-reset-apply.txt), [qa-05/05-reset-apply-continuacion.txt](qa-05/05-reset-apply-continuacion.txt), [qa-05/06-status-limpio.txt](qa-05/06-status-limpio.txt) | U-QA-05 |
| | | Migración desde el esquema previo a la spec (`0002`, idéntico a `main`) con datos → `0015`, y comparación del catálogo completo (tablas, columnas, restricciones, índices, vistas, funciones, triggers, políticas, grants y buckets) frente a la instalación limpia | **hecho localmente** | [informe §2](qa-05/informe.md#2-instalación-limpia-y-migración-desde-la-versión-previa), [qa-05/catalogo.mjs](qa-05/catalogo.mjs) | U-QA-05 |
| | | Adopción y migración en preproducción y producción | **pendiente externo** | Preproducción no existe. Requiere autorización, ref real, plan del proveedor y respaldo ensayado del destino ([promoción](../../../promocion.md)). Los comandos están preparados y ensayados contra un Postgres efímero con TLS ([O08/inf-07](../../2026-10-23/O08/inf-07/informe.md)). | Néstor |
| 2 | Integración y E2E con navegadores; lector, zoom, móvil y ambos temas; sin errores JS ni de hidratación ni éxitos falsos. | Recorrido HTTP con sesiones GoTrue reales A/B (13 rutas) y redirección anónima | **hecho localmente** | [qa-05/07-acceso-app.json](qa-05/07-acceso-app.json) | U-QA-05 |
| | | Bordes de paginación 0/1/10/11 y filtro desde página posterior (UX-06) en la app real con Chrome | **hecho localmente** | [qa-05/22-paginacion.json](qa-05/22-paginacion.json) | U-QA-05 |
| | | Integración completa, E2E (Chromium, Firefox, WebKit) y a11y en el perfil `test` | **hecho localmente** | [G16](g16-coordinador.md): integración 291/291 ×2, E2E Chromium completo, Firefox 82/82 y WebKit 79+9 por separado tras [O16-XB](xb/informe.md) (omisiones de motor inventariadas), a11y 10/10. El tercer run completo de los tres navegadores se interrumpió por memoria y el usuario dio por buenos los runs. | Coordinador |
| | | Lector de pantalla, Safari macOS/iOS, Edge y dispositivos móviles reales | **pendiente externo** (ensayo manual) | `tests/accessibility/manual.md`, [accesibilidad](../../../accesibilidad.md). No se afirma ninguna prueba inexistente. | Néstor |
| 3 | Benchmark final y comparación con G09: cambio de modelo, restauración, conexiones, workers y límites globales. | `perf:local` 100/1 000/10 000 en `scratch` y comparación con G09 | **hecho localmente** | [qa-05/rendimiento/informe.md](qa-05/rendimiento/informe.md) | U-QA-05 |
| | | Rendimiento con datos, red y alojamiento reales | **pendiente externo** | Las cifras locales no son un SLA. | Néstor |
| 4 | Google OAuth y renovación reales, cabeceras y caché del alojamiento, checks externos de proveedores habilitados con presupuesto mínimo. | Google OAuth real y su renovación | **pendiente externo** | Necesita el proyecto real, callbacks del entorno y una cuenta de prueba. En local, la sesión PKCE se prueba con GoTrue y Mailpit ([O09/ops-04](../../2026-10-23/O09/ops-04/informe.md)). | Néstor |
| | | Cabeceras, HTTPS, CDN y caché del alojamiento; CSP en modo enforcement | **pendiente externo** | Matriz local superada: 53/53 cabeceras con `/offline` y `/sw.js` ([O15/exp-08](../O15/exp-08/informe.md)), [seguridad](../../../seguridad.md). | Néstor |
| | | Sonda externa de Open Library y BNE con presupuesto mínimo | **pendiente externo** | Sin autorización no se ejecuta. No se usa el catálogo privado como prueba pública. | Néstor |
| | | Google Books | **diferido con decisión** | Apagado hasta verificar consola, cuota, coste y términos ([06](../../../spec-pendientes/06-proveedores-bibliograficos.md), [O09/bib-03](../../2026-10-23/O09/bib-03.md)). | Néstor |
| 5 | Respaldo administrativo y Storage de la versión final; borrado de cuenta y no resurrección al restaurar. | Respaldo de la versión final con `biblib-media` (avatar y foto de ubicación) y `biblib-covers` → borrado de la cuenta C por el worker → reset → restore → verify | **hecho localmente** | [informe §3](qa-05/informe.md#3-respaldo-y-restauración-de-la-versión-final), [qa-05/18-restore-verify.txt](qa-05/18-restore-verify.txt), [qa-05/19-ensayo-tras-restore.json](qa-05/19-ensayo-tras-restore.json) | U-QA-05 |
| | | Respaldo del proveedor, copia de Storage y restauración remota en un proyecto aislado | **pendiente externo** | Hay que identificar el plan y la retención contratados; no se presupone PITR ([recuperación](../../../recuperacion.md#procedimiento-remoto-pendiente)). | Néstor |
| 6 | Release del mismo commit, lockfile y migraciones, con artefacto inmutable del destino; errores y alertas probadas; plan de recuperación y responsable. | Workflows de CI, semanal y promoción (desactivada) preparados; `build:prod` y huella del artefacto; plan de recuperación con responsable | **hecho localmente** | [O09/qa-04](../../2026-10-23/O09/qa-04.md), [promoción](../../../promocion.md), [recuperación](../../../recuperacion.md) (responsable: Néstor) | U-QA-04, U-INF-07, U-OPS-02 |
| | | Ejecución real en GitHub, artefacto de release del destino y su configuración pública verificada | **pendiente externo** | Push/PR y autorización del destino. | Néstor |
| | | Alertas probadas en la herramienta real | **pendiente externo** | Alertas propuestas, no activadas ([alertas](../../../alertas.md)). | Néstor |
| 7 | Matriz de los 35 hallazgos con evidencia por entorno; Google apagado y 3D libre como decisiones. | Matriz | **hecho localmente** | [matriz-auditoria.md](matriz-auditoria.md) | U-QA-05 |
| | | Rotación y zoom libres del 3D | **diferido con decisión** | [README de la spec, A07](../../../spec-pendientes/README.md), [07-rediseno](../../../spec-pendientes/07-rediseno.md) | Néstor |

## Pendientes externos consolidados

Todos son de Néstor (usuario). Ninguno se ha simulado.

1. **Google OAuth real:** callbacks y orígenes del entorno, renovación de sesión y cierre.
2. **Alojamiento:** HTTPS, cookies `Secure`, cabeceras efectivas, CDN y caché, y CSP en modo enforcement.
3. **Preproducción:** crearla. Después, adoptar el historial, migrar y hacer el smoke del destino.
4. **Producción:** identidad, respaldo del proveedor ensayado y plan revisado antes de migrar.
5. **Release:** ejecución real de los workflows (push/PR), artefacto inmutable del destino y configuración pública verificada.
6. **Alertas:** exportador, panel y prueba de disparo controlada en la herramienta real.
7. **Proveedores:** sonda de Open Library y BNE con presupuesto mínimo. Google Books sigue apagado.
8. **Accesibilidad manual:** lector de pantalla, Safari macOS/iOS, Edge y dispositivos reales.
9. **Máquina local:** decisión A/B sobre los bindings de Docker fuera de loopback ([operación](../../../operacion.md#limitación-conocida-bindings-fuera-de-loopback)) y el `.env` no acreditado del checkout principal.

## Revalidación del coordinador (perfil `test`)

Hecha el 26 de octubre de 2026 sobre `5a5adfe`; las correcciones de pruebas se integraron en `78326f8`. Acta: [g16-coordinador.md](g16-coordinador.md).

| Suite | Resultado |
| --- | --- |
| `test:integration:local --profile test` | 291/291 en dos pasadas seguidas |
| `test:integration:media` / `security` / `reading` | 5/5 · 24/24 · 28/28 |
| `security:headers:local` | 55/55 |
| `test:e2e:local` Chromium | completo, sin fallos |
| `test:e2e:local` Firefox y WebKit | 48 fallos de prueba en G16, sin defectos de producto. Corregidos en [O16-XB](xb/informe.md): Firefox 82/82 y WebKit 79+9 por separado, con omisiones de motor inventariadas. El run completo final se interrumpió por memoria y el usuario lo dio por bueno. |
| `test:a11y:local` | 10/10 |

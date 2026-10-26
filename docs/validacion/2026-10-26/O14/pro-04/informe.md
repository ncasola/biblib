# U-PRO-04 · Préstamos privados por ejemplar

26 de octubre de 2026. Implementación y aceptación local completadas en **`u-pro-04-stack`**, worktree `C:/Users/ncaso/orca/workspaces/biblib/u-qa-01`. Se partió de `u-pro-04`; antes del turno de stack se integró `feature/spec-pendientes` con U-PRO-02 y U-UX-02 (`a40783a`). No hay push, PR ni actuación remota.

## Entrega

- `app/actions/loans.ts`: lecturas de historial, listado activo y cifra del inicio; prestar, devolver, editar y borrar. El dueño procede de la sesión; todas las consultas aplican RLS y todas las mutaciones toman el bloqueo de biblioteca. Las modificaciones comparan la versión del préstamo.
- Prestar usa `loan_open` y reconoce el reenvío de la misma operación por alias y fecha de salida. Otro préstamo activo da `CONFLICT`. Devolver usa `loan_return`: misma devolución ya guardada reconoce el reintento; otra fecha o versión antigua produce conflicto.
- Editar y borrar requieren confirmación explícita en la interfaz y `confirmed: true` en la acción. Los errores conservan el borrador y ofrecen recarga para revisar cambios de otra pestaña.
- La ficha incorpora `LoanPanel` con préstamo activo e historial. Devolver libera el ejemplar para un préstamo sucesivo; borrar retira solo ese préstamo. No se modifica el estado ni la versión del ejemplar al prestar.
- `/loans` muestra «Prestados», con filtro «Solo vencidos» y enlaces a la ficha. `LoanSummary` consulta la cifra real en el inicio; un fallo se muestra como error y no se sustituye por cero.
- Fechas civiles `AAAA-MM-DD` de extremo a extremo; la presentación no las convierte en instantes. Hoy y los vencidos usan `civilDateInZone` con la zona del navegador. Sin vencimiento: «Sin fecha acordada». El alias inválido propone otro alias corto sin sugerir correo ni teléfono.
- Se mantiene `LOAN_REMINDERS_SENT = false`; no existe envío ni anuncio de recordatorios. No se añaden contactos, tablas o migraciones. Exportación v2, versiones anteriores, respaldo y supresión usan el contrato ya integrado de `0015`.
- Se conservan los controles y resúmenes de lectura de U-PRO-02 y el rediseño 3D de U-UX-02. Los componentes `loan-*` usan los tokens y controles de «Biblioteca nocturna».

## Aceptación de U-PRO-04 y G14

| Criterio | Evidencia |
| --- | --- |
| Un activo por copia, también con duplicado concurrente | `loans`: dos altas por HTTP y dos conexiones Postgres; `reading-loans`: índice y funciones reales. |
| Prestar no cambia la lectura | Comparación de estado y versión antes/después del alta; E2E mantiene `reading`. El grupo de datos también cambia la lectura por la app sin tocar el préstamo. |
| Devolución con versión e historial sucesivo | Conflicto antiguo, fecha anterior rechazada, mismo reenvío reconocido, préstamo siguiente y dos filas de historial. E2E completa el recorrido. |
| Fechas civiles y vencidos | Unidad en medianoche y cambio de hora; integración con Kiritimati, Los Ángeles, Madrid y UTC; listado E2E vencido. |
| Fechas ausentes y privacidad | Sin vencimiento no se inventa fecha; alias inválido conserva borrador. A/B, cuenta inactiva y ejemplar borrado por las acciones reales. |
| Ida y vuelta v2 | Exportar, modificar y reemplazar por la app restaura contenido e IDs que seguían perteneciendo a la cuenta; el grupo de datos cubre también versiones anteriores, fusión y archivo v1. |
| Ningún recordatorio anunciado | Contrato constante `false`, entradas estrictas y pantallas sin estados de envío. |

## Validación ejecutada

Todos los comandos finales indicados devolvieron **0**. Los registros de SQL aislado se obtuvieron en `u-pro-04` después del merge y se trasladaron a esta rama; no hubo cambios SQL posteriores. Las comprobaciones generales finales y las ejecuciones con perfil se hicieron en `u-qa-01`.

| Comando | Resultado | Registro |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | Correcto; lockfile intacto | Turno de stack, sin dependencias añadidas. |
| `pnpm lint` | Sin errores ni avisos | [lint.log](lint.log) |
| `pnpm typecheck` | Correcto | [typecheck.log](typecheck.log) |
| `pnpm test` | 494 pasadas, 0 fallos | [test.log](test.log) |
| `pnpm test:scripts` | 272 pasadas, 0 fallos, 2 omitidas | [test-scripts.log](test-scripts.log) |
| `pnpm test:db` | Todas las migraciones y pruebas SQL hasta `0015` correctas | [test-db.log](test-db.log) |
| `pnpm build` | Correcto, incluida `/loans` | [build.log](build.log) |
| `pnpm test:smoke` | 12 comprobaciones correctas | [test-smoke.log](test-smoke.log) |
| `pnpm test:integration:loans --profile test --reuse-build` | 10 pasadas, 0 fallos | [integration-loans.log](integration-loans.log) |
| `pnpm test:integration:reading-loans --profile test --reuse-build` | 19 pasadas, 0 fallos | [integration-reading-loans.log](integration-reading-loans.log) |
| `pnpm test:e2e:local --profile test --grep "préstamos:"` | 5 pasadas: 2 sesiones y 3 recorridos propios | [e2e-prestamos.log](e2e-prestamos.log) |
| `pnpm test:e2e:local --profile test --reuse-build` | **74 pasadas**, 18 pendientes heredados, 0 fallos conocidos, 0 fallos, 0 repeticiones | [e2e-completo.log](e2e-completo.log) |
| `pnpm test:a11y:local --profile test --reuse-build` | **10 pasadas**, 0 fallos ni pendientes | [a11y-completo.log](a11y-completo.log) |
| `pnpm db:local:status --profile test` | Propiedad acreditada y servicios sanos | [estado-test-final.log](estado-test-final.log) |

Las dos omisiones de scripts corresponden a pruebas que requieren `scratch` acreditado, perfil no asignado a esta unidad. Los 18 pendientes E2E son los esqueletos y la captura optativa que conserva la suite de otras unidades; se retiró el `fixme` de U-PRO-04 al activar sus recorridos. No se cuentan como pruebas pasadas.

Los runners con stack confirmaron dos cuentas de Auth sin cambios, limpieza de los datos desechables y ninguna salida de red externa. El build usado con `--reuse-build` fue compilado por el runner con el perfil y la raíz acreditados, después del ajuste de cabecera.

### Interfaz y accesibilidad

Los tres recorridos propios comprueban préstamo/devolución, préstamo sucesivo, confirmaciones de edición y borrado, cancelación del borrado, cifra del inicio, listado vencido y borrador tras alias inválido. Se mide reflujo de la ficha con préstamo activo en 320, 375, 768 y 1440 px, en ambos temas.

Axe de la ficha, el diálogo de préstamo y el listado: **cero violaciones en ambos temas**; se conservan los resultados incompletos para revisión en [claro](chromium-flujos-prestamos-light-axe.json) y [oscuro](chromium-flujos-prestamos-dark-axe.json). La auditoría general añade contraste, foco, teclado, movimiento reducido y zoom equivalente al 200/400 %. Sus 36 artefactos actualizados se guardan en [a11y-general](a11y-general/), preservando los originales históricos de O11.

Capturas: [préstamo activo](chromium-prestamo-activo.png), [devolución](chromium-prestamo-devuelto.png), ficha [clara](chromium-prestamos-light-ficha.png) y [oscura](chromium-prestamos-dark-ficha.png), listado [claro](chromium-prestamos-light-listado.png) y [oscuro](chromium-prestamos-dark-listado.png). Solo contienen datos ficticios.

## Correcciones y alcance compartido

- `e347766`: incorporación mínima de `/loans` a `lib/auth-navigation.ts`, su prueba, la matriz de cabeceras y `docs/seguridad.md`, necesaria para la ruta privada.
- `c8b82f3`: acciones, componentes, pruebas iniciales y sección propia de operación. Scripts añadidos al final de `package.json`; grupo `loans` añadido a `SUITES`.
- `a40783a`: merge aditivo de lectura y 3D; se conservaron ambos componentes de ficha e inicio, ambos scripts de integración y las dos secciones de operación.
- `b5a1eba`: el E2E nuevo detectó que «Editar ficha» desbordaba la cabecera a 768 px con algunos títulos. Se permitió cambiar de fila mediante `sm:flex-wrap`; los recorridos de reflujo propios y generales pasan después del ajuste.
- `7da6efe`: pruebas completas, contraste y retirada del pendiente de préstamos. La primera expectativa de ida y vuelta era incorrecta: un ID borrado antes de importar puede reasignarse. La prueba final modifica el registro y restaura el contenido, comprobando IDs aún propios. Se conservan los intentos iniciales de integración y E2E como diagnóstico, sin presentarlos como éxitos.

## Estado entregado y recursos

**Perfil `test` activo por instrucción expresa del coordinador**, sin ejecutar `up`, `down` ni reset. Red: `biblib-test-network`. Volúmenes conservados: `supabase_db_biblib-test` y `supabase_storage_biblib-test`. Contenedores y puertos en [recursos-test.txt](recursos-test.txt). El aviso de ocho bindings fuera de loopback es la limitación ya documentada del stack; no se cambió configuración global de Docker.

No se levantó `scratch`, no se tocaron recursos de HolaERP ni otros stacks, y no se leyeron ni copiaron archivos de secretos. Los procesos de las apps de prueba y los contenedores efímeros de SQL/smoke se cierran mediante sus runners. La rama de origen `u-pro-04` queda limpia; la entrega final y esta evidencia están en `u-pro-04-stack`.

Queda al coordinador integrar la rama y registrar el cierre de U-PRO-04/G14. No hay conflictos de integración pendientes ni migraciones o despliegues remotos realizados por esta unidad.

# Informe O14 · U-PRO-02 · Ciclos, sesiones y progreso de lectura

**Fecha:** 25–26 de octubre de 2026 · **Rama:** `u-pro-02` (worktree `stack-scratch`) · **Perfil:** `scratch` (head `0015`, sin migración nueva) · **Contrato:** [contratos-o14](../../../../spec-pendientes/contratos-o14.md) · **Operación:** [docs/operacion.md → U-PRO-02](../../../../operacion.md#ciclos-sesiones-y-progreso-de-lectura--u-pro-02-o14).

## Qué se entrega

- **Acciones** `app/actions/reading.ts` sobre `reading_cycle_start` y `reading_cycle_close`:
  - Ciclos: iniciar o releer, pausar, reanudar, terminar o abandonar, y reabrir. Todas usan la versión vista y piden confirmación al cerrar, reabrir y releer.
  - Entradas: registrar, corregir y borrar, siempre con `occurred_at` explícito.
  - Lecturas: «Seguir leyendo» y estadísticas.
  - Errores: BR001, 23514, 23505, BP001, 23503 y BD001 se traducen a mensajes claros.
  - **El reintento propio no es un conflicto:** `already-open` al iniciar, `already_closed` con el mismo estado y fecha, el mismo estado al pausar o reanudar, la entrada con el mismo ID y los mismos datos, y el borrado de lo que ya no existe. Las escrituras toman antes el bloqueo de colección.
- **Lógica pura** `lib/reading.ts`:
  - Vistas y validación de entradas.
  - Progreso con `readingProgress`.
  - Zona de la persona: medianoche con horario de verano y formato.
  - Estadísticas con periodo y denominador.
- **Ficha:** panel «Lectura» con estos componentes, añadido a la ficha sin reescribirla (una línea en `book-details-screen.tsx`):
  - `components/reading-panel.tsx`: ciclo actual, acciones con diálogo de fecha («Ahora», otra fecha o «No lo sé (sin fecha)») e historial de lecturas y relecturas.
  - `reading-entries.tsx`: sesiones.
  - `reading-progress.tsx`: chip, barra solo con total conocido y fechas en la zona del navegador.
- **Inicio:** `components/reading-home.tsx`.
  - «Seguir leyendo» se construye con los ciclos abiertos reales y sustituye al bloque basado en el estado.
  - «Tu lectura registrada» muestra sesiones y páginas de los últimos 30 días y lecturas terminadas del año, con su periodo, fuente, denominador y zona horaria.
  - Los cierres sin fecha y los libros `read` sin lecturas se mencionan aparte, sin fecha.
- **Pruebas:**
  - Unitarias: `tests/reading.test.ts`, 18 pruebas.
  - Integración: grupo `tests/integration/reading`, 28 pruebas por las Server Actions reales. Se ejecuta con `pnpm test:integration:reading` y también en `test:integration:local`.
  - E2E: `tests/e2e/flujos/lectura.spec.ts`, 2 recorridos. Se retiró el `fixme` de U-PRO-02.

## Puerta G14 (parte de U-PRO-02)

| Criterio | Evidencia |
| --- | --- |
| Una relectura crea un ciclo sin perder historia | `relectura.test.mjs`: la lectura n.º 1 conserva estado, fechas, sesiones y **versión**; la relectura exige confirmación y la última lectura vista; reabrir la 1 con la 2 en curso da «ya hay una lectura en curso» (23505). E2E y captura `ficha-*-1440.png`. |
| Sesión y progreso no inventan fechas legacy | `cero-ciclos.test.mjs`: libros `read` sin ciclos: estadísticas a cero con el legado aparte, «Seguir leyendo» vacío aunque haya un libro «Leyendo», consultar no crea ciclos. Sin fecha de inicio o fin, el campo queda nulo (`interrupcion`, `relectura`). Ficha legada sin ningún `<time>` (E2E, `ficha-legado-*.png`). |
| Total de páginas desconocido sin porcentaje falso | `paginas.test.mjs`: `totalPages: null`, página 4000 registrada y `percent: null` en ficha e inicio; total corregido a la baja: la nota se edita, la página no sube y no hay porcentaje. E2E sin `progressbar`; `ficha-sin-total-*.png`. |

Aceptación de 03:
- No se acepta una página negativa ni superior al total conocido.
- La relectura crea un ciclo nuevo.
- El fin se revierte (reabrir con confirmación) y las sesiones se corrigen o se borran (borrar pide confirmación).
- El inicio solo cuenta lo registrado y etiqueta el periodo.
- Los libros legados no tienen fecha inventada.

## Resultados (ejecutados en esta sesión)

| Comprobación | Resultado |
| --- | --- |
| `pnpm test:integration:reading --profile scratch` (`grupo-reading.log`) | **28/28**. Escenarios: dos dispositivos, interrupción, husos horarios (+14:00/−12:00, medianoche UTC en cuatro zonas, Nochevieja), relectura y fechas cruzadas, copia sin páginas, cero ciclos, A/B y anónimo, cuenta inactiva. La primera ejecución dio 27/28 por un error de la propia prueba (leía `totalPages` del resultado de la mutación en vez de su `reading`); se corrigió y la segunda dio 28/28. |
| `pnpm test:integration:reading-loans --profile scratch --reuse-build` (`grupo-reading-loans.log`) | 19/19: regresión del lote D. |
| `pnpm lint` / `pnpm typecheck` | Correctos. `typecheck` también compila el E2E nuevo. |
| `pnpm test` | 487/487. |
| `pnpm test:scripts` | 275/275. |
| `pnpm test:db` | Correcto, en un contenedor aislado propio del script. |
| `pnpm build` / `pnpm test:smoke` | Correctos. |
| Comprobación visual y de accesibilidad en scratch (`visual-axe.json`, capturas `*.png`) | Ficha (con total, sin total, legado) e inicio en tema oscuro y claro a 1440, 375 y 320 px: **sin desbordamiento horizontal** y **sin violaciones de axe** (WCAG 2.1 A/AA) en el panel y el `main` del inicio. Zona del navegador `Europe/Madrid`. |
| E2E `lectura.spec.ts` | **No ejecutado:** solo admite el perfil `test`. Lo ejecuta el coordinador al integrar con `pnpm test:e2e:local --grep "lectura:"`. |

## Recursos y limpieza

- **Stack:** `scratch` arrancado con `db:local:bootstrap` y parado con `db:local:down --profile scratch` (`scratch-down.txt`). Quedan la red `biblib-scratch-network` y los volúmenes `supabase_db_biblib-scratch` y `supabase_storage_biblib-scratch`.
- **Cuentas y otros stacks:** las cuentas desechables se retiran al terminar cada prueba. No se tocaron los stacks `main` ni `test` ni HolaERP.

## Notas para la integración

- **Conflictos posibles con U-PRO-04:**
  - En `app/page.tsx` se sustituyó el bloque «Seguir leyendo» por `<ReadingContinueSection />` y `<ReadingStatsSection />`; el hueco de «Prestados» de las tarjetas no se tocó.
  - En `components/book-details-screen.tsx` se añadieron una línea de import y `<ReadingPanel …/>` tras el estado.
- **Archivos compartidos:** un commit aparte añade el script al final de `package.json` y el grupo `reading` a `SUITES` de `tests/integration/run.mjs`.
- **Fuera de alcance:** el titular del inicio y las tarjetas «Leyendo/Leídos» siguen contando el **estado actual**, como antes. No es lectura registrada y no lleva fechas. Unificar ese texto con los ciclos sería decisión de diseño.

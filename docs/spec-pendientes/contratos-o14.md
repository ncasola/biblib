# Contratos de datos de O14 · migración `0015_reading_and_loans`

**Fecha:** 26 de octubre de 2026 · **Lote:** D (único escritor de schema en O14) · **Estado:** implementado y verificado en local (evidencia en [validación O14/d](../validacion/2026-10-26/O14/d/informe.md)).

Este documento fija lo que leen las unidades de O14 —U-PRO-02 (lectura) y U-PRO-04 (préstamos)— antes de escribir sus acciones y pantallas: tablas y columnas, restricciones, funciones SQL, límites, la forma v2 de cada entidad y cómo entran en versiones anteriores, respaldo, restauración y eliminación de cuenta. Las especificaciones de producto siguen en [03](03-experiencia-y-funciones.md); aquí solo el contrato de datos. **Ninguna unidad genera otra migración en O14**: si un contrato no basta, se pide al lote D.

Tipos y límites en TypeScript (sin `server-only`, válidos en cliente y servidor):

| Módulo | Contenido |
| --- | --- |
| [`lib/product/reading-loans.ts`](../../lib/product/reading-loans.ts) | Estados de ciclo (`READING_CYCLE_STATUSES`, abiertos y cerrados, etiquetas en español), `READING_LIMITS`, `readingProgress` (porcentaje honesto), `LOAN_LIMITS`, `isValidBorrowerLabel`, `isCivilDate`, `civilDateInZone`, `isLoanOverdue`, `LOAN_NO_DUE_DATE_TEXT`, `LOAN_REMINDERS_SENT = false`, DTO `ReadingCycle`, `ReadingEntry`, `Loan`, respuestas de las funciones SQL y el SQLSTATE `READING_PAGE_SQLSTATE`. |
| [`lib/types.ts`](../../lib/types.ts) | `Book.reading?: ReadingCycle[]` y `Book.loans?: Loan[]` (ausentes si no hay nada). |
| [`lib/db/schema.ts`](../../lib/db/schema.ts) | Tablas Drizzle `readingCycles`, `readingEntries` y `loans` (fechas civiles con `date(…, { mode: "string" })`). |
| [`lib/db/product.ts`](../../lib/db/product.ts) | Lectura y escritura para exportar, importar y restaurar (no son acciones de unidad). |

## Reglas comunes (las de [O13](contratos-o13.md#reglas-comunes-todas-las-tablas-nuevas), sin excepciones)

1. **Dueño y RLS.** `user_id` y políticas `*_select_own`/`*_insert_own`/`*_update_own`/`*_delete_own` con `user_id = (select auth.uid())`. El dueño sale siempre de la sesión; ningún DTO elige `user_id`.
2. **Cuenta activa.** Políticas RESTRICTIVE `*_insert_active`/`*_update_active`/`*_delete_active` con `biblib.account_write_allowed()` en las tres tablas: con la cuenta en eliminación, **BD001** (→ `ACCOUNT_INACTIVE`). Las cuatro funciones de abajo también.
3. **FK con el mismo dueño.** `(user_id, copy_id) → copies(user_id, id)` y `(user_id, cycle_id) → reading_cycles(user_id, id)`, **en cascada**: borrar el ejemplar se lleva su lectura y sus préstamos (no quedan huérfanos ni se impide el borrado). Citar un ejemplar o ciclo de otra cuenta da **23503**.
4. **Versión por fila.** `version uuid` que renueva `rotate_book_version` en cada `INSERT`/`UPDATE`. Las mutaciones comparan `version`; 0 filas → `CONFLICT`. La restauración administrativa rota estas versiones (`PRODUCT_TOKEN_TABLES`).
5. **Revisión de colección.** Escribir en cualquiera de las tres tablas rota la revisión del dueño (forman parte de la exportación, las versiones anteriores y el reemplazo).
6. **Límites en Postgres** (`enforce_row_limit`, **BP001** → `LIMIT_EXCEEDED`; nunca se recorta). Checks: 23514 → `INVALID_INPUT`; unicidad: 23505 → `CONFLICT`; **BR001** (página por encima del total) → `INVALID_INPUT`.
7. **Independencia.** Ni la lectura ni los préstamos cambian `copies.status`, `copies.version` ni la versión de la ficha; cambiar el estado actual tampoco los toca. Un préstamo no cambia el estado de lectura ni al revés.

## U-PRO-02 · Ciclos y entradas de lectura

| Tabla | Columnas | Restricciones |
| --- | --- | --- |
| `reading_cycles` | `id`, `user_id`, `copy_id`, `cycle_number` (1–1000), `status`, `started_at`, `finished_at` (`timestamptz`, nulos si no constan), `version`, fechas | `status` ∈ **`reading`, `paused`** (abiertos), **`finished`, `abandoned`** (cerrados). **Un ciclo abierto por ejemplar** (`reading_cycles_open_unique`, índice parcial). Número único por ejemplar (`reading_cycles_copy_number_unique`). Abierto ⇒ sin `finished_at`; `finished_at ≥ started_at` si constan ambos. Máx. **50 por ejemplar** y **20000 por cuenta**. |
| `reading_entries` | `id`, `user_id`, `cycle_id`, `occurred_at` (**obligatorio**, `timestamptz`), `page_from`, `page_to`, `note` (1–1000), `version`, fechas | Páginas enteras 0–100000; `page_from` exige `page_to` y `page_from ≤ page_to`; lleva `page_to` o `note`. **`page_to` nunca supera el total conocido** de la edición del ejemplar (`editions.number_of_pages > 0`; `guard_reading_entry_pages`, BR001). Con el total desconocido (0) se admite. Máx. **1000 por ciclo** y **50000 por cuenta**. |

- **Una relectura es un ciclo nuevo** (número siguiente); los anteriores no se tocan. «Ciclo» no es «sesión»: una sesión o un cambio de progreso es una **entrada** de un ciclo.
- **Sin backfill.** 0015 no convierte el estado `read` legado en ciclos, sesiones ni fechas, y ningún flujo debe hacerlo: un libro leído antiguo conserva su estado actual sin fecha. Nunca se usa la fecha actual para rellenar el pasado ni se deducen eventos de `updated_at`. Si una acción registra «empecé hoy», es la persona quien lo afirma en ese momento.
- **Instantes en UTC.** Se guardan como `timestamptz` y se presentan en la zona de la persona. `occurred_at` lo envía la acción (sin `DEFAULT`).
- **Progreso honesto.** `readingProgress(page, total)` devuelve `percent: null` si el total es 0/desconocido o si la página lo supera (un total corregido a la baja después no reescribe entradas: editar su nota sigue pasando, subir su página no).
- **Reabrir o pausar:** `update reading_cycles set status = …, finished_at = null where id = $1 and version = $2`. Reabrir con otro abierto da **23505** (`CONFLICT`: «ya hay una lectura en curso»).
- Estadísticas: cuentan **solo entradas y ciclos registrados**, con su periodo y denominador; ningún libro `read` sin ciclo entra como lectura con fecha.

Funciones (`SECURITY INVOKER`: corren con la RLS de quien llama; dueño de `auth.uid()`, `search_path=pg_catalog`, BD001 con la cuenta en eliminación, `EXECUTE` solo para `authenticated`):

| Función | Respuesta | Uso |
| --- | --- | --- |
| `biblib.reading_cycle_start(copy_id uuid, started_at timestamptz)` | `{ status: "started", cycle_id, cycle_number, version }` · `{ status: "open", … }` · `{ status: "not_found" }` | Inicia lectura o relectura con el número siguiente bajo el bloqueo del ejemplar. `open`: ya había un ciclo abierto (reintento tras una respuesta perdida o segundo dispositivo): se devuelve ese, sin crear otro. `started_at` nulo si no consta. |
| `biblib.reading_cycle_close(cycle_id uuid, expected_version uuid, status text, finished_at timestamptz)` | `{ status: "closed", version }` · `{ status: "already_closed", cycle_status, finished_at, version }` · `{ status: "conflict", version }` · `{ status: "not_found" }` | Termina o abandona (`status` ∈ `finished`, `abandoned`; otro → 22023). `already_closed` permite a la acción reconocer su propio reintento; `conflict`, otra pestaña. |

Las entradas se crean, corrigen y borran con SQL directo (`insert … returning version`, `update/delete … where id = $1 and version = $2`). Un ejemplar o ciclo de otra cuenta no existe para la función (`not_found`), igual que uno borrado.

## U-PRO-04 · Préstamos

| Tabla | Columnas | Restricciones |
| --- | --- | --- |
| `loans` | `id`, `user_id`, `copy_id`, `borrower_label`, `loaned_on` (**`DATE`**, obligatoria), `due_on` (`DATE`), `returned_on` (`DATE`), `note` (1–500), `version`, fechas | **Un préstamo activo por ejemplar y cuenta** (`loans_active_unique`, índice parcial `returned_on is null`). `due_on` y `returned_on` ≥ `loaned_on`; fechas entre 1900-01-01 y 2999-12-31. `borrower_label`: 1–40 caracteres, sin espacios en los extremos ni control, **sin `@` y con 6 dígitos como mucho** (`isValidBorrowerLabel`): un alias, nunca correo ni teléfono. Máx. **200 por ejemplar** y **20000 por cuenta**. |

- **Fechas civiles sin conversión.** `DATE` en Postgres y texto `AAAA-MM-DD` en TypeScript (Drizzle `mode: "string"`, lectura con `::text`); nunca `new Date("2026-03-29")`, que lo interpreta en UTC. «Hoy» en la zona de la persona: `civilDateInZone(new Date(), zona)`.
- **Sin vencimiento:** `due_on` nulo; la interfaz dice `LOAN_NO_DUE_DATE_TEXT` («Sin fecha acordada»). Vencido = activo con `due_on` anterior a hoy (`isLoanOverdue`).
- **Sin recordatorios.** No hay columna ni estado de envío (`LOAN_REMINDERS_SENT = false`); la interfaz nunca afirma que se avisó a nadie. Tampoco hay contactos: solo el alias.
- **Historial.** Devolver cierra el préstamo (`returned_on`) y deja el ejemplar libre para uno nuevo; los anteriores se conservan. Borrar un préstamo (con confirmación) es la única forma de retirarlo antes de borrar el ejemplar o la cuenta; retirar la función no borra el historial.

| Función | Respuesta | Uso |
| --- | --- | --- |
| `biblib.loan_open(copy_id uuid, borrower_label text, loaned_on date, due_on date, note text)` | `{ status: "opened", loan_id, version }` · `{ status: "active", loan_id, borrower_label, loaned_on, version }` · `{ status: "not_found" }` | Presta bajo el bloqueo del ejemplar. `active`: ya está prestado; si coincide alias y fecha es el propio reintento, si no, `CONFLICT` («ya está prestado»). Un alias o fecha inválidos → 23514. |
| `biblib.loan_return(loan_id uuid, expected_version uuid, returned_on date)` | `{ status: "returned", version }` · `{ status: "already_returned", returned_on, version }` · `{ status: "conflict", version }` · `{ status: "not_found" }` | Devuelve con la versión esperada; `returned_on` nula → 22023; anterior a la salida → 23514. |

Editar alias, vencimiento o nota: `update loans … where id = $1 and version = $2`.

## Formato v2 (`formatVersion: 2`)

Secciones **opcionales y declaradas por copia** (un lector anterior las rechaza con explicación; un archivo anterior no las trae y se importa **sin lectura ni préstamos**, aunque tenga libros `read`):

| Capacidad | Dónde | Forma |
| --- | --- | --- |
| `copies.reading` | `copies[].reading` | `[{ id, cycleNumber, status, startedAt?, finishedAt?, entries?: [{ id, occurredAt, pageFrom?, pageTo?, note? }] }]`, instantes ISO 8601 con zona (la exportación escribe UTC con `Z`), por número de ciclo y entradas por instante. |
| `copies.loans` | `copies[].loans` | `[{ id, borrowerLabel, loanedOn, dueOn?, returnedOn?, note? }]`, fechas `AAAA-MM-DD`, por fecha de salida. |

- El lector (`assertReadingAndLoans`) rechaza con explicación: número de ciclo repetido, más de un ciclo abierto o con fin, fin antes del inicio, entrada sin página ni nota o con `pageFrom > pageTo`, página por encima de `number_of_pages` de la edición (si es > 0), más de un préstamo activo, vencimiento o devolución antes de la salida, IDs repetidos en el archivo, fechas imposibles, alias con correo o teléfono y campos desconocidos (p. ej., un «recordatorio enviado»).
- **Fusión:** solo los ejemplares **nuevos** reciben lectura y préstamos, con IDs nuevos; un ejemplar que ya existía conserva los suyos (repetir la fusión no duplica). **Reemplazo:** la colección resultante es la del archivo también en lectura y préstamos, y se conservan los IDs que la cuenta aún tenía. Límites superados → `LIMIT_EXCEEDED`; página por encima del total → `INVALID_INPUT`; nada se aplica a medias.
- **Partes:** cada copia lleva su lectura y sus préstamos (no hay secciones de cuenta); dos copias de una misma edición en partes distintas pueden tener lecturas distintas.
- v1 nunca lleva lectura ni préstamos: una colección con ellos exige v2 (`libraryRequiresV2`).

## Versiones anteriores, respaldo y restauración

- **Versiones anteriores (schema_version 4).** `library_snapshot_capture` guarda por ejemplar `reading` (ciclos con `entries`) y `loans`, sin claves nulas; los recuentos de la cabecera incluyen `reading_cycles`, `reading_entries` y `loans`. Restaurar devuelve todo con sus IDs salvo los que hoy usa otra cuenta (`library_snapshot_foreign_ids` también los informa). Las versiones 1–3 se siguen restaurando (sin lectura ni préstamos).
- **Respaldo administrativo** (`db:backup:local`): las tablas entran por esquema. **Restauración** (`db:restore:local`): rota sus versiones (`PRODUCT_TOKEN_TABLES`); `db:restore:verify` compara contenido sin ellas.

## Eliminación de cuenta (U-OPS-03)

Las tres tablas se retiran **al principio del paso `product`** (`reading_entries`, `reading_cycles`, `loans`; antes que los ejemplares). Inventario: `ACCOUNT_DATA_INVENTORY`, `account_deletion_step_tables` (0015) y [retención](../retencion.md). El préstamo solo guarda el alias que escribió el dueño: no hay datos de la otra persona que conservar ni que borrar en otra cuenta.

## Lo que queda en las unidades

| Unidad | Pendiente sobre este contrato |
| --- | --- |
| U-PRO-02 | Acciones `app/actions/reading.ts` (iniciar, pausar, terminar/abandonar, reabrir con confirmación y versión; registrar, corregir y borrar entradas con `occurred_at` explícito; traducir BR001/23505/BP001), panel de progreso con `readingProgress` (sin indicador si no hay total), detalle con historial de lecturas, resumen del inicio y estadísticas solo con datos registrados, periodo y denominador; zona horaria de la persona al presentar; pruebas de dos dispositivos, interrupción de red, husos y fixture de cero ciclos. |
| U-PRO-04 | Acciones `app/actions/loans.ts` (prestar con `loan_open` reconociendo el propio reintento, devolver con versión, editar y borrar con confirmación), listado «Prestados», ficha con historial, «Sin fecha acordada» y vencidos con `civilDateInZone`; mensajes de alias no válido sin sugerir correo ni teléfono; nunca anunciar recordatorios; pruebas de préstamo sucesivo, duplicado concurrente, husos, libro borrado y permisos A/B. |

# Informe O14 · lote D · migración `0015_reading_and_loans`

**Fecha:** 26-10-2026 · **Rama:** `o14-d` (worktree `stack-scratch`) · **Perfil:** `scratch` · **Contrato para las unidades:** [contratos-o14](../../../../spec-pendientes/contratos-o14.md).

## Qué se entrega

- **Una sola migración** `drizzle/0015_reading_and_loans.sql` con su snapshot y su entrada en el journal (generada con Drizzle y completada a mano: índices antes de las FK compuestas, triggers, funciones, grants, versiones anteriores y pasos de eliminación). Tablas: `reading_cycles`, `reading_entries` (U-PRO-02) y `loans` (U-PRO-04). **Sin backfill**: el estado `read` legado no se convierte en ciclos, entradas ni fechas.
- **Reglas en Postgres:** RLS del dueño, FK compuestas `(user_id, …)` con la copia (y con el ciclo) en cascada, política RESTRICTIVE de cuenta activa en cada escritura, `version` por fila y revisión de colección. Un ciclo abierto por ejemplar y un préstamo activo por ejemplar (índices únicos parciales); estado de ciclo conocido sin fin mientras está abierto y fin ≥ inicio; páginas 0–100000 con `desde ≤ hasta` y nunca por encima del total conocido de la edición (`guard_reading_entry_pages`, BR001); fechas civiles `DATE` con vencimiento y devolución ≥ salida; alias de 1–40 caracteres sin `@` ni más de 6 dígitos; límites por ejemplar/ciclo y por cuenta (BP001). Sin columnas de recordatorio ni de contacto.
- **Funciones de las acciones** `reading_cycle_start`, `reading_cycle_close`, `loan_open`, `loan_return`: `SECURITY INVOKER` (RLS de quien llama), dueño de `auth.uid()`, `search_path` fijo, BD001 con la cuenta en eliminación, bloqueo por ejemplar y respuestas que distinguen el propio reintento (`open`, `already_closed`, `active`, `already_returned`) de un conflicto. En la lista de exposición (`exposicion.test.mjs`, nueva prueba de invokers) y en `docs/seguridad.md`.
- **v2, importación y restauraciones:** capacidades `copies.reading` y `copies.loans` por copia (instantes UTC y fechas civiles tal cual); el lector rechaza con explicación lo que 0015 no admitiría. Exportación, importación (fusión y reemplazo), restauración por partes y versiones anteriores (**schema_version 4**) escriben lectura y préstamos en la misma transacción; un archivo anterior se importa sin ellos. IDs propios conservados al reemplazar y en versiones anteriores (salvo los que usa otra cuenta, que `library_snapshot_foreign_ids` también informa).
- **Respaldo y restauración administrativos:** las tablas entran por esquema; el restore rota sus versiones (`PRODUCT_TOKEN_TABLES`). **Eliminación de cuenta:** las tres tablas al principio del paso `product` (`account_deletion_step_tables`, `ACCOUNT_DATA_INVENTORY`, `DELETION_SCOPE`, `docs/retencion.md`).
- **Contratos TypeScript:** `lib/product/reading-loans.ts` (estados, límites, `readingProgress`, `isValidBorrowerLabel`, `isCivilDate`, `civilDateInZone`, `isLoanOverdue`, «Sin fecha acordada», `LOAN_REMINDERS_SENT = false`, DTO y respuestas de las funciones) y `Book.reading`/`Book.loans`.
- **Pruebas:** `tests/db/reading-loans-legacy.sql` + `tests/db/reading-loans.sql`; `tests/reading-loans.test.ts`; manifest y hechos reales `objects-0015.json` con su prueba de drift; grupo `tests/integration/reading-loans` (19 pruebas) en `SUITES` y `pnpm test:integration:reading-loans`.

## Resultados (ejecutados en esta sesión)

| Comprobación | Resultado |
| --- | --- |
| `0014 → 0015` en scratch con datos (`scratch-0014-antes.json`, `scratch-migracion-0014-0015.txt`, `scratch-0015-sin-backfill.json`) | Aplicada. 2 cuentas y 9 ejemplares (2 `read`): misma huella de `id:status:version:updated_at` antes y después; 0 ciclos, 0 entradas, 0 préstamos. |
| `db:status:local` tras migrar (`scratch-status-0015.txt`) y final (`validacion-status-final.txt`) | up-to-date, **864 comprobaciones**, sin drift. |
| Desde vacío con `db:reset:local` (`ensayo-03`, `ensayo-04`) | Head 0015, bootstrap con migración, seed y verificación reales; 864 comprobaciones. |
| Ensayo respaldo → reset → restore → verify con ciclos, entradas y préstamos poblados (`ensayo-01`…`ensayo-08`) | **Superado**: 65/65 comprobaciones; `reading_cycles` (4), `reading_entries` (4) y `loans` (4) iguales al recibo con sus versiones rotadas; recuentos, fechas civiles e instantes idénticos antes y después (`ensayo-01` = `ensayo-07`). |
| Grupos en scratch | `reading-loans` 19/19, `product` 17/17, `account` 11/11, `snapshots` 10/10, `restore` 11/11, `model` 8/8, `security` 24/24. |
| `pnpm test` | 469/469. |
| `pnpm test:scripts` | Dos ejecuciones completas en paralelo con 274/275: falló la prueba `[stack]` del seed por timeout de la CLI de Docker («Docker no respondió…», código 8) con los stacks `main` y `test` de otros workers en marcha; la misma prueba pasa sola (15/15) y la suite completa en serie (`--test-concurrency=1`) pasa **275/275** (`validacion-test-scripts-serie.txt`; los intentos quedan en `-intento-1/2`). |
| `pnpm test:db` | Correcto (todas las migraciones, `product*.sql` y `reading-loans*.sql`). |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test:smoke` | Correctos (el smoke aplica ya 0015). |
| HolaERP (`holaerp-antes.txt` / `holaerp-despues.txt`) | Parado antes y después, mismos contenedores, redes y volúmenes; solo cambia el «Exited … ago». No se arrancó ni se tocó. |

## Hallazgos de O13 aplicados de antemano

1. **Índices antes de las FK compuestas:** el SQL generado se reordenó al ensamblar (la FK de `reading_entries` apunta a `(user_id, id)` de `reading_cycles`).
2. **Vista previa de importación:** lectura y préstamos viajan dentro de cada copia del payload v2 que ya guarda la vista previa; no hizo falta tocar `app/actions/import-preview.ts`. Lo acredita el reemplazo y la fusión por la app del grupo `reading-loans`.
3. **Storage:** no aplica (sin objetos nuevos).
4. **Formas canónicas:** la exportación escribe instantes con `to_char(… at time zone 'UTC')` y fechas con `::text`; la versión anterior normaliza los instantes de jsonb a ISO UTC, así que la ida y vuelta compara exacto.
5. **Verificación del restore:** las tres tablas tienen `id`; comparan por clave natural y sus versiones rotadas quedan fuera (65/65 a la primera).
6. **Smoke:** aplica 0015 en su base.

Hallazgo nuevo de este lote: la restauración por partes considera conflicto de edición cualquier diferencia entre copias de una misma edición; `reading` y `loans` se añadieron a los campos por copia excluidos de esa comparación (`lib/import-staging.ts`).

## Decisiones del lote (documentadas en el contrato)

- **Funciones `SECURITY INVOKER`** en lugar de `DEFINER`: dan el comportamiento transaccional pedido (número de ciclo, reintento reconocible, versión) sin ampliar privilegios; la unicidad la garantizan además los índices parciales.
- **Copia borrada en cascada:** la lectura y los préstamos son del ejemplar, como notas y ubicación; borrar el libro (con confirmación de la app) se los lleva y no impide el borrado ni deja huérfanos.
- **Fechas desconocidas como nulos** (`started_at`, `finished_at`); `occurred_at` obligatorio y sin `DEFAULT`: la acción declara el instante, nunca la base.
- **Alias:** sin `@` y con 6 dígitos como mucho, también validado en TS con la misma regla.
- Lectura y préstamos en el paso `product` existente (sin paso nuevo) para no tocar la máquina de estados del worker.

## Recursos Docker que quedan

`db:local:down --profile scratch` ejecutado (`scratch-down.txt`). Quedan solo los del perfil, conservados por diseño: red `biblib-scratch-network` y volúmenes `supabase_db_biblib-scratch` y `supabase_storage_biblib-scratch` (`scratch-recursos-restantes.txt`). Respaldo del ensayo en `.biblib/backups/20261025T223049Z-scratch-ac628f` (ignorado por Git). Las cuentas desechables de los grupos se retiraron; scratch queda con las cuentas fixture A/B y los ciclos y préstamos del ensayo.

## Pendiente fuera de este lote

Acciones, pantallas y estadísticas de U-PRO-02 y U-PRO-04 (tabla final del contrato). Fuera del scope cerrado se tocaron, en commits propios y como hizo O13: `docs/seguridad.md` (inventario de 0015) y `tests/integration/security/exposicion.test.mjs` (prueba de funciones invoker). Sin push ni PR.

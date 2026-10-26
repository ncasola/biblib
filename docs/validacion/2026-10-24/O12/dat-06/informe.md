# U-DAT-06 · Obra, edición y ejemplar con ISBN opcional (O12)

**Rama:** `u-dat-06` sobre `feature/spec-pendientes` (`dafbfc2`). **Perfil:** `scratch` (`biblib-scratch`, puertos 55340–55349). **Fecha:** 2026-10-24/25.
Operación y decisiones: [docs/operacion.md · U-DAT-06](../../../../operacion.md#obra-edición-y-ejemplar-con-isbn-opcional--u-dat-06-o12). Formatos: [docs/formatos.md](../../../../formatos.md#payload-portable-formatversion-2).

## Qué se entrega

- **Modelo** `biblib.works` / `editions` / `copies`, privado por cuenta, con RLS (`user_id = (select auth.uid())`) y FK que incluyen al dueño. `editions.isbn13` es opcional con único parcial `(user_id, isbn13)`. La comprobación física (`edition_verification`) está en el ejemplar y `legacy_identifier` conserva `manual-…`. La portada (URL y asset privado) está en la edición.
- **Migraciones** `0010` (expandir + backfill + comparar, con informe), `0011` (congelar, agrupar equivalencias compatibles, `books_legacy` y vista plana `books` con triggers INSTEAD OF) y `0012` (poda `SECURITY DEFINER`, ver hallazgos). No se reescribe ninguna migración anterior a la unidad.
- **Contratos** `createCopyAction`, `createEditionAction`, `updateEditionAction` (exige confirmar cuántos ejemplares cambian) y `mergeEditionsAction`, con versiones, revisión e idempotencia. «Ya existe» ofrece abrir o añadir otro ejemplar. El DTO plano `Book` se conserva y `catalogue.isbnVerified` se deriva del ejemplar.
- **Formatos.** v2 con capacidad completa y `requiredCapabilities`. v1 solo sin pérdida. El lector v1/legacy crea un ejemplar por fila (111 → 111). Versiones anteriores `schema_version: 2`, restauración por partes y respaldo administrativo usan el modelo nuevo.
- **T5** (columna generada `search_text`; trigramas evaluados y no adoptados) y **T7** (igualdad indexada de ISBN), medidas antes y después con `perf:local --scale 10000`.

## Migración real en scratch

| Paso | Evidencia | Resultado |
| --- | --- | --- |
| Datos legacy en 0009: fixture sintético de 111 fichas + equivalencias ISBN-10/13 (121 fichas), portada privada | `01`, `02` | 121/121 |
| Respaldo 0009 → reset desde vacío → restore 0009 → verify | `03`–`08` | verify superado |
| plan/migrate/status 0010 | `09`–`11` | up-to-date, 467 comprobaciones |
| Ensayo tras 0010 + informe del backfill | `12`, [`13-informe-backfill-0010.json`](13-informe-backfill-0010.json) | 121/121; 10 130 ejemplares = 10 130 ediciones; 0 diferencias |
| plan/migrate/status 0011 | `14`–`16` | up-to-date |
| Ensayo tras 0011 + comparación | `17`, [`18-informe-comparacion-0011.json`](18-informe-comparacion-0011.json) | 121/121; 2 agrupaciones compatibles (10 128 ediciones); 0 diferencias |
| Respaldo 0011 → reset → restore → verify → ensayo | `19`–`24` | verify superado, 121/121 |
| plan/migrate/status 0012 | `25`–`27` | up-to-date |
| Limpieza de la cuenta de escala por GoTrue (prueba real de 0012) | `28` | cuenta y modelo borrados |
| Respaldo 0012 → reset desde vacío (13 migraciones) → restore → verify → ensayo | `29`–`35` | verify superado, 121/121, 0 diferencias |

Informe del backfill (todas las cuentas de scratch, incluida la de escala de 10 000):

- `conflict` = 4: equivalencias con datos distintos, que quedan sin ISBN-13, con su texto original y una fila en el informe.
- `normalized` = 1 e `invalid` = 1.
- `grouped` (0011) = 2.
- Ninguna fila descartada: `books_legacy` conserva las 10 130.

## Pruebas

| Comprobación | Evidencia | Resultado |
| --- | --- | --- |
| `pnpm lint` | `60-lint.txt` | correcto |
| `pnpm typecheck` | `61-typecheck.txt` | correcto |
| `pnpm test` | `62-test.txt` | 356/356 |
| `pnpm test:scripts` completo con stack scratch | `63-test-scripts.txt` | 256/256, 0 omitidas |
| `pnpm test:db` (contenedor aislado; 111 fichas, equivalencias, backfill, vista, borrado de cuenta 0011 → 0012) | `64-test-db.txt` | correcto |
| Integración en scratch: model 8, security 23, jobs 19, snapshots 10, views 5, restore 11, assets 10, catalogue 14 | `40`–`47` | 100/100 |
| `pnpm build` | `65-build.txt` | correcto |
| `pnpm test:smoke` (aplica 0010–0012) | `66-test-smoke.txt` | correcto |
| `db:status:local` final | `67-status-final.txt` | up-to-date, head 0012, 467 comprobaciones |
| Retirada de la cuenta de ensayo por GoTrue | `36-ensayo-retirar.txt` | cuenta, 121 ejemplares y su objeto retirados |
| HolaERP | `holaerp-antes.txt`, `holaerp-despues.txt` | idéntico |

El grupo nuevo `tests/integration/model/` cubre, con sesiones reales A/B:

- dos copias de un ISBN (una edición, dos ejemplares independientes);
- edición compartida con confirmación;
- libro sin ISBN editado, exportado en v2 y restaurado con `null`;
- importación v2 de dos copias de una edición;
- FK y fusiones cruzadas rechazadas;
- altas concurrentes sin duplicados e idempotencia;
- fusión con revisión;
- proveedor simulado sin verificación física.

**No ejecutado:** `test:integration:local` completo (grupos `rls`, `storage`, `import` y `auth`) y `test:e2e:local`. Solo admiten el perfil `test`, que usa otro worktree. Pregunté al coordinador (`msg_604a1f5ca3ca`) y no hubo respuesta en dos esperas de 30 minutos, así que apliqué la opción conservadora: solo scratch. Revisé estáticamente esos grupos:

- `rls/sql-roles.test.mjs` esperaba 42501 al ceder un libro por `books`; la vista responde 0A000. Lo actualicé para comprobar ambas capas: 0A000 en la vista y 42501 en `copies`.
- `e2e-manifest.mjs` restaura por la vista, que respeta `edition_id`.

Hay que ejecutarlos con el perfil `test` antes de integrar. Los hallazgos 1, 2 y 7 muestran que hasta ahora solo los habría detectado una ejecución real de la interfaz.

## Rendimiento

En [`rendimiento/`](rendimiento/):

- [`comparacion.md`](rendimiento/comparacion.md): tablas antes/después;
- `antes*` (head 0009), `despues*` (0011 con el mismo dataset migrado), `despues-explain` (EXPLAIN y trigramas) y `despues-final` (exportación y vistas previas con el código final);
- 0 medidas fuera de presupuesto y aislamiento bajo carga 964/0.

| | Antes | Después |
| --- | --- | --- |
| T7 consulta por ISBN exacto, SQL p95 | 8.36 ms | 0.13 ms |
| T5 búsqueda por texto, SQL p95 | 103.7 ms | 30.4 ms |
| Búsqueda por ISBN parcial, SQL p95 | 141.6 ms | 29.4 ms |
| Exportación en el servidor, acción p95 c=1 / c=5 | 493 / 1 921 ms | 737 / 4 671 ms |
| Vista previa de importación, acción p95 c=1 | 243–307 ms | 300–411 ms |

**Trigramas no adoptados.** Un GIN sobre `search_text` ocupa 1.8 MiB, no mejora la búsqueda y encarece la escritura masiva un 22 %.

**La exportación y la vista previa empeoran** (lecturas completas a través de la vista), aunque siguen dentro de presupuesto. Es el primer candidato de mejora: leer las tablas sin la vista.

## Hallazgos durante la validación (corregidos)

1. **Token plano rechazado.** El token de la vista (`md5(...)::uuid`) no es un UUID RFC y `z.uuid()` lo rechazaba: editar con el token de la ficha fallaba con `INVALID_INPUT`. Corregido con `versionTokenSchema` (`2ea349c`).
2. **La vista previa de importación perdía datos.** Guardaba la forma plana y no la podía volver a leer con ejemplares sin ISBN-13; además perdía las ediciones compartidas. Ahora guarda el payload v2, que se relee idéntico (`c7968bd`).
3. **Deshacer perdía claves de la procedencia.** Deshacer una versión anterior perdía claves internas del `catalogue` (las marcas del censo). La edición conserva ahora todo salvo la comprobación física, igual que el backfill (`eef3519`).
4. **Precedencia de operadores en el staging.** `data->'catalogue' - 'isbnVerified'` se leía como `'catalogue' - 'isbnVerified'`. La validación de la restauración por partes fallaba con un error genérico (`1c46ac2`).
7. **Ajustes enviaba la colección ya leída.** Ajustes revisaba el archivo en el navegador y enviaba la colección en forma plana, que el servidor no podía releer con ejemplares sin ISBN-13. Importar desde Ajustes fallaba con `INVALID_INPUT`. Ahora envía el archivo tal cual (`8f3fedf`). Lo detectó `test:smoke`, que también se actualizó: el aviso habla de «Esta edición» y ofrece «Abrir el ejemplar guardado». Lo mismo se cambió en `tests/e2e/flujos/catalogo.spec.ts`, sin ejecutar.
5. **No se podía borrar una cuenta desde Auth.** La poda (SECURITY INVOKER) se ejecutaba con `supabase_auth_admin`, que no tiene acceso a `biblib`, y GoTrue no podía borrar ninguna cuenta con ejemplares. Corregido con la migración **0012** (`42b8793`), probado en `test:db` y con GoTrue real (`28`).
6. **Restos de pruebas y límite de verify.** El grupo `model` dejaba trabajos e historial de importación de B (`944a018`). Con esos restos, el primer ciclo de respaldo de 0012 falló en `db:restore:verify` (`import_previews`, `library_jobs`): restore los invalida a propósito pero verify los compara. Es una limitación anterior a la unidad y queda documentada en [recuperación](../../../../recuperacion.md#obra-edición-y-ejemplar-u-dat-06). El ciclo repetido sin restos pasó.

## Incidencias del proceso

- Durante el primer ensayo, un `db:reset:local --dry-run` repetido con el mismo `--out` sobrescribió el plan de un reset fallido. Ese plan quedó en `.biblib/state/scratch-reset.incompleto-20261025T0027Z.json` y se hizo un reset nuevo.

## Recursos que quedan

Al terminar: `db:local:down --profile scratch` (`99-down-scratch.txt`). Se conservan la red y los volúmenes `supabase_*_biblib-scratch` del perfil, la lista está en `99-docker-restante.txt`. No se tocó nada de HolaERP ni de otros perfiles.

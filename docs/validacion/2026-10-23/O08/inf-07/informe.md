# U-INF-07 · Adopción y promoción de migraciones a preproducción/producción (O08)

Fecha: 23-10-2026. Rama: `u-inf-07` (desde `feature/spec-pendientes`, `ff890a1`). Raíz: `C:/Users/ncaso/orca/workspaces/biblib/u-inf-03`. Perfil: `scratch` (`biblib-scratch`, 55340–55349).

**Resultado: preparada y ensayada en local; verificación real PENDIENTE.** No hay destino remoto autorizado: no se ha conectado con ningún proyecto Supabase, no se han leído `.env` ni credenciales y no se ha ejecutado `supabase link`, `db push` ni `config push`. Los criterios 1–8 se demuestran contra Postgres efímeros propios que simulan el remoto (TLS autofirmado para `db.<ref>.supabase.co`) y contra `scratch`. Su comprobación en preproducción/producción queda pendiente de la autorización de Néstor y de las condiciones abiertas de [docs/promocion.md](../../../../promocion.md#condiciones-abiertas-antes-de-la-primera-promoción-real).

## Implementación

| Archivo | Cambio |
| --- | --- |
| `scripts/db/remote-preflight.mjs` (nuevo) | `describeRemote` (identidad sin conectar: `--expect-project`, URL pública de Auth y conexión del mismo proyecto, pooler solo con `postgres.<ref>` y en modo sesión, base, rol, TLS `verify-full`), `connectRemote` (certificado verificado contra el host remoto), `probeRemote` (TLS según el servidor, rol, primario, permisos, propiedad, versión), `dataPreflight` (revisión previa a `0001`/`0002`), `platformFingerprint` (auth/storage), `validateBackupReceipt` y `assertReceiptMatchesDatabase`. |
| `scripts/db/adopt.mjs` (nuevo) | `analyzeAdoption`/`compareToPrefix` (equivalencia por metadatos con cada prefijo del journal: manifest, tablas y columnas del snapshot, objetos posteriores ausentes; evidencia por migración o conciliación), `applyAdoption` (solo ledger, bajo bloqueo, verificación en la misma transacción) y CLI `db:adopt:<target>` sin `--force`. |
| `scripts/db/plan.mjs` | `db:plan:preprod|prod --out --expect-project`: plan `migrate` o `adopt-ledger` en transacción `read only`; listado restringido de correcciones si hay datos incompatibles. `validatePlan` admite el tipo esperado. |
| `scripts/db/migrate.mjs` | `db:status:preprod|prod`, `db:migrate:preprod|prod` con `--backup-receipt`, `runPromotion` común a migrate/adopt (plan, identidad, recibo, rol, bloqueo, recibo frente al destino, huella de plataforma, registro en `.biblib/promotions/`), `--force` rechazado. |
| `scripts/db/target.mjs` | Objetivos `local`, `preprod`, `prod`. |
| `scripts/db/backup-local.mjs` | `receipt.json` (`biblib-backup-receipt`) con alcance Mailpit (copia RAW sin marcar leídos), rutas relativas a la raíz, `discardedStateHash` idéntico al del plan de reset, estrategia, cobertura y ensayo; `--receipt-of <carpeta>` lo reemite tras `db:restore:verify`. |
| `package.json` | Al final: `db:status|plan|migrate|adopt:preprod|prod`. |
| `tests/scripts/promotion.test.mjs` (nuevo) | 16 pruebas sin Docker. |
| `tests/scripts/promotion-stack.test.mjs`, `promotion-harness.mjs` (nuevos) | 8 escenarios `[stack]` contra Postgres 17 efímero con TLS; certificado X.509 generado en JS (sin openssl). |
| `docs/promocion.md` (nuevo), `docs/operacion.md` (sección propia) | Procedimiento, contratos, pérdida de escrituras, condiciones abiertas y aceptación. |

Cambios fuera del alcance de la unidad, **acordados con el coordinador** (respuesta A a `orca orchestration ask`) y aislados en sus commits:

- `61389b2` `scripts/db/restore-local.mjs`: `classifyDestination` no cuenta como datos del destino las tablas derivadas/regenerables (`library_state`, previews y caché/cuotas del catálogo). Desde `0003`, el seed crea `library_state` para A/B y `db:restore:local` rechazaba cualquier scratch recién reseteado (6). `library_operations` sigue contando.
- `25bad82` y `d19cee4` `scripts/lib/backup-db.mjs`: al verificar, `library_state` excluye también `rotated_xact` (la rotación de `books.version` dispara el trigger de `0003`) y usa `user_id` como clave natural (sin `id`, la clave era la fila entera, con los tokens rotados).
- `tests/scripts/backup.test.mjs` (pruebas de los dos arreglos) y `tests/scripts/migrations.test.mjs` (`d7de7b4`: la prueba «preprod/prod pendientes de U-INF-07» pasa a comprobar el contrato nuevo).

## Ensayo contra el remoto simulado

`BIBLIB_INF07_EVIDENCE=… node --test tests/scripts/promotion-stack.test.mjs` (`stack-tests.txt`, 8/8, 65 s). Cada ejecución arranca `postgres:17-alpine` propio (`biblib.unit=u-inf-07-ensayo`, `127.0.0.1::5432`), con certificado para `db.inf07ensayoremoto001.supabase.co` y el sustituto mínimo de Auth de `test:db`, y lo elimina por ID al terminar. El runner verifica el certificado contra ese nombre; solo la resolución del host se redirige mediante una dependencia que la CLI no expone. El respaldo del «remoto» y su ensayo de restauración en otro contenedor usan un productor de recibos **solo de ensayo** con el mismo contrato.

| # | Escenario | Resultado | Evidencia |
| --- | --- | --- | --- |
| 1 | `status`/`plan` sobre base vacía | 0; pendientes `0000`…`0004`; ningún esquema `biblib`/`drizzle` creado; plan sin credenciales | `01-*.json` |
| 2 | Ref ajena, sin `SSLMODE`, `require`, host de otro proyecto, rol `authenticated`, certificado de otro proyecto, servidor sin TLS → **3**; plan de otro commit, sin recibo, recibo sin ensayo → **6**; recibo de `prod` usado en `preprod` → **3**; plan de otro head (destino ya avanzado) → **6** | Ledger y hechos de catálogo idénticos tras los 11 rechazos | `02-rechazos-antes-de-ddl.json` |
| 3 | Copia equivalente a `0000` (SQL + ledger de Drizzle antiguo, datos A/B con IDs fijos) | 0; `0000`→`0004`; 138 comprobaciones del manifest; IDs y datos idénticos; `books.version` rota; FK de propietario rechaza estantería ajena (23503); RLS A ve 2 y B 1, 0 ajenas actualizadas; claims y rol locales a la transacción (`postgres`, sin claims después); `auth`/`storage` sin cambios | `03-*.json` |
| 4 | Datos incompatibles con `0001` (estantería de otro propietario, 200000 páginas, título vacío) | **5**, sin plan; listado restringido con ID, propietario seudonimizado y corrección propuesta; ISBN duplicado normalizado como aviso; datos sin cambios | `04-*.json` |
| 5 | Esquema manual sin ledger equivalente a `0002` | `status` **5** `adoption-required`, demostrable hasta `0002`; plan `adopt-ledger`; usarlo con migrate → **6**; `adopt` → 0, 3 filas exactas, hechos de `biblib` y datos idénticos; repetir → **6**; recibo previo con migrate → **6**; recibo nuevo → `0003`/`0004` aplicadas | `05-*.json` |
| 6 | Esquema de `0002` sin trigger | plan **5** con conciliación (`trigger.books_rotate_version`); `adopt` con un plan previo al drift → **5** bajo bloqueo; sin ledger | `06-drift-sin-trigger.json` |
| 7 | `0005` que falla en su segundo paso | **9**, «revertido: el ledger no avanzó», objeto de prueba ausente, registro con código 9; el respaldo previo restaurado en copia aislada: ledger, manifest y hechos idénticos | `07-*.json` |
| 8 | Dos `migrate` simultáneos con el mismo plan | Códigos `[0, 6]`; 5 filas de ledger | `08-concurrencia.json` |

## Ensayo en `scratch` con las herramientas de U-OPS-02

Tercer intento (`scratch/`), con los arreglos anteriores. Los dos primeros quedan como evidencia de los defectos (`scratch-intento1/`: restore rechazado por `library_state`; `scratch-intento2/`: verify con discrepancia en `library_state`).

| Paso | Exit | Evidencia |
| --- | --- | --- |
| `db:status:local` | 0, `up-to-date` (`0004`) | `00-status.json` |
| `db:reset:local --dry-run` | 0 | `01-reset-plan.json` |
| `db:backup:local` | 0; `discardedStateHash` **igual** al del plan; 4 archivos (dominio, Auth, objeto Storage, mensaje Mailpit) | `02-backup.json` |
| `db:reset:local --apply --backup-receipt` (respaldo aún sin ensayo) | **6** | `03-*.json` |
| Fallo: `drop trigger books_rotate_version` → `db:status:local` | **5**, `drift` | `04-fallo-drift.json` |
| `db:reset:local` (plan nuevo, `--discard-local-data`) | 0 | `05a/05b-*.json` |
| `db:restore:local` | 0; 9 versiones y 2 revisiones rotadas; escritura antigua rechazada | `06-restore.json` |
| `db:restore:verify` | 0; 29 comprobaciones, 0 discrepancias; ledger, manifest (RLS, políticas, función, trigger), sesiones GoTrue reales de A y B con los IDs restaurados (5/3 y 4/3 propias, 0 ajenas); recuperación 11,6 s | `07-verify.json` |
| `db:status:local` | 0, `up-to-date`, trigger conforme; `library_state` una fila por propietario | `08-status.json` |
| `db:backup:local --receipt-of` | 0; recibo con ensayo superado | `09-*.json`, `11-receipt.json` |
| `reset-acepta-recibo.mjs` (sin modificar nada) | `validateResetBackup` acepta el recibo frente al plan real del paso 2 y lo rechaza con otro estado (6); `validateBackupReceipt` lo acepta y rechaza otro destino (3) | `10-reset-acepta-recibo.json` |

Con un único perfil, el reset del mismo stack no puede usar un recibo recién creado: `db:reset:local` exige un ensayo superado y `db:restore:local` exige un destino vacío. El orden válido es el ensayado (renuncia local explícita y restauración posterior) o ensayar el respaldo en otro perfil.

## Aceptación (01 · U-INF-07)

| # | Local (simulado) | Real |
| --- | --- | --- |
| 1 | Demostrado (escenario 2) | **Pendiente** |
| 2 | Demostrado (escenarios 1 y 5) | **Pendiente** |
| 3 | Demostrado (escenario 3) | **Pendiente** |
| 4 | Demostrado (escenarios 5 y 6) | **Pendiente** |
| 5 | Aislamiento A/B con claims (escenario 3) y sesiones GoTrue reales tras restaurar (`scratch`). Edición/importación/conflicto **en preproducción**: no ensayable sin preproducción | **Pendiente** |
| 6 | Demostrado (registro en escenarios 3, 5, 7; concurrencia en 8) | **Pendiente** |
| 7 | Demostrado (escenario 3: claims locales; huella de `auth`/`storage` igual) | **Pendiente** |
| 8 | Demostrado (escenario 7 y `scratch`); pérdida de escrituras documentada | **Pendiente** |

## Validación

| Comando | Resultado |
| --- | --- |
| `pnpm lint` | 0 (`lint.txt`) |
| `pnpm typecheck` | 0 (`typecheck.txt`) |
| `pnpm test` | 169/169 (`test.txt`) |
| `pnpm test:scripts` | 180/180 con `scratch` arrancado: incluye `promotion.test.mjs`, el ensayo `[stack]` de promoción y las pruebas `[stack]` de otras unidades (`test-scripts.txt`) |
| `pnpm test:db` | 0, contenedor efímero propio (`test-db.txt`) |
| HolaERP | `holaerp-before.jsonl` = `holaerp-after.jsonl`: 11 contenedores (IDs, arranque, reinicios, imagen), 3 redes y 7 volúmenes idénticos |

## Recursos y secretos

- `pnpm db:local:down --profile scratch` (`down.json`). Quedan la red `biblib-scratch-network` y los volúmenes `supabase_db_biblib-scratch` y `supabase_storage_biblib-scratch` (`recursos-finales.txt`). Los contenedores `biblib-test` son de U-QA-02 y no se tocaron. No quedan contenedores de ensayo de U-INF-07.
- En `.biblib/` (ignorado): respaldos `20261023T165611Z-scratch-ea6b04`, `20261023T170309Z-scratch-e6232e` y `20261023T170545Z-scratch-554a07` (este con ensayo superado) y planes `inf07-reset-p*.json`. Las pruebas borran sus planes, respaldos y registros.
- Las evidencias contienen IDs ficticios, hashes, huellas y el host ficticio del ensayo; ninguna credencial, JWT ni URL con usuario (revisado). El único «service_role» es el texto del método de Storage del recibo.

## Pendiente y avisos

- Verificación real en preprod/prod: autorización de Néstor, referencia real de cada proyecto (preproducción no existe), estado real de la base, plan del proveedor (sin presuponer PITR), permisos del rol `postgres` alojado, conectividad (IPv6/pooler) y CA.
- Productor real de recibos remotos (`db:backup:prod`, U-OPS-02 + proveedor); el del ensayo no es apto para producción.
- Edición, importación y conflicto en preproducción (criterio 5) y automatización en CI (U-QA-04).
- `docs/recuperacion.md` (U-OPS-02) aún dice que el recibo no satisface `--backup-receipt` de reset: quedó resuelto con `receipt.json`; conviene que su responsable lo actualice. La sección «Migraciones» de `docs/operacion.md` también dice que preprod/prod salen con 2; la nueva sección de U-INF-07 lo sustituye explícitamente.

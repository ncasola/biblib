# U-OPS-02 · Respaldo administrativo y restauración ensayada (O07)

Fecha: 23-10-2026. Rama: `u-ops-02` (desde `feature/spec-pendientes`, `64b8189`). Raíz: `C:/Users/ncaso/orca/workspaces/biblib/u-inf-03`. Perfil: `scratch` (`biblib-scratch`, 55340–55349).

**Resultado: completado en local.** Copia cifrada de esquema, datos, historial, identidades Auth y objetos Storage; restauración en un scratch recién reseteado y verificación sin discrepancias. Los ensayos de clave ausente, destino no vacío, proyecto ajeno, objeto borrado del respaldo y objeto ausente en el destino fallan con el código esperado. Procedimiento: [docs/recuperacion.md](../../../../recuperacion.md).

## Implementación

- `scripts/db/backup-local.mjs` (`db:backup:local`, `db:backup:prod`), `scripts/db/restore-local.mjs` (`db:restore:local`), `scripts/db/restore-verify.mjs` (`db:restore:verify`).
- Helpers nuevos: `scripts/lib/backup-files.mjs` (rutas fuera de Git, recibo sellado, inventario, AES-256-GCM, clave externa), `scripts/lib/backup-db.mjs` (marcas, hashes por tabla, hechos de catálogo, huellas de tokens, inventario Storage, rotación posterior) y `scripts/lib/backup-process.mjs` (procesos sin shell, binarios, entrada por stdin).
- Reutiliza sin modificarlos `resolveSeedTarget`, `assertResetIdentity`, el bloqueo del perfil y el consultivo de migraciones, `inspectDatabase`/manifest de U-INF-04, el registro de fixtures y `signInFixture`.
- Los objetos esperados se derivan de `scripts/db/objects-manifest.mjs` y del catálogo real del origen: no hay una lista propia de tablas, por lo que el mismo código sirve con `0002` y con la `0003` de U-DAT-01.

## Ensayo real (`ensayo.json`)

Harness privado `.biblib/o07-ops02-ensayo.mjs` (ignorado por Git). La clave de 32 bytes se generó fuera del repositorio y solo aparece como `<clave externa>`.

| Paso | Exit (esperado) | Resultado y evidencia |
| --- | --- | --- |
| Datos no fixture | — | Además del censo A/B y la ficha manual de A: bucket privado `biblib-ops02-ensayo` con 2 objetos (uno con espacios y paréntesis en el nombre) y una ficha manual de B. |
| `db:backup:local --encrypt-key-file` | 0 (0) | 10 libros, 6 estanterías, 3 migraciones, 2 usuarios/identidades, 2 buckets, 3 objetos; 5 archivos cifrados; 3,8 s. `01-backup.json`, recibo `11-recibo.json`. |
| Restore sin `--key-file` | 6 (6) | «falta la clave de recuperación», antes de mirar el destino. `02-restore-sin-clave.json`. |
| Restore sobre scratch con datos | 6 (6) | «El destino no está vacío ni recién reseteado». `03-restore-destino-no-vacio.json`. |
| Restore con `--expect-project holaerp` | 3 (3) | Identidad ajena; nada modificado. `04-restore-proyecto-ajeno.json`. |
| `db:reset:local` dry-run + apply `--discard-local-data` | 0 / 0 (0) | Reconstrucción física; el seed crea cuentas A/B con IDs nuevos. `05-reset.json`. |
| `db:restore:local --key-file` | 0 (0) | 6,1 s; `books.version` rotada en 10 fichas; escritura condicional con una versión del respaldo: 0 filas. `06-restore.json`. |
| `db:restore:verify` | 0 (0) | 21 comprobaciones, 0 discrepancias; recuperación (restore + verify) 14,7 s. `07-verify-informe.json`. |
| Copia del respaldo sin un objeto Storage → restore | 11 (11) | Detectado en la integridad previa; destino intacto. `08-restore-respaldo-sin-objeto.json`. |
| Misma copia → verify | 11 (11) | `backup.file.missing`. `09-verify-respaldo-sin-objeto.json`. |
| Objeto retirado del destino → verify | 11 (11) | `storage.objects` 2/3 y objeto ausente. `10-verify-destino-sin-objeto.json`. |
| HolaERP | — | 11 contenedores, 3 redes y 7 volúmenes idénticos antes/después (`holaerp-before.json`, `holaerp-after.json`); IDs, arranques y reinicios iguales también al final de la sesión. |

Comprobaciones de `07-verify-informe.json`: archivos del respaldo; recibo del restore; ledger; manifest U-INF-04 (37 comprobaciones de RLS, políticas, grants, FK, índices, columnas, función y trigger); hechos de catálogo idénticos al origen; cantidades/claves/contenido de `biblib.books`, `biblib.shelves`, `drizzle.__drizzle_migrations`, `auth.users`, `auth.identities`, `auth.mfa_factors`, `auth.webauthn_credentials`, `storage.buckets` y `storage.objects`; 10 tokens rotados sin coincidencias; muestra de 5 fichas; sesiones GoTrue reales de A y B con los IDs **restaurados** (no los del seed posterior al reset), RLS con sus claims (5 libros y 3 estanterías propias cada una, 0 ajenas, actualizar lo ajeno afecta 0 filas); 2 buckets privados y 3 objetos con su sha256.

`11-recibo.json` es el recibo del respaldo sin los hechos de catálogo (solo su hash) y con las huellas de tokens resumidas. `restoreVerification` apunta al ensayo superado; `lastRehearsal`, al fallo deliberado del destino, que no desacredita la copia.

## Validación

| Comando | Resultado |
| --- | --- |
| `pnpm lint` | 0 (`lint.txt`). |
| `pnpm typecheck` | 0 (`typecheck.txt`). |
| `pnpm test` | 66/66 (`test.txt`). |
| `pnpm test:scripts` | 140/140, incluidas las 15 de `tests/scripts/backup.test.mjs` y las pruebas `[stack]` sobre scratch ya restaurado (`test-scripts.txt`). |
| `pnpm test:db` | 0, contenedor efímero propio (`test-db.txt`). |

`tests/scripts/backup.test.mjs` (sin Docker): `db:backup:prod` → 2; argumentos remotos (`--db-url`, `--linked`, `--project-ref`, perfiles desconocidos) → 2; carpeta de respaldos fuera de Git; clave externa (formato, ubicación, ausencia) y cifrado autenticado; recibo sellado y origen remoto; objeto ausente/alterado y rutas fuera del respaldo; restore con objeto ausente (11), sin clave u otra clave (6), proyecto ajeno, `BIBLIB_TARGET=prod` y perfil no scratch desde un worktree (3); prefijo del journal; destino recién reseteado; comparación de verify; referencia del ensayo; exclusiones de Auth y ejecución por stdin.

## Recursos y secretos

- `pnpm db:local:down --profile scratch` (`down.json`): sin contenedores scratch. Quedan la red `biblib-scratch-network` y los volúmenes `supabase_db_biblib-scratch` y `supabase_storage_biblib-scratch` (`recursos-finales.txt`), como en olas anteriores.
- Los respaldos del ensayo y sus copias manipuladas quedan en `.biblib/backups/` (ignorado). La clave está fuera del repositorio. El CLI no dejó contenedores transitorios.
- Las evidencias se revisaron en busca de JWT, claves `sb_secret`, URLs con credenciales y contraseñas: ninguna. Contienen IDs ficticios, hashes, cantidades y la huella de la clave.
- Al terminar había un contenedor `biblib-smoke-*` en marcha de otra unidad; no se tocó.

## Fuera de alcance o pendiente

- Procedimiento remoto y `db:backup:prod` real: U-INF-07 y plan del proveedor.
- El recibo no satisface aún el adaptador `--backup-receipt` de `db:reset:local` (pide alcance `mailpit`, rutas relativas a la raíz y `discardedStateHash` de su plan). Integración pendiente para U-INF-06/07.
- Automatización periódica, retención efectiva y procesamiento en streaming de volúmenes grandes (P2).
- Las tablas de previews/leases/idempotencia de futuras unidades se detectan por nombre/columnas; las de idempotencia quedan para revisión manual hasta que exista su contrato.

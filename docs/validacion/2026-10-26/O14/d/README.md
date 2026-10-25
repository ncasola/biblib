# Evidencia O14 · lote D (`0015_reading_and_loans`)

Archivos de esta carpeta (salidas reales, sin secretos ni datos de biblioteca personales; las cuentas son desechables `o13d-…@biblib.test` del harness compartido o fixtures del censo):

| Archivo | Qué acredita |
| --- | --- |
| `holaerp-antes.txt` / `holaerp-despues.txt` | Contenedores, redes y volúmenes `*holaerp*` antes y después: idénticos (HolaERP estaba parado y no se arrancó ni se tocó). |
| `scratch-0014-antes.json` | Recuentos de scratch en 0014 con datos (2 cuentas, 9 ejemplares, 2 `read`) y huella de `id:status:version:updated_at` de todos los ejemplares. |
| `scratch-migracion-0014-0015.txt` | `db:migrate:local` 0014 → 0015 con datos. |
| `scratch-0015-sin-backfill.json` | Tras 0015: misma huella de ejemplares y 0 ciclos, entradas y préstamos (sin backfill del estado legado). |
| `scratch-status-0015.txt` | `db:status:local` sin pendientes ni drift. |
| `grupo-*.log` | Grupos de integración en scratch (`reading-loans`, `product`, `account`, `snapshots`, `restore`, `model`, `security`). |
| `ensayo-*.txt` / `.json` | Ensayo respaldo → reset (desde vacío, head 0015) → restore → verify con ciclos, entradas y préstamos poblados. |
| `validacion-*.txt` | lint, typecheck, `pnpm test`, `test:scripts`, `test:db`, build y smoke. |

Informe: [informe.md](informe.md).

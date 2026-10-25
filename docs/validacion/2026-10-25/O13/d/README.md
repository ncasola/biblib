# Evidencia O13 · lote D (`0014_product_batch_o13`)

Archivos de esta carpeta (salidas reales, sin secretos ni datos de biblioteca personales; las cuentas son desechables `o13d-…@biblib.test` o fixtures del censo):

| Archivo | Qué acredita |
| --- | --- |
| `holaerp-antes.txt` / `holaerp-despues.txt` | Contenedores, redes y volúmenes `*holaerp*` antes y después: idénticos. |
| `scratch-0013-antes.json` | Recuentos de scratch en 0013 tras `db:reset:local` con seed y la cuenta de ensayo (procedencias variadas y una copia comprobada). |
| `scratch-migracion-0013-0014.txt` | `db:migrate:local` 0013 → 0014 con datos, verificado. |
| `scratch-0014-backfill.json` | Backfill: una evidencia por edición, una comprobación física solo para la copia comprobada, URL solo donde constaba, ninguna foto. |
| `scratch-status-0014.txt` | `db:status:local` sin pendientes ni drift (780 comprobaciones). |
| `grupo-*.log` | Grupos de integración en scratch (`product`, `account`, `snapshots`, `restore`, `model`, `security`). |
| `ensayo-*.txt` / `.json` | Ensayo respaldo → reset (desde vacío, head 0014) → restore → verify con entidades nuevas pobladas. |
| `validacion-*.txt` | lint, typecheck, `pnpm test`, `test:scripts`, `test:db`, build y smoke. |

Informe: [informe.md](informe.md).

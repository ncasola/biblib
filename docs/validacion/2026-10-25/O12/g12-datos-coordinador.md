# Puerta G12 · parte de datos (U-DAT-06)

**Fecha:** 25 de octubre de 2026 · **Commit:** `4381a0c` en `feature/spec-pendientes` (head `0012_model_account_deletion`) · **Coordinador:** Run de Orca `run_a30695704f5a`.

| Comprobación | Resultado |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | correctos |
| `pnpm test` | 356/356 |
| `pnpm test:scripts` | 249 superadas, 4 omitidas con motivo |
| `pnpm test:db`, `pnpm build` y `pnpm test:smoke` | correctos |
| `db:local:bootstrap --profile test` | `passed`, head `0012` (13/13) |
| `pnpm test:integration:local` (perfil `test`, con el grupo `model`) | 122/122 |
| `pnpm test:integration:security --profile test` | 23/23 |
| `pnpm test:e2e:local` (Chromium) | 40 superados, 0 fallidos, 19 `fixme` de unidades futuras |

Criterios de G12 (datos) acreditados por U-DAT-06 (`docs/validacion/2026-10-24/O12/dat-06/`) y por esta ejecución integrada:

- Las 111 fichas sintéticas conservan IDs, ubicación, estado y fuentes.
- Los ISBN-10/13 equivalentes no descartan filas.
- Dos copias comparten edición y conservan estados independientes.
- Sin ISBN, la edición guarda `null`.
- La ida y vuelta en v2 no pierde datos.

## Incidencias resueltas por el coordinador

- **Docker «no disponible» con el motor sano:** el inventario inspeccionaba 521 volúmenes en una sola llamada y superaba el límite de la línea de comandos de Windows. Se corrigió inspeccionando por lotes, y `test:db`, el smoke y el harness de promoción retiran ahora el volumen anónimo de su Postgres efímero (`a970885`). Néstor autorizó borrar los 505 volúmenes anónimos colgantes; quedan solo volúmenes con nombre.
- **E2E adaptado al modelo nuevo:** el alta manual usa `createEditionAction`, y el movimiento de un libro usa el selector `#book-shelf`, porque la ficha muestra también «Añadir otro ejemplar» (`4381a0c`).

La parte de cuenta de G12 (U-OPS-03) se registra al integrar esa unidad.

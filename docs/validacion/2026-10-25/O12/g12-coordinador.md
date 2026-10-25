# Puerta G12 · Coordinador (O12 completa)

**Fecha:** 25 de octubre de 2026 · **Commit:** `06e76b6` en `feature/spec-pendientes` (head `0013_account_deletion`) · **Run de Orca:** `run_a30695704f5a`.

O12 integra **U-DAT-06** (obra, edición y ejemplar; ISBN opcional) y **U-OPS-03** (eliminación de cuenta y retención). La parte de datos ya pasó en `4381a0c` ([g12-datos-coordinador.md](g12-datos-coordinador.md)). Esta ejecución vuelve a validar todo con las dos unidades integradas.

| Comprobación | Resultado |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | correctos |
| `pnpm test` | 368/368 |
| `pnpm test:scripts` | 255 superadas, 4 omitidas con motivo |
| `pnpm test:db`, `pnpm build`, `pnpm check:bundle --forbid-local-login` y `pnpm test:smoke` | correctos |
| `db:local:bootstrap --profile test` | `passed`, head `0013_account_deletion` |
| `pnpm test:integration:local` (perfil `test`, incluye los grupos `model` y `account`) | 132/132 |
| `pnpm test:integration:security --profile test` | 23/23 |
| `pnpm test:e2e:local` (Chromium) | 40 superados, 0 fallidos, 19 `fixme` de unidades futuras |

## Criterios de cuenta de G12

U-OPS-03 los acredita en `docs/validacion/2026-10-25/O12/ops-03/`, y esta ejecución los confirma en el perfil `test`:

- **Borrado propio, idempotente y reintentable:**
  - La solicitud usa siempre la cuenta autenticada.
  - Un doble clic devuelve el mismo estado.
  - Un worker interrumpido o con Storage caído queda pendiente y se puede reintentar sin recrear datos.
- **Un JWT antiguo y un worker vencido no recrean datos:**
  - Las acciones responden `ACCOUNT_INACTIVE`.
  - RLS restrictiva bloquea las escrituras por Data API y por Storage.
  - GoTrue bloquea tanto un inicio de sesión nuevo como un refresh antiguo.
- **Un backup restaurado aplica las supresiones antes de abrir:** la cuenta suprimida no resucita y B no cambia.

## Decisión del worker, aceptada por el coordinador

GoTrue `admin.signOut` exige el JWT del propio usuario, y el proceso administrativo no debe guardarlo. La revocación queda así:

1. La acción hace un logout global con la sesión del usuario.
2. El worker administrativo, fuera de Next, banea la cuenta.
3. Al terminar, el worker borra la identidad con `admin.deleteUser`.

Mientras tanto, la guarda de cuenta activa bloquea cualquier JWT que siga vivo.

## Límites anotados

- La copia offline (U-EXP-08) y las tablas de F3 quedan solo anotadas en `docs/retencion.md`.
- La regla de sesión reciente (>15 min) se prueba con claims simulados.

# Puerta G06 · salida de F0

**Fecha:** 23 de octubre de 2026 · **Commit:** `011c627` en `feature/spec-pendientes` · **Ejecutada por:** coordinador de la Run de Orca `run_9216ea6502cb`.

## Validación del código integrado

| Comprobación | Resultado |
| --- | --- |
| `pnpm lint` | 0 errores |
| `pnpm typecheck` | correcto |
| `pnpm test` | 66/66 |
| `BIBLIB_SKIP_STACK_TESTS=1 pnpm test:scripts` | 120/120 |
| `pnpm test:db` (Postgres efímero) | correcto |
| `pnpm build` (placeholders públicos de CI) | correcto |

## Recorrido real con el perfil `test`

Ejecutado desde el worktree `u-qa-01`, avanzado a `011c627`:

1. `pnpm db:local:bootstrap --profile test` → `passed` en `preflight → stack → env → migrate → seed → verify`; head `0002_book_versions` (3/3, `up-to-date`).
2. `pnpm test:integration:local` → **34 escenarios superados, 0 fallidos** (GoTrue, Postgres, Storage y app Next reales; aislamiento A/B, anónimo, sesiones, RLS, trigger de versión, Storage firmado).
3. `pnpm db:local:down --profile test` → stack parado, volúmenes conservados.
4. Contenedores de HolaERP (ID y nombre) idénticos antes y después: 11.

## Lo que esta puerta no demuestra

- **Clon limpio:** no se ejecutó en un clon nuevo; cada fase se ensayó en worktrees hijos sin archivos privados (O02–O06). Los perfiles están ligados a la raíz del checkout, así que un clon nuevo necesita un perfil libre o el reset de su propio stack.
- **Bindings en loopback:** no se cumplen. Docker Desktop publica en `0.0.0.0`; `doctor` lo avisa y las alternativas A/B están en `docs/operacion.md`, pendientes de decisión.
- **Fuera de F0:** Google OAuth real, destinos remotos y Linux nativo/CI (U-QA-02/04, U-INF-07).
- **Hallazgos abiertos de U-QA-01:** registrados en `unidades.json`.

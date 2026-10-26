# Orquestación de F2 con Orca

**Versión:** 1.0 · **Fecha:** 24 de octubre de 2026 · **Estado:** en ejecución: O11 cerrada ([G11](../validacion/2026-10-24/O11/g11-coordinador.md)), O12 cerrada ([G12](../validacion/2026-10-25/O12/g12-coordinador.md)) y O13 cerrada ([G13](../validacion/2026-10-25/O13/g13-coordinador.md)): **F2 completa**.

Plan operativo de la fase F2, olas O11–O13: restauración conjunta, assets privados, accesibilidad, modelo obra/edición/ejemplar y ciclo de vida de cuenta. Las funciones de producto de O13 se solapan con F3.

Siguen vigentes las reglas de [orquestación de F0](orquestacion-f0.md) (§0 y §1) y de [F1](orquestacion-f1.md): una migración por ola, perfiles con un solo dueño y limpieza de worktrees al fusionar. Las unidades y su aceptación están en [02](02-datos-importacion-y-catalogacion.md), [03](03-experiencia-y-funciones.md) y [04](04-calidad-seguridad-y-operacion.md). Run de Orca: `run_a30695704f5a`.

## Decisiones de Néstor

- **24-10-2026 · Imágenes:** se autoriza `sharp`, con `allowBuilds: sharp: true` en `pnpm-workspace.yaml`, como decodificador de U-DAT-10. Ya era dependencia, bajo el override de seguridad `>=0.35.5`. También vuelve a habilitar la optimización de `next/image`.

- **24-10-2026 · Worktrees de stack:** se mantienen los dos worktrees dueños de perfil, renombrados en Orca como `stack-scratch` (antes `u-inf-03`) y `stack-test` (antes `u-qa-01`). Cada unidad con stack trabaja en ellos en su propia rama, porque el ciclo de vida liga cada perfil a la raíz del checkout.

## Olas y agentes

| Ola | Unidad | Agente | Stack | Schema |
| --- | --- | --- | --- | --- |
| O11 | U-DAT-04 Restauración multipart atómica (+ T1 de rendimiento) | Claude (Opus) | `scratch` | `0008` |
| O11 | U-EXP-03 Accesibilidad verificada (+ T6) | Codex | `test` | No (axe en el lockfile) |
| O11 | U-DAT-10 Assets privados y portadas seguras | Claude (Opus) | `scratch` | `0009` y `sharp` |
| O12 | U-DAT-06 Obra, edición y ejemplar; ISBN opcional (+ T5/T7) | Claude (Opus) | `scratch` | `0010`–`0012` |
| O12 | U-OPS-03 Eliminación de cuenta y retención | Claude (Opus) | `scratch` | `0013` |
| O13 · 1 | O13-D Lote de schema de producto: tags/notas/valoración, ubicaciones físicas y fotos, series, avatar, evidencia/incidencias de revisión y mapeo CSV; v2, snapshots, restore, eliminación y permisos | Claude (Opus) | `scratch` | `0014` (único head de la ola) |
| O13 · 1 | U-EXP-05 Alta consecutiva y escáner ISBN (dueña de `BookForm` en el paso 1) | Codex (OpenCode se quedó sin cuota) | No | No |
| O13 · 1→2 | U-DAT-09 CSV con mapeo: fase 1 parser/mapeo/normalización sin escrituras; fase 2 integración tras `0014` | Codex | Fase 2 | Consume `0014` |
| O13 · 2 | U-DAT-07 Bandeja de revisión | Claude (Opus) | `scratch` | Consume `0014` |
| O13 · 2 | U-PRO-03 Ubicación física y fotos | Claude (Opus) | `test` | Consume `0014` |
| O13 · 2 | U-PRO-05 Series y volúmenes | Claude (Sonnet) | No | Consume `0014` |
| O13 · 2 | U-PRO-01 Notas, etiquetas y valoración (dueña de `BookForm` en el paso 2) | Codex | No | Consume `0014` |
| O13 · 2 | U-EXP-06 Avatar y `lib/media/server.ts` compartido | Codex | No | Consume `0014` |
| O13 · 3 | O13-FIX Fallos de G13 en el stack real | Claude (Opus) | `test` | No |

## Puertas

- **G11:** un conjunto de 2001 registros se publica entero o no se publica; si faltan o se alteran partes, cero cambios activos. Snapshots, IDs y estantería predeterminada coherentes. El banco de pruebas de hasta 10000 cumple el presupuesto o rechaza sin commits parciales. Los assets bloquean SSRF, XML/SVG, archivos inválidos y accesos ajenos. Recorridos a 320, 375, 768 y 1440 px, con teclado, zoom y ambos temas, con evidencia.
- **G12–G13:** según [05](05-fases-olas-y-trazabilidad.md).

## O13 · Orden

Siguiendo el orden de 05:

1. D publica un único lote `0014` con las tablas y contratos de producto de toda la ola, para no abrir varios heads de Drizzle, y fija el contrato en `contratos-o13.md`. En paralelo, U-EXP-05 (sin schema) y la fase 1 de U-DAT-09 (parseo y fixtures).
2. Con `0014` integrado, las unidades de producto y revisión implementan acciones y UI sobre el contrato. Nunca editan `BookForm` dos unidades a la vez: U-PRO-01 lo toma después de U-EXP-05.
3. Lección: los grupos de integración escritos sin stack fallaron la primera vez contra Supabase real (harness, permisos y aislamiento). O13-FIX los corrigió antes de la puerta. En adelante, cada unidad sin stack recibe un turno en un perfil antes de su `worker_done`.

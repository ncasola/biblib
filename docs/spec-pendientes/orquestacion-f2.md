# Orquestación de F2 con Orca

**Versión:** 1.0 · **Fecha:** 24 de octubre de 2026 · **Estado:** en ejecución (O11).

Plan operativo de la fase F2, olas O11–O13: restauración conjunta, assets privados, accesibilidad, modelo obra/edición/ejemplar y ciclo de vida de cuenta. Las funciones de producto de O13 se solapan con F3.

Siguen vigentes las reglas de [orquestación de F0](orquestacion-f0.md) (§0 y §1) y de [F1](orquestacion-f1.md): una migración por ola, perfiles con un solo dueño y limpieza de worktrees al fusionar. Las unidades y su aceptación están en [02](02-datos-importacion-y-catalogacion.md), [03](03-experiencia-y-funciones.md) y [04](04-calidad-seguridad-y-operacion.md). Run de Orca: `run_a30695704f5a`.

## Decisiones de Néstor

- **24-10-2026 · Imágenes:** se autoriza `sharp`, con `allowBuilds: sharp: true` en `pnpm-workspace.yaml`, como decodificador de U-DAT-10. Ya era dependencia, bajo el override de seguridad `>=0.35.5`. También vuelve a habilitar la optimización de `next/image`.

## Olas y agentes

| Ola | Unidad | Agente | Stack | Schema |
| --- | --- | --- | --- | --- |
| O11 | U-DAT-04 Restauración multipart atómica (+ T1 de rendimiento) | Claude (Opus) | `scratch` | `0008` |
| O11 | U-EXP-03 Accesibilidad verificada (+ T6) | Codex | `test` | No (axe en el lockfile) |
| O11 | U-DAT-10 Assets privados y portadas seguras | Tras U-DAT-04 | — | `0009` y `sharp` |
| O12 | U-DAT-06 Obra, edición y ejemplar; ISBN opcional (+ T5/T7) | Por fijar | — | Sí |
| O12 | U-OPS-03 Eliminación de cuenta y retención | Por fijar | — | Tras U-DAT-06 |
| O13 | U-DAT-07, U-DAT-09, U-EXP-05, U-EXP-06, U-PRO-01, U-PRO-03, U-PRO-05 | Por fijar | — | Un lote de schema revisado (D) |

## Puertas

- **G11:** un conjunto de 2001 registros se publica entero o no se publica; si faltan o se alteran partes, cero cambios activos. Snapshots, IDs y estantería predeterminada coherentes. El banco de pruebas de hasta 10000 cumple el presupuesto o rechaza sin commits parciales. Los assets bloquean SSRF, XML/SVG, archivos inválidos y accesos ajenos. Recorridos a 320, 375, 768 y 1440 px, con teclado, zoom y ambos temas, con evidencia.
- **G12–G13:** según [05](05-fases-olas-y-trazabilidad.md).

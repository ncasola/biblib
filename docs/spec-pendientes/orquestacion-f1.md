# Orquestación de F1 con Orca

**Versión:** 1.0 · **Fecha:** 23 de octubre de 2026 · **Estado:** en ejecución: O07–O09 cerradas (G07/G08/G09); O10 en curso.

Plan operativo de la fase F1 (O07–O10): integridad de colección, proveedores bibliográficos, cuotas, trabajos y recuperación. Las reglas comunes (§0) y el contrato de F0 (§1) de [orquestación de F0](orquestacion-f0.md) siguen vigentes; este documento solo añade lo propio de F1. Unidades y aceptación: [02](02-datos-importacion-y-catalogacion.md), [03](03-experiencia-y-funciones.md), [04](04-calidad-seguridad-y-operacion.md), [01](01-entorno-y-migraciones.md) y [06](06-proveedores-bibliograficos.md).

## Reglas añadidas en F1

1. **Migraciones:** una sola unidad por ola escribe `lib/db/schema.ts` y una migración nueva, numerada de forma consecutiva (`0003`, `0004`…). Ninguna otra unidad genera migraciones en esa ola.
2. **Errores de dominio:** `lib/domain-errors.ts` y `lib/action-result.ts` los extiende la unidad de datos de la ola. Las demás usan sus propios tipos discriminados o preguntan.
3. **Stacks:** cada perfil pertenece a un único worktree: `scratch` a `u-inf-03` y `test` a `u-qa-01`. Las unidades que necesitan stack reutilizan esos worktrees con una rama nueva por unidad. Las demás trabajan en worktrees nuevos sin Docker.
4. **Agentes:** OpenCode Go sin cuota → sus unidades pasan a Codex (decisión de Néstor). Se vuelve a OpenCode cuando la cuota se recupere.
5. **Limpieza:** al fusionar una unidad se elimina su worktree y su rama, salvo los dos worktrees dueños de perfiles.

## Olas y agentes

| Ola | Unidad | Agente | Stack | Toca schema |
| --- | --- | --- | --- | --- |
| O07 | U-DAT-01 Revisión de colección y CAS | Claude (Opus) | `test` | Sí (`0003`) |
| O07 | U-OPS-02 Backup administrativo y restore | Claude (Opus) | `scratch` | No |
| O07 | U-BIB-01 Contrato y orquestador bibliográfico | Codex | No | No |
| O07 | U-EXP-01 Navegación, títulos y retorno | Claude (Sonnet): OpenCode sin cuota y Codex al 13 % de su límite de 5 h | No | No |
| O07 | U-LOC-01 Login local con correo y contraseña (petición de Néstor) | Claude (Sonnet) | No | No |
| O07 | U-QA-02 E2E y navegadores (tras U-DAT-01) | Claude (Opus) | `test` | No (Playwright en lockfile) |
| O08 | U-BIB-02 Adaptadores OL y BNE | Codex | No | No |
| O08 | U-DAT-05 Cuota y caché compartidas | Claude (Opus) | `scratch` | Sí (`0004`) |
| O08 | U-EXP-04 3D táctil/teclado y alternativa 2D | OpenCode `glm-5.3` → Codex (cuota agotada otra vez) | No | No |
| O08 | U-INF-07 Adopción y promoción remota (tras U-DAT-05) | Claude (Opus) | `scratch` | No (sin destino remoto autorizado: queda preparada) |
| O09 | U-BIB-04 Procedencia y candidatos | Claude (Opus) | No | No (pregunta antes) |
| O09 | U-BIB-03 Google Books opcional | Codex | No | No |
| O09 | U-DAT-03 Trabajos persistentes y leases | Claude (Opus) | `scratch` | Sí (`0005`) |
| O09 | U-QA-03 Rendimiento (primera medición) | Claude (Sonnet) | `test` | No (índices propuestos) |
| O09 | U-FIX-01 Cero tráfico en fixture y 404 de ficha | Codex | No | No |
| O09 | U-QA-04 CI y artefactos (ejecución real pendiente de push) | Codex | No | No |
| O09 | U-OPS-04 Sesión, exposición y cabeceras (local; HTTPS real pendiente) | Claude (Opus) | `scratch` | No |
| O10 | U-DAT-08 Búsqueda título/autor | Codex | No | No |
| O10 | U-BIB-05 Todos los flujos por el orquestador | Claude (Sonnet) | Al final | No |
| O10 | U-DAT-02 Snapshots y deshacer (+ índices T8, CLS T2) | Claude (Opus) | `scratch` | Sí (`0006`) |
| O10 | U-FIX-02 Sesión por petición y latencia (T3/T4) | Claude (Opus) | `test` | No |
| O10 | U-EXP-02 Vistas guardadas | Tras U-DAT-02 | — | Sí (`0007`) |

## Puertas

- **G07:** una preview antigua no reemplaza cambios posteriores; B no invalida A; doble confirmación idempotente. Orquestador sin confundir timeout con ausencia. Volver del detalle conserva consulta y posición. Copia administrativa restaurada en stack aislado con RLS/trigger/objetos validados. E2E Chromium reproducible con fixtures.
- **G08–G10:** según [05](05-fases-olas-y-trazabilidad.md).

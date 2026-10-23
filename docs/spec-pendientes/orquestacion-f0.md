# Orquestación de F0 con Orca

**Versión:** 1.0 · **Fecha:** 23 de octubre de 2026 · **Estado:** en ejecución.

Plan operativo para implementar la fase F0 (O00–O06) de esta spec con workers supervisados de Orca: Claude Code, Codex y OpenCode Go. Este documento fija las reglas comunes, el contrato compartido entre unidades y el reparto de agentes. Las unidades y su aceptación siguen siendo las de [01](01-entorno-y-migraciones.md) y [04](04-calidad-seguridad-y-operacion.md); aquí solo se concreta lo que la spec deja a la implementación y que varios workers necesitan compartir.

## O00 · Inventario y decisiones de arranque

| Tema | Resultado (23-10-2026) |
| --- | --- |
| Punto de partida | `main` en `3c6fd35`, árbol limpio. `pnpm lint`, `pnpm typecheck` y `pnpm test` (50/50) en verde. Rama de integración `feature/spec-pendientes`. |
| Archivos personales | No hay `imports/` ni archivos sin seguimiento. Existe `.env` privado: no se lee ni se versiona. |
| Docker | Docker Desktop 29.4.3, 12 CPU, ~20 GB. Windows 11. |
| Coexistencia | HolaERP está en marcha: `supabase_*_holaerp` en 5432 y 54321/54323/54324, publicado en `0.0.0.0`. BibLib no lo detiene ni lo modifica; sirve como caso real de coexistencia. |
| Puertos | 55320–55349 y 3147–3149 libres y fuera de los rangos excluidos de Windows (`netsh … excludedportrange`). |
| Supabase CLI | Se fija **2.117.0** exacta (la instalada y la de HolaERP). 2.121.0 existe; no se adopta sin probar su plantilla. |
| Destino remoto | Producción: proyecto Supabase existente, identidad no inspeccionada en F0. Preproducción: **no configurado**. Ninguna operación remota en F0. |
| Google Books | Opcional y apagado; no bloquea F0. |
| Worker de jobs / respaldo | Sin decidir; pertenecen a F1 (U-DAT-03, U-OPS-02). |

## §0 · Reglas comunes para todos los workers

1. Leer `AGENTS.md`, [README de la spec](README.md), este documento y la sección de su unidad. Textos visibles en español, sin `any`, `pnpm`.
2. **Prohibido** leer, imprimir o copiar `.env`, `.env.local` o cualquier secreto. Prohibido tocar la base remota.
3. **Prohibido** detener, borrar o modificar contenedores, redes o volúmenes ajenos (`*holaerp*` u otros): nada de `supabase stop --all`, `docker system prune`, `docker volume rm` por patrón ni cerrar procesos por ocupar un puerto.
4. Desde un worktree solo se levantan los perfiles **`scratch`** o **`test`** (nunca `main`), y solo el worker al que la ola se lo asigne. Al terminar se para con el wrapper o `supabase stop` del workdir del perfil, conservando volúmenes salvo pruebas de reset.
5. Scope cerrado: solo los archivos de la unidad y los compartidos que se le asignen abajo. Lo que se salga del scope se describe en el `worker_done`, no se hace.
6. Conventional Commits en español (`feat(db): …`), commits pequeños en la rama del worktree. Sin push ni PR.
7. Validación mínima antes de `worker_done`: `pnpm lint`, `pnpm typecheck`, `pnpm test` y `pnpm test:scripts` (desde que exista). Las pruebas que necesiten Docker, el CLI o el stack se ejecutan y su resultado se informa tal cual; nada se marca como pasado sin ejecutarlo.
8. Archivos compartidos: `package.json` (scripts añadidos solo al final del bloque; al fusionar se conservan todos), `.gitignore` (solo anexar), `pnpm-lock.yaml`/`pnpm-workspace.yaml` (solo la unidad designada por ola), `docs/operacion.md` (cada unidad añade su propia sección).
9. Exactamente un `orca orchestration send --type worker_done` con `--outcome succeeded|failed`, cuerpo de tres frases (qué hice, qué encontré, qué queda o qué conflictos hay) y `--files-modified`. Las dudas bloqueantes van por `orca orchestration ask`.

## §1 · Contrato compartido de F0

**Perfiles.** Versionados en `supabase/profiles.json` (lo crea U-INF-01). Estado local en `.biblib/` (ignorado por Git).

| Perfil | `projectId` | Puertos (shadow, API, DB, Studio, Mailpit, SMTP, POP, analytics, inspector, pooler) | App | Uso |
| --- | --- | --- | --- | --- |
| `main` | `biblib-local` | 55320–55329 | 3147 | Desarrollo en el checkout principal. |
| `test` | `biblib-test` | 55330–55339 | 3148 | `test:integration:local` y CI. |
| `scratch` | `biblib-scratch` | 55340–55349 | 3149 | Worktrees y pruebas destructivas descartables. |

La red de cada perfil es `<projectId>-network`, con `com.docker.network.bridge.host_binding_ipv4=127.0.0.1` y etiquetas `biblib.profile=<perfil>` y `biblib.root=<hash de la raíz>`. Cada perfil tiene su workdir generado en `.biblib/stacks/<perfil>/`, a partir de `supabase/config.toml` (el de `main`) más las diferencias del perfil. Nada de SQL de negocio en `supabase/migrations/`.

**Variables.** `BIBLIB_TARGET=local|test|preprod|prod` (obligatoria en wrappers), `BIBLIB_PROFILE=main|test|scratch` (por defecto `main`; en `test`, el perfil `test`), `BIBLIB_CATALOGUE_MODE=fixture|live` (servidor; por defecto `fixture` en local/test). Secretos de servidor sin prefijo `NEXT_PUBLIC_`.

**Módulos y firmas** (Node ESM `.mjs`, sin dependencias de shell):

| Módulo | Unidad | Exporta |
| --- | --- | --- |
| `scripts/lib/profiles.mjs` | U-INF-01 | `loadProfiles()`, `getProfile(name)`, `profileWorkdir(name)`, `profilePorts(name)` |
| `scripts/lib/exit-codes.mjs` | U-INF-01 | `EXIT` con los códigos 0, 2–11 y 130 de [01](01-entorno-y-migraciones.md#argumentos-y-códigos-de-salida-de-los-wrappers), y `BiblibError(code, phase, message)` |
| `scripts/db/environment.mjs` | U-INF-02 | `loadTarget(target, { profile })` → `TargetContext { target, profile, fingerprint, env(), redacted() }`, `childEnv(ctx)` y `assertNoForeignEnvFiles(ctx)` |
| `scripts/local-stack.mjs` | U-INF-03 | CLI `doctor`, `status`, `up`, `down` y `bootstrap` (contrato), con salida `{ schemaVersion, target, fingerprint, endpoints, services, head, checks[] }` |
| `scripts/db/migrate.mjs`, `plan.mjs`, `journal-guard.mjs`, `objects-manifest.mjs` | U-INF-04 | `status`, `plan --out` y `migrate --plan --expect-project --expect-plan` |
| `scripts/db/seed-local.mjs`, `tests/fixtures/census.json` | U-INF-05 | Seed idempotente A/B (`@biblib.test`), bucket `biblib-test-assets` y fixtures de catálogo |
| `scripts/local-stack.mjs reset` | U-INF-06 | `reset --dry-run --out` y `reset --apply --plan --expect-project --expect-plan (--backup-receipt \| --discard-local-data)` |
| `lib/observability/` | U-OPS-01 | `createLogger`, `withCorrelation`, `emit(event, fields)` con lista blanca de campos |

**Pruebas de scripts:** `tests/scripts/**/*.test.mjs` con `node --test`, script `pnpm test:scripts` (lo crea U-INF-01). Simulan procesos/CLI sin Docker; las pruebas con stack real se marcan y se pueden saltar con `BIBLIB_SKIP_STACK_TESTS=1`.

## §2 · Olas, unidades y agentes

| Ola | Unidad | Agente | Lockfile | Stack `scratch` |
| --- | --- | --- | --- | --- |
| O01 | U-INF-01 Stack Supabase propio | Claude (Opus) | Sí (`supabase@2.117.0`, `allowBuilds`) | Sí |
| O01 | U-OPS-05 Mantenimiento y restos del prototipo | OpenCode · `glm-5.3` | No: las retiradas de dependencias se proponen en el informe | No |
| O02 | U-INF-02 Objetivos explícitos y builds aislados | Codex | Si lo necesita | No |
| O03 | U-INF-03 CLI de ciclo de vida y diagnóstico | Codex | No | Sí |
| O03 | U-OPS-01 Observabilidad sin datos privados | OpenCode · `kimi-k3` | No | No |
| O04 | U-INF-04 Runner Drizzle único | Claude (Opus) | Si lo necesita | Sí |
| O05 | U-INF-05 Fixtures GoTrue, Storage y correo | Codex | Si lo necesita | Sí |
| O06 | U-INF-06 Reset y bootstrap verificables | Codex | No | Sí (`scratch`) |
| O06 | U-QA-01 Integración Supabase real | Claude (Opus) | Si lo necesita | Usa `test` |

Cada unidad trabaja en un worktree hijo de `feature/spec-pendientes`. El coordinador fusiona cada ola con `git merge --no-ff`, ejecuta la validación de la puerta y actualiza `unidades.json`.

## §3 · Puertas del coordinador

- **G01:** `config.toml` sin SQL de negocio; perfil `scratch` arranca y para con HolaERP vivo e intacto (comparar `docker ps`/redes/volúmenes `*holaerp*` antes y después); bindings en `127.0.0.1`.
- **G02:** con variables remotas falsas heredadas, los comandos locales abortan o usan solo el perfil; `db:generate` sin credenciales; bundle cliente sin secretos.
- **G03:** `doctor`/`status --json` de solo lectura y sin secretos; `up` idempotente; puerto ocupado → diagnóstico, exit 8/4.
- **G04:** base vacía `scratch` → `0000…0002` una sola vez; repetir no cambia nada; drift de trigger/política detectado.
- **G05:** seed repetido idempotente; sesiones GoTrue reales A/B; Storage privado con firma; Mailpit captura.
- **G06 (salida F0):** bootstrap → migración → seed → acceso → CRUD/aislamiento sobre stack limpio; reset rechaza 5432/`holaerp`/remoto; `test:integration:local` en verde.

Si una puerta falla, la ola no se cierra: se lanza una tarea de corrección al mismo agente o, si es de diseño, se escala a Néstor.

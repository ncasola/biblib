# Mantenimiento de BibLib

**Referencia:** unidad U-OPS-05 de la [spec de pendientes](spec-pendientes/README.md) · hallazgos FE-04 y SEC-01. Política para mantener dependencias, scripts y el repositorio sanos sin publicar datos personales.

## Política de actualización de dependencias

- **Lockfile congelado.** Toda instalación usa `pnpm install --frozen-lockfile`. Nunca se fuerza con `--no-frozen-lockfile` para «arreglar» un build: si el lockfile no cuadra, se investiga y se regenera como parte de una propuesta explícita.
- **Sin `latest`.** No se instalan tags `latest` ni `*` y no son un estado permanente aceptable. Los rangos `^` existentes se respetan, pero cualquier salto de versión pasa por una propuesta concreta con el lockfile regenerado.
- **Versiones fijadas de referencia:** Node `>=24.11.1 <25` y pnpm `>=10.32.1 <11` (`packageManager: pnpm@10.32.1` en `package.json`); Supabase CLI **2.117.0 exacta** (decisión de O00: la instalada y la probada en HolaERP; no se adopta una superior sin probar su plantilla).
- **Cadencia.** Revisiones periódicas pactadas, no automáticas: una propuesta por área (framework, UI, base de datos) con changelog revisado. Responder a un aviso de seguridad que afecte al despliegue es prioridad **P1**; la limpieza ordinaria es **P3**.
- **Advisories.** Antes de cada propuesta se revisan `pnpm audit` y las alertas oficiales (GitHub Advisories / Dependabot). Los overrides de seguridad transitivos definidos en `pnpm-workspace.yaml` (`postcss`, `sharp`, `nanoid`, `source-map-js`: solo saltos dentro del mismo major) se retiran cuando el paquete padre los sube por su cuenta.
- **Validación.** Una actualización se valida en local (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` y las suites del área afectada) y **en preproducción antes de atribuirle efecto al despliegue real**. No se publica una actualización solo porque pase la suite local.
- **Recuperación.** Se revierte la actualización concreta dejando el lockfile consistente. No se modifica el historial de migraciones ya aplicado para recuperar una dependencia.

## Inventario de scripts

| Script | Qué hace | Requisitos |
| --- | --- | --- |
| `pnpm dev` | Servidor de desarrollo Next. | Variables de entorno locales. |
| `pnpm build` | Compila la aplicación para producción. | — |
| `pnpm start` | Sirve el build de producción. | Build previo. |
| `pnpm lint` | ESLint sobre todo el repo (`eslint .`). | — |
| `pnpm typecheck` | `next typegen` + `tsc --noEmit`. | — |
| `pnpm test` | Compila y ejecuta las 50 pruebas unitarias con `node --test`; usan respuestas simuladas de Open Library. | — |
| `pnpm test:import` | Solo la suite de importación (`library-import.test.js`). | — |
| `pnpm test:db` | `scripts/test-database.mjs`: crea un contenedor Postgres temporal propio, aplica migraciones, prueba RLS con dos usuarios, restricciones y rollback, y lo elimina. No usa `.env.local` ni bases reales. | Docker; puede descargar `postgres:17-alpine`. |
| `pnpm test:smoke` | `scripts/smoke-app.mjs`: construye en carpeta temporal sin `.env`, con Auth simulado y Postgres efímero, y comprueba los recorridos principales. | Docker y Chrome (`CHROME_BIN` opcional). |
| `pnpm db:generate` | `drizzle-kit generate`: genera SQL de migración. Revisar el SQL antes de aplicarlo. | — |
| `pnpm db:migrate` | `drizzle-kit migrate`: aplica migraciones al destino configurado. Revisar el destino antes de ejecutar. | Variables de conexión. |

La spec de pendientes añadirá wrappers por entorno (`db:local:*`, `test:scripts`, `test:integration:local`, …) en las olas de infraestructura; cuando existan, esta tabla se actualiza en el mismo cambio. `pnpm test:scripts` existe desde U-INF-01; el inventario vigente de comandos está en `package.json` y en la [guía de operación](operacion.md).

## Decisiones de `allowBuilds` de pnpm

`pnpm-workspace.yaml` autoriza exactamente lo que la instalación necesita, ni un paquete más:

| Paquete | Decisión | Motivo |
| --- | --- | --- |
| `unrs-resolver` | `true` | Necesario para la resolución de importaciones de ESLint. |
| `esbuild` | `false` | Sin compilar funciona para el uso actual. |
| `sharp` | `false` | `next.config.mjs` fija `images.unoptimized: true`, así que `next/image` no optimiza con sharp; autorizarlo es una decisión humana, no del agente. |

Cualquier autorización nueva se justifica aquí con la utilidad concreta, quién la aprobó y por qué, en el mismo cambio que la añade.

## Guía breve de contribución

1. **Rama y commits.** Una rama por unidad (`u-<unidad>`), commits pequeños con Conventional Commits **en español**: `feat(auth): …`, `fix(import): …`, `docs(spec): …`, `chore(deps): …`, `refactor(limpieza): …`.
2. **Validación mínima antes de entregar:** `pnpm lint`, `pnpm typecheck`, `pnpm test` y `pnpm build` (más `pnpm test:scripts`). Nada se da por pasado sin ejecutarlo.
3. **Código.** Textos visibles en español, TypeScript sin `any`, `pnpm` como gestor, acciones de servidor para datos de dominio y RLS por usuario.
4. **Seguridad.** Prohibido leer, imprimir o copiar `.env*`; prohibido tocar la base remota, contenedores o volúmenes ajenos. Los respaldos y credenciales nunca entran en Git.
5. **Datos personales.** Antes de un commit, revisa el staging: `imports/`, fotos personales y `docs/validacion/**/privado/` están ignorados a propósito. Las fotos del usuario no se borran, mueven ni publican como parte de una limpieza técnica.
6. **Consultas de estilo y operación:** [AGENTS.md](../AGENTS.md) (raíz) y [operación](operacion.md).

## Archivos personales y privacidad

Quedan fuera del repositorio, con reglas específicas en `.gitignore`: los archivos de importación de la biblioteca real (`imports/`), las fotografías personales (`fotos/`, `fotos-personales/`) y las evidencias con datos personales de las validaciones (`docs/validacion/**/privado/`). Los fixtures **ficticios** de `tests/` sí se versionan. La decisión de qué es privado se toma explícitamente al preparar cada commit, no por defecto.

# U-OPS-04 · Sesión, exposición de datos y cabeceras (O09, parte local)

**Fecha:** 23 de octubre de 2026 · **Rama:** `u-ops-04` (desde `feature/spec-pendientes` en `9a64364`) · **Worktree:** `u-inf-03` · **Perfil:** `scratch` (`biblib-scratch`, head `0005`, app en `127.0.0.1:3149`) · **Agente:** Claude (Opus).

Inventario y decisiones: [docs/seguridad.md](../../../../seguridad.md). Este informe registra lo ejecutado y sus resultados. No hay alojamiento ni destino remoto autorizados: HTTPS real, CDN y Google OAuth quedan pendientes y no se simulan.

## Commits

| Commit | Contenido |
| --- | --- |
| `ac2c723` | `app/layout.tsx`: `connection()` y nonce para `next-themes`. Archivo fuera de la propiedad de la unidad; cambio aprobado por el coordinador (opción A), en un commit aislado. |
| `afdeff3` | `lib/security-headers.ts`, `proxy.ts` (CSP Report-Only con nonce) y `next.config.mjs` (caché privada, COOP, `Permissions-Policy`). |
| `13031cc` | `appEnv` en `scripts/db/environment.mjs` y `nextEnv` en `scripts/next-target.mjs`: `service_role` fuera del proceso de Next. |
| `7425b6e` | `pnpm security:headers:local` y la matriz `scripts/security/headers-matrix.mjs`. |
| `5eefaa0` | `tests/security-headers.test.ts` y `tests/scripts/security-exposure.test.mjs`. |
| `30a666d` y el siguiente | Grupo `tests/integration/security/` y `pnpm test:integration:security`. |
| último | `docs/seguridad.md`, sección en `docs/operacion.md` y esta evidencia. |

## Resultados con stack (`scratch`)

| Comprobación | Resultado | Evidencia |
| --- | --- | --- |
| `pnpm db:local:bootstrap --profile scratch` | 0: preflight, stack, env, migrate, seed y verify completados (aviso conocido de bindings fuera de loopback de Docker Desktop) | — |
| `pnpm security:headers:local --profile scratch` | **35/35** respuestas coinciden con la matriz, salida 0 | [cabeceras-scratch.json](cabeceras-scratch.json), [log](cabeceras-scratch.log) |
| `pnpm test:integration:security --profile scratch` | **19/19**, salida 0 | [integracion-security.log](integracion-security.log) |
| CSP en `dev:local` (Chrome) | Nonce aplicado, `'unsafe-eval'` solo en desarrollo, 0 violaciones en 5 rutas | [csp-desarrollo.json](csp-desarrollo.json) |
| Rendimiento antes/después del render dinámico | Ver tabla siguiente | [medicion-rendimiento.json](medicion-rendimiento.json) |

**Primer intento del grupo:** la primera ejecución completa (con build) dio 16/19. Las tres pruebas de `aislamiento.test.mjs` fallaron en su `before` con «Docker no respondió al comprobar la propiedad del stack local» (salida 8). El hook resolvía el stack tres veces justo después del build. `ctx.signIn` reutiliza ahora el contexto ya acreditado, y la repetición con `--reuse-build` (mismo build) pasó 19/19. No fue un fallo de seguridad.

Hallazgos durante el desarrollo, ya incorporados:

- Antes de la unidad, `/` y `/books` con sesión respondían `Cache-Control: s-maxage=31536000` (páginas estáticas): eran cacheables por un CDN.
- Next 16 fija en las Server Actions `no-cache, no-store, max-age=0, must-revalidate` y no admite sustituirlo. Se registra ese valor exacto en la matriz. `no-store` impide cualquier caché.
- Next sobrescribe `Vary` en las páginas, así que el HTML no lleva `Vary: Cookie`. La garantía es `no-store`.
- Única violación CSP restante: la sonda `allowsEval` de Zod 4 en `/books/add`, `/book/[id]` y `/settings` (explicada en seguridad.md; inocua con enforcement).

### Medición rápida antes/después (para U-QA-03)

`start:local`, sesión real de A, 5 peticiones de calentamiento y 40 secuenciales por ruta, mismo equipo con HolaERP en marcha. El tiempo incluye el `getUser` del proxy contra GoTrue.

| Ruta | Antes (estática `○`) mediana / p95 | Después (dinámica `ƒ`) mediana / p95 | `Cache-Control` antes → después |
| --- | --- | --- | --- |
| `/` | 62,6 / 75,2 ms | 54,4 / 62,3 ms | `s-maxage=31536000` → `private, no-store` |
| `/books` | 96,9 / 155,2 ms | 53,7 / 57,8 ms | `s-maxage=31536000` → `private, no-store` |

No se aprecia penalización: el coste dominante es la ida a GoTrue del proxy, que ya existía, y la diferencia está dentro del ruido de una medición local. `pnpm build` lista ahora las 15 rutas como dinámicas (antes, 9 eran estáticas). U-QA-03 debe medirlo con su metodología.

## Validación del repositorio

Ejecutado al cierre, en este orden y sobre el árbol final de código:

| Comando | Resultado |
| --- | --- |
| `pnpm lint` | 0 |
| `pnpm typecheck` | 0 |
| `pnpm test` | 256/256 |
| `pnpm test:scripts` | 201/201 |
| `pnpm build` | 0; las 15 rutas son dinámicas (`ƒ`) |
| `pnpm test:smoke` | `ok: true` |

## Recursos y coexistencia

- **HolaERP idéntico:** se comparó antes y después el inventario `docker ps -a`, los volúmenes y las redes `*holaerp*` (21 entradas: mismos IDs, nombres y estados; solo cambia el tiempo de actividad). No se tocó ningún recurso ajeno.
- **`scratch` parado** con `pnpm db:local:down --profile scratch` (salida 0, sin contenedores en marcha). Como exige el lifecycle, se conservan los volúmenes `supabase_db_biblib-scratch` y `supabase_storage_biblib-scratch` y la red `biblib-scratch-network`, registrados a este root.
- **Puerto 3149 libre** al terminar. Los runners arrancaron y pararon sus instancias de la app. Una instancia manual de depuración se detuvo por su PID tras comprobar que era `next-target start local --profile scratch` de este worktree.
- `next dev` (comprobación de CSP en desarrollo) añade por su cuenta un bloque de reglas a `agents.md`. Se restauró el archivo: no pertenece a esta unidad.

## Fuera de alcance y pendientes

- `tests/integration/run.mjs` (U-QA-01) enumera sus grupos y no incluye `security`. Añadirlo es un cambio de una línea en un archivo ajeno; el grupo se ejecuta con su propio comando.
- Silenciar la sonda de Zod (`z.config({ jitless: true })` en código cliente) antes de pasar la CSP a enforcement.
- Pendientes de alojamiento: HTTPS real, CDN, Google OAuth con cuenta de prueba, CSP en enforcement tras recoger informes, y repetición con U-EXP-05 (cámara) y U-EXP-08 (offline). Detalle en [seguridad.md § Pendientes](../../../../seguridad.md#pendientes).
- `supabase/config.toml` no se ha modificado: `api.schemas` ya excluye `biblib` y `drizzle`.

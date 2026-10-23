# Puertas G07 y G08

**Fecha:** 23 de octubre de 2026 · **Commit:** `f4fef4c` en `feature/spec-pendientes` · **Ejecutada por:** el coordinador de la Run de Orca `run_0513502ec5ee`.

## Validación del código integrado

| Comprobación | Resultado |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | correctos |
| `pnpm test` | 227/227 |
| `BIBLIB_SKIP_STACK_TESTS=1 pnpm test:scripts` | 172 superadas, 4 omitidas con motivo (2 de stack y 2 de build en un checkout con `.env` privado) |
| `pnpm test:db` | correcto (`0000→0004`) |
| `pnpm build` y `check:bundle --forbid-local-login` | correctos; 38 archivos sin secretos ni formulario local |
| `pnpm test:smoke` | correcto |
| `pnpm db:local:bootstrap --profile test` | `passed`; head `0004_catalogue_coordination` (5/5) |
| `pnpm test:integration:local` (perfil `test`) | 59/59 |
| `pnpm test:e2e:local` (Chromium) | 33 superados, 1 fallo conocido (`/book/<no UUID>` → 500), 23 `fixme` asociados a unidades futuras, 0 repeticiones |

## G07

- Una preview antigua no reemplaza cambios posteriores; B no invalida a A; la doble confirmación es idempotente. Lo cubren el grupo de integración `import` y el E2E de importación.
- El orquestador no confunde un timeout con una ausencia (pruebas de U-BIB-01).
- Volver desde la ficha conserva la consulta y la posición (E2E de consulta y smoke).
- Copia administrativa restaurada en `scratch`, con RLS, trigger y objetos validados (U-OPS-02, ampliada por U-INF-07: verify 29/29).
- E2E en Chromium reproducible con fixtures; Firefox y WebKit pasaron 66/66 en el ensayo de U-QA-02.

## G08

- La cuota y la caché compartidas se probaron con dos procesos Node contra Supabase local (grupo `catalogue`).
- El XML de BNE se procesa de forma segura: rechaza DTD, XXE y tamaños excesivos. Se hicieron 3 consultas públicas reales, todas con HTTP 200.
- Open Library va por el gateway. Un fallo de catálogo mantiene el alta manual.
- El visor 3D no promete giro ni zoom, muestra como máximo 48 libros y ofrece una alternativa 2D (U-EXP-04).
- **Promoción remota: preparada y ensayada solo contra destinos locales** (Postgres 17 efímero con TLS y `scratch`). Sin destino autorizado, la verificación contra preproducción y producción sigue **pendiente**.

## Hallazgos abiertos

1. **Tráfico externo en modo `fixture`:** la recuperación de portadas, «Buscar portada» y el enriquecimiento de la importación (`lib/library-import.ts`, `lib/api-client.ts`) siguen llamando a openlibrary.org. Se corrige con prioridad en `U-FIX-01`.
2. `/book/<id no UUID>` devuelve 500 en lugar de 404. Va también en `U-FIX-01`.
3. La ruta `app/api/books/search` debe filtrar las portadas de `google-books` (indicado por U-BIB-04).
4. `docs/recuperacion.md` está desfasado respecto al recibo de respaldo ampliado por U-INF-07.

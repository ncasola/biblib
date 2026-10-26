# Seguridad: sesión, exposición de datos y cabeceras

**Unidad:** U-OPS-04 (hallazgos SEC-02/03/04/05 y BE-05) · **Fecha:** 23 de octubre de 2026 · **Alcance:** parte local. La verificación en HTTPS real, CDN y Google OAuth queda [pendiente](#pendientes) y no se da por hecha.

Este documento es el inventario de referencia. Si cambia una ruta, un grant o una cabecera, se actualiza a la vez que la matriz ejecutable (`scripts/security/headers-matrix.mjs`) y las pruebas que la vigilan. No es un pentest exhaustivo.

## Cómo se verifica

| Comando | Qué demuestra | Requiere |
| --- | --- | --- |
| `pnpm security:headers:local --profile scratch [--reuse-build] [--out archivo.json]` | Compila con `build:local`, arranca con `start:local` en el puerto del perfil (3149 para `scratch`), pide las 35 peticiones del inventario como anónimo y con la sesión real de A y compara las cabeceras efectivas con la matriz. Sale con **11** si alguna no coincide. | Stack del perfil sano, migrado y con seed. Sin red externa. |
| `pnpm test:integration:security --profile scratch [--reuse-build]` | Grupo `tests/integration/security/` (23 pruebas): acceso por el formulario local, renovación, cierre y callback PKCE reales; token revocado sin escritura y atestación de sesión (U-FIX-02); misma URL como A, B y anónimo; Data API, grants y `SECURITY DEFINER`; CSP Report-Only en Chrome. | Igual, más Chrome instalado (canal `chrome` de Playwright, como `playwright.config.ts`). |
| `pnpm test` (`tests/security-headers.test.ts`) | Constructor de la CSP y reglas de `next.config.mjs`. | Nada. |
| `pnpm test:scripts` (`tests/scripts/security-exposure.test.mjs`) | `service_role` fuera del proceso de Next, ningún código de la app la nombra, `api.schemas`, cobertura de la matriz frente a `app/` y lógica del comparador. | Nada. |

Ambos comandos con stack siguen el patrón de `test:integration:jobs`: acreditan la propiedad del perfil, toman su bloqueo, exigen el ledger al día y fixtures A/B completos, y nunca terminan a un ocupante del puerto de la app (salida 8). El perfil `test` también se admite. El grupo `security` no está incluido en `pnpm test:integration:local` (su runner enumera los grupos y pertenece a U-QA-01).

## Rutas públicas y privadas

La protección la decide `isProtectedPath` (`lib/auth-navigation.ts`) en `proxy.ts`: sin sesión válida, redirige a `/login?redirect=<ruta y consulta>`; con sesión, `/login` redirige al destino interno saneado por `getSafeRedirectPath`. El matcher del proxy excluye `/api`, `_next/static`, `_next/image`, `favicon.ico` y las imágenes de `public/`.

| Ruta (`app/`) | Tipo | Acceso | Datos | Notas |
| --- | --- | --- | --- | --- |
| `/` | Página | Privada | Resumen por acción | Inicio. |
| `/books` | Página | Privada | Por acciones | Colección. |
| `/books/add` | Página | Privada | Por acciones | Alta manual o por ISBN. |
| `/books/search` | Página | Privada | Por acciones | Filtros en la URL. |
| `/book/[id]` | Página | Privada | Servidor + acciones | Un ID de otra cuenta responde 404 (U-FIX-01). |
| `/shelves`, `/shelves/3d` | Página | Privada | Por acciones | |
| `/loans` | Página | Privada | Por acciones con RLS | Préstamos activos del dueño; vencimiento civil en la zona de la persona. |
| `/settings` | Página | Privada | Por acciones | Exportar/importar. |
| `/profile` | Página | Privada | Sesión | |
| `/login` | Página | Pública | — | Con sesión, redirige al destino interno. Formulario local solo en builds `local`/`test` (U-LOC-01). |
| `/auth/callback` | Route handler | Pública | Canjea el código PKCE | Destino `next` saneado; sin código o con `error` vuelve a `/login?error=oauth`. |
| `/api/books/search` | Route handler (GET) | Sesión exigida en el handler (401) | Catálogo | Fuera del proxy. |
| `/api/books/add` | Route handler (POST) | Sesión exigida por la acción (401) | Alta | Fuera del proxy. |
| `/api/media/[id]` | Route handler (GET) | Sesión exigida en el handler (401 JSON) | Imagen privada propia de O13 | RLS y Storage con la sesión del dueño; UUID ajeno o ausente: 404. |
| `/api/internal/jobs/run` | Route handler (POST) | Token del ejecutor (401) | Trabajos | No lee sesión ni cuerpo; el dueño sale de la fila reclamada. |
| `/signup`, `/forgot-password` | Redirección (`next.config.mjs`) | Pública | — | Retiradas: llevan a `/login`. |
| Server Actions (`app/actions/*`) | POST a la página que las incluye | Privadas: el proxy las intercepta y cada acción exige usuario | Dominio | Sin sesión: 307 al acceso, la acción no se ejecuta. |

`tests/scripts/security-exposure.test.mjs` falla si aparece una `page.tsx` o `route.ts` que no esté en la matriz.

## Schemas expuestos por la Data API

- `supabase/config.toml` → `[api] schemas = ["public", "graphql_public"]`, `extra_search_path = ["public", "extensions"]`. **`biblib` y `drizzle` no se exponen.** No se ha modificado `config.toml`: la revisión confirma que ningún consumidor necesita la Data API para el dominio, que pasa por Server Actions con conexión Postgres propia.
- Comprobación efectiva (scratch, 23-10-2026): PostgREST responde `406 PGRST106` con la pista «Only the following schemas are exposed: public, graphql_public» para `biblib.books`, `biblib.shelves`, `biblib.library_jobs` y `drizzle.__drizzle_migrations`, como anónimo y como A, en lectura y en RPC (`/rest/v1/rpc/library_job_create`). El SDK con `.schema("biblib")` no obtiene datos y `pg_graphql` no está instalado: GraphQL no publica tablas de BibLib.
- Si en el futuro se habilita una vía (por ejemplo, Realtime o una vista pública), se declara aquí y se prueban sus permisos. No se añade `biblib` a `api.schemas` para facilitar un test.

## Roles y grants

Medido en `biblib-scratch` con head `0005` (prueba: `tests/integration/security/exposicion.test.mjs`).

| Objeto | `anon` | `authenticated` | `service_role` |
| --- | --- | --- | --- |
| Schema `biblib` | Sin `USAGE` | `USAGE`, sin `CREATE` | Sin `USAGE` |
| Schema `drizzle` (ledger) | Sin `USAGE` | Sin `USAGE` | Sin `USAGE` |
| Tablas de `biblib` (13, todas con RLS) | Ninguno | Según tabla (abajo) | — |
| Secuencias `catalogue_fence_seq`, `library_job_fence_seq` | Ninguno | Ninguno | — |

Privilegios de `authenticated` por tabla (todas con `relrowsecurity`; las políticas filtran por `auth.uid()`):

| Tabla | Privilegios | Políticas |
| --- | --- | --- |
| `books`, `shelves` | `SELECT, INSERT, UPDATE, DELETE` | 4 |
| `import_previews` | `SELECT, INSERT, DELETE` | 3 |
| `library_operations` | `SELECT, INSERT` | 2 |
| `catalogue_private_cache` | `SELECT, DELETE` | 2 |
| `account_lifecycle`, `library_jobs`, `library_job_items`, `library_state` | `SELECT` | 1 |
| `catalogue_cache`, `catalogue_inflight`, `catalogue_quota_buckets`, `catalogue_quota_reservations` | Ninguno | 0 (solo funciones definer) |

**Obra, edición y ejemplar (0010–0012, U-DAT-06).** `works`, `editions` y `copies` tienen RLS y las cuatro políticas `*_own` con `user_id = (select auth.uid())` (el uid se evalúa una vez por consulta, no por fila); `authenticated` tiene `SELECT, INSERT, UPDATE, DELETE`; `anon`, nada. Toda FK entre ellas, con las estanterías y con las portadas incluye al dueño, así que una referencia a datos de otra cuenta (un ejemplar en la edición o la estantería de B, una fusión cruzada) falla aunque se conozca el UUID. `model_migration_report` solo se lee (`SELECT`, política propia). La vista `books` es `security_invoker`: aplica la RLS de las tablas a quien consulta y `authenticated` tiene sus cuatro privilegios; sus triggers INSTEAD OF se ejecutan con los privilegios de quien escribe. `books_legacy` no tiene políticas ni privilegios de cliente. `model_compare` es `SECURITY DEFINER` sin `EXECUTE` para clientes; `isbn13_normalize` es pura y la ejecuta `authenticated` porque la evalúa la restricción de `editions.isbn13`. Desde 0012 la poda de ediciones y obras huérfanas (`prune_orphan_*`, triggers por sentencia) es `SECURITY DEFINER` sin `EXECUTE` para nadie: solo borra filas del mismo dueño sin ejemplares ni ediciones, y así el borrado de una cuenta desde Auth no depende de que su rol tenga acceso a `biblib`.

**Lote de producto de O13 (0014).** `tags`, `copy_annotations`, `locations`, `copy_locations`, `series`, `series_editions`, `profiles`, `bibliographic_evidence`, `review_issues` y `csv_mapping_profiles`: RLS con `user_id = (select auth.uid())`, `SELECT, INSERT, UPDATE, DELETE` para `authenticated` y política RESTRICTIVE de cuenta activa en cada escritura. `copy_tags`: `SELECT, INSERT, DELETE`. `review_decisions`: `SELECT, INSERT` (registro de solo inserción). `media_assets`: solo `SELECT`; sus transiciones pasan por `media_asset_begin_upload`, `media_asset_register` y `media_asset_discard` (`SECURITY DEFINER`, dueño de `auth.uid()`, BD001 con la cuenta en eliminación). `anon`, nada. Toda FK entre datos privados incluye al dueño (etiqueta, ubicación, serie, edición, ejemplar o imagen de otra cuenta → violación de FK). El bucket `biblib-media` es privado, solo `image/webp` y 5 MiB, con ruta `<dueño>/<tipo>/<asset>`; sus políticas de `storage.objects` llaman a `media_object_access` (subida única de un asset propio en cuarentena vigente y cuenta activa; lectura del dueño; retirada solo de cuarentenas u objetos sin fila). `tag_normalize` es pura y la ejecuta `authenticated` (columna generada); la purga (`media_asset_purge_*`), la instalación del bucket y los triggers de límites, árbol y referencias no tienen `EXECUTE` de cliente. Contrato completo: [contratos-o13](spec-pendientes/contratos-o13.md).

**Lectura y préstamos de O14 (0015).** `reading_cycles`, `reading_entries` y `loans`: RLS con `user_id = (select auth.uid())`, `SELECT, INSERT, UPDATE, DELETE` para `authenticated`, política RESTRICTIVE de cuenta activa en cada escritura y FK con la copia (o el ciclo) del mismo dueño. `anon`, nada. Las funciones que usan las acciones (`reading_cycle_start`, `reading_cycle_close`, `loan_open`, `loan_return`) son `SECURITY INVOKER`: corren con la RLS y las políticas de quien llama, toman el dueño de `auth.uid()`, fijan `search_path=pg_catalog`, lanzan BD001 con la cuenta en eliminación y solo las ejecuta `authenticated` (`tests/integration/security/exposicion.test.mjs`). La guarda de páginas (`guard_reading_entry_pages`) no tiene `EXECUTE` de cliente. Un préstamo guarda un alias corto sin `@` ni más de 6 dígitos: nunca correo ni teléfono. Contrato: [contratos-o14](spec-pendientes/contratos-o14.md).

### Funciones `SECURITY DEFINER` (0003–0005)

Todas son propiedad de `postgres`, fijan `search_path=pg_catalog` y no conceden `EXECUTE` a `PUBLIC` ni a `anon`.

| Migración | Función | `EXECUTE` de `authenticated` |
| --- | --- | --- |
| 0003 | `lock_library()` | **Sí** (bloqueo de la propia biblioteca) |
| 0003 | `rotate_library_revision()` | No (trigger) |
| 0004 | `catalogue_begin`, `catalogue_complete`, `catalogue_invalidate`, `catalogue_private_get`, `catalogue_private_put`, `catalogue_release`, `catalogue_reserve` | No (solo el servidor) |
| 0005 | `library_job_create(...)`, `library_job_control(...)` | **Sí** (el dueño sale de `auth.uid()`) |
| 0005 | `library_job_claim`, `library_job_fence`, `library_job_renew`, `account_is_active`, `account_set_state` | No (worker y ciclo de cuenta) |

| 0013 | `account_write_allowed()`, `account_deletion_request(text)`, `account_deletion_status()` | **Sí** (guarda de las políticas RESTRICTIVE; solicitar y consultar la propia eliminación con `auth.uid()`) |
| 0013 | `account_deletion_claim`, `_renew`, `_lease`, `_purge`, `_objects`, `_advance`, `_fail`, `_complete`, `_retry`, `_suppress`, `_purge_marks`, `_step_remaining`, `account_residue` | No (worker administrativo y restore) |

`biblib.rotate_book_version()` (0002) no es definer; es la función del trigger de versión y no se puede invocar fuera de un trigger.

**Cómo accede la app:** el servidor de Next abre Postgres con `SUPABASE_DB_URL` y ejecuta cada acción en una transacción con el rol `authenticated` local a la transacción (`set_config('role', 'authenticated', true)`, equivalente a `set local role`) y los claims del usuario (`lib/db/client.ts`), de modo que RLS y los grants anteriores se aplican igual que a una sesión real. La credencial de base sigue siendo un secreto de servidor con acceso total: un rol dedicado para producción queda como mejora fuera de esta unidad.

## Credencial `service_role` (hallazgo de U-QA-01)

- **Antes:** `scripts/next-target.mjs` pasaba al proceso de Next todo `childEnv(loadTarget("local"))`, incluida `SUPABASE_SERVICE_ROLE_KEY` local. Además, el `.env.local` que genera el bootstrap de `main` la contiene y Next lo carga por su cuenta.
- **Ahora:** `appEnv(ctx)` (`scripts/db/environment.mjs`) parte de `childEnv` y fija **vacías** las claves de `APP_EXCLUDED_KEYS` (`SUPABASE_SERVICE_ROLE_KEY`). `next-target.mjs` la usa para `dev`, `build` y `start`. Al quedar definida y vacía, Next no la rellena desde `.env.local`, porque no sobrescribe variables ya presentes.
- **Nadie en la app la usa:** ninguna ruta, acción, componente, hook, `lib/`, `proxy.ts` ni `next.config.mjs` contiene `service_role`, `SERVICE_ROLE` ni `auth.admin` (prueba estática en `test:scripts`). `check:bundle` sigue vigilando el bundle cliente.
- **Quién la usa y cómo la obtiene:** el seed, los fixtures, `db:backup|restore`, `verify` y los runners de pruebas la leen de su propio `loadTarget("local", { profile })` (`supabase status` del workdir del perfil o `.env.local` acreditado), siempre fuera del proceso de Next.
- **Worker de trabajos (U-DAT-03):** no la necesita. `pnpm jobs:run:local` deriva el token del ejecutor (HMAC de `SUPABASE_DB_URL`, o `BIBLIB_JOBS_RUNNER_SECRET`) desde su propio `loadTarget` y llama a `/api/internal/jobs/run`. La app ejecuta los pasos con su conexión Postgres; el dueño sale de la fila reclamada.
- **Límite:** `pnpm dev` / `pnpm start` sin wrapper no pasan por `appEnv` y cargarían el `.env.local` de `main` tal cual. Usa los wrappers `dev:local` / `start:local`.

## Matriz de caché y cabeceras por tipo de respuesta

Cabeceras globales en **todas** las respuestas (`next.config.mjs`, regla `/(.*)`):

| Cabecera | Valor |
| --- | --- |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Cross-Origin-Opener-Policy` | `same-origin` (el OAuth es por redirección, no por ventana emergente) |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()`. La cámara la habilitará U-EXP-05 solo en su ruta. |

Por tipo de respuesta (valores efectivos medidos con `security:headers:local`, 35/35 coincidencias; informe en [la evidencia](validacion/2026-10-23/O09/ops-04/cabeceras-scratch.json)):

| Tipo | Ejemplos | Estado | `Cache-Control` | `Vary` | CSP Report-Only |
| --- | --- | --- | --- | --- | --- |
| HTML autenticado | Las 9 rutas privadas con sesión de A | 200 | `private, no-store` | El de Next (`rsc, next-router-*, Accept-Encoding`) | Sí, con nonce en todos los `<script>` |
| HTML público | `/login` anónimo | 200 | `private, no-store` | El de Next | Sí, con nonce |
| HTML 404 | `/ruta-inexistente` | 404 | `private, no-cache, no-store, max-age=0, must-revalidate` (propio de Next) | El de Next | Sí, con nonce |
| Redirección de sesión | Ruta privada anónima; `/login` con sesión | 307 | `private, no-store` | `Cookie` | Sí |
| Callback | `/auth/callback` (válido, inválido, externo, `//`, `/\`) | 303 | `private, no-store` | `Cookie, rsc, …` | Sí |
| Server Action | `POST /` con `Next-Action` | 200 `text/x-component` | `no-cache, no-store, max-age=0, must-revalidate` (fijo en Next) | El de Next | Sí |
| API | `/api/books/search`, `/api/books/add`, `/api/internal/jobs/run` sin credencial | 401 JSON | `private, no-store` | `Cookie, rsc, …` | No (fuera del proxy) |
| Estático con hash | `/_next/static/chunks/*` | 200 | `public, max-age=31536000, immutable` (fijo en Next) | `Accept-Encoding` | No; nunca `Set-Cookie` |
| Archivo de `public/` | `/logo.png`, `/default-book-cover.webp`, `/manifest.webmanifest` | 200 | `public, max-age=0` (Next) | — | Solo el manifiesto (pasa por el proxy); nunca `Set-Cookie` |

Notas:

- **Antes de U-OPS-04** el HTML autenticado salía como página estática con `Cache-Control: s-maxage=31536000`: un CDN podía guardarlo, y con él un `Set-Cookie` de una sesión renovada por el proxy. Ahora todas las páginas se renderizan dinámicamente y no hay `s-maxage` ni `public` en nada que dependa de cookies.
- **Server Actions:** Next 16 fija su `Cache-Control` en `action-handler` y no admite sustituirlo. No incluye `private`, pero `no-store` prohíbe guardarlas en cualquier caché (RFC 9111 §5.2.2.5). Se registra el valor exacto en la matriz.
- **`Vary: Cookie` en HTML:** Next sobrescribe `Vary` en las páginas para la negociación RSC, así que el HTML no lo lleva. La garantía es `no-store`. Las redirecciones del proxy, el callback y la API sí llevan `Vary: Cookie`.
- La regla de caché privada de `next.config.mjs` se aplica a todo salvo `_next/static/`, `_next/image` y extensiones de archivos de `public/` (`png`, `jpg`, `jpeg`, `svg`, `webp`, `ico`, `webmanifest`, `txt`, `xml`).

## CSP en modo informe

`proxy.ts` genera un nonce de 128 bits por petición, lo pasa a Next en la cabecera de petición `Content-Security-Policy-Report-Only` y al layout en `x-nonce`, y publica la misma política en la respuesta. Next 16 lee el nonce de esa cabecera (también en Report-Only) y lo aplica a sus scripts; el script inline de `next-themes` recibe el mismo nonce desde `app/layout.tsx`.

```text
default-src 'self';
script-src 'self' 'nonce-<por petición>' 'strict-dynamic';        (+ 'unsafe-eval' solo con NODE_ENV=development)
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https://covers.openlibrary.org <Supabase del objetivo>;   (+ books.google.com y books.googleusercontent.com solo con BIBLIB_GOOGLE_BOOKS_ENABLED=true)
font-src 'self' data:;
connect-src 'self' <Supabase del objetivo>;
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

- **Hosts:** el navegador solo habla con la app y con GoTrue del objetivo (`NEXT_PUBLIC_SUPABASE_URL`). Las portadas persistentes son de Open Library. BNE no aporta imágenes (solo metadatos y enlaces), así que no figura. Google solo aparece en `img-src` con la vista previa activada; las llamadas a la API de Google las hace el servidor.
- **`style-src 'unsafe-inline'`:** React usa atributos `style` (Radix, transformaciones de la vista 3D), que no admiten nonce. Los scripts no tienen `'unsafe-inline'`.
- **`upgrade-insecure-requests`** no se incluye: Report-Only lo ignora y en local rompería las llamadas a `http://127.0.0.1`. Se decidirá con HTTPS real.
- **Render dinámico:** Next 16 solo aplica nonces en páginas dinámicas. Con la aprobación del coordinador (opción A), `app/layout.tsx` llama a `connection()` (commit aislado `ac2c723`). `pnpm build` marca ahora todas las rutas como `ƒ` (antes, 9 de 15 eran `○`).

### Resultado en navegador (Chrome, sin red externa)

`tests/integration/security/csp-navegador.test.mjs` recorre `/`, `/books`, `/books/add`, `/books/search`, `/book/[id]`, `/shelves`, `/shelves/3d`, `/settings` y `/profile` con la sesión de A, y además el acceso anónimo y `/login`. Recoge los eventos `securitypolicyviolation` y aborta cualquier petición fuera del loopback después de que la CSP la evalúe.

- Sin errores de página ni violaciones, salvo **una violación explicada**: `script-src` / `eval` en `/books/add`, `/book/[id]` y `/settings`. La causa es la sonda `allowsEval` de Zod 4 (`Function("")` dentro de un `try/catch`), que llega al cliente por `components/bibliography-review.tsx` → `lib/bibliographic-catalog/normalize.ts` y por `lib/library-export.ts` → `lib/backup-v2.ts`. La prueba solo la acepta si el script que la dispara es el chunk propio que contiene esa sonda. Con la CSP en vigor, la sonda falla y Zod valida sin JIT: no rompe nada. Antes de pasar a enforcement conviene silenciarla con `z.config({ jitless: true })` en el código cliente (fuera de esta unidad).
- Una imagen de un host no previsto se informa como `img-src` con disposición `report` y no bloquea la página: así se detectará una portada heredada de otro dominio.
- **Desarrollo (`dev:local`):** los nonces funcionan, `'unsafe-eval'` se añade como pide Next para React y no hubo violaciones en `/login`, `/`, `/books`, `/books/add` ni `/settings` ([evidencia](validacion/2026-10-23/O09/ops-04/csp-desarrollo.json)). No se observó ningún fallo de nonces en desarrollo.

**Recuperación:** ante una incompatibilidad, la CSP sigue en informe (o vuelve a él). Retirar la CSP o una capacidad opcional no cambia la autorización de datos. Nunca se desactiva RLS, la protección de rutas ni la validación del callback para resolver una incidencia.

## Sesión local real

Probado con GoTrue y cookies SSR del perfil `scratch` (`tests/integration/security/sesion.test.mjs` y `aislamiento.test.mjs`):

- **Acceso por el formulario local (U-LOC-01):** la acción recibe el `FormData` codificado como en el navegador. GoTrue valida, la respuesta fija `sb-<ref>-auth-token` con `Path=/` y `SameSite=Lax`, conserva el destino interno (`/books?status=read`) y la página privada responde 200 `private, no-store`. Las credenciales erróneas o una cuenta inexistente reciben el mismo mensaje y ninguna cookie. Los destinos `https://…`, `//…`, `/\…` y `/login?redirect=//…` vuelven a `/`.
- **Renovación:** con el acceso vencido, el proxy renueva con el refresh token real (rotado), mantiene la identidad y sirve la página `private, no-store`. Las acciones siguientes funcionan con las cookies nuevas.
- **Cierre:** tras el logout de GoTrue (el mismo endpoint que usa `AuthProvider.signOut`), las cookies antiguas vuelven a `/login?redirect=<ruta y consulta>` y el refresh token se rechaza.
- **Callback con destino interno:** flujo PKCE real. El OTP de GoTrue llega a Mailpit, la verificación en GoTrue redirige a `/auth/callback?next=…&code=…` y el callback canjea el código con el verificador de la cookie: 303 al destino, con sesión. Repetir el código vuelve al acceso. Con un código válido, `next` externo, `//` o `/\` redirige a `/`. Sin código, con un código inventado o con `error` del proveedor, vuelve a `/login?error=oauth` sin cookie de sesión.
- **Ninguna respuesta de A en otra sesión:** se repite la misma URL (7 páginas y 4 acciones de lectura en la misma ruta) como A, B y anónimo, intercalando el orden. Ningún cuerpo de B ni anónimo contiene IDs, títulos propios ni el correo de A, y viceversa. Anónimo recibe 307 y la acción no se ejecuta. Todas las respuestas son `no-store`. `/book/<libro de A>` como B responde 404 y `getBookDetailAction` devuelve `null`.

Esto no prueba un CDN: localmente no hay caché compartida. La garantía local es que ninguna respuesta con datos o cookies es almacenable.

## Verificación de sesión por petición (U-FIX-02)

**Unidad:** U-FIX-02 (tarea T3 de [U-QA-03](validacion/rendimiento/2026-10-23/informe.md#9-tareas-por-presupuesto-incumplido)) · **Fecha:** 23 de octubre de 2026 · Aprobado por el coordinador con las condiciones que se listan abajo. Medición: [validacion/rendimiento/2026-10-23-fix-02](validacion/rendimiento/2026-10-23-fix-02/informe.md).

**Antes:** cada petición a una ruta privada llamaba a `getUser()` (GET `/auth/v1/user` a GoTrue) dos veces: una en `proxy.ts` y otra en `getRequiredUserId()` dentro de la acción. Eran 2,04–2,1 llamadas por acción y ~45–50 ms cada una, el 65–75 % del p50 de una acción con una sesión.

**Ahora:** una sola llamada a GoTrue por petición, en lecturas y en escrituras, sin aceptar tokens revocados.

1. `proxy.ts` sigue verificando la sesión con `getUser()` (y la renueva si el acceso venció), como antes. Si es válida, añade a la petición **reenviada** la cabecera interna `x-biblib-session-attestation`: `v1.<emitida en ms>.<nonce>.<user id>.<HMAC-SHA256>`. La firma cubre el usuario que devolvió GoTrue, el **sha256 del access token** que lleva la petición y el **nonce de esa petición** (el de la CSP, `x-nonce`, que el proxy fija en cada petición).
2. `getRequiredUserId()` (`lib/server-user.ts`) acepta la atestación solo si la firma es de este proceso, el token de las cookies es el mismo, el nonce es el de la petición y tiene **≤ 30 s**. Además **verifica el JWT localmente** (`getClaims()`: firma ES256 con el JWKS de GoTrue, caché de 10 min por proceso, y `exp`) y exige que su `sub` coincida con la atestación y que el rol sea `authenticated`. El usuario sale del JWT verificado; la cabecera solo prueba que GoTrue validó esa sesión en esta misma petición.
3. Cualquier ausencia o fallo (rutas `/api/*`, que no pasan por el proxy; firma de otro proceso; otro token; caducada; otro nonce) hace `getUser()` contra GoTrue, como antes. La atestación nunca concede acceso por sí sola.
4. Dentro de una petición, el resultado se memoiza por objeto de petición (`headers()`) y por access token (`createRequestMemo`, `lib/supabase/session-attestation.ts`): varias llamadas a `getRequiredUserId()` en la misma acción no repiten la verificación, y dos peticiones o dos tokens nunca comparten resultado.

**Condiciones de la aprobación (todas implementadas y probadas):**

| Condición | Dónde |
| --- | --- |
| El proxy elimina siempre la cabecera de atestación que envíe el cliente, en cualquier ruta y antes de añadir la suya. | `forward()` en `proxy.ts`; `revocacion.test.mjs` (cabecera fabricada → 307). |
| Clave HMAC aleatoria por proceso (32 bytes de `randomBytes`), solo en memoria (`globalThis` con un `Symbol.for`); nunca se registra, exporta ni escribe en disco o variables de entorno. | `processKey()` en `lib/supabase/session-attestation.ts`. |
| Liga sha256(token) + user id + nonce único de la petición + marca de tiempo ≤ 30 s; la acción verifica además el JWT en local y exige el mismo `sub`. Cualquier fallo → `getUser()`. | `verifySessionAttestation`, `attestedUserId` en `lib/server-user.ts`. |
| Si proxy y acción se ejecutan en procesos distintos, la atestación no valida y se cae a `getUser()`. | Comportamiento esperado (abajo). |
| Pruebas: cabecera falsificada o de otro proceso, otro token/usuario, caducada, reutilizada en otra petición, sesión cerrada con token no caducado → 307 y escritura con token revocado rechazada. | `tests/session-attestation.test.ts` (`pnpm test`) y `tests/integration/security/revocacion.test.mjs`; la prueba existente de `auth/sesion` (307 de `getLibraryDataAction` tras el cierre) sigue en verde. |

**Revocación inmediata.** No cambia: en las rutas que pasan por el proxy, GoTrue valida la sesión en cada petición, así que una sesión cerrada recibe 307 antes de ejecutar la acción, sea lectura o escritura. La atestación solo vive dentro de la petición que la creó (nonce) y caduca a los 30 s; no es reutilizable en otra petición ni sale en ninguna respuesta. En `/api/*` la acción vuelve a consultar a GoTrue.

**Despliegue en procesos separados (comportamiento esperado, no un fallo).** La clave existe solo en el proceso que la creó. En `next start` el proxy (runtime Node) y las acciones comparten proceso y la atestación valida. Si un alojamiento ejecuta el proxy en otro proceso o instancia (p. ej. un middleware separado), la firma no valida, la acción hace `getUser()` y se vuelve a las dos llamadas por petición: más latencia, la misma seguridad. Para recuperar la ganancia allí habría que compartir la clave por un canal de secretos del alojamiento; no se ha hecho.

**Por qué no las otras opciones.**

- **(a) `cache()` de React por petición:** dentro de una Server Action Next 16 no hay una petición Flight activa (`resolveRequest()` es nulo) y `cache()` devuelve una caché nueva en cada llamada: no memoiza. Por eso la memo es propia. Y aunque memoizara, no quitaría la llamada del proxy, que es otra fase de la petición.
- **(b) `getClaims()` local en la acción, sin GoTrue:** el stack firma con ES256 y la verificación local funciona, pero un token revocado seguiría siendo válido hasta su `exp` (`jwt_expiry = 3600`, una hora). Para lecturas detrás del proxy no haría falta (el proxy ya llamó a GoTrue), pero la acción no puede saber si el proxy se ejecutó sin una señal infalsificable: eso es justo la atestación. `getClaims()` en el **proxy** rompería además el contrato de `auth/sesion`: una acción con las cookies de una sesión cerrada debe recibir 307.
- **(c) Mantener la doble llamada:** cuesta ~45–50 ms por acción sin ganar seguridad: las dos verifican lo mismo en la misma petición.

**Nunca** se lee el usuario de una cabecera o cookie sin firmar: el usuario sale de `getUser()` o de un JWT verificado con el JWKS de GoTrue que coincide con una atestación firmada por este proceso.

## Portadas privadas (U-DAT-10)

- **Sin hosts nuevos en la CSP.** La portada privada se sirve desde el propio origen (`/api/covers/<asset>`), cubierto por `img-src 'self'`. La respuesta lleva:
  - `Cache-Control: private, no-store` y `Vary: Cookie`;
  - `Content-Type: image/webp` y `X-Content-Type-Options: nosniff`;
  - `Content-Security-Policy: default-src 'none'; sandbox` (solo en la imagen);
  - `Cross-Origin-Resource-Policy: same-origin`.

  Un asset ajeno, inexistente, en cuarentena o con licencia vencida responde 404, igual que uno que no existe; sin sesión, 401. La matriz de cabeceras incluye la ruta.
- **Dos barreras.** El servidor comprueba sesión, dueño (RLS de `cover_assets`), estado, licencia y sha256 del objeto. Además descarga con la sesión del dueño, así que las políticas `biblib_covers_*` de `storage.objects` vuelven a decidir. B no puede leer, firmar, listar, subir, sustituir ni retirar objetos de A ni con su JWT directo contra Storage; conocer el UUID o la ruta no basta. `anon` no tiene ninguna política.
- **Sin credencial administrativa en la app.** Las escrituras en Storage usan la sesión del dueño. La política de subida solo admite el intento autorizado (token de la subida o número de fencing del trabajo con su lease vigente) y la cuenta activa. La purga global la hace `pnpm assets:purge:local`, fuera de Next.
- **Enlaces firmados.** La app no emite URL firmadas. El dueño podría firmar sus propios objetos con su JWT contra Storage. Un enlace firmado da acceso mientras dure su TTL aunque la fila cambie después: RLS no revoca un enlace ya emitido. Por eso la app no los usa ni los respalda.
- **SSRF.** La adquisición nunca recibe una URL. Usa hosts HTTPS fijos por proveedor, la IP resuelta una vez y fijada, y bloquea redes privadas, link-local, metadatos cloud, IPv4 mapeada, NAT64 y 6to4. No sigue redirecciones, solo admite el puerto 443 y tiene límites de 5 MiB y 8 s ([operación](operacion.md#portadas-privadas--u-dat-10-o11)).
- **Funciones `SECURITY DEFINER` para `authenticated`** (lista de `tests/integration/security/exposicion.test.mjs`): `cover_asset_request`, `cover_asset_begin_upload`, `cover_asset_authorize`, `cover_asset_register`, `cover_asset_discard`, `cover_asset_revalidate` y `cover_object_access` (la guarda de las políticas). Todas toman el dueño de `auth.uid()`. La purga, la cuota y el restore no se conceden a ningún rol de cliente.
- **Huella de plataforma de la promoción** (`platformFingerprint`): excluye las políticas `biblib_*` de `storage.objects`, que son del dominio y comprueba el manifest de objetos. Cualquier otro cambio en `auth` o `storage` sigue haciendo fallar la promoción.
## Eliminación de cuenta (U-OPS-03)

- **Cuenta de la sesión, nunca del cliente.** `requestAccountDeletionAction` toma la cuenta de `getRequiredUserId()` y rechaza cualquier campo adicional; `account_deletion_request` no tiene parámetro de cuenta (`auth.uid()`). Exige la frase escrita y un inicio de sesión de hace menos de 15 minutos según el claim `amr` del JWT verificado con el JWKS de GoTrue.
- **Revocación.** La acción cierra todas las sesiones con el logout global de GoTrue usando el token del propio usuario (Next sigue sin `service_role`). El worker administrativo, fuera de Next, bloquea la cuenta en GoTrue (`ban_duration`) para que un refresh token superviviente o un inicio de sesión nuevo (también con Google) fallen, y al final borra la identidad. `admin.signOut(jwt, "global")` exige un JWT del usuario que el proceso administrativo no tiene y que no se guarda: por eso se combina el logout del propio usuario con el bloqueo (decisión de U-OPS-03, propuesta al coordinador).
- **JWT antiguo.** Hasta que caduca (1 h) un JWT emitido antes de la solicitud sigue siendo criptográficamente válido para la Data API y Storage, que no consultan las sesiones de GoTrue. No escribe: `biblib` no está expuesto en la Data API; las políticas RESTRICTIVE `*_insert|update|delete_active` de todas las tablas con escritura de cliente, `lock_library()` y las funciones definer de escritura llaman a `account_write_allowed()` (BD001); `cover_object_access` exige cuenta activa para subir y retirar en `storage.objects`. Una cuenta ya borrada tampoco escribe: su marca basta para la guarda y las FK a `auth.users` impiden recrear filas. Lee lo suyo hasta que el worker lo retira.
- **Sin vía de reactivación.** `account_lifecycle` y `account_deletions` no tienen privilegios de escritura para clientes (`account_deletions` ni siquiera de lectura: el estado sale de `account_deletion_status()` sin códigos técnicos); `account_set_state` no es ejecutable por clientes y rechaza una cuenta en eliminación (BD002).
- **Prueba:** `tests/db/account-deletion.sql` (guardas, permisos e inventario), `tests/integration/account/` (acciones, Data API y Storage con el JWT antiguo, GoTrue) y la lista de definers de `tests/integration/security/exposicion.test.mjs`.

## Pendientes

Ninguno de estos puntos se ha verificado en local; no se presentan como superados.

1. **HTTPS real del alojamiento:** atributos `Secure` de las cookies SSR, HSTS (lo gestiona el alojamiento; no se fija en `next.config.mjs`), `upgrade-insecure-requests` y repetición de `security:headers:local` contra la URL publicada. No hay alojamiento ni destino remoto autorizados.
2. **CDN:** comprobar en el alojamiento que HTML, acciones, callback y API no se guardan (cabeceras de caché del proveedor, `x-vercel-cache` o equivalente) y que los estáticos sí.
3. **Google OAuth real con cuenta de prueba:** acceso, callback con `next`, fallo/cancelación del proveedor y cierre. Requiere configurar el proveedor en un proyecto no productivo.
4. **CSP en enforcement:** recoger informes en el alojamiento (se necesita un endpoint `report-to`, coordinado con la observabilidad de U-OPS-01), silenciar la sonda de Zod y solo entonces cambiar a `Content-Security-Policy`. Ante cualquier rotura, volver a informe.
5. **Repetición al integrar U-EXP-05 (cámara):** `Permissions-Policy: camera=(self)` solo en su ruta; repetir la matriz y la prueba en navegador de esa área.
6. **Repetición al integrar U-EXP-08 (offline):** service worker sin HTML autenticado, acciones ni respuestas con cookies en caché; repetir aislamiento A/B y matriz.
7. **Rol de base dedicado** para el servidor en preproducción/producción, en lugar de la URL con acceso total (fuera de U-OPS-04).

## Avatar e imágenes privadas de O13 (U-EXP-06)

`GET /api/media/[id]` figura en la matriz como API anónima (401 JSON, `private, no-store`, `Vary: Cookie`). Una lectura autorizada devuelve WebP con `nosniff`, `Cross-Origin-Resource-Policy: same-origin` y `Content-Security-Policy: default-src 'none'; sandbox`. No añade hosts a la CSP; el navegador usa el mismo origen. El helper vuelve a comprobar dueño y estado con RLS, y descarga con la sesión del dueño. La subida reencodifica sin metadatos y la sustitución publica solo después del registro; la metadata OAuth permanece intacta. La edición está desactivada salvo `BIBLIB_PRIVATE_MEDIA_UPLOADS=1`; retirarla no borra imágenes. La purga administrativa se ejecuta fuera de Next (`media:purge:local`), como las portadas. Detalles y pruebas en [operación](operacion.md#avatar-personal-e-imágenes-privadas--u-exp-06-o13).

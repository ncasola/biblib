# U-QA-01 · Integración con Supabase local real (O06)

**Fecha:** 23-10-2026 · **Rama:** `u-qa-01` (hija de `feature/spec-pendientes`, base `cadabe1`) · **Entorno:** Windows 11, Docker Desktop 29.4.3, Node 24.11.1, pnpm 10.32.1, Supabase CLI 2.117.0 · **Perfil:** `test` (`biblib-test`, 55330–55339, app 3148).

## Commits

| Commit | Contenido |
| --- | --- |
| `1ea7b28` | `fix(stack)`: permite `up`/`bootstrap` del perfil `test` desde un worktree (`main` sigue prohibido). Lo autorizó el coordinador; hay que conciliarlo con U-INF-06 al fusionar. |
| `39b5030` | `test(integracion)`: runner `pnpm test:integration:local`, suite `tests/integration/{auth,rls,storage}`, utilidades `tests/integration/lib/` y pruebas sin Docker en `tests/scripts/integration-runner.test.mjs`. |
| siguiente | `docs`: sección «Integración Supabase real · U-QA-01» en `docs/operacion.md` y esta evidencia. |

No se modificó `tests/integration/support/**`, el esquema ni las acciones.

## Comandos ejecutados

```text
pnpm db:local:doctor --profile test                 → 0
pnpm db:local:bootstrap --profile test              → 0 (preflight, stack, env, migrate, seed; verify pendiente de U-INF-06)
pnpm test:integration:local                         → 0  (run-1.txt)
pnpm test:integration:local                         → 0  (run-2.txt, inmediatamente después, sin intervención)
pnpm test:integration:local --reuse-build + prueba DEMO temporal que falla → 11 (fallo-demostrado.txt; el archivo DEMO no se versiona)
pnpm lint / typecheck / test / test:scripts         → 0 / 0 / 0 (66/66) / 0 (107 pass, 1 skip [stack] de scratch)
pnpm db:local:down --profile test                   → 0
```

## Resultado

- **Dos ejecuciones seguidas en verde:** 34/34 escenarios en cada una (33 en el lote principal y la caída de servicios en un lote final). Cada una tardó unos 80 s con build. Al terminar, las cuentas de Auth no habían cambiado (2, `@biblib.test`) y la limpieza estaba completa.
- **Restos tras las dos ejecuciones** (`residuos.json`): 0 libros, 0 estanterías y 0 objetos `qa-01/` del run, 0 metadatos `qa01_*`. Quedan las 8 fichas y 6 estanterías del censo y `fixtures/portada.webp`.
- **Fallo demostrado:** el runner salió con 11, marcó el escenario con `✖` y el JWT comparado aparece como `[jwt oculto]`. Ninguna evidencia contiene patrones `eyJ…` ni `base64-…`.

### Aceptación de U-QA-01 (04)

| Criterio | Evidencia |
| --- | --- |
| A no accede a recursos de B manipulando IDs o rutas | `rls/acciones-ab`: 9 acciones y la API con IDs de B dan `NOT_FOUND`/404 y B no cambia. `rls/sql-roles`: 0 filas, `42501` y `23503` con el rol `authenticated` real. |
| Anónimo no obtiene datos | El proxy responde 307 a acciones y páginas y `/api/books/add` devuelve 401. Data API: 406 `PGRST106`. Rol `anon` en SQL: `42501`. Storage anónimo rechazado. |
| Renovación válida mantiene destino; revocada vuelve al acceso | `auth/sesion`: una sesión vencida con refresh válido devuelve 200 en `/books?status=read`, con cookies renovadas. Con el refresh revocado: 307 a `/login?redirect=/books?status=read`. |
| Cerrar sesión elimina la vista privada | `auth/sesion`: cookies SSR vaciadas. Una copia antigua de las cookies, su access token y su refresh se rechazan. |
| Storage de fixtures: rechazo anónimo y acceso firmado | `storage/fixtures`: bucket privado. La firma del proceso de prueba devuelve los bytes exactos; alterada, para otra ruta o caducada se rechaza. |
| Assets por propietario | Pendiente de U-DAT-10, como indica la spec. Está documentado en «Qué no cubre». |
| Fallback de portada sin red | Una ficha sin portada guarda `/default-book-cover.webp` sin red. La app sirve ese archivo aunque Supabase esté caído. El `onError` del navegador corresponde a U-QA-02. |
| No se crean usuarios reales | Lo comprueban `auth/cuentas` y la comparación de cuentas antes y después que hace el runner. Mailpit solo tiene destinatarios `@biblib.test`. |
| Un fallo sale distinto de cero y sin tokens | `fallo-demostrado.txt`. Lo cubren también las pruebas del enmascarado en `tests/scripts`. |

Pruebas adicionales de la spec cubiertas:

- Fixture del seed acreditado. No se vuelve a sembrar: véase el hallazgo 4.
- Caída de Auth/Storage (gateway propio).
- Cierre y renovación concurrentes.
- Sesión caducada.
- Conexión reutilizada A→B→sin claims, en SQL directo y en la app.
- Transacción fallida.
- Trigger `books_rotate_version` con el rol real.
- Estantería predeterminada protegida, en la app y en SQL.

## Decisiones

- **Runner:** se escribió en `.mjs` con `node --test`, como `tests/scripts` y los helpers de U-INF-05, sin paso de compilación TS.
- **Acciones de dominio por HTTP contra la app real** (`build:local`/`start:local --profile test`, 3148), con `Next-Action` y el ID del manifiesto del build. Prueban proxy, `getUser`, `withRlsContext` y la conexión compartida `max: 1` tal como se ejecutan en producción. No hay endpoints ni bypass nuevos.
- **Caída de servicios:** se simula deteniendo el contenedor Kong propio, identificado por el ID registrado tras `assertOwnership`, y se vuelve a arrancar. El ID y la IP se conservan, y `db:local:status` sigue acreditando la propiedad.

## Hallazgos y conflictos

1. **Ningún fallo de aislamiento.** Todas las vías cruzadas probadas fueron rechazadas.
2. **La clave de servicio local llega al proceso servidor de Next.** `scripts/next-target.mjs` (U-INF-02) pasa a ese proceso, con `childEnv(loadTarget("local"))`, todas las variables, incluida `SUPABASE_SERVICE_ROLE_KEY` local, aunque la app no la usa. No llega al bundle: `check:bundle` en verde en cada ejecución. Está fuera de scope (`scripts/`) y es recomendable filtrarla en una unidad posterior.
3. **Un upstream caído bloquea las peticiones ~60 s.** Si se detiene GoTrue o Storage por separado, Kong espera al upstream unos 60 s. Durante ese tiempo el proxy de la app no responde, porque `getUser` no tiene timeout. Se observó en el ensayo y afecta a U-OPS/U-QA-02. La suite simula la caída en el gateway.
4. **Límites de GoTrue.** `sign_in_sign_ups` admite 30 cada 5 min por IP; la suite hace 8 inicios de sesión por ejecución. `email_sent` admite 2 por hora, así que el runner no vuelve a sembrar: el seed pide un correo si han pasado más de 65 s.
5. **Conflicto previsto con U-INF-06** en `scripts/local-stack.mjs:245-246` y `tests/scripts/local-stack.test.mjs` (prueba «worktree…»).
6. **`pg_graphql` no está habilitado** en el stack. La prueba lo acepta y seguiría exigiendo que no aparezcan las tablas si se activa.

## Recursos y coexistencia

- **HolaERP idéntico** (`holaerp-antes.txt` / `holaerp-despues.txt`): mismos IDs, `StartedAt`, reinicios, redes y volúmenes. La única diferencia es el texto relativo «Exited … ago» de `supabase_edge_runtime_holaerp`, que ya estaba parado antes de empezar.
- **Recursos que quedan** (`recursos-finales.txt`):
  - Red `biblib-test-network`, con etiquetas `biblib.profile=test` y `biblib.root=8bb89943a348fe10`.
  - Volúmenes `supabase_db_biblib-test` y `supabase_storage_biblib-test`.
  - 0 contenedores.
  - Estado `.biblib/` del worktree: `state/test.json`, `fixtures/test.json` (privado) e `integration/{build,app}.log`.
  - `.next-local` (ignorado).
- **Recursos de `scratch` de otra raíz:** no se tocaron.
- **Limitación conocida:** con el perfil arrancado, `doctor`/`status` avisan de bindings en `0.0.0.0`.

## Recuperación

- **Si una ejecución se interrumpe:** el siguiente `pnpm test:integration:local` limpia primero lo registrado en `.biblib/integration/test-run.json`. Si la limpieza no termina, sale con 10 y conserva el manifiesto, sin sesiones.
- **Si la caída simulada falla a medias:** su `after` vuelve a arrancar Kong. También puede recuperarse con `pnpm db:local:up --profile test`, que comprueba la salud y conserva los IDs.

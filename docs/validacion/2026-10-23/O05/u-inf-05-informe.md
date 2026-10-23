# U-INF-05 · Fixtures locales con servicios reales

Validación del 23-10-2026 en la rama `u-inf-05`, worktree `C:/Users/ncaso/orca/workspaces/biblib/u-inf-03`, perfil exclusivo `scratch`. Implementación en `633a739`. No se modificaron migraciones, schema, runner U-INF-04, configuración global de Docker ni recursos ajenos.

## Entrega

- Censo `biblib-local-v1`, versión 1: A/B con correos `@biblib.test`, metadato de fixture, tres estanterías y cuatro libros ficticios por cuenta, con los cuatro estados y altas manuales/ISBN de prueba.
- `pnpm db:seed:local --profile scratch [--json]`: propiedad de Postgres/Auth/Storage/Kong, endpoints y bindings acreditados antes de escribir; ledger y manifest al día; cuentas por API administrativa de GoTrue; dominio en transacción; bucket privado y correo a Mailpit.
- Registro privado ignorado por Git en `.biblib/fixtures/scratch.json`, con ACL restringida en Windows antes de guardar claves/contraseñas. IDs reales de Auth; contraseñas aleatorias estables durante los reintentos. Recuperación de la ventana entre creación de una cuenta y persistencia de su ID mediante correo + metadato de censo.
- Idempotencia por UUID derivado de censo, propietario, tipo y `fixtureKey`; marcadores adicionales `fixtureKey`/`censusId` en el JSON de cada libro. No se añadió una columna ni una migración para los fixtures.
- Harness `signInFixture` con GoTrue real y serialización de cookies por `@supabase/ssr`; acceso humano `pnpm db:local:login --profile scratch --as a|b` mediante servidor temporal de loopback, sin rutas nuevas en el producto.
- Respuestas de catálogo ficticias versionadas y lector mínimo, sin cambiar el flujo de proveedores. Fase `seed` conectada al bootstrap; `verify` permanece pendiente de U-INF-06.

## Ensayo y aceptación

Docker estaba parado al llegar al ensayo. Se consultó al coordinador, se esperaron sus instrucciones y fue el coordinador quien lo arrancó con autorización de Néstor. Antes de `up`, HolaERP estaba sano y se tomó su línea base.

| Criterio U-INF-05 | Evidencia observada |
| --- | --- |
| 1 · Repetición y continuación | Dos ejecuciones del comando conservaron los IDs de A/B; el ensayo adicional confirmó los mismos ocho libros y seis estanterías, sin duplicados. Un libro manual insertado por SQL en A, sin `fixtureKey`, sobrevivió. Las versiones rotaron mediante el trigger existente. Fallo parcial y recuperación de cuenta sin ID persistido cubiertos por simulaciones. |
| 2 · Sesiones válidas e inválidas | A y B obtuvieron sesión real mediante contraseña y `getUser` validó sus IDs. GoTrue rechazó las firmas alteradas. |
| 3 · Renovación, nombre y salida | Ambas cuentas actualizaron su nombre, renovaron sesión y cerraron sesión; se vaciaron las cookies SSR y GoTrue rechazó el refresh revocado. |
| 4 · Acceso local y fixtures offline | Con `fetch` del proceso Next limitado a loopback mediante preload temporal, una petición externa de control fue rechazada e inicio, colección y alta manual autenticados devolvieron 200. Los archivos de catálogo se leyeron sin red. Este ensayo no cambió el firewall global; el proveedor de búsqueda del producto sigue correspondiendo a U-BIB. |
| 5 · Storage privado y correo | Bucket privado `biblib-test-assets`, objeto `fixtures/portada.webp`; lectura anónima rechazada, URL firmada con 200 y bytes idénticos al fallback versionado. Mailpit recibió un correo de GoTrue dirigido a A. El bucket puede inspeccionarse en Studio del mismo perfil. |
| 6 · Privacidad de credenciales | `git grep -I -q -F -f - -- .`, alimentado solo por stdin en memoria con clave administrativa, contraseñas y tokens reales, obtuvo cero coincidencias. Las evidencias y HTML comprobado no contenían esas credenciales. El enlace humano concedió cookies SSR aceptadas por Next (200) y el servidor temporal terminó. No se adjuntan enlaces temporales, cookies, JWT, URLs firmadas ni el archivo privado. |
| 7 · Rechazo de destinos ajenos | Pruebas sin Docker rechazaron HolaERP en 5432/54321, remoto, registro ausente, red ajena, servicio Auth no registrado y bindings API/DB incorrectos antes de crear clientes/escribir. |

`db:plan:local` encontró `0002_book_versions` al día: no hubo migraciones pendientes ni se reaplicó SQL. Un bootstrap real posterior completó migrate y seed y devolvió `phase: verify`, con `verify: pending`, conforme al alcance de U-INF-06.

## Validación ejecutada

| Comando | Resultado |
| --- | --- |
| `BIBLIB_SKIP_STACK_TESTS=1 pnpm test:scripts` | 101 pruebas pasaron; la prueba nueva de stack y el grupo anterior de stack se omitieron. Ninguna dependencia de Docker en las simulaciones. |
| `pnpm test:scripts` con scratch real | **105/105**, cero omitidas, incluidas GoTrue/Storage/Mailpit y las tres pruebas reales de migraciones. |
| `pnpm test:db` | Correcto en Postgres 17 aislado; migraciones, integridad, RLS A/B, FK, estantería predeterminada, versiones y rollback. Contenedor temporal eliminado por su runner. |
| `pnpm lint` | Correcto, sin avisos. |
| `pnpm typecheck` | Correcto. |
| `pnpm test` | **66/66**. |
| Acceso temporal con `dev:local` | Redirección 303, cookies SSR reales, página autenticada 200; procesos propios de ensayo terminados. |
| Comparación de HolaERP | **Sin cambios**, comparación profunda de inventarios antes/después: 11 contenedores, IDs, estado/salud, fecha de arranque, reinicios, puertos/redes y volúmenes. |

Salidas saneadas: `plan.json`, `seed-first.json`, `seed-second.json`, `real-verification.json`, `human-access-security.json`, `offline-http.json`, `bootstrap.json`, `up.json`, `down.json`, `resources-final.json`, `holaerp-before.json`, `holaerp-after.json` y los archivos `lint.txt`, `typecheck.txt`, `test.txt`, `test-db.txt`, `test-scripts.txt`.

## Estado final y límites

`scratch` quedó parado con **cero contenedores**. Se conservan la red `biblib-scratch-network` y los volúmenes `supabase_db_biblib-scratch` y `supabase_storage_biblib-scratch`, con la misma identidad/fecha de creación previa. La aplicación de ensayo en 3149 también quedó parada. El libro manual ficticio `manual-ensayo-o05` permanece en A como evidencia de conservación.

Sigue vigente la limitación conocida de Docker Desktop: bindings en `0.0.0.0`/`::`, señalados por el wrapper. No se cambió daemon ni firewall. No hay bloqueos nuevos ni conflictos de integración. Reset y verify completo quedan en U-INF-06, la matriz RLS completa en U-QA-01, buckets/políticas definitivos en U-DAT-10 y conexión del modo fixture con proveedores en U-BIB; `--remove` es opcional y no se implementó.

`next dev` añadió automáticamente un bloque a `agents.md` durante el acceso real. Se retiró únicamente ese efecto lateral generado después de parar el proceso; el archivo original se conserva sin cambios.

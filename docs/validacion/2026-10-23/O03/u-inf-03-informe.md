# U-INF-03 · Informe de implementación y ensayo

Fecha: 23-10-2026. Rama: `u-inf-03`; checkout hijo de `feature/spec-pendientes`. Ejecución real: **2026-10-23T11:01:03.364Z → 2026-10-23T11:02:28.725Z** (UTC), Windows 11, Node 24.11.1, pnpm 10.32.1, Supabase CLI 2.117.0 y Docker Desktop 29.4.3.

## Entrega

Implementados `doctor`, `status`, `up`, `down` y el contrato parcial de `bootstrap`, con scripts pnpm, argumentos cerrados, salida JSON segura, timeouts, bloqueo por perfil, registro de identidad/recursos y manejo de SIGINT. Se reutilizan perfiles, códigos de salida, carga/limpieza de entorno y `checkPublishedBindings` existentes; **no se modificó environment.mjs**. La sección «Ciclo de vida del stack» de [operación](../../../operacion.md#ciclo-de-vida-del-stack) describe fases, códigos y recuperación.

La red exige etiquetas de raíz/perfil; los recursos de Supabase, que no admiten esas etiquetas personalizadas en el CLI, se acreditan mediante proyecto, red e IDs registrados (volúmenes: nombre/fecha de creación). No se adoptan automáticamente recursos de otro checkout. El coordinador liberó explícitamente los tres recursos del antiguo ensayo U-INF-01 antes de iniciar este ensayo; este worker no eliminó recursos ajenos.

## Validación ejecutada

| Comando | Resultado |
| --- | --- |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | exit 0, 66/66 |
| `pnpm test:scripts` | exit 0, 60/60 |

Las 20 pruebas nuevas de lifecycle simulan procesos, CLI y Docker: solo lectura, secretos, versiones/Docker ausentes, estado/recursos ajenos, worktrees, bloqueo, puertos/rangos excluidos, idempotencia, salud, SIGINT (incluido un segundo intento), bootstrap main/scratch, cambio de identidad durante start, conservación del registro si Docker deja de responder, bindings fuera del bloque y rutas con espacios en Windows/Linux. El ejecutor también se prueba con procesos Node reales para argv, timeout e interrupción. Linux se verificó con ejecutor simulado; no se afirma un ensayo nativo Linux. En el desarrollo se detectó y corrigió que Studio devuelve 307 en `/`; se comprueba `/project/default` sin seguir redirecciones.

## Secuencia real scratch

Cada salida del wrapper se capturó en memoria, se parseó como JSON y se comprobó contra patrones de JWT, URL Postgres con credenciales y clave administrativa antes de incorporarla al informe. No se imprimió `supabase status`, no se consultaron secretos ni bases remotas y no se ejecutaron migraciones ni seed.

| Paso | Comando | Exit | Duración |
| --- | --- | --- | --- |
| 1 | `node scripts/local-stack.mjs doctor --profile scratch --json` | 0 | 1.518 s |
| 2 | `node scripts/local-stack.mjs up --profile scratch --json` | 0 | 29.885 s |
| 3 | `node scripts/local-stack.mjs up --profile scratch --json` | 0 | 1.713 s |
| 4 | `node scripts/local-stack.mjs status --profile scratch --json` | 0 | 1.951 s |
| 5 | `node scripts/local-stack.mjs down --profile scratch --json` | 0 | 7.933 s |
| 6 | `node scripts/local-stack.mjs up --profile scratch --json` | 0 | 30.289 s |
| 7 | `node scripts/local-stack.mjs down --profile scratch --json` | 0 | 5.565 s |
| 8 | `node scripts/local-stack.mjs up --profile scratch --json` | 8 | 1.504 s |
| 9 | `node scripts/local-stack.mjs status --profile scratch --json` | 0 | 1.505 s |

- **Idempotencia:** el segundo up conservó exactamente los mismos **8 IDs**; no invocó otro start.
- **Persistencia:** se creó exclusivamente en scratch una tabla temporal de ensayo `public.biblib_lifecycle_probe` con el marcador ficticio `u-inf-03-preservado`; la misma fila apareció tras down/up y ambos volúmenes conservaron nombre/fecha de creación. La tabla de ensayo se eliminó antes del último down; no se añadió esquema de negocio.
- **Conflicto real:** un servidor Node de prueba escuchó en **127.0.0.1:55349**, PID **20940**; up devolvió **8**, identificó el PID y el listener siguió activo. Solo el harness cerró después su propio listener.
- **Estado final:** scratch parado, cero contenedores activos del perfil; red y los dos volúmenes propios conservados. No quedó la tabla de ensayo.

### Doctor antes del arranque (salida real saneada)

```json
{
  "schemaVersion": 1,
  "target": "local",
  "profile": "scratch",
  "fingerprint": "ea260283d87954c1c405cb5ee4875867dd8b103c86084460f3a74244e06b13fa",
  "endpoints": {
    "api": "http://127.0.0.1:55341",
    "postgres": {
      "host": "127.0.0.1",
      "port": 55342,
      "database": "postgres"
    },
    "studio": "http://127.0.0.1:55343",
    "mailpit": "http://127.0.0.1:55344"
  },
  "services": [
    {
      "name": "postgres",
      "status": "stopped"
    },
    {
      "name": "auth",
      "status": "stopped"
    },
    {
      "name": "rest",
      "status": "stopped"
    },
    {
      "name": "storage",
      "status": "stopped"
    },
    {
      "name": "studio",
      "status": "stopped"
    },
    {
      "name": "mailpit",
      "status": "stopped"
    }
  ],
  "head": null,
  "checks": [
    {
      "id": "manifest",
      "status": "ok",
      "message": "Manifiesto y configuración coherentes."
    },
    {
      "id": "env",
      "status": "ok",
      "message": "Archivos de entorno acreditados o ausentes."
    },
    {
      "id": "state",
      "status": "ok",
      "message": "Registro de recursos coherente o todavía ausente."
    },
    {
      "id": "version.node",
      "status": "ok",
      "message": "Node esperado >=24.11.1 <25; instalado 24.11.1."
    },
    {
      "id": "version.pnpm",
      "status": "ok",
      "message": "pnpm esperado 10.32.1; instalado 10.32.1."
    },
    {
      "id": "version.supabase",
      "status": "ok",
      "message": "supabase esperado 2.117.0; instalado 2.117.0."
    },
    {
      "id": "docker",
      "status": "ok",
      "message": "Motor Docker disponible."
    },
    {
      "id": "ownership",
      "status": "ok",
      "message": "Recursos del perfil con propiedad acreditada."
    },
    {
      "id": "windows.excluded",
      "status": "ok",
      "message": "El perfil no coincide con rangos TCP excluidos de Windows."
    },
    {
      "id": "bindings.loopback",
      "status": "ok",
      "message": "No hay bindings publicados fuera de loopback."
    }
  ]
}
```

### Status del stack sano (JSON real, parseable)

```json
{
  "schemaVersion": 1,
  "target": "local",
  "profile": "scratch",
  "fingerprint": "ea260283d87954c1c405cb5ee4875867dd8b103c86084460f3a74244e06b13fa",
  "endpoints": {
    "api": "http://127.0.0.1:55341",
    "postgres": {
      "host": "127.0.0.1",
      "port": 55342,
      "database": "postgres"
    },
    "studio": "http://127.0.0.1:55343",
    "mailpit": "http://127.0.0.1:55344"
  },
  "services": [
    {
      "name": "postgres",
      "status": "healthy"
    },
    {
      "name": "auth",
      "status": "healthy"
    },
    {
      "name": "rest",
      "status": "running"
    },
    {
      "name": "storage",
      "status": "healthy"
    },
    {
      "name": "studio",
      "status": "healthy"
    },
    {
      "name": "mailpit",
      "status": "healthy"
    }
  ],
  "head": null,
  "checks": [
    {
      "id": "manifest",
      "status": "ok",
      "message": "Manifiesto y configuración coherentes."
    },
    {
      "id": "env",
      "status": "ok",
      "message": "Archivos de entorno acreditados o ausentes."
    },
    {
      "id": "state",
      "status": "ok",
      "message": "Registro de recursos coherente o todavía ausente."
    },
    {
      "id": "version.node",
      "status": "ok",
      "message": "Node esperado >=24.11.1 <25; instalado 24.11.1."
    },
    {
      "id": "version.pnpm",
      "status": "ok",
      "message": "pnpm esperado 10.32.1; instalado 10.32.1."
    },
    {
      "id": "version.supabase",
      "status": "ok",
      "message": "supabase esperado 2.117.0; instalado 2.117.0."
    },
    {
      "id": "docker",
      "status": "ok",
      "message": "Motor Docker disponible."
    },
    {
      "id": "ownership",
      "status": "ok",
      "message": "Recursos del perfil con propiedad acreditada."
    },
    {
      "id": "windows.excluded",
      "status": "ok",
      "message": "El perfil no coincide con rangos TCP excluidos de Windows."
    },
    {
      "id": "bindings.loopback",
      "status": "warn",
      "message": "Hay 8 bindings publicados fuera de loopback; consulta las alternativas A/B en docs/operacion.md (Limitación conocida)."
    }
  ]
}
```

### Puerto ocupado (error real, sin matar al ocupante)

```json
{
  "schemaVersion": 1,
  "target": "local",
  "code": 8,
  "phase": "preflight",
  "correlation": "51879e81-123c-4773-a15f-c2f2c00f46b6",
  "message": "Puerto 55349 ocupado por un proceso ajeno (PID 20940); no se ha detenido."
}
```

### Última parada (salida real saneada)

```json
{
  "schemaVersion": 1,
  "target": "local",
  "profile": "scratch",
  "fingerprint": "ea260283d87954c1c405cb5ee4875867dd8b103c86084460f3a74244e06b13fa",
  "endpoints": {
    "api": "http://127.0.0.1:55341",
    "postgres": {
      "host": "127.0.0.1",
      "port": 55342,
      "database": "postgres"
    },
    "studio": "http://127.0.0.1:55343",
    "mailpit": "http://127.0.0.1:55344"
  },
  "services": [
    {
      "name": "postgres",
      "status": "stopped"
    },
    {
      "name": "auth",
      "status": "stopped"
    },
    {
      "name": "rest",
      "status": "stopped"
    },
    {
      "name": "storage",
      "status": "stopped"
    },
    {
      "name": "studio",
      "status": "stopped"
    },
    {
      "name": "mailpit",
      "status": "stopped"
    }
  ],
  "head": null,
  "checks": [
    {
      "id": "down",
      "status": "ok",
      "message": "Perfil parado; volúmenes conservados."
    }
  ]
}
```

## HolaERP antes y después

Se compararon estructuralmente todos los recursos cuyo nombre contiene `holaerp`: **11 contenedores, 3 redes y 7 volúmenes**. Para contenedores se compararon ID, nombre, Created, StartedAt, RestartCount, estado, redes completas y bindings; para redes ID/nombre; para volúmenes nombre/CreatedAt. Resultado: **idénticos**; sin paradas, recreaciones o reinicios durante el ensayo.

SHA-256 del snapshot normalizado anterior: `9624d6f76eeba34834e0bdfc9aa332ae2e00cbd0e316c24ba5c394de103421a6`.

SHA-256 del snapshot normalizado posterior: `9624d6f76eeba34834e0bdfc9aa332ae2e00cbd0e316c24ba5c394de103421a6`.

| Contenedor | ID anterior = posterior | StartedAt anterior = posterior | Reinicios |
| --- | --- | --- | --- |
| holaerp-local-redis | `2fd62432d826f76a023a55b8a66bcab3b913f9ee4aba0c99ffff08cc2740fed2` | 2026-10-22T08:16:57.256895727Z | 0 |
| supabase_auth_holaerp | `7937bb8bda3761f5cbda8fc93a99a22be0235d250ee9f4a58726a8cfbddae6bb` | 2026-10-23T10:49:15.102763879Z | 0 |
| supabase_db_holaerp | `95dd8a99145e694c97cc91d74f5a86b5b9c0e1b55486827e87774e8f83901120` | 2026-10-23T10:48:52.079974503Z | 0 |
| supabase_edge_runtime_holaerp | `607df66c4564d78aecde432e405f42b709951f0812745919e0c5b3b87474c610` | 2026-10-23T10:49:18.214927255Z | 0 |
| supabase_inbucket_holaerp | `082bb27f1ad52463c67842f83fc325661e6ab877a2b3ba7f2605fc1b5ffe0607` | 2026-10-23T10:49:15.579020781Z | 0 |
| supabase_kong_holaerp | `08cec5edb3abaec7831307b2007cf5e36a5f8b643991e2639049cc86cb50ed46` | 2026-10-23T10:49:14.541217966Z | 0 |
| supabase_pg_meta_holaerp | `f13ae72c84a88dfffb325842a6b59fd0aab72ef9cc9cd0807aaf45b84cb9a95f` | 2026-10-23T10:49:18.725809295Z | 0 |
| supabase_realtime_holaerp | `635d94610787207c51ee6d0af30dd035c014750349a473ed956c0db49c7a1021` | 2026-10-23T10:49:16.149325273Z | 0 |
| supabase_rest_holaerp | `332384a83b1f341ddefc518d7144987003f6790824aa125244e1a073de639c5d` | 2026-10-23T10:49:16.779145814Z | 0 |
| supabase_storage_holaerp | `120d997b9f56c6894da4e2d5e7971daafe06903b8cd654ec4c2a961ae1135b5a` | 2026-10-23T10:49:17.429384802Z | 0 |
| supabase_studio_holaerp | `b4e9b186eabc5e6c897663ce44f93a6ce7f88a7f7243f5119233ebd184f3ac8f` | 2026-10-23T10:49:19.28979623Z | 0 |

Inventario de redes y volúmenes (idéntico antes/después):

```json
[
  {
    "tipo": "red",
    "id": "bc44cf05fa25c3126a40a9b168236b3fc401247a4f625b312ccaf6ae6c28607c",
    "name": "holaerp-web_holaerp-local-network"
  },
  {
    "tipo": "red",
    "id": "f65d1a0bc4e05b16921718ecd096473ccbdff14dccf8211e9f3a69b6eef59b66",
    "name": "holaerp-woo_default"
  },
  {
    "tipo": "red",
    "id": "1aaaac8132fe938e7e125ba66a8b9a5356647bf30c45392c615a470fa3e10c61",
    "name": "supabase_network_holaerp"
  },
  {
    "tipo": "volumen",
    "id": "holaerp-ps_db-data",
    "name": "holaerp-ps_db-data",
    "createdAt": "2026-10-07T16:43:28Z"
  },
  {
    "tipo": "volumen",
    "id": "holaerp-ps_ps-data",
    "name": "holaerp-ps_ps-data",
    "createdAt": "2026-10-07T16:43:28Z"
  },
  {
    "tipo": "volumen",
    "id": "holaerp-woo_db-data",
    "name": "holaerp-woo_db-data",
    "createdAt": "2026-10-06T15:50:17Z"
  },
  {
    "tipo": "volumen",
    "id": "holaerp-woo_wp-data",
    "name": "holaerp-woo_wp-data",
    "createdAt": "2026-10-06T15:50:17Z"
  },
  {
    "tipo": "volumen",
    "id": "supabase_db_holaerp",
    "name": "supabase_db_holaerp",
    "createdAt": "2026-10-23T10:48:51Z"
  },
  {
    "tipo": "volumen",
    "id": "supabase_edge_runtime_holaerp",
    "name": "supabase_edge_runtime_holaerp",
    "createdAt": "2026-10-23T10:49:17Z"
  },
  {
    "tipo": "volumen",
    "id": "supabase_storage_holaerp",
    "name": "supabase_storage_holaerp",
    "createdAt": "2026-10-23T10:49:17Z"
  }
]
```

Antes de fijar esta línea base hubo una recreación externa de HolaERP (10:48–10:49 UTC), confirmada por el coordinador desde otra sesión de holaerp-web; no ocurrió durante el ensayo ni la causó BibLib.

## Pendientes y límites del alcance

Bootstrap ejecuta **preflight → stack → env**: solo main genera `.env.local` mediante los helpers existentes, y scratch/test explicitan que no se escribe archivo. El recibo `.biblib/state/<perfil>-bootstrap.json` y la respuesta conservan estado **pending** y próxima fase **migrate**; migrate/seed/verify se integrarán en U-INF-06 con U-INF-04/05. Exit 0 solo acredita las fases disponibles; no declara completado el bootstrap.

Los bindings de Docker Desktop continúan en **0.0.0.0/::**, detectados como **warn** con referencia a alternativas A/B documentadas; no se cambió el daemon ni el firewall. Es la limitación conocida de U-INF-01, fuera de la corrección de U-INF-03. No se tocaron runner de migraciones, seed, reset, observabilidad, lockfile ni configuraciones remotas; no hay conflictos de archivos pendientes.

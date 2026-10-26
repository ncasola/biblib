# Tablas de la medición (generadas por `pnpm perf:local`)

Generadas el 2026-10-24T22:02:27.613Z. Cifras en milisegundos salvo indicación. «p50 / p95». Ver [informe](../../informe.md) para el análisis.

## 10000 ejemplares

Dataset `biblib-escala-v1` (huella `6e9b3738de18bd6d`): 10000 libros, 41 estanterías, estanteria mayor 1534 libros, ISBN manuales 1420.

### Acciones (Server Actions reales, caliente)

`Auth` es la duración de `GET /user` en GoTrue (registro del servidor); `SQL` es el tiempo de ejecución real de las sentencias de la acción (pg_stat_statements), solo con 1 sesión.

| escenario | sesiones | n | acción p50 | acción p95 | máx. | SQL p50 / p95 | Auth p50 / p95 | Auth/petición | filas máx. | KiB p50 | pool máx. | errores | peticiones/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| consulta-isbn-alta | 1 | 60 | 72.7 | 85.9 | 89.3 | 6.81 / 8.36 | 42.02 / 51.37 | 1.05 | — | 0 | 1 | 0 | 13 |
| consulta-isbn-alta | 5 | 100 | 132.7 | 175.8 | 227.7 | — | 53.02 / 62.2 | 1.05 | — | 0 | 4 | 0 | 36.3 |
| consulta-isbn-alta | 10 | 150 | 247.4 | 312 | 394.2 | — | 58.39 / 85.09 | 1.04 | — | 0 | 4 | 0 | 39.6 |

### Frío (primera llamada tras arrancar la app)

| escenario | acción | SQL | Auth (GoTrue) |
| --- | --- | --- | --- |
| consulta-isbn-alta | 317.8 | 10.2 | 46.84 |

### Conexiones

max_connections = 100; conexiones abiertas al terminar la carga: 10.

| aplicación | rol | estado | conexiones |
| --- | --- | --- | --- |
| postgres.js | postgres | idle | 4 |
| biblib-perf | postgres | active | 1 |
| biblib-perf-sampler | postgres | idle | 1 |
| (sin nombre) | supabase_storage_admin | idle | 1 |
| pg_net 0.20.4 | postgres | idle | 1 |
| PostgREST 16.2 | authenticator | idle | 1 |
| pg_cron scheduler | supabase_admin | — | 1 |

Salidas de red externas del servidor o del navegador: 0 (guard de red activo).

## Comparación automática con los presupuestos propuestos (10000 ejemplares)

| medida | presupuesto propuesto | medido | resultado |
| --- | --- | --- | --- |
| Filas por página de colección | ≤ 100 | 0 (máximo observado; la página máxima admitida es 100) | Cumple |


# Tablas de la medición (generadas por `pnpm perf:local`)

Generadas el 2026-10-25T01:19:06.179Z. Cifras en milisegundos salvo indicación. «p50 / p95». Ver [informe](informe.md) para el análisis.

## 10000 ejemplares

Dataset `biblib-escala-v1` (huella `6e9b3738de18bd6d`): 10000 libros, 41 estanterías, estanteria mayor 1534 libros, ISBN manuales 1420.

### Acciones (Server Actions reales, caliente)

`Auth` es la duración de `GET /user` en GoTrue (registro del servidor); `SQL` es el tiempo de ejecución real de las sentencias de la acción (pg_stat_statements), solo con 1 sesión.

| escenario | sesiones | n | acción p50 | acción p95 | máx. | SQL p50 / p95 | Auth p50 / p95 | Auth/petición | filas máx. | KiB p50 | pool máx. | errores | peticiones/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| exportacion-servidor | 1 | 12 | 672 | 737.2 | 766.4 | 132.91 / 156.08 | 45.09 / 51.61 | 1 | — | 5 | 1 | 0 | 1.5 |
| exportacion-servidor | 5 | 15 | 2350.2 | 4670.5 | 4770.2 | — | 56.44 / 59.54 | 1 | — | 5 | 4 | 0 | 1.7 |
| exportacion-servidor | 10 | 20 | 4570.2 | 6791.5 | 6792.1 | — | 67.59 / 82.48 | 1 | — | 5 | 4 | 0 | 1.8 |
| preview-importacion-conservar | 1 | 10 | 275.5 | 299.7 | 313.8 | 40.42 / 42.44 | 44.6 / 51.89 | 1.1 | — | 208 | 4 | 0 | 3.4 |
| preview-importacion-conservar | 5 | 10 | 927.6 | 1399.8 | 1480 | — | 48.41 / 58.69 | 1.1 | — | 208 | 4 | 0 | 4.4 |
| preview-importacion-conservar | 10 | 10 | 1774.2 | 2250.5 | 2294.9 | — | 76.93 / 89.27 | 1.1 | — | 208 | 4 | 0 | 4.2 |
| preview-importacion-nuevos | 1 | 10 | 368.4 | 410.5 | 414.9 | 65.11 / 69.09 | 44.75 / 48.19 | 1.1 | — | 905 | 4 | 0 | 2.6 |
| preview-importacion-nuevos | 5 | 10 | 1103.4 | 1697.6 | 1797.8 | — | 50.54 / 66.79 | 1.1 | — | 905 | 4 | 0 | 3.6 |
| preview-importacion-nuevos | 10 | 10 | 2105 | 2747 | 2823.1 | — | 69.75 / 82.43 | 1.1 | — | 905 | 4 | 0 | 3.4 |
| preview-importacion-reemplazo | 1 | 10 | 352.2 | 367.5 | 369.3 | 59.99 / 64.51 | 41.04 / 52.58 | 1.1 | — | 1000 | 4 | 0 | 2.7 |
| preview-importacion-reemplazo | 5 | 10 | 1125.5 | 1667.5 | 1779.1 | — | 49.53 / 57.18 | 1.1 | — | 1000 | 4 | 0 | 3.6 |
| preview-importacion-reemplazo | 10 | 10 | 2004.1 | 2740.2 | 2804.9 | — | 88.16 / 101.48 | 1.1 | — | 1000 | 4 | 0 | 3.5 |

### Frío (primera llamada tras arrancar la app)

| escenario | acción | SQL | Auth (GoTrue) |
| --- | --- | --- | --- |
| exportacion-servidor | 1005.3 | 143.26 | 48.84 |

### Exportación por partes (generada en el servidor)

Respuesta de la acción (manifiesto y enlaces): 5 KiB. Formato 1, 5 partes (2000 + 2000 + 2000 + 2000 + 2000 fichas; 1064 + 1052 + 1046 + 1058 + 1049 KiB). Descarga de las partes desde la app: p50 810.7 ms por parte.

### Conexiones

max_connections = 100; conexiones abiertas al terminar la carga: 11.

| aplicación | rol | estado | conexiones |
| --- | --- | --- | --- |
| postgres.js | postgres | idle | 4 |
| PostgREST 16.2 | authenticator | idle | 2 |
| biblib-perf-sampler | postgres | idle | 1 |
| (sin nombre) | supabase_storage_admin | idle | 1 |
| pg_net 0.20.4 | postgres | idle | 1 |
| pg_cron scheduler | supabase_admin | — | 1 |
| biblib-perf | postgres | active | 1 |

Salidas de red externas del servidor o del navegador: 0 (guard de red activo).

## Comparación automática con los presupuestos propuestos (10000 ejemplares)

| medida | presupuesto propuesto | medido | resultado |
| --- | --- | --- | --- |
| Filas por página de colección | ≤ 100 | 0 (máximo observado; la página máxima admitida es 100) | Cumple |


# Tablas de la medición (generadas por `pnpm perf:local`)

Generadas el 2026-10-23T21:41:20.019Z. Cifras en milisegundos salvo indicación. «p50 / p95». Ver [informe](../informe.md) para el análisis.

## 10000 ejemplares

Dataset `biblib-escala-v1` (huella `6e9b3738de18bd6d`): 10000 libros, 41 estanterías, estanteria mayor 1534 libros, ISBN manuales 1420.

### Acciones (Server Actions reales, caliente)

`Auth` es la duración de `GET /user` en GoTrue (registro del servidor); `SQL` es el tiempo de ejecución real de las sentencias de la acción (pg_stat_statements), solo con 1 sesión.

| escenario | sesiones | n | acción p50 | acción p95 | máx. | SQL p50 / p95 | Auth p50 / p95 | Auth/petición | filas máx. | KiB p50 | pool máx. | errores | peticiones/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dashboard | 1 | 60 | 85.2 | 99 | 102.6 | 18.96 / 22.16 | 45.44 / 59.83 | 1.05 | 10 | 7 | 1 | 0 | 11.2 |
| dashboard | 5 | 100 | 128.7 | 170.5 | 231.1 | — | 66.01 / 94.62 | 1.03 | 10 | 7 | 4 | 0 | 36.3 |
| dashboard | 10 | 150 | 239.2 | 303.3 | 386.9 | — | 116.02 / 159.79 | 1.02 | 10 | 7 | 4 | 0 | 40.9 |
| listado-inicial | 1 | 60 | 81.3 | 95 | 108.4 | 12.38 / 16.06 | 50.56 / 60.58 | 1.05 | 10 | 7 | 4 | 0 | 11.7 |
| listado-inicial | 5 | 100 | 140.7 | 164.4 | 178 | — | 95.75 / 120.7 | 1.03 | 10 | 7 | 4 | 0 | 36.8 |
| listado-inicial | 10 | 150 | 317.5 | 478.9 | 621.4 | — | 229.35 / 356.35 | 1.02 | 10 | 7 | 4 | 0 | 28.4 |
| listado-100-filas | 1 | 60 | 141.9 | 203.1 | 414.5 | 16.8 / 24.05 | 102.66 / 151.2 | 1.03 | 100 | 68 | 4 | 0 | 6.9 |
| listado-100-filas | 5 | 100 | 169.7 | 212.1 | 227.2 | — | 91.92 / 126.63 | 1.03 | 100 | 68 | 4 | 0 | 29 |
| listado-100-filas | 10 | 150 | 238.9 | 307.2 | 384.7 | — | 119.48 / 159.71 | 1.02 | 100 | 68 | 4 | 0 | 40 |
| listado-ultima-pagina | 1 | 60 | 105.8 | 129.5 | 177.1 | 34.77 / 44.39 | 49.68 / 59.69 | 1.05 | 10 | 7 | 4 | 0 | 9.1 |
| listado-ultima-pagina | 5 | 100 | 172.5 | 226.8 | 248.7 | — | 79.93 / 102.33 | 1.03 | 10 | 7 | 4 | 0 | 27.7 |
| listado-ultima-pagina | 10 | 150 | 289.4 | 431.9 | 509 | — | 120.12 / 158.56 | 1.02 | 10 | 7 | 4 | 0 | 32.8 |
| filtrado-estado-estanteria | 1 | 60 | 76.5 | 100.2 | 106.5 | 2.75 / 3.29 | 53.68 / 73.57 | 1.05 | 10 | 7 | 4 | 0 | 12 |
| filtrado-estado-estanteria | 5 | 100 | 119.9 | 153 | 234.7 | — | 76.49 / 104.16 | 1.03 | 10 | 7 | 4 | 0 | 40.7 |
| filtrado-estado-estanteria | 10 | 150 | 189 | 257.8 | 298.9 | — | 127.88 / 178.02 | 1.02 | 10 | 7 | 4 | 0 | 49.7 |
| ordenado-autor | 1 | 60 | 93.5 | 128.2 | 143.4 | 19.53 / 26.54 | 53.07 / 70.83 | 1.05 | 10 | 7 | 4 | 0 | 10 |
| ordenado-autor | 5 | 100 | 160.2 | 204.6 | 233 | — | 88.85 / 120.02 | 1.03 | 10 | 7 | 4 | 0 | 30.3 |
| ordenado-autor | 10 | 150 | 257.8 | 342.8 | 388 | — | 147.05 / 191.95 | 1.02 | 10 | 7 | 4 | 0 | 37.3 |
| ordenado-fecha | 1 | 60 | 99.8 | 121.8 | 161.1 | 29.12 / 34.89 | 52.16 / 72.21 | 1.05 | 10 | 7 | 4 | 0 | 9.3 |
| ordenado-fecha | 5 | 100 | 156.9 | 207.4 | 226.1 | — | 78.74 / 113.13 | 1.03 | 10 | 7 | 4 | 0 | 30.4 |
| ordenado-fecha | 10 | 150 | 267.6 | 349.9 | 539.4 | — | 134.38 / 182.37 | 1.02 | 10 | 7 | 4 | 0 | 35.3 |
| busqueda-local-texto | 1 | 60 | 216.4 | 351.7 | 549 | 140.69 / 201.64 | 55.5 / 87.45 | 1.03 | 10 | 7 | 4 | 0 | 4.2 |
| busqueda-local-texto | 5 | 100 | 263.2 | 309.8 | 431.4 | — | 66.06 / 91.89 | 1.02 | 10 | 7 | 4 | 0 | 18.6 |
| busqueda-local-texto | 10 | 150 | 594 | 711.9 | 761.7 | — | 99.18 / 155.17 | 1.01 | 10 | 7 | 4 | 0 | 16.6 |
| busqueda-local-isbn | 1 | 60 | 207.9 | 263.4 | 309.3 | 130.02 / 180.51 | 54.96 / 68.45 | 1.05 | 1 | 1 | 4 | 0 | 4.7 |
| busqueda-local-isbn | 5 | 100 | 288.9 | 361.3 | 533.5 | — | 79.48 / 109.16 | 1.02 | 1 | 1 | 4 | 0 | 17 |
| busqueda-local-isbn | 10 | 150 | 458.5 | 669.4 | 725.3 | — | 79.95 / 128.53 | 1.02 | 1 | 1 | 4 | 0 | 20.3 |
| detalle | 1 | 60 | 68.6 | 83.9 | 94.5 | 0.07 / 0.1 | 52.4 / 66.87 | 1.05 | — | 1 | 4 | 0 | 13.5 |
| detalle | 5 | 100 | 125.2 | 156.6 | 174.2 | — | 89.82 / 115.36 | 1.03 | — | 1 | 4 | 0 | 38.9 |
| detalle | 10 | 150 | 245 | 371.8 | 416.3 | — | 161.69 / 218.6 | 1.02 | — | 1 | 4 | 0 | 39.2 |
| estanterias | 1 | 60 | 75.5 | 87.1 | 113.9 | 6.84 / 8.75 | 50.89 / 60.19 | 1.05 | 41 | 5 | 4 | 0 | 12.5 |
| estanterias | 5 | 100 | 147.7 | 208.3 | 224.7 | — | 92.2 / 128.1 | 1.03 | 41 | 5 | 4 | 0 | 32.7 |
| estanterias | 10 | 150 | 226.9 | 350.2 | 394.4 | — | 141.32 / 211.71 | 1.02 | 41 | 5 | 4 | 0 | 40.7 |
| estanteria-3d-pagina-48 | 1 | 60 | 77.8 | 99.8 | 103.6 | 5.16 / 6.72 | 52.46 / 64.92 | 1.05 | 48 | 32 | 4 | 0 | 12 |
| estanteria-3d-pagina-48 | 5 | 100 | 137 | 187.1 | 226.3 | — | 86.51 / 114.31 | 1.03 | 48 | 32 | 4 | 0 | 34.2 |
| estanteria-3d-pagina-48 | 10 | 150 | 227.8 | 299.8 | 343.7 | — | 126.57 / 185.05 | 1.02 | 48 | 32 | 4 | 0 | 41.9 |
| exportacion-lectura-completa | 1 | 12 | 483.5 | 548.3 | 563.4 | 104.77 / 116.91 | 47.32 / 59.51 | 1.08 | 10000 | 6741 | 4 | 0 | 1.8 |
| exportacion-lectura-completa | 5 | 15 | 1543.3 | 2132.6 | 2164.1 | — | 60.02 / 79.76 | 1.07 | 10000 | 6741 | 4 | 0 | 2.7 |
| exportacion-lectura-completa | 10 | 20 | 2776.3 | 3993.9 | 4358.5 | — | 100.71 / 164.59 | 1 | 10000 | 6741 | 4 | 0 | 3 |
| preview-importacion-conservar | 1 | 10 | 279.1 | 305.4 | 310.4 | 34.57 / 40.84 | 46.24 / 55.26 | 1.2 | — | 208 | 4 | 0 | 3.4 |
| preview-importacion-conservar | 5 | 10 | 888.8 | 1344.1 | 1431.8 | — | 56.81 / 78.08 | 1.2 | — | 208 | 4 | 0 | 4.7 |
| preview-importacion-conservar | 10 | 10 | 1721.7 | 2112.8 | 2152.2 | — | 100.33 / 112.41 | 1.2 | — | 208 | 4 | 0 | 4.4 |
| preview-importacion-nuevos | 1 | 10 | 323.5 | 338.6 | 339.5 | 46.23 / 52.05 | 47.9 / 52.27 | 1.1 | — | 503 | 4 | 0 | 2.9 |
| preview-importacion-nuevos | 5 | 10 | 935.9 | 1460.6 | 1546.1 | — | 56.8 / 71.3 | 1.1 | — | 503 | 4 | 0 | 4.3 |
| preview-importacion-nuevos | 10 | 10 | 1972.8 | 2602.3 | 2652.5 | — | 118.28 / 133.09 | 1.1 | — | 503 | 4 | 0 | 3.6 |
| preview-importacion-reemplazo | 1 | 10 | 341.4 | 386.9 | 398.5 | 47.82 / 58.99 | 53.67 / 65.78 | 1.1 | — | 597 | 4 | 0 | 2.7 |
| preview-importacion-reemplazo | 5 | 10 | 1043.4 | 1535.5 | 1620.1 | — | 55.51 / 81.61 | 1.1 | — | 597 | 4 | 0 | 4.1 |
| preview-importacion-reemplazo | 10 | 10 | 2006.5 | 2437.5 | 2475 | — | 143.86 / 163.54 | 1.1 | — | 597 | 4 | 0 | 3.8 |

### Frío (primera llamada tras arrancar la app)

| escenario | acción | SQL | Auth (GoTrue) |
| --- | --- | --- | --- |
| dashboard | 236.2 | 20.03 | 149.34 + 167.08 + 164.22 + 122.94 + 168.1 + 161.49 + 174.83 + 145.97 + 147.48 + 113.83 + 126.61 + 123.91 + 114.61 + 106.95 + 122.36 + 105.27 + 114.23 + 136.21 + 89.29 + 120.04 + 115.39 + 140.88 + 117.15 + 111.14 + 136.73 + 122.44 + 117.27 + 120.4 + 103.47 + 94.57 + 97.98 + 99.12 + 101.33 + 105.96 + 93.45 + 91.46 + 87.47 + 72.89 + 58 + 67.29 + 51.86 |
| listado-inicial | 120.5 | 13.56 | 51.86 + 50.76 |
| listado-100-filas | 95.5 | 12.65 | 50.76 + 49.19 |
| listado-ultima-pagina | 103.1 | 31.17 | 49.19 + 46.47 |
| filtrado-estado-estanteria | 75.5 | 2.28 | 46.47 + 49.37 |
| ordenado-autor | 87.7 | 17.65 | 49.37 + 47.05 |
| ordenado-fecha | 113.3 | 30.05 | 47.05 + 57.65 |
| busqueda-local-texto | 172.3 | 106.7 | 57.65 + 41.2 |
| busqueda-local-isbn | 198.2 | 105.36 | 41.2 + 63.86 |
| detalle | 77.1 | 0.08 | 63.86 + 51.6 |
| estanterias | 82.1 | 8.45 | 51.6 + 49.27 |
| estanteria-3d-pagina-48 | 71.7 | 2.86 | 49.27 + 48.66 |
| exportacion-lectura-completa | 524.1 | 115.82 | 48.66 + 70.63 |

### Exportación por partes (código real del formato 1)

Lectura completa: 6741 KiB. Formato 1, 5 partes (2000 + 2000 + 2000 + 2000 + 2000 fichas; 1160 + 1148 + 1142 + 1154 + 1145 KiB). Particionado en Node (5 repeticiones): p50 232.4 ms, p95 282.3 ms.

### Aislamiento bajo carga

10 sesiones de escala + A + B durante 12 s: 472 peticiones de escala, 50 de A y 50 de B; 572 comprobaciones; **0 violaciones**.

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

## Auth: ida y vuelta de `GET /auth/v1/user` (cliente → Kong → GoTrue)

| sesiones | n | p50 | p95 | máx. |
| --- | --- | --- | --- | --- |
| 1 | 60 | 51.9 | 62.9 | 72.1 |
| 5 | 300 | 82.3 | 140.1 | 198.1 |
| 10 | 600 | 145 | 277.6 | 389.1 |

## Comparación automática con los presupuestos propuestos (10000 ejemplares)

| medida | presupuesto propuesto | medido | resultado |
| --- | --- | --- | --- |
| Consulta paginada y resumen, 10000 ejemplares, caliente, 1 sesión | p95 SQL ≤ 500 ms | 16.06 ms (listado) + 22.16 ms (resumen) = 38.2 ms | Cumple |
| Filas por página de colección | ≤ 100 | 100 (máximo observado; la página máxima admitida es 100) | Cumple |
| Acción de listado, p95 con Auth + DB (1 sesión) | p95 ≤ 1000 ms | 95 ms (Auth GoTrue 60.58 ms × 1.05 llamadas; SQL 16.06 ms) | Cumple |
| Acción de listado con 5 sesiones concurrentes | p95 ≤ 1000 ms | 164.4 ms (36.8 peticiones/s; pool máx. 4) | Cumple |
| Acción de listado con 10 sesiones concurrentes | p95 ≤ 1000 ms | 478.9 ms (28.4 peticiones/s; pool máx. 4) | Cumple |
| Vista 3D: libros por página | ≤ 48 | 48 | Cumple |
| Navegación ordinaria sin consultas sin límite (Ajustes carga la colección completa) | ninguna consulta sin LIMIT que crezca con la colección | getLibraryDataAction devuelve 10000 fichas (6741 KiB) al abrir /settings | **No cumple** |


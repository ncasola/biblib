# Tablas de la medición (generadas por `pnpm perf:local`)

Generadas el 2026-10-23T21:27:29.096Z. Cifras en milisegundos salvo indicación. «p50 / p95». Ver [informe](../informe.md) para el análisis.

## 10000 ejemplares

Dataset `biblib-escala-v1` (huella `6e9b3738de18bd6d`): 10000 libros, 41 estanterías, estanteria mayor 1534 libros, ISBN manuales 1420.

### Acciones (Server Actions reales, caliente)

`Auth` es la duración de `GET /user` en GoTrue (registro del servidor); `SQL` es el tiempo de ejecución real de las sentencias de la acción (pg_stat_statements), solo con 1 sesión.

| escenario | sesiones | n | acción p50 | acción p95 | máx. | SQL p50 / p95 | Auth p50 / p95 | Auth/petición | filas máx. | KiB p50 | pool máx. | errores | peticiones/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dashboard | 1 | 60 | 139.6 | 165.6 | 348.7 | 18.73 / 23.08 | 46.39 / 58.33 | 2.1 | 10 | 7 | 1 | 0 | 6.7 |
| dashboard | 5 | 100 | 284.6 | 624.7 | 751.2 | — | 58.13 / 80.47 | 2.06 | 10 | 7 | 1 | 0 | 15.2 |
| dashboard | 10 | 150 | 561.5 | 753.4 | 818.3 | — | 109.99 / 166.72 | 2.04 | 10 | 7 | 1 | 0 | 16.8 |
| listado-inicial | 1 | 60 | 194.7 | 219.4 | 227.2 | 11.47 / 14.42 | 80.78 / 96.64 | 2.1 | 10 | 7 | 1 | 0 | 5.2 |
| listado-inicial | 5 | 100 | 271.3 | 364.5 | 395.3 | — | 89.26 / 141.17 | 2.06 | 10 | 7 | 1 | 0 | 18.1 |
| listado-inicial | 10 | 150 | 531.1 | 686 | 762.6 | — | 82.58 / 124.23 | 2.04 | 10 | 7 | 1 | 0 | 18.6 |
| listado-100-filas | 1 | 60 | 141.5 | 172.5 | 222.1 | 14.13 / 18.34 | 50.3 / 65.56 | 2.1 | 100 | 68 | 1 | 0 | 6.7 |
| listado-100-filas | 5 | 100 | 253.2 | 347.3 | 374 | — | 71.63 / 110.41 | 2.06 | 100 | 68 | 1 | 0 | 19.2 |
| listado-100-filas | 10 | 150 | 544.9 | 752.5 | 821.6 | — | 83.18 / 137.65 | 2.04 | 100 | 68 | 1 | 0 | 17.2 |
| listado-ultima-pagina | 1 | 60 | 165.1 | 188.4 | 223.5 | 36.62 / 48.27 | 50.54 / 61.34 | 2.1 | 10 | 7 | 1 | 0 | 5.9 |
| listado-ultima-pagina | 5 | 100 | 329.8 | 505.1 | 577.7 | — | 57.44 / 128.17 | 2.06 | 10 | 7 | 1 | 0 | 14 |
| listado-ultima-pagina | 10 | 150 | 625.6 | 721.1 | 826.6 | — | 101.09 / 135.5 | 2.03 | 10 | 7 | 1 | 0 | 15.6 |
| filtrado-estado-estanteria | 1 | 60 | 120.1 | 142.4 | 151 | 2.14 / 2.83 | 47.44 / 60.54 | 2.1 | 10 | 7 | 1 | 0 | 8.1 |
| filtrado-estado-estanteria | 5 | 100 | 223.2 | 311 | 367.5 | — | 79.63 / 109.51 | 2.06 | 10 | 7 | 1 | 0 | 21.8 |
| filtrado-estado-estanteria | 10 | 150 | 445.5 | 644 | 692.3 | — | 138.8 / 275.5 | 2.04 | 10 | 7 | 1 | 0 | 21.5 |
| ordenado-autor | 1 | 60 | 258.1 | 619 | 871.4 | 25.73 / 38.44 | 65.52 / 110.8 | 2.1 | 10 | 7 | 1 | 0 | 3.1 |
| ordenado-autor | 5 | 100 | 365 | 480.7 | 592.1 | — | 95.79 / 149.95 | 2.06 | 10 | 7 | 1 | 0 | 13 |
| ordenado-autor | 10 | 150 | 889.1 | 2108.8 | 2890.5 | — | 96.35 / 186.63 | 2.04 | 10 | 7 | 1 | 0 | 8.3 |
| ordenado-fecha | 1 | 60 | 179.6 | 276 | 287 | 32.56 / 44.63 | 56.42 / 87.26 | 2.05 | 10 | 7 | 1 | 0 | 5.2 |
| ordenado-fecha | 5 | 100 | 340.3 | 755.4 | 982.9 | — | 70.85 / 112.16 | 2.06 | 10 | 7 | 1 | 0 | 12 |
| ordenado-fecha | 10 | 150 | 665.2 | 913.7 | 1085 | — | 71.53 / 161.64 | 2.04 | 10 | 7 | 1 | 0 | 14.4 |
| busqueda-local-texto | 1 | 60 | 262 | 290.9 | 586.4 | 128.32 / 141.99 | 53.81 / 63.37 | 2.07 | 10 | 7 | 1 | 0 | 3.7 |
| busqueda-local-texto | 5 | 100 | 704.8 | 797.1 | 947.1 | — | 51.27 / 63.62 | 2.04 | 10 | 7 | 1 | 0 | 7 |
| busqueda-local-texto | 10 | 150 | 1296.2 | 2154.3 | 2776.8 | — | 49.95 / 98.98 | 2.03 | 10 | 7 | 1 | 0 | 7.1 |
| busqueda-local-isbn | 1 | 60 | 217.8 | 245.5 | 266.5 | 102.55 / 120.43 | 46.04 / 57.27 | 2.07 | 1 | 1 | 1 | 0 | 4.5 |
| busqueda-local-isbn | 5 | 100 | 638 | 819.2 | 957.2 | — | 49.44 / 64.37 | 2.04 | 1 | 1 | 1 | 0 | 7.6 |
| busqueda-local-isbn | 10 | 150 | 1227.1 | 1329.4 | 1421.1 | — | 47.44 / 92.57 | 2.03 | 1 | 1 | 1 | 0 | 8 |
| detalle | 1 | 60 | 115.2 | 130 | 146.5 | 0.06 / 0.08 | 47.75 / 59.17 | 2.1 | — | 1 | 1 | 0 | 8.5 |
| detalle | 5 | 100 | 162.6 | 197 | 240.9 | — | 66 / 76.74 | 2.06 | — | 1 | 1 | 0 | 29.7 |
| detalle | 10 | 150 | 285.6 | 425.1 | 485.3 | — | 110.21 / 136.22 | 2.04 | — | 1 | 1 | 0 | 32.7 |
| estanterias | 1 | 60 | 120.1 | 144.1 | 160.7 | 5.89 / 8.01 | 46.75 / 63.37 | 2.1 | 41 | 5 | 1 | 0 | 8 |
| estanterias | 5 | 100 | 202.1 | 337.6 | 375.1 | — | 73.26 / 148.42 | 2.06 | 41 | 5 | 1 | 0 | 21.8 |
| estanterias | 10 | 150 | 442.3 | 631 | 716.9 | — | 163.65 / 261.95 | 2.04 | 41 | 5 | 1 | 0 | 21.5 |
| estanteria-3d-pagina-48 | 1 | 60 | 126.3 | 198.2 | 213.8 | 4.05 / 5.17 | 50.36 / 91.03 | 2.08 | 48 | 32 | 1 | 0 | 7.2 |
| estanteria-3d-pagina-48 | 5 | 100 | 205 | 277.9 | 299.7 | — | 75.44 / 122.75 | 2.06 | 48 | 32 | 1 | 0 | 22.7 |
| estanteria-3d-pagina-48 | 10 | 150 | 457.3 | 784.3 | 947 | — | 171.97 / 315.88 | 2.04 | 48 | 32 | 1 | 0 | 20.3 |
| exportacion-lectura-completa | 1 | 12 | 529.6 | 594.1 | 607.6 | 106.38 / 126.65 | 48.46 / 64.6 | 2 | 10000 | 6741 | 1 | 0 | 1.6 |
| exportacion-lectura-completa | 5 | 15 | 1619.3 | 2157.1 | 2167.8 | — | 59.09 / 88.06 | 2.07 | 10000 | 6741 | 1 | 0 | 2.5 |
| exportacion-lectura-completa | 10 | 20 | 3374.9 | 3901.8 | 4207 | — | 70.81 / 123.54 | 2.05 | 10000 | 6741 | 1 | 0 | 2.6 |
| preview-importacion-conservar | 1 | 10 | 314.3 | 325.3 | 326.4 | 33.16 / 36.4 | 47.77 / 57.7 | 2.2 | — | 208 | 1 | 0 | 3.1 |
| preview-importacion-conservar | 5 | 10 | 950.3 | 1318.6 | 1388.7 | — | 54.86 / 66.27 | 2.2 | — | 208 | 1 | 0 | 4.5 |
| preview-importacion-conservar | 10 | 10 | 1894 | 2280.9 | 2315.7 | — | 70.39 / 127.58 | 2.3 | — | 208 | 1 | 0 | 4.1 |
| preview-importacion-nuevos | 1 | 10 | 355.5 | 368.3 | 369.5 | 43.74 / 49.6 | 47.6 / 66.77 | 2.2 | — | 503 | 1 | 0 | 2.7 |
| preview-importacion-nuevos | 5 | 10 | 1030.5 | 1433.8 | 1552.4 | — | 52.62 / 69.34 | 2.2 | — | 503 | 1 | 0 | 4 |
| preview-importacion-nuevos | 10 | 10 | 1842.4 | 2341.8 | 2371.5 | — | 85.13 / 104.8 | 2.2 | — | 503 | 1 | 0 | 4 |
| preview-importacion-reemplazo | 1 | 10 | 358 | 375.1 | 377.3 | 43.95 / 47.98 | 47.98 / 56.86 | 2.2 | — | 597 | 1 | 0 | 2.7 |
| preview-importacion-reemplazo | 5 | 10 | 995.1 | 1464.4 | 1553.2 | — | 52.91 / 64.48 | 2.2 | — | 597 | 1 | 0 | 4.1 |
| preview-importacion-reemplazo | 10 | 10 | 1962.7 | 2797.2 | 2855.4 | — | 64.93 / 118.9 | 2.2 | — | 597 | 1 | 0 | 3.4 |

### Frío (primera llamada tras arrancar la app)

| escenario | acción | SQL | Auth (GoTrue) |
| --- | --- | --- | --- |
| dashboard | 321.8 | 27.16 | 209.22 + 200.47 + 174.82 + 201.2 + 172.31 + 162.12 + 144.62 + 219.04 + 194.43 + 214.33 + 195.89 + 164.8 + 200.01 + 174.55 + 177.26 + 168.91 + 145.99 + 164.3 + 145.66 + 137.79 + 125.04 + 136.08 + 146.25 + 131.45 + 148.93 + 114.67 + 157.53 + 95.43 + 69.25 + 52.08 + 52.52 |
| listado-inicial | 228.1 | 16.93 | 52.52 + 62.66 + 50.43 |
| listado-100-filas | 178.6 | 12.61 | 62.66 + 50.43 + 52.86 + 63.92 |
| listado-ultima-pagina | 184.2 | 42.05 | 52.86 + 63.92 + 52.26 + 51.09 |
| filtrado-estado-estanteria | 128 | 3.23 | 52.26 + 51.09 + 41.87 + 50.41 |
| ordenado-autor | 138.1 | 13.96 | 41.87 + 50.41 + 49.15 + 49.45 |
| ordenado-fecha | 135.9 | 22.29 | 49.15 + 49.45 + 45.7 + 43.15 |
| busqueda-local-texto | 249.2 | 111.85 | 45.7 + 43.15 + 53.81 + 55.5 |
| busqueda-local-isbn | 231.1 | 103.4 | 53.81 + 55.5 + 50.28 + 46.91 |
| detalle | 122.1 | 0.08 | 50.28 + 46.91 + 42.74 + 49.35 |
| estanterias | 147 | 6.96 | 42.74 + 49.35 + 54.84 + 59.44 |
| estanteria-3d-pagina-48 | 137.7 | 3.6 | 54.84 + 59.44 + 61.4 + 45.32 |
| exportacion-lectura-completa | 534.7 | 101.64 | 61.4 + 45.32 + 54.1 + 47.83 |

### Exportación por partes (código real del formato 1)

Lectura completa: 6741 KiB. Formato 1, 5 partes (2000 + 2000 + 2000 + 2000 + 2000 fichas; 1160 + 1148 + 1142 + 1154 + 1145 KiB). Particionado en Node (5 repeticiones): p50 236.3 ms, p95 260.9 ms.

### Aislamiento bajo carga

10 sesiones de escala + A + B durante 12 s: 288 peticiones de escala, 30 de A y 30 de B; 348 comprobaciones; **0 violaciones**.

### Conexiones

max_connections = 100; conexiones abiertas al terminar la carga: 7.

| aplicación | rol | estado | conexiones |
| --- | --- | --- | --- |
| (sin nombre) | supabase_storage_admin | idle | 1 |
| biblib-perf | postgres | active | 1 |
| biblib-perf-sampler | postgres | idle | 1 |
| pg_cron scheduler | supabase_admin | — | 1 |
| pg_net 0.20.4 | postgres | idle | 1 |
| postgres.js | postgres | idle | 1 |
| PostgREST 16.2 | authenticator | idle | 1 |

Salidas de red externas del servidor o del navegador: 0 (guard de red activo).

## Auth: ida y vuelta de `GET /auth/v1/user` (cliente → Kong → GoTrue)

| sesiones | n | p50 | p95 | máx. |
| --- | --- | --- | --- | --- |
| 1 | 60 | 50.8 | 65 | 77 |
| 5 | 300 | 77.9 | 108.8 | 156.7 |
| 10 | 600 | 150.4 | 229.2 | 292.6 |

## Comparación automática con los presupuestos propuestos (10000 ejemplares)

| medida | presupuesto propuesto | medido | resultado |
| --- | --- | --- | --- |
| Consulta paginada y resumen, 10000 ejemplares, caliente, 1 sesión | p95 SQL ≤ 500 ms | 14.42 ms (listado) + 23.08 ms (resumen) = 37.5 ms | Cumple |
| Filas por página de colección | ≤ 100 | 100 (máximo observado; la página máxima admitida es 100) | Cumple |
| Acción de listado, p95 con Auth + DB (1 sesión) | p95 ≤ 1000 ms | 219.4 ms (Auth GoTrue 96.64 ms × 2.1 llamadas; SQL 14.42 ms) | Cumple |
| Acción de listado con 5 sesiones concurrentes | p95 ≤ 1000 ms | 364.5 ms (18.1 peticiones/s; pool máx. 1) | Cumple |
| Acción de listado con 10 sesiones concurrentes | p95 ≤ 1000 ms | 686 ms (18.6 peticiones/s; pool máx. 1) | Cumple |
| ordenado-autor con 10 sesiones concurrentes | p95 ≤ 1000 ms | p95 2108.8 ms (p50 889.1 ms) | **No cumple** |
| busqueda-local-texto con 10 sesiones concurrentes | p95 ≤ 1000 ms | p95 2154.3 ms (p50 1296.2 ms) | **No cumple** |
| busqueda-local-isbn con 10 sesiones concurrentes | p95 ≤ 1000 ms | p95 1329.4 ms (p50 1227.1 ms) | **No cumple** |
| Vista 3D: libros por página | ≤ 48 | 48 | Cumple |
| Navegación ordinaria sin consultas sin límite (Ajustes carga la colección completa) | ninguna consulta sin LIMIT que crezca con la colección | getLibraryDataAction devuelve 10000 fichas (6741 KiB) al abrir /settings | **No cumple** |


# Tablas de la medición (generadas por `pnpm perf:local`)

Generadas el 2026-10-25T00:41:49.591Z. Cifras en milisegundos salvo indicación. «p50 / p95». Ver [informe](../../informe.md) para el análisis.

## 10000 ejemplares

Dataset `biblib-escala-v1` (huella `6e9b3738de18bd6d`): 10000 libros, 41 estanterías, estanteria mayor 1534 libros, ISBN manuales 1420.

### Acciones (Server Actions reales, caliente)

`Auth` es la duración de `GET /user` en GoTrue (registro del servidor); `SQL` es el tiempo de ejecución real de las sentencias de la acción (pg_stat_statements), solo con 1 sesión.

| escenario | sesiones | n | acción p50 | acción p95 | máx. | SQL p50 / p95 | Auth p50 / p95 | Auth/petición | filas máx. | KiB p50 | pool máx. | errores | peticiones/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dashboard | 1 | 60 | 79.5 | 88.8 | 95.7 | 14.72 / 16.21 | 42.93 / 50.8 | 1.05 | 10 | 8 | 1 | 0 | 12.1 |
| dashboard | 5 | 100 | 107.4 | 117.8 | 150.4 | — | 51.96 / 57.03 | 1.05 | 10 | 8 | 4 | 0 | 45.6 |
| dashboard | 10 | 150 | 158 | 188.5 | 269.3 | — | 67 / 86.09 | 1.05 | 10 | 8 | 4 | 0 | 61.2 |
| listado-inicial | 1 | 60 | 68.2 | 81.5 | 96.8 | 6.72 / 8.08 | 43.64 / 60.03 | 1.15 | 10 | 8 | 4 | 0 | 13.7 |
| listado-inicial | 5 | 100 | 100.3 | 110.5 | 125.9 | — | 55.22 / 61.89 | 1.04 | 10 | 8 | 4 | 0 | 49.2 |
| listado-inicial | 10 | 150 | 143.3 | 181.5 | 228.2 | — | 74.14 / 108.78 | 1.05 | 10 | 8 | 4 | 0 | 67 |
| listado-100-filas | 1 | 60 | 75.8 | 93.3 | 104.7 | 10.74 / 13.78 | 42.79 / 52.15 | 1.05 | 100 | 84 | 4 | 0 | 12.1 |
| listado-100-filas | 5 | 100 | 115.1 | 148.2 | 154.5 | — | 54.06 / 64.05 | 1.05 | 100 | 84 | 4 | 0 | 41.5 |
| listado-100-filas | 10 | 150 | 181.7 | 244 | 267.8 | — | 65.66 / 98.19 | 1.03 | 100 | 84 | 4 | 0 | 52.2 |
| listado-ultima-pagina | 1 | 60 | 85.8 | 97.3 | 98.2 | 23.64 / 25.51 | 42.12 / 52.46 | 1.05 | 10 | 8 | 4 | 0 | 11.2 |
| listado-ultima-pagina | 5 | 100 | 119.5 | 131.6 | 162.5 | — | 53.62 / 61.88 | 1.04 | 10 | 8 | 4 | 0 | 41.2 |
| listado-ultima-pagina | 10 | 150 | 176.4 | 217.4 | 291.3 | — | 77.66 / 104.89 | 1.02 | 10 | 8 | 4 | 0 | 55.2 |
| filtrado-estado-estanteria | 1 | 60 | 66 | 74.6 | 84 | 3.44 / 7.07 | 43.72 / 51.35 | 1.12 | 10 | 8 | 4 | 0 | 14.5 |
| filtrado-estado-estanteria | 5 | 100 | 117 | 131.8 | 136 | — | 83.81 / 96.14 | 1.04 | 10 | 8 | 4 | 0 | 44.5 |
| filtrado-estado-estanteria | 10 | 150 | 180.4 | 239.1 | 262.5 | — | 125.47 / 175.1 | 1.04 | 10 | 8 | 4 | 0 | 53.9 |
| ordenado-autor | 1 | 60 | 110.4 | 119.8 | 135.1 | 15.53 / 16.28 | 75.48 / 85.56 | 1.05 | 10 | 8 | 4 | 0 | 9.1 |
| ordenado-autor | 5 | 100 | 135.8 | 167.2 | 173.9 | — | 85.5 / 113.59 | 1.03 | 10 | 8 | 4 | 0 | 37.6 |
| ordenado-autor | 10 | 150 | 194 | 240.2 | 286 | — | 128.51 / 156.94 | 1.02 | 10 | 8 | 4 | 0 | 50.7 |
| ordenado-fecha | 1 | 60 | 86.8 | 96.3 | 104.6 | 24.18 / 25.45 | 44.01 / 51.04 | 1.07 | 10 | 8 | 4 | 0 | 11.2 |
| ordenado-fecha | 5 | 100 | 115.2 | 132.3 | 165.9 | — | 53.15 / 63.23 | 1.04 | 10 | 8 | 4 | 0 | 42 |
| ordenado-fecha | 10 | 150 | 160.9 | 203.1 | 289.2 | — | 66.95 / 84.62 | 1.02 | 10 | 8 | 4 | 0 | 59.1 |
| busqueda-local-texto | 1 | 60 | 87.8 | 105.3 | 114.6 | 26.38 / 30.37 | 44.25 / 52.43 | 1.05 | 10 | 9 | 4 | 0 | 11 |
| busqueda-local-texto | 5 | 100 | 110.9 | 124 | 140.2 | — | 51.82 / 57.58 | 1.03 | 10 | 9 | 4 | 0 | 44.7 |
| busqueda-local-texto | 10 | 150 | 168.9 | 202.8 | 266.6 | — | 69.12 / 87.58 | 1.05 | 10 | 9 | 4 | 0 | 57.8 |
| busqueda-local-isbn | 1 | 60 | 86.7 | 97 | 107.3 | 26.15 / 29.38 | 42.49 / 49.44 | 1.05 | 1 | 1 | 4 | 0 | 11 |
| busqueda-local-isbn | 5 | 100 | 112.2 | 120 | 162.6 | — | 51.91 / 59.25 | 1.03 | 1 | 1 | 4 | 0 | 44.1 |
| busqueda-local-isbn | 10 | 150 | 169.4 | 209.7 | 284.7 | — | 72.96 / 103.17 | 1.02 | 1 | 1 | 4 | 0 | 55.9 |
| detalle | 1 | 60 | 54.9 | 62.6 | 67.9 | 0.1 / 0.13 | 42.65 / 59.13 | 1.12 | — | 1 | 4 | 0 | 17.1 |
| detalle | 5 | 100 | 79.8 | 89.7 | 93.1 | — | 53.54 / 59.77 | 1.05 | — | 1 | 4 | 0 | 61.3 |
| detalle | 10 | 150 | 121.7 | 155.6 | 188.9 | — | 76.58 / 102.59 | 1.05 | — | 1 | 4 | 0 | 81.4 |
| consulta-isbn-alta | 1 | 60 | 60.4 | 96.7 | 108.6 | 0.05 / 0.14 | 47.38 / 84.83 | 1.17 | — | 0 | 4 | 0 | 14.4 |
| consulta-isbn-alta | 5 | 100 | 111.4 | 128.7 | 148 | — | 88.85 / 102.15 | 1.06 | — | 0 | 4 | 0 | 45.9 |
| consulta-isbn-alta | 10 | 150 | 157.3 | 181.1 | 205.9 | — | 126.73 / 149.22 | 1.05 | — | 0 | 4 | 0 | 61.4 |
| estanterias | 1 | 60 | 68 | 106.1 | 121.5 | 4.72 / 5.57 | 51.71 / 87.64 | 1.07 | 41 | 5 | 4 | 0 | 12.4 |
| estanterias | 5 | 100 | 117 | 288.2 | 369 | — | 88.02 / 194.11 | 1.03 | 41 | 5 | 4 | 0 | 35 |
| estanterias | 10 | 150 | 176.6 | 256.9 | 285.4 | — | 131.79 / 196.01 | 1.03 | 41 | 5 | 4 | 0 | 53.7 |
| estanteria-3d-pagina-48 | 1 | 60 | 74.9 | 101.8 | 120.1 | 10.32 / 11.55 | 44.84 / 78.87 | 1.05 | 48 | 40 | 4 | 0 | 12.2 |
| estanteria-3d-pagina-48 | 5 | 100 | 110.2 | 131.9 | 138.6 | — | 56.53 / 71.14 | 1.03 | 48 | 40 | 4 | 0 | 44 |
| estanteria-3d-pagina-48 | 10 | 150 | 166.2 | 215.3 | 267.6 | — | 82.11 / 107.74 | 1.02 | 48 | 40 | 4 | 0 | 57.7 |
| ajustes-recuentos | 1 | 60 | 64.5 | 100.4 | 109.4 | 5.48 / 6.05 | 46.39 / 79.43 | 1.13 | — | 0 | 4 | 0 | 13.7 |
| ajustes-recuentos | 5 | 100 | 86.6 | 100.5 | 108.8 | — | 56.24 / 69.05 | 1.05 | — | 0 | 4 | 0 | 56.4 |
| ajustes-recuentos | 10 | 150 | 153.3 | 197.6 | 207.8 | — | 115.84 / 159.13 | 1.05 | — | 0 | 4 | 0 | 64.6 |
| exportacion-servidor | 1 | 12 | 727.2 | 757.7 | 768.9 | 151.76 / 165.76 | 43.75 / 51.28 | 1 | — | 5 | 4 | 0 | 1.4 |
| exportacion-servidor | 5 | 15 | 2613.1 | 4445.6 | 4493.6 | — | 57.31 / 60.07 | 1 | — | 5 | 4 | 0 | 1.6 |
| exportacion-servidor | 10 | 20 | 5005.9 | 7480.1 | 7480.8 | — | 63.46 / 90.29 | 1 | — | 5 | 4 | 0 | 1.6 |
| preview-importacion-conservar | 1 | 10 | 272 | 334.7 | 336 | 38.84 / 45.83 | 45.52 / 51.19 | 1.1 | — | 208 | 4 | 0 | 3.4 |
| preview-importacion-conservar | 5 | 10 | 867.7 | 1308.4 | 1385.9 | — | 50.64 / 61.91 | 1.2 | — | 208 | 4 | 0 | 4.7 |
| preview-importacion-conservar | 10 | 10 | 1951.1 | 2382.5 | 2433.5 | — | 102.12 / 110.97 | 1.1 | — | 208 | 4 | 0 | 3.9 |
| preview-importacion-nuevos | 1 | 10 | 331.2 | 362.8 | 363.1 | 56.88 / 60.1 | 42.04 / 50.57 | 1.1 | — | 905 | 4 | 0 | 2.8 |
| preview-importacion-nuevos | 5 | 10 | 1050.7 | 1535.7 | 1623.4 | — | 48.88 / 52.86 | 1.1 | — | 905 | 4 | 0 | 3.8 |
| preview-importacion-nuevos | 10 | 10 | 1990.7 | 2603.9 | 2669.2 | — | 101.11 / 107.47 | 1.1 | — | 905 | 4 | 0 | 3.6 |
| preview-importacion-reemplazo | 1 | 10 | 324.6 | 354.8 | 366.9 | 55.5 / 57.68 | 44.57 / 57.13 | 1.1 | — | 1000 | 4 | 0 | 2.9 |
| preview-importacion-reemplazo | 5 | 10 | 1142.5 | 1563.1 | 1664.6 | — | 48.5 / 52.12 | 1.1 | — | 1000 | 4 | 0 | 3.8 |
| preview-importacion-reemplazo | 10 | 10 | 1905 | 2496.3 | 2559.2 | — | 66.36 / 72.2 | 1.1 | — | 1000 | 4 | 0 | 3.8 |

### Frío (primera llamada tras arrancar la app)

| escenario | acción | SQL | Auth (GoTrue) |
| --- | --- | --- | --- |
| dashboard | 212.5 | 17.02 | 45.85 |
| listado-inicial | 106.7 | 7.1 | 45.85 + 46.97 |
| listado-100-filas | 89.1 | 10.97 | 46.97 + 43.33 |
| listado-ultima-pagina | 92.2 | 25.2 | 46.97 + 43.33 + 41.29 |
| filtrado-estado-estanteria | 69.9 | 6.59 | 43.33 + 41.29 + 39.72 |
| ordenado-autor | 94.7 | 16.64 | 41.29 + 39.72 + 53.31 |
| ordenado-fecha | 91.7 | 24.83 | 39.72 + 53.31 + 41.68 |
| busqueda-local-texto | 85.4 | 14.6 | 53.31 + 41.68 + 44.64 |
| busqueda-local-isbn | 116.2 | 34.98 | 41.68 + 44.64 + 49.94 |
| detalle | 161.6 | 0.14 | 44.64 + 49.94 + 41.49 |
| consulta-isbn-alta | 60.7 | 0.04 | 49.94 + 41.49 + 42.74 |
| estanterias | 61.9 | 5.19 | 41.49 + 42.74 + 39.43 |
| estanteria-3d-pagina-48 | 69.1 | 7.05 | 42.74 + 39.43 + 38.81 |
| ajustes-recuentos | 77 | 5.6 | 39.43 + 38.81 + 48.73 |
| exportacion-servidor | 870.5 | 187.24 | 38.81 + 48.73 + 38.6 |

### Exportación por partes (generada en el servidor)

Respuesta de la acción (manifiesto y enlaces): 5 KiB. Formato 1, 5 partes (2000 + 2000 + 2000 + 2000 + 2000 fichas; 1064 + 1052 + 1046 + 1058 + 1049 KiB). Descarga de las partes desde la app: p50 955.9 ms por parte.

### Consultas principales (EXPLAIN ANALYZE, rol authenticated, 30 ejecuciones)

| consulta | acción | ejecución p50 / p95 | planificación p50 | nodos | LIMIT |
| --- | --- | --- | --- | --- | --- |
| resumen.totales | getLibrarySummaryAction | 6.94 / 7.371 | 0.324 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| resumen.recientes | getLibrarySummaryAction | 0.221 / 0.296 | 0.71 | Limit › Result › Nested Loop › Index Scan (copies_user_created_idx) | sí |
| resumen.leyendo | getLibrarySummaryAction | 9.21 / 10.084 | 0.682 | Limit › Result › Sort › Hash Join | sí |
| listado.recuento | listBooksAction | 5.794 / 6.091 | 0.313 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| listado.pagina-1 | listBooksAction | 0.255 / 0.307 | 0.605 | Limit › Result › Incremental Sort › Nested Loop | sí |
| listado.ultima-pagina | listBooksAction | 111.895 / 196.655 | 0.72 | Limit › Result › Sort › Hash Join | sí |
| filtrado.recuento | listBooksAction | 2.592 / 3.319 | 0.31 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| filtrado.pagina | listBooksAction | 5.997 / 6.441 | 0.613 | Limit › Result › Sort › Nested Loop | sí |
| orden.autor | listBooksAction | 64.373 / 73.455 | 0.688 | Limit › Result › Sort › Hash Join | sí |
| orden.fecha | listBooksAction | 71.651 / 78.4 | 0.661 | Limit › Result › Sort › Hash Join | sí |
| busqueda.recuento | listBooksAction | 11.778 / 12.303 | 0.348 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| busqueda.pagina | listBooksAction | 0.999 / 1.206 | 0.647 | Limit › Result › Incremental Sort › Nested Loop | sí |
| busqueda.isbn | listBooksAction | 62.317 / 72.927 | 0.703 | Limit › Result › Sort › Nested Loop | sí |
| busqueda.isbn-exacto | listBooksAction | 22.495 / 24.146 | 0.693 | Limit › Result › Sort › Nested Loop | sí |
| detalle | getBookDetailAction | 0.107 / 0.154 | 0.523 | Limit › Result › Nested Loop › Index Scan (copies_user_id_id_unique) | sí |
| estanterias | getShelvesAction | 4.774 / 5.454 | 0.197 | Sort › Result › Aggregate › Nested Loop | **no** |
| 3d.pagina | listBooksAction | 2.424 / 2.754 | 0.575 | Limit › Result › Incremental Sort › Nested Loop | sí |
| exportacion.todo | prepareLibraryExportAction / descarga de partes (servidor) | 105.212 / 115.599 | 0.618 | Sort › Result › Hash Join › Nested Loop | **no** |
| isbn.igualdad | getBookByIsbnAction / alta | 0.08 / 0.116 | 0.585 | Limit › Result › Sort › Nested Loop | sí |
| importacion.instantanea | prepareImportAction / confirmImportAction | 8.841 / 11.483 | 0.345 | Sort › Result › Hash Join › Seq Scan | **no** |

### Aislamiento bajo carga

10 sesiones de escala + A + B durante 12 s: 794 peticiones de escala, 85 de A y 85 de B; 964 comprobaciones; **0 violaciones**.

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
| Consulta paginada y resumen, 10000 ejemplares, caliente, 1 sesión | p95 SQL ≤ 500 ms | 8.08 ms (listado) + 16.21 ms (resumen) = 24.3 ms | Cumple |
| Filas por página de colección | ≤ 100 | 100 (máximo observado; la página máxima admitida es 100) | Cumple |
| Acción de listado, p95 con Auth + DB (1 sesión) | p95 ≤ 1000 ms | 81.5 ms (Auth GoTrue 60.03 ms × 1.15 llamadas; SQL 8.08 ms) | Cumple |
| Acción de listado con 5 sesiones concurrentes | p95 ≤ 1000 ms | 110.5 ms (49.2 peticiones/s; pool máx. 4) | Cumple |
| Acción de listado con 10 sesiones concurrentes | p95 ≤ 1000 ms | 181.5 ms (67 peticiones/s; pool máx. 4) | Cumple |
| Vista 3D: libros por página | ≤ 48 | 48 | Cumple |
| Navegación ordinaria sin consultas sin límite (Ajustes al abrirse) | ninguna consulta sin LIMIT que crezca con la colección | getLibraryCountsAction responde 110 B al abrir /settings | Cumple |


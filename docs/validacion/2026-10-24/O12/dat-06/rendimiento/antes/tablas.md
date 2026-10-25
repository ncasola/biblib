# Tablas de la medición (generadas por `pnpm perf:local`)

Generadas el 2026-10-24T21:55:55.110Z. Cifras en milisegundos salvo indicación. «p50 / p95». Ver [informe](informe.md) para el análisis.

## 10000 ejemplares

Dataset `biblib-escala-v1` (huella `6e9b3738de18bd6d`): 10000 libros, 41 estanterías, estanteria mayor 1534 libros, ISBN manuales 1420.

### Acciones (Server Actions reales, caliente)

`Auth` es la duración de `GET /user` en GoTrue (registro del servidor); `SQL` es el tiempo de ejecución real de las sentencias de la acción (pg_stat_statements), solo con 1 sesión.

| escenario | sesiones | n | acción p50 | acción p95 | máx. | SQL p50 / p95 | Auth p50 / p95 | Auth/petición | filas máx. | KiB p50 | pool máx. | errores | peticiones/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dashboard | 1 | 60 | 79.5 | 99.7 | 132.4 | 8.57 / 12.06 | 46.8 / 59.32 | 1.05 | 10 | 7 | 1 | 0 | 11.4 |
| dashboard | 5 | 100 | 101.4 | 120.8 | 138.4 | — | 54.07 / 64.03 | 1.05 | 10 | 7 | 4 | 0 | 47.5 |
| dashboard | 10 | 150 | 152.6 | 199 | 243 | — | 77.56 / 108.32 | 1.08 | 10 | 7 | 4 | 0 | 63.7 |
| listado-inicial | 1 | 60 | 63.7 | 77.8 | 129 | 0.85 / 1.12 | 46.84 / 78.76 | 1.3 | 10 | 7 | 4 | 0 | 14.5 |
| listado-inicial | 5 | 100 | 89 | 108.5 | 117.6 | — | 56.08 / 69.64 | 1.07 | 10 | 7 | 4 | 0 | 54.2 |
| listado-inicial | 10 | 150 | 132 | 167.2 | 196 | — | 80.39 / 104.49 | 1.09 | 10 | 7 | 4 | 0 | 73.8 |
| listado-100-filas | 1 | 60 | 65 | 79.7 | 100.8 | 1.82 / 2.15 | 44.89 / 72.77 | 1.18 | 100 | 68 | 4 | 0 | 14.2 |
| listado-100-filas | 5 | 100 | 94.1 | 110.4 | 123.3 | — | 54.44 / 62.32 | 1.05 | 100 | 68 | 4 | 0 | 51.8 |
| listado-100-filas | 10 | 150 | 141.8 | 186.3 | 211.5 | — | 71.65 / 97.41 | 1.07 | 100 | 68 | 4 | 0 | 67.3 |
| listado-ultima-pagina | 1 | 60 | 95.7 | 119 | 132.4 | 33.64 / 46.49 | 44.48 / 52.66 | 1.1 | 10 | 7 | 4 | 0 | 9.8 |
| listado-ultima-pagina | 5 | 100 | 123.7 | 139.7 | 195.5 | — | 51.46 / 60.87 | 1.04 | 10 | 7 | 4 | 0 | 38.9 |
| listado-ultima-pagina | 10 | 150 | 206.4 | 291.3 | 367.8 | — | 63.96 / 105.74 | 1.04 | 10 | 7 | 4 | 0 | 46.7 |
| filtrado-estado-estanteria | 1 | 60 | 60.2 | 69.7 | 73.8 | 2.29 / 2.67 | 43.28 / 50.75 | 1.13 | 10 | 7 | 4 | 0 | 15.5 |
| filtrado-estado-estanteria | 5 | 100 | 114.6 | 129.5 | 135 | — | 84.94 / 97.5 | 1.07 | 10 | 7 | 4 | 0 | 46.2 |
| filtrado-estado-estanteria | 10 | 150 | 182.7 | 218.2 | 229.4 | — | 132.03 / 166 | 1.02 | 10 | 7 | 4 | 0 | 52.8 |
| ordenado-autor | 1 | 60 | 101.7 | 119.7 | 154.2 | 13.95 / 17.49 | 73.24 / 86.04 | 1.05 | 10 | 7 | 4 | 0 | 10.3 |
| ordenado-autor | 5 | 100 | 141 | 169.8 | 176.7 | — | 94.67 / 115.41 | 1.03 | 10 | 7 | 4 | 0 | 34.8 |
| ordenado-autor | 10 | 150 | 231 | 307.4 | 356.4 | — | 164.93 / 235.37 | 1.05 | 10 | 7 | 4 | 0 | 41.5 |
| ordenado-fecha | 1 | 60 | 88.3 | 111.4 | 124.9 | 24.91 / 31.12 | 47.94 / 78.35 | 1.05 | 10 | 7 | 4 | 0 | 10.5 |
| ordenado-fecha | 5 | 100 | 111.7 | 143.4 | 179.9 | — | 55.17 / 83.49 | 1.03 | 10 | 7 | 4 | 0 | 42.6 |
| ordenado-fecha | 10 | 150 | 151.3 | 191 | 259.6 | — | 78.33 / 94.51 | 1.07 | 10 | 7 | 4 | 0 | 63.6 |
| busqueda-local-texto | 1 | 60 | 152.7 | 172.9 | 202.5 | 93.32 / 103.69 | 43.97 / 50.78 | 1.05 | 10 | 7 | 4 | 0 | 6.8 |
| busqueda-local-texto | 5 | 100 | 207.4 | 269.2 | 284.6 | — | 55.31 / 68.3 | 1.03 | 10 | 7 | 4 | 0 | 24.3 |
| busqueda-local-texto | 10 | 150 | 321.9 | 406.1 | 432.6 | — | 53.62 / 74.92 | 1.02 | 10 | 7 | 4 | 0 | 31.2 |
| busqueda-local-isbn | 1 | 60 | 150.2 | 210 | 244.2 | 91.34 / 141.6 | 42.23 / 50.16 | 1.05 | 1 | 1 | 4 | 0 | 6.2 |
| busqueda-local-isbn | 5 | 100 | 188.9 | 298.1 | 351.8 | — | 49.9 / 68.22 | 1.03 | 1 | 1 | 4 | 0 | 24.1 |
| busqueda-local-isbn | 10 | 150 | 357.5 | 462.7 | 497.7 | — | 54.47 / 79.51 | 1.02 | 1 | 1 | 4 | 0 | 27.1 |
| detalle | 1 | 60 | 54.8 | 63.2 | 68.4 | 0.06 / 0.1 | 41.95 / 50.44 | 1.07 | — | 1 | 4 | 0 | 17.1 |
| detalle | 5 | 100 | 79.8 | 98.2 | 109.8 | — | 54.23 / 69.49 | 1.07 | — | 1 | 4 | 0 | 59.7 |
| detalle | 10 | 150 | 119.4 | 139.2 | 157.2 | — | 76.29 / 98.56 | 1.11 | — | 1 | 4 | 0 | 82.7 |
| estanterias | 1 | 60 | 61 | 70.5 | 80.1 | 5.93 / 6.82 | 41.95 / 73.07 | 1.18 | 41 | 5 | 4 | 0 | 15.3 |
| estanterias | 5 | 100 | 88.8 | 107.9 | 130.1 | — | 53.61 / 75.45 | 1.05 | 41 | 5 | 4 | 0 | 53.6 |
| estanterias | 10 | 150 | 164.7 | 243.6 | 272.7 | — | 115.86 / 193.06 | 1.02 | 41 | 5 | 4 | 0 | 58.2 |
| estanteria-3d-pagina-48 | 1 | 60 | 65.2 | 99.8 | 104.3 | 1.35 / 3.97 | 52.93 / 139.37 | 1.15 | 48 | 32 | 4 | 0 | 12.8 |
| estanteria-3d-pagina-48 | 5 | 100 | 83.6 | 93.8 | 99.3 | — | 52.8 / 60.17 | 1.06 | 48 | 32 | 4 | 0 | 58.5 |
| estanteria-3d-pagina-48 | 10 | 150 | 135 | 177.3 | 183.6 | — | 79.45 / 135.56 | 1.05 | 48 | 32 | 4 | 0 | 69.3 |
| ajustes-recuentos | 1 | 60 | 74 | 97.4 | 109 | 0.77 / 0.86 | 71.85 / 85.05 | 1.07 | — | 0 | 4 | 0 | 13.1 |
| ajustes-recuentos | 5 | 100 | 106.4 | 123.2 | 127.5 | — | 84.68 / 94.66 | 1.05 | — | 0 | 4 | 0 | 47.6 |
| ajustes-recuentos | 10 | 150 | 137.7 | 199.8 | 227.5 | — | 97.39 / 156.08 | 1.05 | — | 0 | 4 | 0 | 69.8 |
| exportacion-servidor | 1 | 12 | 450.8 | 492.9 | 496 | 85.09 / 101.76 | 46.76 / 82.55 | 1.08 | — | 5 | 4 | 0 | 2.2 |
| exportacion-servidor | 5 | 15 | 1835.3 | 1921 | 1990.7 | — | 54.52 / 62.62 | 1.07 | — | 5 | 4 | 0 | 2.6 |
| exportacion-servidor | 10 | 20 | 3055.2 | 4569.6 | 4570.9 | — | 83.11 / 92.76 | 1.05 | — | 5 | 4 | 0 | 2.7 |
| preview-importacion-conservar | 1 | 10 | 234.9 | 242.9 | 244.3 | 31.44 / 34.22 | 44.31 / 52.56 | 1.2 | — | 208 | 4 | 0 | 4.1 |
| preview-importacion-conservar | 5 | 10 | 734.3 | 1167.9 | 1222.2 | — | 49.68 / 54.19 | 1.2 | — | 208 | 4 | 0 | 5.5 |
| preview-importacion-conservar | 10 | 10 | 1436.9 | 1758.5 | 1808.6 | — | 78.77 / 86.09 | 1.2 | — | 208 | 4 | 0 | 5.3 |
| preview-importacion-nuevos | 1 | 10 | 264.4 | 297.4 | 300.6 | 41.53 / 49.06 | 41.01 / 48.66 | 1.2 | — | 503 | 4 | 0 | 3.5 |
| preview-importacion-nuevos | 5 | 10 | 935.3 | 1447 | 1523.6 | — | 52.29 / 66.37 | 1.2 | — | 503 | 4 | 0 | 4.4 |
| preview-importacion-nuevos | 10 | 10 | 1720.4 | 2216.6 | 2279.2 | — | 98.37 / 112.25 | 1.1 | — | 503 | 4 | 0 | 4.2 |
| preview-importacion-reemplazo | 1 | 10 | 272.7 | 307.1 | 313.9 | 44.76 / 47.56 | 43.96 / 49.72 | 1.1 | — | 597 | 4 | 0 | 3.4 |
| preview-importacion-reemplazo | 5 | 10 | 878.7 | 1318.2 | 1390.2 | — | 46.58 / 54.37 | 1.1 | — | 597 | 4 | 0 | 4.7 |
| preview-importacion-reemplazo | 10 | 10 | 1654.7 | 2070.7 | 2122.8 | — | 86.02 / 99.68 | 1.1 | — | 597 | 4 | 0 | 4.5 |

### Frío (primera llamada tras arrancar la app)

| escenario | acción | SQL | Auth (GoTrue) |
| --- | --- | --- | --- |
| dashboard | 202.5 | 9.44 | 49.32 |
| listado-inicial | 105 | 0.81 | 49.32 + 52.44 |
| listado-100-filas | 71.8 | 1.9 | 49.32 + 52.44 + 41 |
| listado-ultima-pagina | 116 | 32.72 | 52.44 + 41 + 50.84 |
| filtrado-estado-estanteria | 64.7 | 2.33 | 52.44 + 41 + 50.84 + 41.58 |
| ordenado-autor | 83.3 | 13.3 | 41 + 50.84 + 41.58 + 48.27 |
| ordenado-fecha | 119.9 | 26.48 | 50.84 + 41.58 + 48.27 + 63.69 |
| busqueda-local-texto | 116 | 47.64 | 41.58 + 48.27 + 63.69 + 45.54 |
| busqueda-local-isbn | 159.8 | 90.42 | 63.69 + 45.54 + 45.47 |
| detalle | 168.1 | 0.08 | 45.54 + 45.47 + 41.43 |
| estanterias | 74.6 | 6.22 | 45.47 + 41.43 + 45.55 |
| estanteria-3d-pagina-48 | 63.1 | 0.71 | 41.43 + 45.55 + 42.74 |
| ajustes-recuentos | 68.9 | 0.95 | 45.55 + 42.74 + 44.13 |
| exportacion-servidor | 551.5 | 103.16 | 45.55 + 42.74 + 44.13 + 42.68 |

### Exportación por partes (generada en el servidor)

Respuesta de la acción (manifiesto y enlaces): 5 KiB. Formato 1, 5 partes (2000 + 2000 + 2000 + 2000 + 2000 fichas; 1160 + 1148 + 1142 + 1154 + 1145 KiB). Descarga de las partes desde la app: p50 549.2 ms por parte.

### Consultas principales (EXPLAIN ANALYZE, rol authenticated, 30 ejecuciones)

| consulta | acción | ejecución p50 / p95 | planificación p50 | nodos | LIMIT |
| --- | --- | --- | --- | --- | --- |
| resumen.totales | getLibrarySummaryAction | 4.125 / 4.565 | 0.121 | Aggregate › Result › Seq Scan | **no** |
| resumen.recientes | getLibrarySummaryAction | 0.04 / 0.052 | 0.192 | Limit › Result › Nested Loop › Index Scan (books_user_created_idx) | sí |
| resumen.leyendo | getLibrarySummaryAction | 3.236 / 3.429 | 0.252 | Limit › Sort › Result › Hash Join | sí |
| listado.recuento | listBooksAction | 0.875 / 0.976 | 0.071 | Aggregate › Result › Index Only Scan (books_user_id_idx) | **no** |
| listado.pagina-1 | listBooksAction | 0.046 / 0.069 | 0.193 | Limit › Result › Nested Loop › Index Scan (books_user_title_idx) | sí |
| listado.ultima-pagina | listBooksAction | 33.462 / 42.382 | 0.308 | Limit › Sort › Result › Hash Join | sí |
| filtrado.recuento | listBooksAction | 0.756 / 1.072 | 0.106 | Aggregate › Result › Bitmap Heap Scan › Bitmap Index Scan (books_shelf_id_idx) | **no** |
| filtrado.pagina | listBooksAction | 1.305 / 1.582 | 0.206 | Limit › Sort › Result › Nested Loop | sí |
| orden.autor | listBooksAction | 13.738 / 16.161 | 0.287 | Limit › Sort › Result › Hash Join | sí |
| orden.fecha | listBooksAction | 22.696 / 25.34 | 0.289 | Limit › Sort › Result › Hash Join | sí |
| busqueda.recuento | listBooksAction | 45.517 / 48.665 | 0.135 | Aggregate › Result › Seq Scan | **no** |
| busqueda.pagina | listBooksAction | 1.414 / 1.525 | 0.253 | Limit › Result › Nested Loop › Index Scan (books_user_title_idx) | sí |
| busqueda.isbn | listBooksAction | 77.353 / 86.749 | 0.296 | Limit › Sort › Result › Nested Loop | sí |
| busqueda.isbn-exacto | listBooksAction | 46.122 / 52.481 | 0.298 | Limit › Sort › Result › Nested Loop | sí |
| detalle | getBookDetailAction | 0.044 / 0.079 | 0.202 | Limit › Result › Hash Join › Seq Scan | sí |
| estanterias | getShelvesAction | 6.149 / 6.582 | 0.263 | Sort › Aggregate › Result › Hash Join | **no** |
| 3d.pagina | listBooksAction | 0.115 / 0.179 | 0.153 | Limit › Result › Nested Loop › Index Scan (books_user_shelf_title_idx) | sí |
| exportacion.todo | prepareLibraryExportAction / descarga de partes (servidor) | 30.402 / 31.898 | 0.275 | Sort › Result › Hash Join › Seq Scan | **no** |
| isbn.escaneo | getBookByIsbnAction / alta / edición | 1.898 / 2.172 | 0.111 | Result › Seq Scan | **no** |
| importacion.instantanea | prepareImportAction / confirmImportAction | 4.156 / 5.029 | 0.132 | Sort › Result › Seq Scan | **no** |

### Aislamiento bajo carga

10 sesiones de escala + A + B durante 12 s: 777 peticiones de escala, 75 de A y 80 de B; 932 comprobaciones; **0 violaciones**.

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
| Consulta paginada y resumen, 10000 ejemplares, caliente, 1 sesión | p95 SQL ≤ 500 ms | 1.12 ms (listado) + 12.06 ms (resumen) = 13.2 ms | Cumple |
| Filas por página de colección | ≤ 100 | 100 (máximo observado; la página máxima admitida es 100) | Cumple |
| Acción de listado, p95 con Auth + DB (1 sesión) | p95 ≤ 1000 ms | 77.8 ms (Auth GoTrue 78.76 ms × 1.3 llamadas; SQL 1.12 ms) | Cumple |
| Acción de listado con 5 sesiones concurrentes | p95 ≤ 1000 ms | 108.5 ms (54.2 peticiones/s; pool máx. 4) | Cumple |
| Acción de listado con 10 sesiones concurrentes | p95 ≤ 1000 ms | 167.2 ms (73.8 peticiones/s; pool máx. 4) | Cumple |
| Vista 3D: libros por página | ≤ 48 | 48 | Cumple |
| Navegación ordinaria sin consultas sin límite (Ajustes al abrirse) | ninguna consulta sin LIMIT que crezca con la colección | getLibraryCountsAction responde 110 B al abrir /settings | Cumple |


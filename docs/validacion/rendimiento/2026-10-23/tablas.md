# Tablas de la medición (generadas por `pnpm perf:local`)

Generadas el 2026-10-23T19:41:11.003Z. Cifras en milisegundos salvo indicación. «p50 / p95». Ver [informe](informe.md) para el análisis.

## 100 ejemplares

Dataset `biblib-escala-v1` (huella `8235428f06b93d82`): 100 libros, 6 estanterías, estanteria mayor 38 libros, ISBN manuales 16.

### Acciones (Server Actions reales, caliente)

`Auth` es la duración de `GET /user` en GoTrue (registro del servidor); `SQL` es el tiempo de ejecución real de las sentencias de la acción (pg_stat_statements), solo con 1 sesión.

| escenario | sesiones | n | acción p50 | acción p95 | máx. | SQL p50 / p95 | Auth p50 / p95 | Auth/petición | filas máx. | KiB p50 | pool máx. | errores | peticiones/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dashboard | 1 | 60 | 140 | 197.4 | 233.3 | 3.77 / 6.52 | 50.39 / 77.55 | 2.12 | 10 | 7 | 1 | 0 | 6.6 |
| dashboard | 5 | 100 | 214.3 | 338 | 395.1 | — | 75.54 / 108.85 | 2.06 | 10 | 7 | 1 | 0 | 21.6 |
| dashboard | 10 | 150 | 407.1 | 570.2 | 634.1 | — | 158.58 / 222.65 | 2.04 | 10 | 7 | 1 | 0 | 23.7 |
| listado-inicial | 1 | 60 | 222.7 | 473.8 | 582.3 | 0.35 / 0.44 | 97.01 / 173.49 | 2.07 | 10 | 7 | 1 | 0 | 3.9 |
| listado-inicial | 5 | 100 | 193.1 | 374.2 | 536 | — | 73.74 / 174.31 | 2.06 | 10 | 7 | 1 | 0 | 22.3 |
| listado-inicial | 10 | 150 | 274.8 | 340.6 | 420.4 | — | 105.04 / 145.85 | 2.04 | 10 | 7 | 1 | 0 | 35.1 |
| listado-100-filas | 1 | 60 | 123.4 | 142.2 | 186.6 | 0.83 / 1.02 | 48.52 / 56.8 | 2.1 | 100 | 67 | 1 | 0 | 7.7 |
| listado-100-filas | 5 | 100 | 180.6 | 252.2 | 293 | — | 66.94 / 96.14 | 2.06 | 100 | 67 | 1 | 0 | 26 |
| listado-100-filas | 10 | 150 | 317.8 | 506.5 | 614.3 | — | 92.48 / 158.19 | 2.04 | 100 | 67 | 1 | 0 | 28.8 |
| listado-ultima-pagina | 1 | 60 | 144.3 | 277.8 | 401.9 | 0.44 / 0.65 | 58.79 / 131.06 | 2.07 | 10 | 7 | 1 | 0 | 5.8 |
| listado-ultima-pagina | 5 | 100 | 170.6 | 227.7 | 246.8 | — | 65.85 / 101.79 | 2.06 | 10 | 7 | 1 | 0 | 27.8 |
| listado-ultima-pagina | 10 | 150 | 346 | 444.1 | 501.4 | — | 148.21 / 194.99 | 2.04 | 10 | 7 | 1 | 0 | 27.9 |
| filtrado-estado-estanteria | 1 | 60 | 179.1 | 235.5 | 246.8 | 0.2 / 0.25 | 77.73 / 106.12 | 2.08 | 10 | 6 | 1 | 0 | 6 |
| filtrado-estado-estanteria | 5 | 100 | 218.2 | 323.2 | 338.4 | — | 82.67 / 128.14 | 2.06 | 10 | 6 | 1 | 0 | 21.7 |
| filtrado-estado-estanteria | 10 | 150 | 389.6 | 686 | 845.1 | — | 138.29 / 198.03 | 2.04 | 10 | 7 | 1 | 0 | 22.2 |
| ordenado-autor | 1 | 60 | 117.8 | 173.3 | 208.1 | 0.36 / 0.46 | 48.7 / 68.06 | 2.1 | 10 | 7 | 1 | 0 | 7.9 |
| ordenado-autor | 5 | 100 | 165.9 | 227.3 | 284.1 | — | 63.24 / 92.09 | 2.06 | 10 | 7 | 1 | 0 | 28.1 |
| ordenado-autor | 10 | 150 | 283.8 | 404.9 | 464.3 | — | 96.95 / 179.79 | 2.04 | 10 | 7 | 1 | 0 | 33.6 |
| ordenado-fecha | 1 | 60 | 112.2 | 180.4 | 185.3 | 0.41 / 0.5 | 47.03 / 81.29 | 2.1 | 10 | 7 | 1 | 0 | 8 |
| ordenado-fecha | 5 | 100 | 151.3 | 235.1 | 254.5 | — | 57.13 / 105.59 | 2.06 | 10 | 7 | 1 | 0 | 29.7 |
| ordenado-fecha | 10 | 150 | 331.8 | 413.6 | 469 | — | 145.47 / 188.86 | 2.04 | 10 | 7 | 1 | 0 | 28.9 |
| busqueda-local-texto | 1 | 60 | 188.1 | 273 | 305 | 1.11 / 1.47 | 83.17 / 122.07 | 2.1 | 10 | 5 | 1 | 0 | 5.4 |
| busqueda-local-texto | 5 | 100 | 205.5 | 271.7 | 295.9 | — | 73.05 / 119.92 | 2.06 | 10 | 5 | 1 | 0 | 24.6 |
| busqueda-local-texto | 10 | 150 | 277.6 | 492.3 | 573.5 | — | 94.42 / 177.03 | 2.04 | 10 | 5 | 1 | 0 | 31.8 |
| busqueda-local-isbn | 1 | 60 | 132.4 | 182.5 | 227.9 | 1.22 / 1.46 | 52.62 / 80.41 | 2.1 | 1 | 1 | 1 | 0 | 7.1 |
| busqueda-local-isbn | 5 | 100 | 222.6 | 333.4 | 478.6 | — | 83.39 / 133.45 | 2.06 | 1 | 1 | 1 | 0 | 21.3 |
| busqueda-local-isbn | 10 | 150 | 294.6 | 426.3 | 523.2 | — | 97.29 / 176.72 | 2.04 | 1 | 1 | 1 | 0 | 32.3 |
| detalle | 1 | 60 | 113.6 | 233.7 | 256.8 | 0.08 / 0.12 | 47.73 / 106.82 | 2.1 | — | 1 | 1 | 0 | 7.4 |
| detalle | 5 | 100 | 166.6 | 250.4 | 287.8 | — | 66.31 / 114.86 | 2.06 | — | 1 | 1 | 0 | 27.2 |
| detalle | 10 | 150 | 1095.6 | 3169.3 | 4351.7 | — | 245.8 / 763.17 | 2.04 | — | 1 | 1 | 0 | 7.4 |
| estanterias | 1 | 60 | 171.3 | 277.8 | 319.3 | 0.22 / 0.28 | 63.92 / 108.3 | 2.1 | 6 | 1 | 1 | 0 | 5.3 |
| estanterias | 5 | 100 | 228.3 | 636.5 | 694.3 | — | 78.66 / 123.2 | 2.06 | 6 | 1 | 1 | 0 | 15.7 |
| estanterias | 10 | 150 | 366.8 | 987.4 | 1201.1 | — | 106.87 / 191.58 | 2.04 | 6 | 1 | 1 | 0 | 22.9 |
| estanteria-3d-pagina-48 | 1 | 60 | 140.1 | 282.6 | 376.5 | 0.5 / 0.73 | 55.1 / 98.26 | 2.1 | 38 | 26 | 1 | 0 | 5.8 |
| estanteria-3d-pagina-48 | 5 | 100 | 203.8 | 283.7 | 353.8 | — | 75.88 / 115.6 | 2.06 | 38 | 26 | 1 | 0 | 23.8 |
| estanteria-3d-pagina-48 | 10 | 150 | 324 | 514.3 | 673.5 | — | 112.2 / 189.02 | 2.04 | 38 | 26 | 1 | 0 | 28.6 |
| exportacion-lectura-completa | 1 | 12 | 120.5 | 147.7 | 160.5 | 0.78 / 1.06 | 45.62 / 56.06 | 2.5 | 100 | 68 | 1 | 0 | 7.9 |
| exportacion-lectura-completa | 5 | 15 | 150.8 | 219.6 | 238.5 | — | 55.15 / 68.15 | 2.4 | 100 | 68 | 1 | 0 | 29.1 |
| exportacion-lectura-completa | 10 | 20 | 257.7 | 401.5 | 427.4 | — | 78.17 / 106.44 | 2.3 | 100 | 68 | 1 | 0 | 29.6 |
| preview-importacion-conservar | 1 | 10 | 209.6 | 217.6 | 218.4 | 1.7 / 1.9 | 83.13 / 94.78 | 2.4 | — | 11 | 1 | 0 | 4.7 |
| preview-importacion-conservar | 5 | 10 | 228.2 | 345.9 | 364.8 | — | 58.24 / 86.39 | 2.6 | — | 11 | 1 | 0 | 17.4 |
| preview-importacion-conservar | 10 | 10 | 469.1 | 553.4 | 563.7 | — | 109.54 / 135.36 | 2.6 | — | 11 | 1 | 0 | 17.6 |
| preview-importacion-nuevos | 1 | 10 | 158.8 | 228.4 | 235.4 | 2.26 / 2.92 | 50.89 / 92.29 | 2.5 | — | 26 | 1 | 0 | 5.6 |
| preview-importacion-nuevos | 5 | 10 | 313.1 | 477.4 | 501.1 | — | 76.17 / 95.95 | 2.2 | — | 26 | 1 | 0 | 12.7 |
| preview-importacion-nuevos | 10 | 10 | 675.5 | 812.5 | 825.7 | — | 155.75 / 184.9 | 2.6 | — | 26 | 1 | 0 | 12 |
| preview-importacion-reemplazo | 1 | 10 | 141.1 | 164.5 | 171.7 | 1.84 / 2.23 | 50.18 / 57.32 | 2.6 | — | 16 | 1 | 0 | 6.6 |
| preview-importacion-reemplazo | 5 | 10 | 307.4 | 413.9 | 439.1 | — | 75.73 / 98.2 | 2.6 | — | 16 | 1 | 0 | 13.7 |
| preview-importacion-reemplazo | 10 | 10 | 530.7 | 659.7 | 674.2 | — | 132.56 / 147.03 | 2.6 | — | 16 | 1 | 0 | 14.6 |

### Frío (primera llamada tras arrancar la app)

| escenario | acción | SQL | Auth (GoTrue) |
| --- | --- | --- | --- |
| dashboard | 248.4 | 4.65 | 88.15 + 85.31 + 82.63 + 87.22 + 73.05 + 81.11 + 97.76 + 89.3 + 96.44 + 91.45 + 87.68 + 87.37 + 100.63 + 94.44 + 108.35 + 90.03 + 85.32 + 85.44 + 88.88 + 94.6 + 98.24 + 82.66 + 89.79 + 92.58 + 92.62 + 101.63 + 100.89 + 106.36 + 117.76 + 98.6 + 108.56 + 104.42 + 118.95 + 105.14 + 102.69 + 105.37 + 101.08 + 104.45 + 123.67 + 120.52 + 119.11 + 102.94 + 140.34 + 70.69 + 90.39 + 73.46 + 49.86 + 39.66 + 51.57 |
| listado-inicial | 149.4 | 2.21 | 50.32 + 41.89 |
| listado-100-filas | 134 | 3.11 | 47.26 + 45.88 |
| listado-ultima-pagina | 110.7 | 2.08 | 40.42 + 41.75 |
| filtrado-estado-estanteria | 121 | 0.92 | 44.56 + 49.3 |
| ordenado-autor | 116.2 | 2.01 | 45.87 + 44.42 |
| ordenado-fecha | 127.9 | 2.26 | 46.5 + 50.81 |
| busqueda-local-texto | 148.2 | 3.65 | 52.53 + 56.8 |
| busqueda-local-isbn | 134.4 | 3 | 50.05 + 50.8 |
| detalle | 110.4 | 0.06 | 41.13 + 43.94 |
| estanterias | 112.1 | 1.73 | 41.65 + 45.02 |
| estanteria-3d-pagina-48 | 108.2 | 1.11 | 42.71 + 39.84 |
| exportacion-lectura-completa | 129.9 | 2.28 | 39.12 + 48.12 |

### Exportación por partes (código real del formato 1)

Lectura completa: 68 KiB. Formato 1, 1 partes (100 fichas; 57 KiB). Particionado en Node (5 repeticiones): p50 3.1 ms, p95 10.6 ms.

### Consultas principales (EXPLAIN ANALYZE, rol authenticated, 30 ejecuciones)

| consulta | acción | ejecución p50 / p95 | planificación p50 | nodos | LIMIT |
| --- | --- | --- | --- | --- | --- |
| resumen.totales | getLibrarySummaryAction | 0.09 / 0.136 | 0.112 | Aggregate › Result › Seq Scan | **no** |
| resumen.recientes | getLibrarySummaryAction | 0.18 / 0.253 | 0.228 | Limit › Sort › Result › Hash Join | sí |
| resumen.leyendo | getLibrarySummaryAction | 0.133 / 0.174 | 0.297 | Limit › Sort › Result › Hash Join | sí |
| listado.recuento | listBooksAction | 0.085 / 0.122 | 0.134 | Aggregate › Result › Seq Scan | **no** |
| listado.pagina-1 | listBooksAction | 0.252 / 0.373 | 0.334 | Limit › Sort › Result › Hash Join | sí |
| listado.ultima-pagina | listBooksAction | 0.296 / 0.348 | 0.342 | Limit › Sort › Result › Hash Join | sí |
| filtrado.recuento | listBooksAction | 0.092 / 0.148 | 0.139 | Aggregate › Result › Seq Scan | **no** |
| filtrado.pagina | listBooksAction | 0.148 / 0.216 | 0.274 | Limit › Sort › Result › Nested Loop | sí |
| orden.autor | listBooksAction | 0.334 / 0.445 | 0.381 | Limit › Sort › Result › Hash Join | sí |
| orden.fecha | listBooksAction | 0.45 / 1.186 | 0.359 | Limit › Sort › Result › Hash Join | sí |
| busqueda.recuento | listBooksAction | 0.679 / 0.747 | 0.158 | Aggregate › Result › Seq Scan | **no** |
| busqueda.pagina | listBooksAction | 0.794 / 4.403 | 0.369 | Limit › Sort › Result › Nested Loop | sí |
| busqueda.isbn | listBooksAction | 1.03 / 2.422 | 0.355 | Limit › Sort › Result › Nested Loop | sí |
| busqueda.isbn-exacto | listBooksAction | 0.696 / 0.922 | 0.336 | Limit › Sort › Result › Nested Loop | sí |
| detalle | getBookDetailAction | 0.092 / 0.111 | 0.317 | Limit › Result › Nested Loop › Seq Scan | sí |
| estanterias | getShelvesAction | 0.208 / 0.243 | 0.324 | Sort › Aggregate › Result › Hash Join | **no** |
| 3d.pagina | listBooksAction | 0.185 / 0.217 | 0.269 | Limit › Sort › Result › Nested Loop | sí |
| exportacion.todo | getLibraryDataAction | 0.336 / 0.436 | 0.336 | Sort › Result › Hash Join › Seq Scan | **no** |
| isbn.escaneo | getBookByIsbnAction / alta / edición | 0.09 / 0.104 | 0.153 | Result › Seq Scan | **no** |
| importacion.instantanea | prepareImportAction / confirmImportAction | 0.124 / 0.156 | 0.176 | Sort › Result › Seq Scan | **no** |

### Índices candidatos (medidos en transacción revertida)

- `books_user_title_idx` (32 KiB; tabla 408 KiB; insertar 2000 fichas: 103.5 ms sin índice → 17.1 ms con él): listado.pagina-1 0.348 / 0.606 → 0.092 / 0.132; listado.ultima-pagina 0.388 / 0.525 → 0.398 / 1.305; busqueda.pagina 0.833 / 2.075 → 0.583 / 0.802
- `books_user_shelf_title_idx` (32 KiB; tabla 760 KiB; insertar 2000 fichas: 103.5 ms sin índice → 35 ms con él): filtrado.recuento 0.143 / 0.203 → 0.056 / 0.091; 3d.pagina 0.163 / 0.248 → 0.113 / 0.169
- `books_user_created_idx` (16 KiB; tabla 1104 KiB; insertar 2000 fichas: 103.5 ms sin índice → 34.7 ms con él): resumen.recientes 0.295 / 0.45 → 0.066 / 0.113
- `books_user_status_updated_idx` (16 KiB; tabla 1456 KiB; insertar 2000 fichas: 103.5 ms sin índice → 20.7 ms con él): resumen.totales 0.312 / 0.456 → 0.153 / 0.281; resumen.leyendo 0.488 / 0.607 → 0.077 / 0.109
- `books_user_shelf_idx` (16 KiB; tabla 1808 KiB; insertar 2000 fichas: 103.5 ms sin índice → 17.1 ms con él): filtrado.recuento 0.387 / 0.567 → 0.049 / 0.096; estanterias 0.454 / 0.762 → 0.168 / 0.325
- `books_search_trgm_idx` (80 KiB; tabla 2160 KiB; insertar 2000 fichas: 103.5 ms sin índice → 19.8 ms con él): busqueda.recuento 0.646 / 0.987 → 0.791 / 1.116; busqueda.pagina 1.483 / 2.028 → 0.736 / 0.926; busqueda.isbn 2.08 / 2.601 → 0.976 / 1.104; busqueda.isbn-exacto 1.666 / 2.694 → 0.631 / 0.784

### Aislamiento bajo carga

10 sesiones de escala + A + B durante 6 s: 159 peticiones de escala, 15 de A y 15 de B; 189 comprobaciones; **0 violaciones**.

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

### Web vitals · perfil «escritorio-local»

Chrome estable en modo headless, ventana 1280×800, DPR 1, es-ES. Sin limitación de red (la app y el stack están en loopback) ni de CPU. Caché HTTP vacía en frío; poblada en caliente. Navegador 155.0.8059.85. Mediana de 2 contexto(s) por pantalla.

| pantalla | LCP frío | LCP caliente | FCP frío | datos listos frío | datos listos caliente | CLS | INP | interacciones | tareas largas |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| inicio | 602 | 450 | 290 | 536 | 507 | 0.001 | 32 | 1.5 | 0 (0 ms) |
| coleccion | 234 | 136 | 234 | 932.5 | 613 | 0.001 | 48 | 7 | 0 (0 ms) |
| busqueda-avanzada | 644 | 698 | 148 | 583.5 | 647.5 | 0.001 | 48 | 8 | 0 (0 ms) |
| ficha | 632 | 468 | 216 | 604 | 446.5 | 0.001 | 32 | 2.5 | 0 (0 ms) |
| estanterias | 454 | 370 | 134 | 419.5 | 354 | 0.001 | 40 | 3.5 | 0 (0 ms) |
| estanteria-3d | 514 | 588 | 156 | 601 | 771 | 0.001 | 0 | 0 | 0 (0 ms) |
| ajustes | 170 | 110 | 170 | 498 | — | 0.001 | 16 | 1 | 0 (0 ms) |

Exportación en el navegador (clic → copia lista): 200.5 ms.

Salidas de red externas del servidor o del navegador: 0 (guard de red activo).

## 1000 ejemplares

Dataset `biblib-escala-v1` (huella `6343ab435b44d73a`): 1000 libros, 13 estanterías, estanteria mayor 239 libros, ISBN manuales 135.

### Acciones (Server Actions reales, caliente)

`Auth` es la duración de `GET /user` en GoTrue (registro del servidor); `SQL` es el tiempo de ejecución real de las sentencias de la acción (pg_stat_statements), solo con 1 sesión.

| escenario | sesiones | n | acción p50 | acción p95 | máx. | SQL p50 / p95 | Auth p50 / p95 | Auth/petición | filas máx. | KiB p50 | pool máx. | errores | peticiones/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dashboard | 1 | 60 | 127.7 | 147.6 | 337.3 | 2.59 / 3.72 | 47.23 / 53.75 | 2.1 | 10 | 7 | 1 | 0 | 7.4 |
| dashboard | 5 | 100 | 197.6 | 424.6 | 548.3 | — | 64.77 / 100.3 | 2.06 | 10 | 7 | 1 | 0 | 19.6 |
| dashboard | 10 | 150 | 498.3 | 836.3 | 907.6 | — | 171.77 / 336.48 | 2.04 | 10 | 7 | 1 | 0 | 18.6 |
| listado-inicial | 1 | 60 | 190.7 | 232.4 | 259.5 | 1.66 / 2.08 | 85.6 / 104.98 | 2.08 | 10 | 7 | 1 | 0 | 5 |
| listado-inicial | 5 | 100 | 225.4 | 348 | 478.1 | — | 96.72 / 150.68 | 2.06 | 10 | 7 | 1 | 0 | 21.2 |
| listado-inicial | 10 | 150 | 272.9 | 421.4 | 520 | — | 92.36 / 177.51 | 2.04 | 10 | 7 | 1 | 0 | 34 |
| listado-100-filas | 1 | 60 | 108.3 | 120.6 | 123.5 | 2.24 / 2.57 | 42.98 / 50.8 | 2.1 | 100 | 68 | 1 | 0 | 8.8 |
| listado-100-filas | 5 | 100 | 191.9 | 253.3 | 294.8 | — | 70.5 / 103.63 | 2.06 | 100 | 68 | 1 | 0 | 25.1 |
| listado-100-filas | 10 | 150 | 312.8 | 423.2 | 619.5 | — | 118.12 / 178.15 | 2.04 | 100 | 68 | 1 | 0 | 29.4 |
| listado-ultima-pagina | 1 | 60 | 118.4 | 136.2 | 147.8 | 2.62 / 3.36 | 46.35 / 55.87 | 2.1 | 10 | 7 | 1 | 0 | 8.2 |
| listado-ultima-pagina | 5 | 100 | 176.6 | 214.4 | 244.9 | — | 66.91 / 85.61 | 2.06 | 10 | 7 | 1 | 0 | 27.8 |
| listado-ultima-pagina | 10 | 150 | 317.4 | 495.9 | 572.9 | — | 113.74 / 215.65 | 2.04 | 10 | 7 | 1 | 0 | 28.8 |
| filtrado-estado-estanteria | 1 | 60 | 202.2 | 238.4 | 299.4 | 0.47 / 0.69 | 89.79 / 114.3 | 2.08 | 10 | 7 | 1 | 0 | 4.8 |
| filtrado-estado-estanteria | 5 | 100 | 264 | 496.5 | 578.1 | — | 113.43 / 175.63 | 2.05 | 10 | 7 | 1 | 0 | 17.8 |
| filtrado-estado-estanteria | 10 | 150 | 340.7 | 480.2 | 733.1 | — | 113.64 / 208.47 | 2.01 | 10 | 7 | 1 | 0 | 27.7 |
| ordenado-autor | 1 | 60 | 119.8 | 293 | 419.1 | 1.97 / 2.58 | 47.31 / 131.41 | 2.1 | 10 | 7 | 1 | 0 | 7 |
| ordenado-autor | 5 | 100 | 180.5 | 219.4 | 260.7 | — | 68.52 / 89.02 | 2.06 | 10 | 7 | 1 | 0 | 26.8 |
| ordenado-autor | 10 | 150 | 274.9 | 363.8 | 436.5 | — | 92.89 / 141.38 | 2.04 | 10 | 7 | 1 | 0 | 34.6 |
| ordenado-fecha | 1 | 60 | 120.1 | 146.9 | 159.2 | 2.82 / 3.82 | 47.34 / 56.3 | 2.1 | 10 | 7 | 1 | 0 | 8 |
| ordenado-fecha | 5 | 100 | 169.3 | 241.2 | 261.9 | — | 65.6 / 94.92 | 2.06 | 10 | 7 | 1 | 0 | 27.3 |
| ordenado-fecha | 10 | 150 | 312.1 | 397.6 | 433.5 | — | 102.58 / 186.61 | 2.04 | 10 | 7 | 1 | 0 | 31 |
| busqueda-local-texto | 1 | 60 | 197.5 | 248.2 | 269.9 | 10.49 / 12.88 | 82.58 / 108.44 | 2.1 | 10 | 7 | 1 | 0 | 5.1 |
| busqueda-local-texto | 5 | 100 | 222.5 | 260.8 | 272.4 | — | 90.44 / 112.23 | 2.06 | 10 | 7 | 1 | 0 | 23.5 |
| busqueda-local-texto | 10 | 150 | 319.6 | 444.8 | 592.8 | — | 107.64 / 181.26 | 2.04 | 10 | 7 | 1 | 0 | 29.1 |
| busqueda-local-isbn | 1 | 60 | 117.5 | 131.6 | 150.7 | 9.97 / 11.97 | 44.64 / 53.49 | 2.1 | 1 | 1 | 1 | 0 | 8.2 |
| busqueda-local-isbn | 5 | 100 | 219.4 | 289.4 | 319.3 | — | 86.9 / 119.76 | 2.06 | 1 | 1 | 1 | 0 | 23.3 |
| busqueda-local-isbn | 10 | 150 | 314.1 | 394.2 | 468.3 | — | 56.45 / 140.29 | 2.04 | 1 | 1 | 1 | 0 | 30.8 |
| detalle | 1 | 60 | 104.6 | 118.8 | 130.8 | 0.06 / 0.11 | 43.88 / 53.25 | 2.1 | — | 1 | 1 | 0 | 9.2 |
| detalle | 5 | 100 | 139 | 162.5 | 186.1 | — | 55.78 / 66.38 | 2.06 | — | 1 | 1 | 0 | 35.2 |
| detalle | 10 | 150 | 241.7 | 624.4 | 796.1 | — | 99.37 / 249.91 | 2.04 | — | 1 | 1 | 0 | 33.4 |
| estanterias | 1 | 60 | 149.3 | 226.4 | 286 | 0.89 / 1.09 | 53.99 / 106.61 | 2.1 | 13 | 1 | 1 | 0 | 6.2 |
| estanterias | 5 | 100 | 224.8 | 349.4 | 367.3 | — | 100.05 / 147.15 | 2.05 | 13 | 1 | 1 | 0 | 20.7 |
| estanterias | 10 | 150 | 315.1 | 392.7 | 505.3 | — | 135.77 / 177.87 | 2.04 | 13 | 1 | 1 | 0 | 31.3 |
| estanteria-3d-pagina-48 | 1 | 60 | 108.6 | 120.9 | 129.2 | 0.82 / 1.01 | 44.17 / 53.4 | 2.1 | 48 | 32 | 1 | 0 | 8.9 |
| estanteria-3d-pagina-48 | 5 | 100 | 147.4 | 226.4 | 245.2 | — | 57.24 / 101.48 | 2.06 | 48 | 32 | 1 | 0 | 29.4 |
| estanteria-3d-pagina-48 | 10 | 150 | 311.8 | 412.2 | 433.5 | — | 130.04 / 174.13 | 2.04 | 48 | 32 | 1 | 0 | 31.8 |
| exportacion-lectura-completa | 1 | 12 | 243.1 | 290.5 | 302 | 8.8 / 16.12 | 89.42 / 114.83 | 2.33 | 1000 | 673 | 1 | 0 | 3.9 |
| exportacion-lectura-completa | 5 | 15 | 432.7 | 522.5 | 571.4 | — | 72.86 / 94.65 | 2.27 | 1000 | 673 | 1 | 0 | 10.5 |
| exportacion-lectura-completa | 10 | 20 | 623.5 | 828 | 882.6 | — | 77.19 / 110.67 | 2.3 | 1000 | 673 | 1 | 0 | 13.8 |
| preview-importacion-conservar | 1 | 10 | 217.9 | 265.7 | 270.2 | 13.79 / 15.82 | 48.82 / 55.78 | 2.4 | — | 103 | 1 | 0 | 4.2 |
| preview-importacion-conservar | 5 | 10 | 584.9 | 849.1 | 905.7 | — | 56.42 / 81.65 | 2.4 | — | 103 | 1 | 0 | 7.2 |
| preview-importacion-conservar | 10 | 10 | 1064.7 | 1326.4 | 1356 | — | 82.41 / 99.88 | 2.4 | — | 103 | 1 | 0 | 7.1 |
| preview-importacion-nuevos | 1 | 10 | 231 | 265.7 | 278.9 | 17.06 / 19.37 | 44.86 / 52.36 | 2.4 | — | 251 | 1 | 0 | 4.1 |
| preview-importacion-nuevos | 5 | 10 | 493.2 | 741.3 | 764.1 | — | 48.57 / 62.83 | 2.4 | — | 251 | 1 | 0 | 7.8 |
| preview-importacion-nuevos | 10 | 10 | 1004.9 | 1291.6 | 1314.1 | — | 74.56 / 80.32 | 2.4 | — | 251 | 1 | 0 | 7.4 |
| preview-importacion-reemplazo | 1 | 10 | 207.2 | 220.3 | 222.4 | 13.9 / 14.45 | 45.31 / 52.85 | 2.4 | — | 145 | 1 | 0 | 4.6 |
| preview-importacion-reemplazo | 5 | 10 | 493.8 | 743.3 | 789 | — | 50.14 / 58.05 | 2.5 | — | 145 | 1 | 0 | 8.4 |
| preview-importacion-reemplazo | 10 | 10 | 980.3 | 1254 | 1292 | — | 60.22 / 107.61 | 2.4 | — | 145 | 1 | 0 | 7.5 |

### Frío (primera llamada tras arrancar la app)

| escenario | acción | SQL | Auth (GoTrue) |
| --- | --- | --- | --- |
| dashboard | 249.7 | 3.45 | 80.08 + 97.35 + 92.52 + 85.02 + 86.28 + 123.55 + 90.81 + 91.64 + 86.21 + 84.43 + 101.22 + 93.18 + 94.82 + 95.04 + 95.24 + 91.63 + 93.69 + 95.07 + 88.98 + 90.87 + 96.8 + 82.36 + 84.23 + 93.18 + 87.27 + 98.07 + 102.47 + 93.95 + 101.12 + 110.9 + 109.79 + 115.4 + 114.49 + 105.7 + 101.48 + 106.63 + 103.93 + 96.04 + 98.03 + 97.57 + 103.37 + 86.19 + 85.94 + 65.7 + 64.42 + 63.76 + 68.38 + 58.88 + 71.12 + 48.84 + 44 |
| listado-inicial | 160 | 1.8 | 50.72 + 50.36 |
| listado-100-filas | 123.2 | 2.4 | 50.36 + 45.01 + 42.46 |
| listado-ultima-pagina | 138.4 | 2.82 | 52.74 + 50.43 |
| filtrado-estado-estanteria | 131.6 | 1.27 | 49.13 + 51.57 |
| ordenado-autor | 129.9 | 1.83 | 55.3 + 47.07 |
| ordenado-fecha | 124.9 | 2.8 | 47.07 + 47.91 + 47.54 |
| busqueda-local-texto | 131.7 | 9.77 | 47.54 + 53.36 + 42.61 |
| busqueda-local-isbn | 130.2 | 9.8 | 48.6 + 45.78 |
| detalle | 114.2 | 0.11 | 45.78 + 43.99 + 45.45 |
| estanterias | 117.5 | 0.79 | 45.45 + 45.71 + 48.01 |
| estanteria-3d-pagina-48 | 116.6 | 1.67 | 48.01 + 42.71 + 48.56 |
| exportacion-lectura-completa | 170.6 | 10.53 | 48.56 + 44.28 + 44.8 |

### Exportación por partes (código real del formato 1)

Lectura completa: 673 KiB. Formato 1, 1 partes (1000 fichas; 572 KiB). Particionado en Node (5 repeticiones): p50 31.2 ms, p95 41.5 ms.

### Consultas principales (EXPLAIN ANALYZE, rol authenticated, 30 ejecuciones)

| consulta | acción | ejecución p50 / p95 | planificación p50 | nodos | LIMIT |
| --- | --- | --- | --- | --- | --- |
| resumen.totales | getLibrarySummaryAction | 0.513 / 0.797 | 0.082 | Aggregate › Result › Seq Scan | **no** |
| resumen.recientes | getLibrarySummaryAction | 1.296 / 1.478 | 0.226 | Limit › Sort › Result › Hash Join | sí |
| resumen.leyendo | getLibrarySummaryAction | 0.502 / 0.721 | 0.2 | Limit › Sort › Result › Hash Join | sí |
| listado.recuento | listBooksAction | 0.131 / 0.215 | 0.083 | Aggregate › Result › Index Only Scan (books_user_id_idx) | **no** |
| listado.pagina-1 | listBooksAction | 1.154 / 1.322 | 0.182 | Limit › Sort › Result › Hash Join | sí |
| listado.ultima-pagina | listBooksAction | 1.893 / 2.244 | 0.196 | Limit › Sort › Result › Hash Join | sí |
| filtrado.recuento | listBooksAction | 0.11 / 0.178 | 0.07 | Aggregate › Result › Bitmap Heap Scan › Bitmap Index Scan (books_shelf_id_idx) | **no** |
| filtrado.pagina | listBooksAction | 0.198 / 0.303 | 0.151 | Limit › Sort › Result › Nested Loop | sí |
| orden.autor | listBooksAction | 1.494 / 1.847 | 0.192 | Limit › Sort › Result › Hash Join | sí |
| orden.fecha | listBooksAction | 2.545 / 3.099 | 0.211 | Limit › Sort › Result › Hash Join | sí |
| busqueda.recuento | listBooksAction | 4.882 / 6.046 | 0.114 | Aggregate › Result › Seq Scan | **no** |
| busqueda.pagina | listBooksAction | 5.145 / 6.091 | 0.263 | Limit › Sort › Result › Nested Loop | sí |
| busqueda.isbn | listBooksAction | 7.428 / 9.214 | 0.257 | Limit › Sort › Result › Nested Loop | sí |
| busqueda.isbn-exacto | listBooksAction | 4.882 / 5.068 | 0.23 | Limit › Sort › Result › Nested Loop | sí |
| detalle | getBookDetailAction | 0.035 / 0.073 | 0.19 | Limit › Result › Nested Loop › Index Scan (books_pkey) | sí |
| estanterias | getShelvesAction | 1.072 / 1.392 | 0.258 | Sort › Aggregate › Result › Hash Join | **no** |
| 3d.pagina | listBooksAction | 0.518 / 0.632 | 0.199 | Limit › Sort › Result › Nested Loop | sí |
| exportacion.todo | getLibraryDataAction | 2.369 / 3.142 | 0.241 | Sort › Result › Hash Join › Seq Scan | **no** |
| isbn.escaneo | getBookByIsbnAction / alta / edición | 0.13 / 0.155 | 0.06 | Result › Index Only Scan (books_user_id_isbn_unique) | **no** |
| importacion.instantanea | prepareImportAction / confirmImportAction | 0.434 / 0.665 | 0.071 | Sort › Result › Seq Scan | **no** |

### Índices candidatos (medidos en transacción revertida)

- `books_user_title_idx` (104 KiB; tabla 5584 KiB; insertar 2000 fichas: 133.9 ms sin índice → 138.6 ms con él): listado.pagina-1 1.284 / 1.708 → 0.046 / 0.073; listado.ultima-pagina 2.295 / 2.91 → 2.107 / 2.601; busqueda.pagina 5.225 / 6.242 → 5.049 / 5.451
- `books_user_shelf_title_idx` (120 KiB; tabla 5584 KiB; insertar 2000 fichas: 133.9 ms sin índice → 137.2 ms con él): filtrado.recuento 0.499 / 0.69 → 0.191 / 0.271; 3d.pagina 0.843 / 1.086 → 0.112 / 0.16
- `books_user_created_idx` (80 KiB; tabla 8024 KiB; insertar 2000 fichas: 133.9 ms sin índice → 146.3 ms con él): resumen.recientes 2.016 / 2.351 → 0.044 / 0.075
- `books_user_status_updated_idx` (88 KiB; tabla 10520 KiB; insertar 2000 fichas: 133.9 ms sin índice → 142.7 ms con él): resumen.totales 1.392 / 2.449 → 1.183 / 1.627; resumen.leyendo 1.338 / 1.653 → 0.053 / 0.074
- `books_user_shelf_idx` (16 KiB; tabla 13024 KiB; insertar 2000 fichas: 133.9 ms sin índice → 139.7 ms con él): filtrado.recuento 1.337 / 2.175 → 0.096 / 0.199; estanterias 1.978 / 2.561 → 0.641 / 0.92
- `books_search_trgm_idx` (288 KiB; tabla 15528 KiB; insertar 2000 fichas: 133.9 ms sin índice → 188.3 ms con él): busqueda.recuento 6.544 / 7.077 → 9.313 / 9.828; busqueda.pagina 7.031 / 7.905 → 9.276 / 9.888; busqueda.isbn 9.316 / 10.292 → 11.68 / 12.391; busqueda.isbn-exacto 6.7 / 7.187 → 9.695 / 12.674

### Aislamiento bajo carga

10 sesiones de escala + A + B durante 6 s: 170 peticiones de escala, 20 de A y 20 de B; 210 comprobaciones; **0 violaciones**.

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

### Web vitals · perfil «escritorio-local»

Chrome estable en modo headless, ventana 1280×800, DPR 1, es-ES. Sin limitación de red (la app y el stack están en loopback) ni de CPU. Caché HTTP vacía en frío; poblada en caliente. Navegador 155.0.8059.85. Mediana de 2 contexto(s) por pantalla.

| pantalla | LCP frío | LCP caliente | FCP frío | datos listos frío | datos listos caliente | CLS | INP | interacciones | tareas largas |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| inicio | 522 | 356 | 272 | 460 | 334 | 0.001 | 24 | 1.5 | 0 (0 ms) |
| coleccion | 186 | 136 | 186 | 817 | 633.5 | 0.005 | 80 | 8 | 0 (0 ms) |
| busqueda-avanzada | 1014 | 808 | 192 | 877.5 | 754.5 | 0.001 | 40 | 7.5 | 0 (0 ms) |
| ficha | 896 | 548 | 292 | 859.5 | 526 | 0.001 | 32 | 2 | 0 (0 ms) |
| estanterias | 514 | 318 | 158 | 464.5 | 294.5 | 0.001 | 48 | 4 | 0 (0 ms) |
| estanteria-3d | 552 | 462 | 172 | 581 | 544.5 | 0.001 | 32 | 2 | 0 (0 ms) |
| ajustes | 168 | 134 | 168 | — | 544 | 0.001 | 24 | 1 | 0 (0 ms) |

Exportación en el navegador (clic → copia lista): 278 ms.

Salidas de red externas del servidor o del navegador: 0 (guard de red activo).

## 10000 ejemplares

Dataset `biblib-escala-v1` (huella `6e9b3738de18bd6d`): 10000 libros, 41 estanterías, estanteria mayor 1534 libros, ISBN manuales 1420.

### Acciones (Server Actions reales, caliente)

`Auth` es la duración de `GET /user` en GoTrue (registro del servidor); `SQL` es el tiempo de ejecución real de las sentencias de la acción (pg_stat_statements), solo con 1 sesión.

| escenario | sesiones | n | acción p50 | acción p95 | máx. | SQL p50 / p95 | Auth p50 / p95 | Auth/petición | filas máx. | KiB p50 | pool máx. | errores | peticiones/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dashboard | 1 | 60 | 142.4 | 167.3 | 199.5 | 18.84 / 21.52 | 46.77 / 55.86 | 2.1 | 10 | 7 | 1 | 0 | 6.8 |
| dashboard | 5 | 100 | 270 | 312.3 | 415.5 | — | 53.99 / 74.94 | 2.06 | 10 | 7 | 1 | 0 | 18.1 |
| dashboard | 10 | 150 | 543.8 | 1265.1 | 1373.8 | — | 54.53 / 113.89 | 2.04 | 10 | 7 | 1 | 0 | 16.4 |
| listado-inicial | 1 | 60 | 134.7 | 228.8 | 266.6 | 12.53 / 21.04 | 50.44 / 64.97 | 2.1 | 10 | 7 | 1 | 0 | 6.4 |
| listado-inicial | 5 | 100 | 166.3 | 184.9 | 275.7 | — | 54.19 / 64.42 | 2.06 | 10 | 7 | 1 | 0 | 29.1 |
| listado-inicial | 10 | 150 | 338.4 | 372.3 | 514.1 | — | 55.02 / 78.29 | 2.04 | 10 | 7 | 1 | 0 | 28.8 |
| listado-100-filas | 1 | 60 | 138.9 | 166.6 | 186.5 | 14.1 / 18.77 | 49.24 / 60.72 | 2.1 | 100 | 68 | 1 | 0 | 6.8 |
| listado-100-filas | 5 | 100 | 305 | 621.6 | 1403.6 | — | 120.21 / 332.96 | 2.02 | 100 | 68 | 1 | 0 | 14 |
| listado-100-filas | 10 | 150 | 469 | 1479 | 1736.8 | — | 105.93 / 235.7 | 2.04 | 100 | 68 | 1 | 0 | 16.9 |
| listado-ultima-pagina | 1 | 60 | 146.8 | 163.9 | 171 | 32.59 / 38.53 | 45.65 / 52.79 | 2.1 | 10 | 7 | 1 | 0 | 6.6 |
| listado-ultima-pagina | 5 | 100 | 285.3 | 352 | 414.6 | — | 49.95 / 60.97 | 2.06 | 10 | 7 | 1 | 0 | 16.9 |
| listado-ultima-pagina | 10 | 150 | 666.8 | 880.6 | 935.1 | — | 55.67 / 82.62 | 2.04 | 10 | 7 | 1 | 0 | 14.5 |
| filtrado-estado-estanteria | 1 | 60 | 109.9 | 118.4 | 125.7 | 2.15 / 2.54 | 43.77 / 50.62 | 2.1 | 10 | 7 | 1 | 0 | 8.9 |
| filtrado-estado-estanteria | 5 | 100 | 165.2 | 212.2 | 231.5 | — | 61.52 / 83.74 | 2.06 | 10 | 7 | 1 | 0 | 28.9 |
| filtrado-estado-estanteria | 10 | 150 | 287 | 379.2 | 417.4 | — | 85.45 / 167.61 | 2.04 | 10 | 7 | 1 | 0 | 32.8 |
| ordenado-autor | 1 | 60 | 174.9 | 241.6 | 257.8 | 14.77 / 18.49 | 55.74 / 103.99 | 2.1 | 10 | 7 | 1 | 0 | 5.6 |
| ordenado-autor | 5 | 100 | 184.5 | 280.8 | 311.2 | — | 58.82 / 112.83 | 2.06 | 10 | 7 | 1 | 0 | 24 |
| ordenado-autor | 10 | 150 | 438.4 | 576.9 | 661.1 | — | 135.34 / 207.11 | 2.03 | 10 | 7 | 1 | 0 | 22.3 |
| ordenado-fecha | 1 | 60 | 142.4 | 176.6 | 200.6 | 23.7 / 30.25 | 47.07 / 56.87 | 2.1 | 10 | 7 | 1 | 0 | 6.8 |
| ordenado-fecha | 5 | 100 | 246.4 | 278.8 | 354.5 | — | 55.32 / 66.89 | 2.06 | 10 | 7 | 1 | 0 | 19.8 |
| ordenado-fecha | 10 | 150 | 470.3 | 567.6 | 664.4 | — | 54.2 / 123.05 | 2.04 | 10 | 7 | 1 | 0 | 20.2 |
| busqueda-local-texto | 1 | 60 | 220.7 | 311.6 | 709.9 | 105.27 / 160.4 | 47.74 / 74.29 | 2.07 | 10 | 7 | 1 | 0 | 4 |
| busqueda-local-texto | 5 | 100 | 648.3 | 1055.2 | 1201 | — | 48.52 / 63.95 | 2.04 | 10 | 7 | 1 | 0 | 7.2 |
| busqueda-local-texto | 10 | 150 | 1197.5 | 1277.6 | 1339.1 | — | 46.05 / 78.79 | 2.03 | 10 | 7 | 1 | 0 | 8.3 |
| busqueda-local-isbn | 1 | 60 | 214.9 | 256.4 | 311.5 | 101.78 / 123.85 | 46.5 / 55.89 | 2.07 | 1 | 1 | 1 | 0 | 4.5 |
| busqueda-local-isbn | 5 | 100 | 575.3 | 659.1 | 698.4 | — | 45.87 / 58.33 | 2.04 | 1 | 1 | 1 | 0 | 8.5 |
| busqueda-local-isbn | 10 | 150 | 1148.4 | 1221.7 | 1393.9 | — | 45.5 / 93.77 | 2.03 | 1 | 1 | 1 | 0 | 8.6 |
| detalle | 1 | 60 | 107.3 | 128.7 | 182.8 | 0.07 / 0.12 | 44.57 / 55.7 | 2.1 | — | 1 | 1 | 0 | 8.8 |
| detalle | 5 | 100 | 138.8 | 162.7 | 178.2 | — | 55.87 / 70.1 | 2.06 | — | 1 | 1 | 0 | 34.8 |
| detalle | 10 | 150 | 225.7 | 298.1 | 376.1 | — | 91.67 / 120.59 | 2.04 | — | 1 | 1 | 0 | 42.4 |
| estanterias | 1 | 60 | 123.8 | 146.8 | 160.9 | 6.51 / 8.72 | 47.62 / 55.66 | 2.1 | 41 | 5 | 1 | 0 | 7.7 |
| estanterias | 5 | 100 | 238.8 | 304.2 | 352.2 | — | 89.03 / 131.5 | 2.06 | 41 | 5 | 1 | 0 | 20.2 |
| estanterias | 10 | 150 | 370.8 | 463 | 569.3 | — | 143.99 / 183.31 | 2.04 | 41 | 5 | 1 | 0 | 26.1 |
| estanteria-3d-pagina-48 | 1 | 60 | 116.6 | 200.6 | 228.1 | 4.17 / 5.37 | 45.62 / 87.16 | 2.1 | 48 | 32 | 1 | 0 | 7.3 |
| estanteria-3d-pagina-48 | 5 | 100 | 183.8 | 279.2 | 313.2 | — | 69.04 / 125.39 | 2.06 | 48 | 32 | 1 | 0 | 24.4 |
| estanteria-3d-pagina-48 | 10 | 150 | 352.3 | 449.8 | 535 | — | 125.07 / 213.13 | 2.04 | 48 | 32 | 1 | 0 | 27.5 |
| exportacion-lectura-completa | 1 | 12 | 523.9 | 576.4 | 616.8 | 105.24 / 122.9 | 49.42 / 82.12 | 2 | 10000 | 6741 | 1 | 0 | 1.6 |
| exportacion-lectura-completa | 5 | 15 | 2398.6 | 3156.6 | 3213.6 | — | 61.85 / 81.33 | 2 | 10000 | 6741 | 1 | 0 | 1.9 |
| exportacion-lectura-completa | 10 | 20 | 3112.4 | 3627.9 | 3896.8 | — | 83.86 / 196.31 | 2 | 10000 | 6741 | 1 | 0 | 2.8 |
| preview-importacion-conservar | 1 | 10 | 303.6 | 344.7 | 356 | 35.84 / 39.87 | 44.9 / 54.42 | 2.2 | — | 208 | 1 | 0 | 3.1 |
| preview-importacion-conservar | 5 | 10 | 1091.4 | 1474.2 | 1628.5 | — | 53.62 / 69.02 | 2.2 | — | 208 | 1 | 0 | 4.1 |
| preview-importacion-conservar | 10 | 10 | 2195.3 | 2586.2 | 2624.2 | — | 57.67 / 101.62 | 2.2 | — | 208 | 1 | 0 | 3.6 |
| preview-importacion-nuevos | 1 | 10 | 363.3 | 403.4 | 407.9 | 47.83 / 57.09 | 46.92 / 49.64 | 2.2 | — | 503 | 1 | 0 | 2.6 |
| preview-importacion-nuevos | 5 | 10 | 1233.8 | 1671 | 1819.7 | — | 56.53 / 67.97 | 2.2 | — | 503 | 1 | 0 | 3.5 |
| preview-importacion-nuevos | 10 | 10 | 2390.1 | 2965.8 | 3022.9 | — | 71.94 / 123.75 | 2.2 | — | 503 | 1 | 0 | 3.1 |
| preview-importacion-reemplazo | 1 | 10 | 371 | 461.8 | 497.1 | 49.04 / 52.3 | 47.95 / 62.31 | 2.2 | — | 597 | 1 | 0 | 2.5 |
| preview-importacion-reemplazo | 5 | 10 | 1866.4 | 2934.8 | 3088.1 | — | 81.25 / 140.58 | 2.2 | — | 597 | 1 | 0 | 2.3 |
| preview-importacion-reemplazo | 10 | 10 | 2218.8 | 2837.6 | 2879.2 | — | 101.81 / 183.5 | 2.2 | — | 597 | 1 | 0 | 3.3 |

### Frío (primera llamada tras arrancar la app)

| escenario | acción | SQL | Auth (GoTrue) |
| --- | --- | --- | --- |
| dashboard | 263.1 | 18.12 | 44.32 + 55.3 |
| listado-inicial | 150.8 | 12.02 | 47.62 + 42.45 |
| listado-100-filas | 132 | 13.58 | 46.18 + 39.12 |
| listado-ultima-pagina | 166.3 | 34.62 | 56.18 + 44.41 |
| filtrado-estado-estanteria | 113.3 | 2.3 | 41.64 + 40.9 |
| ordenado-autor | 139.6 | 13.5 | 44.82 + 56.91 |
| ordenado-fecha | 126.1 | 22.69 | 40.91 + 39.87 |
| busqueda-local-texto | 210.7 | 96.67 | 45.02 + 43.67 |
| busqueda-local-isbn | 239.2 | 106.16 | 52.51 + 53.38 |
| detalle | 122.7 | 0.1 | 44.81 + 47.45 |
| estanterias | 119.1 | 6.65 | 46.84 + 42.77 |
| estanteria-3d-pagina-48 | 123.3 | 3.38 | 45.99 + 46.26 |
| exportacion-lectura-completa | 497.6 | 116.24 | 41.59 + 42.83 |

### Exportación por partes (código real del formato 1)

Lectura completa: 6741 KiB. Formato 1, 5 partes (2000 + 2000 + 2000 + 2000 + 2000 fichas; 1160 + 1148 + 1142 + 1154 + 1145 KiB). Particionado en Node (5 repeticiones): p50 221 ms, p95 251.7 ms.

### Consultas principales (EXPLAIN ANALYZE, rol authenticated, 30 ejecuciones)

| consulta | acción | ejecución p50 / p95 | planificación p50 | nodos | LIMIT |
| --- | --- | --- | --- | --- | --- |
| resumen.totales | getLibrarySummaryAction | 6.248 / 14.467 | 0.178 | Aggregate › Result › Seq Scan | **no** |
| resumen.recientes | getLibrarySummaryAction | 16.267 / 20.838 | 0.377 | Limit › Sort › Result › Hash Join | sí |
| resumen.leyendo | getLibrarySummaryAction | 4.196 / 5.221 | 0.307 | Limit › Sort › Result › Hash Join | sí |
| listado.recuento | listBooksAction | 0.997 / 1.208 | 0.093 | Aggregate › Result › Index Only Scan (books_user_id_idx) | **no** |
| listado.pagina-1 | listBooksAction | 12.365 / 16.214 | 0.328 | Limit › Sort › Result › Hash Join | sí |
| listado.ultima-pagina | listBooksAction | 34.382 / 41.097 | 0.291 | Limit › Sort › Result › Hash Join | sí |
| filtrado.recuento | listBooksAction | 0.706 / 1.064 | 0.085 | Aggregate › Result › Bitmap Heap Scan › Bitmap Index Scan (books_shelf_id_idx) | **no** |
| filtrado.pagina | listBooksAction | 1.362 / 1.841 | 0.198 | Limit › Sort › Result › Nested Loop | sí |
| orden.autor | listBooksAction | 13.686 / 15.53 | 0.283 | Limit › Sort › Result › Hash Join | sí |
| orden.fecha | listBooksAction | 22.564 / 29.421 | 0.273 | Limit › Sort › Result › Hash Join | sí |
| busqueda.recuento | listBooksAction | 48.165 / 65.505 | 0.123 | Aggregate › Result › Seq Scan | **no** |
| busqueda.pagina | listBooksAction | 49.105 / 54.908 | 0.279 | Limit › Sort › Result › Hash Join | sí |
| busqueda.isbn | listBooksAction | 77.789 / 91.705 | 0.283 | Limit › Sort › Result › Nested Loop | sí |
| busqueda.isbn-exacto | listBooksAction | 49.102 / 54.915 | 0.292 | Limit › Sort › Result › Nested Loop | sí |
| detalle | getBookDetailAction | 0.046 / 0.066 | 0.213 | Limit › Result › Hash Join › Seq Scan | sí |
| estanterias | getShelvesAction | 6.21 / 6.772 | 0.247 | Sort › Aggregate › Result › Hash Join | **no** |
| 3d.pagina | listBooksAction | 2.074 / 2.434 | 0.169 | Limit › Sort › Result › Nested Loop | sí |
| exportacion.todo | getLibraryDataAction | 30.082 / 34.027 | 0.272 | Sort › Result › Hash Join › Seq Scan | **no** |
| isbn.escaneo | getBookByIsbnAction / alta / edición | 1.588 / 2.091 | 0.08 | Result › Seq Scan | **no** |
| importacion.instantanea | prepareImportAction / confirmImportAction | 4.319 / 5.542 | 0.124 | Sort › Result › Seq Scan | **no** |

### Índices candidatos (medidos en transacción revertida)

- `books_user_title_idx` (864 KiB; tabla 8088 KiB; insertar 2000 fichas: 137.6 ms sin índice → 165.5 ms con él): listado.pagina-1 11.074 / 12.332 → 0.05 / 0.086; listado.ultima-pagina 29.798 / 32.635 → 32.063 / 39.674; busqueda.pagina 47.367 / 51.801 → 1.511 / 2.142
- `books_user_shelf_title_idx` (1040 KiB; tabla 11096 KiB; insertar 2000 fichas: 137.6 ms sin índice → 168.3 ms con él): filtrado.recuento 1.397 / 1.702 → 1.482 / 1.769; 3d.pagina 2.968 / 3.344 → 0.137 / 0.204
- `books_user_created_idx` (592 KiB; tabla 14104 KiB; insertar 2000 fichas: 137.6 ms sin índice → 168 ms con él): resumen.recientes 11.918 / 15.27 → 0.044 / 0.085
- `books_user_status_updated_idx` (680 KiB; tabla 17112 KiB; insertar 2000 fichas: 137.6 ms sin índice → 176.4 ms con él): resumen.totales 5.851 / 7.433 → 5.83 / 7.455; resumen.leyendo 4.992 / 5.323 → 0.06 / 0.095
- `books_user_shelf_idx` (96 KiB; tabla 20120 KiB; insertar 2000 fichas: 137.6 ms sin índice → 161.6 ms con él): filtrado.recuento 3.039 / 4.889 → 0.774 / 1.175; estanterias 9.381 / 11.358 → 8.909 / 10.445
- `books_search_trgm_idx` (1848 KiB; tabla 23128 KiB; insertar 2000 fichas: 137.6 ms sin índice → 252 ms con él): busqueda.recuento 52.157 / 60.905 → 65.931 / 134.098; busqueda.pagina 54.878 / 63.761 → 50.104 / 54.21; busqueda.isbn 87.937 / 101.362 → 78.577 / 89.868; busqueda.isbn-exacto 57.276 / 74.254 → 51.147 / 68.439

### Aislamiento bajo carga

10 sesiones de escala + A + B durante 12 s: 301 peticiones de escala, 30 de A y 30 de B; 361 comprobaciones; **0 violaciones**.

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

### Web vitals · perfil «escritorio-local»

Chrome estable en modo headless, ventana 1280×800, DPR 1, es-ES. Sin limitación de red (la app y el stack están en loopback) ni de CPU. Caché HTTP vacía en frío; poblada en caliente. Navegador 155.0.8059.85. Mediana de 3 contexto(s) por pantalla.

| pantalla | LCP frío | LCP caliente | FCP frío | datos listos frío | datos listos caliente | CLS | INP | interacciones | tareas largas |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| inicio | 624 | 488 | 260 | 530 | 463 | 0.001 | 32 | 2 | 0 (0 ms) |
| coleccion | 168 | 124 | 168 | 606 | 502 | 0.001 | 48 | 8 | 0 (0 ms) |
| busqueda-avanzada | 628 | 572 | 148 | 548 | 507 | 0.001 | 40 | 7 | 0 (0 ms) |
| ficha | 588 | 532 | 136 | 559 | 445 | 0.001 | 40 | 3 | 0 (0 ms) |
| estanterias | 508 | 368 | 132 | 457 | 328 | 0.001 | 56 | 4 | 0 (0 ms) |
| estanteria-3d | 464 | 368 | 136 | 434 | 492 | 0.001 | 24 | 2 | 0 (0 ms) |
| ajustes | 160 | 96 | 160 | — | — | 0.169 | 16 | 1 | 0 (0 ms) |

Exportación en el navegador (clic → copia lista): 1415 ms.

### Web vitals · perfil «movil-cpu-x4»

Chrome estable en modo headless emulando un móvil (390×844, DPR 3, táctil) con la CPU 4× más lenta (Emulation.setCPUThrottlingRate) y sin limitación de red. Caché vacía en frío; poblada en caliente. Navegador 155.0.8059.85. Mediana de 2 contexto(s) por pantalla.

| pantalla | LCP frío | LCP caliente | FCP frío | datos listos frío | datos listos caliente | CLS | INP | interacciones | tareas largas |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| inicio | 1286 | 500 | 360 | 1090.5 | 449 | 0 | 80 | 2 | 0 (0 ms) |
| coleccion | 436 | 192 | 436 | 1398.5 | 766.5 | 0 | 120 | 8 | 1.5 (163 ms) |
| busqueda-avanzada | 1404 | 890 | 272 | 1110.5 | 682.5 | 0 | 168 | 8 | 1 (147.5 ms) |
| ficha | 2336 | 1190 | 310 | 2066 | 1130.5 | 0 | 216 | 4 | 0 (0 ms) |
| estanterias | 1600 | 838 | 396 | 1404 | 620.5 | 0 | 496 | 4 | 1 (99 ms) |
| estanteria-3d | 1356 | 680 | 286 | 1439.5 | 861 | 0 | 120 | 2 | 1 (107 ms) |
| ajustes | 426 | 228 | 426 | 2108 | — | 0.579 | 80 | 1 | 2.5 (366.5 ms) |

Exportación en el navegador (clic → copia lista): 3294.5 ms.

Salidas de red externas del servidor o del navegador: 0 (guard de red activo).

## Auth: ida y vuelta de `GET /auth/v1/user` (cliente → Kong → GoTrue)

| sesiones | n | p50 | p95 | máx. |
| --- | --- | --- | --- | --- |
| 1 | 60 | 51.6 | 58.3 | 66.9 |
| 5 | 300 | 69 | 106.7 | 169.9 |
| 10 | 600 | 96.8 | 126.9 | 173.8 |

## Cuota distribuida con dos procesos (catálogo en fixture)

- Dos procesos × 6 ISBN distintos: 12 peticiones al proveedor simulado, separación mínima entre las plazas reservadas por la base 1000 ms (intervalo exigido 1000 ms) → cumple. Entre las peticiones observadas la separación mínima fue 991 ms (media 1000 ms): hasta 9 ms de jitter de planificación del proceso, no una reserva adelantada. Duración total 10995 ms; latencia por consulta (incluye la espera de su plaza) p50 1990 ms / p95 2088 ms.
- Conexiones de los procesos (muestreo cada 25 ms, 410 muestras): máx. 2 simultáneas (pool de 2 por proceso), 2 activa(s), «idle in transaction» máx. 0, transacción más larga 125 ms.
- Caché compartida: 6 consultas repetidas desde el otro proceso, 0 peticiones al proveedor, latencia p50 3.1 ms / p95 46.7 ms.
- Consulta en vuelo: el mismo ISBN pedido a la vez por los dos procesos → 1 petición al proveedor.

## Comparación automática con los presupuestos propuestos (10000 ejemplares)

| medida | presupuesto propuesto | medido | resultado |
| --- | --- | --- | --- |
| Consulta paginada y resumen, 10000 ejemplares, caliente, 1 sesión | p95 SQL ≤ 500 ms | 21.04 ms (listado) + 21.52 ms (resumen) = 42.6 ms | Cumple |
| Filas por página de colección | ≤ 100 | 100 (máximo observado; la página máxima admitida es 100) | Cumple |
| Acción de listado, p95 con Auth + DB (1 sesión) | p95 ≤ 1000 ms | 228.8 ms (Auth GoTrue 64.97 ms × 2.1 llamadas; SQL 21.04 ms) | Cumple |
| Acción de listado con 5 sesiones concurrentes | p95 ≤ 1000 ms | 184.9 ms (29.1 peticiones/s; pool máx. 1) | Cumple |
| Acción de listado con 10 sesiones concurrentes | p95 ≤ 1000 ms | 372.3 ms (28.8 peticiones/s; pool máx. 1) | Cumple |
| dashboard con 10 sesiones concurrentes | p95 ≤ 1000 ms | p95 1265.1 ms (p50 543.8 ms) | **No cumple** |
| listado-100-filas con 10 sesiones concurrentes | p95 ≤ 1000 ms | p95 1479 ms (p50 469 ms) | **No cumple** |
| busqueda-local-texto con 5 sesiones concurrentes | p95 ≤ 1000 ms | p95 1055.2 ms (p50 648.3 ms) | **No cumple** |
| busqueda-local-texto con 10 sesiones concurrentes | p95 ≤ 1000 ms | p95 1277.6 ms (p50 1197.5 ms) | **No cumple** |
| busqueda-local-isbn con 10 sesiones concurrentes | p95 ≤ 1000 ms | p95 1221.7 ms (p50 1148.4 ms) | **No cumple** |
| Vista 3D: libros por página | ≤ 48 | 48 | Cumple |
| Navegación ordinaria sin consultas sin límite (Ajustes carga la colección completa) | ninguna consulta sin LIMIT que crezca con la colección | getLibraryDataAction devuelve 10000 fichas (6741 KiB) al abrir /settings | **No cumple** |
| Paso de worker: no retener conexión mientras se espera la cuota | sin transacción abierta durante la espera | transacción más larga 125 ms; «idle in transaction» máx. 0; conexiones máx. 2 (2 procesos) | Cumple |
| inicio (escritorio) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 624 ms · INP 32 ms · CLS 0.001 | Cumple |
| coleccion (escritorio) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 168 ms · INP 48 ms · CLS 0.001 | Cumple |
| busqueda-avanzada (escritorio) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 628 ms · INP 40 ms · CLS 0.001 | Cumple |
| ficha (escritorio) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 588 ms · INP 40 ms · CLS 0.001 | Cumple |
| estanterias (escritorio) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 508 ms · INP 56 ms · CLS 0.001 | Cumple |
| estanteria-3d (escritorio) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 464 ms · INP 24 ms · CLS 0.001 | Cumple |
| ajustes (escritorio) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 160 ms · INP 16 ms · CLS 0.169 | **No cumple** |
| inicio (movil) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 1286 ms · INP 80 ms · CLS 0 | Cumple |
| coleccion (movil) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 436 ms · INP 120 ms · CLS 0 | Cumple |
| busqueda-avanzada (movil) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 1404 ms · INP 168 ms · CLS 0 | Cumple |
| ficha (movil) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 2336 ms · INP 216 ms · CLS 0 | **No cumple** |
| estanterias (movil) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 1600 ms · INP 496 ms · CLS 0 | **No cumple** |
| estanteria-3d (movil) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 1356 ms · INP 120 ms · CLS 0 | Cumple |
| ajustes (movil) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 426 ms · INP 80 ms · CLS 0.579 | **No cumple** |


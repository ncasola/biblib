# Tablas de la medición (generadas por `pnpm perf:local`)

Generadas el 2026-10-26T08:01:00.514Z. Cifras en milisegundos salvo indicación. «p50 / p95». Ver [informe](informe.md) para el análisis.

## 100 ejemplares

Dataset `biblib-escala-v1` (huella `8235428f06b93d82`): 100 libros, 6 estanterías, estanteria mayor 38 libros, ISBN manuales 16.

### Acciones (Server Actions reales, caliente)

`Auth` es la duración de `GET /user` en GoTrue (registro del servidor); `SQL` es el tiempo de ejecución real de las sentencias de la acción (pg_stat_statements), solo con 1 sesión.

| escenario | sesiones | n | acción p50 | acción p95 | máx. | SQL p50 / p95 | Auth p50 / p95 | Auth/petición | filas máx. | KiB p50 | pool máx. | errores | peticiones/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dashboard | 1 | 60 | 73.8 | 107.9 | 122.1 | 0.47 / 0.66 | 50.25 / 64.65 | 1.07 | 10 | 8 | 1 | 0 | 12.3 |
| dashboard | 5 | 100 | 130.8 | 206.1 | 289.8 | — | 71.29 / 119.85 | 1.03 | 10 | 8 | 4 | 0 | 36.4 |
| dashboard | 10 | 150 | 228.7 | 395.8 | 463.9 | — | 123.98 / 244.51 | 1.04 | 10 | 8 | 4 | 0 | 40.3 |
| listado-inicial | 1 | 60 | 78 | 138.6 | 188.9 | 0.45 / 0.68 | 52.07 / 82.89 | 1.05 | 10 | 9 | 4 | 0 | 10.9 |
| listado-inicial | 5 | 100 | 184 | 346 | 417.3 | — | 113.65 / 281.61 | 1.03 | 10 | 9 | 4 | 0 | 24.9 |
| listado-inicial | 10 | 150 | 344.8 | 728.6 | 884.7 | — | 248.8 / 592.71 | 1.02 | 10 | 9 | 4 | 0 | 26.4 |
| listado-100-filas | 1 | 60 | 130.4 | 188.2 | 274.3 | 1.81 / 2.25 | 94.73 / 131.79 | 1.05 | 100 | 87 | 4 | 0 | 6.9 |
| listado-100-filas | 5 | 100 | 202.3 | 383.7 | 445 | — | 119.05 / 234.65 | 1.03 | 100 | 87 | 4 | 0 | 21.6 |
| listado-100-filas | 10 | 150 | 308.7 | 438 | 525.2 | — | 157.63 / 323.92 | 1.02 | 100 | 87 | 4 | 0 | 30.7 |
| listado-ultima-pagina | 1 | 60 | 83.3 | 115.9 | 215.7 | 0.59 / 0.77 | 52.84 / 67.06 | 1.05 | 10 | 9 | 4 | 0 | 10.8 |
| listado-ultima-pagina | 5 | 100 | 118.9 | 190.9 | 201.8 | — | 69.33 / 117.67 | 1.03 | 10 | 9 | 4 | 0 | 38.5 |
| listado-ultima-pagina | 10 | 150 | 212.9 | 304.2 | 352.4 | — | 118.24 / 182.31 | 1.02 | 10 | 9 | 4 | 0 | 44.8 |
| filtrado-estado-estanteria | 1 | 60 | 83.7 | 110.5 | 139.5 | 0.5 / 0.63 | 54.78 / 62.61 | 1.05 | 10 | 8 | 4 | 0 | 11 |
| filtrado-estado-estanteria | 5 | 100 | 130.4 | 172.2 | 208.9 | — | 74.58 / 104.81 | 1.03 | 10 | 8 | 4 | 0 | 37.9 |
| filtrado-estado-estanteria | 10 | 150 | 204.1 | 333.7 | 402.6 | — | 124.8 / 181.3 | 1.02 | 10 | 9 | 4 | 0 | 44.9 |
| ordenado-autor | 1 | 60 | 74.4 | 87.4 | 94.6 | 0.52 / 0.74 | 49.49 / 57.44 | 1.07 | 10 | 9 | 4 | 0 | 12.7 |
| ordenado-autor | 5 | 100 | 95.8 | 125 | 141.1 | — | 56.16 / 72.06 | 1.06 | 10 | 9 | 4 | 0 | 50.4 |
| ordenado-autor | 10 | 150 | 140.3 | 167.3 | 196.3 | — | 77.32 / 92.16 | 1.07 | 10 | 9 | 4 | 0 | 68.7 |
| ordenado-fecha | 1 | 60 | 68.6 | 77.3 | 83.2 | 0.58 / 0.7 | 45.78 / 55.43 | 1.13 | 10 | 9 | 4 | 0 | 13.9 |
| ordenado-fecha | 5 | 100 | 94.7 | 125.1 | 141.1 | — | 53.93 / 72.97 | 1.05 | 10 | 9 | 4 | 0 | 49.6 |
| ordenado-fecha | 10 | 150 | 133.8 | 176 | 221.9 | — | 69.56 / 90.67 | 1.09 | 10 | 9 | 4 | 0 | 71.4 |
| busqueda-local-texto | 1 | 60 | 94.6 | 113.6 | 119 | 0.51 / 0.64 | 74.12 / 89.6 | 1.25 | 10 | 7 | 4 | 0 | 10.9 |
| busqueda-local-texto | 5 | 100 | 124.2 | 148.5 | 160.5 | — | 86.66 / 103.02 | 1.03 | 10 | 7 | 4 | 0 | 40.8 |
| busqueda-local-texto | 10 | 150 | 189.4 | 267.5 | 296.8 | — | 134.8 / 193.75 | 1.05 | 10 | 7 | 4 | 0 | 50.2 |
| busqueda-local-isbn | 1 | 60 | 65.3 | 98.9 | 110.8 | 0.43 / 0.55 | 45.28 / 84.63 | 1.08 | 1 | 1 | 4 | 0 | 13.7 |
| busqueda-local-isbn | 5 | 100 | 110.8 | 132.3 | 147.4 | — | 81.78 / 97.96 | 1.06 | 1 | 1 | 4 | 0 | 47 |
| busqueda-local-isbn | 10 | 150 | 169.6 | 216.7 | 250.8 | — | 128.78 / 169.97 | 1.09 | 1 | 1 | 4 | 0 | 56.4 |
| detalle | 1 | 60 | 66 | 102.5 | 105.4 | 0.14 / 0.19 | 47.62 / 84.02 | 1.08 | — | 1 | 4 | 0 | 13.7 |
| detalle | 5 | 100 | 93.3 | 139.7 | 202.1 | — | 58.32 / 93.95 | 1.05 | — | 1 | 4 | 0 | 48.8 |
| detalle | 10 | 150 | 132.2 | 180.1 | 208.3 | — | 80.67 / 127.66 | 1.09 | — | 1 | 4 | 0 | 71.8 |
| consulta-isbn-alta | 1 | 60 | 60.1 | 99.7 | 122.9 | 0.06 / 0.16 | 48.41 / 115.4 | 1.17 | — | 0 | 4 | 0 | 14.1 |
| consulta-isbn-alta | 5 | 100 | 114 | 132.4 | 139.5 | — | 87.75 / 106.16 | 1.06 | — | 0 | 4 | 0 | 44.4 |
| consulta-isbn-alta | 10 | 150 | 120.9 | 145.8 | 153.5 | — | 78.32 / 106.35 | 1.12 | — | 0 | 4 | 0 | 80.7 |
| estanterias | 1 | 60 | 65.9 | 102.5 | 165.1 | 0.14 / 0.2 | 49.46 / 98.16 | 1.2 | 6 | 1 | 4 | 0 | 13.6 |
| estanterias | 5 | 100 | 83.1 | 126 | 132.3 | — | 54.59 / 103.91 | 1.04 | 6 | 1 | 4 | 0 | 54.4 |
| estanterias | 10 | 150 | 116.9 | 219 | 240.9 | — | 77.91 / 159.49 | 1.02 | 6 | 1 | 4 | 0 | 75 |
| estanteria-3d-pagina-48 | 1 | 60 | 66.7 | 82.6 | 89.1 | 0.71 / 0.84 | 45.73 / 68.67 | 1.27 | 38 | 33 | 4 | 0 | 14.1 |
| estanteria-3d-pagina-48 | 5 | 100 | 113.2 | 147.1 | 168.4 | — | 60.23 / 80.52 | 1.04 | 38 | 33 | 4 | 0 | 43.4 |
| estanteria-3d-pagina-48 | 10 | 150 | 148.3 | 208 | 256.2 | — | 71.66 / 136.36 | 1.05 | 38 | 33 | 4 | 0 | 63.1 |
| ajustes-recuentos | 1 | 60 | 58 | 69.1 | 80.3 | 0.12 / 0.16 | 45.69 / 57.37 | 1.15 | — | 0 | 4 | 0 | 16.5 |
| ajustes-recuentos | 5 | 100 | 80.5 | 93 | 116.1 | — | 54.46 / 62.86 | 1.06 | — | 0 | 4 | 0 | 61.3 |
| ajustes-recuentos | 10 | 150 | 159.2 | 191.3 | 202.3 | — | 124.75 / 148.64 | 1.08 | — | 0 | 4 | 0 | 62.6 |
| exportacion-servidor | 1 | 12 | 83.4 | 95.7 | 96.4 | 1.25 / 1.4 | 43.78 / 67.05 | 1.5 | — | 2 | 4 | 0 | 11.3 |
| exportacion-servidor | 5 | 15 | 133.1 | 155.4 | 186.9 | — | 53.5 / 70.94 | 1.27 | — | 2 | 4 | 0 | 32.7 |
| exportacion-servidor | 10 | 20 | 213.1 | 349.6 | 357.9 | — | 108.23 / 123.5 | 1.15 | — | 2 | 4 | 0 | 37.4 |
| preview-importacion-conservar | 1 | 10 | 121.9 | 146.9 | 147.1 | 2.44 / 4.05 | 80.12 / 104.37 | 1.3 | — | 11 | 4 | 0 | 8 |
| preview-importacion-conservar | 5 | 10 | 124 | 196.9 | 210.4 | — | 48.82 / 58.08 | 1.4 | — | 11 | 4 | 0 | 32.1 |
| preview-importacion-conservar | 10 | 10 | 277.7 | 344 | 352.1 | — | 115.16 / 128.48 | 1.5 | — | 11 | 4 | 0 | 28 |
| preview-importacion-nuevos | 1 | 10 | 111.3 | 120.3 | 122.8 | 2.94 / 3.26 | 76.64 / 87.44 | 1.3 | — | 46 | 4 | 0 | 8.6 |
| preview-importacion-nuevos | 5 | 10 | 154.7 | 228 | 239.2 | — | 85.77 / 98.04 | 1.3 | — | 46 | 4 | 0 | 25.6 |
| preview-importacion-nuevos | 10 | 10 | 369.6 | 449.3 | 459.3 | — | 162.99 / 175.96 | 1.3 | — | 46 | 4 | 0 | 21.6 |
| preview-importacion-reemplazo | 1 | 10 | 78.6 | 87.7 | 87.7 | 2.36 / 2.59 | 46.1 / 54.86 | 1.3 | — | 36 | 4 | 0 | 12 |
| preview-importacion-reemplazo | 5 | 10 | 159 | 242.1 | 253.3 | — | 53.19 / 59.94 | 1.4 | — | 36 | 4 | 0 | 26.2 |
| preview-importacion-reemplazo | 10 | 10 | 255 | 332.9 | 341.9 | — | 75.37 / 85.54 | 1.3 | — | 36 | 4 | 0 | 28.8 |

### Frío (primera llamada tras arrancar la app)

| escenario | acción | SQL | Auth (GoTrue) |
| --- | --- | --- | --- |
| dashboard | 391.6 | 1.58 | 192.36 + 177.7 + 180.55 + 128.47 + 125.73 + 137.41 + 137.48 + 132.01 + 108.55 + 136.19 + 112.78 + 97.52 + 108.69 + 131.88 + 93.82 + 98.21 + 101.58 + 101.26 + 106.21 + 109.87 + 109.93 + 91.64 + 97.24 + 97.86 + 98.04 + 98.25 + 98.05 + 92.51 + 90.51 + 81.88 + 80.26 + 77.81 + 82.96 + 94.96 + 74.39 + 89.68 + 73.71 + 95.36 + 75.5 + 70.22 + 70.29 + 75.02 + 72.69 + 60.75 + 79.3 + 68.83 + 52.03 + 58.4 + 45.58 + 45.73 |
| listado-inicial | 177.3 | 0.68 | 45.73 + 70.02 |
| listado-100-filas | 112.5 | 1.57 | 70.02 + 52.54 |
| listado-ultima-pagina | 78.3 | 0.55 | 70.02 + 52.54 + 45.88 |
| filtrado-estado-estanteria | 78.9 | 0.41 | 52.54 + 45.88 + 50.51 |
| ordenado-autor | 66.1 | 0.49 | 52.54 + 45.88 + 50.51 + 39.04 |
| ordenado-fecha | 79.7 | 0.73 | 45.88 + 50.51 + 39.04 + 46.17 |
| busqueda-local-texto | 97.6 | 0.82 | 50.51 + 39.04 + 46.17 + 54.67 |
| busqueda-local-isbn | 134.1 | 0.76 | 46.17 + 54.67 + 71.67 |
| detalle | 100.4 | 0.16 | 54.67 + 71.67 + 52.27 |
| consulta-isbn-alta | 96.4 | 0.08 | 71.67 + 52.27 + 63.67 |
| estanterias | 61.3 | 0.11 | 52.27 + 63.67 + 44.59 |
| estanteria-3d-pagina-48 | 74.6 | 0.72 | 63.67 + 44.59 + 47.61 |
| ajustes-recuentos | 64.3 | 0.17 | 63.67 + 44.59 + 47.61 + 38.18 |
| exportacion-servidor | 138.8 | 1.84 | 44.59 + 47.61 + 38.18 + 50.69 |

### Exportación por partes (generada en el servidor)

Respuesta de la acción (manifiesto y enlaces): 2 KiB. Formato 1, 1 partes (100 fichas; 53 KiB). Descarga de las partes desde la app: p50 257.2 ms por parte.

### Consultas principales (EXPLAIN ANALYZE, rol authenticated, 30 ejecuciones)

| consulta | acción | ejecución p50 / p95 | planificación p50 | nodos | LIMIT |
| --- | --- | --- | --- | --- | --- |
| resumen.totales | getLibrarySummaryAction | 0.115 / 0.197 | 0.264 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| resumen.recientes | getLibrarySummaryAction | 0.1 / 0.121 | 0.537 | Limit › Result › Nested Loop › Index Scan (copies_user_created_idx) | sí |
| resumen.leyendo | getLibrarySummaryAction | 0.143 / 0.238 | 0.511 | Limit › Result › Sort › Hash Join | sí |
| listado.recuento | listBooksAction | 0.092 / 0.141 | 0.242 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| listado.pagina-1 | listBooksAction | 0.057 / 0.079 | 0.252 | Limit › Result › Incremental Sort › Nested Loop | sí |
| listado.ultima-pagina | listBooksAction | 0.147 / 0.179 | 0.247 | Limit › Result › Sort › Hash Join | sí |
| listado.filas | listBooksAction | 0.199 / 0.25 | 0.931 | Result › Hash Join › Nested Loop › Seq Scan | sí |
| filtrado.recuento | listBooksAction | 0.07 / 0.102 | 0.25 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| filtrado.pagina | listBooksAction | 0.079 / 0.102 | 0.28 | Limit › Result › Sort › Hash Join | sí |
| orden.autor | listBooksAction | 0.135 / 0.168 | 0.245 | Limit › Result › Sort › Hash Join | sí |
| orden.fecha | listBooksAction | 0.217 / 0.263 | 0.243 | Limit › Result › Sort › Hash Join | sí |
| busqueda.recuento | listBooksAction | 0.138 / 0.154 | 0.252 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| busqueda.pagina | listBooksAction | 0.185 / 0.211 | 0.317 | Limit › Result › Sort › Hash Join | sí |
| busqueda.isbn | listBooksAction | 0.23 / 0.386 | 0.382 | Limit › Result › Sort › Hash Join | sí |
| busqueda.isbn-exacto | listBooksAction | 0.187 / 0.265 | 0.346 | Limit › Result › Sort › Hash Join | sí |
| detalle | getBookDetailAction | 0.122 / 0.177 | 0.582 | Limit › Result › Nested Loop › Seq Scan | sí |
| estanterias | getShelvesAction | 0.099 / 0.123 | 0.166 | Sort › Result › Aggregate › Hash Join | **no** |
| 3d.pagina | listBooksAction | 0.093 / 0.14 | 0.251 | Limit › Result › Sort › Hash Join | sí |
| exportacion.todo | prepareLibraryExportAction / descarga de partes (servidor) | 0.588 / 0.704 | 0.589 | Sort › Result › Hash Join › Seq Scan | **no** |
| isbn.igualdad | getBookByIsbnAction / alta | 0.101 / 0.164 | 0.666 | Limit › Result › Sort › Nested Loop | sí |
| importacion.instantanea | prepareImportAction / confirmImportAction | 0.117 / 0.153 | 0.254 | Sort › Result › Hash Join › Seq Scan | **no** |

### Índices candidatos (medidos en transacción revertida)

- `editions_search_trgm_idx` (80 KiB; tabla 424 KiB; insertar 2000 fichas: 31.2 ms sin índice → 39 ms con él): busqueda.recuento 0.17 / 0.256 → 0.166 / 0.251; busqueda.pagina 0.182 / 0.261 → 0.173 / 0.228; busqueda.isbn 0.196 / 0.265 → 0.182 / 0.34; busqueda.isbn-exacto 0.175 / 0.243 → 0.178 / 0.26

### Aislamiento bajo carga

10 sesiones de escala + A + B durante 6 s: 337 peticiones de escala, 35 de A y 35 de B; 407 comprobaciones; **0 violaciones**.

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

### Web vitals · perfil «escritorio-local»

Chrome estable en modo headless, ventana 1280×800, DPR 1, es-ES. Sin limitación de red (la app y el stack están en loopback) ni de CPU. Caché HTTP vacía en frío; poblada en caliente. Navegador 155.0.8059.86. Mediana de 2 contexto(s) por pantalla.

| pantalla | LCP frío | LCP caliente | FCP frío | datos listos frío | datos listos caliente | CLS | INP | interacciones | tareas largas |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| inicio | 536 | 356 | 338 | 953 | 796.5 | 0.159 | 24 | 2 | 0 (0 ms) |
| coleccion | 222 | 124 | 222 | 963.5 | 731 | 0.004 | 48 | 7 | 0 (0 ms) |
| busqueda-avanzada | 148 | 116 | 148 | 767 | 694 | 0.004 | 32 | 7.5 | 0 (0 ms) |
| ficha | 618 | 484 | 200 | 1005 | 899 | 0.004 | 56 | 4 | 0 (0 ms) |
| estanterias | 662 | 382 | 194 | 575 | 424 | 0.004 | 64 | 4 | 0 (0 ms) |
| estanteria-3d | 938 | 752 | 204 | — | 598 | 0.004 | 0 | 0 | 1 (68 ms) |
| ajustes | 226 | 222 | 226 | 1991.5 | 1557.5 | 0.004 | 16 | 1 | 1 (81 ms) |

Exportación en el navegador (clic → copia lista): 306.5 ms.

Salidas de red externas del servidor o del navegador: 0 (guard de red activo).

## 1000 ejemplares

Dataset `biblib-escala-v1` (huella `6343ab435b44d73a`): 1000 libros, 13 estanterías, estanteria mayor 239 libros, ISBN manuales 135.

### Acciones (Server Actions reales, caliente)

`Auth` es la duración de `GET /user` en GoTrue (registro del servidor); `SQL` es el tiempo de ejecución real de las sentencias de la acción (pg_stat_statements), solo con 1 sesión.

| escenario | sesiones | n | acción p50 | acción p95 | máx. | SQL p50 / p95 | Auth p50 / p95 | Auth/petición | filas máx. | KiB p50 | pool máx. | errores | peticiones/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dashboard | 1 | 60 | 80 | 137.1 | 158.7 | 2.1 / 2.55 | 51.53 / 66.63 | 1.07 | 10 | 9 | 1 | 0 | 10.6 |
| dashboard | 5 | 100 | 124.2 | 160.7 | 206.3 | — | 69.07 / 96.4 | 1.04 | 10 | 9 | 4 | 0 | 38.4 |
| dashboard | 10 | 150 | 195.7 | 553.8 | 694.7 | — | 113.31 / 207.6 | 1.02 | 10 | 9 | 4 | 0 | 38.4 |
| listado-inicial | 1 | 60 | 83.7 | 121 | 307.6 | 1.26 / 1.58 | 53.44 / 67.87 | 1.07 | 10 | 9 | 4 | 0 | 10.1 |
| listado-inicial | 5 | 100 | 104.9 | 129.3 | 142.2 | — | 58.3 / 76.23 | 1.04 | 10 | 9 | 4 | 0 | 45.7 |
| listado-inicial | 10 | 150 | 151.6 | 202.7 | 300.1 | — | 80.19 / 109.42 | 1.05 | 10 | 9 | 4 | 0 | 63.7 |
| listado-100-filas | 1 | 60 | 76.9 | 98.9 | 111 | 2.81 / 3.78 | 45.95 / 56.29 | 1.07 | 100 | 88 | 4 | 0 | 11.9 |
| listado-100-filas | 5 | 100 | 121.2 | 159.3 | 186.7 | — | 57.19 / 82.59 | 1.05 | 100 | 88 | 4 | 0 | 38.7 |
| listado-100-filas | 10 | 150 | 205.6 | 244.2 | 312 | — | 73.32 / 106 | 1.02 | 100 | 88 | 4 | 0 | 47.5 |
| listado-ultima-pagina | 1 | 60 | 71.2 | 83.8 | 97.9 | 2.35 / 3 | 45.17 / 54.1 | 1.07 | 10 | 9 | 4 | 0 | 13.3 |
| listado-ultima-pagina | 5 | 100 | 115 | 144.3 | 165.6 | — | 63.11 / 91.8 | 1.04 | 10 | 9 | 4 | 0 | 42.5 |
| listado-ultima-pagina | 10 | 150 | 147.4 | 196.8 | 219.5 | — | 79.51 / 117.93 | 1.05 | 10 | 9 | 4 | 0 | 64.5 |
| filtrado-estado-estanteria | 1 | 60 | 71.6 | 83.9 | 90.4 | 0.96 / 1.3 | 47.49 / 59 | 1.1 | 10 | 9 | 4 | 0 | 13.3 |
| filtrado-estado-estanteria | 5 | 100 | 119.1 | 158.3 | 171.9 | — | 70.07 / 108.22 | 1.04 | 10 | 9 | 4 | 0 | 41.3 |
| filtrado-estado-estanteria | 10 | 150 | 199.4 | 252.8 | 286.2 | — | 139.11 / 179.15 | 1.02 | 10 | 9 | 4 | 0 | 48.7 |
| ordenado-autor | 1 | 60 | 91.5 | 126.7 | 157.8 | 1.86 / 2.4 | 72.32 / 94.41 | 1.05 | 10 | 9 | 4 | 0 | 10.6 |
| ordenado-autor | 5 | 100 | 139.5 | 185.6 | 208.7 | — | 95.3 / 129.26 | 1.05 | 10 | 9 | 4 | 0 | 35 |
| ordenado-autor | 10 | 150 | 183.3 | 251 | 296.9 | — | 107.11 / 174.22 | 1.05 | 10 | 9 | 4 | 0 | 51.7 |
| ordenado-fecha | 1 | 60 | 68.7 | 110.4 | 126.4 | 2.67 / 3.36 | 43.86 / 88.57 | 1.05 | 10 | 9 | 4 | 0 | 12.9 |
| ordenado-fecha | 5 | 100 | 100.6 | 117.2 | 143.6 | — | 56.41 / 68.84 | 1.03 | 10 | 9 | 4 | 0 | 48 |
| ordenado-fecha | 10 | 150 | 196.7 | 248.2 | 273 | — | 133.57 / 190.83 | 1.02 | 10 | 9 | 4 | 0 | 49.2 |
| busqueda-local-texto | 1 | 60 | 73.2 | 88.3 | 130.8 | 2.85 / 3.84 | 46.55 / 56.8 | 1.05 | 10 | 9 | 4 | 0 | 12.9 |
| busqueda-local-texto | 5 | 100 | 121.3 | 337.1 | 488.3 | — | 68.37 / 113.58 | 1.03 | 10 | 9 | 4 | 0 | 31.1 |
| busqueda-local-texto | 10 | 150 | 168.9 | 268.4 | 325.4 | — | 91.27 / 141.14 | 1.03 | 10 | 9 | 4 | 0 | 55 |
| busqueda-local-isbn | 1 | 60 | 77.8 | 147.5 | 190.8 | 3.12 / 4.08 | 49.19 / 84.75 | 1.05 | 1 | 1 | 4 | 0 | 10.7 |
| busqueda-local-isbn | 5 | 100 | 113.6 | 149.4 | 158 | — | 65.64 / 95.77 | 1.04 | 1 | 1 | 4 | 0 | 42.6 |
| busqueda-local-isbn | 10 | 150 | 150.6 | 192.9 | 218.2 | — | 88.63 / 115.07 | 1.03 | 1 | 1 | 4 | 0 | 64.5 |
| detalle | 1 | 60 | 63.3 | 74.1 | 76 | 0.13 / 0.21 | 46.05 / 55.24 | 1.1 | — | 1 | 4 | 0 | 15 |
| detalle | 5 | 100 | 98.4 | 121.1 | 133.4 | — | 60.77 / 80.52 | 1.04 | — | 1 | 4 | 0 | 49.4 |
| detalle | 10 | 150 | 134.2 | 177.9 | 230.2 | — | 86.18 / 115.19 | 1.05 | — | 1 | 4 | 0 | 70.3 |
| consulta-isbn-alta | 1 | 60 | 60.1 | 66.4 | 70.7 | 0.05 / 0.14 | 46.37 / 101.82 | 1.23 | — | 0 | 4 | 0 | 15.9 |
| consulta-isbn-alta | 5 | 100 | 123.8 | 151.9 | 164.5 | — | 96.78 / 121.64 | 1.06 | — | 0 | 4 | 0 | 40.1 |
| consulta-isbn-alta | 10 | 150 | 203.1 | 410.9 | 494.3 | — | 168.62 / 281.13 | 1.02 | — | 0 | 4 | 0 | 42.8 |
| estanterias | 1 | 60 | 65.9 | 102.6 | 107.5 | 0.56 / 0.7 | 48.97 / 87.28 | 1.05 | 13 | 1 | 4 | 0 | 13.1 |
| estanterias | 5 | 100 | 96.9 | 152.8 | 163.2 | — | 64.04 / 120.32 | 1.04 | 13 | 1 | 4 | 0 | 45.4 |
| estanterias | 10 | 150 | 193.3 | 401.2 | 523 | — | 145.51 / 311.67 | 1.05 | 13 | 1 | 4 | 0 | 44.7 |
| estanteria-3d-pagina-48 | 1 | 60 | 79.3 | 97.5 | 117.2 | 2.26 / 2.96 | 48.76 / 80.22 | 1.05 | 48 | 42 | 4 | 0 | 11.7 |
| estanteria-3d-pagina-48 | 5 | 100 | 111.6 | 147.8 | 205.5 | — | 58.26 / 87.74 | 1.04 | 48 | 42 | 4 | 0 | 41.2 |
| estanteria-3d-pagina-48 | 10 | 150 | 191.6 | 251.4 | 293.5 | — | 97.5 / 172.13 | 1.02 | 48 | 42 | 4 | 0 | 49.9 |
| ajustes-recuentos | 1 | 60 | 64.8 | 160.3 | 235.6 | 0.71 / 0.99 | 49.49 / 133.58 | 1.07 | — | 0 | 4 | 0 | 11.6 |
| ajustes-recuentos | 5 | 100 | 87.4 | 110.7 | 126.6 | — | 59.14 / 79.99 | 1.05 | — | 0 | 4 | 0 | 55.4 |
| ajustes-recuentos | 10 | 150 | 146.7 | 189.2 | 215.8 | — | 102.77 / 153.11 | 1.05 | — | 0 | 4 | 0 | 64.8 |
| exportacion-servidor | 1 | 12 | 236.2 | 257 | 262.8 | 16.02 / 26.61 | 98.59 / 135.85 | 1.17 | — | 2 | 4 | 0 | 4.3 |
| exportacion-servidor | 5 | 15 | 437.9 | 561.6 | 672.4 | — | 57.79 / 70.17 | 1.2 | — | 2 | 4 | 0 | 10.7 |
| exportacion-servidor | 10 | 20 | 651 | 957.9 | 958.6 | — | 68.4 / 100.49 | 1.15 | — | 2 | 4 | 0 | 12.9 |
| preview-importacion-conservar | 1 | 10 | 169.4 | 199.9 | 200.6 | 16.06 / 19.12 | 48.26 / 54.73 | 1.2 | — | 103 | 4 | 0 | 5.5 |
| preview-importacion-conservar | 5 | 10 | 512.8 | 705.3 | 724.6 | — | 47.97 / 58.36 | 1.3 | — | 103 | 4 | 0 | 8.5 |
| preview-importacion-conservar | 10 | 10 | 909.2 | 1097.6 | 1123.6 | — | 80.29 / 88.29 | 1.3 | — | 103 | 4 | 0 | 8.6 |
| preview-importacion-nuevos | 1 | 10 | 200.1 | 217.3 | 218.9 | 24.37 / 28.63 | 45.24 / 49.63 | 1.2 | — | 452 | 4 | 0 | 4.7 |
| preview-importacion-nuevos | 5 | 10 | 677.1 | 940 | 1013.1 | — | 57.58 / 64.56 | 1.2 | — | 452 | 4 | 0 | 6.6 |
| preview-importacion-nuevos | 10 | 10 | 1134.6 | 1467.5 | 1496.6 | — | 75.84 / 86.14 | 1.2 | — | 452 | 4 | 0 | 6.4 |
| preview-importacion-reemplazo | 1 | 10 | 200.7 | 230.1 | 239.7 | 21.95 / 25.01 | 48.72 / 56.22 | 1.3 | — | 346 | 4 | 0 | 4.7 |
| preview-importacion-reemplazo | 5 | 10 | 524.2 | 763.3 | 814.3 | — | 52.15 / 62.82 | 1.3 | — | 346 | 4 | 0 | 7.5 |
| preview-importacion-reemplazo | 10 | 10 | 1856.2 | 2142.3 | 2166.6 | — | 93.27 / 101.33 | 1.2 | — | 346 | 4 | 0 | 4.5 |

### Frío (primera llamada tras arrancar la app)

| escenario | acción | SQL | Auth (GoTrue) |
| --- | --- | --- | --- |
| dashboard | 356 | 2.61 | 52.57 |
| listado-inicial | 108.7 | 1.03 | 52.57 + 48.45 |
| listado-100-filas | 121 | 3.76 | 48.45 + 47.64 |
| listado-ultima-pagina | 95.9 | 2.9 | 47.64 + 51.68 |
| filtrado-estado-estanteria | 93.9 | 0.98 | 51.68 + 57.69 |
| ordenado-autor | 85.1 | 1.93 | 51.68 + 57.69 + 48.73 |
| ordenado-fecha | 89.8 | 3.27 | 57.69 + 48.73 + 48.02 |
| busqueda-local-texto | 91.4 | 3.17 | 48.73 + 48.02 + 56.39 |
| busqueda-local-isbn | 80.2 | 2.77 | 48.02 + 56.39 + 45.77 |
| detalle | 80.7 | 0.2 | 56.39 + 45.77 + 42.62 |
| consulta-isbn-alta | 71.5 | 0.06 | 45.77 + 42.62 + 50.26 |
| estanterias | 69.7 | 0.59 | 42.62 + 50.26 + 48.3 |
| estanteria-3d-pagina-48 | 75.1 | 1.96 | 50.26 + 48.3 + 42.04 |
| ajustes-recuentos | 87.1 | 0.88 | 48.3 + 42.04 + 48.49 |
| exportacion-servidor | 200.7 | 15.29 | 42.04 + 48.49 + 48.73 |

### Exportación por partes (generada en el servidor)

Respuesta de la acción (manifiesto y enlaces): 2 KiB. Formato 1, 1 partes (1000 fichas; 524 KiB). Descarga de las partes desde la app: p50 291 ms por parte.

### Consultas principales (EXPLAIN ANALYZE, rol authenticated, 30 ejecuciones)

| consulta | acción | ejecución p50 / p95 | planificación p50 | nodos | LIMIT |
| --- | --- | --- | --- | --- | --- |
| resumen.totales | getLibrarySummaryAction | 0.751 / 1.078 | 0.334 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| resumen.recientes | getLibrarySummaryAction | 0.174 / 0.231 | 0.589 | Limit › Result › Nested Loop › Index Scan (copies_user_created_idx) | sí |
| resumen.leyendo | getLibrarySummaryAction | 0.851 / 1.301 | 0.621 | Limit › Result › Sort › Hash Join | sí |
| listado.recuento | listBooksAction | 0.778 / 1.019 | 0.398 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| listado.pagina-1 | listBooksAction | 0.118 / 0.171 | 0.38 | Limit › Result › Incremental Sort › Nested Loop | sí |
| listado.ultima-pagina | listBooksAction | 1.551 / 2.034 | 0.353 | Limit › Result › Sort › Hash Join | sí |
| listado.filas | listBooksAction | 0.408 / 0.584 | 1.073 | Result › Nested Loop › Hash Join › Seq Scan | sí |
| filtrado.recuento | listBooksAction | 0.32 / 0.445 | 0.296 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| filtrado.pagina | listBooksAction | 0.361 / 0.491 | 0.323 | Limit › Result › Sort › Hash Join | sí |
| orden.autor | listBooksAction | 1.055 / 1.446 | 0.356 | Limit › Result › Sort › Hash Join | sí |
| orden.fecha | listBooksAction | 1.888 / 2.357 | 0.32 | Limit › Result › Sort › Hash Join | sí |
| busqueda.recuento | listBooksAction | 1.247 / 1.943 | 0.354 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| busqueda.pagina | listBooksAction | 1.277 / 1.747 | 0.363 | Limit › Result › Sort › Hash Join | sí |
| busqueda.isbn | listBooksAction | 1.339 / 1.78 | 0.367 | Limit › Result › Sort › Hash Join | sí |
| busqueda.isbn-exacto | listBooksAction | 2.006 / 2.655 | 0.541 | Limit › Result › Sort › Hash Join | sí |
| detalle | getBookDetailAction | 0.156 / 0.212 | 0.706 | Limit › Result › Nested Loop › Index Scan (copies_user_id_id_unique) | sí |
| estanterias | getShelvesAction | 0.571 / 0.83 | 0.246 | Sort › Result › Aggregate › Hash Join | **no** |
| 3d.pagina | listBooksAction | 0.573 / 0.824 | 0.325 | Limit › Result › Sort › Hash Join | sí |
| exportacion.todo | prepareLibraryExportAction / descarga de partes (servidor) | 5.281 / 6.462 | 0.626 | Sort › Result › Hash Join › Seq Scan | **no** |
| isbn.igualdad | getBookByIsbnAction / alta | 0.082 / 0.114 | 0.586 | Limit › Result › Sort › Nested Loop | sí |
| importacion.instantanea | prepareImportAction / confirmImportAction | 0.807 / 0.979 | 0.287 | Sort › Result › Hash Join › Seq Scan | **no** |

### Índices candidatos (medidos en transacción revertida)

- `editions_search_trgm_idx` (288 KiB; tabla 3200 KiB; insertar 2000 fichas: 336.9 ms sin índice → 376 ms con él): busqueda.recuento 2.752 / 6.265 → 2.745 / 8.498; busqueda.pagina 2.003 / 3.2 → 1.322 / 1.986; busqueda.isbn 2.706 / 3.539 → 1.577 / 2.251; busqueda.isbn-exacto 2.777 / 3.848 → 1.616 / 1.853

### Aislamiento bajo carga

10 sesiones de escala + A + B durante 6 s: 368 peticiones de escala, 40 de A y 40 de B; 448 comprobaciones; **0 violaciones**.

### Conexiones

max_connections = 100; conexiones abiertas al terminar la carga: 11.

| aplicación | rol | estado | conexiones |
| --- | --- | --- | --- |
| postgres.js | postgres | idle | 4 |
| biblib-perf | postgres | active | 1 |
| biblib-perf-sampler | postgres | idle | 1 |
| pg_cron scheduler | supabase_admin | — | 1 |
| pg_net 0.20.4 | postgres | idle | 1 |
| PostgREST 16.2 | authenticator | idle | 1 |
| (sin nombre) | supabase_storage_admin | idle | 1 |
| Supabase Storage API 1.72.1 | supabase_storage_admin | idle | 1 |

### Web vitals · perfil «escritorio-local»

Chrome estable en modo headless, ventana 1280×800, DPR 1, es-ES. Sin limitación de red (la app y el stack están en loopback) ni de CPU. Caché HTTP vacía en frío; poblada en caliente. Navegador 155.0.8059.86. Mediana de 2 contexto(s) por pantalla.

| pantalla | LCP frío | LCP caliente | FCP frío | datos listos frío | datos listos caliente | CLS | INP | interacciones | tareas largas |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| inicio | 564 | 408 | 346 | 967 | 802 | 0.159 | 40 | 2 | 0 (0 ms) |
| coleccion | 194 | 132 | 194 | 861.5 | 802.5 | 0.004 | 48 | 7 | 0 (0 ms) |
| busqueda-avanzada | 164 | 114 | 164 | 842.5 | 742 | 0.004 | 32 | 7.5 | 0 (0 ms) |
| ficha | 726 | 552 | 228 | 1168.5 | 998.5 | 0.004 | 48 | 4 | 0 (0 ms) |
| estanterias | 578 | 378 | 180 | 525 | 388 | 0.004 | 64 | 4 | 0 (0 ms) |
| estanteria-3d | 760 | 742 | 178 | 556.5 | 487 | 0.004 | 32 | 2 | 1 (53 ms) |
| ajustes | 282 | 164 | 282 | 1044.5 | 829.5 | 0.004 | 24 | 1 | 0.5 (27 ms) |

Exportación en el navegador (clic → copia lista): 477.5 ms.

Salidas de red externas del servidor o del navegador: 0 (guard de red activo).

## 10000 ejemplares

Dataset `biblib-escala-v1` (huella `6e9b3738de18bd6d`): 10000 libros, 41 estanterías, estanteria mayor 1534 libros, ISBN manuales 1420.

### Acciones (Server Actions reales, caliente)

`Auth` es la duración de `GET /user` en GoTrue (registro del servidor); `SQL` es el tiempo de ejecución real de las sentencias de la acción (pg_stat_statements), solo con 1 sesión.

| escenario | sesiones | n | acción p50 | acción p95 | máx. | SQL p50 / p95 | Auth p50 / p95 | Auth/petición | filas máx. | KiB p50 | pool máx. | errores | peticiones/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dashboard | 1 | 60 | 78.9 | 86.8 | 95.3 | 13.54 / 15.98 | 43.7 / 52.51 | 1.05 | 10 | 8 | 1 | 0 | 12.2 |
| dashboard | 5 | 100 | 108.4 | 154.4 | 166.4 | — | 52.89 / 66.31 | 1.03 | 10 | 8 | 4 | 0 | 43.4 |
| dashboard | 10 | 150 | 158.5 | 198.5 | 260.8 | — | 68.89 / 101.74 | 1.02 | 10 | 8 | 4 | 0 | 59.4 |
| listado-inicial | 1 | 60 | 74.7 | 86.2 | 92.3 | 5.88 / 7.29 | 44.43 / 55.9 | 1.05 | 10 | 9 | 4 | 0 | 12.9 |
| listado-inicial | 5 | 100 | 111 | 151.3 | 165.3 | — | 60.01 / 83.13 | 1.03 | 10 | 9 | 4 | 0 | 43.2 |
| listado-inicial | 10 | 150 | 145.4 | 184.4 | 256.4 | — | 68.67 / 100.72 | 1.02 | 10 | 9 | 4 | 0 | 65.4 |
| listado-100-filas | 1 | 60 | 78.8 | 88.5 | 98.7 | 7.94 / 8.79 | 45.06 / 53.36 | 1.05 | 100 | 88 | 4 | 0 | 11.9 |
| listado-100-filas | 5 | 100 | 121.1 | 146.6 | 151.2 | — | 53.03 / 61.72 | 1.04 | 100 | 88 | 4 | 0 | 40.3 |
| listado-100-filas | 10 | 150 | 204 | 270.2 | 411.2 | — | 66.37 / 106.95 | 1.02 | 100 | 88 | 4 | 0 | 46.5 |
| listado-ultima-pagina | 1 | 60 | 93.8 | 112.2 | 114.7 | 23.54 / 31.26 | 45.32 / 54.75 | 1.05 | 10 | 9 | 4 | 0 | 10.2 |
| listado-ultima-pagina | 5 | 100 | 125.5 | 175.9 | 190.9 | — | 56.94 / 79.04 | 1.03 | 10 | 9 | 4 | 0 | 37 |
| listado-ultima-pagina | 10 | 150 | 183.3 | 226 | 295.8 | — | 72.67 / 98.49 | 1.02 | 10 | 9 | 4 | 0 | 52.7 |
| filtrado-estado-estanteria | 1 | 60 | 81.8 | 134.4 | 192.5 | 6.66 / 10.38 | 50.71 / 66.88 | 1.05 | 10 | 9 | 4 | 0 | 10.8 |
| filtrado-estado-estanteria | 5 | 100 | 130.5 | 166.2 | 171.1 | — | 78.47 / 112.18 | 1.04 | 10 | 9 | 4 | 0 | 37.8 |
| filtrado-estado-estanteria | 10 | 150 | 213.2 | 328.3 | 360.1 | — | 148.07 / 241.2 | 1.02 | 10 | 9 | 4 | 0 | 44.3 |
| ordenado-autor | 1 | 60 | 95 | 134.6 | 161.6 | 15.28 / 22.44 | 53.77 / 91.67 | 1.05 | 10 | 9 | 4 | 0 | 9.6 |
| ordenado-autor | 5 | 100 | 122.4 | 156.2 | 159.3 | — | 61.77 / 102.35 | 1.03 | 10 | 9 | 4 | 0 | 38.7 |
| ordenado-autor | 10 | 150 | 184.3 | 252.2 | 298.9 | — | 92.32 / 171.77 | 1.02 | 10 | 9 | 4 | 0 | 50.7 |
| ordenado-fecha | 1 | 60 | 96.8 | 116.9 | 147.9 | 25.08 / 31.31 | 46.96 / 59.61 | 1.05 | 10 | 9 | 4 | 0 | 9.8 |
| ordenado-fecha | 5 | 100 | 128.7 | 174.8 | 208.6 | — | 56.54 / 81.99 | 1.03 | 10 | 9 | 4 | 0 | 36.6 |
| ordenado-fecha | 10 | 150 | 213 | 314.8 | 439.7 | — | 81.66 / 134.31 | 1.02 | 10 | 9 | 4 | 0 | 43.6 |
| busqueda-local-texto | 1 | 60 | 96.2 | 111.3 | 122 | 27 / 32.76 | 46.61 / 54.27 | 1.05 | 10 | 9 | 4 | 0 | 10.1 |
| busqueda-local-texto | 5 | 100 | 124 | 150 | 162.7 | — | 55.88 / 67.83 | 1.03 | 10 | 9 | 4 | 0 | 38.4 |
| busqueda-local-texto | 10 | 150 | 192.9 | 254.8 | 302.7 | — | 80.41 / 128.61 | 1.02 | 10 | 9 | 4 | 0 | 49.2 |
| busqueda-local-isbn | 1 | 60 | 95.8 | 115.9 | 138.7 | 27.32 / 34.46 | 46.89 / 58.21 | 1.05 | 1 | 1 | 4 | 0 | 9.9 |
| busqueda-local-isbn | 5 | 100 | 122.7 | 161.7 | 239.8 | — | 55.46 / 72.83 | 1.03 | 1 | 1 | 4 | 0 | 38 |
| busqueda-local-isbn | 10 | 150 | 193.4 | 262.9 | 321.5 | — | 72.4 / 109.6 | 1.02 | 1 | 1 | 4 | 0 | 48.5 |
| detalle | 1 | 60 | 63.1 | 74.8 | 78.8 | 0.14 / 0.18 | 45.81 / 53.98 | 1.05 | — | 1 | 4 | 0 | 14.9 |
| detalle | 5 | 100 | 98.8 | 123.4 | 126.9 | — | 62.9 / 82.22 | 1.03 | — | 1 | 4 | 0 | 49.1 |
| detalle | 10 | 150 | 154 | 221.5 | 234.2 | — | 98.12 / 163.89 | 1.02 | — | 1 | 4 | 0 | 61.2 |
| consulta-isbn-alta | 1 | 60 | 91.7 | 122.8 | 131.2 | 0.05 / 0.15 | 78.71 / 106.57 | 1.05 | — | 0 | 4 | 0 | 11.3 |
| consulta-isbn-alta | 5 | 100 | 92.4 | 153.9 | 170.6 | — | 61.11 / 125.45 | 1.05 | — | 0 | 4 | 0 | 48.5 |
| consulta-isbn-alta | 10 | 150 | 161.7 | 239.1 | 284.8 | — | 122.04 / 207.13 | 1.02 | — | 0 | 4 | 0 | 60.3 |
| estanterias | 1 | 60 | 65.9 | 76.8 | 107.9 | 4.47 / 5.52 | 46.51 / 54.06 | 1.05 | 41 | 5 | 4 | 0 | 14 |
| estanterias | 5 | 100 | 130.5 | 158.6 | 176.1 | — | 93.93 / 119.91 | 1.03 | 41 | 5 | 4 | 0 | 37.8 |
| estanterias | 10 | 150 | 158.4 | 236.1 | 258.7 | — | 109.09 / 167.75 | 1.02 | 41 | 5 | 4 | 0 | 60 |
| estanteria-3d-pagina-48 | 1 | 60 | 79.6 | 97.5 | 111.4 | 8.99 / 11.46 | 45.1 / 57.27 | 1.05 | 48 | 42 | 4 | 0 | 11.8 |
| estanteria-3d-pagina-48 | 5 | 100 | 115.6 | 145.2 | 155.5 | — | 58.43 / 77.46 | 1.03 | 48 | 42 | 4 | 0 | 40.9 |
| estanteria-3d-pagina-48 | 10 | 150 | 216.9 | 319.7 | 389.2 | — | 126.42 / 224.65 | 1.02 | 48 | 42 | 4 | 0 | 43 |
| ajustes-recuentos | 1 | 60 | 67.1 | 77.2 | 109.7 | 5.88 / 7.5 | 47.6 / 78.93 | 1.05 | — | 0 | 4 | 0 | 14 |
| ajustes-recuentos | 5 | 100 | 95.1 | 112.5 | 127.3 | — | 62 / 78.94 | 1.04 | — | 0 | 4 | 0 | 50.7 |
| ajustes-recuentos | 10 | 150 | 179 | 394.6 | 498.3 | — | 123.15 / 351.85 | 1.02 | — | 0 | 4 | 0 | 45.7 |
| exportacion-servidor | 1 | 12 | 732.1 | 798.5 | 826.1 | 144.21 / 159.5 | 48.25 / 55.04 | 1 | — | 5 | 4 | 0 | 1.4 |
| exportacion-servidor | 5 | 15 | 2336 | 4743.3 | 4915.9 | — | 56.63 / 65.26 | 1 | — | 5 | 4 | 0 | 1.6 |
| exportacion-servidor | 10 | 20 | 5023.6 | 7518.7 | 7519.1 | — | 80.36 / 91.37 | 1 | — | 5 | 4 | 0 | 1.6 |
| preview-importacion-conservar | 1 | 10 | 282.2 | 364.2 | 379.3 | 43.58 / 49.2 | 45.78 / 55.35 | 1.1 | — | 208 | 4 | 0 | 3.2 |
| preview-importacion-conservar | 5 | 10 | 1123.7 | 1545.4 | 1656.1 | — | 68.49 / 79.53 | 1.1 | — | 208 | 4 | 0 | 3.9 |
| preview-importacion-conservar | 10 | 10 | 1871 | 2360.9 | 2420.5 | — | 95.22 / 105.69 | 1.1 | — | 208 | 4 | 0 | 4 |
| preview-importacion-nuevos | 1 | 10 | 365.8 | 435 | 437.8 | 62.33 / 79.21 | 47.14 / 56.97 | 1.1 | — | 905 | 4 | 0 | 2.5 |
| preview-importacion-nuevos | 5 | 10 | 1317.3 | 1786.6 | 1912.9 | — | 55.72 / 61.87 | 1.1 | — | 905 | 4 | 0 | 3.3 |
| preview-importacion-nuevos | 10 | 10 | 2159.1 | 2824.6 | 2878.5 | — | 115.87 / 122.03 | 1.1 | — | 905 | 4 | 0 | 3.3 |
| preview-importacion-reemplazo | 1 | 10 | 346.9 | 407.3 | 428.7 | 61.76 / 67.75 | 45.1 / 55.22 | 1.1 | — | 1000 | 4 | 0 | 2.7 |
| preview-importacion-reemplazo | 5 | 10 | 1140.1 | 1670.1 | 1775.7 | — | 49.99 / 57.96 | 1.1 | — | 1000 | 4 | 0 | 3.6 |
| preview-importacion-reemplazo | 10 | 10 | 2192.9 | 2934.1 | 2995.6 | — | 74.88 / 86.52 | 1.1 | — | 1000 | 4 | 0 | 3.2 |

### Frío (primera llamada tras arrancar la app)

| escenario | acción | SQL | Auth (GoTrue) |
| --- | --- | --- | --- |
| dashboard | 347.8 | 16.05 | 58.39 |
| listado-inicial | 97.8 | 6.12 | 58.39 + 37.61 |
| listado-100-filas | 92.8 | 8.64 | 37.61 + 45.13 |
| listado-ultima-pagina | 90.9 | 23.28 | 45.13 + 40.28 |
| filtrado-estado-estanteria | 80.2 | 6.54 | 40.28 + 47.64 |
| ordenado-autor | 87.7 | 14.97 | 40.28 + 47.64 + 43.92 |
| ordenado-fecha | 96.9 | 23.39 | 47.64 + 43.92 + 43.87 |
| busqueda-local-texto | 81.1 | 13.97 | 43.87 + 40.39 |
| busqueda-local-isbn | 115.5 | 34.82 | 40.39 + 47.6 |
| detalle | 78.8 | 0.14 | 47.6 + 43.77 |
| consulta-isbn-alta | 71.4 | 0.04 | 43.77 + 54.71 |
| estanterias | 61.9 | 4.76 | 43.77 + 54.71 + 39.57 |
| estanteria-3d-pagina-48 | 68.4 | 5.12 | 54.71 + 39.57 + 36.47 |
| ajustes-recuentos | 93.5 | 7.66 | 39.57 + 36.47 + 55.46 |
| exportacion-servidor | 780.8 | 155.54 | 55.46 + 48.27 |

### Exportación por partes (generada en el servidor)

Respuesta de la acción (manifiesto y enlaces): 5 KiB. Formato 1, 5 partes (2000 + 2000 + 2000 + 2000 + 2000 fichas; 1064 + 1053 + 1046 + 1058 + 1049 KiB). Descarga de las partes desde la app: p50 842.1 ms por parte.

### Consultas principales (EXPLAIN ANALYZE, rol authenticated, 30 ejecuciones)

| consulta | acción | ejecución p50 / p95 | planificación p50 | nodos | LIMIT |
| --- | --- | --- | --- | --- | --- |
| resumen.totales | getLibrarySummaryAction | 7.374 / 9.058 | 0.359 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| resumen.recientes | getLibrarySummaryAction | 0.126 / 0.216 | 0.607 | Limit › Result › Nested Loop › Index Scan (copies_user_created_idx) | sí |
| resumen.leyendo | getLibrarySummaryAction | 6.913 / 8.13 | 0.651 | Limit › Result › Sort › Hash Join | sí |
| listado.recuento | listBooksAction | 5.975 / 6.466 | 0.344 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| listado.pagina-1 | listBooksAction | 0.068 / 0.107 | 0.247 | Limit › Result › Incremental Sort › Nested Loop | sí |
| listado.ultima-pagina | listBooksAction | 21.045 / 29.726 | 0.446 | Limit › Result › Sort › Hash Join | sí |
| listado.filas | listBooksAction | 0.256 / 0.336 | 1.051 | Result › Nested Loop › Aggregate › Limit | sí |
| filtrado.recuento | listBooksAction | 3.189 / 4.379 | 0.348 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| filtrado.pagina | listBooksAction | 3.297 / 3.882 | 0.352 | Limit › Result › Sort › Hash Join | sí |
| orden.autor | listBooksAction | 9.717 / 11.168 | 0.349 | Limit › Result › Sort › Hash Join | sí |
| orden.fecha | listBooksAction | 18.752 / 21.43 | 0.329 | Limit › Result › Sort › Hash Join | sí |
| busqueda.recuento | listBooksAction | 12.459 / 13.031 | 0.346 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| busqueda.pagina | listBooksAction | 0.763 / 0.991 | 0.32 | Limit › Result › Incremental Sort › Nested Loop | sí |
| busqueda.isbn | listBooksAction | 12.827 / 16.236 | 0.37 | Limit › Result › Sort › Hash Join | sí |
| busqueda.isbn-exacto | listBooksAction | 13.093 / 16.222 | 0.398 | Limit › Result › Sort › Hash Join | sí |
| detalle | getBookDetailAction | 0.161 / 0.297 | 0.7 | Limit › Result › Nested Loop › Hash Join | sí |
| estanterias | getShelvesAction | 5.897 / 8.979 | 0.329 | Sort › Result › Aggregate › Hash Join | **no** |
| 3d.pagina | listBooksAction | 2.499 / 3.825 | 0.447 | Limit › Result › Incremental Sort › Nested Loop | sí |
| exportacion.todo | prepareLibraryExportAction / descarga de partes (servidor) | 66.223 / 74.906 | 0.603 | Sort › Result › Hash Join › Seq Scan | **no** |
| isbn.igualdad | getBookByIsbnAction / alta | 0.093 / 0.125 | 0.71 | Limit › Result › Sort › Nested Loop | sí |
| importacion.instantanea | prepareImportAction / confirmImportAction | 9.142 / 11.837 | 0.347 | Sort › Result › Hash Join › Seq Scan | **no** |

### Índices candidatos (medidos en transacción revertida)

- `editions_search_trgm_idx` (1840 KiB; tabla 11424 KiB; insertar 2000 fichas: 298.8 ms sin índice → 405.9 ms con él): busqueda.recuento 13.604 / 15.668 → 14.15 / 22.458; busqueda.pagina 0.881 / 1.172 → 1.123 / 1.56; busqueda.isbn 13.473 / 18.157 → 14.416 / 21.096; busqueda.isbn-exacto 13.405 / 14.684 → 13.67 / 15.151

### Aislamiento bajo carga

10 sesiones de escala + A + B durante 12 s: 678 peticiones de escala, 75 de A y 75 de B; 828 comprobaciones; **0 violaciones**.

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

### Web vitals · perfil «escritorio-local»

Chrome estable en modo headless, ventana 1280×800, DPR 1, es-ES. Sin limitación de red (la app y el stack están en loopback) ni de CPU. Caché HTTP vacía en frío; poblada en caliente. Navegador 155.0.8059.86. Mediana de 3 contexto(s) por pantalla.

| pantalla | LCP frío | LCP caliente | FCP frío | datos listos frío | datos listos caliente | CLS | INP | interacciones | tareas largas |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| inicio | 536 | 392 | 224 | 941 | 774 | 0.159 | 40 | 2 | 0 (0 ms) |
| coleccion | 152 | 136 | 152 | 819 | 708 | 0.004 | 32 | 8 | 0 (0 ms) |
| busqueda-avanzada | 156 | 112 | 156 | 850 | 888 | 0.004 | 48 | 8 | 0 (0 ms) |
| ficha | 664 | 556 | 240 | 1133 | 1001 | 0.004 | 48 | 4 | 0 (0 ms) |
| estanterias | 516 | 448 | 172 | 509 | 459 | 0.004 | 96 | 4 | 0 (0 ms) |
| estanteria-3d | 752 | 632 | 168 | 631 | 516 | 0.004 | 24 | 2 | 1 (50 ms) |
| ajustes | 256 | 164 | 256 | 1008 | 819 | 0.004 | 24 | 1 | 0 (0 ms) |

Exportación en el navegador (clic → copia lista): 1348 ms.

### Web vitals · perfil «movil-cpu-x4»

Chrome estable en modo headless emulando un móvil (390×844, DPR 3, táctil) con la CPU 4× más lenta (Emulation.setCPUThrottlingRate) y sin limitación de red. Caché vacía en frío; poblada en caliente. Navegador 155.0.8059.86. Mediana de 2 contexto(s) por pantalla.

| pantalla | LCP frío | LCP caliente | FCP frío | datos listos frío | datos listos caliente | CLS | INP | interacciones | tareas largas |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| inicio | 458 | 1252 | 458 | — | 1722 | 0.039 | 120 | 2 | 3 (322 ms) |
| coleccion | 292 | 212 | 292 | 1789.5 | 1547 | 0 | 112 | 8 | 4 (496.5 ms) |
| busqueda-avanzada | 1586 | 1332 | 260 | 1657 | 1378.5 | 0 | 152 | 8 | 4 (557 ms) |
| ficha | 1498 | 1454 | 276 | 1985 | 1879 | 0.081 | 120 | 4 | 4 (431 ms) |
| estanterias | 1774 | 1416 | 306 | 1718 | 1461.5 | 0 | 176 | 4 | 5 (592 ms) |
| estanteria-3d | 1262 | 1382 | 280 | 1404 | 1517 | 0.003 | 72 | 2 | 5 (783.5 ms) |
| ajustes | 396 | 360 | 396 | — | 831.5 | 0.005 | 72 | 1 | 4 (602.5 ms) |

Exportación en el navegador (clic → copia lista): 1482.5 ms.

Salidas de red externas del servidor o del navegador: 0 (guard de red activo).

## Auth: ida y vuelta de `GET /auth/v1/user` (cliente → Kong → GoTrue)

| sesiones | n | p50 | p95 | máx. |
| --- | --- | --- | --- | --- |
| 1 | 60 | 52.4 | 78.9 | 93.6 |
| 5 | 300 | 67.2 | 108.1 | 186.9 |
| 10 | 600 | 126 | 227.7 | 314.5 |

## Cuota distribuida con dos procesos (catálogo en fixture)

- Dos procesos × 6 ISBN distintos: 12 peticiones al proveedor simulado, separación mínima entre las plazas reservadas por la base 1000 ms (intervalo exigido 1000 ms) → cumple. Entre las peticiones observadas la separación mínima fue 983 ms (media 1000 ms): hasta 17 ms de jitter de planificación del proceso, no una reserva adelantada. Duración total 11005 ms; latencia por consulta (incluye la espera de su plaza) p50 1996 ms / p95 2010 ms.
- Conexiones de los procesos (muestreo cada 25 ms, 424 muestras): máx. 2 simultáneas (pool de 2 por proceso), 2 activa(s), «idle in transaction» máx. 0, transacción más larga 8 ms.
- Caché compartida: 6 consultas repetidas desde el otro proceso, 0 peticiones al proveedor, latencia p50 3.3 ms / p95 33.4 ms.
- Consulta en vuelo: el mismo ISBN pedido a la vez por los dos procesos → 1 petición al proveedor.

## Comparación automática con los presupuestos propuestos (10000 ejemplares)

| medida | presupuesto propuesto | medido | resultado |
| --- | --- | --- | --- |
| Consulta paginada y resumen, 10000 ejemplares, caliente, 1 sesión | p95 SQL ≤ 500 ms | 7.29 ms (listado) + 15.98 ms (resumen) = 23.3 ms | Cumple |
| Filas por página de colección | ≤ 100 | 100 (máximo observado; la página máxima admitida es 100) | Cumple |
| Acción de listado, p95 con Auth + DB (1 sesión) | p95 ≤ 1000 ms | 86.2 ms (Auth GoTrue 55.9 ms × 1.05 llamadas; SQL 7.29 ms) | Cumple |
| Acción de listado con 5 sesiones concurrentes | p95 ≤ 1000 ms | 151.3 ms (43.2 peticiones/s; pool máx. 4) | Cumple |
| Acción de listado con 10 sesiones concurrentes | p95 ≤ 1000 ms | 184.4 ms (65.4 peticiones/s; pool máx. 4) | Cumple |
| Vista 3D: libros por página | ≤ 48 | 48 | Cumple |
| Navegación ordinaria sin consultas sin límite (Ajustes al abrirse) | ninguna consulta sin LIMIT que crezca con la colección | getLibraryCountsAction responde 110 B al abrir /settings | Cumple |
| Paso de worker: no retener conexión mientras se espera la cuota | sin transacción abierta durante la espera | transacción más larga 8 ms; «idle in transaction» máx. 0; conexiones máx. 2 (2 procesos) | Cumple |
| inicio (escritorio) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 536 ms · INP 40 ms · CLS 0.159 | **No cumple** |
| coleccion (escritorio) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 152 ms · INP 32 ms · CLS 0.004 | Cumple |
| busqueda-avanzada (escritorio) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 156 ms · INP 48 ms · CLS 0.004 | Cumple |
| ficha (escritorio) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 664 ms · INP 48 ms · CLS 0.004 | Cumple |
| estanterias (escritorio) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 516 ms · INP 96 ms · CLS 0.004 | Cumple |
| estanteria-3d (escritorio) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 752 ms · INP 24 ms · CLS 0.004 | Cumple |
| ajustes (escritorio) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 256 ms · INP 24 ms · CLS 0.004 | Cumple |
| inicio (movil) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 1252 ms · INP 120 ms · CLS 0.039 | Cumple |
| coleccion (movil) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 292 ms · INP 112 ms · CLS 0 | Cumple |
| busqueda-avanzada (movil) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 1586 ms · INP 152 ms · CLS 0 | Cumple |
| ficha (movil) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 1498 ms · INP 120 ms · CLS 0.081 | Cumple |
| estanterias (movil) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 1774 ms · INP 176 ms · CLS 0 | Cumple |
| estanteria-3d (movil) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 1382 ms · INP 72 ms · CLS 0.003 | Cumple |
| ajustes (movil) | LCP ≤ 2500 ms · INP ≤ 200 ms · CLS ≤ 0.1 | LCP 396 ms · INP 72 ms · CLS 0.005 | Cumple |


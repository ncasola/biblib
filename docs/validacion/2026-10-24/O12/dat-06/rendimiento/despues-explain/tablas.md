# Tablas de la medición (generadas por `pnpm perf:local`)

Generadas el 2026-10-25T00:46:39.842Z. Cifras en milisegundos salvo indicación. «p50 / p95». Ver [informe](informe.md) para el análisis.

## 10000 ejemplares

Dataset `biblib-escala-v1` (huella `6e9b3738de18bd6d`): 10000 libros, 41 estanterías, estanteria mayor 1534 libros, ISBN manuales 1420.

### Consultas principales (EXPLAIN ANALYZE, rol authenticated, 30 ejecuciones)

| consulta | acción | ejecución p50 / p95 | planificación p50 | nodos | LIMIT |
| --- | --- | --- | --- | --- | --- |
| resumen.totales | getLibrarySummaryAction | 7.143 / 7.361 | 0.316 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| resumen.recientes | getLibrarySummaryAction | 0.112 / 0.141 | 0.506 | Limit › Result › Nested Loop › Index Scan (copies_user_created_idx) | sí |
| resumen.leyendo | getLibrarySummaryAction | 7.635 / 8.092 | 0.568 | Limit › Result › Sort › Hash Join | sí |
| listado.recuento | listBooksAction | 5.704 / 6.01 | 0.306 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| listado.pagina-1 | listBooksAction | 0.077 / 0.117 | 0.263 | Limit › Result › Incremental Sort › Nested Loop | sí |
| listado.ultima-pagina | listBooksAction | 17.572 / 18.925 | 0.333 | Limit › Result › Sort › Hash Join | sí |
| listado.filas | listBooksAction | 0.823 / 1.223 | 0.935 | Result › Nested Loop › Seq Scan › Aggregate | sí |
| filtrado.recuento | listBooksAction | 3.565 / 5.577 | 0.427 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| filtrado.pagina | listBooksAction | 3.203 / 4.373 | 0.365 | Limit › Result › Sort › Hash Join | sí |
| orden.autor | listBooksAction | 9.459 / 11.52 | 0.343 | Limit › Result › Sort › Hash Join | sí |
| orden.fecha | listBooksAction | 18.479 / 20.638 | 0.332 | Limit › Result › Sort › Hash Join | sí |
| busqueda.recuento | listBooksAction | 11.913 / 12.428 | 0.336 | Aggregate › Result › Hash Join › Seq Scan | **no** |
| busqueda.pagina | listBooksAction | 0.786 / 0.958 | 0.282 | Limit › Result › Incremental Sort › Nested Loop | sí |
| busqueda.isbn | listBooksAction | 12.974 / 19.587 | 0.369 | Limit › Result › Sort › Hash Join | sí |
| busqueda.isbn-exacto | listBooksAction | 13.038 / 14.207 | 0.35 | Limit › Result › Sort › Hash Join | sí |
| detalle | getBookDetailAction | 0.098 / 0.139 | 0.535 | Limit › Result › Nested Loop › Index Scan (copies_user_id_id_unique) | sí |
| estanterias | getShelvesAction | 4.905 / 5.113 | 0.208 | Sort › Result › Aggregate › Nested Loop | **no** |
| 3d.pagina | listBooksAction | 1.394 / 1.792 | 0.289 | Limit › Result › Incremental Sort › Nested Loop | sí |
| exportacion.todo | prepareLibraryExportAction / descarga de partes (servidor) | 36.264 / 39.635 | 0.521 | Result › Hash Join › Nested Loop › Seq Scan | **no** |
| exportacion.orden | prepareLibraryExportAction (orden por IDs) | 17.834 / 22.696 | 0.338 | Sort › Result › Hash Join › Seq Scan | **no** |
| isbn.igualdad | getBookByIsbnAction / alta | 0.074 / 0.097 | 0.542 | Limit › Result › Sort › Nested Loop | sí |
| importacion.instantanea | prepareImportAction / confirmImportAction | 9.066 / 9.949 | 0.311 | Sort › Result › Hash Join › Seq Scan | **no** |

### Índices candidatos (medidos en transacción revertida)

- `editions_search_trgm_idx` (1832 KiB; tabla 11288 KiB; insertar 2000 fichas: 282.2 ms sin índice → 343 ms con él): busqueda.recuento 13.234 / 14.504 → 12.099 / 12.51; busqueda.pagina 0.76 / 0.947 → 0.736 / 1.043; busqueda.isbn 13.067 / 14.92 → 12.264 / 13.505; busqueda.isbn-exacto 14.074 / 14.595 → 13.534 / 17.618

Salidas de red externas del servidor o del navegador: 0 (guard de red activo).

## Comparación automática con los presupuestos propuestos (10000 ejemplares)

| medida | presupuesto propuesto | medido | resultado |
| --- | --- | --- | --- |
| Filas por página de colección | ≤ 100 | 0 (máximo observado; la página máxima admitida es 100) | Cumple |

